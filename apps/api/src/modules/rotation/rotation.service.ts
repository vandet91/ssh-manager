import { generateKeyPairSync } from 'crypto'
import sshpk from 'sshpk'
import { db } from '../../db/client'
import { encryptSecret, getVaultKey } from '../../utils/vault'
import { pemToAuthorizedKeysLine, getFingerprint } from '../../utils/ssh'
import { appendKeyToServer, removeKeyFromServer } from '../../utils/key-ops'
import { sendAlert } from '../../utils/webhook'
import { getRedis } from '../../jobs/redis'
import pino from 'pino'

const log = pino({ name: 'rotation' })

const LOCK_TTL_SECONDS = 600
/** How many days archived keys are kept before permanent deletion */
export const ARCHIVE_RETENTION_DAYS = 30

async function acquireLock(keyId: string): Promise<boolean> {
  const redis = getRedis()
  const result = await redis.set(`rotation:lock:${keyId}`, '1', 'EX', LOCK_TTL_SECONDS, 'NX')
  return result === 'OK'
}

async function releaseLock(keyId: string): Promise<void> {
  const redis = getRedis()
  await redis.del(`rotation:lock:${keyId}`)
}

function computeNextRotation(policy: string): Date | null {
  const days: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 }
  const d = days[policy]
  if (!d) return null
  const dt = new Date()
  dt.setDate(dt.getDate() + d)
  return dt
}

function purgeDate(): Date {
  const dt = new Date()
  dt.setDate(dt.getDate() + ARCHIVE_RETENTION_DAYS)
  return dt
}


export async function rotateKey(keyId: string, triggeredBy?: string): Promise<Record<string, unknown>> {
  const acquired = await acquireLock(keyId)
  if (!acquired) throw new Error('Another rotation job is already running for this key')
  try {
    return await performRotation(keyId, triggeredBy)
  } finally {
    await releaseLock(keyId)
  }
}

