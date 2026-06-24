import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'
import { requireTotpElevation } from '../../utils/totp-guard'
import { Client } from 'ssh2'

const RadiusBody = z.object({
  name:        z.string().min(1).max(255),
  description: z.string().max(1000).optional().nullable(),
  host:        z.string().min(1),
  auth_port:   z.number().int().min(1).max(65535).default(1812),
  acct_port:   z.number().int().min(1).max(65535).default(1813),
  secret:      z.string().min(1),   // plaintext on write
  timeout:     z.number().int().min(1).max(60).default(5),
  retries:     z.number().int().min(0).max(10).default(2),
})

// Build model-aware RADIUS + AAA + 802.1X global config CLI
function buildRadiusCliScript(
  vendor: string, osType: string, sysDescr: string, model: string,
  servers: Array<{ host: string; auth_port: number; acct_port: number; secret: string; timeout: number; retries: number }>,
): string {
  const d = sysDescr.toLowerCase()
  const m = model.toLowerCase()
  const isNxos    = d.includes('nx-os') || /^n[2359]k/.test(m)
  const isCiscoSmb = d.includes('small business') || /^sg[23456]|^cbs[23]/.test(m)
  const isJuniper  = vendor.toLowerCase().includes('juniper') || d.includes('junos')
  const isHp       = vendor.toLowerCase().includes('hp') || vendor.toLowerCase().includes('aruba') || d.includes('procurve') || d.includes('aruba')
  const isMikrotik = vendor.toLowerCase().includes('mikrotik') || d.includes('routeros')
  const isFortigate = vendor.toLowerCase().includes('fortinet') || d.includes('fortigate')

  if (isJuniper) {
    const lines: string[] = []
    for (const s of servers) {
      lines.push(`set access radius-server ${s.host} port ${s.auth_port} secret "${s.secret}" timeout ${s.timeout} retry ${s.retries}`)
    }
    lines.push('set access profile DOT1X_PROFILE authentication-order radius')
    lines.push('set access profile DOT1X_PROFILE radius authentication-server ' + servers.map(s => s.host).join(' '))
    lines.push('commit')
    return lines.join('\n')
  }

  if (isHp) {
    const lines: string[] = []
    for (const s of servers) {
      lines.push(`radius-server host ${s.host} key "${s.secret}"`)
    }
    lines.push('aaa authentication port-access eap-radius')
    lines.push('write memory')
    return lines.join('\n')
  }

  if (isMikrotik) {
    const lines: string[] = []
    for (const s of servers) {
      lines.push(`/radius add address=${s.host} authentication-port=${s.auth_port} accounting-port=${s.acct_port} secret="${s.secret}" timeout=${s.timeout}s service=dot1x`)
    }
    lines.push('/interface dot1x server set enabled=yes')
    return lines.join('\n')
  }

  if (isFortigate) {
    const lines: string[] = ['config user radius']
    for (const s of servers) {
      lines.push(`  edit "${s.host}"`)
      lines.push(`    set server "${s.host}"`)
      lines.push(`    set secret "${s.secret}"`)
      lines.push(`    set auth-type auto`)
      lines.push('  next')
    }
    lines.push('end')
    return lines.join('\n')
  }

  if (isNxos) {
    const lines: string[] = ['configure terminal']
    for (const s of servers) {
      lines.push(`radius-server host ${s.host} key ${s.secret} auth-port ${s.auth_port} acct-port ${s.acct_port} timeout ${s.timeout} retransmit ${s.retries}`)
    }
    lines.push('aaa group server radius RADIUS_DOT1X')
    for (const s of servers) lines.push(`  server ${s.host}`)
    lines.push('feature dot1x')
    lines.push('dot1x system-auth-control')
    lines.push('copy running-config startup-config')
    return lines.join('\n')
  }

  if (isCiscoSmb) {
    const lines: string[] = []
    for (const s of servers) {
      lines.push(`radius-server host ${s.host} auth-port ${s.auth_port} acct-port ${s.acct_port} key ${s.secret} timeout ${s.timeout} retransmit ${s.retries}`)
    }
    lines.push('aaa authentication dot1x default radius')
    lines.push('dot1x system-auth-control')
    lines.push('end')
    return lines.join('\n')
  }

  // Cisco IOS / IOS-XE default
  const lines: string[] = ['conf t']
  lines.push('aaa new-model')
  for (const s of servers) {
    lines.push(`radius-server host ${s.host} auth-port ${s.auth_port} acct-port ${s.acct_port} key ${s.secret} timeout ${s.timeout} retransmit ${s.retries}`)
  }
  lines.push('aaa authentication dot1x default group radius')
  lines.push('aaa authorization network default group radius')
  lines.push('dot1x system-auth-control')
  lines.push('end')
  lines.push('wr')
  return lines.join('\n')
}

