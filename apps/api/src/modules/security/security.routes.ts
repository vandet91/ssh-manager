import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { runSecurityScan } from './security.service'
import { startSecurityWorker } from '../../jobs/security.worker'

let securityQueue: ReturnType<typeof startSecurityWorker>['queue'] | null = null

async function securityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // POST /security/scan/:serverId
  fastify.post('/security/scan/:serverId', { preHandler: requirePermission('security:scan') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    await runSecurityScan(serverId)
    const scan = await db.selectFrom('security_scans').selectAll()
      .where('server_id', '=', serverId)
      .orderBy('scanned_at', 'desc').limit(1).executeTakeFirst()
    return scan
  })

  // POST /security/scan/all
  fastify.post('/security/scan/all', { preHandler: requirePermission('security:scan') }, async () => {
    const servers = await db.selectFrom('servers').select(['id']).where('is_active', '=', true).execute()

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
  fastify.get('/security/findings', { preHandler: requirePermission('security:read') }, async (req) => {
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
  fastify.get('/security/findings/:serverId', { preHandler: requirePermission('security:read') }, async (req) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    return db.selectFrom('security_scans').selectAll()
      .where('server_id', '=', serverId)
      .orderBy('scanned_at', 'desc')
      .execute()
  })
}

export default securityRoutes
