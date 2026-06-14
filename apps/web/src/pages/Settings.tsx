import { useEffect, useState } from 'react'
import { api, TelegramSettings, AlertSettings } from '../api/client'

interface PasswordPolicy {
  min_length: number
  require_uppercase: boolean
  require_lowercase: boolean
  require_numbers: boolean
  require_special: boolean
  max_age_days: number
  max_login_attempts: number
  lockout_duration_minutes: number
}

const DEFAULT: PasswordPolicy = {
  min_length: 8,
  require_uppercase: false,
  require_lowercase: false,
  require_numbers: false,
  require_special: false,
  max_age_days: 0,
  max_login_attempts: 5,
  lockout_duration_minutes: 30,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  borderRadius: 6,
  border: '1px solid var(--input-border)',
  background: 'var(--input-bg)',
  color: 'var(--input-text)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-secondary)',
  marginBottom: 5,
  display: 'block',
}

function NumberField({ label, hint, value, min, max, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; onChange: (v: number) => void
}) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {hint && <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>{hint}</p>}
      <input
        type="number" min={min} max={max}
        value={value}
        onChange={e => onChange(Math.min(max, Math.max(min, Number(e.target.value))))}
        style={{ ...inputStyle, width: 120 }}
      />
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
      {/* Toggle pill */}
      <div
        onClick={() => onChange(!checked)}
        style={{
          flexShrink: 0,
          marginTop: 2,
          width: 36, height: 20, borderRadius: 10,
          background: checked ? 'var(--accent-hex)' : 'var(--border-med)',
          position: 'relative',
          transition: 'background 0.15s',
          cursor: 'pointer',
        }}
      >
        <div style={{
          position: 'absolute',
          top: 2, left: checked ? 18 : 2,
          width: 16, height: 16, borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.15s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </div>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
      </div>
    </label>
  )
}

const DEFAULT_TG: TelegramSettings = { enabled: false, bot_token: '', allowed_chats: [], totp_secret: '' }

const DEFAULT_ALERT: AlertSettings = {
  webhook_enabled: false, webhook_url: '',
  email_enabled: false, smtp_host: '', smtp_port: 587, smtp_secure: false,
  smtp_user: '', smtp_pass: '', smtp_from: '', email_recipients: [],
  telegram_enabled: false, telegram_chat_id: 0,
  events: {
    rotation_failed: true, rotation_success: false,
    security_critical: true, security_high: true,
    key_expiring: true, login_failed: true,
    new_login: false, server_unreachable: true,
    key_revoked: true, user_deactivated: false,
  },
}

const ALERT_EVENT_LABELS: { key: keyof AlertSettings['events']; label: string; hint: string; severity: 'critical' | 'warning' | 'info' }[] = [
  { key: 'rotation_failed',    label: 'Key rotation failed',        hint: 'A scheduled or manual rotation could not complete',   severity: 'critical' },
  { key: 'rotation_success',   label: 'Key rotation succeeded',     hint: 'Rotation completed successfully across all servers',   severity: 'info'     },
  { key: 'security_critical',  label: 'Critical security finding',  hint: 'Security scan found a critical misconfiguration',      severity: 'critical' },
  { key: 'security_high',      label: 'High security finding',      hint: 'Security scan found a high-severity misconfiguration', severity: 'warning'  },
  { key: 'key_expiring',       label: 'Key approaching rotation',   hint: 'A key is due for rotation within 7 days',             severity: 'warning'  },
  { key: 'login_failed',       label: 'Repeated login failures',    hint: 'Account locked due to too many failed attempts',       severity: 'warning'  },
  { key: 'new_login',          label: 'New user login',             hint: 'A user successfully signed in',                       severity: 'info'     },
  { key: 'server_unreachable', label: 'Server unreachable',         hint: 'SSH connection to a managed server failed',           severity: 'critical' },
  { key: 'key_revoked',        label: 'Key revoked',                hint: 'An SSH key was manually revoked/deleted',             severity: 'warning'  },
  { key: 'user_deactivated',   label: 'User deactivated',           hint: 'A user account was disabled',                         severity: 'info'     },
]

