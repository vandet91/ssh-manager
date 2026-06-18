import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'

const VAULT_TYPES = ['server_os', 'service', 'api_key', 'network_device', 'domain_ad', 'email', 'printer', 'dvr', 'other'] as const

const EntryBody = z.object({
  title: z.string().min(1).max(300),
  type: z.enum(VAULT_TYPES).default('other'),
  category: z.string().max(100).optional(),
  ou: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).default([]),
  username: z.string().max(300).optional(),
  password: z.string().optional(),
  url: z.string().max(1000).optional(),
  notes: z.string().max(5000).optional(),
  server_credential_id: z.string().uuid().optional(),
})

export default async function vaultRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /vault — list entries (active by default; ?archived=true for archived)
  fastify.get('/vault', { preHandler: requirePermission('servers:read') }, async (req) => {
    const query = z.object({
      type: z.string().optional(),
      category: z.string().optional(),
      tag: z.string().optional(),
      search: z.string().optional(),
      archived: z.coerce.boolean().default(false),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(100),
    }).parse(req.query)

    const anyDb = db as any
    let qb = anyDb
      .selectFrom('vault_entries')
      .leftJoin('server_credentials', 'server_credentials.id', 'vault_entries.server_credential_id')
      .leftJoin('servers', 'servers.id', 'server_credentials.server_id')
      .select([
        'vault_entries.id',
        'vault_entries.title',
        'vault_entries.type',
        'vault_entries.category',
        'vault_entries.ou',
        'vault_entries.tags',
        'vault_entries.username',
        'vault_entries.url',
        'vault_entries.notes',
        'vault_entries.server_credential_id',
        'vault_entries.created_by',
        'vault_entries.created_at',
        'vault_entries.updated_at',
        'vault_entries.is_archived',
        'vault_entries.archived_at',
        'server_credentials.label as linked_credential_label',
        'servers.id as linked_server_id',
        'servers.name as linked_server_name',
      ])
      .orderBy('vault_entries.updated_at', 'desc')

    qb = qb.where('vault_entries.is_archived', '=', query.archived)
    if (query.type) qb = qb.where('vault_entries.type', '=', query.type)
    if (query.category) qb = qb.where('vault_entries.category', '=', query.category)

    const rows = await qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()

    // Tag filter in-memory (postgres array contains requires sql tag)
    let result = rows as any[]
    if (query.tag) result = result.filter((r: any) => r.tags?.includes(query.tag))
    if (query.search) {
      const s = query.search.toLowerCase()
      result = result.filter((r: any) =>
        r.title?.toLowerCase().includes(s) ||
        r.username?.toLowerCase().includes(s) ||
        r.notes?.toLowerCase().includes(s) ||
        r.category?.toLowerCase().includes(s)
      )
    }

    return result
  })

  // POST /vault/purge-bulk — permanently delete multiple archived entries (MUST be before /:id)
  fastify.post('/vault/purge-bulk', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(req.body)
    await db.deleteFrom('vault_entries').where('id', 'in', ids).execute()
    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.purged_bulk', resource: 'vault_entry', resourceId: undefined,
      details: { count: ids.length }, request: req,
    })
    return { purged: ids.length }
  })

  // GET /vault/ous — list all OUs with entry counts (MUST be before /vault/:id)
  fastify.get('/vault/ous', { preHandler: requirePermission('servers:read') }, async () => {
    const rows = await db.selectFrom('vault_entries')
      .select(['ou'])
      .where('ou', 'is not', null)
      .execute()
    const counts: Record<string, number> = {}
    for (const r of rows) {
      const key = r.ou as string
      counts[key] = (counts[key] ?? 0) + 1
    }
    return Object.entries(counts)
      .map(([ou, count]) => ({ ou, count }))
      .sort((a, b) => a.ou.localeCompare(b.ou))
  })

  // POST /vault/ous/rename — rename an OU across all entries (MUST be before /vault/:id)
  fastify.post('/vault/ous/rename', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { from, to } = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(req.body)
    if (from === to) return reply.code(400).send({ error: 'Names are the same' })
    const result = await db.updateTable('vault_entries')
      .set({ ou: to, updated_at: new Date() })
      .where('ou', '=', from)
      .execute()
    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.ou_renamed', resource: 'vault_ou', resourceId: undefined,
      details: { from, to, affected: Number(result[0]?.numUpdatedRows ?? 0) }, request: req,
    })
    return { affected: Number(result[0]?.numUpdatedRows ?? 0) }
  })

  // POST /vault/ous/delete — delete an OU; move entries to move_to or clear their OU (MUST be before /vault/:id)
  fastify.post('/vault/ous/delete', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { ou, move_to } = z.object({ ou: z.string().min(1), move_to: z.string().optional() }).parse(req.body)
    const newOu = move_to && move_to.trim() ? move_to.trim() : null
    const result = await db.updateTable('vault_entries')
      .set({ ou: newOu, updated_at: new Date() })
      .where('ou', '=', ou)
      .execute()
    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.ou_deleted', resource: 'vault_ou', resourceId: undefined,
      details: { ou, move_to: newOu, affected: Number(result[0]?.numUpdatedRows ?? 0) }, request: req,
    })
    return { affected: Number(result[0]?.numUpdatedRows ?? 0) }
  })

  // GET /vault/:id — single entry (no password)
  fastify.get('/vault/:id', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const entry = await db.selectFrom('vault_entries').selectAll().where('id', '=', id).executeTakeFirst()
    if (!entry) return reply.code(404).send({ error: 'Not found' })
    const { password_enc: _, ...safe } = entry
    return safe
  })

  // POST /vault — create entry
  fastify.post('/vault', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const body = EntryBody.parse(req.body)
    const vaultKey = getVaultKey()

    const passwordEnc = body.password ? encryptSecret(body.password, vaultKey) : null

    const [entry] = await db.insertInto('vault_entries').values({
      title: body.title,
      type: body.type,
      category: body.category ?? null,
      ou: body.ou ?? null,
      tags: body.tags,
      username: body.username ?? null,
      password_enc: passwordEnc,
      url: body.url ?? null,
      notes: body.notes ?? null,
      server_credential_id: body.server_credential_id ?? null,
      created_by: req.session.user!.id,
    }).returningAll().execute()

    // Bidirectional sync: if linked to a server_credential, also update that credential's password
    if (body.password && body.server_credential_id) {
      await syncToCredential(body.server_credential_id, body.password, vaultKey)
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.created', resource: 'vault_entry', resourceId: entry.id,
      details: { title: body.title, type: body.type }, request: req,
    })

    const { password_enc: _, ...safe } = entry
    return reply.code(201).send(safe)
  })

  // PATCH /vault/:id — update entry
  fastify.patch('/vault/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = EntryBody.partial().parse(req.body)

    const existing = await db.selectFrom('vault_entries').selectAll().where('id', '=', id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const vaultKey = getVaultKey()
    const updates: Record<string, unknown> = { updated_at: new Date() }

    if (body.title !== undefined) updates.title = body.title
    if (body.type !== undefined) updates.type = body.type
    if (body.category !== undefined) updates.category = body.category
    if (body.ou !== undefined) updates.ou = body.ou || null
    if (body.tags !== undefined) updates.tags = body.tags
    if (body.username !== undefined) updates.username = body.username
    if (body.url !== undefined) updates.url = body.url
    if (body.notes !== undefined) updates.notes = body.notes
    if (body.server_credential_id !== undefined) updates.server_credential_id = body.server_credential_id || null
    if (body.password !== undefined && body.password !== '') {
      updates.password_enc = encryptSecret(body.password, vaultKey)
    }

    await db.updateTable('vault_entries').set(updates).where('id', '=', id).execute()

    // Bidirectional sync: push new password to linked credential
    const linkedCredId = (body.server_credential_id !== undefined ? body.server_credential_id : existing.server_credential_id) ?? null
    if (body.password && linkedCredId) {
      await syncToCredential(linkedCredId, body.password, vaultKey)
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.updated', resource: 'vault_entry', resourceId: id,
      details: { password_changed: !!body.password }, request: req,
    })

    return { ok: true }
  })

  // POST /vault/:id/reveal — decrypt and return password
  fastify.post('/vault/:id/reveal', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const entry = await db.selectFrom('vault_entries').selectAll().where('id', '=', id).executeTakeFirst()
    if (!entry) return reply.code(404).send({ error: 'Not found' })
    if (!entry.password_enc) return reply.code(404).send({ error: 'No password stored' })

    const vaultKey = getVaultKey()
    const password = decryptSecret(entry.password_enc, vaultKey)

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.revealed', resource: 'vault_entry', resourceId: id,
      details: { title: entry.title }, request: req,
    })

    return { password }
  })

  // POST /vault/:id/pull-from-credential — pull latest password FROM linked server_credential into vault
  fastify.post('/vault/:id/pull-from-credential', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const entry = await db.selectFrom('vault_entries').selectAll().where('id', '=', id).executeTakeFirst()
    if (!entry) return reply.code(404).send({ error: 'Not found' })
    if (!entry.server_credential_id) return reply.code(400).send({ error: 'No linked credential' })

    const cred = await db.selectFrom('server_credentials').selectAll()
      .where('id', '=', entry.server_credential_id).executeTakeFirst()
    if (!cred) return reply.code(404).send({ error: 'Linked credential not found' })

    await db.updateTable('vault_entries')
      .set({ password_enc: cred.password_enc, updated_at: new Date() })
      .where('id', '=', id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.synced_from_credential', resource: 'vault_entry', resourceId: id,
      details: { server_credential_id: entry.server_credential_id }, request: req,
    })

    return { ok: true }
  })

  // DELETE /vault/:id — soft delete (archive)
  fastify.delete('/vault/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const entry = await db.selectFrom('vault_entries').select(['id', 'title']).where('id', '=', id).executeTakeFirst()
    if (!entry) return reply.code(404).send({ error: 'Not found' })

    await db.updateTable('vault_entries')
      .set({ is_archived: true, archived_at: new Date(), updated_at: new Date() })
      .where('id', '=', id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.archived', resource: 'vault_entry', resourceId: id,
      details: { title: entry.title }, request: req,
    })

    reply.code(204).send()
  })

  // POST /vault/:id/restore — unarchive
  fastify.post('/vault/:id/restore', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const entry = await db.selectFrom('vault_entries').select(['id', 'title']).where('id', '=', id).executeTakeFirst()
    if (!entry) return reply.code(404).send({ error: 'Not found' })

    await db.updateTable('vault_entries')
      .set({ is_archived: false, archived_at: null, updated_at: new Date() })
      .where('id', '=', id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.restored', resource: 'vault_entry', resourceId: id,
      details: { title: entry.title }, request: req,
    })

    return { ok: true }
  })

  // DELETE /vault/:id/purge — permanently delete
  fastify.delete('/vault/:id/purge', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const entry = await db.selectFrom('vault_entries').select(['id', 'title']).where('id', '=', id).executeTakeFirst()
    if (!entry) return reply.code(404).send({ error: 'Not found' })

    await db.deleteFrom('vault_entries').where('id', '=', id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'vault.purged', resource: 'vault_entry', resourceId: id,
      details: { title: entry.title }, request: req,
    })

    reply.code(204).send()
  })


}

async function syncToCredential(credId: string, password: string, vaultKey: Buffer): Promise<void> {
  await db.updateTable('server_credentials')
    .set({ password_enc: encryptSecret(password, vaultKey), updated_at: new Date() })
    .where('id', '=', credId)
    .execute()
}
