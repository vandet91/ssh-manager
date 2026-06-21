import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { exec } from 'child_process'
import { promisify } from 'util'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'

const execAsync = promisify(exec)

const NETWORK_OS_TYPES = [
  'router','switch','switch-l3','access-point','wireless-controller',
  'firewall','utm','ids-ips','waf',
  'load-balancer','proxy','wan-optimizer',
  'vpn-gateway','vpn-concentrator',
  'patch-panel','media-converter','sfp-module',
  'ip-pbx','voip-gateway',
  'dvr','nvr','ip-camera',
  'ups','pdu','kvm-switch','console-server',
  'other-network',
]

async function pingHost(hostname: string): Promise<{ status: 'online' | 'offline'; latency_ms: number | null }> {
  try {
    // Try ICMP ping (works on Linux/Alpine containers)
    const { stdout } = await execAsync(`ping -c 1 -W 2 ${hostname}`, { timeout: 5000 })
    // Parse "rtt min/avg/max/mdev = 0.234/0.234/0.234/0.000 ms"
    const match = stdout.match(/min\/avg\/max.*?=\s*[\d.]+\/([\d.]+)/)
    const latency_ms = match ? Math.round(parseFloat(match[1])) : null
    return { status: 'online', latency_ms }
  } catch {
    // Ping failed — try TCP port 80 as fallback
    try {
      const start = Date.now()
      await execAsync(`nc -z -w 2 ${hostname} 80`, { timeout: 3000 })
      return { status: 'online', latency_ms: Date.now() - start }
    } catch {
      return { status: 'offline', latency_ms: null }
    }
  }
}

export default async function networkPingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // POST /network-devices/ping
  fastify.post('/network-devices/ping', { preHandler: requirePermission('servers:read') }, async (req) => {
    const body = z.object({
      device_ids:  z.array(z.string().uuid()).optional(),
      os_type:     z.string().optional(),
      environment: z.string().optional(),
    }).parse(req.body)

    // Build query
    let query = db.selectFrom('servers')
      .select(['id', 'name', 'hostname', 'os_type', 'environment', 'ping_enabled', 'in_stock'])
      .where('device_category', '=', 'network')
      .where('is_active', '=', true)

    if (body.device_ids?.length) {
      query = query.where('id', 'in', body.device_ids)
    }
    if (body.os_type) {
      query = query.where('os_type', '=', body.os_type)
    }
    if (body.environment) {
      query = query.where('environment', '=', body.environment)
    }

    const devices = await query.execute()

    // Ping in parallel (cap at 20 concurrent)
    const results: Array<{
      id: string; name: string; hostname: string
      status: 'online' | 'offline' | 'skipped'
      latency_ms: number | null
      skipped_reason: string | null
    }> = []

    const batchSize = 20
    for (let i = 0; i < devices.length; i += batchSize) {
      const batch = devices.slice(i, i + batchSize)
      const batchResults = await Promise.all(batch.map(async (d) => {
        if (d.in_stock) {
          return { id: d.id, name: d.name, hostname: d.hostname, status: 'skipped' as const, latency_ms: null, skipped_reason: 'in stock' }
        }
        if (d.ping_enabled === false) {
          return { id: d.id, name: d.name, hostname: d.hostname, status: 'skipped' as const, latency_ms: null, skipped_reason: 'ping disabled' }
        }

        const { status, latency_ms } = await pingHost(d.hostname)

        // Persist result
        await db.updateTable('servers').set({
          ping_last_at: new Date(),
          ping_last_status: status,
          ping_last_latency_ms: latency_ms,
          updated_at: new Date(),
        }).where('id', '=', d.id).execute()

        return { id: d.id, name: d.name, hostname: d.hostname, status, latency_ms, skipped_reason: null }
      }))
      results.push(...batchResults)
    }

    const online  = results.filter((r) => r.status === 'online').length
    const offline = results.filter((r) => r.status === 'offline').length
    const skipped = results.filter((r) => r.status === 'skipped').length

    return { results, summary: { total: results.length, online, offline, skipped } }
  })

  // GET /network-devices/ping-status — last saved ping results for all network devices
  fastify.get('/network-devices/ping-status', { preHandler: requirePermission('servers:read') }, async () => {
    const rows = await db.selectFrom('servers')
      .select(['id', 'name', 'hostname', 'os_type', 'environment', 'ping_enabled', 'in_stock', 'ping_last_at', 'ping_last_status', 'ping_last_latency_ms'])
      .where('device_category', '=', 'network')
      .where('is_active', '=', true)
      .orderBy('name', 'asc')
      .execute()

    return rows
  })

  // PATCH /servers/:id/ping-settings — update ping_enabled / in_stock flags
  fastify.patch('/servers/:id/ping-settings', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      ping_enabled: z.boolean().optional(),
      in_stock:     z.boolean().optional(),
    }).parse(req.body)

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.ping_enabled !== undefined) updates.ping_enabled = body.ping_enabled
    if (body.in_stock     !== undefined) updates.in_stock     = body.in_stock

    await db.updateTable('servers').set(updates as any).where('id', '=', id).execute()
    reply.code(204).send()
  })
}
