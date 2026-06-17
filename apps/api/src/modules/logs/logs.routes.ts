import { FastifyInstance } from 'fastify'
import * as fs from 'fs'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'

async function logsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /logs/audit
  fastify.get('/logs/audit', { preHandler: requirePermission('logs:read') }, async (req) => {
    const query = z.object({
      user_id: z.string().uuid().optional(),
      action: z.string().optional(),
      resource: z.string().optional(),
      server_id: z.string().uuid().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(req.query)

    let qb = db.selectFrom('audit_logs').selectAll().orderBy('created_at', 'desc')
    if (query.user_id) qb = qb.where('user_id', '=', query.user_id)
    if (query.action) qb = qb.where('action', 'like', `%${query.action}%`)
    if (query.resource) qb = qb.where('resource', '=', query.resource)
    if (query.server_id) qb = qb.where('server_id', '=', query.server_id)

    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // GET /logs/export — CSV download of audit logs
  fastify.get('/logs/export', { preHandler: requirePermission('logs:read') }, async (req, reply) => {
    const logs = await db.selectFrom('audit_logs').selectAll().orderBy('created_at', 'desc').execute()

    const header = 'id,user_email,action,resource,resource_id,server_id,ip_address,created_at\n'
    const rows = logs.map((l) =>
      [l.id, l.user_email ?? '', l.action, l.resource ?? '', l.resource_id ?? '', l.server_id ?? '', l.ip_address ?? '', l.created_at].join(',')
    ).join('\n')

    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', 'attachment; filename="audit_logs.csv"')
    return reply.send(header + rows)
  })

  // DELETE /logs/audit?older_than=30|60|90|all — admin only
  fastify.delete('/logs/audit', { preHandler: requirePermission('admin') }, async (req, reply) => {
    const { older_than } = z.object({
      older_than: z.enum(['30', '60', '90', 'all']).default('all'),
    }).parse(req.query)

    let qb = db.deleteFrom('audit_logs')
    if (older_than !== 'all') {
      const cutoff = new Date(Date.now() - Number(older_than) * 86400 * 1000)
      qb = qb.where('created_at', '<', cutoff) as typeof qb
    }
    const result = await qb.executeTakeFirst()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'logs.audit.cleared', resource: 'audit_logs',
      details: { older_than, deleted: Number(result?.numDeletedRows ?? 0) }, request: req,
    })
    return { deleted: Number(result?.numDeletedRows ?? 0) }
  })

  // GET /logs/sessions — list session recordings
  fastify.get('/logs/sessions', { preHandler: requirePermission('logs:read') }, async (req) => {
    const query = z.object({
      user_id: z.string().uuid().optional(),
      server_id: z.string().uuid().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(req.query)

    let qb = db.selectFrom('session_recordings').selectAll().orderBy('started_at', 'desc')
    if (query.user_id) qb = qb.where('user_id', '=', query.user_id)
    if (query.server_id) qb = qb.where('server_id', '=', query.server_id)

    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // GET /logs/sessions/:id/play — stream cast file for asciinema player
  fastify.get('/logs/sessions/:id/play', { preHandler: requirePermission('logs:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const recording = await db.selectFrom('session_recordings').selectAll()
      .where('id', '=', id).executeTakeFirst()

    if (!recording) return reply.code(404).send({ error: 'Recording not found' })
    if (!recording.cast_file_path || !fs.existsSync(recording.cast_file_path)) {
      return reply.code(404).send({ error: 'Cast file not found on disk' })
    }

    reply.header('Content-Type', 'application/x-asciicast')
    return reply.send(fs.createReadStream(recording.cast_file_path))
  })

  // GET /logs/sessions/:id/download — download cast file
  fastify.get('/logs/sessions/:id/download', { preHandler: requirePermission('logs:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const recording = await db.selectFrom('session_recordings').selectAll()
      .where('id', '=', id).executeTakeFirst()

    if (!recording) return reply.code(404).send({ error: 'Recording not found' })
    if (!recording.cast_file_path || !fs.existsSync(recording.cast_file_path)) {
      return reply.code(404).send({ error: 'Cast file not found on disk' })
    }

    reply.header('Content-Type', 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="session-${id}.cast"`)
    return reply.send(fs.createReadStream(recording.cast_file_path))
  })

  // DELETE /logs/sessions/:id — admin only
  fastify.delete('/logs/sessions/:id', { preHandler: requirePermission('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const recording = await db.selectFrom('session_recordings').selectAll()
      .where('id', '=', id).executeTakeFirst()

    if (!recording) return reply.code(404).send({ error: 'Recording not found' })

    if (recording.cast_file_path && fs.existsSync(recording.cast_file_path)) {
      fs.unlinkSync(recording.cast_file_path)
    }
    await db.deleteFrom('session_recordings').where('id', '=', id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'logs.session.deleted', resource: 'session_recordings', resourceId: id, request: req,
    })
    return reply.code(204).send()
  })

  // DELETE /logs/sessions?older_than=30|60|90|all — bulk delete, admin only
  fastify.delete('/logs/sessions', { preHandler: requirePermission('admin') }, async (req, reply) => {
    const { older_than } = z.object({
      older_than: z.enum(['30', '60', '90', 'all']).default('all'),
    }).parse(req.query)

    let qb = db.selectFrom('session_recordings').select(['id', 'cast_file_path'])
    if (older_than !== 'all') {
      const cutoff = new Date(Date.now() - Number(older_than) * 86400 * 1000)
      qb = qb.where('started_at', '<', cutoff) as typeof qb
    }
    const toDelete = await qb.execute()

    // Delete cast files from disk
    for (const r of toDelete) {
      if (r.cast_file_path && fs.existsSync(r.cast_file_path)) {
        try { fs.unlinkSync(r.cast_file_path) } catch { /* skip */ }
      }
    }

    const ids = toDelete.map((r) => r.id)
    if (ids.length > 0) {
      await db.deleteFrom('session_recordings').where('id', 'in', ids).execute()
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'logs.sessions.cleared', resource: 'session_recordings',
      details: { older_than, deleted: ids.length }, request: req,
    })
    return { deleted: ids.length }
  })
}

export default logsRoutes
