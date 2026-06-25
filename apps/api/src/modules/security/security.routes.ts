import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { runSecurityScan } from './security.service'
import { startSecurityWorker } from '../../jobs/security.worker'

let securityQueue: ReturnType<typeof startSecurityWorker>['queue'] | null = null

async function securityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // POST /security/scan/:serverId
  fastify.post('/security/scan/:serverId', { preHandler: requireAdmin }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    await runSecurityScan(serverId)
    const scan = await db.selectFrom('security_scans').selectAll()
      .where('server_id', '=', serverId)
      .orderBy('scanned_at', 'desc').limit(1).executeTakeFirst()
    return scan
  })

  // POST /security/scan/all
  fastify.post('/security/scan/all', { preHandler: requireAdmin }, async () => {
    const servers = await db.selectFrom('servers').select(['id'])
      .where('is_active', '=', true)
      .where((eb) => eb.or([eb('os_type', '!=', 'windows'), eb('os_type', 'is', null)]))
      .execute()

    if (!securityQueue) {
      const { queue } = startSecurityWorker()
      securityQueue = queue
    }

    for (const server of servers) {
      await securityQueue.add('scan', { serverId: server.id })
    }

    return { enqueued: servers.length }
  })

  // GET /security/findings
  fastify.get('/security/findings', { preHandler: requireAdmin }, async (req) => {
    const query = z.object({
      severity: z.string().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(req.query)

    let qb = db.selectFrom('security_scans').selectAll().orderBy('scanned_at', 'desc')
    if (query.severity) qb = qb.where('severity', '=', query.severity as 'high')
    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // GET /security/findings/:serverId
  fastify.get('/security/findings/:serverId', { preHandler: requireAdmin }, async (req) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const [findings, suppressions] = await Promise.all([
      db.selectFrom('security_scans').selectAll()
        .where('server_id', '=', serverId)
        .orderBy('scanned_at', 'desc')
        .execute(),
      db.selectFrom('security_suppressions')
        .select(['check_id', 'reason', 'suppressed_at'])
        .where('server_id', '=', serverId)
        .execute(),
    ])
    const suppressedMap = Object.fromEntries(suppressions.map(s => [s.check_id, s]))
    return findings.map(f => ({
      ...f,
      suppressed: !!suppressedMap[f.check_id],
      suppression_reason: suppressedMap[f.check_id]?.reason ?? null,
    }))
  })

  // GET /security/suppressions/:serverId
  fastify.get('/security/suppressions/:serverId', { preHandler: requireAdmin }, async (req) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    return db.selectFrom('security_suppressions').selectAll()
      .where('server_id', '=', serverId)
      .execute()
  })

  // POST /security/suppressions
  fastify.post('/security/suppressions', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z.object({
      server_id: z.string().uuid(),
      check_id:  z.string().min(1),
      reason:    z.string().max(500).default(''),
    }).parse(req.body)
    const userId = req.session.user!.id
    await db.insertInto('security_suppressions').values({
      server_id:     body.server_id,
      check_id:      body.check_id,
      reason:        body.reason,
      suppressed_by: userId,
    })
    .onConflict(oc => oc.columns(['server_id', 'check_id']).doUpdateSet({
      reason:        body.reason,
      suppressed_by: userId,
      suppressed_at: new Date(),
    }))
    .execute()
    return reply.code(201).send({ ok: true })
  })

  // DELETE /security/suppressions/:serverId/:checkId
  fastify.delete('/security/suppressions/:serverId/:checkId', { preHandler: requireAdmin }, async (req, reply) => {
    const { serverId, checkId } = z.object({
      serverId: z.string().uuid(),
      checkId:  z.string().min(1),
    }).parse(req.params)
    await db.deleteFrom('security_suppressions')
      .where('server_id', '=', serverId)
      .where('check_id',  '=', checkId)
      .execute()
    return reply.code(200).send({ ok: true })
  })
}

export default securityRoutes
