import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'

export const passwordPolicySchema = z.object({
  min_length: z.number().int().min(6).max(128),
  require_uppercase: z.boolean(),
  require_lowercase: z.boolean(),
  require_numbers: z.boolean(),
  require_special: z.boolean(),
  max_repeat: z.number().int().min(0).max(10),            // 0 = no limit; max consecutive identical chars
  max_age_days: z.number().int().min(0).max(3650),        // 0 = never expire
  max_login_attempts: z.number().int().min(0).max(100),   // 0 = no lockout
  lockout_duration_minutes: z.number().int().min(1).max(1440),
})

export type PasswordPolicy = z.infer<typeof passwordPolicySchema>

export const DEFAULT_POLICY: PasswordPolicy = {
  min_length: 8,
  require_uppercase: false,
  require_lowercase: false,
  require_numbers: false,
  require_special: false,
  max_repeat: 0,
  max_age_days: 0,
  max_login_attempts: 5,
  lockout_duration_minutes: 30,
}

export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  try {
    const row = await db.selectFrom('settings' as any)
      .selectAll()
      .where('key' as any, '=', 'password_policy')
      .executeTakeFirst() as any
    if (!row) return DEFAULT_POLICY
    return passwordPolicySchema.parse(row.value)
  } catch {
    return DEFAULT_POLICY
  }
}

export function validatePassword(password: string, policy: PasswordPolicy): string | null {
  if (password.length < policy.min_length)
    return `Password must be at least ${policy.min_length} characters`
  if (policy.require_uppercase && !/[A-Z]/.test(password))
    return 'Password must contain at least one uppercase letter'
  if (policy.require_lowercase && !/[a-z]/.test(password))
    return 'Password must contain at least one lowercase letter'
  if (policy.require_numbers && !/[0-9]/.test(password))
    return 'Password must contain at least one number'
  if (policy.require_special && !/[^A-Za-z0-9]/.test(password))
    return 'Password must contain at least one special character'
  if (policy.max_repeat > 0) {
    const pattern = new RegExp(`(.)\\1{${policy.max_repeat},}`)
    if (pattern.test(password))
      return `Password must not contain more than ${policy.max_repeat} consecutive identical characters`
  }
  return null
}