async function performRotation(keyId: string, triggeredBy?: string): Promise<Record<string, unknown>> {
  const vaultKey = getVaultKey()

  const oldKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', keyId).executeTakeFirst()
  if (!oldKey) throw new Error('Key not found')

  // Generate new keypair
  let newPemPrivate: string
  let newPemPublic: string
  if (oldKey.key_type === 'ed25519') {
    const kp = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    newPemPrivate = kp.privateKey; newPemPublic = kp.publicKey
  } else {
    const kp = generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
    newPemPrivate = kp.privateKey; newPemPublic = kp.publicKey
  }

  const newPublicKey = pemToAuthorizedKeysLine(newPemPublic)
  const newFingerprint = getFingerprint(newPemPublic)
  const parsedPriv = sshpk.parsePrivateKey(newPemPrivate, 'pkcs8')
  const newOpenSshPrivate = parsedPriv.toString('openssh')
  const newPrivateKeyEnc = encryptSecret(newOpenSshPrivate, vaultKey)

  const assignments = await db.selectFrom('key_assignments').selectAll()
    .where('key_id', '=', keyId).where('is_active', '=', true).execute()

  const [job] = await db.insertInto('rotation_jobs').values({
    key_id: keyId,
    status: 'running',
    triggered_by: triggeredBy ?? null,
    started_at: new Date(),
    affected_servers: JSON.stringify(assignments.map((a) => ({ server_id: a.server_id, linux_user: a.linux_user, status: 'pending' }))),
  }).returningAll().execute()

  const results: Array<{ server_id: string; linux_user: string; status: string; error?: string }> = []
  let allSuccess = true

  // Step 1: Append new key to every assigned server
  for (const assignment of assignments) {
    try {
      const server = await db.selectFrom('servers').selectAll().where('id', '=', assignment.server_id).executeTakeFirst()
      if (!server) throw new Error('Server not found')
      await appendKeyToServer(server, assignment.linux_user, newPublicKey)
      results.push({ server_id: assignment.server_id, linux_user: assignment.linux_user, status: 'success' })
    } catch (err: unknown) {
      allSuccess = false
      results.push({ server_id: assignment.server_id, linux_user: assignment.linux_user, status: 'failed', error: (err as Error).message })
      log.error({ err, assignment }, 'Failed to append new key during rotation')
    }
  }

  if (allSuccess) {
    // Step 2: Remove old key from servers
    for (const assignment of assignments) {
      try {
        const server = await db.selectFrom('servers').selectAll().where('id', '=', assignment.server_id).executeTakeFirst()
        if (!server) continue
        const oldKeyBody = oldKey.public_key.trim().split(' ')[1] ?? ''
        await removeKeyFromServer(server, assignment.linux_user, oldKeyBody)
      } catch (err: unknown) {
        log.error({ err, assignment }, 'Failed to remove old key during rotation — continuing')
      }
    }

    // Step 3: Create the new key record (successor), keeping all metadata from old key
    const [newKeyRecord] = await db.insertInto('ssh_keys').values({
      name: oldKey.name,
      description: oldKey.description,
      key_type: oldKey.key_type,
      public_key: newPublicKey,
      private_key_enc: newPrivateKeyEnc,
      fingerprint: newFingerprint,
      rotation_policy: oldKey.rotation_policy,
      last_rotated_at: new Date(),
      next_rotation_at: computeNextRotation(oldKey.rotation_policy),
      created_by: oldKey.created_by,
      predecessor_key_id: oldKey.id,
    }).returningAll().execute()

    // Step 4: Archive the old key (keep private key for revert, but deactivate)
    await db.updateTable('ssh_keys').set({
      is_active: false,
      archived_at: new Date(),
      archive_reason: 'rotated',
      archived_by: triggeredBy ?? null,
      purge_after: purgeDate(),
      successor_key_id: newKeyRecord.id,
      updated_at: new Date(),
    }).where('id', '=', keyId).execute()

    // Step 5: Re-point all assignments to the new key
    if (assignments.length > 0) {
      await db.updateTable('key_assignments')
        .set({ key_id: newKeyRecord.id })
        .where('key_id', '=', keyId)
        .execute()
    }

    // Step 6: Re-point server management_key_id if this was a management key
    await db.updateTable('servers')
      .set({ management_key_id: newKeyRecord.id, updated_at: new Date() })
      .where('management_key_id', '=', keyId)
      .execute()

    await db.updateTable('rotation_jobs').set({
      status: 'success',
      completed_at: new Date(),
      affected_servers: JSON.stringify(results),
      key_id: newKeyRecord.id,   // point job at the new key for traceability
    }).where('id', '=', job.id).execute()

    return { ...job, new_key_id: newKeyRecord.id, affected_servers: results, status: 'success' }
  } else {
    // Rollback: remove newly-appended key from servers that succeeded
    for (const r of results.filter((x) => x.status === 'success')) {
      try {
        const server = await db.selectFrom('servers').selectAll().where('id', '=', r.server_id).executeTakeFirst()
        if (!server) continue
        const newKeyBody = newPublicKey.trim().split(' ')[1] ?? ''
        await removeKeyFromServer(server, r.linux_user, newKeyBody)
      } catch (err: unknown) {
        log.error({ err, r }, 'Failed to rollback new key during rotation failure')
      }
    }

    const errorSummary = results.filter((x) => x.status === 'failed').map((x) => `${x.server_id}/${x.linux_user}: ${x.error}`).join('; ')
    await db.updateTable('rotation_jobs').set({
      status: 'rolled_back', completed_at: new Date(), error_message: errorSummary, affected_servers: JSON.stringify(results),
    }).where('id', '=', job.id).execute()
    await sendAlert({
      event: 'rotation_failed',
      title: 'Key Rotation Failed',
      message: `Rotation failed for key ${keyId}: ${errorSummary}`,
      severity: 'critical',
      details: { key_id: keyId, error: errorSummary },
    })

    return { ...job, affected_servers: results, status: 'rolled_back' }
  }
}

