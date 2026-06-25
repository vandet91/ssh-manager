import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as crypto from 'crypto'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'
import { decryptSecret, encryptSecret, getVaultKey } from '../../utils/vault'

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, 200_000, 32, 'sha256')
}

function encryptPayload(plaintext: string, passphrase: string): string {
  const salt = crypto.randomBytes(16)
  const iv   = crypto.randomBytes(12)
  const key  = deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    v: 1,
    salt: salt.toString('hex'),
    iv:   iv.toString('hex'),
    tag:  tag.toString('hex'),
    data: encrypted.toString('hex'),
  })
}

function decryptPayload(envelope: string, passphrase: string): string {
  const { v, salt, iv, tag, data } = JSON.parse(envelope)
  if (v !== 1) throw new Error('Unsupported vault export version')
  const key = deriveKey(passphrase, Buffer.from(salt, 'hex'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return decipher.update(Buffer.from(data, 'hex')) + decipher.final('utf8')
}

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
  fastify.get('/settings/password-policy', { preHandler: [requireAuth, requireAdmin] }, async () => {
    return getPasswordPolicy()
  })

  // PUT /settings/password-policy
  fastify.put('/settings/password-policy', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
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

  const groupSchema = z.object({ enabled: z.boolean().default(true), totp: z.boolean().default(false) })

  const commandsSchema = z.object({
    servers:    groupSchema.default({ enabled: true,  totp: false }),
    status:     groupSchema.default({ enabled: true,  totp: false }),
    software:   groupSchema.default({ enabled: true,  totp: false }),
    linux_info: groupSchema.default({ enabled: true,  totp: false }),
    linux_svc:  groupSchema.default({ enabled: true,  totp: true  }),
    ad_read:    groupSchema.default({ enabled: true,  totp: false }),
    ad_write:   groupSchema.default({ enabled: true,  totp: true  }),
  })

  const DEFAULT_COMMANDS = {
    servers:    { enabled: true,  totp: false },
    status:     { enabled: true,  totp: false },
    software:   { enabled: true,  totp: false },
    linux_info: { enabled: true,  totp: false },
    linux_svc:  { enabled: true,  totp: true  },
    ad_read:    { enabled: true,  totp: false },
    ad_write:   { enabled: true,  totp: true  },
  }

  const telegramSchema = z.object({
    enabled: z.boolean(),
    bot_token: z.string(),
    allowed_chats: z.array(z.number().int()),
    totp_secret: z.string(),
    commands: commandsSchema.default(DEFAULT_COMMANDS),
  })

  // GET /settings/telegram
  fastify.get('/settings/telegram', { preHandler: [requireAuth, requireAdmin] }, async () => {
    const rows = (await (db as any).selectFrom('settings').selectAll()
      .where('key', 'in', ['telegram_enabled','telegram_bot_token','telegram_allowed_chats','telegram_totp_secret','telegram_commands'])
      .execute()) as Array<{ key: string; value: unknown }>
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return {
      enabled:       !!(m['telegram_enabled'] ?? false),
      bot_token:     (m['telegram_bot_token'] as string) ?? '',
      allowed_chats: (m['telegram_allowed_chats'] as number[]) ?? [],
      totp_secret:   (m['telegram_totp_secret'] as string) ?? '',
      commands:      (m['telegram_commands'] as object) ?? DEFAULT_COMMANDS,
    }
  })

  // PUT /settings/telegram
  fastify.put('/settings/telegram', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
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
    await upsert('telegram_commands',      body.commands)

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'settings.telegram.updated', resource: 'settings',
      details: { enabled: body.enabled, has_token: !!body.bot_token, chat_count: body.allowed_chats.length },
      request: req,
    })
    return { ok: true }
  })

  // POST /settings/telegram/generate-totp — generate a new TOTP secret for the bot
  fastify.post('/settings/telegram/generate-totp', { preHandler: [requireAuth, requireAdmin] }, async () => {
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
  fastify.get('/settings/alerts', { preHandler: [requireAuth, requireAdmin] }, async () => {
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
  fastify.put('/settings/alerts', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
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
  fastify.post('/settings/alerts/test-webhook', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
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

  fastify.get('/settings/ai-keys', { preHandler: [requireAuth, requireAdmin] }, async () => {
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

  fastify.put('/settings/ai-keys', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
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
  fastify.post('/settings/alerts/test-email', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
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

  // GET /settings/vault/export — export all credentials encrypted with passphrase
  fastify.get('/settings/vault/export', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { passphrase } = z.object({ passphrase: z.string().min(8) }).parse(req.query)
    const vaultKey = getVaultKey()

    const servers = await (db as any).selectFrom('servers').select(['id', 'name', 'hostname']).orderBy('name').execute()
    const allCreds = await (db as any).selectFrom('server_credentials')
      .select(['id', 'server_id', 'category', 'label', 'linux_user', 'service_name', 'service_username', 'notes', 'password_enc', 'is_archived'])
      .execute()

    const payload = {
      exported_at: new Date().toISOString(),
      servers: (servers as any[]).map((s: any) => ({
        name: s.name,
        host: s.hostname,
        credentials: (allCreds as any[])
          .filter((c: any) => c.server_id === s.id && !c.is_archived)
          .map((c: any) => ({
            label:            c.label,
            category:         c.category,
            linux_user:       c.linux_user,
            service_name:     c.service_name,
            service_username: c.service_username,
            notes:            c.notes,
            password:         decryptSecret(c.password_enc, vaultKey),
          })),
      })).filter((s: any) => s.credentials.length > 0),
    }

    const envelope = encryptPayload(JSON.stringify(payload), passphrase)

    await writeAuditLog({
      userId: (req.session.user as any)!.id, userEmail: (req.session.user as any)!.email,
      action: 'vault.exported', resource: 'vault', resourceId: undefined,
      details: { server_count: payload.servers.length }, request: req,
    })

    reply.header('Content-Disposition', `attachment; filename="vault-export-${new Date().toISOString().slice(0,10)}.pvd"`)
    reply.header('Content-Type', 'application/octet-stream')
    return reply.send(Buffer.from(envelope))
  })

  // POST /settings/vault/import — import credentials from encrypted export file
  fastify.post('/settings/vault/import', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const body = z.object({
      passphrase: z.string().min(1),
      data: z.string().min(1),         // raw file content (sent as base64 string from frontend)
      mode: z.enum(['skip', 'overwrite']).default('skip'),
    }).parse(req.body)

    let payload: any
    try {
      const json = decryptPayload(body.data, body.passphrase)
      payload = JSON.parse(json)
    } catch {
      return reply.code(400).send({ error: 'Wrong passphrase or corrupted file' })
    }

    const vaultKey = getVaultKey()
    const servers = await (db as any).selectFrom('servers').select(['id', 'name', 'hostname']).execute()

    let imported = 0, skipped = 0

    for (const exportedServer of (payload.servers ?? [])) {
      const server = (servers as any[]).find((s: any) =>
        s.hostname === exportedServer.host || s.name === exportedServer.name
      )
      if (!server) { skipped += (exportedServer.credentials?.length ?? 0); continue }

      for (const cred of (exportedServer.credentials ?? [])) {
        if (body.mode === 'skip') {
          const existing = await db.selectFrom('server_credentials')
            .select('id')
            .where('server_id', '=', server.id)
            .where('label', '=', cred.label)
            .where('is_archived', '=', false)
            .executeTakeFirst()
          if (existing) { skipped++; continue }
        }

        await db.insertInto('server_credentials').values({
          server_id:        server.id,
          category:         cred.category ?? 'linux',
          label:            cred.label,
          linux_user:       cred.linux_user ?? null,
          service_name:     cred.service_name ?? null,
          service_username: cred.service_username ?? null,
          notes:            cred.notes ?? null,
          password_enc:     encryptSecret(cred.password, vaultKey),
        }).execute()
        imported++
      }
    }

    await writeAuditLog({
      userId: (req.session.user as any)!.id, userEmail: (req.session.user as any)!.email,
      action: 'vault.imported', resource: 'vault', resourceId: undefined,
      details: { imported, skipped }, request: req,
    })

    return { ok: true, imported, skipped }
  })

  // ── TOTP Action Rules ─────────────────────────────────────────────────────────

  // GET /settings/totp-actions
  fastify.get('/settings/totp-actions', { preHandler: [requireAuth] }, async (req) => {
    const rows = await (db as any)
      .selectFrom('totp_action_rules')
      .selectAll()
      .orderBy('category')
      .orderBy('label')
      .execute()

    const elevationMinutes = await (db as any)
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'totp_elevation_minutes')
      .executeTakeFirst()
      .then((r: any) => r ? JSON.parse(r.value) : 15)

    return { actions: rows, elevationMinutes }
  })

  // PUT /settings/totp-actions
  fastify.put('/settings/totp-actions', { preHandler: [requireAdmin] }, async (req, reply) => {
    const { actions, elevationMinutes } = req.body as {
      actions: { action: string; enabled: boolean }[]
      elevationMinutes?: number
    }

    for (const { action, enabled } of actions) {
      await (db as any)
        .updateTable('totp_action_rules')
        .set({ enabled, updated_at: new Date() })
        .where('action', '=', action)
        .execute()
    }

    if (typeof elevationMinutes === 'number' && elevationMinutes > 0) {
      await (db as any)
        .insertInto('settings')
        .values({ key: 'totp_elevation_minutes', value: JSON.stringify(elevationMinutes) })
        .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: JSON.stringify(elevationMinutes) }))
        .execute()
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'settings.totp_actions.updated', request: req,
    })

    return { ok: true }
  })

  // ── Login Background Image ────────────────────────────────────────────────────

  const LOGIN_BG_PATH = process.env.RECORDINGS_STORAGE_PATH
    ? require('path').join(process.env.RECORDINGS_STORAGE_PATH, '..', 'assets')
    : '/var/lib/ssh-manager/assets'

  // GET /settings/login-bg — PUBLIC (no auth, needed by login page)
  fastify.get('/settings/login-bg', async (_req, reply) => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const row = await (db as any).selectFrom('settings').select('value')
      .where('key', '=', 'login_bg_file').executeTakeFirst()
    if (!row) return reply.status(204).send()
    const raw = row.value as string
    const filename = raw.startsWith('"') ? JSON.parse(raw) as string : raw
    const filePath = path.join(LOGIN_BG_PATH, filename)
    if (!fs.existsSync(filePath)) return reply.status(204).send()
    const ext = path.extname(filename).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    reply.header('Content-Type', mime)
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.send(fs.createReadStream(filePath))
  })

  // POST /settings/login-bg — admin upload
  fastify.post('/settings/login-bg', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const fs = require('fs') as typeof import('fs')
    const fsp = require('fs/promises') as typeof import('fs/promises')
    const path = require('path') as typeof import('path')

    await fsp.mkdir(LOGIN_BG_PATH, { recursive: true })

    const parts = req.parts()
    let fileBuffer: Buffer | null = null
    let originalFilename = ''

    for await (const part of parts) {
      if (part.type === 'file') {
        originalFilename = part.filename
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
      }
    }

    if (!fileBuffer || !originalFilename) return reply.status(400).send({ error: 'No file provided' })

    const ext = require('path').extname(originalFilename).toLowerCase()
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
    if (!allowed.includes(ext)) return reply.status(400).send({ error: 'Only JPEG, PNG, WebP, GIF allowed' })
    if (fileBuffer.length > 10 * 1024 * 1024) return reply.status(400).send({ error: 'Max 10 MB' })

    // Remove old file
    const existing = await (db as any).selectFrom('settings').select('value').where('key', '=', 'login_bg_file').executeTakeFirst()
    if (existing) {
      try { fs.unlinkSync(path.join(LOGIN_BG_PATH, JSON.parse(existing.value))) } catch {}
    }

    const filename = `login-bg${ext}`
    await fsp.writeFile(path.join(LOGIN_BG_PATH, filename), fileBuffer)

    await (db as any).insertInto('settings').values({ key: 'login_bg_file', value: JSON.stringify(filename) })
      .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: JSON.stringify(filename) })).execute()

    return { ok: true }
  })

  // DELETE /settings/login-bg — admin remove
  fastify.delete('/settings/login-bg', { preHandler: [requireAuth, requireAdmin] }, async (_req, reply) => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const existing = await (db as any).selectFrom('settings').select('value').where('key', '=', 'login_bg_file').executeTakeFirst()
    if (existing) {
      try { fs.unlinkSync(path.join(LOGIN_BG_PATH, JSON.parse(existing.value))) } catch {}
      await (db as any).deleteFrom('settings').where('key', '=', 'login_bg_file').execute()
    }
    return reply.status(204).send()
  })
}

export default settingsRoutes
