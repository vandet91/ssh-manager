import passport from 'passport'
import { Strategy as OidcStrategy, Profile, VerifyCallback } from 'passport-openidconnect'
import { db } from '../../db/client'
import { config } from '../../config'
import { writeAuditLog } from '../../utils/audit'

export function setupPassport(): void {
  passport.serializeUser((user: Express.User, done) => done(null, user))
  passport.deserializeUser((user: Express.User, done) => done(null, user))

  // Microsoft 365
  if (config.MS_CLIENT_ID && config.MS_CLIENT_SECRET && config.MS_TENANT_ID) {
    passport.use(
      'microsoft',
      new OidcStrategy(
        {
          issuer: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/v2.0`,
          authorizationURL: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/oauth2/v2.0/authorize`,
          tokenURL: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/oauth2/v2.0/token`,
          userInfoURL: 'https://graph.microsoft.com/oidc/userinfo',
          clientID: config.MS_CLIENT_ID,
          clientSecret: config.MS_CLIENT_SECRET,
          callbackURL: config.MS_CALLBACK_URL!,
          scope: ['openid', 'profile', 'email'],
        },
        async (_issuer: string, profile: Profile, done: VerifyCallback) => {
          try {
            const email = (profile.emails?.[0]?.value ?? '').toLowerCase()
            if (!email) return done(new Error('No email in profile'))

            const user = await upsertUser({
              email,
              displayName: profile.displayName ?? email,
              provider: 'microsoft',
              providerId: profile.id,
            })
            done(null, user ?? false)
          } catch (err) {
            done(err as Error)
          }
        },
      ),
    )
  }

  // Google Workspace
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    passport.use(
      'google',
      new OidcStrategy(
        {
          issuer: 'https://accounts.google.com',
          authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenURL: 'https://oauth2.googleapis.com/token',
          userInfoURL: 'https://openidconnect.googleapis.com/v1/userinfo',
          clientID: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          callbackURL: config.GOOGLE_CALLBACK_URL!,
          scope: ['openid', 'profile', 'email'],
        },
        async (_issuer: string, profile: Profile, done: VerifyCallback) => {
          try {
            const email = (profile.emails?.[0]?.value ?? '').toLowerCase()
            if (!email) return done(new Error('No email in profile'))

            if (config.GOOGLE_HOSTED_DOMAIN && !email.endsWith('@' + config.GOOGLE_HOSTED_DOMAIN)) {
              return done(null, false)
            }

            const user = await upsertUser({
              email,
              displayName: profile.displayName ?? email,
              provider: 'google',
              providerId: profile.id,
            })
            done(null, user ?? false)
          } catch (err) {
            done(err as Error)
          }
        },
      ),
    )
  }
}

// Accounts are provisioned by an admin (Users page → Create User) beforehand.
// SSO login only ever links to and updates an existing row by provider+providerId
// or by email — it never creates a new user. Returns null when no matching
// account exists, which the caller (passport verify callback) treats as a
// failed login via done(null, false).
async function upsertUser(data: {
  email: string
  displayName: string
  provider: 'microsoft' | 'google'
  providerId: string | null
}) {
  const existing = await db
    .selectFrom('users')
    .selectAll()
    .where('provider', '=', data.provider)
    .where('provider_id', '=', data.providerId)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('users')
      .set({
        display_name: data.displayName,
        last_login_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .execute()
    return { ...existing, display_name: data.displayName }
  }

  // Also check by email — links an admin-provisioned account (created with
  // just email/role, provider left null) to its SSO identity on first login.
  const byEmail = await db.selectFrom('users').selectAll().where('email', '=', data.email).executeTakeFirst()
  if (byEmail) {
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

export { passport }
