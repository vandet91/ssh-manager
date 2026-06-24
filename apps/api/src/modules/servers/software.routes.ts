import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { withServerSsh } from '../../utils/server-ssh'
import { writeAuditLog } from '../../utils/audit'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SoftwareCategory = 'language' | 'webserver' | 'database' | 'container' | 'process_manager' | 'monitoring' | 'security'
export type ServiceStatus = 'active' | 'inactive' | 'failed' | 'unknown' | null

export interface SoftwareItem {
  name: string
  category: SoftwareCategory
  installed: boolean
  version: string | null
  service_name: string | null     // primary systemd service name
  status: ServiceStatus           // null = not a managed service
  enabled: string | null          // 'enabled' | 'disabled' | 'static' | null
}

// ── Metadata mapping ───────────────────────────────────────────────────────────
// Maps the label used in the detection script → category + possible service names

interface Meta { category: SoftwareCategory; services: string[] }

const SOFTWARE_META: Record<string, Meta> = {
  // Languages
  'PHP':              { category: 'language',         services: ['php-fpm','php8.3-fpm','php8.2-fpm','php8.1-fpm','php8.0-fpm','php7.4-fpm'] },
  'Node':             { category: 'language',         services: [] },
  'Python3':          { category: 'language',         services: [] },
  'Python':           { category: 'language',         services: [] },
  'Ruby':             { category: 'language',         services: [] },
  'Go':               { category: 'language',         services: [] },
  'Java':             { category: 'language',         services: [] },
  'Perl':             { category: 'language',         services: [] },
  'pip3':             { category: 'language',         services: [] },
  'Composer':         { category: 'language',         services: [] },
  // Web servers
  'Nginx':            { category: 'webserver',        services: ['nginx'] },
  'Apache':           { category: 'webserver',        services: ['apache2','httpd'] },
  'Caddy':            { category: 'webserver',        services: ['caddy'] },
  'Lighttpd':         { category: 'webserver',        services: ['lighttpd'] },
  // Databases
  'MySQL':            { category: 'database',         services: ['mysql','mariadb','mysqld'] },
  'PostgreSQL':       { category: 'database',         services: ['postgresql','postgres'] },
  'MongoDB':          { category: 'database',         services: ['mongod','mongodb'] },
  'Redis':            { category: 'database',         services: ['redis','redis-server'] },
  'SQLite':           { category: 'database',         services: [] },
  'InfluxDB':         { category: 'database',         services: ['influxdb'] },
  // Containers
  'Docker':           { category: 'container',        services: ['docker'] },
  'Podman':           { category: 'container',        services: ['podman'] },
  // Process managers
  'PM2':              { category: 'process_manager',  services: ['pm2-root','pm2'] },
  'Supervisord':      { category: 'process_manager',  services: ['supervisor','supervisord'] },
  'Gunicorn':         { category: 'process_manager',  services: ['gunicorn'] },
  'uWSGI':            { category: 'process_manager',  services: ['uwsgi'] },
  // Monitoring
  'Prom Exporter':    { category: 'monitoring',       services: ['prometheus-node-exporter','node_exporter','node-exporter'] },
  'Telegraf':         { category: 'monitoring',       services: ['telegraf'] },
  'Netdata':          { category: 'monitoring',       services: ['netdata'] },
  'Datadog Agent':    { category: 'monitoring',       services: ['datadog-agent','dd-agent'] },
  'Zabbix Agent':     { category: 'monitoring',       services: ['zabbix-agent','zabbix_agentd'] },
  // Security
  'Fail2ban':         { category: 'security',         services: ['fail2ban'] },
  'UFW':              { category: 'security',         services: ['ufw'] },
  'Certbot':          { category: 'security',         services: [] },
}

// ── Detection shell script ─────────────────────────────────────────────────────
// Piped via base64 to avoid quoting headaches

const DETECT_SCRIPT = `#!/bin/sh
p() {
  if command -v "$1" >/dev/null 2>&1; then
    v=$("$1" $3 2>&1 | head -1 | tr '\t' ' ') || v="?"
    printf 'PKG\\t%s\\t%s\\n' "$2" "$v"
  fi
}
sv() {
  if systemctl cat "$1.service" >/dev/null 2>&1; then
    a=$(systemctl is-active "$1" 2>/dev/null) || a=unknown
    e=$(systemctl is-enabled "$1" 2>/dev/null) || e=unknown
    printf 'SVC\\t%s\\t%s\\t%s\\n' "$1" "$a" "$e"
  fi
}
p php         PHP         '--version'
p node        Node        '--version'
p python3     Python3     '--version'
p python      Python      '--version'
p ruby        Ruby        '--version'
p go          Go          'version'
p java        Java        '-version'
p perl        Perl        '--version'
p pip3        pip3        '--version'
p composer    Composer    '--version'
p nginx       Nginx       '-v'
p apache2     Apache      '-v'
p httpd       Apache      '-v'
p caddy       Caddy       'version'
p lighttpd    Lighttpd    '-v'
p mysql       MySQL       '--version'
p psql        PostgreSQL  '--version'
p mongod      MongoDB     '--version'
p redis-server Redis      '--version'
p sqlite3     SQLite      '--version'
p influxd     InfluxDB    'version'
p docker      Docker      '--version'
p podman      Podman      '--version'
p pm2         PM2         '--version'
p supervisord Supervisord '--version'
p gunicorn    Gunicorn    '--version'
p uwsgi       uWSGI       '--version'
p node_exporter 'Prom Exporter' '--version'
p telegraf    Telegraf    '--version'
p netdata     Netdata     '--version'
p datadog-agent 'Datadog Agent' 'version'
p zabbix_agentd 'Zabbix Agent' '--version'
p fail2ban-client Fail2ban '--version'
p ufw         UFW         '--version'
p certbot     Certbot     '--version'
for svc in nginx apache2 httpd mysql mariadb postgresql mongod redis redis-server docker pm2 supervisor supervisord fail2ban ufw netdata telegraf prometheus-node-exporter; do
  sv "$svc"
done
`

