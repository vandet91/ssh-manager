/**
 * PuTTY Private Key (.ppk) parser — supports PPK v2 and v3.
 *
 * PPK v2: SHA-1 HMAC, AES-256-CBC key derivation (MD5-based)
 * PPK v3: SHA-256 HMAC, Argon2 KDF
 *
 * Converts to OpenSSH PEM format (PKCS8 private + SPKI public).
 */
import { createHash, createHmac, createDecipheriv } from 'crypto'
import { generateKeyPairSync } from 'crypto'

export interface PpkParseResult {
  privateKeyPem: string
  publicKeyPem: string
  keyType: 'ed25519' | 'rsa4096' | string
  comment: string
}

interface PpkFields {
  version: number
  keyType: string
  encryption: string
  comment: string
  publicKeyB64: string
  privateKeyB64: string
  privateMac: string
  argon2Type?: string
  argon2Memory?: number
  argon2Passes?: number
  argon2Parallelism?: number
  argon2Salt?: string
}

function parsePpkText(text: string): PpkFields {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const fields: Record<string, string> = {}
  let section: 'public' | 'private' | null = null
  let publicLines: string[] = []
  let privateLines: string[] = []
  let publicCount = 0
  let privateCount = 0

  for (const line of lines) {
    if (line.startsWith('PuTTY-User-Key-File-')) {
      const version = parseInt(line.split('-').pop() ?? '0', 10)
      fields['version'] = String(version)
      fields['key-type'] = line.split(': ')[1]?.trim() ?? ''
    } else if (line.startsWith('Encryption: ')) {
      fields['encryption'] = line.split(': ')[1]?.trim() ?? ''
    } else if (line.startsWith('Comment: ')) {
      fields['comment'] = line.split(': ').slice(1).join(': ').trim()
    } else if (line.startsWith('Public-Lines: ')) {
      publicCount = parseInt(line.split(': ')[1] ?? '0', 10)
      section = 'public'
    } else if (line.startsWith('Private-Lines: ')) {
      privateCount = parseInt(line.split(': ')[1] ?? '0', 10)
      section = 'private'
    } else if (line.startsWith('Private-MAC: ')) {
      fields['private-mac'] = line.split(': ')[1]?.trim() ?? ''
      section = null
    } else if (line.startsWith('Key-Derivation: ')) {
      fields['key-derivation'] = line.split(': ')[1]?.trim() ?? ''
    } else if (line.startsWith('Argon2-Memory: ')) {
      fields['argon2-memory'] = line.split(': ')[1]?.trim() ?? ''
    } else if (line.startsWith('Argon2-Passes: ')) {
      fields['argon2-passes'] = line.split(': ')[1]?.trim() ?? ''
    } else if (line.startsWith('Argon2-Parallelism: ')) {
      fields['argon2-parallelism'] = line.split(': ')[1]?.trim() ?? ''
    } else if (line.startsWith('Argon2-Salt: ')) {
      fields['argon2-salt'] = line.split(': ')[1]?.trim() ?? ''
    } else if (section === 'public' && publicLines.length < publicCount) {
      publicLines.push(line)
    } else if (section === 'private' && privateLines.length < privateCount) {
      privateLines.push(line)
    }
  }

  return {
    version: parseInt(fields['version'] ?? '2', 10),
    keyType: fields['key-type'] ?? '',
    encryption: fields['encryption'] ?? 'none',
    comment: fields['comment'] ?? '',
    publicKeyB64: publicLines.join(''),
    privateKeyB64: privateLines.join(''),
    privateMac: fields['private-mac'] ?? '',
    argon2Type: fields['key-derivation'],
    argon2Memory: fields['argon2-memory'] ? parseInt(fields['argon2-memory'], 10) : undefined,
    argon2Passes: fields['argon2-passes'] ? parseInt(fields['argon2-passes'], 10) : undefined,
    argon2Parallelism: fields['argon2-parallelism'] ? parseInt(fields['argon2-parallelism'], 10) : undefined,
    argon2Salt: fields['argon2-salt'],
  }
}

