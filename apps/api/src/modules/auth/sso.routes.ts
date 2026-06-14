import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

import { passport } from './passport'
import { writeAuditLog } from '../../utils/audit'
import { config } from '../../config'

async function ssoRoutes(fastify: FastifyInstance): Promise<void> {
  // Microsoft SSO
  fastify.get('/auth/microsoft', (req: FastifyRequest, reply: FastifyReply) => {
    passport.authenticate('microsoft')(req.raw, reply.raw, () => {})
  })

  fastify.get('/auth/microsoft/callback', async (req: FastifyRequest, reply: FastifyReply) => {
    return new Promise<void>((resolve) => {
      passport.authenticate('microsoft', async (err: Error, user: Record<string, unknown>) => {
        if (err || !user) {
          await writeAuditLog({ action: 'auth.login.failed', details: { provider: 'microsoft', error: err?.message }, request: req })
          reply.redirect(`${config.FRONTEND_URL}/login?error=auth_failed`)
          return resolve()
        }
        await handleSsoCallback(req, reply, user)
        resolve()
      })(req.raw, reply.raw, () => {})
    })
  })

  // Google SSO
  fastify.get('/auth/google', (req: FastifyRequest, reply: FastifyReply) => {
    passport.authenticate('google')(req.raw, reply.raw, () => {})
  })

  fastify.get('/auth/google/callback', async (req: FastifyRequest, reply: FastifyReply) => {
    return new Promise<void>((resolve) => {
      passport.authenticate('google', async (err: Error, user: Record<string, unknown>) => {
        if (err || !user) {
          await writeAuditLog({ action: 'auth.login.failed', details: { provider: 'google', error: err?.message }, request: req })
          reply.redirect(`${config.FRONTEND_URL}/login?error=auth_failed`)
          return resolve()
        }
        await handleSsoCallback(req, reply, user)
        resolve()
      })(req.raw, reply.raw, () => {})
    })
  })
}

async function handleSsoCallback(req: FastifyRequest, reply: FastifyReply, user: Record<string, unknown>): Promise<void> {
  const dbUser = user as {
    id: string; email: string; role: 'admin' | 'operator' | 'developer' | 'viewer'
    mfa_enabled: boolean
  }

  if (dbUser.mfa_enabled) {
    req.session.mfaPending = true
    req.session.mfaUserId = dbUser.id
    await writeAuditLog({ userId: dbUser.id, userEmail: dbUser.email, action: 'auth.login.mfa_required', request: req })
    reply.redirect(`${config.FRONTEND_URL}/login?mfa=required`)
    return
  }

  req.session.user = {
    id: dbUser.id,
    email: dbUser.email,
    role: dbUser.role,
    mfaEnabled: dbUser.mfa_enabled,
    mfaPending: false,
  }

  await writeAuditLog({ userId: dbUser.id, userEmail: dbUser.email, action: 'auth.login.success', request: req })
  reply.redirect(`${config.FRONTEND_URL}/dashboard`)
}

export default ssoRoutes
