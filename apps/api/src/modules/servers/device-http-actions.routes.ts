import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'

const ActionBody = z.object({
  name:             z.string().min(1).max(128),
  description:      z.string().max(500).optional(),
  method:           z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  url_path:         z.string().min(1).max(1000),
  headers:          z.record(z.string()).default({}),
  body:             z.string().optional(),
  content_type:     z.string().max(100).default('application/json'),
  auth_type:        z.enum(['none', 'basic', 'bearer', 'vault']).default('none'),
  auth_username:    z.string().max(256).optional(),
  auth_password:    z.string().optional(),
  vault_id:         z.string().uuid().nullable().optional(),
  follow_redirects: z.boolean().default(true),
  timeout_ms:       z.number().int().min(1000).max(60000).default(10000),
  sort_order:       z.number().int().default(0),
})

export default async function deviceHttpActionsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth)

  // GET /network-devices/:id/actions
  fastify.get('/network-devices/:id/actions', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const rows = await (db as any)
      .selectFrom('device_http_actions as a')
      .leftJoin('vault_entries as v', 'v.id', 'a.vault_id')
      .select([
        'a.id', 'a.device_id', 'a.name', 'a.description',
        'a.method', 'a.url_path', 'a.headers', 'a.body',
        'a.content_type', 'a.auth_type', 'a.auth_username',
        'a.vault_id', 'a.follow_redirects', 'a.timeout_ms',
        'a.sort_order', 'a.created_at', 'a.updated_at',
        'v.title as vault_title',
      ])
      .where('a.device_id', '=', id)
      .orderBy('a.sort_order', 'asc')
      .orderBy('a.created_at', 'asc')
      .execute()
    return rows
  })

  // POST /network-devices/:id/actions
  fastify.post('/network-devices/:id/actions', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = ActionBody.parse(req.body)
    const vaultKey = getVaultKey()
    const auth_password_enc = body.auth_password ? encryptSecret(body.auth_password, vaultKey) : null

    const row = await (db as any).insertInto('device_http_actions').values({
      device_id: id,
      name: body.name,
      description: body.description ?? null,
      method: body.method,
      url_path: body.url_path,
      headers: JSON.stringify(body.headers),
      body: body.body ?? null,
      content_type: body.content_type,
      auth_type: body.auth_type,
      auth_username: body.auth_username ?? null,
      auth_password_enc,
      vault_id: body.vault_id ?? null,
      follow_redirects: body.follow_redirects,
      timeout_ms: body.timeout_ms,
      sort_order: body.sort_order,
      created_by: (req.session.user as any)!.id,
    }).returningAll().executeTakeFirst()

    return reply.code(201).send(row)
  })

  // PATCH /network-devices/:id/actions/:actionId
  fastify.patch('/network-devices/:id/actions/:actionId', async (req, reply) => {
    const { id, actionId } = z.object({ id: z.string().uuid(), actionId: z.string().uuid() }).parse(req.params)
    const body = ActionBody.partial().parse(req.body)
    const vaultKey = getVaultKey()

    const existing = await (db as any).selectFrom('device_http_actions').select(['id']).where('id', '=', actionId).where('device_id', '=', id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ error: 'Action not found' })

    const updates: any = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name
    if (body.description !== undefined) updates.description = body.description ?? null
    if (body.method !== undefined) updates.method = body.method
    if (body.url_path !== undefined) updates.url_path = body.url_path
    if (body.headers !== undefined) updates.headers = JSON.stringify(body.headers)
    if (body.body !== undefined) updates.body = body.body ?? null
    if (body.content_type !== undefined) updates.content_type = body.content_type
    if (body.auth_type !== undefined) updates.auth_type = body.auth_type
    if (body.auth_username !== undefined) updates.auth_username = body.auth_username ?? null
    if (body.auth_password) updates.auth_password_enc = encryptSecret(body.auth_password, vaultKey)
    if (body.vault_id !== undefined) updates.vault_id = body.vault_id ?? null
    if (body.follow_redirects !== undefined) updates.follow_redirects = body.follow_redirects
    if (body.timeout_ms !== undefined) updates.timeout_ms = body.timeout_ms
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order

    await (db as any).updateTable('device_http_actions').set(updates).where('id', '=', actionId).execute()
    return { ok: true }
  })

  // DELETE /network-devices/:id/actions/:actionId
  fastify.delete('/network-devices/:id/actions/:actionId', async (req, reply) => {
    const { id, actionId } = z.object({ id: z.string().uuid(), actionId: z.string().uuid() }).parse(req.params)
    await (db as any).deleteFrom('device_http_actions').where('id', '=', actionId).where('device_id', '=', id).execute()
    return reply.code(204).send()
  })

  // POST /network-devices/:id/actions/:actionId/execute
  fastify.post('/network-devices/:id/actions/:actionId/execute', async (req, reply) => {
    const { id, actionId } = z.object({ id: z.string().uuid(), actionId: z.string().uuid() }).parse(req.params)

    // Load device + action
    const device = await (db as any).selectFrom('servers').select(['id', 'name', 'web_url']).where('id', '=', id).executeTakeFirst()
    if (!device) return reply.code(404).send({ error: 'Device not found' })
    if (!device.web_url) return reply.code(400).send({ error: 'Device has no web URL configured' })

    const action = await (db as any).selectFrom('device_http_actions').selectAll().where('id', '=', actionId).where('device_id', '=', id).executeTakeFirst()
    if (!action) return reply.code(404).send({ error: 'Action not found' })

    // Build full URL
    const baseUrl = device.web_url.replace(/\/$/, '')
    const path = action.url_path.startsWith('/') ? action.url_path : `/${action.url_path}`
    const fullUrl = `${baseUrl}${path}`

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': action.content_type ?? 'application/json',
      ...(typeof action.headers === 'string' ? JSON.parse(action.headers) : action.headers ?? {}),
    }

    // Resolve auth
    const vaultKey = getVaultKey()
    if (action.auth_type === 'basic') {
      let password = ''
      if (action.vault_id) {
        const ve = await (db as any).selectFrom('vault_entries').select(['password_enc', 'username']).where('id', '=', action.vault_id).executeTakeFirst()
        if (ve?.password_enc) password = decryptSecret(ve.password_enc, vaultKey)
        if (!action.auth_username && ve?.username) headers['Authorization'] = `Basic ${Buffer.from(`${ve.username}:${password}`).toString('base64')}`
        else headers['Authorization'] = `Basic ${Buffer.from(`${action.auth_username ?? ''}:${password}`).toString('base64')}`
      } else if (action.auth_password_enc) {
        password = decryptSecret(action.auth_password_enc, vaultKey)
        headers['Authorization'] = `Basic ${Buffer.from(`${action.auth_username ?? ''}:${password}`).toString('base64')}`
      }
    } else if (action.auth_type === 'bearer') {
      let token = ''
      if (action.vault_id) {
        const ve = await (db as any).selectFrom('vault_entries').select(['password_enc']).where('id', '=', action.vault_id).executeTakeFirst()
        if (ve?.password_enc) token = decryptSecret(ve.password_enc, vaultKey)
      } else if (action.auth_password_enc) {
        token = decryptSecret(action.auth_password_enc, vaultKey)
      }
      if (token) headers['Authorization'] = `Bearer ${token}`
    } else if (action.auth_type === 'vault' && action.vault_id) {
      // vault type: inject username+password as Basic
      const ve = await (db as any).selectFrom('vault_entries').select(['password_enc', 'username']).where('id', '=', action.vault_id).executeTakeFirst()
      if (ve) {
        const password = ve.password_enc ? decryptSecret(ve.password_enc, vaultKey) : ''
        headers['Authorization'] = `Basic ${Buffer.from(`${ve.username ?? ''}:${password}`).toString('base64')}`
      }
    }

    // Execute HTTP request (Node built-in fetch — Node 18+)
    const startMs = Date.now()
    try {
      const fetchRes = await fetch(fullUrl, {
        method: action.method,
        headers,
        body: ['GET', 'DELETE'].includes(action.method) ? undefined : (action.body ?? undefined),
        signal: AbortSignal.timeout(action.timeout_ms ?? 10000),
        redirect: action.follow_redirects ? 'follow' : 'manual',
      } as RequestInit)

      const duration_ms = Date.now() - startMs
      const responseText = await fetchRes.text().catch(() => '')

      await writeAuditLog({
        userId: (req.session.user as any)!.id,
        userEmail: (req.session.user as any)!.email,
        action: 'device.http_action.executed',
        resource: 'network_device',
        resourceId: id,
        details: { action_name: action.name, method: action.method, url: fullUrl, status: fetchRes.status },
        request: req,
      })

      return {
        ok: fetchRes.ok,
        status: fetchRes.status,
        status_text: fetchRes.statusText,
        duration_ms,
        response: responseText.slice(0, 4000),
      }
    } catch (err: any) {
      const duration_ms = Date.now() - startMs
      return reply.code(502).send({ ok: false, error: err.message, duration_ms })
    }
  })
}