async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /settings/password-policy
  fastify.get('/settings/password-policy', { preHandler: [requireAuth, requirePermission('admin')] }, async () => {
    return getPasswordPolicy()
  })

  // PUT /settings/password-policy
  fastify.put('/settings/password-policy', { preHandler: [requireAuth, requirePermission('admin')] }, async (req, reply) => {
    const body = passwordPolicySchema.parse(req.body)

    await (db as any)
      .insertInto('settings')
      .values({ key: 'password_policy', value: JSON.stringify(body), updated_at: new Date() })
      .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: JSON.stringify(body), updated_at: new Date() }))
      .execute()

    await writeAuditLog({
      userId: req.session.user!.id,
      userEmail: req.session.user!.email,
      action: 'settings.password_policy.updated',
      resource: 'settings',
      details: body,
      request: req,
    })

    return body
  })

  // ── Telegram Settings ───────────────────────────────────────────────────────

  const telegramSchema = z.object({
    enabled: z.boolean(),
    bot_token: z.string(),
    allowed_chats: z.array(z.number().int()),
    totp_secret: z.string(),
  })

  // GET /settings/telegram
  fastify.get('/settings/telegram', { preHandler: [requireAuth, requirePermission('admin')] }, async () => {
    const rows = (await (db as any).selectFrom('settings').selectAll()
      .where('key', 'in', ['telegram_enabled','telegram_bot_token','telegram_allowed_chats','telegram_totp_secret'])
      .execute()) as Array<{ key: string; value: unknown }>
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return {
      enabled:       !!(m['telegram_enabled'] ?? false),
      bot_token:     (m['telegram_bot_token'] as string) ?? '',
      allowed_chats: (m['telegram_allowed_chats'] as number[]) ?? [],
      totp_secret:   (m['telegram_totp_secret'] as string) ?? '',
    }
  })

  // PUT /settings/telegram
  fastify.put('/settings/telegram', { preHandler: [requireAuth, requirePermission('admin')] }, async (req, reply) => {
    const body = telegramSchema.parse(req.body)
    const upsert = async (key: string, value: unknown) => {
      await (db as any)
        .insertInto('settings')
        .values({ key, value: JSON.stringify(value), updated_at: new Date() })
        .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }))
        .execute()
    }
    await upsert('telegram_enabled',       body.enabled)
    await upsert('telegram_bot_token',     body.bot_token)
    await upsert('telegram_allowed_chats', body.allowed_chats)
    await upsert('telegram_totp_secret',   body.totp_secret)

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'settings.telegram.updated', resource: 'settings',
      details: { enabled: body.enabled, has_token: !!body.bot_token, chat_count: body.allowed_chats.length },
      request: req,
    })
    return { ok: true }
  })

  // POST /settings/telegram/generate-totp — generate a new TOTP secret for the bot
  fastify.post('/settings/telegram/generate-totp', { preHandler: [requireAuth, requirePermission('admin')] }, async () => {
    const speakeasy = await import('speakeasy')
    const secret = speakeasy.generateSecret({ name: 'SSH Manager Bot', length: 20 })
    return {
      secret: secret.base32,
      otpauth_url: secret.otpauth_url,
    }
  })

  // ── Alert Settings ──────────────────────────────────────────────────────────

  const alertEventsSchema = z.object({
    rotation_failed:   z.boolean(),
    rotation_success:  z.boolean(),
    security_critical: z.boolean(),
    security_high:     z.boolean(),
    key_expiring:      z.boolean(),
    login_failed:      z.boolean(),
    new_login:         z.boolean(),
    server_unreachable: z.boolean(),
    key_revoked:       z.boolean(),
    user_deactivated:  z.boolean(),
  })

  const alertSettingsSchema = z.object({
    webhook_enabled:    z.boolean(),
    webhook_url:        z.string(),
    email_enabled:      z.boolean(),
    smtp_host:          z.string(),
    smtp_port:          z.number().int().min(1).max(65535),
    smtp_secure:        z.boolean(),
    smtp_user:          z.string(),
    smtp_pass:          z.string(),
    smtp_from:          z.string(),
    email_recipients:   z.array(z.string().email()),
    telegram_enabled:   z.boolean(),
    telegram_chat_id:   z.number().int(),
    events:             alertEventsSchema,
  })

  // GET /settings/alerts
  fastify.get('/settings/alerts', { preHandler: [requireAuth, requirePermission('admin')] }, async () => {
    const keys = [
      'alert_webhook_enabled', 'alert_webhook_url',
      'alert_email_enabled', 'alert_smtp_host', 'alert_smtp_port', 'alert_smtp_secure',
      'alert_smtp_user', 'alert_smtp_pass', 'alert_smtp_from', 'alert_email_recipients',
      'alert_telegram_enabled', 'alert_telegram_chat_id', 'alert_events',
    ]
    const rows = (await (db as any).selectFrom('settings').selectAll().where('key', 'in', keys).execute()) as Array<{ key: string; value: unknown }>
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return {
      webhook_enabled:   !!(m['alert_webhook_enabled'] ?? false),
      webhook_url:       (m['alert_webhook_url'] as string) ?? '',
      email_enabled:     !!(m['alert_email_enabled'] ?? false),
      smtp_host:         (m['alert_smtp_host'] as string) ?? '',
      smtp_port:         (m['alert_smtp_port'] as number) ?? 587,
      smtp_secure:       !!(m['alert_smtp_secure'] ?? false),
      smtp_user:         (m['alert_smtp_user'] as string) ?? '',
      smtp_pass:         (m['alert_smtp_pass'] as string) ?? '',
      smtp_from:         (m['alert_smtp_from'] as string) ?? '',
      email_recipients:  (m['alert_email_recipients'] as string[]) ?? [],
      telegram_enabled:  !!(m['alert_telegram_enabled'] ?? false),
      telegram_chat_id:  (m['alert_telegram_chat_id'] as number) ?? 0,
      events:            (m['alert_events'] as Record<string, boolean>) ?? {},
    }
  })

  // PUT /settings/alerts
  fastify.put('/settings/alerts', { preHandler: [requireAuth, requirePermission('admin')] }, async (req, reply) => {
    const body = alertSettingsSchema.parse(req.body)
    const upsert = async (key: string, value: unknown) => {
      await (db as any).insertInto('settings')
        .values({ key, value: JSON.stringify(value), updated_at: new Date() })
        .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }))
        .execute()
    }
    await upsert('alert_webhook_enabled',  body.webhook_enabled)
    await upsert('alert_webhook_url',       body.webhook_url)
    await upsert('alert_email_enabled',    body.email_enabled)
    await upsert('alert_smtp_host',         body.smtp_host)
    await upsert('alert_smtp_port',         body.smtp_port)
    await upsert('alert_smtp_secure',       body.smtp_secure)
    await upsert('alert_smtp_user',         body.smtp_user)
    await upsert('alert_smtp_pass',         body.smtp_pass)
    await upsert('alert_smtp_from',         body.smtp_from)
    await upsert('alert_email_recipients', body.email_recipients)
    await upsert('alert_telegram_enabled', body.telegram_enabled)
    await upsert('alert_telegram_chat_id', body.telegram_chat_id)
    await upsert('alert_events',            body.events)

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'settings.alerts.updated', resource: 'settings',
      details: { webhook_enabled: body.webhook_enabled, email_enabled: body.email_enabled, telegram_enabled: body.telegram_enabled },
      request: req,
    })
    return { ok: true }
  })

  // POST /settings/alerts/test-webhook — send a test webhook
  fastify.post('/settings/alerts/test-webhook', { preHandler: [requireAuth, requirePermission('admin')] }, async (req, reply) => {
    const { url } = z.object({ url: z.string().url() }).parse(req.body)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [{ color: '#3182ce', title: '✅ SSH Manager — Test Alert', text: 'Webhook connection is working correctly.', footer: 'SSH Manager Alerts', ts: Math.floor(Date.now() / 1000) }],
        }),
      })
      return { ok: res.ok, status: res.status }
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
  })

  // ── AI Provider Keys ────────────────────────────────────────────────────────

  fastify.get('/settings/ai-keys', { preHandler: [requireAuth, requirePermission('admin')] }, async () => {
    const keys = ['ai_key_claude', 'ai_key_openai', 'ai_key_gemini', 'ai_key_deepseek', 'ai_default_provider', 'ai_default_model']
    const rows = (await (db as any).selectFrom('settings').selectAll().where('key', 'in', keys).execute()) as Array<{ key: string; value: unknown }>
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return {
      claude:           (m['ai_key_claude'] as string) ?? '',
      openai:           (m['ai_key_openai'] as string) ?? '',
      gemini:           (m['ai_key_gemini'] as string) ?? '',
      deepseek:         (m['ai_key_deepseek'] as string) ?? '',
      default_provider: (m['ai_default_provider'] as string) ?? 'claude',
      default_model:    (m['ai_default_model'] as string) ?? '',
    }
  })

  fastify.put('/settings/ai-keys', { preHandler: [requireAuth, requirePermission('admin')] }, async (req, reply) => {
    const body = z.object({
      claude:           z.string().optional(),
      openai:           z.string().optional(),
      gemini:           z.string().optional(),
      deepseek:         z.string().optional(),
      default_provider: z.string().optional(),
      default_model:    z.string().optional(),
    }).parse(req.body)

    const upsert = async (key: string, value: unknown) => {
      await (db as any).insertInto('settings')
        .values({ key, value: JSON.stringify(value), updated_at: new Date() })
        .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }))
        .execute()
    }
    if (body.claude           !== undefined) await upsert('ai_key_claude',          body.claude)
    if (body.openai           !== undefined) await upsert('ai_key_openai',          body.openai)
    if (body.gemini           !== undefined) await upsert('ai_key_gemini',          body.gemini)
    if (body.deepseek         !== undefined) await upsert('ai_key_deepseek',        body.deepseek)
    if (body.default_provider !== undefined) await upsert('ai_default_provider',    body.default_provider)
    if (body.default_model    !== undefined) await upsert('ai_default_model',       body.default_model)

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'settings.ai_keys.updated', resource: 'settings',
      details: { providers: Object.keys(body).filter((k) => !!(body as any)[k]) }, request: req,
    })
    return { ok: true }
  })

  // POST /settings/alerts/test-email — send a test email
  fastify.post('/settings/alerts/test-email', { preHandler: [requireAuth, requirePermission('admin')] }, async (req, reply) => {
    const { sendAlert } = await import('../../utils/alerts')
    try {
      await sendAlert({
        event: 'new_login',
        title: 'Test Email Alert',
        message: 'This is a test alert from SSH Manager. Your email alert configuration is working correctly.',
        severity: 'info',
        details: { triggered_by: req.session.user!.email, timestamp: new Date().toISOString() },
      })
      return { ok: true }
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    }
  })
}

export default settingsRoutes
