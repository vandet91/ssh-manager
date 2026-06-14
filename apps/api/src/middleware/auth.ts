import { FastifyRequest, FastifyReply } from 'fastify'

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

const PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  operator: [
    'servers:read', 'servers:write',
    'keys:read', 'keys:write', 'keys:rotate',
    'assignments:read', 'assignments:write',
    'terminal:connect',
    'logs:read',
    'security:scan', 'security:read',
  ],
  developer: [
    'servers:read',
    'keys:read',
    'assignments:read',
    'terminal:connect',
    'logs:read',
  ],
  viewer: [
    'servers:read',
    'keys:read',
    'logs:read',
  ],
}

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.session.user
    if (!user) { reply.code(401).send({ error: 'Unauthorized' }); return }
    if (user.mfaPending) { reply.code(403).send({ error: 'MFA verification required' }); return }

    const perms = PERMISSIONS[user.role] ?? []
    if (perms.includes('*') || perms.includes(permission)) return

    reply.code(403).send({ error: 'Forbidden', required: permission })
  }
}
