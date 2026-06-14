import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGORITHM = 'aes-256-gcm'

export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, masterKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`
}

export function decryptSecret(stored: string, masterKey: Buffer): string {
  const [ivHex, tagHex, ciphertextB64] = stored.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export function getVaultKey(): Buffer {
  const hex = process.env.VAULT_ENCRYPTION_KEY ?? ''
  if (hex.length !== 64) throw new Error('VAULT_ENCRYPTION_KEY must be 32 bytes (64 hex chars)')
  return Buffer.from(hex, 'hex')
}
