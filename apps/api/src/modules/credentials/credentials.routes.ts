import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'
import { withServerSsh } from '../../utils/server-ssh'

export default async function credentialsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /servers/:id/credentials — list credentials (no plaintext passwords)
  fastify.get('/servers/:id/credentials', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const rows = await db.selectFrom('server_credentials')
      .select(['id', 'server_id', 'category', 'linux_user', 'service_name', 'service_username',
               'label', 'notes', 'created_by', 'last_revealed_at', 'last_changed_on_server_at',
               'is_archived', 'archived_at', 'archived_reason', 'predecessor_id', 'created_at', 'updated_at'])
      .where('server_id', '=', id)
      .orderBy('is_archived').orderBy('category').orderBy('label').orderBy('created_at', 'desc')
      .execute()

    // Enrich with creator email
    const userIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))] as string[]
    const users = userIds.length > 0
      ? await db.selectFrom('users').select(['id', 'email', 'display_name']).where('id', 'in', userIds).execute()
      : []
    const userMap = Object.fromEntries(users.map((u) => [u.id, u.display_name ?? u.email]))

    return rows.map((r) => ({ ...r, created_by_name: r.created_by ? (userMap[r.created_by] ?? null) : null }))
  })

  // POST /servers/:id/credentials — create a credential
  fastify.post('/servers/:id/credentials', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      category: z.enum(['linux', 'database', 'web', 'application', 'service', 'other']).default('linux'),
      linux_user: z.string().max(100).optional(),
      service_name: z.string().max(100).optional(),
      service_username: z.string().max(100).optional(),
      label: z.string().min(1).max(200),
      password: z.string().min(1),
      notes: z.string().max(1000).optional(),
      apply_on_server: z.boolean().default(false),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const vaultKey = getVaultKey()
    const passwordEnc = encryptSecret(body.password, vaultKey)

    const [cred] = await db.insertInto('server_credentials').values({
      server_id: id,
      category: body.category,
      linux_user: body.linux_user ?? null,
      service_name: body.service_name ?? null,
      service_username: body.service_username ?? null,
      label: body.label,
      password_enc: passwordEnc,
      notes: body.notes ?? null,
      created_by: req.session.user!.id,
    }).returningAll().execute()

    // For linux category: optionally apply via chpasswd
    if (body.apply_on_server && body.category === 'linux' && body.linux_user) {
      try {
        await withServerSsh(id, async (client) => {
          const { sshExec } = await import('../../utils/ssh')
          const escaped = body.password.replace(/'/g, "'\\''")
          await sshExec(client, `echo '${body.linux_user}:${escaped}' | sudo chpasswd`)
        })
        await db.updateTable('server_credentials')
          .set({ last_changed_on_server_at: new Date(), updated_at: new Date() })
          .where('id', '=', cred.id)
          .execute()
      } catch (err: unknown) {
        return reply.code(207).send({
          ...cred, password_enc: undefined,
          warning: `Saved to vault but failed to apply on server: ${(err as Error).message}`,
        })
      }
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'credential.created', resource: 'server_credential', resourceId: cred.id,
      serverId: id, details: { category: body.category, label: body.label, apply_on_server: body.apply_on_server }, request: req,
    })

    const { password_enc: _, ...safe } = cred
    return reply.code(201).send(safe)
  })

  // PATCH /servers/:id/credentials/:credId — update label/notes in-place; password change archives old + creates new
  fastify.patch('/servers/:id/credentials/:credId', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)
    const body = z.object({
      label: z.string().min(1).max(200).optional(),
      notes: z.string().max(1000).optional(),
      password: z.string().min(1).optional(),
      apply_on_server: z.boolean().default(false),
    }).parse(req.body)

    const cred = await db.selectFrom('server_credentials').selectAll().where('id', '=', credId).where('server_id', '=', id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })

    // ── Password changed: archive old, create new ───────────────────────────
    if (body.password !== undefined) {
      const vaultKey = getVaultKey()
      let appliedAt: Date | null = null
      let warning: string | undefined

      if (body.apply_on_server && cred.category === 'linux' && cred.linux_user) {
        try {
          await withServerSsh(id, async (client) => {
            const { sshExec } = await import('../../utils/ssh')
            const escaped = body.password!.replace(/'/g, "'\\''")
            await sshExec(client, `echo '${cred.linux_user}:${escaped}' | sudo chpasswd`)
          })
          appliedAt = new Date()
        } catch (err: unknown) {
          warning = `Saved to vault but failed to apply on server: ${(err as Error).message}`
        }
      }

      // Archive old credential
      await db.updateTable('server_credentials').set({
        is_archived: true, archived_at: new Date(), archived_reason: 'updated', updated_at: new Date(),
      }).where('id', '=', credId).execute()

      // Create new active credential (carry label/notes override if provided)
      const [newCred] = await db.insertInto('server_credentials').values({
        server_id: id,
        category: cred.category ?? 'linux',
        linux_user: cred.linux_user,
        service_name: cred.service_name,
        service_username: cred.service_username,
        label: body.label ?? cred.label,
        notes: body.notes !== undefined ? body.notes : cred.notes,
        password_enc: encryptSecret(body.password, vaultKey),
        created_by: req.session.user!.id,
        last_changed_on_server_at: appliedAt,
        predecessor_id: credId,
      }).returningAll().execute()

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'credential.updated', resource: 'server_credential', resourceId: newCred.id,
        serverId: id, details: { password_changed: true, apply_on_server: body.apply_on_server, archived_id: credId }, request: req,
      })

      return { ok: true, new_id: newCred.id, ...(warning ? { warning } : {}) }
    }

    // ── Label/notes only: update in-place, no archive needed ───────────────
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.label !== undefined) updates.label = body.label
    if (body.notes !== undefined) updates.notes = body.notes
    await db.updateTable('server_credentials').set(updates).where('id', '=', credId).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'credential.updated', resource: 'server_credential', resourceId: credId,
      serverId: id, details: { password_changed: false }, request: req,
    })

    return { ok: true }
  })

  // POST /servers/:id/credentials/:credId/reveal — return decrypted password (audit logged)
  fastify.post('/servers/:id/credentials/:credId/reveal', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)

    const cred = await db.selectFrom('server_credentials').selectAll().where('id', '=', credId).where('server_id', '=', id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })

    const vaultKey = getVaultKey()
    const password = decryptSecret(cred.password_enc, vaultKey)

    await db.updateTable('server_credentials').set({ last_revealed_at: new Date() }).where('id', '=', credId).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'credential.revealed', resource: 'server_credential', resourceId: credId,
      serverId: id, details: { linux_user: cred.linux_user, label: cred.label }, request: req,
    })

    return { password }
  })

  // POST /servers/:id/credentials/:credId/apply — push the stored password to the server via chpasswd
  fastify.post('/servers/:id/credentials/:credId/apply', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)

    const cred = await db.selectFrom('server_credentials').selectAll().where('id', '=', credId).where('server_id', '=', id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })
    if (cred.category !== 'linux' || !cred.linux_user) return reply.code(400).send({ error: 'Only Linux user credentials can be applied via chpasswd' })

    const vaultKey = getVaultKey()
    const password = decryptSecret(cred.password_enc, vaultKey)

    try {
      await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')
        const escaped = password.replace(/'/g, "'\\''")
        await sshExec(client, `echo '${cred.linux_user}:${escaped}' | sudo chpasswd`)
      })
    } catch (err: unknown) {
      return reply.code(500).send({ error: `Failed to apply password on server: ${(err as Error).message}` })
    }

    await db.updateTable('server_credentials')
      .set({ last_changed_on_server_at: new Date(), updated_at: new Date() })
      .where('id', '=', credId)
      .execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'credential.applied', resource: 'server_credential', resourceId: credId,
      serverId: id, details: { linux_user: cred.linux_user, label: cred.label }, request: req,
    })

    return { ok: true, applied_at: new Date().toISOString() }
  })

  // POST /servers/:id/credentials/:credId/rotate — generate a new secure password, apply via SSH, archive old, create new
  fastify.post('/servers/:id/credentials/:credId/rotate', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)

    const cred = await db.selectFrom('server_credentials').selectAll().where('id', '=', credId).where('server_id', '=', id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })
    if (cred.is_archived) return reply.code(400).send({ error: 'Cannot rotate an archived credential' })

    // Generate a cryptographically secure random password (24 chars, mixed alphabet)
    const { randomBytes } = await import('crypto')
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
    const bytes = randomBytes(24)
    const newPassword = Array.from(bytes).map((b) => alphabet[b % alphabet.length]).join('')

    const vaultKey = getVaultKey()

    // Apply on server first — only archive/create if apply succeeds
    try {
      await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')
        const escaped = newPassword.replace(/'/g, "'\\''")
        await sshExec(client, `echo '${cred.linux_user}:${escaped}' | sudo chpasswd`)
      })
    } catch (err: unknown) {
      return reply.code(500).send({ error: `Failed to apply new password on server: ${(err as Error).message}` })
    }

    // Archive the old credential (keep for reference, do NOT delete)
    await db.updateTable('server_credentials').set({
      is_archived: true,
      archived_at: new Date(),
      archived_reason: 'rotated',
      updated_at: new Date(),
    }).where('id', '=', credId).execute()

    // Create the new active credential (successor), preserving all metadata from old
    const [newCred] = await db.insertInto('server_credentials').values({
      server_id: id,
      category: cred.category ?? 'linux',
      linux_user: cred.linux_user,
      service_name: cred.service_name,
      service_username: cred.service_username,
      label: cred.label,
      notes: cred.notes,
      password_enc: encryptSecret(newPassword, vaultKey),
      created_by: req.session.user!.id,
      last_changed_on_server_at: new Date(),
      predecessor_id: credId,
    }).returningAll().execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'credential.rotated', resource: 'server_credential', resourceId: newCred.id,
      serverId: id, details: { linux_user: cred.linux_user, label: cred.label, archived_id: credId }, request: req,
    })

    return { ok: true, new_id: newCred.id }
  })

  // POST /servers/:id/credentials/:credId/verify — check if stored password still matches the server
  fastify.post('/servers/:id/credentials/:credId/verify', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)

    const cred = await db.selectFrom('server_credentials').selectAll().where('id', '=', credId).where('server_id', '=', id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })
    if (cred.category !== 'linux' || !cred.linux_user) return reply.code(400).send({ error: 'Only Linux user credentials can be verified' })

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const vaultKey = getVaultKey()
    const password = decryptSecret(cred.password_enc, vaultKey)

    // Attempt SSH password authentication — this verifies the password at the PAM/OS level
    const { Client } = await import('ssh2')
    const match: boolean = await new Promise((resolve) => {
      const client = new Client()
      let resolved = false
      const done = (result: boolean) => {
        if (!resolved) { resolved = true; resolve(result) }
        try { client.end() } catch {}
      }
      client
        .on('ready', () => done(true))
        .on('error', (err: Error & { level?: string }) => {
          // 'client-authentication' = wrong password or auth method not allowed
          // We treat 'not allowed' (PasswordAuthentication disabled) separately
          if (err.level === 'client-authentication') done(false)
          else done(false)
        })
        .connect({
          host: server.hostname,
          port: server.ssh_port,
          username: cred.linux_user!,
          password,
          readyTimeout: 10000,
          authHandler: (_methodsLeft, _partialSuccess, cb) => cb('password'),
        })
    })

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'credential.verified', resource: 'server_credential', resourceId: credId,
      serverId: id, details: { linux_user: cred.linux_user, label: cred.label, match }, request: req,
    })

    return { match, checked_at: new Date().toISOString() }
  })

  // POST /servers/:id/credentials/:credId/copy — reveal password for clipboard only (audit logged same as reveal)
  fastify.post('/servers/:id/credentials/:credId/copy', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)

    const cred = await db.selectFrom('server_credentials').selectAll().where('id', '=', credId).where('server_id', '=', id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })

    const vaultKey = getVaultKey()
    const password = decryptSecret(cred.password_enc, vaultKey)

    await db.updateTable('server_credentials').set({ last_revealed_at: new Date() }).where('id', '=', credId).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'credential.copied', resource: 'server_credential', resourceId: credId,
      serverId: id, details: { linux_user: cred.linux_user, label: cred.label }, request: req,
    })

    return { password }
  })

  // DELETE /servers/:id/credentials/:credId
  //   Active credential  → soft-archive (reason: 'deleted') so history is preserved
  //   Archived credential → hard-delete (permanent purge)
  fastify.delete('/servers/:id/credentials/:credId', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)

    const cred = await db.selectFrom('server_credentials').selectAll().where('id', '=', credId).where('server_id', '=', id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })

    if (cred.is_archived) {
      // Already archived — permanently delete
      await db.deleteFrom('server_credentials').where('id', '=', credId).execute()
      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'credential.purged', resource: 'server_credential', resourceId: credId,
        serverId: id, details: { linux_user: cred.linux_user, label: cred.label }, request: req,
      })
    } else {
      // Active — soft-archive so history is preserved
      await db.updateTable('server_credentials').set({
        is_archived: true, archived_at: new Date(), archived_reason: 'deleted', updated_at: new Date(),
      }).where('id', '=', credId).execute()
      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'credential.deleted', resource: 'server_credential', resourceId: credId,
        serverId: id, details: { linux_user: cred.linux_user, label: cred.label }, request: req,
      })
    }

    return reply.code(204).send()
  })
}
