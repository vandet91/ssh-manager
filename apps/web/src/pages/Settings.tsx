import React, { useEffect, useState, useRef } from 'react'
import { useSystemName } from '../context/SystemNameContext'
import { api, TelegramSettings, AlertSettings, TotpActionRule, TotpActionSettings, DistroArt, distroArtApi } from '../api/client'

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

const DEFAULT_COMMANDS = {
  servers:    { enabled: true, totp: false },
  status:     { enabled: true, totp: false },
  software:   { enabled: true, totp: false },
  linux_info: { enabled: true, totp: false },
  linux_svc:  { enabled: true, totp: true  },
  ad_read:    { enabled: true, totp: false },
  ad_write:   { enabled: true, totp: true  },
  network:    { enabled: true, totp: false },
  tasks:      { enabled: true, totp: true  },
}
const DEFAULT_TG: TelegramSettings = { enabled: false, bot_token: '', allowed_chats: [], totp_secret: '', commands: DEFAULT_COMMANDS }

// Per-group command lists for individual toggles
const GROUP_COMMANDS: Record<keyof typeof DEFAULT_COMMANDS, { cmd: string; label: string }[]> = {
  servers:    [{ cmd: 'servers', label: '/servers' }, { cmd: 'devices', label: '/devices' }, { cmd: 'status', label: '/status' }],
  status:     [{ cmd: 'status', label: '/status' }],
  software:   [{ cmd: 'software', label: '/software' }],
  linux_info: [
    { cmd: 'disk',    label: '/disk' },
    { cmd: 'memory',  label: '/memory' },
    { cmd: 'top',     label: '/top' },
    { cmd: 'users',   label: '/users' },
    { cmd: 'uptime',  label: '/uptime' },
    { cmd: 'logs',    label: '/logs' },
    { cmd: 'netstat', label: '/netstat' },
  ],
  linux_svc:  [
    { cmd: 'start',   label: '/start' },
    { cmd: 'stop',    label: '/stop' },
    { cmd: 'restart', label: '/restart' },
    { cmd: 'reboot',  label: '/reboot ⚠️' },
  ],
  network:    [
    { cmd: 'ping',       label: '/ping' },
    { cmd: 'pingall',    label: '/pingall' },
    { cmd: 'down',       label: '/down' },
    { cmd: 'snmp',       label: '/snmp' },
    { cmd: 'interfaces',    label: '/interfaces' },
    { cmd: 'rebootdevice', label: '/rebootdevice ⚠️' },
  ],
  tasks:      [{ cmd: 'tasks', label: '/tasks' }, { cmd: 'runtask', label: '/runtask ⚠️' }],
  ad_read:    [
    { cmd: 'aduser',     label: '/aduser' },
    { cmd: 'adgroups',   label: '/adgroups' },
    { cmd: 'adgroup',    label: '/adgroup' },
    { cmd: 'adlocked',   label: '/adlocked' },
    { cmd: 'adexpired',  label: '/adexpired' },
    { cmd: 'addisabled', label: '/addisabled' },
    { cmd: 'adhealth',   label: '/adhealth' },
    { cmd: 'adpolicy',   label: '/adpolicy' },
  ],
  ad_write:   [
    { cmd: 'adunlock',  label: '/adunlock ⚠️' },
    { cmd: 'adenable',  label: '/adenable ⚠️' },
    { cmd: 'addisable', label: '/addisable ⚠️' },
    { cmd: 'adreset',   label: '/adreset ⚠️' },
  ],
}