export default function Settings() {
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // Telegram
  const [tg, setTg] = useState<TelegramSettings>(DEFAULT_TG)
  const [tgSaving, setTgSaving] = useState(false)
  const [tgSaved, setTgSaved] = useState(false)
  const [tgError, setTgError] = useState('')
  const [allowedChatsText, setAllowedChatsText] = useState('')
  const [generatingTotp, setGeneratingTotp] = useState(false)
  const [totpQr, setTotpQr] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)

  // Alerts
  const [alert, setAlert] = useState<AlertSettings>(DEFAULT_ALERT)
  const [alertSaving, setAlertSaving] = useState(false)
  const [alertSaved, setAlertSaved] = useState(false)
  const [alertError, setAlertError] = useState('')
  const [showSmtpPass, setShowSmtpPass] = useState(false)
  const [recipientsText, setRecipientsText] = useState('')
  const [testingWebhook, setTestingWebhook] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)
  const [testMsg, setTestMsg] = useState('')

  useEffect(() => {
    api.get<PasswordPolicy>('/settings/password-policy')
      .then(p => { setPolicy(p); setLoading(false) })
      .catch(() => setLoading(false))
    api.get<TelegramSettings>('/settings/telegram')
      .then(t => { setTg(t); setAllowedChatsText(t.allowed_chats.join(', ')) })
      .catch(() => {})
    api.get<AlertSettings>('/settings/alerts')
      .then(a => { setAlert(a); setRecipientsText(a.email_recipients.join(', ')) })
      .catch(() => {})
  }, [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await api.put('/settings/password-policy', policy)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const set = <K extends keyof PasswordPolicy>(key: K, val: PasswordPolicy[K]) =>
    setPolicy(p => ({ ...p, [key]: val }))

  const saveTelegram = async () => {
    setTgSaving(true); setTgError(''); setTgSaved(false)
    try {
      const chats = allowedChatsText.split(/[\s,]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n))
      await api.put('/settings/telegram', { ...tg, allowed_chats: chats })
      setTg(prev => ({ ...prev, allowed_chats: chats }))
      setTgSaved(true)
      setTimeout(() => setTgSaved(false), 3000)
    } catch (err: unknown) {
      setTgError((err as Error).message ?? 'Save failed')
    } finally {
      setTgSaving(false)
    }
  }

  const generateTotp = async () => {
    setGeneratingTotp(true)
    try {
      const res = await api.post<{ secret: string; otpauth_url: string }>('/settings/telegram/generate-totp')
      setTg(prev => ({ ...prev, totp_secret: res.secret }))
      // Generate QR code URI for display
      setTotpQr(res.otpauth_url)
    } catch (err: unknown) {
      setTgError((err as Error).message ?? 'Failed to generate TOTP')
    } finally {
      setGeneratingTotp(false)
    }
  }

  const saveAlerts = async () => {
    setAlertSaving(true); setAlertError(''); setAlertSaved(false)
    try {
      const recipients = recipientsText.split(/[\s,]+/).map(s => s.trim()).filter(s => s.includes('@'))
      await api.put('/settings/alerts', { ...alert, email_recipients: recipients })
      setAlert(prev => ({ ...prev, email_recipients: recipients }))
      setAlertSaved(true)
      setTimeout(() => setAlertSaved(false), 3000)
    } catch (err: unknown) {
      setAlertError((err as Error).message ?? 'Save failed')
    } finally {
      setAlertSaving(false)
    }
  }

  const testWebhook = async () => {
    if (!alert.webhook_url) return
    setTestingWebhook(true); setTestMsg('')
    try {
      await api.post('/settings/alerts/test-webhook', { url: alert.webhook_url })
      setTestMsg('✓ Webhook test sent')
    } catch (err: unknown) {
      setTestMsg('✗ ' + ((err as Error).message ?? 'Failed'))
    } finally {
      setTestingWebhook(false)
      setTimeout(() => setTestMsg(''), 4000)
    }
  }

  const testEmail = async () => {
    setTestingEmail(true); setTestMsg('')
    try {
      await api.post('/settings/alerts/test-email', {})
      setTestMsg('✓ Test email sent')
    } catch (err: unknown) {
      setTestMsg('✗ ' + ((err as Error).message ?? 'Failed'))
    } finally {
      setTestingEmail(false)
      setTimeout(() => setTestMsg(''), 4000)
    }
  }

  // Live preview of password requirements
  const requirements: string[] = []
  requirements.push(`At least ${policy.min_length} characters`)
  if (policy.require_uppercase) requirements.push('Uppercase letter (A–Z)')
  if (policy.require_lowercase) requirements.push('Lowercase letter (a–z)')
  if (policy.require_numbers) requirements.push('Number (0–9)')
  if (policy.require_special) requirements.push('Special character (!@#$…)')

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: 'var(--text-heading)' }}>Settings</h1>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>System-wide configuration (admin only)</p>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
        <form onSubmit={save}>
          {/* ── Password Policy Card ─────────────────────────────────── */}
          <div style={{
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: 10,
            overflow: 'hidden',
            marginBottom: 24,
          }}>
            {/* Header */}
            <div style={{
              background: 'var(--card-header-bg)',
              borderBottom: '1px solid var(--card-border)',
              padding: '14px 20px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>🔐</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>Password Policy</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                  Applied to all local-auth users on registration and password change
                </div>
              </div>
            </div>

            <div style={{ padding: '20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>

                {/* Left — complexity */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8 }}>
                    Complexity Rules
                  </div>

                  <NumberField
                    label="Minimum length"
                    hint="Between 6 and 128 characters"
                    value={policy.min_length} min={6} max={128}
                    onChange={v => set('min_length', v)}
                  />

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <Toggle
                      label="Require uppercase"
                      hint="At least one A–Z"
                      checked={policy.require_uppercase}
                      onChange={v => set('require_uppercase', v)}
                    />
                    <Toggle
                      label="Require lowercase"
                      hint="At least one a–z"
                      checked={policy.require_lowercase}
                      onChange={v => set('require_lowercase', v)}
                    />
                    <Toggle
                      label="Require numbers"
                      hint="At least one 0–9"
                      checked={policy.require_numbers}
                      onChange={v => set('require_numbers', v)}
                    />
                    <Toggle
                      label="Require special character"
                      hint="At least one !@#$%^&* etc."
                      checked={policy.require_special}
                      onChange={v => set('require_special', v)}
                    />
                  </div>
                </div>

                {/* Right — expiry + lockout */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8 }}>
                    Expiry &amp; Lockout
                  </div>

                  <NumberField
                    label="Password expiry (days)"
                    hint="0 = passwords never expire"
                    value={policy.max_age_days} min={0} max={3650}
                    onChange={v => set('max_age_days', v)}
                  />

                  <NumberField
                    label="Max failed login attempts"
                    hint="0 = no lockout enforced"
                    value={policy.max_login_attempts} min={0} max={100}
                    onChange={v => set('max_login_attempts', v)}
                  />

                  <NumberField
                    label="Lockout duration (minutes)"
                    hint="How long an account is locked after too many failures"
                    value={policy.lockout_duration_minutes} min={1} max={1440}
                    onChange={v => set('lockout_duration_minutes', v)}
                  />
                </div>
              </div>

              {/* Preview */}
              <div style={{
                marginTop: 24,
                padding: '12px 16px',
                background: 'rgba(var(--accent) / 0.06)',
                border: '1px solid rgba(var(--accent) / 0.18)',
                borderRadius: 8,
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--accent-hex)', marginBottom: 8 }}>
                  Live preview — password requirements
                </div>
                <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {requirements.map((r, i) => (
                    <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r}</li>
                  ))}
                </ul>
                {policy.max_login_attempts > 0 && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--warning)' }}>
                    ⚠ Account locks for {policy.lockout_duration_minutes} min after {policy.max_login_attempts} failed attempt(s)
                  </div>
                )}
                {policy.max_age_days > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                    🕒 Passwords expire every {policy.max_age_days} day(s)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Password Policy Save Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
            <button type="submit" disabled={saving} className="btn-primary" style={{ padding: '8px 24px' }}>
              {saving ? 'Saving…' : 'Save Password Policy'}
            </button>
            {saved && <span style={{ fontSize: 13, color: 'var(--success)' }}>✓ Saved</span>}
            {error && <span style={{ fontSize: 13, color: 'var(--error)' }}>✗ {error}</span>}
          </div>
        </form>

          {/* ── Telegram Bot Card — separate from password policy form ─── */}
          <div style={{
            background: 'var(--card-bg)',
            border: '1px solid var(--card-border)',
            borderRadius: 10,
            overflow: 'hidden',
            marginBottom: 24,
          }}>
            <div style={{
              background: 'var(--card-header-bg)',
              borderBottom: '1px solid var(--card-border)',
              padding: '14px 20px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>✈️</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>Telegram Bot</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                  Monitor servers and control services via Telegram. Critical actions require a TOTP code.
                </div>
              </div>
            </div>

            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>

              <Toggle
                label="Enable Telegram Bot"
                hint="Bot will poll Telegram for commands once enabled and token is set"
                checked={tg.enabled}
                onChange={v => setTg(prev => ({ ...prev, enabled: v }))}
              />

              {/* Bot Token */}
              <div>
                <label style={labelStyle}>Bot Token</label>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>
                  Get from <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-hex)' }}>@BotFather</a> → /newbot
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={tg.bot_token}
                    onChange={e => setTg(prev => ({ ...prev, bot_token: e.target.value }))}
                    placeholder="123456789:AABB..."
                    style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(v => !v)}
                    style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
                    {showToken ? '🙈 Hide' : '👁 Show'}
                  </button>
                </div>
              </div>

              {/* Allowed chat IDs */}
              <div>
                <label style={labelStyle}>Allowed Chat IDs</label>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>
                  Comma-separated Telegram chat/user IDs. Leave empty to allow any chat (not recommended).
                  Send a message to the bot then check API logs to find your chat ID.
                </p>
                <input
                  type="text"
                  value={allowedChatsText}
                  onChange={e => setAllowedChatsText(e.target.value)}
                  placeholder="123456789, -100987654321"
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }}
                />
              </div>

              {/* TOTP Secret */}
              <div>
                <label style={labelStyle}>TOTP Authenticator Secret</label>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                  Required before any critical action (start/stop/restart) runs via Telegram.
                  Generate a new secret, scan the QR code into your authenticator app (Google Authenticator, Authy, etc.).
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={tg.totp_secret}
                    readOnly
                    placeholder="(not set)"
                    style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 11, background: 'var(--bg-subtle)' }}
                  />
                  <button
                    type="button"
                    onClick={generateTotp}
                    disabled={generatingTotp}
                    style={{
                      padding: '7px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                      background: 'var(--accent-hex)', color: '#fff', border: 'none', fontWeight: 500,
                      opacity: generatingTotp ? 0.7 : 1,
                    }}>
                    {generatingTotp ? 'Generating…' : '⟳ Generate New'}
                  </button>
                </div>
                {totpQr && (
                  <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-subtle)', border: '1px solid var(--border-med)', borderRadius: 8 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 6 }}>
                      ⚠️ Scan this into your authenticator app now — it won't be shown again
                    </p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                      Or manually enter the secret above. Remember to click Save after generating.
                    </p>
                    <p style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--accent-hex)', wordBreak: 'break-all' }}>
                      {totpQr}
                    </p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                      💡 Tip: You can paste the URL above into{' '}
                      <a href="https://www.qr-code-generator.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-hex)' }}>a QR code generator</a>
                      {' '}to get a scannable image, or use the secret key directly.
                    </p>
                  </div>
                )}
              </div>

              {/* Bot commands reference */}
              <div style={{ padding: '12px 16px', background: 'rgba(var(--accent)/0.06)', border: '1px solid rgba(var(--accent)/0.18)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--accent-hex)', marginBottom: 8 }}>
                  Bot Commands
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
                  {[
                    ['/help', 'Show all commands'],
                    ['/servers', 'List registered servers'],
                    ['/status <server>', 'Connection info'],
                    ['/software <server>', 'Installed software'],
                    ['/restart <svc> <server>', '⚠ Restart service'],
                    ['/stop <svc> <server>', '⚠ Stop service'],
                    ['/start <svc> <server>', '⚠ Start service'],
                  ].map(([cmd, desc]) => (
                    <div key={cmd} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--accent-hex)', whiteSpace: 'nowrap' }}>{cmd}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Telegram save bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 }}>
                <button
                  type="button"
                  onClick={saveTelegram}
                  disabled={tgSaving}
                  className="btn-primary"
                  style={{ padding: '8px 24px' }}>
                  {tgSaving ? 'Saving…' : 'Save Telegram Settings'}
                </button>
                {tgSaved && <span style={{ fontSize: 13, color: 'var(--success)' }}>✓ Saved</span>}
                {tgError && <span style={{ fontSize: 13, color: 'var(--error)' }}>✗ {tgError}</span>}
              </div>

            </div>
          </div>

          {/* ── Alert Settings Card ────────────────────────────────────── */}
          <div style={{
            background: 'var(--card-bg)', border: '1px solid var(--card-border)',
            borderRadius: 10, overflow: 'hidden', marginBottom: 24,
          }}>
            <div style={{
              background: 'var(--card-header-bg)', borderBottom: '1px solid var(--card-border)',
              padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 16 }}>🔔</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>Alert Notifications</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                  Send alerts via Slack webhook, email, or Telegram for critical system events
                </div>
              </div>
            </div>

            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 28 }}>

              {/* ── Webhook (Slack / Teams) ── */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8, marginBottom: 16 }}>
                  Slack / Teams Webhook
                </div>
                <Toggle label="Enable Webhook Alerts" hint="Send alerts to a Slack-compatible incoming webhook"
                  checked={alert.webhook_enabled} onChange={v => setAlert(a => ({ ...a, webhook_enabled: v }))} />
                <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                  <input
                    type="url" value={alert.webhook_url} placeholder="https://hooks.slack.com/services/..."
                    onChange={e => setAlert(a => ({ ...a, webhook_url: e.target.value }))}
                    style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  />
                  <button type="button" onClick={testWebhook} disabled={testingWebhook || !alert.webhook_url}
                    style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', opacity: !alert.webhook_url ? 0.5 : 1 }}>
                    {testingWebhook ? 'Sending…' : '⚡ Test'}
                  </button>
                </div>
              </div>

              {/* ── Email (SMTP) ── */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8, marginBottom: 16 }}>
                  Email (SMTP)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <Toggle label="Enable Email Alerts" hint="Send alerts via SMTP email"
                    checked={alert.email_enabled} onChange={v => setAlert(a => ({ ...a, email_enabled: v }))} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 80px', gap: 10 }}>
                    <div>
                      <label style={labelStyle}>SMTP Host</label>
                      <input type="text" value={alert.smtp_host} placeholder="smtp.gmail.com"
                        onChange={e => setAlert(a => ({ ...a, smtp_host: e.target.value }))}
                        style={inputStyle} />
                    </div>
                    <div>
                      <label style={labelStyle}>Port</label>
                      <input type="number" value={alert.smtp_port} min={1} max={65535}
                        onChange={e => setAlert(a => ({ ...a, smtp_port: Number(e.target.value) }))}
                        style={inputStyle} />
                    </div>
                    <div style={{ paddingTop: 22 }}>
                      <Toggle label="TLS" checked={alert.smtp_secure}
                        onChange={v => setAlert(a => ({ ...a, smtp_secure: v }))} />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div>
                      <label style={labelStyle}>Username</label>
                      <input type="text" value={alert.smtp_user} placeholder="alerts@yourcompany.com"
                        onChange={e => setAlert(a => ({ ...a, smtp_user: e.target.value }))}
                        style={inputStyle} />
                    </div>
                    <div>
                      <label style={labelStyle}>Password</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input type={showSmtpPass ? 'text' : 'password'} value={alert.smtp_pass} placeholder="••••••••"
                          onChange={e => setAlert(a => ({ ...a, smtp_pass: e.target.value }))}
                          style={{ ...inputStyle, flex: 1 }} />
                        <button type="button" onClick={() => setShowSmtpPass(v => !v)}
                          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
                          {showSmtpPass ? '🙈' : '👁'}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>From Address</label>
                    <input type="email" value={alert.smtp_from} placeholder="SSH Manager &lt;noreply@yourcompany.com&gt;"
                      onChange={e => setAlert(a => ({ ...a, smtp_from: e.target.value }))}
                      style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Alert Recipients</label>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>Comma-separated email addresses that will receive alert emails</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input type="text" value={recipientsText} placeholder="admin@company.com, sec@company.com"
                        onChange={e => setRecipientsText(e.target.value)}
                        style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 12 }} />
                      <button type="button" onClick={testEmail} disabled={testingEmail || !alert.email_enabled}
                        style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', opacity: !alert.email_enabled ? 0.5 : 1 }}>
                        {testingEmail ? 'Sending…' : '⚡ Test'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Telegram Alert Channel ── */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8, marginBottom: 16 }}>
                  Telegram Alert Channel
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <Toggle label="Enable Telegram Alerts" hint="Send alerts to a Telegram chat/channel (uses the bot token from the Telegram Bot section above)"
                    checked={alert.telegram_enabled} onChange={v => setAlert(a => ({ ...a, telegram_enabled: v }))} />
                  <div>
                    <label style={labelStyle}>Alert Chat ID</label>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5 }}>
                      The chat or channel ID where alerts will be sent. Can be different from the bot's command chat.
                      Use a negative ID for groups/channels (e.g. <code style={{ fontFamily: 'monospace' }}>-100123456789</code>).
                    </p>
                    <input type="number" value={alert.telegram_chat_id || ''} placeholder="-100123456789"
                      onChange={e => setAlert(a => ({ ...a, telegram_chat_id: Number(e.target.value) }))}
                      style={{ ...inputStyle, width: 220, fontFamily: 'monospace', fontSize: 12 }} />
                  </div>
                </div>
              </div>

              {/* ── Event Toggles ── */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8, marginBottom: 16 }}>
                  Alert Events
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  {ALERT_EVENT_LABELS.map(({ key, label, hint, severity }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ flexShrink: 0, marginTop: 2 }}>
                        <div
                          onClick={() => setAlert(a => ({ ...a, events: { ...a.events, [key]: !a.events[key] } }))}
                          style={{
                            width: 36, height: 20, borderRadius: 10, cursor: 'pointer', position: 'relative', transition: 'background 0.15s',
                            background: alert.events[key] ? 'var(--accent-hex)' : 'var(--border-med)',
                          }}
                        >
                          <div style={{
                            position: 'absolute', top: 2, left: alert.events[key] ? 18 : 2,
                            width: 16, height: 16, borderRadius: '50%', background: '#fff',
                            transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                          }} />
                        </div>
                      </div>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{label}</span>
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                            background: severity === 'critical' ? 'rgba(239,68,68,0.15)' : severity === 'warning' ? 'rgba(234,179,8,0.15)' : 'rgba(99,102,241,0.15)',
                            color: severity === 'critical' ? '#ef4444' : severity === 'warning' ? '#eab308' : '#818cf8',
                          }}>{severity}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Save bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4, borderTop: '1px solid var(--border-weak)' }}>
                <button type="button" onClick={saveAlerts} disabled={alertSaving}
                  className="btn-primary" style={{ padding: '8px 24px' }}>
                  {alertSaving ? 'Saving…' : 'Save Alert Settings'}
                </button>
                {alertSaved && <span style={{ fontSize: 13, color: 'var(--success)' }}>✓ Saved</span>}
                {alertError && <span style={{ fontSize: 13, color: 'var(--error)' }}>✗ {alertError}</span>}
                {testMsg && <span style={{ fontSize: 13, color: testMsg.startsWith('✓') ? 'var(--success)' : 'var(--error)' }}>{testMsg}</span>}
              </div>

            </div>
          </div>

        </>
      )}
    </div>
  )
}
