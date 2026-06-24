import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAdmin } from '../../middleware/auth'
import { XMLParser } from 'fast-xml-parser'

export default async function pingcastleRoutes(fastify: FastifyInstance) {

  // GET /servers/:id/pingcastle — latest report
  fastify.get('/servers/:id/pingcastle', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const report = await db
      .selectFrom('pingcastle_reports')
      .selectAll()
      .where('server_id', '=', id)
      .orderBy('uploaded_at', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!report) return reply.code(404).send({ error: 'No report uploaded yet' })
    return report
  })

  // POST /servers/:id/pingcastle — upload XML report
  fastify.post('/servers/:id/pingcastle', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').select(['id']).where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const data = await (req as any).file()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })

    const buf = await data.toBuffer()
    const xml = buf.toString('utf8')

    let parsed: any
    try {
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => ['HealthcheckRiskRule', 'DomainController', 'Member'].includes(name) })
      parsed = parser.parse(xml)
    } catch {
      return reply.code(400).send({ error: 'Invalid XML file' })
    }

    // PingCastle report root element
    const hc: any = parsed?.HealthcheckData ?? parsed?.['ns2:HealthcheckData'] ?? parsed?.Report
    if (!hc) return reply.code(400).send({ error: 'Not a valid PingCastle XML report (missing HealthcheckData element)' })

    const domainFqdn: string = hc.DomainFQDN ?? hc.Domain ?? null
    const generationDate: Date | null = hc.GenerationDate ? new Date(hc.GenerationDate) : null
    const globalScore: number = parseInt(hc.GlobalScore ?? hc.Score ?? '0', 10)
    const staleScore: number = parseInt(hc.StaleObjectsScore ?? '0', 10)
    const privilegedScore: number = parseInt(hc.PrivilegiedGroupScore ?? hc.PrivilegedGroupScore ?? '0', 10)
    const trustScore: number = parseInt(hc.TrustScore ?? '0', 10)
    const anomalyScore: number = parseInt(hc.AnomalyScore ?? '0', 10)

    // Risk rules
    const rawRules: any[] = hc.RiskRules?.HealthcheckRiskRule ?? []
    const riskRules = rawRules.map((r: any) => ({
      points: parseInt(r.Points ?? '0', 10),
      category: r.Category ?? '',
      model: r.Model ?? '',
      risk_id: r.RiskId ?? '',
      rationale: r.Rationale ?? '',
      details: r.Details ?? '',
    }))

    // Domain controllers (basic info)
    const rawDCs: any[] = hc.DomainControllers?.DomainController ?? []
    const domainControllers = rawDCs.map((dc: any) => ({
      name: dc.DCName ?? dc.Name ?? '',
      ip: dc.IP ?? '',
      os: dc.OperatingSystem ?? '',
      is_pdc: dc.FSMO?.includes?.('PDC') ?? false,
    }))

    await db.insertInto('pingcastle_reports').values({
      server_id: id,
      domain_fqdn: domainFqdn,
      generation_date: generationDate ?? undefined,
      global_score: isNaN(globalScore) ? 0 : globalScore,
      stale_score: isNaN(staleScore) ? 0 : staleScore,
      privileged_score: isNaN(privilegedScore) ? 0 : privilegedScore,
      trust_score: isNaN(trustScore) ? 0 : trustScore,
      anomaly_score: isNaN(anomalyScore) ? 0 : anomalyScore,
      risk_rules: JSON.stringify(riskRules),
      domain_controllers: JSON.stringify(domainControllers),
      uploaded_by: (req as any).user?.email ?? null,
    }).execute()

    return {
      ok: true,
      domain_fqdn: domainFqdn,
      global_score: globalScore,
      rules_count: riskRules.length,
    }
  })

  // DELETE /servers/:id/pingcastle — remove all reports for this server
  fastify.delete('/servers/:id/pingcastle', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await db.deleteFrom('pingcastle_reports').where('server_id', '=', id).execute()
    return { ok: true }
  })
}