/** Revert a rotation: push the old key back, remove the new key, swap assignments back.
 *  archivedKeyId = the OLD key (currently archived with archive_reason='rotated'). */
export async function revertRotation(archivedKeyId: string, triggeredBy?: string): Promise<void> {
  const acquired = await acquireLock(archivedKeyId)
  if (!acquired) throw new Error('Another rotation job is running — try again shortly')
  try {
    await performRevert(archivedKeyId, triggeredBy)
  } finally {
    await releaseLock(archivedKeyId)
  }
}

async function performRevert(archivedKeyId: string, triggeredBy?: string): Promise<void> {
  const oldKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', archivedKeyId).executeTakeFirst()
  if (!oldKey) throw new Error('Key not found')
  if (!oldKey.successor_key_id) throw new Error('No successor key — nothing to revert')
  if (oldKey.archive_reason !== 'rotated') throw new Error('Only rotated keys can be reverted')

  const newKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', oldKey.successor_key_id).executeTakeFirst()
  if (!newKey) throw new Error('Successor key not found')

  // Find all assignments currently pointing at the new key (our successor)
  const assignments = await db.selectFrom('key_assignments').selectAll()
    .where('key_id', '=', newKey.id).where('is_active', '=', true).execute()

  const errors: string[] = []

  // For each server: push old key back, remove new key
  for (const assignment of assignments) {
    try {
      const server = await db.selectFrom('servers').selectAll().where('id', '=', assignment.server_id).executeTakeFirst()
      if (!server) continue
      // Push old key first (so there's always at least one valid key on the server)
      await appendKeyToServer(server, assignment.linux_user, oldKey.public_key)
      // Then remove the new key
      const newKeyBody = newKey.public_key.trim().split(' ')[1] ?? ''
      await removeKeyFromServer(server, assignment.linux_user, newKeyBody)
    } catch (err: unknown) {
      errors.push(`${assignment.server_id}/${assignment.linux_user}: ${(err as Error).message}`)
      log.error({ err, assignment }, 'Failed to revert key on server')
    }
  }

  if (errors.length > 0) throw new Error(`Revert partially failed:\n${errors.join('\n')}`)

  // Swap assignments back to old key
  if (assignments.length > 0) {
    await db.updateTable('key_assignments').set({ key_id: archivedKeyId })
      .where('key_id', '=', newKey.id).execute()
  }

  // Re-point any management_key_id that pointed to the new key
  await db.updateTable('servers')
    .set({ management_key_id: archivedKeyId, updated_at: new Date() })
    .where('management_key_id', '=', newKey.id)
    .execute()

  // Restore old key to active
  await db.updateTable('ssh_keys').set({
    is_active: true,
    archived_at: null,
    archive_reason: null,
    archived_by: null,
    purge_after: null,
    successor_key_id: null,
    updated_at: new Date(),
  }).where('id', '=', archivedKeyId).execute()

  // Archive the new key (mark as reverted so it's visible in the archive)
  await db.updateTable('ssh_keys').set({
    is_active: false,
    archived_at: new Date(),
    archive_reason: 'reverted',
    archived_by: triggeredBy ?? null,
    purge_after: purgeDate(),
    updated_at: new Date(),
  }).where('id', '=', newKey.id).execute()

  log.info({ archivedKeyId, newKeyId: newKey.id, triggeredBy }, 'Key rotation reverted')
}

/** Permanently delete archived keys whose purge_after date has passed. */
export async function purgeExpiredArchivedKeys(): Promise<number> {
  const now = new Date()
  const expired = await db.selectFrom('ssh_keys')
    .select(['id', 'name'])
    .where('is_active', '=', false)
    .where('purge_after', '<', now)
    .where('archived_at', 'is not', null)
    .execute()

  if (expired.length === 0) return 0

  for (const key of expired) {
    await db.deleteFrom('ssh_keys').where('id', '=', key.id).execute()
    log.info({ keyId: key.id, name: key.name }, 'Permanently purged expired archived key')
  }

  return expired.length
}
