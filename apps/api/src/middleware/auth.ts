import { FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db/client'

export interface SessionUser {
  id: string
  email: string
  role: 'admin' | 'operator' | 'developer' | 'viewer'
  mfaEnabled: boolean
  mfaPending?: boolean
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    user?: SessionUser
    mfaPending?: boolean
    mfaUserId?: string
    totpElevatedUntil?: number   // epoch ms — set after TOTP elevation
    totpLastCode?: string        // last accepted code hash — prevents replay
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.session.user) {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }
  if (request.session.user.mfaPending) {
    reply.code(403).send({ error: 'MFA verification required' })
    return
  }
}

// Cache: role → Set<permission>, refreshed every 60s
let permCache: Record<string, Set<string>> = {}
let permCacheAt = 0

const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  operator: [
    'servers:read', 'servers:write',
    'keys:read', 'keys:write', 'keys:rotate',
    'assignments:read', 'assignments:write',
    'terminal:connect', 'logs:read',
    'security:scan', 'security:read',
  ],
  developer: ['servers:read', 'keys:read', 'assignments:read', 'terminal:connect', 'logs:read'],
  viewer: ['servers:read', 'keys:read', 'logs:read'],
}

export async function getPermissions(role: string): Promise<Set<string>> {
  if (role === 'admin') return new Set(['*'])

  const now = Date.now()
  if (now - permCacheAt > 60_000) {
    try {
      const rows = await (db as any).selectFrom('role_permissions').select(['role', 'permission']).execute() as { role: string; permission: string }[]
      const fresh: Record<string, Set<string>> = {}
      for (const r of rows) {
        if (!fresh[r.role]) fresh[r.role] = new Set()
        fresh[r.role].add(r.permission)
      }
      permCache = fresh
      permCacheAt = now
    } catch {
      // DB not ready yet (e.g. during migration) — fall back to defaults
      if (!permCache[role]) {
        const defaults: Record<string, Set<string>> = {}
        for (const [r, ps] of Object.entries(DEFAULT_PERMISSIONS)) {
          defaults[r] = new Set(ps)
        }
        return defaults[role] ?? new Set()
      }
    }
  }

  return permCache[role] ?? new Set()
}

export function invalidatePermCache() {
  permCacheAt = 0
}

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.session.user
    if (!user) { reply.code(401).send({ error: 'Unauthorized' }); return }
    if (user.mfaPending) { reply.code(403).send({ error: 'MFA verification required' }); return }

    if (user.role === 'admin') return

    const perms = await getPermissions(user.role)
    if (perms.has('*') || perms.has(permission)) return

    reply.code(403).send({ error: 'Forbidden', required: permission })
  }
}
