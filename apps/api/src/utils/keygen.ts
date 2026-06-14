import { generateKeyPairSync } from 'crypto'
import sshpk from 'sshpk'

export interface GeneratedKeyPair {
  pemPrivate: string      // OpenSSH format — compatible with ssh2
  pemPublic: string       // SPKI PEM
  authorizedKeysLine: string
  fingerprint: string
}

export function generateKeyPair(type: 'ed25519' | 'rsa4096' = 'ed25519'): GeneratedKeyPair {
  let pemPrivatePkcs8: string
  let pemPublic: string

  if (type === 'ed25519') {
    const kp = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    pemPrivatePkcs8 = kp.privateKey
    pemPublic = kp.publicKey
  } else {
    const kp = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    pemPrivatePkcs8 = kp.privateKey
    pemPublic = kp.publicKey
  }

  // Convert PKCS8 → OpenSSH format. ssh2 requires OpenSSH private key format
  // for Ed25519; PKCS8 causes "All configured authentication methods failed".
  const parsedPriv = sshpk.parsePrivateKey(pemPrivatePkcs8, 'pkcs8')
  const pemPrivate = parsedPriv.toString('openssh')

  const parsedPub = sshpk.parseKey(pemPublic, 'pem')
  const authorizedKeysLine = parsedPub.toString('ssh')
  const fingerprint = parsedPub.fingerprint('sha256').toString()

  return { pemPrivate, pemPublic, authorizedKeysLine, fingerprint }
}