// Build per-port 802.1X control CLI
function buildDot1xPortScript(
  vendor: string, osType: string, sysDescr: string, model: string,
  ifNames: string[], enabled: boolean,
): string {
  const d = sysDescr.toLowerCase()
  const m = model.toLowerCase()
  const isNxos     = d.includes('nx-os') || /^n[2359]k/.test(m)
  const isCiscoSmb = d.includes('small business') || /^sg[23456]|^cbs[23]/.test(m)
  const isHp       = vendor.toLowerCase().includes('hp') || vendor.toLowerCase().includes('aruba') || d.includes('procurve')

  const control = enabled ? 'auto' : 'force-authorized'

  if (isHp) {
    return ifNames.map(iface =>
      enabled
        ? `aaa port-access authenticator ${iface}\naaa port-access authenticator active\nwrite memory`
        : `no aaa port-access authenticator ${iface}\nwrite memory`
    ).join('\n')
  }

  if (isNxos) {
    const lines = ['configure terminal']
    for (const iface of ifNames) {
      lines.push(`interface ${iface}`)
      lines.push(`  dot1x port-control ${control}`)
      lines.push('  exit')
    }
    lines.push('copy running-config startup-config')
    return lines.join('\n')
  }

  if (isCiscoSmb) {
    const lines: string[] = []
    for (const iface of ifNames) {
      lines.push(`interface ${iface}`)
      lines.push(`  dot1x port-control ${control}`)
      lines.push('exit')
    }
    lines.push('end')
    return lines.join('\n')
  }

  // Cisco IOS / IOS-XE
  const lines = ['conf t']
  for (const iface of ifNames) {
    lines.push(`interface ${iface}`)
    lines.push(` authentication port-control ${control}`)
    if (enabled) lines.push(' dot1x pae authenticator')
    else lines.push(' no dot1x pae authenticator')
    lines.push(' exit')
  }
  lines.push('end')
  lines.push('wr')
  return lines.join('\n')
}

