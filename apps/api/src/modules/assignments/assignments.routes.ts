import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'
import { pushKeyToServer, removeKeyFromServer as removeKeyFromServerOsAware, listServerUsers } from '../../utils/key-ops'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'

const AssignmentBody = z.object({
  user_id: z.string().uuid(),
  key_id: z.string().uuid(),
  server_id: z.string().uuid(),
  linux_user: z.string().min(1).max(100),
  can_terminal: z.boolean().default(true),
  expires_at: z.string().datetime().optional(),
  domain_user: z.string().max(200).optional(),
  domain_password: z.string().max(500).optional(),
})

async function removeKeyFromServer(serverId: string, linuxUser: string, publicKey: string): Promise<void> {
  const server = await db.selectFrom('servers').select(['id', 'os_type']).where('id', '=', serverId).executeTakeFirst()
  const keyBody = publicKey.trim().split(' ')[1] ?? publicKey.trim()
  await removeKeyFromServerOsAware(server ?? { id: serverId, os_type: null }, linuxUser, keyBody)
}

async function assignmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /assignments/server-users/:serverId — list users on a server (Linux or Windows)
  fastify.get('/assignments/server-users/:serverId', { preHandler: requireAdmin }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    try {
      const users = await listServerUsers(serverId)
      return users
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Could not fetch server users', details: (err as Error).message })
    }
  })

  // GET /assignments — admin sees all; operator sees only their own
  fastify.get('/assignments', { preHandler: requireAuth }, async (req) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(req.query)
    const user = req.session.user!

    const db2 = db as any
    let qb = db2.selectFrom('key_assignments')
      .leftJoin('servers', 'servers.id', 'key_assignments.server_id')
      .leftJoin('ssh_keys', 'ssh_keys.id', 'key_assignments.key_id')
      .select([
        'key_assignments.id',
        'key_assignments.user_id',
        'key_assignments.key_id',
        'key_assignments.server_id',
        'key_assignments.linux_user',
        'key_assignments.can_terminal',
        'key_assignments.expires_at',
        'key_assignments.is_active',
        'key_assignments.created_at',
        'key_assignments.granted_by',
        'servers.name as server_name',
        'servers.is_active as server_is_active',
        'servers.os_type as server_os_type',
        'servers.hostname as server_hostname',
        'ssh_keys.name as key_name',
        'ssh_keys.is_active as key_is_active',
        'key_assignments.domain_user',
      ])

    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // POST /assignments
  fastify.post('/assignments', { preHandler: requireAdmin }, async (req, reply) => {
    const body = AssignmentBody.parse(req.body)

    // Get the public key
    const key = await db.selectFrom('ssh_keys').selectAll().where('id', '=', body.key_id).where('is_active', '=', true).executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'SSH key not found or inactive' })

    // Push to server
    try {
      await pushKeyToServer(body.server_id, body.linux_user, key.public_key)
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to push key to server', details: (err as Error).message })
    }

    const vaultKey = getVaultKey()
    const domainPasswordEnc = body.domain_password ? encryptSecret(body.domain_password, vaultKey) : null

    const assignment = await db.insertInto('key_assignments').values({
      user_id: body.user_id,
      key_id: body.key_id,
      server_id: body.server_id,
      linux_user: body.linux_user,
      can_terminal: body.can_terminal,
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
      granted_by: req.session.user!.id,
      domain_user: body.domain_user ?? null,
      domain_password_enc: domainPasswordEnc,
    }).returningAll().executeTakeFirst()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'assignment.created', resource: 'key_assignment', resourceId: assignment!.id,
      serverId: body.server_id, details: { linux_user: body.linux_user }, request: req,
    })
    return reply.code(201).send(assignment)
  })

  // GET /assignments/:id
  fastify.get('/assignments/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const assignment = await db.selectFrom('key_assignments').selectAll().where('id', '=', id).executeTakeFirst()
    if (!assignment) return reply.code(404).send({ error: 'Assignment not found' })

    const user = req.session.user!
    return assignment
  })

  // PATCH /assignments/:id — update linux_user, can_terminal, expires_at
  fastify.patch('/assignments/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      linux_user:      z.string().min(1).max(64).optional(),
      can_terminal:    z.boolean().optional(),
      expires_at:      z.string().nullable().optional(),
      domain_user:     z.string().max(200).nullable().optional(),
      domain_password: z.string().max(500).nullable().optional(),
    }).parse(req.body)

    const assignment = await db.selectFrom('key_assignments').selectAll().where('id', '=', id).executeTakeFirst()
    if (!assignment) return reply.code(404).send({ error: 'Assignment not found' })
    if (!assignment.is_active) return reply.code(400).send({ error: 'Cannot edit a revoked assignment' })

    const vaultKey = getVaultKey()
    const updates: Record<string, unknown> = {}
    if (body.linux_user !== undefined) updates.linux_user = body.linux_user
    if (body.can_terminal !== undefined) updates.can_terminal = body.can_terminal
    if (body.expires_at !== undefined) updates.expires_at = body.expires_at ? new Date(body.expires_at) : null
    if (body.domain_user !== undefined) updates.domain_user = body.domain_user ?? null
    if (body.domain_password !== undefined) {
      updates.domain_password_enc = body.domain_password ? encryptSecret(body.domain_password, vaultKey) : null
    }

    if (Object.keys(updates).length > 0) {
      await db.updateTable('key_assignments').set(updates).where('id', '=', id).execute()
      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'assignment.updated', resource: 'key_assignment', resourceId: id,
        serverId: assignment.server_id, details: { ...updates }, request: req,
      })
    }

    return { ok: true }
  })

  // DELETE /assignments/:id (revoke)
  fastify.delete('/assignments/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const assignment = await db.selectFrom('key_assignments').selectAll().where('id', '=', id).executeTakeFirst()
    if (!assignment) return reply.code(404).send({ error: 'Assignment not found' })

    // Block revoking the active management key — it would break SSH connectivity
    const server = await db.selectFrom('servers').select(['management_key_id']).where('id', '=', assignment.server_id).executeTakeFirst()
    if (server?.management_key_id && server.management_key_id === assignment.key_id) {
      return reply.code(409).send({ error: 'Cannot revoke the management key — it is the active SSH key for this server. Set a different management key first.' })
    }

    const key = await db.selectFrom('ssh_keys').select(['public_key']).where('id', '=', assignment.key_id).executeTakeFirst()

    if (key) {
      try {
        await removeKeyFromServer(assignment.server_id, assignment.linux_user, key.public_key)
      } catch (err: unknown) {
        // Log but continue revoking from DB
        fastify.log.error({ err }, 'Failed to remove key from server during revoke')
      }
    }

    await db.updateTable('key_assignments').set({ is_active: false }).where('id', '=', id).execute()
    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'assignment.revoked', resource: 'key_assignment', resourceId: id,
      serverId: assignment.server_id, details: { linux_user: assignment.linux_user }, request: req,
    })
    reply.code(204).send()
  })
}

export default assignmentsRoutes
