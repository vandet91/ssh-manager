import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { generateKeyPairSync } from 'crypto'
import sshpk from 'sshpk'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'
import { parsePpk, isPpkFile } from '../../utils/ppk'
import { pemToAuthorizedKeysLine, getFingerprint } from '../../utils/ssh'
import { revertRotation, purgeExpiredArchivedKeys, ARCHIVE_RETENTION_DAYS } from '../rotation/rotation.service'
import { convertToPpk } from '../../utils/ppk-export'

function computeNextRotation(policy: string): Date | null {
  const days: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 }
  const d = days[policy]
  if (!d) return null
  const dt = new Date()
  dt.setDate(dt.getDate() + d)
  return dt
}

async function serversRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /keys
  fastify.get('/keys', { preHandler: requirePermission('keys:read') }, async () => {
    return db.selectFrom('ssh_keys')
      .select(['id', 'name', 'description', 'key_type', 'public_key', 'fingerprint', 'rotation_policy', 'last_rotated_at', 'next_rotation_at', 'is_active', 'created_by', 'created_at', 'updated_at'])
      .where('is_active', '=', true)
      .execute()
  })

  // GET /keys/archived
  fastify.get('/keys/archived', { preHandler: requirePermission('keys:read') }, async () => {
    return db.selectFrom('ssh_keys')
      .select(['id', 'name', 'description', 'key_type', 'fingerprint', 'rotation_policy',
        'archived_at', 'archive_reason', 'purge_after', 'successor_key_id', 'predecessor_key_id',
        'last_rotated_at', 'created_at', 'updated_at'])
      .where('is_active', '=', false)
      .where('archived_at', 'is not', null)
      .orderBy('archived_at', 'desc')
      .execute()
  })

  // POST /keys/generate
  fastify.post('/keys/generate', { preHandler: requirePermission('keys:write') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      key_type: z.enum(['ed25519', 'rsa4096']).default('ed25519'),
      rotation_policy: z.enum(['manual', '7d', '30d', '90d', '180d', '365d']).default('manual'),
    }).parse(req.body)

    const vaultKey = getVaultKey()

    let pemPrivate: string
    let pemPublic: string

    if (body.key_type === 'ed25519') {
      const kp = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      pemPrivate = kp.privateKey
      pemPublic = kp.publicKey
    } else {
      const kp = generateKeyPairSync('rsa', {
        modulusLength: 4096,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      })
      pemPrivate = kp.privateKey
      pemPublic = kp.publicKey
    }

    // Convert PKCS8 → OpenSSH so ssh2 can authenticate with it
    const parsedPriv = sshpk.parsePrivateKey(pemPrivate, 'pkcs8')
    const opensshPrivate = parsedPriv.toString('openssh')

    const authorizedKeysLine = pemToAuthorizedKeysLine(pemPublic)
    const fingerprint = getFingerprint(pemPublic)
    const privateKeyEnc = encryptSecret(opensshPrivate, vaultKey)

    const key = await db.insertInto('ssh_keys').values({
      name: body.name,
      description: body.description ?? null,
      key_type: body.key_type,
      public_key: authorizedKeysLine,
      private_key_enc: privateKeyEnc,
      fingerprint,
      rotation_policy: body.rotation_policy,
      next_rotation_at: computeNextRotation(body.rotation_policy),
      created_by: req.session.user!.id,
    }).returningAll().executeTakeFirst()

    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'key.generated', resource: 'ssh_key', resourceId: key!.id, request: req })
    return reply.code(201).send({ ...key, private_key_enc: undefined })
  })

  // POST /keys/import — supports OpenSSH PEM and PuTTY .ppk
  fastify.post('/keys/import', { preHandler: requirePermission('keys:write') }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      rotation_policy: z.enum(['manual', '7d', '30d', '90d', '180d', '365d']).default('manual'),
      public_key: z.string().optional(),
      private_key: z.string(),   // PEM (PKCS8/PKCS1/OpenSSH) or PPK content
      passphrase: z.string().optional(),
    }).parse(req.body)

    const vaultKey = getVaultKey()

    let pemPrivate: string
    let pemPublic: string
    let keyType: 'ed25519' | 'rsa4096' = 'ed25519'

    if (isPpkFile(body.private_key)) {
      // PuTTY PPK format
      const parsed = await parsePpk(body.private_key, body.passphrase)
      pemPrivate = parsed.privateKeyPem
      pemPublic = parsed.publicKeyPem
      keyType = (parsed.keyType as 'ed25519' | 'rsa4096') || 'ed25519'
    } else {
      // Standard PEM
      pemPrivate = body.private_key
      if (body.public_key) {
        pemPublic = body.public_key
      } else {
        // Derive public key from private key using sshpk
        try {
          const parsedPriv = sshpk.parsePrivateKey(pemPrivate, 'pem')
          const pub = parsedPriv.toPublic()
          pemPublic = pub.toString('pem')
        } catch {
          return reply.code(400).send({ error: 'Could not derive public key from private key. Please provide public_key separately.' })
        }
      }

      // Detect type from public key
      try {
        const pk = sshpk.parseKey(pemPublic, 'pem')
        keyType = pk.type === 'ed25519' ? 'ed25519' : 'rsa4096'
      } catch { /* default to ed25519 */ }
    }

    const authorizedKeysLine = pemToAuthorizedKeysLine(pemPublic)
    const fingerprint = getFingerprint(pemPublic)
    const privateKeyEnc = encryptSecret(pemPrivate, vaultKey)

    const key = await db.insertInto('ssh_keys').values({
      name: body.name,
      description: body.description ?? null,
      key_type: keyType,
      public_key: authorizedKeysLine,
      private_key_enc: privateKeyEnc,
      fingerprint,
      rotation_policy: body.rotation_policy,
      next_rotation_at: computeNextRotation(body.rotation_policy),
      created_by: req.session.user!.id,
    }).returningAll().executeTakeFirst()

    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'key.imported', resource: 'ssh_key', resourceId: key!.id, request: req })
    return reply.code(201).send({ ...key, private_key_enc: undefined })
  })

  // GET /keys/:id
  fastify.get('/keys/:id', { preHandler: requirePermission('keys:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const key = await db.selectFrom('ssh_keys')
      .select(['id', 'name', 'description', 'key_type', 'public_key', 'fingerprint', 'rotation_policy', 'last_rotated_at', 'next_rotation_at', 'is_active', 'created_by', 'created_at', 'updated_at'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'Key not found' })

    const rotations = await db.selectFrom('rotation_jobs')
      .selectAll().where('key_id', '=', id)
      .orderBy('created_at', 'desc').limit(10)
      .execute()

    return { ...key, rotation_history: rotations }
  })

  // PATCH /keys/:id
  fastify.patch('/keys/:id', { preHandler: requirePermission('keys:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      rotation_policy: z.enum(['manual', '7d', '30d', '90d', '180d', '365d']).optional(),
    }).parse(req.body)

    const updates: Record<string, unknown> = { ...body, updated_at: new Date() }
    if (body.rotation_policy) updates.next_rotation_at = computeNextRotation(body.rotation_policy)

    const key = await db.updateTable('ssh_keys').set(updates).where('id', '=', id).returningAll().executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'Key not found' })
    return { ...key, private_key_enc: undefined }
  })

  // GET /keys/orphaned-assignments — keys that have active assignments pointing to deleted servers
  fastify.get('/keys/orphaned-assignments', { preHandler: requirePermission('keys:read') }, async (_req, reply) => {
    const rows = await db.selectFrom('key_assignments')
      .innerJoin('ssh_keys', 'ssh_keys.id', 'key_assignments.key_id')
      .leftJoin('servers', 'servers.id', 'key_assignments.server_id')
      .select([
        'key_assignments.key_id',
        'ssh_keys.name as key_name',
        'key_assignments.server_id',
        'key_assignments.linux_user',
        'servers.name as server_name',
        'servers.is_active as server_active',
      ])
      .where('key_assignments.is_active', '=', true)
      .where((eb) => eb.or([
        eb('servers.id', 'is', null),
        eb('servers.is_active', '=', false),
      ]))
      .execute()
    return rows
  })

  // POST /keys/cleanup-orphans — deactivate all assignments pointing to deleted servers
  fastify.post('/keys/cleanup-orphans', { preHandler: requirePermission('keys:write') }, async (req, reply) => {
    const result = await db.updateTable('key_assignments')
      .set({ is_active: false })
      .where('is_active', '=', true)
      .where('server_id', 'not in',
        db.selectFrom('servers').select('id').where('is_active', '=', true)
      )
      .execute()
    const cleaned = Number((result as unknown as { numUpdatedRows: bigint }).numUpdatedRows ?? 0)
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'keys.orphans_cleaned', details: { rows: cleaned }, request: req })
    return { cleaned }
  })

  // DELETE /keys/:id — moves to archive (soft delete)
  fastify.delete('/keys/:id', { preHandler: requirePermission('keys:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    // Auto-clean orphaned assignments (server was deleted but assignments weren't deactivated)
    await db.updateTable('key_assignments')
      .set({ is_active: false })
      .where('key_id', '=', id)
      .where('is_active', '=', true)
      .where('server_id', 'not in',
        db.selectFrom('servers').select('id').where('is_active', '=', true)
      )
      .execute()

    const activeAssignments = await db.selectFrom('key_assignments')
      .innerJoin('servers', 'servers.id', 'key_assignments.server_id')
      .selectAll('key_assignments')
      .where('key_assignments.key_id', '=', id)
      .where('key_assignments.is_active', '=', true)
      .where('servers.is_active', '=', true)
      .execute()
    if (activeAssignments.length > 0) {
      return reply.code(409).send({ error: `Key has ${activeAssignments.length} active assignment(s) — revoke them first`, count: activeAssignments.length })
    }

    const managedServers = await db.selectFrom('servers').select(['id', 'name'])
      .where('management_key_id', '=', id).where('is_active', '=', true).execute()
    if (managedServers.length > 0) {
      const names = managedServers.map((s) => s.name).join(', ')
      return reply.code(409).send({ error: `Key is the management key for server(s): ${names} — reassign or decommission those servers first`, count: managedServers.length })
    }

    const purgeAfter = new Date()
    purgeAfter.setDate(purgeAfter.getDate() + ARCHIVE_RETENTION_DAYS)

    await db.updateTable('ssh_keys').set({
      is_active: false,
      archived_at: new Date(),
      archive_reason: 'deleted',
      archived_by: req.session.user!.id,
      purge_after: purgeAfter,
      updated_at: new Date(),
    }).where('id', '=', id).execute()

    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'key.archived', resource: 'ssh_key', resourceId: id, request: req })
    reply.code(204).send()
  })

  // POST /keys/:id/revert — revert a rotation, push old key back to servers
  fastify.post('/keys/:id/revert', { preHandler: requirePermission('keys:rotate') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const key = await db.selectFrom('ssh_keys').selectAll().where('id', '=', id).executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'Key not found' })
    if (key.archive_reason !== 'rotated') return reply.code(400).send({ error: 'Only keys archived by rotation can be reverted' })
    if (!key.successor_key_id) return reply.code(400).send({ error: 'No successor key linked — cannot revert' })

    try {
      await revertRotation(id, req.session.user!.id)
      await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'key.rotation.reverted', resource: 'ssh_key', resourceId: id, request: req })
      return { ok: true, message: 'Rotation reverted — old key is active again' }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // DELETE /keys/archived/:id — permanently delete an archived key immediately
  fastify.delete('/keys/archived/:id', { preHandler: requirePermission('keys:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const key = await db.selectFrom('ssh_keys').select(['id', 'is_active', 'archived_at']).where('id', '=', id).executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'Key not found' })
    if (key.is_active) return reply.code(400).send({ error: 'Key is still active — delete it first' })
    if (!key.archived_at) return reply.code(400).send({ error: 'Key is not archived' })

    // Block if any ACTIVE server still uses this as management key
    const activeServers = await db.selectFrom('servers').select(['name'])
      .where('management_key_id', '=', id).where('is_active', '=', true).execute()
    if (activeServers.length > 0) {
      const names = activeServers.map((s) => s.name).join(', ')
      return reply.code(409).send({ error: `Key is still the management key for active server(s): ${names}` })
    }

    // Null out management_key_id on inactive/decommissioned servers referencing this key
    await db.updateTable('servers').set({ management_key_id: null })
      .where('management_key_id', '=', id).execute()

    // Also clear any key_assignments still referencing this key (soft-deleted assignments)
    await db.updateTable('key_assignments').set({ is_active: false })
      .where('key_id', '=', id).execute()

    // Null out key_id on rotation_jobs referencing this key (historical records, keep the jobs)
    await (db as any).updateTable('rotation_jobs').set({ key_id: null })
      .where('key_id', '=', id).execute()

    await db.deleteFrom('ssh_keys').where('id', '=', id).execute()
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'key.purged', resource: 'ssh_key', resourceId: id, request: req })
    reply.code(204).send()
  })

  // POST /keys/purge-expired — trigger manual purge of expired archived keys
  fastify.post('/keys/purge-expired', { preHandler: requirePermission('keys:write') }, async () => {
    const count = await purgeExpiredArchivedKeys()
    return { purged: count }
  })

  // GET /keys/:id/public
  fastify.get('/keys/:id/public', { preHandler: requirePermission('keys:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const key = await db.selectFrom('ssh_keys').select(['name', 'public_key']).where('id', '=', id).executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'Key not found' })
    reply.header('Content-Type', 'text/plain')
    reply.header('Content-Disposition', `attachment; filename="${key.name}.pub"`)
    return reply.send(key.public_key)
  })

  // GET /keys/:id/private?format=openssh|ppk — download decrypted private key (admin/operator only)
  fastify.get('/keys/:id/private', { preHandler: requirePermission('keys:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { format } = z.object({ format: z.enum(['openssh', 'ppk']).default('openssh') }).parse(req.query)

    const key = await db.selectFrom('ssh_keys')
      .select(['name', 'key_type', 'private_key_enc', 'is_active'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'Key not found' })

    const vaultKey = getVaultKey()
    const opensshKey = decryptSecret(key.private_key_enc, vaultKey)

    await writeAuditLog({
      userId: req.session.user!.id,
      userEmail: req.session.user!.email,
      action: 'key.private_downloaded',
      resource: 'ssh_key',
      resourceId: id,
      details: { format },
      request: req,
    })

    const safeName = key.name.replace(/[^a-z0-9_\-]/gi, '_')

    if (format === 'ppk') {
      try {
        const ppkContent = convertToPpk(opensshKey, key.name)
        reply.header('Content-Type', 'application/octet-stream')
        reply.header('Content-Disposition', `attachment; filename="${safeName}.ppk"`)
        return reply.send(ppkContent)
      } catch (err: unknown) {
        return reply.code(500).send({ error: `PPK conversion failed: ${(err as Error).message}` })
      }
    }

    reply.header('Content-Type', 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`)
    return reply.send(opensshKey)
  })
}

export default serversRoutes
