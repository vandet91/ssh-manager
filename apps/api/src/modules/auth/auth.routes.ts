import { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'

import speakeasy from 'speakeasy'
import QRCode from 'qrcode'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db } from '../../db/client'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { elevateSession } from '../../utils/totp-guard'
import { config } from '../../config'
import { getPasswordPolicy, validatePassword } from '../settings/settings.routes'

async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /auth/login â€” local username/password login
  fastify.post('/auth/login', async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }).parse(req.body)

    const user = await db.selectFrom('users').selectAll()
      .where('email', '=', body.email.toLowerCase())
      .where('provider', '=', 'local')
      .executeTakeFirst()

    if (!user || !user.password_hash) {
      await writeAuditLog({ userEmail: body.email, action: 'auth.login.failed', request: req })
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    if (!user.is_active) {
      return reply.code(403).send({ error: 'Account is disabled' })
    }

    // Check account lockout
    const policy = await getPasswordPolicy()
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const unlockAt = new Date(user.locked_until)
      const minsLeft = Math.ceil((unlockAt.getTime() - Date.now()) / 60000)
      return reply.code(423).send({ error: `Account locked. Try again in ${minsLeft} minute(s).` })
    }

    const valid = await bcrypt.compare(body.password, user.password_hash)
    if (!valid) {
      const attempts = (user.failed_login_attempts ?? 0) + 1
      const shouldLock = policy.max_login_attempts > 0 && attempts >= policy.max_login_attempts
      const lockedUntil = shouldLock
        ? new Date(Date.now() + policy.lockout_duration_minutes * 60 * 1000)
        : null

      await db.updateTable('users')
        .set({ failed_login_attempts: attempts, locked_until: lockedUntil, updated_at: new Date() })
        .where('id', '=', user.id).execute()

      await writeAuditLog({ userId: user.id, userEmail: user.email, action: 'auth.login.failed', request: req })

      if (shouldLock) {
        return reply.code(423).send({ error: `Too many failed attempts. Account locked for ${policy.lockout_duration_minutes} minute(s).` })
      }
      const remaining = policy.max_login_attempts > 0 ? policy.max_login_attempts - attempts : null
      return reply.code(401).send({
        error: remaining !== null
          ? `Invalid email or password. ${remaining} attempt(s) remaining.`
          : 'Invalid email or password',
      })
    }

    // Enforce password expiry before granting session
    if (policy.max_age_days > 0) {
      const changedAt = user.password_changed_at ? new Date(user.password_changed_at) : null
      const expiredAt = changedAt
        ? new Date(changedAt.getTime() + policy.max_age_days * 86400 * 1000)
        : new Date(0) // never set = treat as immediately expired
      if (new Date() > expiredAt) {
        await writeAuditLog({ userId: user.id, userEmail: user.email, action: 'auth.login.password_expired', request: req })
        return reply.code(403).send({ error: 'Password expired. Please contact an administrator to reset it.', code: 'PASSWORD_EXPIRED' })
      }
    }

    // Reset lockout on successful login
    await db.updateTable('users')
      .set({ failed_login_attempts: 0, locked_until: null, last_login_at: new Date(), updated_at: new Date() })
      .where('id', '=', user.id).execute()

    if (user.mfa_enabled) {
      req.session.mfaPending = true
      req.session.mfaUserId = user.id
      await writeAuditLog({ userId: user.id, userEmail: user.email, action: 'auth.login.mfa_required', request: req })
      return { mfaRequired: true }
    }

    req.session.user = { id: user.id, email: user.email, mfaEnabled: !!user.mfa_enabled, mfaPending: false }
    await writeAuditLog({ userId: user.id, userEmail: user.email, action: 'auth.login.success', request: req })
    return { ok: true, user: { id: user.id, email: user.email, mfa_enabled: !!user.mfa_enabled, is_active: !!user.is_active, display_name: user.display_name ?? null, last_login_at: user.last_login_at?.toISOString() ?? null, created_at: user.created_at?.toISOString() ?? new Date().toISOString() } }
  })

  // POST /auth/register â€” admin creates a local user
  fastify.post('/auth/register', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      displayName: z.string().optional(),
      password: z.string().min(1),
    }).parse(req.body)

    const policy = await getPasswordPolicy()
    const pwErr = validatePassword(body.password, policy)
    if (pwErr) return reply.code(400).send({ error: pwErr })

    const existing = await db.selectFrom('users').select('id')
      .where('email', '=', body.email.toLowerCase())
      .executeTakeFirst()
    if (existing) return reply.code(409).send({ error: 'Email already in use' })

    const passwordHash = await bcrypt.hash(body.password, 12)

    const [user] = await db.insertInto('users').values({
      email: body.email.toLowerCase(),
      display_name: body.displayName || null,
      provider: 'local',
      provider_id: null,
      password_hash: passwordHash,
      role: 'admin',
    }).returningAll().execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'user.created', resource: 'user', resourceId: user.id,
      details: { email: user.email, role: user.role }, request: req,
    })

    return { id: user.id, email: user.email, displayName: user.display_name, role: user.role }
  })

  // POST /auth/change-password â€” logged-in user changes own password
  fastify.post('/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(1),
    }).parse(req.body)

    const policy = await getPasswordPolicy()
    const pwErr = validatePassword(body.newPassword, policy)
    if (pwErr) return reply.code(400).send({ error: pwErr })

    const user = await db.selectFrom('users').selectAll().where('id', '=', req.session.user!.id).executeTakeFirst()
    if (!user || user.provider !== 'local') return reply.code(400).send({ error: 'Not a local account' })

    const valid = await bcrypt.compare(body.currentPassword, user.password_hash!)
    if (!valid) return reply.code(401).send({ error: 'Current password is incorrect' })

    const passwordHash = await bcrypt.hash(body.newPassword, 12)
    await db.updateTable('users')
      .set({ password_hash: passwordHash, password_changed_at: new Date(), updated_at: new Date() })
      .where('id', '=', user.id).execute()

    await writeAuditLog({ userId: user.id, userEmail: user.email, action: 'auth.password_changed', request: req })
    return { ok: true }
  })

  // POST /auth/admin/set-password â€” admin resets any local user password
  fastify.post('/auth/admin/set-password', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const body = z.object({
      user_id: z.string().uuid(),
      new_password: z.string().min(1),
    }).parse(req.body)

    const policy = await getPasswordPolicy()
    const pwErr = validatePassword(body.new_password, policy)
    if (pwErr) return reply.code(400).send({ error: pwErr })

    const user = await db.selectFrom('users').selectAll().where('id', '=', body.user_id).executeTakeFirst()
    if (!user) return reply.code(404).send({ error: 'User not found' })
    if (user.provider !== 'local') return reply.code(400).send({ error: 'Not a local account' })

    const passwordHash = await bcrypt.hash(body.new_password, 12)
    await db.updateTable('users')
      .set({ password_hash: passwordHash, password_changed_at: new Date(), failed_login_attempts: 0, locked_until: null, updated_at: new Date() })
      .where('id', '=', body.user_id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'auth.admin.password_reset', resource: 'user', resourceId: body.user_id, request: req,
    })
    return { ok: true }
  })

  // GET /auth/me
  fastify.get('/auth/me', async (req, reply) => {
    if (!req.session.user) return reply.code(401).send({ error: 'Unauthorized' })
    const u = req.session.user
    return {
      id: u.id,
      email: u.email,
      mfa_enabled: u.mfaEnabled,
      is_active: true,
      display_name: null,
      last_login_at: null,
      created_at: new Date().toISOString(),
    }
  })

  // GET /auth/me/permissions
  fastify.get('/auth/me/permissions', async (req, reply) => {
    if (!req.session.user) return reply.code(401).send({ error: 'Unauthorized' })
    return { isAdmin: true }
  })

  // POST /auth/logout
  fastify.post('/auth/logout', async (req, reply) => {
    await req.session.destroy()
    return reply.send({ ok: true })
  })

  // POST /auth/mfa/setup â€” generate TOTP secret
  fastify.post('/auth/mfa/setup', async (req, reply) => {
    if (!req.session.user) return reply.code(401).send({ error: 'Unauthorized' })
    const secret = speakeasy.generateSecret({ name: `${config.MFA_ISSUER} (${req.session.user.email})`, length: 32 })
    const otpauthUrl = secret.otpauth_url!
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl)

    // Store secret encrypted temporarily (not enabled yet â€” enabled after verify)
    const vaultKey = getVaultKey()
    const encSecret = encryptSecret(secret.base32, vaultKey)

    await db.updateTable('users')
      .set({ mfa_secret: encSecret, updated_at: new Date() })
      .where('id', '=', req.session.user.id)
      .execute()

    return { qrDataUrl, secret: secret.base32 }
  })

  // POST /auth/mfa/verify â€” verify and enable MFA
  fastify.post('/auth/mfa/verify', async (req, reply) => {
    if (!req.session.user) return reply.code(401).send({ error: 'Unauthorized' })

    const body = z.object({ token: z.string().length(6) }).parse(req.body)
    const user = await db.selectFrom('users').selectAll().where('id', '=', req.session.user.id).executeTakeFirst()
    if (!user?.mfa_secret) return reply.code(400).send({ error: 'MFA setup not initiated' })

    const vaultKey = getVaultKey()
    const plainSecret = decryptSecret(user.mfa_secret, vaultKey)

    const valid = speakeasy.totp.verify({ secret: plainSecret, encoding: 'base32', token: body.token, window: 1 })
    if (!valid) return reply.code(400).send({ error: 'Invalid MFA token' })

    // Generate backup codes
    const backupCodes = Array.from({ length: 8 }, () =>
      randomBytes(4).toString('hex').toUpperCase()
    )
    const encBackups = JSON.stringify(backupCodes.map((c) => encryptSecret(c, vaultKey)))

    await db.updateTable('users')
      .set({ mfa_enabled: true, mfa_backup_codes: encBackups, updated_at: new Date() })
      .where('id', '=', req.session.user.id)
      .execute()

    req.session.user.mfaEnabled = true
    req.session.user.mfaPending = false
    await req.session.save()

    return { backupCodes }
  })

  // POST /auth/mfa/validate â€” second factor during login
  fastify.post('/auth/mfa/validate', async (req, reply) => {
    if (!req.session.mfaPending || !req.session.mfaUserId) {
      return reply.code(400).send({ error: 'No MFA session pending' })
    }

    const body = z.object({ token: z.string() }).parse(req.body)
    const user = await db.selectFrom('users').selectAll().where('id', '=', req.session.mfaUserId).executeTakeFirst()
    if (!user) return reply.code(404).send({ error: 'User not found' })

    const vaultKey = getVaultKey()

    // Try TOTP
    const plainSecret = decryptSecret(user.mfa_secret!, vaultKey)
    const validTotp = speakeasy.totp.verify({ secret: plainSecret, encoding: 'base32', token: body.token, window: 1 })

    // Try backup codes
    let validBackup = false
    if (!validTotp) {
      const encBackups: string[] = JSON.parse(user.mfa_backup_codes as string || '[]')
      for (let i = 0; i < encBackups.length; i++) {
        try {
          const decoded = decryptSecret(encBackups[i], vaultKey)
          if (decoded.toUpperCase() === body.token.toUpperCase()) {
            validBackup = true
            encBackups.splice(i, 1)
            await db.updateTable('users')
              .set({ mfa_backup_codes: JSON.stringify(encBackups), updated_at: new Date() })
              .where('id', '=', user.id)
              .execute()
            break
          }
        } catch { /* skip invalid */ }
      }
    }

    if (!validTotp && !validBackup) {
      await writeAuditLog({ userId: user.id, userEmail: user.email, action: 'mfa.validate.failed', request: req })
      return reply.code(401).send({ error: 'Invalid MFA token' })
    }

    req.session.user = {
      id: user.id,
      email: user.email,
      mfaEnabled: !!user.mfa_enabled,
      mfaPending: false,
    }
    req.session.mfaPending = false
    req.session.mfaUserId = undefined

    await writeAuditLog({ userId: user.id, userEmail: user.email, action: 'mfa.validate.success', request: req })
    return { ok: true, user: { id: user.id, email: user.email, role: user.role, mfa_enabled: !!user.mfa_enabled, mfa_exempt: !!user.mfa_exempt, is_active: !!user.is_active, display_name: user.display_name ?? null, last_login_at: user.last_login_at?.toISOString() ?? null, created_at: user.created_at?.toISOString() ?? new Date().toISOString() } }
  })

  // POST /auth/totp/elevate â€” verify TOTP code and elevate session for critical actions
  fastify.post('/auth/totp/elevate', { preHandler: [requireAuth] }, async (req, reply) => {
    const { token } = req.body as { token: string }
    if (!token) return reply.code(400).send({ error: 'token required' })

    const user = await db.selectFrom('users')
      .select(['mfa_secret', 'mfa_enabled'])
      .where('id', '=', req.session.user!.id)
      .executeTakeFirst()

    if (!user?.mfa_enabled || !user.mfa_secret) {
      return reply.code(400).send({ error: 'MFA not enabled on this account' })
    }

    const vaultKey = getVaultKey()
    const plainSecret = decryptSecret(user.mfa_secret, vaultKey)

    // Prevent replay â€” reject code if it was the last accepted one
    const codeHash = require('crypto').createHash('sha256').update(token).digest('hex')
    if (req.session.totpLastCode === codeHash) {
      return reply.code(400).send({ error: 'TOTP code already used' })
    }

    const valid = speakeasy.totp.verify({ secret: plainSecret, encoding: 'base32', token, window: 1 })
    if (!valid) {
      await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'totp.elevate.failed', request: req })
      return reply.code(400).send({ error: 'Invalid TOTP code' })
    }

    req.session.totpLastCode = codeHash
    await elevateSession(req)
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'totp.elevate.success', request: req })
    return { ok: true, elevatedUntil: req.session.totpElevatedUntil }
  })

  // GET /auth/totp/elevation-status â€” check if session is currently elevated
  fastify.get('/auth/totp/elevation-status', { preHandler: [requireAuth] }, async (req) => {
    const until = req.session.totpElevatedUntil
    const elevated = typeof until === 'number' && until > Date.now()
    return { elevated, elevatedUntil: elevated ? until : null }
  })

  // GET /auth/mfa/backup-codes
  fastify.get('/auth/mfa/backup-codes', async (req, reply) => {
    if (!req.session.user) return reply.code(401).send({ error: 'Unauthorized' })
    const user = await db.selectFrom('users').select(['mfa_backup_codes']).where('id', '=', req.session.user.id).executeTakeFirst()
    const vaultKey = getVaultKey()
    const encBackups: string[] = JSON.parse((user?.mfa_backup_codes as string) || '[]')
    const codes = encBackups.map((c) => { try { return decryptSecret(c, vaultKey) } catch { return '(invalid)' } })
    return { backupCodes: codes }
  })
}

export default authRoutes

