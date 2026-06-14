import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret } from './vault'
import { randomBytes } from 'crypto'

describe('vault', () => {
  const key = randomBytes(32)

  it('encrypts and decrypts a string round-trip', () => {
    const plaintext = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB...'
    const encrypted = encryptSecret(plaintext, key)
    expect(encrypted).not.toBe(plaintext)
    expect(decryptSecret(encrypted, key)).toBe(plaintext)
  })

  it('produces different ciphertext for same input (random IV)', () => {
    const plaintext = 'same input'
    const enc1 = encryptSecret(plaintext, key)
    const enc2 = encryptSecret(plaintext, key)
    expect(enc1).not.toBe(enc2)
  })

  it('throws on wrong key', () => {
    const plaintext = 'secret'
    const encrypted = encryptSecret(plaintext, key)
    const wrongKey = randomBytes(32)
    expect(() => decryptSecret(encrypted, wrongKey)).toThrow()
  })

  it('throws on tampered ciphertext', () => {
    const plaintext = 'secret'
    const encrypted = encryptSecret(plaintext, key)
    const parts = encrypted.split(':')
    parts[2] = Buffer.from('tampered').toString('base64')
    expect(() => decryptSecret(parts.join(':'), key)).toThrow()
  })
})
