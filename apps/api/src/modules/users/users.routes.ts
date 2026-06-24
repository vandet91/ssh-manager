import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission, invalidatePermCache } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'

const ALL_PERMISSIONS = [
  'servers:read', 'servers:write', 'servers:admin',
  'keys:read', 'keys:write', 'keys:rotate',
  'assignments:read', 'assignments:write',
  'terminal:connect',
  'logs:read',
  'security:read', 'security:scan',
] as const

async function usersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /users/me
  fastify.get('/users/me', async (req) => {
    const user = await db.selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'mfa_enabled', 'is_active', 'last_login_at', 'created_at'])
      .where('id', '=', req.session.user!.id)
      .executeTakeFirst()
    return user
  })

  // GET /users
  fastify.get('/users', { preHandler: requirePermission('admin') }, async (req) => {
    const query = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().default(50) }).parse(req.query)
    const offset = (query.page - 1) * query.limit
    const [users, countRow] = await Promise.all([
      db.selectFrom('users')
        .select(['id', 'email', 'display_name', 'role', 'provider', 'mfa_enabled', 'is_active', 'last_login_at', 'created_at'])
        .limit(query.limit).offset(offset)
        .execute(),
      db.selectFrom('users').select(db.fn.countAll().as('count')).executeTakeFirst(),
    ])
    return { users, total: Number(countRow?.count ?? 0), page: query.page, limit: query.limit }
  })

  // GET /users/:id
  fastify.get('/users/:id', { preHandler: requirePermission('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const user = await db.selectFrom('users')
      .select(['id', 'email', 'display_name', 'role', 'provider', 'mfa_enabled', 'is_active', 'last_login_at', 'created_at'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!user) return reply.code(404).send({ error: 'User not found' })
    return user
  })

  // PATCH /users/:id
  fastify.patch('/users/:id', { preHandler: requirePermission('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    // Prevent admins from changing their own role or deactivating themselves
    if (id === req.session.user!.id) {
      return reply.code(403).send({ error: 'You cannot change your own role or account status. Ask another admin.' })
    }

    const body = z.object({
      role: z.enum(['admin', 'operator', 'developer', 'viewer']).optional(),
      is_active: z.boolean().optional(),
    }).parse(req.body)

    const user = await db.updateTable('users')
      .set({ ...body, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()

    if (!user) return reply.code(404).send({ error: 'User not found' })

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'user.updated', resource: 'user', resourceId: id,
      details: body, request: req,
    })
    return user
  })

  // DELETE /users/:id (deactivate)
  fastify.delete('/users/:id', { preHandler: requirePermission('admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    // Prevent admins from deactivating themselves
    if (id === req.session.user!.id) {
      return reply.code(403).send({ error: 'You cannot deactivate your own account. Ask another admin.' })
    }

    await db.updateTable('users').set({ is_active: false, updated_at: new Date() }).where('id', '=', id).execute()
    await db.updateTable('key_assignments').set({ is_active: false }).where('user_id', '=', id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'user.deactivated', resource: 'user', resourceId: id, request: req,
    })
    reply.code(204).send()
  })

  // GET /users/:id/assignments
  fastify.get('/users/:id/assignments', { preHandler: requirePermission('admin') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return db.selectFrom('key_assignments')
      .selectAll()
      .where('user_id', '=', id)
      .execute()
  })

  // GET /users/role-permissions — get all role→permission mappings
  fastify.get('/users/role-permissions', { preHandler: requirePermission('admin') }, async () => {
    const rows = await (db as any).selectFrom('role_permissions').select(['role', 'permission']).execute() as { role: string; permission: string }[]
    const result: Record<string, string[]> = { operator: [], developer: [], viewer: [] }
    for (const r of rows) {
      if (result[r.role]) result[r.role].push(r.permission)
    }
    return { permissions: result, all_permissions: ALL_PERMISSIONS }
  })

  // PUT /users/role-permissions/:role — replace all permissions for a role
  fastify.put('/users/role-permissions/:role', { preHandler: requirePermission('admin') }, async (req, reply) => {
    const { role } = z.object({ role: z.enum(['operator', 'developer', 'viewer']) }).parse(req.params)
    const { permissions } = z.object({ permissions: z.array(z.string()) }).parse(req.body)

    const valid = permissions.filter((p) => (ALL_PERMISSIONS as readonly string[]).includes(p))

    await (db as any).deleteFrom('role_permissions').where('role', '=', role).execute()
    if (valid.length > 0) {
      await (db as any).insertInto('role_permissions')
        .values(valid.map((permission) => ({ role, permission })))
        .execute()
    }

    invalidatePermCache()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'role_permissions.updated', resource: 'role_permissions', resourceId: role,
      details: { role, permissions: valid }, request: req,
    })

    return { role, permissions: valid }
  })

  // GET /users/access-review — periodic access review (who has what role, lockout status)
  fastify.get('/users/access-review', { preHandler: requirePermission('admin') }, async (req) => {
    const users = await db.selectFrom('users')
      .select([
        'id', 'email', 'display_name', 'role', 'provider',
        'mfa_enabled', 'is_active', 'last_login_at',
        'failed_login_attempts', 'locked_until', 'password_changed_at',
        'created_at',
      ])
      .orderBy('role').orderBy('email')
      .execute()

    const now = new Date()

    const summary = {
      total: users.length,
      by_role: {
        admin:     users.filter((u) => u.role === 'admin').length,
        operator:  users.filter((u) => u.role === 'operator').length,
        developer: users.filter((u) => u.role === 'developer').length,
        viewer:    users.filter((u) => u.role === 'viewer').length,
      },
      inactive:       users.filter((u) => !u.is_active).length,
      locked:         users.filter((u) => u.locked_until && new Date(u.locked_until) > now).length,
      mfa_disabled:   users.filter((u) => !u.mfa_enabled && u.is_active).length,
      never_logged_in: users.filter((u) => !u.last_login_at && u.is_active).length,
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'users.access_review', resource: 'users', request: req,
    })

    return { summary, users }
  })
}

export default usersRoutes