// PPK v2 key derivation: MD5-based sequential hashing
function deriveKeyV2(passphrase: string): Buffer {
  const pass = Buffer.from(passphrase, 'utf8')
  const key1 = createHash('md5').update(Buffer.concat([Buffer.from([0, 0, 0, 0]), pass])).digest()
  const key2 = createHash('md5').update(Buffer.concat([Buffer.from([0, 0, 0, 1]), pass])).digest()
  return Buffer.concat([key1, key2]) // 32 bytes for AES-256
}

// PPK v3 key derivation using Argon2 via the argon2 package
async function deriveKeyV3(
  passphrase: string,
  salt: Buffer,
  type: string,
  memory: number,
  passes: number,
  parallelism: number,
): Promise<Buffer<ArrayBuffer>> {
  // We need 80 bytes total: 32 (cipher key) + 16 (IV) + 32 (MAC key)
  // Use argon2 library
  let argon2: typeof import('argon2')
  try {
    argon2 = await import('argon2')
  } catch {
    throw new Error('argon2 package required for PPK v3 decryption. Run: npm install argon2')
  }

  const argon2Type =
    type === 'Argon2d' ? argon2.argon2d : type === 'Argon2id' ? argon2.argon2id : argon2.argon2i

  const hash = await argon2.hash(passphrase, {
    type: argon2Type,
    salt,
    memoryCost: memory,
    timeCost: passes,
    parallelism,
    hashLength: 80,
    raw: true,
  })

  return Buffer.from(new Uint8Array(hash as unknown as ArrayBufferLike))
}

function decryptAesCbc(encrypted: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

// Read a big-endian uint32
function readUint32(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset)
}

// Read length-prefixed SSH bytes (uint32 length + data)
function readMpint(buf: Buffer, offset: number): { value: Buffer; nextOffset: number } {
  const len = readUint32(buf, offset)
  return { value: buf.slice(offset + 4, offset + 4 + len), nextOffset: offset + 4 + len }
}