function TgCommandGroups({ tg, setTg }: { tg: TelegramSettings; setTg: React.Dispatch<React.SetStateAction<TelegramSettings>> }) {
  const [expanded, setExpanded] = React.useState<string | null>(null)

  const groups: [keyof typeof DEFAULT_COMMANDS, string, boolean][] = [
    ['servers',    'Servers',         false],
    ['software',   'Software',        false],
    ['linux_info', 'Linux Info',      false],
    ['linux_svc',  'Linux Services',  true ],
    ['network',    'Network / SNMP',  false],
    ['tasks',      'Tasks',           true ],
    ['ad_read',    'AD Read',         false],
    ['ad_write',   'AD Write',        true ],
  ]

  const updateGroup = (key: keyof typeof DEFAULT_COMMANDS, patch: Partial<{ enabled: boolean; totp: boolean; cmds: Record<string, boolean> }>) =>
    setTg(prev => ({
      ...prev,
      commands: { ...(prev.commands ?? DEFAULT_COMMANDS), [key]: { ...(prev.commands?.[key] ?? DEFAULT_COMMANDS[key]), ...patch } },
    }))

  return (
    <div style={{ border: '1px solid var(--border-med)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 56px 56px', alignItems: 'center', padding: '6px 14px', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-med)', gap: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>Command Group</span>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', textAlign: 'center' }}>Enable</span>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', textAlign: 'center' }}>TOTP</span>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', textAlign: 'center' }}>Cmds</span>
      </div>

      {groups.map(([key, label], i) => {
        const cfg = tg.commands?.[key] ?? DEFAULT_COMMANDS[key]
        const enabled = cfg.enabled !== false
        const totp = cfg.totp === true
        const cmds = (cfg as any).cmds as Record<string, boolean> | undefined
        const cmdList = GROUP_COMMANDS[key] ?? []
        const disabledCount = cmdList.filter(c => cmds?.[c.cmd] === false).length
        const isOpen = expanded === key

        return (
          <div key={key} style={{ borderBottom: i < groups.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
            {/* Group row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 56px 56px', alignItems: 'center', padding: '8px 14px', gap: 4, opacity: enabled ? 1 : 0.5 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-heading)' }}>{label}
                {disabledCount > 0 && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>({cmdList.length - disabledCount}/{cmdList.length})</span>}
              </span>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <input type="checkbox" checked={enabled} onChange={e => updateGroup(key, { enabled: e.target.checked })} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <input type="checkbox" checked={totp} disabled={!enabled} title={!enabled ? 'Enable the group first' : 'Require TOTP'} onChange={e => updateGroup(key, { totp: e.target.checked })} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button type="button" onClick={() => setExpanded(isOpen ? null : key)} disabled={!enabled}
                  style={{ fontSize: 10, padding: '2px 6px', background: isOpen ? 'var(--accent-hex)' : 'var(--bg-surface)', color: isOpen ? '#fff' : 'var(--text-muted)', border: '1px solid var(--border-med)', borderRadius: 4, cursor: enabled ? 'pointer' : 'default' }}>
                  {isOpen ? '▲' : '▼'}
                </button>
              </div>
            </div>

            {/* Per-command rows */}
            {isOpen && enabled && (
              <div style={{ background: 'var(--bg-subtle)', borderTop: '1px solid var(--border-subtle)', padding: '6px 14px 10px 28px', display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                {cmdList.map(({ cmd, label: cmdLabel }) => {
                  const cmdEnabled = cmds?.[cmd] !== false
                  return (
                    <label key={cmd} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', padding: '3px 8px', borderRadius: 4, background: cmdEnabled ? 'rgba(var(--accent)/0.08)' : 'var(--bg-surface)', border: `1px solid ${cmdEnabled ? 'rgba(var(--accent)/0.25)' : 'var(--border-subtle)'}` }}>
                      <input type="checkbox" checked={cmdEnabled} onChange={e => {
                        const newCmds = { ...(cmds ?? {}), [cmd]: e.target.checked }
                        updateGroup(key, { cmds: newCmds })
                      }} style={{ margin: 0 }} />
                      <span style={{ fontSize: 12, fontFamily: 'monospace', color: cmdEnabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>{cmdLabel}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

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
  const { systemName, setSystemName } = useSystemName()
  const [sysNameInput, setSysNameInput] = useState(systemName)
  const [sysNameSaving, setSysNameSaving] = useState(false)
  const [sysNameSaved, setSysNameSaved] = useState(false)

  useEffect(() => { setSysNameInput(systemName) }, [systemName])

  async function saveSystemName() {
    setSysNameSaving(true); setSysNameSaved(false)
    try {
      const r = await fetch('/api/settings/system-name', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sysNameInput }), credentials: 'include' })
      if (!r.ok) throw new Error('Failed')
      const d = await r.json()
      setSystemName(d.system_name)
      setSysNameSaved(true)
      setTimeout(() => setSysNameSaved(false), 2000)
    } catch { /* ignore */ }
    setSysNameSaving(false)
  }

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

  // Vault export/import
  const [vaultPassphrase, setVaultPassphrase] = useState('')
  const [showVaultPass, setShowVaultPass] = useState(false)
  const [vaultExporting, setVaultExporting] = useState(false)
  const [vaultExportMsg, setVaultExportMsg] = useState('')
  const [vaultImportFile, setVaultImportFile] = useState<File | null>(null)
  const [vaultImportPass, setVaultImportPass] = useState('')
  const [showImportPass, setShowImportPass] = useState(false)
  const [vaultImportMode, setVaultImportMode] = useState<'skip' | 'overwrite'>('skip')
  const [vaultImporting, setVaultImporting] = useState(false)
  const [vaultImportMsg, setVaultImportMsg] = useState('')

  const exportVault = async () => {
    if (!vaultPassphrase || vaultPassphrase.length < 8) {
      setVaultExportMsg('✗ Passphrase must be at least 8 characters')
      return
    }
    setVaultExporting(true); setVaultExportMsg('')
    try {
      const params = new URLSearchParams({ passphrase: vaultPassphrase })
      const res = await fetch(`/api/settings/vault/export?${params}`, { credentials: 'include' })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Export failed') }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vault-export-${new Date().toISOString().slice(0,10)}.pvd`
      a.click()
      URL.revokeObjectURL(url)
      setVaultExportMsg('✓ Export downloaded')
      setTimeout(() => setVaultExportMsg(''), 4000)
    } catch (err: unknown) {
      setVaultExportMsg('✗ ' + (err as Error).message)
    } finally {
      setVaultExporting(false)
    }
  }

  const importVault = async () => {
    if (!vaultImportFile || !vaultImportPass) return
    setVaultImporting(true); setVaultImportMsg('')
    try {
      const text = await vaultImportFile.text()
      const res = await api.post<{ imported: number; skipped: number }>('/settings/vault/import', {
        passphrase: vaultImportPass,
        data: text,
        mode: vaultImportMode,
      })
      setVaultImportMsg(`✓ Imported ${res.imported} credential(s), skipped ${res.skipped}`)
      setTimeout(() => setVaultImportMsg(''), 6000)
    } catch (err: unknown) {
      setVaultImportMsg('✗ ' + (err as Error).message)
    } finally {
      setVaultImporting(false)
    }
  }

  // TOTP action rules
  const [totpActions, setTotpActions] = useState<TotpActionRule[]>([])
  const [totpElevationMinutes, setTotpElevationMinutes] = useState(15)
  const [totpSaving, setTotpSaving] = useState(false)
  const [totpSaved, setTotpSaved] = useState(false)
  const [totpError, setTotpError] = useState('')

  // AI Provider keys
  type AiKeys = { claude: string; openai: string; gemini: string; deepseek: string; default_provider: string; default_model: string }
  const [aiKeys, setAiKeys] = useState<AiKeys>({ claude: '', openai: '', gemini: '', deepseek: '', default_provider: 'claude', default_model: '' })
  const [aiSaving, setAiSaving] = useState(false)
  const [aiSaved, setAiSaved] = useState(false)
  const [aiError, setAiError] = useState('')
  const [showAiKeys, setShowAiKeys] = useState<Record<string, boolean>>({})

  const [recordingEnabled, setRecordingEnabled] = useState(true)
  const [recSaving, setRecSaving] = useState(false)

  const [aiFeatures, setAiFeatures] = useState({ analyst_enabled: true, assistant_enabled: true })
  const [aiFeatSaving, setAiFeatSaving] = useState(false)

  useEffect(() => {
    api.get<{ enabled: boolean }>('/settings/session-recording')
      .then(r => setRecordingEnabled(r.enabled))
      .catch(() => {})
    api.get<{ analyst_enabled: boolean; assistant_enabled: boolean }>('/settings/ai-features')
      .then(setAiFeatures)
      .catch(() => {})
    api.get<PasswordPolicy>('/settings/password-policy')
      .then(p => { setPolicy(p); setLoading(false) })
      .catch(() => setLoading(false))
    api.get<TelegramSettings>('/settings/telegram')
      .then(t => { setTg(t); setAllowedChatsText(t.allowed_chats.join(', ')) })
      .catch(() => {})
    api.get<AlertSettings>('/settings/alerts')
      .then(a => { setAlert(a); setRecipientsText(a.email_recipients.join(', ')) })
      .catch(() => {})
    api.get<AiKeys>('/settings/ai-keys')
      .then(k => setAiKeys(k))
      .catch(() => {})
    api.get<TotpActionSettings>('/settings/totp-actions')
      .then(t => { setTotpActions(t.actions); setTotpElevationMinutes(t.elevationMinutes) })
      .catch(() => {})
  }, [])

  const toggleRecording = async (enabled: boolean) => {
    const prev = recordingEnabled
    setRecordingEnabled(enabled)   // optimistic
    setRecSaving(true)
    try {
      await api.put('/settings/session-recording', { enabled })
    } catch {
      setRecordingEnabled(prev)    // revert on failure
    } finally {
      setRecSaving(false)
    }
  }

  const toggleAiFeature = async (key: 'analyst_enabled' | 'assistant_enabled', enabled: boolean) => {
    const prev = aiFeatures
    const next = { ...aiFeatures, [key]: enabled }
    setAiFeatures(next)   // optimistic
    setAiFeatSaving(true)
    try {
      await api.put('/settings/ai-features', next)
    } catch {
      setAiFeatures(prev)  // revert on failure
    } finally {
      setAiFeatSaving(false)
    }
  }

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

  const saveAiKeys = async () => {
    setAiSaving(true); setAiError(''); setAiSaved(false)
    try {
      await api.put('/settings/ai-keys', aiKeys)
      setAiSaved(true)
      setTimeout(() => setAiSaved(false), 3000)
    } catch (err: unknown) {
      setAiError((err as Error).message ?? 'Save failed')
    } finally {
      setAiSaving(false)
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
          {/* ── System Name Card ─────────────────────────────────────── */}
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
            <div style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--card-border)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>🏷</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>System Name</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>Shown in the sidebar, login page, and browser tab</div>
              </div>
            </div>
            <div style={{ padding: '20px', display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                value={sysNameInput}
                onChange={e => setSysNameInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveSystemName()}
                maxLength={80}
                placeholder="SSH Manager"
                style={{ flex: 1, padding: '8px 12px', borderRadius: 7, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--input-text)', fontSize: 14, outline: 'none' }}
              />
              <button type="button" onClick={saveSystemName} disabled={sysNameSaving || !sysNameInput.trim()}
                style={{ padding: '8px 20px', borderRadius: 7, border: 'none', background: 'var(--accent-hex)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                {sysNameSaving ? 'Saving…' : sysNameSaved ? '✓ Saved' : 'Save'}
              </button>
            </div>
          </div>

        <form onSubmit={save}>
          {/* ── Session Recording Card ───────────────────────────────── */}
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
              <span style={{ fontSize: 16 }}>🎬</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>Session Recording</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                  Record terminal sessions as asciinema casts for later playback
                </div>
              </div>
            </div>
            <div style={{ padding: '20px' }}>
              <Toggle
                label={recSaving ? 'Saving…' : 'Record terminal sessions'}
                hint="When off, new terminal sessions are not recorded. Existing recordings are kept."
                checked={recordingEnabled}
                onChange={toggleRecording}
              />
            </div>
          </div>

          {/* ── AI Features Card ─────────────────────────────────────── */}
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
              <span style={{ fontSize: 16 }}>🤖</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>AI Features</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                  Uses the provider configured in AI Providers. Disabling hides the feature and blocks its API.
                </div>
              </div>
            </div>
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Toggle
                label={aiFeatSaving ? 'Saving…' : 'AI Analyst (server log analysis)'}
                hint="The AI log/health analysis on the Servers page."
                checked={aiFeatures.analyst_enabled}
                onChange={v => toggleAiFeature('analyst_enabled', v)}
              />
              <Toggle
                label={aiFeatSaving ? 'Saving…' : 'AI Assistant (terminal helper)'}
                hint="The in-terminal assistant panel for quick command lookup and troubleshooting."
                checked={aiFeatures.assistant_enabled}
                onChange={v => toggleAiFeature('assistant_enabled', v)}
              />
            </div>
          </div>

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

              {/* Command group toggles */}
              <TgCommandGroups tg={tg} setTg={setTg} />

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

        {/* ── TOTP Action Guards ───────────────────────────────────────────── */}
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
          <div style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--card-border)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16 }}>🔐</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>TOTP Action Guards</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Require authenticator verification before critical actions. Users must have MFA enabled on their account.</div>
            </div>
          </div>
          <div style={{ padding: '16px 20px' }}>

            {/* Elevation window */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '12px 16px', background: 'var(--bg-body)', borderRadius: 8, border: '1px solid var(--card-border)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Elevation window</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>How long a TOTP verification stays valid before asking again (like sudo timeout)</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="number" min={1} max={120}
                  value={totpElevationMinutes}
                  onChange={e => setTotpElevationMinutes(Number(e.target.value))}
                  style={{ width: 64, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: 13, textAlign: 'center' }}
                />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>minutes</span>
              </div>
            </div>

            {/* Group actions by category */}
            {Array.from(new Set(totpActions.map(a => a.category))).map(category => (
              <div key={category} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 8 }}>{category}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {totpActions.filter(a => a.category === category).map(rule => (
                    <label key={rule.action} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 6, cursor: 'pointer', background: rule.enabled ? 'rgba(var(--accent-rgb, 88,166,255),0.06)' : 'transparent', border: `1px solid ${rule.enabled ? 'var(--accent-hex)' : 'var(--card-border)'}`, transition: 'all 0.15s' }}>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={e => setTotpActions(prev => prev.map(a => a.action === rule.action ? { ...a, enabled: e.target.checked } : a))}
                        style={{ width: 16, height: 16, accentColor: 'var(--accent-hex)', cursor: 'pointer' }}
                      />
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 13, color: 'var(--text)' }}>{rule.label}</span>
                      </div>
                      {rule.enabled && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'var(--accent-hex)', color: '#fff', fontWeight: 500 }}>Protected</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}

            {totpError && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>{totpError}</div>}
            {totpSaved && <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 8 }}>✓ Saved</div>}

            <button
              disabled={totpSaving}
              onClick={async () => {
                setTotpSaving(true); setTotpError(''); setTotpSaved(false)
                try {
                  await api.put('/settings/totp-actions', { actions: totpActions.map(a => ({ action: a.action, enabled: a.enabled })), elevationMinutes: totpElevationMinutes })
                  setTotpSaved(true)
                  setTimeout(() => setTotpSaved(false), 3000)
                } catch (e: any) { setTotpError(e.message || 'Failed to save') }
                finally { setTotpSaving(false) }
              }}
              style={{ padding: '8px 20px', borderRadius: 6, background: 'var(--accent-hex)', color: '#fff', border: 'none', fontWeight: 500, fontSize: 13, cursor: 'pointer', opacity: totpSaving ? 0.6 : 1 }}
            >
              {totpSaving ? 'Saving…' : 'Save TOTP Settings'}
            </button>
          </div>
        </div>

        {/* ── Vault Export / Import ────────────────────────────────────────── */}
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
          <div style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--card-border)', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16 }}>🗄️</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>Vault Export / Import</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                Back up all credentials to an AES-256 encrypted file, or restore from one
              </div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>

            {/* Export */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8 }}>
                Export
              </div>
              <div>
                <label style={labelStyle}>Encryption Passphrase</label>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Min 8 characters. You'll need this to import the file.</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type={showVaultPass ? 'text' : 'password'}
                    value={vaultPassphrase}
                    onChange={e => setVaultPassphrase(e.target.value)}
                    placeholder="Strong passphrase…"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button type="button" onClick={() => setShowVaultPass(v => !v)}
                    style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
                    {showVaultPass ? '🙈' : '👁'}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" onClick={exportVault} disabled={vaultExporting || !vaultPassphrase}
                  className="btn-primary" style={{ padding: '8px 20px', opacity: !vaultPassphrase ? 0.5 : 1 }}>
                  {vaultExporting ? 'Exporting…' : '⬇ Download Export'}
                </button>
                {vaultExportMsg && <span style={{ fontSize: 13, color: vaultExportMsg.startsWith('✓') ? 'var(--success)' : 'var(--error)' }}>{vaultExportMsg}</span>}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Downloads a <code style={{ fontFamily: 'monospace' }}>.pvd</code> file containing all active credentials encrypted with your passphrase.
              </p>
              <div style={{ borderTop: '1px solid var(--border-weak)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>KeePass Compatible Export</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button type="button" onClick={() => {
                    const a = document.createElement('a')
                    a.href = '/api/vault/export/keepass'
                    a.download = ''
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                  }} style={{ padding: '8px 20px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
                    ⬇ KeePass Export (.xml)
                  </button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                  Exports all active vault entries as plain KeePass 2.x XML. Import via <strong>File → Import → KeePass XML 2.x</strong> in KeePass.
                </p>
              </div>
            </div>

            {/* Import */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-weak)', paddingBottom: 8 }}>
                Import
              </div>
              <div>
                <label style={labelStyle}>Export File (.pvd)</label>
                <input type="file" accept=".pvd" onChange={e => setVaultImportFile(e.target.files?.[0] ?? null)}
                  style={{ ...inputStyle, padding: '5px 10px', cursor: 'pointer' }} />
              </div>
              <div>
                <label style={labelStyle}>Passphrase</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type={showImportPass ? 'text' : 'password'} value={vaultImportPass}
                    onChange={e => setVaultImportPass(e.target.value)}
                    placeholder="Passphrase used during export"
                    style={{ ...inputStyle, flex: 1 }} />
                  <button type="button" onClick={() => setShowImportPass(v => !v)}
                    style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
                    {showImportPass ? '🙈' : '👁'}
                  </button>
                </div>
              </div>
              <div>
                <label style={labelStyle}>If credential already exists</label>
                <select value={vaultImportMode} onChange={e => setVaultImportMode(e.target.value as 'skip' | 'overwrite')} style={{ ...inputStyle, width: 'auto' }}>
                  <option value="skip">Skip (keep existing)</option>
                  <option value="overwrite">Add anyway (creates duplicate)</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" onClick={importVault} disabled={vaultImporting || !vaultImportFile || !vaultImportPass}
                  className="btn-primary" style={{ padding: '8px 20px', opacity: (!vaultImportFile || !vaultImportPass) ? 0.5 : 1 }}>
                  {vaultImporting ? 'Importing…' : '⬆ Import'}
                </button>
                {vaultImportMsg && <span style={{ fontSize: 13, color: vaultImportMsg.startsWith('✓') ? 'var(--success)' : 'var(--error)' }}>{vaultImportMsg}</span>}
              </div>
            </div>

          </div>
        </div>

        {/* ── AI Provider Keys ─────────────────────────────────────────────── */}
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-weak)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-weak)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-heading)' }}>AI Providers</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>API keys for AI log analysis. Keys are stored encrypted in the database.</div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Provider rows */}
            {([
              { id: 'claude',   label: 'Anthropic Claude', icon: '🟠', hint: 'Best for deep reasoning & long-context analysis' },
              { id: 'openai',   label: 'OpenAI GPT',       icon: '🟢', hint: 'Reliable, fast — gpt-4o-mini is cost-efficient'  },
              { id: 'gemini',   label: 'Google Gemini',    icon: '🔵', hint: 'Huge 1M token context — great for very large logs' },
              { id: 'deepseek', label: 'DeepSeek',         icon: '🔴', hint: 'Excellent technical analysis, very low cost'       },
            ] as const).map(({ id, label, icon, hint }) => (
              <div key={id} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, alignItems: 'start' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{icon} {label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>{hint}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type={showAiKeys[id] ? 'text' : 'password'}
                      value={(aiKeys as any)[id]}
                      onChange={e => setAiKeys(k => ({ ...k, [id]: e.target.value }))}
                      placeholder={`${label} API key`}
                      style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12, paddingRight: 36 }}
                    />
                    <button type="button"
                      onClick={() => setShowAiKeys(s => ({ ...s, [id]: !s[id] }))}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0 }}>
                      {showAiKeys[id] ? '🙈' : '👁'}
                    </button>
                  </div>
                  {(aiKeys as any)[id] && (
                    <span style={{ fontSize: 11, color: 'var(--success)', whiteSpace: 'nowrap' }}>✓ Set</span>
                  )}
                </div>
              </div>
            ))}

            {/* Default provider/model */}
            <div style={{ borderTop: '1px solid var(--border-weak)', paddingTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Default Provider</label>
                <select value={aiKeys.default_provider} onChange={e => setAiKeys(k => ({ ...k, default_provider: e.target.value }))} style={inputStyle}>
                  <option value="claude">🟠 Anthropic Claude</option>
                  <option value="openai">🟢 OpenAI GPT</option>
                  <option value="gemini">🔵 Google Gemini</option>
                  <option value="deepseek">🔴 DeepSeek</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Default Model <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(overridable per analysis)</span></label>
                <input value={aiKeys.default_model} onChange={e => setAiKeys(k => ({ ...k, default_model: e.target.value }))}
                  placeholder="e.g. claude-sonnet-4-6 (leave blank for auto)"
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }} />
              </div>
            </div>

            {/* Save bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4, borderTop: '1px solid var(--border-weak)' }}>
              <button type="button" onClick={saveAiKeys} disabled={aiSaving}
                className="btn-primary" style={{ padding: '8px 24px' }}>
                {aiSaving ? 'Saving…' : 'Save AI Keys'}
              </button>
              {aiSaved && <span style={{ fontSize: 13, color: 'var(--success)' }}>✓ Saved</span>}
              {aiError && <span style={{ fontSize: 13, color: 'var(--error)' }}>✗ {aiError}</span>}
            </div>
          </div>
        </div>

        {/* ── Login Background ──────────────────────────────────────────────── */}
        <div style={{ marginTop: 24 }}>
          <LoginBgSection />
          <LoginLogoSection />
        </div>

        {/* ── Distro Art ────────────────────────────────────────────────────── */}
        <DistroArtSection />

        </>
      )}
    </div>
  )
}

// ─── Login Background Section ──────────────────────────────────────────────────

function LoginBgSection() {
  const [preview, setPreview] = useState<string | null>(null)
  const [hasImage, setHasImage] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/settings/login-bg').then(r => {
      if (r.ok && r.status !== 204) {
        setHasImage(true)
        setPreview(`/api/settings/login-bg?t=${Date.now()}`)
      }
    }).catch(() => {})
  }, [])

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPreview(URL.createObjectURL(file))
  }

  const upload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setUploading(true); setMsg('')
    try {
      const form = new FormData()
      form.append('file', file)
      const r = await fetch('/api/settings/login-bg', { method: 'POST', body: form, credentials: 'include' })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Upload failed')
      setHasImage(true)
      setMsg('Background updated.')
    } catch (e: any) { setMsg(e.message) }
    setUploading(false)
  }

  const remove = async () => {
    if (!confirm('Remove login background?')) return
    await fetch('/api/settings/login-bg', { method: 'DELETE', credentials: 'include' })
    setHasImage(false); setPreview(null); setMsg('Background removed.')
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 24, marginBottom: 24 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: 'var(--text-heading)' }}>🖼 Login Page Background</h3>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)' }}>
        Upload a background image for the login page. Recommended: landscape photo, 1920×1080 or larger. Max 10 MB.
      </p>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Preview */}
        <div style={{
          width: 240, height: 135, borderRadius: 8, overflow: 'hidden', flexShrink: 0,
          border: '1px solid var(--border-med)', background: 'var(--bg-canvas)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative',
        }}>
          {preview ? (
            <img src={preview} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 32, opacity: 0.2 }}>🖼</span>
          )}
          {preview && (
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(135deg,rgba(0,0,0,0.5),rgba(0,0,20,0.35))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                background: 'rgba(15,15,30,0.75)', backdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
                padding: '6px 12px', color: '#fff', fontSize: 11,
              }}>Preview</div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleFile}
            style={{ display: 'block', marginBottom: 12, fontSize: 13, color: 'var(--text-primary)' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={upload} disabled={uploading || !fileRef.current?.files?.length}
              className="btn-primary" style={{ padding: '7px 16px', fontSize: 13 }}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
            {hasImage && (
              <button onClick={remove}
                style={{
                  padding: '7px 16px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
                  background: 'rgba(242,73,92,0.12)', border: '1px solid rgba(242,73,92,0.35)',
                  color: '#f2495c',
                }}>
                Remove
              </button>
            )}
          </div>
          {msg && <p style={{ marginTop: 10, fontSize: 13, color: msg.includes('failed') || msg.includes('Max') ? '#f2495c' : 'var(--text-muted)' }}>{msg}</p>}
        </div>
      </div>
    </div>
  )
}

