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
            done(null, user)
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
            done(null, user)
          } catch (err) {
            done(err as Error)
          }
        },
      ),
    )
  }
}

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

  // Check bootstrap admin
  const bootstrapRole = data.email === config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() ? 'admin' : 'operator'

  const [inserted] = await db
    .insertInto('users')
    .values({
      email: data.email,
      display_name: data.displayName,
      provider: data.provider,
      provider_id: data.providerId,
      role: bootstrapRole,
      last_login_at: new Date(),
    })
    .returningAll()
    .execute()

  return inserted
}

export { passport }