export default async function radiusRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // â”€â”€ RADIUS server CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/radius-servers', { preHandler: requireAuth }, async () => {
    const vaultKey = getVaultKey()
    const rows = await db.selectFrom('radius_servers' as any).selectAll().orderBy('name', 'asc').execute()
    return (rows as any[]).map(r => ({
      id:          r.id,
      name:        r.name,
      description: r.description,
      host:        r.host,
      auth_port:   r.auth_port,
      acct_port:   r.acct_port,
      secret:      r.secret_enc ? decryptSecret(r.secret_enc, vaultKey) : '',
      timeout:     r.timeout,
      retries:     r.retries,
      created_at:  r.created_at,
      updated_at:  r.updated_at,
    }))
  })

  fastify.post('/radius-servers', { preHandler: requireAdmin }, async (req, reply) => {
    const body = RadiusBody.parse(req.body)
    const vaultKey = getVaultKey()
    const userId = (req.session.user as any)?.id ?? null

    const [row] = await (db.insertInto('radius_servers' as any).values({
      name:        body.name,
      description: body.description ?? null,
      host:        body.host,
      auth_port:   body.auth_port,
      acct_port:   body.acct_port,
      secret_enc:  encryptSecret(body.secret, vaultKey),
      timeout:     body.timeout,
      retries:     body.retries,
      created_by:  userId,
    }).returningAll().execute() as any)

    await writeAuditLog({ userId, userEmail: (req.session.user as any)?.email, action: 'radius_server.created', resource: 'radius_server', resourceId: row.id, request: req })
    reply.code(201).send({ id: row.id })
  })

  fastify.put('/radius-servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = RadiusBody.parse(req.body)
    const vaultKey = getVaultKey()

    const existing = await (db.selectFrom('radius_servers' as any).select(['id']).where('id', '=', id).executeTakeFirst() as any)
    if (!existing) return reply.code(404).send({ error: 'RADIUS server not found' })

    await db.updateTable('radius_servers' as any).set({
      name:        body.name,
      description: body.description ?? null,
      host:        body.host,
      auth_port:   body.auth_port,
      acct_port:   body.acct_port,
      secret_enc:  encryptSecret(body.secret, vaultKey),
      timeout:     body.timeout,
      retries:     body.retries,
      updated_at:  new Date(),
    }).where('id', '=', id).execute()

    await writeAuditLog({ userId: (req.session.user as any)?.id, userEmail: (req.session.user as any)?.email, action: 'radius_server.updated', resource: 'radius_server', resourceId: id, request: req })
    reply.code(204).send()
  })

  fastify.delete('/radius-servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await db.deleteFrom('radius_servers' as any).where('id', '=', id).execute()
    await writeAuditLog({ userId: (req.session.user as any)?.id, userEmail: (req.session.user as any)?.email, action: 'radius_server.deleted', resource: 'radius_server', resourceId: id, request: req })
    reply.code(204).send()
  })

  // â”€â”€ Push RADIUS config to a network device â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/servers/:id/push-radius', {
    preHandler: [requireAdmin, requireTotpElevation('radius_config_push')],
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { radius_server_ids } = z.object({ radius_server_ids: z.array(z.string().uuid()).min(1) }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Device not found' })

    const vaultKey = getVaultKey()

    // Fetch selected RADIUS servers
    const radiusRows = await (db.selectFrom('radius_servers' as any).selectAll()
      .where('id', 'in', radius_server_ids).execute() as any) as any[]
    if (radiusRows.length === 0) return reply.code(404).send({ error: 'No RADIUS servers found' })

    const radiusServers = radiusRows.map((r: any) => ({
      host:      r.host,
      auth_port: r.auth_port,
      acct_port: r.acct_port,
      secret:    r.secret_enc ? decryptSecret(r.secret_enc, vaultKey) : '',
      timeout:   r.timeout,
      retries:   r.retries,
    }))

    // Resolve device SSH credentials
    const sshUser = (server as any).management_linux_user || 'admin'
    const sshKeyEnc = (server as any).access_ssh_key_enc
    const sshPass   = (server as any).access_ssh_password_enc
    if (!sshKeyEnc && !sshPass) return reply.code(400).send({ error: 'No SSH credentials on device' })

    // Build CLI script
    const lastData = (server as any).snmp_last_data
    const sysDescr = ((typeof lastData === 'string' ? JSON.parse(lastData) : lastData)?.sysDescr ?? '')
    const script = buildRadiusCliScript(
      (server as any).snmp_vendor ?? '',
      (server as any).os_type ?? '',
      sysDescr,
      (server as any).snmp_model ?? '',
      radiusServers,
    )

    // Run via SSH
    const privateKey = sshKeyEnc ? decryptSecret(sshKeyEnc, vaultKey) : undefined
    const password   = sshPass   ? decryptSecret(sshPass, vaultKey) : undefined

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const client = new Client()
        client.on('ready', () => {
          client.shell({ term: 'vt100', cols: 220, rows: 50 }, (err: any, stream: any) => {
            if (err) { client.end(); reject(err); return }
            const chunks: Buffer[] = []
            stream.on('data', (d: Buffer) => chunks.push(d))
            stream.on('close', () => { client.end(); resolve(Buffer.concat(chunks).toString('utf8').slice(0, 3000)) })
            stream.write(script + '\nexit\n')
            setTimeout(() => { try { stream.close() } catch {} }, 15000)
          })
        })
        client.on('error', reject)
        client.connect({ host: server.hostname, port: 22, username: sshUser, privateKey, password, readyTimeout: 10000 })
      })

      await writeAuditLog({ userId: (req.session.user as any)?.id, userEmail: (req.session.user as any)?.email, action: 'radius_config_push', resource: 'server', resourceId: id, request: req })
      return { ok: true, output }
    } catch (err: any) {
      return reply.code(400).send({ error: `SSH push failed: ${err.message ?? err}` })
    }
  })

  // â”€â”€ Push 802.1X port auth to selected ports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/servers/:id/push-dot1x-ports', {
    preHandler: [requireAdmin, requireTotpElevation('network_config_push')],
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { if_names, enabled } = z.object({
      if_names: z.array(z.string()).min(1),
      enabled:  z.boolean(),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Device not found' })

    const vaultKey = getVaultKey()
    const lastData = (server as any).snmp_last_data
    const sysDescr = ((typeof lastData === 'string' ? JSON.parse(lastData) : lastData)?.sysDescr ?? '')

    const script = buildDot1xPortScript(
      (server as any).snmp_vendor ?? '',
      (server as any).os_type ?? '',
      sysDescr,
      (server as any).snmp_model ?? '',
      if_names,
      enabled,
    )

    const sshUser    = (server as any).management_linux_user || 'admin'
    const privateKey = (server as any).access_ssh_key_enc ? decryptSecret((server as any).access_ssh_key_enc, vaultKey) : undefined
    const password   = (server as any).access_ssh_password_enc ? decryptSecret((server as any).access_ssh_password_enc, vaultKey) : undefined
    if (!privateKey && !password) return reply.code(400).send({ error: 'No SSH credentials on device' })

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const client = new Client()
        client.on('ready', () => {
          client.shell({ term: 'vt100', cols: 220, rows: 50 }, (err: any, stream: any) => {
            if (err) { client.end(); reject(err); return }
            const chunks: Buffer[] = []
            stream.on('data', (d: Buffer) => chunks.push(d))
            stream.on('close', () => { client.end(); resolve(Buffer.concat(chunks).toString('utf8').slice(0, 3000)) })
            stream.write(script + '\nexit\n')
            setTimeout(() => { try { stream.close() } catch {} }, 12000)
          })
        })
        client.on('error', reject)
        client.connect({ host: server.hostname, port: 22, username: sshUser, privateKey, password, readyTimeout: 10000 })
      })

      await writeAuditLog({ userId: (req.session.user as any)?.id, userEmail: (req.session.user as any)?.email, action: 'dot1x_port_push', resource: 'server', resourceId: id, request: req })
      return { ok: true, output }
    } catch (err: any) {
      return reply.code(400).send({ error: `SSH push failed: ${err.message ?? err}` })
    }
  })

  // â”€â”€ SNMP: fetch authenticated hosts for a port â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns MAC table from dot1xAuthSuppOperTable per ifIndex

  fastify.get('/servers/:id/dot1x-hosts/:ifIndex', { preHandler: requireAuth }, async (req, reply) => {
    const { id, ifIndex } = z.object({ id: z.string().uuid(), ifIndex: z.string() }).parse(req.params)
    const ifIdx = parseInt(ifIndex, 10)
    if (isNaN(ifIdx)) return reply.code(400).send({ error: 'Invalid ifIndex' })

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Device not found' })
    if (!(server as any).snmp_enabled) return reply.code(400).send({ error: 'SNMP not configured' })

    const vaultKey  = getVaultKey()
    const version   = (server as any).snmp_version ?? 'v2c'
    const port      = (server as any).snmp_port ?? 161
    const community = (server as any).snmp_community_enc ? decryptSecret((server as any).snmp_community_enc, vaultKey) : 'public'

    try {
      const snmp = await import('net-snmp')
      const sess = snmp.createSession(server.hostname, community, {
        port, retries: 1, timeout: 5000, transport: 'udp4',
        version: version === 'v1' ? snmp.Version1 : snmp.Version2c,
      })

      // dot1xAuthSuppOperTable indexed by ifIndex.macIndex â€” get all entries under this ifIndex
      const baseOid = `1.0.8802.1.1.1.1.2.2.1.1.${ifIdx}`

      const hosts = await new Promise<Array<{ mac: string; status: string }>>((resolve) => {
        const result: Array<{ mac: string; status: string }> = []
        sess.subtree(baseOid, 10, (vbs: any[]) => {
          for (const vb of vbs) {
            if (snmp.isVarbindError(vb)) continue
            const raw = vb.value
            let mac = ''
            if (Buffer.isBuffer(raw) && raw.length === 6) {
              mac = Array.from(raw).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
            } else if (raw != null) mac = String(raw)
            if (mac) result.push({ mac, status: 'authenticated' })
          }
        }, () => { sess.close(); resolve(result) })
      })

      // Also try the simpler authenticated host count OID
      const countOid = `1.0.8802.1.1.1.1.2.4.1.9.${ifIdx}`
      const countResult = await new Promise<string>((resolve) => {
        sess.get([countOid], (err: any, vbs: any) => {
          if (err || !vbs || snmp.isVarbindError(vbs[0])) { resolve(''); return }
          resolve(vbs[0]?.value != null ? String(vbs[0].value) : '')
        })
      }).catch(() => '')

      return { if_index: ifIdx, hosts, auth_count: countResult }
    } catch (err: any) {
      return reply.code(400).send({ error: `SNMP query failed: ${err.message ?? err}` })
    }
  })
}

