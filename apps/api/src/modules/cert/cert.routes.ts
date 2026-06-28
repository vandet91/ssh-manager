import { FastifyInstance } from 'fastify'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'
import {
  checkAndSaveCert, renewCert,
  validateCertFiles, applyCertFiles, scheduleCertApply, cancelCertApply,
  type CertApplyConfig,
} from './cert.service'

export default async function certRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /servers/:id/cert
  fastify.get('/servers/:id/cert', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await (db as any)
      .selectFrom('servers')
      .select([
        'id', 'hostname', 'cert_host', 'cert_port',
        'cert_expires_at', 'cert_issuer', 'cert_subject',
        'cert_sans', 'cert_is_self_signed', 'cert_last_checked_at',
        'cert_renewal_cmd', 'cert_auto_renew', 'cert_error',
        'cert_pending_apply_at', 'cert_pending_apply_config',
      ])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return reply.status(404).send({ error: 'Server not found' })
    return row
  })

  // POST /servers/:id/cert/check — manual live check
  fastify.post('/servers/:id/cert/check', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = (req as any).session.user
    try {
      const info = await checkAndSaveCert(id)
      await writeAuditLog({ userEmail: user.email, action: 'cert.check', resource: id, serverId: id, details: { host: info.host, expiresAt: info.expiresAt } })
      return info
    } catch (err) {
      return reply.status(422).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/cert/renew — certbot / custom renewal command
  fastify.post('/servers/:id/cert/renew', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = (req as any).session.user
    try {
      const output = await renewCert(id)
      await writeAuditLog({ userEmail: user.email, action: 'cert.renew', resource: id, serverId: id, details: { output: output.slice(0, 500) } })
      return { ok: true, output }
    } catch (err) {
      return reply.status(422).send({ error: (err as Error).message })
    }
  })

  // PUT /servers/:id/cert/settings — monitoring config
  fastify.put('/servers/:id/cert/settings', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { cert_host, cert_port, cert_protocol, cert_renewal_cmd, cert_auto_renew } = req.body as {
      cert_host?: string; cert_port?: number; cert_protocol?: string; cert_renewal_cmd?: string; cert_auto_renew?: boolean
    }
    await (db as any)
      .updateTable('servers')
      .set({
        ...(cert_host       !== undefined && { cert_host: cert_host || null }),
        ...(cert_port       !== undefined && { cert_port }),
        ...(cert_protocol   !== undefined && { cert_protocol: cert_protocol || 'https' }),
        ...(cert_renewal_cmd !== undefined && { cert_renewal_cmd: cert_renewal_cmd || null }),
        ...(cert_auto_renew !== undefined && { cert_auto_renew }),
      })
      .where('id', '=', id)
      .execute()
    return { ok: true }
  })

  // POST /servers/:id/cert/validate-files — validate uploaded cert files on the server
  fastify.post('/servers/:id/cert/validate-files', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { cert_path, key_path, chain_path } = req.body as {
      cert_path: string; key_path?: string; chain_path?: string
    }
    if (!cert_path) return reply.status(400).send({ error: 'cert_path is required' })
    try {
      const result = await validateCertFiles(id, cert_path, key_path, chain_path)
      return result
    } catch (err) {
      return reply.status(422).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/cert/apply-files — apply cert files now
  fastify.post('/servers/:id/cert/apply-files', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = (req as any).session.user
    const cfg = req.body as CertApplyConfig
    if (!cfg.cert_path || !cfg.target_cert) return reply.status(400).send({ error: 'cert_path and target_cert are required' })
    try {
      const { output } = await applyCertFiles(id, cfg)
      await checkAndSaveCert(id).catch(() => {})
      await writeAuditLog({
        userEmail: user.email, action: 'cert.apply', resource: id, serverId: id,
        details: { target_cert: cfg.target_cert, service: cfg.service_name, action: cfg.service_action },
      })
      return { ok: true, output }
    } catch (err) {
      return reply.status(422).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/cert/schedule-apply — schedule cert apply for later
  fastify.post('/servers/:id/cert/schedule-apply', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = (req as any).session.user
    const { run_at, ...cfg } = req.body as { run_at: string } & CertApplyConfig
    if (!run_at) return reply.status(400).send({ error: 'run_at is required' })
    const runAt = new Date(run_at)
    if (isNaN(runAt.getTime()) || runAt <= new Date()) return reply.status(400).send({ error: 'run_at must be a future datetime' })
    await scheduleCertApply(id, runAt, cfg as CertApplyConfig)
    await writeAuditLog({
      userEmail: user.email, action: 'cert.schedule', resource: id, serverId: id,
      details: { run_at, target_cert: (cfg as CertApplyConfig).target_cert },
    })
    return { ok: true, run_at: runAt.toISOString() }
  })

  // DELETE /servers/:id/cert/schedule-apply — cancel pending scheduled apply
  fastify.delete('/servers/:id/cert/schedule-apply', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await cancelCertApply(id)
    return { ok: true }
  })

  // GET /cert/expiring — all servers with cert monitoring, sorted by expiry
  fastify.get('/cert/expiring', { preHandler: [requireAuth] }, async () => {
    const rows = await (db as any)
      .selectFrom('servers')
      .select([
        'id', 'name', 'hostname', 'cert_host', 'cert_port',
        'cert_expires_at', 'cert_subject', 'cert_issuer',
        'cert_is_self_signed', 'cert_last_checked_at', 'cert_error',
        'cert_pending_apply_at', 'environment', 'os_type',
      ])
      .where('cert_host', 'is not', null)
      .orderBy('cert_expires_at', 'asc')
      .execute()

    return rows.map((r: any) => ({
      ...r,
      days_remaining: r.cert_expires_at
        ? Math.floor((new Date(r.cert_expires_at).getTime() - Date.now()) / 86400000)
        : null,
    }))
  })
}
