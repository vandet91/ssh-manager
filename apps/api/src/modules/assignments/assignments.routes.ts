import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'
import { pushKeyToServer, removeKeyFromServer as removeKeyFromServerOsAware, listServerUsers } from '../../utils/key-ops'

const AssignmentBody = z.object({
  user_id: z.string().uuid(),
  key_id: z.string().uuid(),
  server_id: z.string().uuid(),
  linux_user: z.string().min(1).max(100),
  can_terminal: z.boolean().default(true),
  expires_at: z.string().datetime().optional(),
})

async function removeKeyFromServer(serverId: string, linuxUser: string, publicKey: string): Promise<void> {
  const server = await db.selectFrom('servers').select(['id', 'os_type']).where('id', '=', serverId).executeTakeFirst()
  const keyBody = publicKey.trim().split(' ')[1] ?? publicKey.trim()
  await removeKeyFromServerOsAware(server ?? { id: serverId, os_type: null }, linuxUser, keyBody)
}

async function assignmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /assignments/server-users/:serverId — list users on a server (Linux or Windows)
  fastify.get('/assignments/server-users/:serverId', { preHandler: requirePermission('assignments:read') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    try {
      const users = await listServerUsers(serverId)
      return users
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Could not fetch server users', details: (err as Error).message })
    }
  })

  // GET /assignments
  fastify.get('/assignments', { preHandler: requirePermission('assignments:read') }, async (req) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(req.query)
    const user = req.session.user!

    let qb = db.selectFrom('key_assignments').selectAll()
    // Developers see only their own assignments
    if (user.role === 'developer') qb = qb.where('user_id', '=', user.id)

    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // POST /assignments
  fastify.post('/assignments', { preHandler: requirePermission('assignments:write') }, async (req, reply) => {
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

    const assignment = await db.insertInto('key_assignments').values({
      user_id: body.user_id,
      key_id: body.key_id,
      server_id: body.server_id,
      linux_user: body.linux_user,
      can_terminal: body.can_terminal,
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
      granted_by: req.session.user!.id,
    }).returningAll().executeTakeFirst()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'assignment.created', resource: 'key_assignment', resourceId: assignment!.id,
      serverId: body.server_id, details: { linux_user: body.linux_user }, request: req,
    })
    return reply.code(201).send(assignment)
  })

  // GET /assignments/:id
  fastify.get('/assignments/:id', { preHandler: requirePermission('assignments:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const assignment = await db.selectFrom('key_assignments').selectAll().where('id', '=', id).executeTakeFirst()
    if (!assignment) return reply.code(404).send({ error: 'Assignment not found' })

    const user = req.session.user!
    if (user.role === 'developer' && assignment.user_id !== user.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    return assignment
  })

  // DELETE /assignments/:id (revoke)
  fastify.delete('/assignments/:id', { preHandler: requirePermission('assignments:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const assignment = await db.selectFrom('key_assignments').selectAll().where('id', '=', id).executeTakeFirst()
    if (!assignment) return reply.code(404).send({ error: 'Assignment not found' })

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
