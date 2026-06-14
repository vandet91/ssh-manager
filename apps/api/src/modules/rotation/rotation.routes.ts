import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'
import { rotateKey } from './rotation.service'

async function rotationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // POST /keys/:id/rotate
  fastify.post('/keys/:id/rotate', { preHandler: requirePermission('keys:rotate') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const key = await db.selectFrom('ssh_keys').selectAll().where('id', '=', id).where('is_active', '=', true).executeTakeFirst()
    if (!key) return reply.code(404).send({ error: 'Key not found' })

    const job = await rotateKey(id, req.session.user!.id)
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'key.rotation.triggered', resource: 'ssh_key', resourceId: id, request: req })
    return job
  })

  // GET /rotation/jobs
  fastify.get('/rotation/jobs', { preHandler: requirePermission('keys:rotate') }, async (req) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(req.query)
    return db.selectFrom('rotation_jobs').selectAll()
      .orderBy('created_at', 'desc')
      .limit(query.limit).offset((query.page - 1) * query.limit)
      .execute()
  })

  // GET /rotation/jobs/:id
  fastify.get('/rotation/jobs/:id', { preHandler: requirePermission('keys:rotate') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const job = await db.selectFrom('rotation_jobs').selectAll().where('id', '=', id).executeTakeFirst()
    if (!job) return reply.code(404).send({ error: 'Job not found' })
    return job
  })
}

export default rotationRoutes
