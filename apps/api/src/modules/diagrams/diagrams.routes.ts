import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'

const DiagramBody = z.object({
  name: z.string().min(1).max(256),
  data: z.object({
    nodes: z.array(z.any()).default([]),
    edges: z.array(z.any()).default([]),
  }).default({ nodes: [], edges: [] }),
})

export default async function diagramRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth)

  // GET /diagrams — list all diagrams
  fastify.get('/diagrams', { preHandler: requireAuth }, async (req) => {
    const rows = await db
      .selectFrom('network_diagrams')
      .leftJoin('users', 'users.id', 'network_diagrams.created_by')
      .select([
        'network_diagrams.id',
        'network_diagrams.name',
        'network_diagrams.created_by',
        'network_diagrams.created_at',
        'network_diagrams.updated_at',
        'users.display_name as creator_name',
        'users.email as creator_email',
      ])
      .orderBy('network_diagrams.updated_at', 'desc')
      .execute()
    return { diagrams: rows }
  })

  // POST /diagrams — create new diagram
  fastify.post('/diagrams', { preHandler: requireAuth }, async (req, reply) => {
    const body = DiagramBody.parse(req.body)
    const userId = req.session.user!.id
    const row = await db
      .insertInto('network_diagrams')
      .values({ name: body.name, data: JSON.stringify(body.data), created_by: userId })
      .returningAll()
      .executeTakeFirstOrThrow()
    return reply.code(201).send(row)
  })

  // GET /diagrams/:id — load single diagram
  fastify.get('/diagrams/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const row = await db
      .selectFrom('network_diagrams')
      .leftJoin('users', 'users.id', 'network_diagrams.created_by')
      .select([
        'network_diagrams.id',
        'network_diagrams.name',
        'network_diagrams.data',
        'network_diagrams.created_by',
        'network_diagrams.created_at',
        'network_diagrams.updated_at',
        'users.display_name as creator_name',
        'users.email as creator_email',
      ])
      .where('network_diagrams.id', '=', id)
      .executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Diagram not found' })
    return row
  })

  // PATCH /diagrams/:id — save/update
  fastify.patch('/diagrams/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = DiagramBody.partial().parse(req.body)
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name
    if (body.data !== undefined) updates.data = JSON.stringify(body.data)
    const row = await db
      .updateTable('network_diagrams')
      .set(updates)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Diagram not found' })
    return row
  })

  // DELETE /diagrams/:id
  fastify.delete('/diagrams/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const row = await db
      .deleteFrom('network_diagrams')
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Diagram not found' })
    return { ok: true }
  })
}
