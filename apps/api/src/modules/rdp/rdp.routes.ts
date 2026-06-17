import { FastifyInstance } from 'fastify'
import * as crypto from 'crypto'
import * as net from 'net'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'

// Must match the key used in guac-proxy/index.js (AES-256 = 32 bytes)
function getGuacKey(): Buffer {
  const raw = process.env.GUAC_CRYPT_KEY ?? ''
  if (!raw || raw.length < 16) throw new Error('GUAC_CRYPT_KEY not configured — add it to your .env file')
  const buf = Buffer.alloc(32)
  Buffer.from(raw).copy(buf)
  return buf
}

function encryptGuacToken(data: object): string {
  const key = getGuacKey()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)

  // guacamole-lite 1.2.x expects: base64(JSON.stringify({ iv: base64(iv), value: base64(ciphertext) }))
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'binary')
  encrypted += cipher.final('binary')

  const tokenObj = {
    iv:    Buffer.from(iv).toString('base64'),
    value: Buffer.from(encrypted, 'binary').toString('base64'),
  }
  return Buffer.from(JSON.stringify(tokenObj)).toString('base64')
}

async function rdpRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /servers/:id/rdp-token
  // Returns an encrypted token the browser uses to open the WebSocket RDP session
  fastify.post('/servers/:id/rdp-token', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      username:  z.string().min(1),
      password:  z.string().min(1),
      domain:    z.string().optional(),
      port:      z.number().int().min(1).max(65535).default(3389),
      width:     z.number().int().min(640).max(3840).default(1280),
      height:    z.number().int().min(480).max(2160).default(768),
      dpi:       z.number().int().min(72).max(192).default(96),
      // credential_id lets the UI use a saved vault credential instead of sending the password raw
      credential_id: z.string().uuid().optional(),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    let username = body.username
    let password = body.password
    let domain   = body.domain ?? ''

    // If a saved credential was selected, decrypt it from the vault
    if (body.credential_id) {
      const cred = await db.selectFrom('server_credentials' as any)
        .selectAll()
        .where('id' as any, '=', body.credential_id)
        .where('server_id' as any, '=', id)
        .where('is_archived' as any, '=', false)
        .executeTakeFirst() as any
      if (!cred) return reply.code(404).send({ error: 'Credential not found' })
      const vk = getVaultKey()
      username = cred.service_username ?? cred.linux_user ?? username
      password = decryptSecret(cred.password_enc, vk)
      // Extract domain saved in notes as "Domain: DOMAIN_NAME"
      if (!domain && cred.notes) {
        const m = (cred.notes as string).match(/^Domain:\s*(.+)$/im)
        if (m) domain = m[1].trim()
      }
    }

    // Validate GUAC_CRYPT_KEY is configured before generating token
    try { getGuacKey() } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }

    const connection = {
      connection: {
        type: 'rdp',
        settings: {
          hostname:            server.hostname,
          port:                String(body.port),
          username,
          password,
          domain,
          width:               String(body.width),
          height:              String(body.height),
          dpi:                 String(body.dpi),
          security:            'nla',
          'ignore-cert':       'true',
          'console':           'true',
          'enable-clipboard':  'true',
          'clipboard-encoding': 'UTF-8',
          'enable-drive':      'true',
          'drive-name':        'Upload',
          'drive-path':        '/tmp/guac-uploads',
          'create-drive-path': 'true',
          'enable-wallpaper':  'false',
          'enable-theming':    'false',
          'enable-font-smoothing': 'false',
          'enable-full-window-drag': 'false',
          'enable-desktop-composition': 'false',
          'enable-menu-animations': 'false',
          'disable-auth':      'false',
          'color-depth':       '16',
          'resize-method':     'display-update',
          'force-lossless':    'false',
        },
      },
    }

    const token = encryptGuacToken(connection)

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.rdp_session_started', resource: 'server', resourceId: id,
      details: { hostname: server.hostname, rdp_port: body.port, username },
      request: req,
    })

    return { token, server_name: server.name, hostname: server.hostname }
  })

  // GET /servers/:id/rdp-check — TCP port reachability check (no credentials needed)
  fastify.get('/servers/:id/rdp-check', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { port } = z.object({ port: z.coerce.number().int().min(1).max(65535).default(3389) }).parse(req.query)

    const server = await db.selectFrom('servers').select(['hostname']).where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const reachable = await new Promise<boolean>((resolve) => {
      const sock = new net.Socket()
      const timeout = 4000
      sock.setTimeout(timeout)
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('timeout', () => { sock.destroy(); resolve(false) })
      sock.once('error', () => { sock.destroy(); resolve(false) })
      sock.connect(port, server.hostname)
    })

    // Include the source IP so users know which IP to whitelist in Windows Firewall
    const sourceIp = (req.socket?.localAddress ?? '').replace('::ffff:', '')
    return { reachable, hostname: server.hostname, port, source_ip: sourceIp }
  })

  // POST /servers/:id/windows-setup — save RDP credentials to vault and mark server ready
  fastify.post('/servers/:id/windows-setup', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      username:    z.string().min(1),
      password:    z.string().min(1),
      domain:      z.string().optional(),
      rdp_port:    z.number().int().min(1).max(65535).default(3389),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const vk = getVaultKey()
    const label = body.domain
      ? `${body.domain}\\${body.username} (RDP)`
      : `${body.username} (RDP)`

    await (db as any).insertInto('server_credentials').values({
      server_id:        id,
      category:         'other',
      service_name:     'RDP',
      service_username: body.username,
      label,
      notes:            body.domain ? `Domain: ${body.domain}` : null,
      password_enc:     encryptSecret(body.password, vk),
      is_archived:      false,
      created_by:       req.session.user!.id,
    }).execute()

    await db.updateTable('servers')
      .set({ windows_rdp_ready: true, os_type: 'windows' })
      .where('id', '=', id)
      .execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.windows_setup_complete', resource: 'server', resourceId: id,
      details: { hostname: server.hostname, rdp_port: body.rdp_port, username: body.username },
      request: req,
    })

    return { ok: true }
  })

  // GET /servers/:id/rdp-credentials — list vault credentials suitable for RDP
  fastify.get('/servers/:id/rdp-credentials', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const creds = await (db as any)
      .selectFrom('server_credentials')
      .select(['id', 'label', 'service_username', 'notes', 'category', 'updated_at', 'is_archived'])
      .where('server_id', '=', id)
      .where('category', '!=', 'linux')
      .orderBy('label')
      .execute()
    return creds
  })

  // PUT /servers/:id/rdp-credentials/:credId — update an RDP credential
  fastify.put('/servers/:id/rdp-credentials/:credId', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)
    const body = z.object({
      label:    z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1).optional(),
      domain:   z.string().optional(),
    }).parse(req.body)

    const cred = await (db as any)
      .selectFrom('server_credentials').selectAll()
      .where('id', '=', credId).where('server_id', '=', id)
      .executeTakeFirst() as any
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })

    const vk = getVaultKey()
    const newLabel = body.domain ? `${body.domain}\\${body.username} (RDP)` : `${body.username} (RDP)`
    const updates: Record<string, unknown> = {
      label:            body.label || newLabel,
      service_username: body.username,
      notes:            body.domain ? `Domain: ${body.domain}` : null,
    }
    if (body.password) updates.password_enc = encryptSecret(body.password, vk)

    await (db as any).updateTable('server_credentials')
      .set(updates)
      .where('id', '=', credId)
      .execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.rdp_credential_updated', resource: 'server', resourceId: id,
      details: { credId, username: body.username },
      request: req,
    })

    return { ok: true }
  })

  // DELETE /servers/:id/rdp-credentials/:credId — archive or permanently delete
  fastify.delete('/servers/:id/rdp-credentials/:credId', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)
    const body = z.object({ permanent: z.boolean().default(false) }).optional().parse(req.body)

    const cred = await (db as any)
      .selectFrom('server_credentials').select(['id', 'is_archived'])
      .where('id', '=', credId).where('server_id', '=', id)
      .executeTakeFirst() as any
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })

    if (body?.permanent || cred.is_archived) {
      await (db as any).deleteFrom('server_credentials').where('id', '=', credId).execute()
    } else {
      await (db as any).updateTable('server_credentials').set({ is_archived: true }).where('id', '=', credId).execute()
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.rdp_credential_deleted', resource: 'server', resourceId: id,
      details: { credId, permanent: !!(body?.permanent || cred.is_archived) },
      request: req,
    })

    reply.code(204).send()
  })

  // POST /servers/:id/rdp-credentials/:credId/reveal — decrypt password
  fastify.post('/servers/:id/rdp-credentials/:credId/reveal', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id, credId } = z.object({ id: z.string().uuid(), credId: z.string().uuid() }).parse(req.params)
    const cred = await (db as any)
      .selectFrom('server_credentials').select(['password_enc'])
      .where('id', '=', credId).where('server_id', '=', id)
      .executeTakeFirst() as any
    if (!cred) return reply.code(404).send({ error: 'Credential not found' })
    const vk = getVaultKey()
    return { password: decryptSecret(cred.password_enc, vk) }
  })
}

export default rdpRoutes
