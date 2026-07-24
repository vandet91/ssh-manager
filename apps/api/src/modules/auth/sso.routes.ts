import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import * as crypto from 'crypto'
import { db } from '../../db/client'
import { writeAuditLog } from '../../utils/audit'
import { config } from '../../config'

// ── Shared session finalization ───────────────────────────────────────────────

async function finalizeLogin(req: FastifyRequest, reply: FastifyReply, dbUser: {
  id: string; email: string; role: string; mfa_enabled: boolean
}): Promise<void> {
  if (dbUser.mfa_enabled) {
    req.session.mfaPending = true
    req.session.mfaUserId = dbUser.id
    await writeAuditLog({ userId: dbUser.id, userEmail: dbUser.email, action: 'auth.login.mfa_required', request: req })
    await req.session.save()
    reply.redirect(`${config.FRONTEND_URL}/login?mfa=required`)
    return
  }

  req.session.user = {
    id: dbUser.id,
    email: dbUser.email,
    mfaEnabled: !!dbUser.mfa_enabled,
    mfaPending: false,
  }
  await writeAuditLog({ userId: dbUser.id, userEmail: dbUser.email, action: 'auth.login.success', request: req })
  await req.session.save()
  reply.redirect(`${config.FRONTEND_URL}/dashboard`)
}

// Accounts are provisioned by an admin (Users page → Create User) beforehand.
// SSO login only ever links to and updates an existing row by provider+providerId
// or by email — it never creates a new user. Returns null when no matching
// account exists, which the caller treats as a login failure.
async function upsertSsoUser(data: {
  email: string; displayName: string; provider: 'google' | 'microsoft'; providerId: string
}) {
  const existing = await db.selectFrom('users').selectAll()
    .where('provider', '=', data.provider)
    .where('provider_id', '=', data.providerId)
    .executeTakeFirst()

  if (existing) {
    await db.updateTable('users').set({ display_name: data.displayName, last_login_at: new Date(), updated_at: new Date() })
      .where('id', '=', existing.id).execute()
    return { ...existing, display_name: data.displayName }
  }

  // Also check by email — this is how an admin-provisioned account (created
  // with just email/role, provider left null) gets linked to its SSO identity
  // on first login.
  const byEmail = await db.selectFrom('users').selectAll().where('email', '=', data.email).executeTakeFirst()
  if (byEmail) {
    // Only set provider/provider_id if account has no password (pure SSO bootstrap)
    const updates: Record<string, unknown> = { display_name: data.displayName, last_login_at: new Date(), updated_at: new Date() }
    if (!byEmail.password_hash) {
      updates.provider = data.provider
      updates.provider_id = data.providerId
    }
    await db.updateTable('users').set(updates as any).where('id', '=', byEmail.id).execute()
    return { ...byEmail, ...updates }
  }

  return null
}

// ── Google OAuth2 (direct, no passport) ──────────────────────────────────────

async function googleRoutes(fastify: FastifyInstance): Promise<void> {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return

  fastify.get('/auth/google', async (req: FastifyRequest, reply: FastifyReply) => {
    const state = crypto.randomBytes(16).toString('hex')
    req.session.set('oauthState', state)
    await req.session.save()

    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!,
      redirect_uri: config.GOOGLE_CALLBACK_URL!,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      ...(config.GOOGLE_HOSTED_DOMAIN ? { hd: config.GOOGLE_HOSTED_DOMAIN } : {}),
    })
    reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  })

  fastify.get('/auth/google/callback', async (req: FastifyRequest, reply: FastifyReply) => {
    const { code, state, error } = req.query as Record<string, string>

    if (error) {
      reply.redirect(`${config.FRONTEND_URL}/login?error=auth_failed`)
      return
    }

    const savedState = req.session.get('oauthState') as string | undefined
    if (!state || state !== savedState) {
      reply.redirect(`${config.FRONTEND_URL}/login?error=state_mismatch`)
      return
    }

    try {
      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.GOOGLE_CLIENT_ID!,
          client_secret: config.GOOGLE_CLIENT_SECRET!,
          redirect_uri: config.GOOGLE_CALLBACK_URL!,
          grant_type: 'authorization_code',
        }),
      })
      const tokens = await tokenRes.json() as { access_token?: string; error?: string }
      if (!tokens.access_token) throw new Error(tokens.error ?? 'No access token')

      // Fetch user info
      const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const profile = await userRes.json() as { sub: string; email: string; name: string; hd?: string }

      if (!profile.email) throw new Error('No email in profile')

      // Enforce hosted domain
      if (config.GOOGLE_HOSTED_DOMAIN) {
        const hd = profile.hd ?? profile.email.split('@')[1]
        if (hd !== config.GOOGLE_HOSTED_DOMAIN) {
          await writeAuditLog({ action: 'auth.login.failed', details: { provider: 'google', reason: 'wrong_domain', email: profile.email }, request: req })
          reply.redirect(`${config.FRONTEND_URL}/login?error=wrong_domain`)
          return
        }
      }

      const dbUser = await upsertSsoUser({
        email: profile.email.toLowerCase(),
        displayName: profile.name ?? profile.email,
        provider: 'google',
        providerId: profile.sub,
      })

      if (!dbUser) {
        await writeAuditLog({ action: 'auth.login.failed', details: { provider: 'google', reason: 'no_account', email: profile.email }, request: req })
        reply.redirect(`${config.FRONTEND_URL}/login?error=no_account`)
        return
      }

      await finalizeLogin(req, reply, dbUser as any)
    } catch (err: any) {
      await writeAuditLog({ action: 'auth.login.failed', details: { provider: 'google', error: err.message }, request: req })
      reply.redirect(`${config.FRONTEND_URL}/login?error=auth_failed`)
    }
  })
}

// ── Microsoft SSO (passport-based, kept as-is) ────────────────────────────────
// TODO: migrate to direct OAuth like Google above if passport issues arise

import { passport } from './passport'

async function microsoftRoutes(fastify: FastifyInstance): Promise<void> {
  if (!config.MS_CLIENT_ID || !config.MS_CLIENT_SECRET || !config.MS_TENANT_ID) return

  fastify.get('/auth/microsoft', (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack()
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
        const dbUser = user as any
        await finalizeLogin(req, reply, dbUser)
        resolve()
      })(req.raw, reply.raw, () => {})
    })
  })
}

// ── Register all SSO routes ───────────────────────────────────────────────────

async function ssoRoutes(fastify: FastifyInstance): Promise<void> {
  await googleRoutes(fastify)
  await microsoftRoutes(fastify)
}

export default ssoRoutes