function parseDetectOutput(raw: string): SoftwareItem[] {
  const pkgMap = new Map<string, { version: string }>()
  const svcMap = new Map<string, { status: ServiceStatus; enabled: string }>()

  for (const line of raw.split('\n')) {
    const parts = line.split('\t')
    if (parts[0] === 'PKG' && parts[1] && parts[2] !== undefined) {
      pkgMap.set(parts[1], { version: parts[2].trim() })
    }
    if (parts[0] === 'SVC' && parts[1] && parts[2]) {
      svcMap.set(parts[1], {
        status: (parts[2].trim() as ServiceStatus) ?? 'unknown',
        enabled: parts[3]?.trim() ?? 'unknown',
      })
    }
  }

  // Deduplicate — if both 'apache2' and 'httpd' produce PKG Apache, keep one
  const seen = new Set<string>()
  const items: SoftwareItem[] = []

  for (const [label, meta] of Object.entries(SOFTWARE_META)) {
    // Only include if binary was found OR a matching service exists
    const installed = pkgMap.has(label)
    const matchedSvc = meta.services.find((s) => svcMap.has(s))
    if (!installed && !matchedSvc) continue

    // Deduplicate by category+name (e.g. Apache from apache2 and httpd)
    const key = `${meta.category}:${label}`
    if (seen.has(key)) continue
    seen.add(key)

    const svcInfo = matchedSvc ? svcMap.get(matchedSvc)! : null

    items.push({
      name: label,
      category: meta.category,
      installed,
      version: pkgMap.get(label)?.version ?? null,
      service_name: matchedSvc ?? null,
      status: svcInfo?.status ?? null,
      enabled: svcInfo?.enabled ?? null,
    })
  }

  return items
}

// ── Routes ─────────────────────────────────────────────────────────────────────

export default async function softwareRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /servers/:id/software — detect installed software via SSH
  fastify.get('/servers/:id/software', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const server = await db.selectFrom('servers').select(['id', 'management_key_id']).where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server not configured (no management key)' })

    try {
      const result = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        // base64-encode the script to avoid shell quoting issues
        const encoded = Buffer.from(DETECT_SCRIPT).toString('base64')
        const out = await sshExec(client, `echo '${encoded}' | base64 -d | sh 2>/dev/null`)

        return parseDetectOutput(out.stdout)
      })

      return { items: result, scanned_at: new Date().toISOString() }
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Software scan failed', details: (err as Error).message })
    }
  })

  // POST /servers/:id/services/:service/control — start / stop / restart / reload a service
  fastify.post('/servers/:id/services/:service/control', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, service } = z.object({
      id: z.string().uuid(),
      service: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_@.:-]+$/, 'Invalid service name'),
    }).parse(req.params)

    const { action } = z.object({
      action: z.enum(['start', 'stop', 'restart', 'reload']),
    }).parse(req.body)

    const server = await db.selectFrom('servers').select(['id', 'management_key_id', 'name']).where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server not configured' })

    try {
      const result = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        const out = await sshExec(client, `sudo systemctl ${action} ${service} 2>&1; echo "EXIT:$?"`)
        const exitMatch = out.stdout.match(/EXIT:(\d+)/)
        const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0
        const output = out.stdout.replace(/EXIT:\d+\n?$/, '').trim()

        if (exitCode !== 0) {
          throw Object.assign(new Error(`systemctl ${action} ${service} failed: ${output || out.stderr}`), { statusCode: 400 })
        }

        // Get new status after action
        const statusOut = await sshExec(client, `systemctl is-active ${service} 2>/dev/null`)
        return {
          ok: true,
          action,
          service,
          new_status: statusOut.stdout.trim() as ServiceStatus,
          output,
        }
      })

      await writeAuditLog({
        userId: req.session.user!.id,
        userEmail: req.session.user!.email,
        action: `service.${action}`,
        resource: 'server',
        resourceId: id,
        details: { service, server_name: server.name },
        request: req,
      })

      return result
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })
}
