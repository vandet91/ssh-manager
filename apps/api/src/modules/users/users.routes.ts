import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'

async function usersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /users/me
  fastify.get('/users/me', async (req) => {
    return db.selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'mfa_enabled', 'is_active', 'last_login_at', 'created_at'])
      .where('id', '=', req.session.user!.id)
      .executeTakeFirst()
  })

  // GET /users
  fastify.get('/users', { preHandler: requireAdmin }, async (req) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(req.query)
    const [users, countRow] = await Promise.all([
      db.selectFrom('users')
        .select(['id', 'email', 'display_name', 'role', 'provider', 'mfa_enabled', 'mfa_exempt', 'is_active', 'last_login_at', 'created_at'])
        .limit(query.limit).offset((query.page - 1) * query.limit)
        .execute(),
      db.selectFrom('users').select(db.fn.countAll().as('count')).executeTakeFirst(),
    ])
    return { users, total: Number(countRow?.count ?? 0), page: query.page, limit: query.limit }
  })

  // GET /users/:id
  fastify.get('/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const user = await db.selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'provider', 'mfa_enabled', 'is_active', 'last_login_at', 'created_at'])
      .where('id', '=', id).executeTakeFirst()
    if (!user) return reply.code(404).send({ error: 'User not found' })
    return user
  })

  // PATCH /users/:id — change status or password
  fastify.patch('/users/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { id: callerId } = req.session.user!

    if (id === callerId) return reply.code(403).send({ error: 'You cannot change your own account status. Ask another admin.' })

    const body = z.object({
      is_active: z.boolean().optional(),
    }).parse(req.body)

    const user = await db.updateTable('users').set({ ...body, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirst()
    if (!user) return reply.code(404).send({ error: 'User not found' })
    await writeAuditLog({ userId: callerId, userEmail: req.session.user!.email, action: 'user.updated', resource: 'user', resourceId: id, details: body, request: req })
    return user
  })

  // DELETE /users/:id/mfa — admin resets MFA (clears secret, forces re-enroll next login)
  fastify.delete('/users/:id/mfa', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await db.updateTable('users')
      .set({ mfa_secret: null, mfa_enabled: false, mfa_backup_codes: null, mfa_exempt: false, updated_at: new Date() })
      .where('id', '=', id).execute()
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'user.mfa_reset', resource: 'user', resourceId: id, request: req })
    return { ok: true }
  })

  // PATCH /users/:id/mfa — toggle MFA exempt (disable requirement without clearing secret)
  fastify.patch('/users/:id/mfa', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { exempt } = z.object({ exempt: z.boolean() }).parse(req.body)
    const updates: Record<string, unknown> = { mfa_exempt: exempt, updated_at: new Date() }
    if (exempt) {
      // Disabling MFA: clear secret so there's no stale TOTP data
      updates.mfa_enabled = false
      updates.mfa_secret = null
      updates.mfa_backup_codes = null
    }
    await db.updateTable('users').set(updates).where('id', '=', id).execute()
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: exempt ? 'user.mfa_disabled' : 'user.mfa_required', resource: 'user', resourceId: id, request: req })
    return { ok: true }
  })

  // DELETE /users/:id — deactivate
  fastify.delete('/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    if (id === req.session.user!.id) return reply.code(403).send({ error: 'You cannot deactivate your own account.' })
    await db.updateTable('users').set({ is_active: false, updated_at: new Date() }).where('id', '=', id).execute()
    await db.updateTable('key_assignments').set({ is_active: false }).where('user_id', '=', id).execute()
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'user.deactivated', resource: 'user', resourceId: id, request: req })
    reply.code(204).send()
  })

  // ── Operator grant management ─────────────────────────────────────────────

  // GET /users/:id/grants — all server + vault grants for an operator
  fastify.get('/users/:id/grants', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const [serverGrants, vaultGrants] = await Promise.all([
      (db as any).selectFrom('operator_server_access as osa')
        .innerJoin('servers', 'servers.id', 'osa.server_id')
        .select(['osa.id', 'osa.server_id', 'servers.name as server_name', 'servers.hostname', 'servers.environment', 'servers.os_type', 'osa.granted_at', 'osa.expires_at'])
        .where('osa.operator_id', '=', id)
        .orderBy('servers.name', 'asc')
        .execute(),
      (db as any).selectFrom('operator_vault_access as ova')
        .innerJoin('vault_entries', 'vault_entries.id', 'ova.vault_entry_id')
        .select(['ova.id', 'ova.vault_entry_id', 'vault_entries.title', 'vault_entries.type', 'ova.can_write', 'ova.granted_at', 'ova.expires_at'])
        .where('ova.operator_id', '=', id)
        .orderBy('vault_entries.title', 'asc')
        .execute(),
    ])
    return { server_grants: serverGrants, vault_grants: vaultGrants }
  })

  // PUT /users/:id/grants/servers — replace all server grants for an operator
  fastify.put('/users/:id/grants/servers', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { grants } = z.object({
      grants: z.array(z.object({
        server_id: z.string().uuid(),
        expires_at: z.string().datetime().optional(),
      })),
    }).parse(req.body)

    await (db as any).deleteFrom('operator_server_access').where('operator_id', '=', id).execute()
    if (grants.length > 0) {
      await (db as any).insertInto('operator_server_access').values(
        grants.map(g => ({
          operator_id: id,
          server_id: g.server_id,
          granted_by: req.session.user!.id,
          expires_at: g.expires_at ? new Date(g.expires_at) : null,
        }))
      ).execute()
    }

    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'operator.server_grants_updated', resource: 'user', resourceId: id, details: { count: grants.length }, request: req })
    return { ok: true, count: grants.length }
  })

  // PUT /users/:id/grants/vault — replace all vault grants for an operator
  fastify.put('/users/:id/grants/vault', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { grants } = z.object({
      grants: z.array(z.object({
        vault_entry_id: z.string().uuid(),
        can_write: z.boolean().default(false),
        expires_at: z.string().datetime().optional(),
      })),
    }).parse(req.body)

    await (db as any).deleteFrom('operator_vault_access').where('operator_id', '=', id).execute()
    if (grants.length > 0) {
      await (db as any).insertInto('operator_vault_access').values(
        grants.map(g => ({
          operator_id: id,
          vault_entry_id: g.vault_entry_id,
          can_write: g.can_write,
          granted_by: req.session.user!.id,
          expires_at: g.expires_at ? new Date(g.expires_at) : null,
        }))
      ).execute()
    }

    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'operator.vault_grants_updated', resource: 'user', resourceId: id, details: { count: grants.length }, request: req })
    return { ok: true, count: grants.length }
  })

  // GET /users/access-review
  fastify.get('/users/access-review', { preHandler: requireAdmin }, async (req) => {
    const users = await db.selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'provider', 'mfa_enabled', 'is_active', 'last_login_at', 'failed_login_attempts', 'locked_until', 'password_changed_at', 'created_at'])
      .orderBy('role').orderBy('email').execute()
    const now = new Date()
    const summary = {
      total: users.length,
      inactive: users.filter(u => !u.is_active).length,
      locked: users.filter(u => u.locked_until && new Date(u.locked_until) > now).length,
      mfa_disabled: users.filter(u => !u.mfa_enabled && u.is_active).length,
    }
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'users.access_review', resource: 'users', request: req })
    return { summary, users }
  })
}

export default usersRoutes
