import { FastifyRequest, FastifyReply } from 'fastify'

export interface SessionUser {
  id: string
  email: string
  mfaEnabled: boolean
  mfaPending?: boolean
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    user?: SessionUser
    mfaPending?: boolean
    mfaUserId?: string
    totpElevatedUntil?: number
    totpLastCode?: string
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = request.session.user
  if (!user) { reply.code(401).send({ error: 'Unauthorized' }); return }
  if (user.mfaPending) { reply.code(403).send({ error: 'MFA verification required' }); return }
}

// requireAdmin is an alias — all authenticated users are admins for now
export const requireAdmin = requireAuth

export function invalidatePermCache() { /* no-op */ }
export async function getPermissions(_role: string): Promise<Set<string>> { return new Set() }
