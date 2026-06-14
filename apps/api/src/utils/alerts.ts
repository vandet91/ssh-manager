import { db } from '../db/client'

export type AlertEvent =
  | 'rotation_failed'
  | 'rotation_success'
  | 'security_critical'
  | 'security_high'
  | 'key_expiring'
  | 'login_failed'
  | 'new_login'
  | 'server_unreachable'
  | 'key_revoked'
  | 'user_deactivated'

export interface AlertPayload {
  event: AlertEvent
  title: string
  message: string
  details?: Record<string, unknown>
  severity?: 'info' | 'warning' | 'critical'
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await (db as any).selectFrom('settings').selectAll().where('key', '=', key).executeTakeFirst()
    return row ? (row.value as T) : fallback
  } catch { return fallback }
}

async function getAlertEvents(): Promise<Record<string, boolean>> {
  return getSetting('alert_events', {})
}

// ── Webhook (Slack / Teams / generic) ────────────────────────────────────────
async function sendWebhook(payload: AlertPayload): Promise<void> {
  const enabled = await getSetting<boolean>('alert_webhook_enabled', false)
  const url = await getSetting<string>('alert_webhook_url', '')
  if (!enabled || !url) return

  const color = payload.severity === 'critical' ? '#e53e3e' : payload.severity === 'warning' ? '#d69e2e' : '#3182ce'
  const slackBody = {
    attachments: [{
      color,
      title: `🚨 SSH Manager — ${payload.title}`,
      text: payload.message,
      fields: payload.details
        ? Object.entries(payload.details).map(([k, v]) => ({ title: k, value: String(v), short: true }))
        : [],
      footer: 'SSH Manager Alerts',
      ts: Math.floor(Date.now() / 1000),
    }],
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackBody),
    })
  } catch (err) {
    console.error('[alerts] Webhook send failed:', err)
  }
}

// ── Email via SMTP (nodemailer) ───────────────────────────────────────────────
async function sendEmail(payload: AlertPayload): Promise<void> {
  const enabled = await getSetting<boolean>('alert_email_enabled', false)
  if (!enabled) return

  const [host, port, secure, user, pass, from, recipients] = await Promise.all([
    getSetting<string>('alert_smtp_host', ''),
    getSetting<number>('alert_smtp_port', 587),
    getSetting<boolean>('alert_smtp_secure', false),
    getSetting<string>('alert_smtp_user', ''),
    getSetting<string>('alert_smtp_pass', ''),
    getSetting<string>('alert_smtp_from', ''),
    getSetting<string[]>('alert_email_recipients', []),
  ])

  if (!host || recipients.length === 0) return

  try {
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host, port, secure,
      auth: user ? { user, pass } : undefined,
    } as any)

    const detailsHtml = payload.details
      ? `<table style="border-collapse:collapse;margin-top:12px">${Object.entries(payload.details).map(([k, v]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px">${k}</td><td style="padding:4px 0;font-size:13px"><b>${v}</b></td></tr>`
        ).join('')}</table>`
      : ''

    const severityColor = payload.severity === 'critical' ? '#e53e3e' : payload.severity === 'warning' ? '#d69e2e' : '#3182ce'

    await transporter.sendMail({
      from: from || user,
      to: recipients.join(', '),
      subject: `[SSH Manager] ${payload.title}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px">
          <div style="background:${severityColor};color:#fff;padding:12px 16px;border-radius:6px 6px 0 0">
            <strong>🚨 SSH Manager Alert</strong>
          </div>
          <div style="border:1px solid #e2e8f0;border-top:none;padding:16px;border-radius:0 0 6px 6px">
            <h3 style="margin:0 0 8px">${payload.title}</h3>
            <p style="margin:0;color:#444">${payload.message}</p>
            ${detailsHtml}
            <p style="margin:16px 0 0;font-size:12px;color:#999">${new Date().toISOString()}</p>
          </div>
        </div>
      `,
    })
  } catch (err) {
    console.error('[alerts] Email send failed:', err)
  }
}

// ── Telegram alert channel ────────────────────────────────────────────────────
async function sendTelegramAlert(payload: AlertPayload): Promise<void> {
  const enabled = await getSetting<boolean>('alert_telegram_enabled', false)
  const chatId = await getSetting<number>('alert_telegram_chat_id', 0)
  const token = await getSetting<string>('telegram_bot_token', '')
  if (!enabled || !chatId || !token) return

  const emoji = payload.severity === 'critical' ? '🚨' : payload.severity === 'warning' ? '⚠️' : 'ℹ️'
  const detailLines = payload.details
    ? '\n' + Object.entries(payload.details).map(([k, v]) => `  • *${k}:* ${v}`).join('\n')
    : ''

  const text = `${emoji} *SSH Manager — ${payload.title}*\n\n${payload.message}${detailLines}`

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
  } catch (err) {
    console.error('[alerts] Telegram alert send failed:', err)
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function sendAlert(payload: AlertPayload): Promise<void> {
  try {
    const events = await getAlertEvents()
    if (events[payload.event] === false) return  // event disabled

    await Promise.allSettled([
      sendWebhook(payload),
      sendEmail(payload),
      sendTelegramAlert(payload),
    ])
  } catch (err) {
    console.error('[alerts] sendAlert error:', err)
  }
}