// Convert raw RSA key material (from PPK blob) to PEM
function rsaBlobToPem(publicBlob: Buffer, privateBlob: Buffer): { privateKeyPem: string; publicKeyPem: string } {
  // Public blob: string "ssh-rsa" + mpint e + mpint n
  let offset = 0
  const typeLen = readUint32(publicBlob, offset)
  offset += 4 + typeLen // skip "ssh-rsa"

  const { value: e, nextOffset: off2 } = readMpint(publicBlob, offset)
  const { value: n } = readMpint(publicBlob, off2)

  // Private blob: mpint d + mpint p + mpint q + mpint iqmp
  let pOffset = 0
  const { value: d, nextOffset: pOff2 } = readMpint(privateBlob, pOffset)
  const { value: p, nextOffset: pOff3 } = readMpint(privateBlob, pOff2)
  const { value: q, nextOffset: pOff4 } = readMpint(privateBlob, pOff3)
  const { value: iqmp } = readMpint(privateBlob, pOff4)

  // Compute dp = d mod (p-1), dq = d mod (q-1) using BigInt
  const dBig = BigInt('0x' + d.toString('hex'))
  const pBig = BigInt('0x' + p.toString('hex'))
  const qBig = BigInt('0x' + q.toString('hex'))
  const dp = dBig % (pBig - 1n)
  const dq = dBig % (qBig - 1n)

  function bigIntToBuffer(bi: bigint): Buffer {
    let hex = bi.toString(16)
    if (hex.length % 2) hex = '0' + hex
    return Buffer.from(hex, 'hex')
  }

  const dpBuf = bigIntToBuffer(dp)
  const dqBuf = bigIntToBuffer(dq)

  // Build DER-encoded RSAPrivateKey (PKCS#1)
  function encodeAsn1Integer(buf: Buffer): Buffer {
    // Ensure no leading zeros except when needed for sign
    let data = buf
    while (data.length > 1 && data[0] === 0) data = data.slice(1)
    if (data[0] & 0x80) data = Buffer.concat([Buffer.from([0]), data])
    return encodeAsn1(0x02, data)
  }

  function encodeAsn1(tag: number, data: Buffer): Buffer {
    const len = encodeAsn1Length(data.length)
    return Buffer.concat([Buffer.from([tag]), len, data])
  }

  function encodeAsn1Length(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len])
    if (len < 0x100) return Buffer.from([0x81, len])
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff])
  }

  const version = encodeAsn1(0x02, Buffer.from([0x00]))
  const seq = encodeAsn1(0x30, Buffer.concat([
    version,
    encodeAsn1Integer(n),
    encodeAsn1Integer(e),
    encodeAsn1Integer(d),
    encodeAsn1Integer(p),
    encodeAsn1Integer(q),
    encodeAsn1Integer(dpBuf),
    encodeAsn1Integer(dqBuf),
    encodeAsn1Integer(iqmp),
  ]))

  const pkcs1B64 = seq.toString('base64')
  const privateKeyPem = `-----BEGIN RSA PRIVATE KEY-----\n${pkcs1B64.match(/.{1,64}/g)!.join('\n')}\n-----END RSA PRIVATE KEY-----`

  // Build SubjectPublicKeyInfo for RSA
  const rsaOid = Buffer.from('300d06092a864886f70d0101010500', 'hex') // OID 1.2.840.113549.1.1.1 + NULL
  const pubSeq = encodeAsn1(0x30, Buffer.concat([encodeAsn1Integer(n), encodeAsn1Integer(e)]))
  const bitString = encodeAsn1(0x03, Buffer.concat([Buffer.from([0x00]), pubSeq]))
  const spki = encodeAsn1(0x30, Buffer.concat([rsaOid, bitString]))
  const spkiB64 = spki.toString('base64')
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spkiB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`

  return { privateKeyPem, publicKeyPem }
}

// Convert raw Ed25519 key material from PPK blob to PEM
function ed25519BlobToPem(publicBlob: Buffer, privateBlob: Buffer): { privateKeyPem: string; publicKeyPem: string } {
  // Public blob: string "ssh-ed25519" + string(32 bytes public key)
  let offset = 0
  const typeLen = readUint32(publicBlob, offset)
  offset += 4 + typeLen
  const { value: pubKey } = readMpint(publicBlob, offset)

  // Private blob: string(64 bytes: 32 seed + 32 public)
  const { value: privFull } = readMpint(privateBlob, 0)
  const seed = privFull.slice(0, 32)

  // Ed25519 PKCS8: OID 1.3.101.112
  // PKCS8 structure: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING seed } }
  const ed25519Oid = Buffer.from('302a300506032b6570032100', 'hex')

  function encodeAsn1(tag: number, data: Buffer): Buffer {
    const len = data.length
    let lenBytes: Buffer
    if (len < 0x80) lenBytes = Buffer.from([len])
    else if (len < 0x100) lenBytes = Buffer.from([0x81, len])
    else lenBytes = Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff])
    return Buffer.concat([Buffer.from([tag]), lenBytes, data])
  }

  // PKCS8 private key
  const pkcs8 = encodeAsn1(0x30, Buffer.concat([
    encodeAsn1(0x02, Buffer.from([0x00])),
    encodeAsn1(0x30, Buffer.from('06032b6570', 'hex')),
    encodeAsn1(0x04, encodeAsn1(0x04, seed)),
  ]))
  const privateB64 = pkcs8.toString('base64')
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateB64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`

  // SubjectPublicKeyInfo
  const spki = encodeAsn1(0x30, Buffer.concat([
    encodeAsn1(0x30, Buffer.from('06032b6570', 'hex')),
    encodeAsn1(0x03, Buffer.concat([Buffer.from([0x00]), pubKey.slice(0, 32)])),
  ]))
  const pubB64 = spki.toString('base64')
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${pubB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`

  return { privateKeyPem, publicKeyPem }
}

export async function parsePpk(ppkText: string, passphrase?: string): Promise<PpkParseResult> {
  const fields = parsePpkText(ppkText)

  if (!fields.keyType) throw new Error('Invalid PPK file: missing key type')

  const publicBlob = Buffer.from(fields.publicKeyB64, 'base64')
  let privateBlob = Buffer.from(fields.privateKeyB64, 'base64')

  // Decrypt private blob if encrypted
  if (fields.encryption !== 'none') {
    if (!passphrase) throw new Error('This PPK file is encrypted. Please provide a passphrase.')
    if (fields.encryption !== 'aes256-cbc') {
      throw new Error(`Unsupported PPK encryption: ${fields.encryption}`)
    }

    let cipherKey: Buffer
    let iv: Buffer

    if (fields.version === 2) {
      const derivedKey = deriveKeyV2(passphrase)
      cipherKey = derivedKey.slice(0, 32)
      iv = Buffer.alloc(16, 0) // PPK v2 uses zero IV
    } else if (fields.version === 3) {
      if (!fields.argon2Salt) throw new Error('PPK v3: missing Argon2 salt')
      const salt = Buffer.from(fields.argon2Salt, 'hex')
      const derived = await deriveKeyV3(
        passphrase,
        salt,
        fields.argon2Type ?? 'Argon2id',
        fields.argon2Memory ?? 8192,
        fields.argon2Passes ?? 21,
        fields.argon2Parallelism ?? 1,
      )
      cipherKey = derived.slice(0, 32)
      iv = derived.slice(32, 48)
      // derived.slice(48, 80) is the MAC key (used for v3 MAC verification)
    } else {
      throw new Error(`Unsupported PPK version: ${fields.version}`)
    }

    privateBlob = Buffer.from(decryptAesCbc(privateBlob, cipherKey, iv))
  }

  // Verify MAC (v2: SHA-1 HMAC, v3: SHA-256 HMAC)
  if (fields.version === 2) {
    const macKey = createHash('sha1')
      .update(Buffer.concat([Buffer.from('putty-private-key-file-mac-key'), Buffer.from(passphrase ?? '', 'utf8')]))
      .digest()

    const encTag = fields.encryption !== 'none' ? fields.encryption : 'none'
    function sshString(s: string): Buffer {
      const b = Buffer.from(s, 'utf8')
      const len = Buffer.alloc(4)
      len.writeUInt32BE(b.length)
      return Buffer.concat([len, b])
    }
    function sshBytes(b: Buffer): Buffer {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(b.length)
      return Buffer.concat([len, b])
    }

    const macData = Buffer.concat([
      sshString(fields.keyType),
      sshString(encTag),
      sshString(fields.comment),
      sshBytes(publicBlob),
      sshBytes(privateBlob),
    ])

    const computedMac = createHmac('sha1', macKey).update(macData).digest('hex')
    if (computedMac !== fields.privateMac) {
      throw new Error('PPK MAC verification failed — wrong passphrase or corrupted file')
    }
  }

  // Convert to PEM based on key type
  const normalizedType = fields.keyType.toLowerCase()

  let privateKeyPem: string
  let publicKeyPem: string
  let keyType: 'ed25519' | 'rsa4096' | string

  if (normalizedType === 'ssh-ed25519') {
    const result = ed25519BlobToPem(publicBlob, privateBlob)
    privateKeyPem = result.privateKeyPem
    publicKeyPem = result.publicKeyPem
    keyType = 'ed25519'
  } else if (normalizedType === 'ssh-rsa') {
    const result = rsaBlobToPem(publicBlob, privateBlob)
    privateKeyPem = result.privateKeyPem
    publicKeyPem = result.publicKeyPem
    keyType = 'rsa4096'
  } else {
    throw new Error(`Unsupported PPK key type: ${fields.keyType}`)
  }

  return { privateKeyPem, publicKeyPem, keyType, comment: fields.comment }
}

export function isPpkFile(content: string): boolean {
  return content.trimStart().startsWith('PuTTY-User-Key-File-')
}
