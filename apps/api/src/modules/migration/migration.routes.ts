import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { withServerSsh } from '../../utils/server-ssh'
import { runDiscovery, compareSnapshots, DiscoverySnapshot } from '../../utils/discovery'
import { writeAuditLog } from '../../utils/audit'
import { createJob, runTransferJob, runVerifyJob, dumpDatabase, checkRestoreReadiness, restoreDatabase, transferJobs, TransferType } from '../../utils/transfer'

async function migrationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // POST /migration/snapshots — run discovery on a server and save snapshot
  fastify.post('/migration/snapshots', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const body = z.object({
      server_id: z.string().uuid(),
      label: z.string().max(120).optional().default(''),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', body.server_id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server not configured (no management key)' })

    let snapshot: DiscoverySnapshot
    try {
      snapshot = await withServerSsh(body.server_id, async (client) => {
        return runDiscovery(client)
      })
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Discovery failed', details: (err as Error).message })
    }

    const row = await db.insertInto('migration_snapshots').values({
      server_id: body.server_id,
      server_name: server.name,
      label: body.label || `${server.name} — ${new Date().toLocaleDateString()}`,
      snapshot: JSON.stringify(snapshot),
      created_by: req.session.user!.id,
    }).returningAll().executeTakeFirst()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'migration.snapshot_created', resource: 'migration_snapshot', resourceId: row!.id,
      details: { server_id: body.server_id, server_name: server.name }, request: req,
    })

    return reply.code(201).send(row)
  })

  // GET /migration/snapshots — list all snapshots (newest first)
  fastify.get('/migration/snapshots', { preHandler: requirePermission('servers:read') }, async (req) => {
    const query = z.object({
      server_id: z.string().uuid().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(req.query)

    let qb = db.selectFrom('migration_snapshots')
      .select(['id', 'server_id', 'server_name', 'label', 'created_by', 'created_at'])
      .orderBy('created_at', 'desc')

    if (query.server_id) qb = qb.where('server_id', '=', query.server_id)

    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // GET /migration/snapshots/:id — get full snapshot detail
  fastify.get('/migration/snapshots/:id', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const row = await db.selectFrom('migration_snapshots').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Snapshot not found' })
    return row
  })

  // PATCH /migration/snapshots/:id — update label
  fastify.patch('/migration/snapshots/:id', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({ label: z.string().max(120) }).parse(req.body)
    const row = await db.updateTable('migration_snapshots')
      .set({ label: body.label })
      .where('id', '=', id)
      .returningAll().executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Snapshot not found' })
    return row
  })

  // DELETE /migration/snapshots/:id
  fastify.delete('/migration/snapshots/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await db.deleteFrom('migration_snapshots').where('id', '=', id).execute()
    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'migration.snapshot_deleted', resource: 'migration_snapshot', resourceId: id, request: req,
    })
    return reply.code(204).send()
  })

  // POST /migration/compare — diff two snapshots
  fastify.post('/migration/compare', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const body = z.object({
      source_id: z.string().uuid(),
      target_id: z.string().uuid(),
    }).parse(req.body)

    const [sourceRow, targetRow] = await Promise.all([
      db.selectFrom('migration_snapshots').selectAll().where('id', '=', body.source_id).executeTakeFirst(),
      db.selectFrom('migration_snapshots').selectAll().where('id', '=', body.target_id).executeTakeFirst(),
    ])

    if (!sourceRow) return reply.code(404).send({ error: 'Source snapshot not found' })
    if (!targetRow) return reply.code(404).send({ error: 'Target snapshot not found' })

    const source = sourceRow.snapshot as DiscoverySnapshot
    const target = targetRow.snapshot as DiscoverySnapshot
    const diff = compareSnapshots(source, target)

    return {
      source: { id: sourceRow.id, server_name: sourceRow.server_name, label: sourceRow.label, created_at: sourceRow.created_at },
      target: { id: targetRow.id, server_name: targetRow.server_name, label: targetRow.label, created_at: targetRow.created_at },
      diff,
      summary: {
        total: diff.length,
        match: diff.filter((d) => d.status === 'match').length,
        missing: diff.filter((d) => d.status === 'missing').length,
        mismatch: diff.filter((d) => d.status === 'mismatch').length,
        extra: diff.filter((d) => d.status === 'extra').length,
      },
    }
  })

  // POST /migration/dump — dump a database to a file on the source server (phase 1 only)
  fastify.post('/migration/dump', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const body = z.object({
      server_id: z.string().uuid(),
      type: z.enum(['mysql', 'postgresql', 'mongodb']),
      database: z.string().min(1),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', body.server_id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server has no management key' })

    try {
      const result = await withServerSsh(body.server_id, async (client) => {
        return dumpDatabase(client, body.type, body.database, req.id as string)
      })
      return result
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // POST /migration/restore-check — check if target server is ready to restore
  fastify.post('/migration/restore-check', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const body = z.object({
      server_id: z.string().uuid(),
      type: z.enum(['mysql', 'postgresql', 'mongodb']),
      database: z.string().min(1),
      dump_file: z.string().min(1),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', body.server_id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    try {
      const report = await withServerSsh(body.server_id, async (client) => {
        return checkRestoreReadiness(client, body.type, body.database, body.dump_file)
      })
      return report
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // POST /migration/restore — restore a database from a dump file on the target server
  fastify.post('/migration/restore', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const body = z.object({
      server_id: z.string().uuid(),
      type: z.enum(['mysql', 'postgresql', 'mongodb']),
      database: z.string().min(1),
      dump_file: z.string().min(1),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', body.server_id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const logs: string[] = []
    try {
      await withServerSsh(body.server_id, async (client) => {
        await restoreDatabase(client, body.type, body.database, body.dump_file, (msg) => {
          logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`)
        })
      })
      return { success: true, log: logs }
    } catch (err) {
      logs.push(`[${new Date().toLocaleTimeString()}] Error: ${(err as Error).message}`)
      return reply.code(500).send({ error: (err as Error).message, log: logs })
    }
  })

  // POST /migration/transfer — start a transfer job between two servers
  fastify.post('/migration/transfer', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const body = z.object({
      source_id: z.string().uuid(),
      target_id: z.string().uuid(),
      type: z.enum(['mysql', 'postgresql', 'mongodb', 'redis', 'files', 'configs', 'cron']),
      options: z.object({
        database: z.string().optional(),
        source_path: z.string().optional(),
        target_path: z.string().optional(),
        users: z.string().optional(),
      }).optional().default({}),
    }).parse(req.body)

    const [srcServer, tgtServer] = await Promise.all([
      db.selectFrom('servers').selectAll().where('id', '=', body.source_id).executeTakeFirst(),
      db.selectFrom('servers').selectAll().where('id', '=', body.target_id).executeTakeFirst(),
    ])
    if (!srcServer) return reply.code(404).send({ error: 'Source server not found' })
    if (!tgtServer) return reply.code(404).send({ error: 'Target server not found' })
    if (!srcServer.management_key_id) return reply.code(400).send({ error: 'Source server has no management key' })
    if (!tgtServer.management_key_id) return reply.code(400).send({ error: 'Target server has no management key' })

    const job = createJob(body.source_id, body.target_id, body.type as TransferType, body.options, req.session.user!.id)
    job.log.push(`[${new Date().toLocaleTimeString()}] Job created. Connecting to servers…`)

    // Run async — caller polls /migration/transfer/:jobId
    ;(async () => {
      try {
        await withServerSsh(body.source_id, async (srcClient) => {
          await withServerSsh(body.target_id, async (tgtClient) => {
            await runTransferJob(job, srcClient, tgtClient)
          })
        })
      } catch (err) {
        job.status = 'error'
        job.ended_at = new Date().toISOString()
        job.log.push(`[${new Date().toLocaleTimeString()}] Connection error: ${(err as Error).message}`)
      }
    })().catch(() => {})

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'migration.transfer.start', resource: 'migration', resourceId: job.id,
      details: { type: body.type, source: srcServer.name, target: tgtServer.name }, request: req,
    })
    return reply.code(202).send({ job_id: job.id })
  })

  // GET /migration/transfer/:jobId — poll job status
  fastify.get('/migration/transfer/:jobId', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params)
    const job = transferJobs.get(jobId)
    if (!job) return reply.code(404).send({ error: 'Job not found' })
    return job
  })

  // POST /migration/transfer/:jobId/verify — verify data integrity after transfer
  fastify.post('/migration/transfer/:jobId/verify', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(req.params)
    const job = transferJobs.get(jobId)
    if (!job) return reply.code(404).send({ error: 'Job not found' })
    if (job.status === 'running' || job.status === 'pending') return reply.code(409).send({ error: 'Job is still running' })

    const [srcServer, tgtServer] = await Promise.all([
      db.selectFrom('servers').selectAll().where('id', '=', job.source_server_id).executeTakeFirst(),
      db.selectFrom('servers').selectAll().where('id', '=', job.target_server_id).executeTakeFirst(),
    ])
    if (!srcServer || !tgtServer) return reply.code(404).send({ error: 'Server not found' })

    try {
      const report = await withServerSsh(job.source_server_id, async (srcClient) => {
        return withServerSsh(job.target_server_id, async (tgtClient) => {
          return runVerifyJob(job, srcClient, tgtClient)
        })
      })
      return report
    } catch (err) {
      return reply.code(500).send({ error: 'Verification failed', details: (err as Error).message })
    }
  })

  // GET /migration/transfer — list recent jobs (last 50)
  fastify.get('/migration/transfer', { preHandler: requirePermission('servers:read') }, async (_req, _reply) => {
    const jobs = [...transferJobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 50)
    return jobs
  })

  // GET /migration/snapshots/:id/export — download snapshot as JSON
  fastify.get('/migration/snapshots/:id/export', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const row = await db.selectFrom('migration_snapshots').selectAll().where('id', '=', id).executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Snapshot not found' })
    reply.header('Content-Type', 'application/json')
    reply.header('Content-Disposition', `attachment; filename="snapshot-${row.server_name}-${id.slice(0, 8)}.json"`)
    return reply.send(JSON.stringify({ meta: { id: row.id, server_name: row.server_name, label: row.label, created_at: row.created_at }, snapshot: row.snapshot }, null, 2))
  })
}

export default migrationRoutes
