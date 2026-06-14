/**
 * One-time script: converts all PKCS8 private keys in the vault to OpenSSH format.
 * Run with: npx ts-node src/scripts/fix-key-format.ts
 */
import sshpk from 'sshpk'
import { db } from '../db/client'
import { decryptSecret, encryptSecret, getVaultKey } from '../utils/vault'

async function main() {
  const vaultKey = getVaultKey()
  const keys = await db.selectFrom('ssh_keys').select(['id', 'name', 'private_key_enc']).execute()

  let fixed = 0
  for (const key of keys) {
    const pem = decryptSecret(key.private_key_enc, vaultKey)

    if (pem.includes('BEGIN PRIVATE KEY') || pem.includes('BEGIN RSA PRIVATE KEY')) {
      console.log(`Converting ${key.name} (${key.id}) from PKCS8 → OpenSSH...`)
      try {
        const parsed = sshpk.parsePrivateKey(pem, 'pkcs8')
        const openssh = parsed.toString('openssh')
        const enc = encryptSecret(openssh, vaultKey)
        await db.updateTable('ssh_keys').set({ private_key_enc: enc }).where('id', '=', key.id).execute()
        console.log(`  ✓ Done`)
        fixed++
      } catch (e) {
        console.error(`  ✗ Failed: ${(e as Error).message}`)
      }
    } else {
      console.log(`${key.name}: already OpenSSH format, skipping`)
    }
  }
  console.log(`\nConverted ${fixed}/${keys.length} keys`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