// ─── Login Logo Section ────────────────────────────────────────────────────────

function LoginLogoSection() {
  const [preview, setPreview] = useState<string | null>(null)
  const [hasLogo, setHasLogo] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/settings/login-logo').then(r => {
      if (r.ok && r.status !== 204) {
        setHasLogo(true)
        setPreview(`/api/settings/login-logo?t=${Date.now()}`)
      }
    }).catch(() => {})
  }, [])

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPreview(URL.createObjectURL(file))
  }

  const upload = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setUploading(true); setMsg('')
    try {
      const form = new FormData()
      form.append('file', file)
      const r = await fetch('/api/settings/login-logo', { method: 'POST', body: form, credentials: 'include' })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Upload failed')
      setHasLogo(true)
      setMsg('Logo updated.')
    } catch (e: any) { setMsg(e.message) }
    setUploading(false)
  }

  const remove = async () => {
    if (!confirm('Remove login logo?')) return
    await fetch('/api/settings/login-logo', { method: 'DELETE', credentials: 'include' })
    setHasLogo(false); setPreview(null); setMsg('Logo removed.')
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 24, marginBottom: 24 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: 'var(--text-heading)' }}>🏷 Login Page Logo</h3>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)' }}>
        Upload a logo to replace the default icon on the login page. Recommended: square PNG or SVG with transparency. Max 2 MB.
      </p>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Preview */}
        <div style={{
          width: 96, height: 96, borderRadius: 16, overflow: 'hidden', flexShrink: 0,
          border: '1px solid var(--border-med)', background: 'var(--bg-canvas)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {preview ? (
            <img src={preview} alt="logo preview" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 8, boxSizing: 'border-box' }} />
          ) : (
            <span style={{ fontSize: 36, opacity: 0.2 }}>⌨</span>
          )}
        </div>

        {/* Controls */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml"
            onChange={handleFile}
            style={{ display: 'block', marginBottom: 12, fontSize: 13, color: 'var(--text-primary)' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={upload} disabled={uploading || !fileRef.current?.files?.length}
              className="btn-primary" style={{ padding: '7px 16px', fontSize: 13 }}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
            {hasLogo && (
              <button onClick={remove}
                style={{
                  padding: '7px 16px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
                  background: 'rgba(242,73,92,0.12)', border: '1px solid rgba(242,73,92,0.35)',
                  color: '#f2495c',
                }}>
                Remove
              </button>
            )}
          </div>
          {msg && <p style={{ marginTop: 10, fontSize: 13, color: msg.includes('failed') || msg.includes('Max') ? '#f2495c' : 'var(--text-muted)' }}>{msg}</p>}
        </div>
      </div>
    </div>
  )
}

// ─── Distro Art Section ────────────────────────────────────────────────────────
const monoFont = '"JetBrains Mono","Fira Code","Cascadia Code",monospace'

function ArtPreview({ lines, color, scroll = false }: { lines: string[]; color: string; scroll?: boolean }) {
  return (
    <pre style={{
      fontFamily: monoFont, fontSize: 10, lineHeight: 1.5,
      color, margin: 0, userSelect: 'none', textAlign: 'left',
      textShadow: `0 0 10px ${color}44`,
      overflow: scroll ? 'auto' : 'hidden',
      maxHeight: scroll ? 'none' : 130,
      width: '100%',
    }}>
      {lines.join('\n')}
    </pre>
  )
}

function DistroArtSection() {
  const [list, setList] = useState<DistroArt[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<DistroArt | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [err, setErr] = useState('')

  // edit form state
  const [editKey, setEditKey] = useState('')
  const [editColor, setEditColor] = useState('#94a3b8')
  const [editArt, setEditArt] = useState('')

  const load = () => {
    setLoading(true)
    distroArtApi.list().then(data => { setList(data); setLoading(false) }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const openEdit = (item: DistroArt, newEntry = false) => {
    setEditing(item)
    setIsNew(newEntry)
    setEditKey(item.key)
    setEditColor(item.color)
    setEditArt(item.art_lines.join('\n'))
    setErr('')
  }


  const openNew = () => openEdit({ key: '', art_lines: [], color: '#94a3b8' }, true)

  const save = async () => {
    const lines = editArt.split('\n')
    if (!editKey.trim()) { setErr('Key is required'); return }
    if (lines.every(l => !l.trim())) { setErr('Art cannot be empty'); return }
    setSaving(true); setErr('')
    try {
      await distroArtApi.save(editKey.trim().toLowerCase(), lines, editColor)
      setEditing(null)
      load()
    } catch (e: any) {
      setErr(e.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const del = async (key: string) => {
    if (!confirm(`Delete "${key}" logo? The Terminal will fall back to the built-in default.`)) return
    setDeleting(key)
    try {
      await distroArtApi.remove(key)
      load()
    } finally {
      setDeleting(null)
    }
  }

  const previewLines = editArt ? editArt.split('\n') : ['(no art yet)']

  return (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
      {/* Header */}
      <div style={{ background: 'var(--card-header-bg)', borderBottom: '1px solid var(--card-border)', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>🎨</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>Distro Art</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              ASCII art logos shown in the Terminal right panel when connected to a server.
              The key must match the server's <code style={{ fontSize: 11 }}>distro</code> / <code style={{ fontSize: 11 }}>os_id</code> value.
            </div>
          </div>
        </div>
        <button onClick={openNew} className="btn-primary" style={{ padding: '7px 16px', fontSize: 13, flexShrink: 0 }}>
          + Add Logo
        </button>
      </div>

      <div style={{ padding: 20 }}>
        {loading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>}
        {!loading && list.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No custom logos yet. The Terminal uses built-in defaults. Click <strong>+ Add Logo</strong> to override any distro.
          </p>
        )}

        {/* Logo grid */}
        {list.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
            {list.map(item => (
              <div key={item.key} style={{
                background: 'var(--bg-body)', border: '1px solid var(--border-weak)',
                borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, position: 'relative',
              }}>
                {/* Key + color dot */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: item.color, flexShrink: 0, display: 'inline-block', boxShadow: `0 0 6px ${item.color}` }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', fontFamily: monoFont }}>{item.key}</span>
                </div>
                {/* Preview */}
                <div style={{ background: '#0d1117', borderRadius: 6, padding: '8px 4px', minHeight: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ArtPreview lines={item.art_lines} color={item.color} />
                </div>
                {/* Actions */}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => openEdit(item)} style={{
                    flex: 1, fontSize: 11, padding: '4px 0', borderRadius: 4, border: '1px solid var(--border-weak)',
                    background: 'var(--card-bg)', color: 'var(--text)', cursor: 'pointer',
                  }}>Edit</button>
                  <button onClick={() => del(item.key)} disabled={deleting === item.key} style={{
                    fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '1px solid #7f1d1d',
                    background: 'transparent', color: '#f87171', cursor: 'pointer',
                  }}>{deleting === item.key ? '…' : '✕'}</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tip */}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, borderTop: '1px solid var(--border-weak)', paddingTop: 12 }}>
          <strong>Tips:</strong> Keep all lines the same width (~16–20 chars). Use Unicode blocks: <code>█ ▀ ▄ ▌ ▐ ░ ▒ ▓</code> or classic ASCII: <code>/ \ | _ . - #</code>.
          You can ask AI to generate art — just paste it into the editor. The <code>default</code> key overrides the fallback for unknown Linux distros.
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={e => { if (e.target === e.currentTarget) setEditing(null) }}>
          <div style={{
            background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12,
            width: 700, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Modal header */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-weak)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>
                {isNew ? 'Add Distro Logo' : `Edit: ${editing.key}`}
              </div>
              <button onClick={() => setEditing(null)} style={{ background: 'none', border: 'none', fontSize: 18, color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* Left: controls */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Key */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    DISTRO KEY <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                  <input
                    value={editKey}
                    onChange={e => setEditKey(e.target.value.toLowerCase())}
                    disabled={!isNew}
                    placeholder="e.g. ubuntu, debian, arch, default"
                    style={{
                      width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 12,
                      border: '1px solid var(--border-weak)', background: 'var(--input-bg)',
                      color: 'var(--text)', fontFamily: monoFont, boxSizing: 'border-box',
                      opacity: isNew ? 1 : 0.6,
                    }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Must match the server's distro / os_id field (lowercase).
                  </div>
                </div>

                {/* Color */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>COLOR</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)}
                      style={{ width: 40, height: 32, border: 'none', cursor: 'pointer', borderRadius: 4, padding: 2 }} />
                    <input value={editColor} onChange={e => setEditColor(e.target.value)}
                      style={{
                        flex: 1, padding: '7px 10px', borderRadius: 6, fontSize: 12,
                        border: '1px solid var(--border-weak)', background: 'var(--input-bg)', color: 'var(--text)', fontFamily: monoFont,
                      }} />
                  </div>
                </div>

                {/* Art textarea */}
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                    ASCII ART <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(one line per row)</span>
                  </label>
                  <textarea
                    value={editArt}
                    onChange={e => setEditArt(e.target.value)}
                    rows={14}
                    spellCheck={false}
                    placeholder={'   ██████   \n  ██    ██  \n ██  ██  ██ \n ...'}
                    style={{
                      width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 12,
                      border: '1px solid var(--border-weak)', background: '#0d1117',
                      color: editColor, fontFamily: monoFont, lineHeight: 1.5, resize: 'vertical',
                      boxSizing: 'border-box', outline: 'none',
                    }}
                  />
                </div>

                {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={save} disabled={saving} className="btn-primary" style={{ padding: '8px 20px' }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => setEditing(null)} style={{
                    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border-weak)',
                    background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 13,
                  }}>Cancel</button>
                </div>
              </div>

              {/* Right: live preview */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>LIVE PREVIEW</div>
                <div style={{
                  background: '#0d1117', borderRadius: 8, border: '1px solid var(--border-weak)',
                  flex: 1, minHeight: 200, padding: 16, overflow: 'auto',
                }}>
                  <ArtPreview lines={previewLines} color={editColor} scroll />
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  This is how the logo will appear in the Terminal panel when connected to a server with distro = <code style={{ fontFamily: monoFont }}>{editKey || '…'}</code>.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
