/**
 * Export a private key to PuTTY PPK v2 (unencrypted) format.
 *
 * Input: OpenSSH private key string (as stored in the vault after generation).
 * Output: PuTTY-User-Key-File-2 text.
 *
 * Supports: ssh-ed25519, ssh-rsa
 */
import { createHash, createHmac } from 'crypto'
import sshpk from 'sshpk'

// ── SSH wire-format helpers ────────────────────────────────────────────────

function sshUint32(n: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(n, 0)
  return buf
}

function sshString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([sshUint32(b.length), b])
}

function sshBytes(b: Buffer): Buffer {
  return Buffer.concat([sshUint32(b.length), b])
}

/** Encode a positive BigInt as an SSH mpint (big-endian, leading 0x00 if high bit set). */
function mpint(buf: Buffer): Buffer {
  // Strip leading zeros
  let start = 0
  while (start < buf.length - 1 && buf[start] === 0) start++
  let data = buf.slice(start)
  // Add leading 0x00 if the high bit is set (to keep it positive)
  if (data[0] & 0x80) data = Buffer.concat([Buffer.from([0x00]), data])
  return sshBytes(data)
}

// ── PPK MAC (v2) ───────────────────────────────────────────────────────────

function ppkMac(keyType: string, comment: string, publicBlob: Buffer, privateBlob: Buffer): string {
  const macKey = createHash('sha1')
    .update(Buffer.concat([Buffer.from('putty-private-key-file-mac-key')]))
    .digest()

  const macData = Buffer.concat([
    sshString(keyType),
    sshString('none'),      // encryption
    sshString(comment),
    sshBytes(publicBlob),
    sshBytes(privateBlob),
  ])

  return createHmac('sha1', macKey).update(macData).digest('hex')
}

// ── PPK text builder ───────────────────────────────────────────────────────

function buildPpk(keyType: string, comment: string, publicBlob: Buffer, privateBlob: Buffer): string {
  const pubB64 = publicBlob.toString('base64')
  const privB64 = privateBlob.toString('base64')
  const mac = ppkMac(keyType, comment, publicBlob, privateBlob)

  const wrapB64 = (b64: string) => b64.match(/.{1,64}/g) ?? []
  const pubLines = wrapB64(pubB64)
  const privLines = wrapB64(privB64)

  return [
    `PuTTY-User-Key-File-2: ${keyType}`,
    `Encryption: none`,
    `Comment: ${comment}`,
    `Public-Lines: ${pubLines.length}`,
    ...pubLines,
    `Private-Lines: ${privLines.length}`,
    ...privLines,
    `Private-MAC: ${mac}`,
  ].join('\r\n') + '\r\n'
}

// ── Ed25519 ────────────────────────────────────────────────────────────────

function opensshToEd25519Ppk(opensshPem: string, comment: string): string {
  const key = sshpk.parsePrivateKey(opensshPem, 'openssh')

  // sshpk exposes ed25519 parts as Buffer-like objects
  // part.A = public key (32 bytes)
  // part.k = private key (32 bytes seed OR 64 bytes seed+pub depending on lib version)
  const parts = key.part as Record<string, { data: Buffer } | undefined>
  const pubPart  = parts['A']?.data
  const privPart = parts['k']?.data

  if (!pubPart || !privPart) {
    throw new Error('Could not extract Ed25519 key parts from OpenSSH key')
  }

  const pub32  = Buffer.from(pubPart).slice(-32)   // always 32 bytes
  // privPart may be 32-byte seed or 64-byte (seed||pub) — normalize to 64
  let priv64: Buffer
  if (privPart.length === 32) {
    priv64 = Buffer.concat([privPart, pub32])
  } else {
    priv64 = Buffer.from(privPart).slice(0, 64)
  }

  // PPK public blob: string("ssh-ed25519") + string(pubkey)
  const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshBytes(pub32)])

  // PPK private blob: string(64-byte seed||pub)
  const privateBlob = sshBytes(priv64)

  return buildPpk('ssh-ed25519', comment, publicBlob, privateBlob)
}

// ── RSA ────────────────────────────────────────────────────────────────────

function opensshToRsaPpk(opensshPem: string, comment: string): string {
  const key = sshpk.parsePrivateKey(opensshPem, 'openssh')

  const parts = key.part as Record<string, { data: Buffer } | undefined>
  const getPartBuf = (name: string): Buffer => {
    const part = parts[name]
    if (!part) throw new Error(`RSA key missing part: ${name}`)
    return Buffer.from(part.data)
  }

  const n    = getPartBuf('n')
  const e    = getPartBuf('e')
  const d    = getPartBuf('d')
  const p    = getPartBuf('p')
  const q    = getPartBuf('q')
  const iqmp = getPartBuf('iqmp')

  // PPK public blob: string("ssh-rsa") + mpint(e) + mpint(n)
  const publicBlob = Buffer.concat([sshString('ssh-rsa'), mpint(e), mpint(n)])

  // PPK private blob: mpint(d) + mpint(p) + mpint(q) + mpint(iqmp)
  const privateBlob = Buffer.concat([mpint(d), mpint(p), mpint(q), mpint(iqmp)])

  return buildPpk('ssh-rsa', comment, publicBlob, privateBlob)
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert an OpenSSH private key to PPK v2 (unencrypted).
 * @param opensshKey - OpenSSH private key string (-----BEGIN OPENSSH PRIVATE KEY-----)
 * @param comment    - Comment field to embed in the PPK file (e.g. key name)
 */
export function convertToPpk(opensshKey: string, comment: string): string {
  const key = sshpk.parsePrivateKey(opensshKey, 'openssh')
  if (key.type === 'ed25519') {
    return opensshToEd25519Ppk(opensshKey, comment)
  } else if (key.type === 'rsa') {
    return opensshToRsaPpk(opensshKey, comment)
  } else {
    throw new Error(`Unsupported key type for PPK export: ${key.type}`)
  }
}
