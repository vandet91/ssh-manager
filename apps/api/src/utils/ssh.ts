import { Client, ConnectConfig } from 'ssh2'
import sshpk from 'sshpk'

/** Auto-convert a private key to OpenSSH format if it's stored as PKCS8/PKCS1.
 *  ssh2 requires OpenSSH format for Ed25519 keys. This makes stored PKCS8 keys
 *  work transparently without a DB migration. */
function ensureOpenSsh(privateKeyPem: string): string {
  if (
    privateKeyPem.includes('BEGIN PRIVATE KEY') ||
    privateKeyPem.includes('BEGIN ENCRYPTED PRIVATE KEY') ||
    privateKeyPem.includes('BEGIN RSA PRIVATE KEY')
  ) {
    try {
      const format = privateKeyPem.includes('BEGIN RSA PRIVATE KEY') ? 'pkcs1' : 'pkcs8'
      const parsed = sshpk.parsePrivateKey(privateKeyPem, format)
      return parsed.toString('openssh')
    } catch { /* leave as-is — ssh2 will surface the real error */ }
  }
  return privateKeyPem
}

export interface SshExecResult {
  stdout: string
  stderr: string
  code: number
}

export function pemToAuthorizedKeysLine(pemPublic: string): string {
  const parsed = sshpk.parseKey(pemPublic, 'pem')
  return parsed.toString('ssh')
}

export function getFingerprint(pemPublic: string): string {
  const parsed = sshpk.parseKey(pemPublic, 'pem')
  return parsed.fingerprint('sha256').toString()
}

export function buildConnectConfig(
  hostname: string,
  port: number,
  linuxUser: string,
  privateKeyPem: string,
  hostKeyFingerprint?: string,
): ConnectConfig {
  return {
    host: hostname,
    port,
    username: linuxUser,
    privateKey: ensureOpenSsh(privateKeyPem),
    readyTimeout: 15000,
    hostVerifier: hostKeyFingerprint
      ? (keyHash: Buffer | string) => {
          const incoming = Buffer.isBuffer(keyHash) ? keyHash.toString('hex') : String(keyHash)
          // Accept if fingerprints match (compare hex or base64 representations)
          return incoming === hostKeyFingerprint || Buffer.from(incoming, 'hex').toString('base64') === hostKeyFingerprint
        }
      : undefined,
  }
}

export function sshExec(client: Client, command: string): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream
        .on('data', (d: Buffer) => { stdout += d.toString() })
        .stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      stream.on('close', (code: number) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
    })
  })
}

export function connectSsh(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect(config)
  })
}

/** Try connecting with each key in order, returning the first that succeeds.
 *  On total failure throws an aggregated error listing what each key tried. */
export async function connectWithFallback(
  hostname: string,
  port: number,
  linuxUser: string,
  keys: Array<{ id: string; privatePem: string }>,
  hostKeyFingerprint?: string,
): Promise<{ client: Client; keyId: string }> {
  const errors: string[] = []
  for (const key of keys) {
    try {
      const cfg = buildConnectConfig(hostname, port, linuxUser, key.privatePem, hostKeyFingerprint)
      const client = await connectSsh(cfg)
      return { client, keyId: key.id }
    } catch (err) {
      errors.push(`[key ${key.id.slice(0, 8)}]: ${(err as Error).message}`)
    }
  }
  throw new Error(`All ${keys.length} key(s) failed to connect:\n${errors.join('\n')}`)
}

export async function withSsh<T>(
  hostname: string,
  port: number,
  linuxUser: string,
  privateKeyPem: string,
  fn: (client: Client) => Promise<T>,
  hostKeyFingerprint?: string,
): Promise<T> {
  const config = buildConnectConfig(hostname, port, linuxUser, privateKeyPem, hostKeyFingerprint)
  const client = await connectSsh(config)
  try {
    return await fn(client)
  } finally {
    client.end()
  }
}

export async function getRemoteHostFingerprint(hostname: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let fingerprint = ''

    client
      .on('ready', () => {
        // Shouldn't normally reach here with anonymous creds, but handle it
        client.end()
        resolve(fingerprint)
      })
      .on('error', (err) => {
        client.destroy()
        // hostVerifier runs during key-exchange — before auth.
        // If we captured a fingerprint already, auth failure is expected and irrelevant.
        if (fingerprint) {
          resolve(fingerprint)
        } else {
          reject(err)
        }
      })
      .connect({
        host: hostname,
        port,
        username: 'sshmanager-probe',   // any username — will fail auth but that's fine
        readyTimeout: 10000,
        hostVerifier: (keyHash: Buffer | string) => {
          fingerprint = Buffer.isBuffer(keyHash) ? keyHash.toString('hex') : String(keyHash)
          return true  // accept the key so we get to the auth stage (which will fail, resolving via on('error'))
        },
      })
  })
}
