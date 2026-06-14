// Quick SSH connection debug - run inside the api container
// Usage: node test-ssh-debug.mjs
import { Client } from 'ssh2'
import { createDecipheriv } from 'crypto'
import sshpk from 'sshpk'

const ENC = 'd4dfe77bb1ccbb68fdda9b27cb22d9be:fc31ade8d2874ff60f1e44da5410808c:zk4h54UNDbujzyIt2Mc70uGXsSMP1I7jg4uqUzlAtziqxqieHszpZPBmA8QfOCiYISpjOPOvkgNg7JC0+CLQGj3JvYcG6TpxyvRgTMPHYI/ysw8GpffunlgLelEN/Kt0caSmdSMkuHnEWv75i1pDcIVXl7E5APCb/Mt1LJA0i+Av4gV6jI8mUDngRYf7uatXdccVlO/AhTqLMS1tzdOSgGdQimQHQEuxKX4TNVJXaMxO0EwbjDYvjG7z+oSHUdCMvEUGceE22XlIJkAFQLCAVzCd1xkK7rvEhqHZfs5L61ni1OHtSoliF6Ci8H1keP/W9rbJg50/g1Spj3VnrgWhX/hRyklSXRuSrcrLEDQw2FDh9Bnc0yFHJ9KUvsEhNB5Pva1MzJ1gfO634ZfX0+4OzLlmoVjuhLMmbvWmpiexIAVtolTTQMLHBOFux4Jsdvqj0eMBeqIx5Saur7T5NDHu3NkyS5xntBSof7IqleE5FSpb1LeGOWWnwceh6go7k5Xo/khxmBzSLybKa30e+Pab'

// Decrypt (same logic as vault.ts)
const VAULT_KEY = process.env.VAULT_KEY
if (!VAULT_KEY) { console.error('VAULT_KEY env not set'); process.exit(1) }
const vaultKey = Buffer.from(VAULT_KEY, 'hex')

const [ivHex, authTagHex, ciphertext] = ENC.split(':')
const iv = Buffer.from(ivHex, 'hex')
const authTag = Buffer.from(authTagHex, 'hex')
const ct = Buffer.from(ciphertext, 'base64')
const decipher = createDecipheriv('aes-256-gcm', vaultKey, iv)
decipher.setAuthTag(authTag)
let decrypted = decipher.update(ct)
decrypted = Buffer.concat([decrypted, decipher.final()])
let privateKey = decrypted.toString('utf8')

console.log('Decrypted key format:', privateKey.split('\n')[0])

// Convert if needed
if (privateKey.includes('BEGIN PRIVATE KEY') || privateKey.includes('BEGIN RSA PRIVATE KEY')) {
  const format = privateKey.includes('BEGIN RSA PRIVATE KEY') ? 'pkcs1' : 'pkcs8'
  try {
    const parsed = sshpk.parsePrivateKey(privateKey, format)
    privateKey = parsed.toString('openssh')
    console.log('Converted to OpenSSH format')
  } catch(e) {
    console.error('Conversion failed:', e.message)
  }
}
console.log('Key header after conversion:', privateKey.split('\n')[0])

// Try SSH connection
const client = new Client()
const HOST_FP = '0000000b7373682d6564323535313900000020d463c5aa4897778544b5eddbe37831bd2549d0426d50c2133b7d850ff35379f0'

client.on('ready', () => {
  console.log('✅ SSH connected successfully!')
  client.end()
}).on('error', (err) => {
  console.error('❌ SSH error:', err.message)
}).connect({
  host: 'ubuntu-test',
  port: 22,
  username: 'root',
  privateKey,
  readyTimeout: 10000,
  hostVerifier: (keyHash) => {
    const incoming = Buffer.isBuffer(keyHash) ? keyHash.toString('hex') : String(keyHash)
    console.log('Host key incoming:', incoming.substring(0, 40) + '...')
    console.log('Stored fingerprint:', HOST_FP.substring(0, 40) + '...')
    const match = incoming === HOST_FP || Buffer.from(incoming, 'hex').toString('base64') === HOST_FP
    console.log('Fingerprint match:', match)
    return match
  }
})
