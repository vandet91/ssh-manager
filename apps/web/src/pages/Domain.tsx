import React, { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api/client'

// ── Types ─────────────────────────────────────────────────────────────────────

type DcServer = { id: string; name: string; hostname: string; environment: string; tags?: { domain_name?: string } }

type DomainUser = {
  samAccountName: string
  displayName: string
  email: string | null
  enabled: boolean
  lockedOut: boolean
  passwordExpired: boolean
  passwordNeverExpires: boolean
  mustChangePassword: boolean
  passwordLastSet: string | null
  lastLogonDate: string | null
  ou: string | null
  distinguishedName: string
}

type UserDetail = {
  groups: { name: string; scope: string; category: string }[]
  description: string | null
  title: string | null
  department: string | null
  adminCount: boolean
  badLogonCount: number
}

type AdGroup = { name: string; scope: string; category: string; description: string }

type Tab = 'locked' | 'password_issues' | 'disabled' | 'all' | 'sessions' | 'computers' | 'groups'

type AdGroupMember = { samAccountName: string; name: string; type: string }

type AdComputer = {
  Name: string
  DNSHostName: string | null
  IPv4Address: string | null
  OperatingSystem: string | null
  LastLogonDate: string | null
  Enabled: boolean
  IsDomainController: boolean
  online?: boolean
}

type Session = {
  username: string
  sessionName: string
  id: string
  state: string
  idleTime: string
}

type DomainHealth = {
  domain: string
  forest: string
  domainMode: string
  forestMode: string
  fsmo: { pdcEmulator: string; ridMaster: string; infraMaster: string; schemaMaster: string; namingMaster: string }
  recycleBinEnabled: boolean
  dcs: Array<{ name: string; hostname: string; isGlobalCatalog: boolean; isReadOnly: boolean; os: string; site: string; ip: string }>
  replFailureCount: number
  replFailDetail: Array<{ partner: string; lastError: string; failureCount: number; firstFailure: string }>
  passwordPolicy: { minLength: number; history: number; maxAgeDays: number; minAgeDays: number; complexityEnabled: boolean; lockoutThreshold: number; lockoutDurationMinutes: number }
  services: Array<{ name: string; status: string }>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PRIVILEGED_GROUPS = new Set([
  'Domain Admins', 'Enterprise Admins', 'Schema Admins', 'Administrators',
  'Account Operators', 'Backup Operators', 'Print Operators', 'Server Operators',
  'Group Policy Creator Owners', 'DNSAdmins', 'DHCP Administrators',
])

// All built-in Windows/AD groups — read-only (member management only, no edit/delete)
const DEFAULT_WINDOWS_GROUPS = new Set([
  // Privileged
  'Domain Admins', 'Enterprise Admins', 'Schema Admins', 'Administrators',
  'Account Operators', 'Backup Operators', 'Print Operators', 'Server Operators',
  'Group Policy Creator Owners', 'DNSAdmins', 'DHCP Administrators',
  // Domain defaults
  'Domain Users', 'Domain Computers', 'Domain Guests', 'Domain Controllers',
  'Read-only Domain Controllers', 'Cloneable Domain Controllers', 'Protected Users',
  'Cert Publishers', 'RAS and IAS Servers', 'Allowed RODC Password Replication Group',
  'Denied RODC Password Replication Group', 'Enterprise Read-only Domain Controllers',
  'Key Admins', 'Enterprise Key Admins',
  // Local built-in
  'Users', 'Guests', 'Remote Desktop Users', 'Network Configuration Operators',
  'Performance Monitor Users', 'Performance Log Users', 'Distributed COM Users',
  'IIS_IUSRS', 'Cryptographic Operators', 'Event Log Readers',
  'Certificate Service DCOM Access', 'Access Control Assistance Operators',
  'Remote Management Users', 'Hyper-V Administrators', 'Storage Replica Administrators',
  'RDS Remote Access Servers', 'RDS Endpoint Servers', 'RDS Management Servers',
  'Windows Authorization Access Group', 'Terminal Server License Servers',
  'Incoming Forest Trust Builders', 'Pre-Windows 2000 Compatible Access',
])

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(date: string | null): string {
  if (!date) return '—'
  const diff = Date.now() - new Date(date).getTime()
  const d = Math.floor(diff / 86400000)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d < 30) return `${d}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

function generatePassword(length = 16): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  const special = '!@#$%^&*()-_=+'
  const all = upper + lower + digits + special
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(length)))
  const pwd = [
    upper[rand[0] % upper.length], lower[rand[1] % lower.length],
    digits[rand[2] % digits.length], special[rand[3] % special.length],
    ...rand.slice(4).map(b => all[b % all.length]),
  ]
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = rand[i % rand.length] % (i + 1);
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]]
  }
  return pwd.join('')
}

function ouLabel(ou: string | null): string {
  if (!ou) return '—'
  return ou.replace(/^CN=[^,]+,/, '').replace(/OU=/g, '').replace(/DC=[^,]+(,|$)/g, '').replace(/,$/, '').trim() || ou
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
      style={{ background: color + '22', color, border: `1px solid ${color}44` }}>
      {label}
    </span>
  )
}

// ── Reset Password Modal ──────────────────────────────────────────────────────

function ResetPasswordModal({ user, serverId, onClose, onDone }: {
  user: DomainUser; serverId: string; onClose: () => void; onDone: () => void
}) {
  const [password, setPassword] = useState(() => generatePassword())
  const [forceChange, setForceChange] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const [doneResult, setDoneResult] = useState<{ updatedCreds: number } | null>(null)

  const save = async () => {
    setSaving(true); setError('')
    try {
      const res = await api.post<{ ok: boolean; updatedCreds: number }>(`/domain/${serverId}/reset-password`, { samAccountName: user.samAccountName, password, forceChange })
      setDoneResult({ updatedCreds: res.updatedCreds ?? 0 })
    } catch (e: any) { setError(e.data?.error ?? e.message ?? 'Failed') }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="rounded-xl border p-6 w-[460px] space-y-4"
        style={{ background: 'var(--modal-bg)', borderColor: 'var(--modal-border)' }}>
        <h2 className="text-base font-bold" style={{ color: 'var(--text-heading)' }}>
          Reset Password — <span className="font-mono">{user.samAccountName}</span>
        </h2>
        <div>
          <label className="text-xs font-semibold mb-1 block" style={{ color: 'var(--text-secondary)' }}>New Password</label>
          <div className="flex gap-2">
            <div className="flex-1 flex items-center rounded-lg border px-3 gap-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
              <input type={showPwd ? 'text' : 'password'} value={password}
                onChange={e => setPassword(e.target.value)}
                className="flex-1 bg-transparent text-sm py-2 outline-none font-mono"
                style={{ color: 'var(--input-text)' }} />
              <button onClick={() => setShowPwd(v => !v)} style={{ color: 'var(--text-muted)' }} className="text-xs px-1">
                {showPwd ? '🙈' : '👁'}
              </button>
            </div>
            <button onClick={() => setPassword(generatePassword())}
              className="px-3 py-2 rounded-lg text-sm border hover:opacity-80"
              style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
              ↺
            </button>
            <button onClick={() => { navigator.clipboard.writeText(password); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
              className="px-3 py-2 rounded-lg text-sm border"
              style={{ background: copied ? '#238636' : 'var(--bg-panel-alt)', borderColor: copied ? '#238636' : 'var(--border-med)', color: copied ? '#fff' : 'var(--text-primary)' }}>
              {copied ? '✓' : '📋'}
            </button>
          </div>
        </div>
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <input type="checkbox" checked={forceChange} onChange={e => setForceChange(e.target.checked)} className="w-4 h-4" />
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>Force change at next logon</span>
        </label>
        {error && <p className="text-sm px-3 py-2 rounded-lg bg-red-900/20 border border-red-800/40 text-red-400">{error}</p>}
        {doneResult && (
          <div className="px-3 py-3 rounded-lg border space-y-1" style={{ background: 'rgba(35,134,54,0.12)', borderColor: 'rgba(35,134,54,0.4)' }}>
            <p className="text-sm font-medium text-green-400">✓ Password reset in Active Directory</p>
            {doneResult.updatedCreds > 0
              ? <p className="text-xs text-green-300">Also updated {doneResult.updatedCreds} stored credential{doneResult.updatedCreds > 1 ? 's' : ''} in the vault — your saved passwords are now in sync.</p>
              : <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No matching stored credentials found — if you have RDP/SSH credentials saved for this account, update them manually.</p>
            }
          </div>
        )}
        <div className="flex gap-2 justify-end pt-1">
          {doneResult
            ? <button onClick={onDone} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: 'var(--btn-accent-bg)' }}>Done</button>
            : <>
                <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm border"
                  style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>Cancel</button>
                <button onClick={save} disabled={saving || !password}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: 'var(--btn-accent-bg)' }}>
                  {saving ? 'Resetting…' : 'Reset Password'}
                </button>
              </>
          }
        </div>
      </div>
    </div>
  )
}

// ── Health Panel ──────────────────────────────────────────────────────────────

function HealthPanel({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [health, setHealth] = useState<DomainHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    api.get<DomainHealth>(`/domain/${serverId}/health`)
      .then(setHealth)
      .catch(e => setError(e.data?.error ?? e.message ?? 'Health check failed'))
      .finally(() => setLoading(false))
  }, [serverId])

  const runSync = async () => {
    setSyncBusy(true); setSyncResult(null)
    try {
      const res = await api.post<{ ok: boolean; output: string; code: number }>(`/domain/${serverId}/replication-sync`, {})
      setSyncResult({ ok: res.code === 0, message: res.output || 'Sync command sent.' })
      // Silently refresh health data in background — no loading state so panel doesn't jump
      setTimeout(() => {
        api.get<DomainHealth>(`/domain/${serverId}/health`).then(setHealth).catch(() => {})
      }, 3000)
    } catch (e: any) {
      setSyncResult({ ok: false, message: e.data?.error ?? e.message ?? 'Sync failed' })
    }
    setSyncBusy(false)
  }

  const svcColor = (status: string) =>
    status === 'Running' ? '#22c55e' : status === 'NotFound' ? '#6b7280' : '#ef4444'

  const svcIcon = (status: string) =>
    status === 'Running' ? '●' : status === 'NotFound' ? '○' : '✕'

  const svcLabel: Record<string, string> = {
    NTDS: 'AD DS', NETLOGON: 'Net Logon', W32Time: 'Time Sync', DNS: 'DNS', KDC: 'Kerberos',
  }

  // Health score calculation
  const issues: string[] = []
  if (health) {
    if (health.replFailureCount > 0) issues.push(`${health.replFailureCount} replication failure(s)`)
    health.services.forEach(s => { if (s.status !== 'Running' && s.status !== 'NotFound') issues.push(`${svcLabel[s.name] ?? s.name} service is ${s.status}`) })
    if (!health.recycleBinEnabled) issues.push('AD Recycle Bin not enabled')
    if (health.passwordPolicy.minLength < 8) issues.push('Password minimum length < 8')
    if (!health.passwordPolicy.complexityEnabled) issues.push('Password complexity not enforced')
    if (health.passwordPolicy.lockoutThreshold === 0) issues.push('Account lockout not configured')
    if (health.passwordPolicy.maxAgeDays === 0) issues.push('Passwords never expire')
    if (health.dcs.filter(dc => dc.isGlobalCatalog).length === 0) issues.push('No Global Catalog servers found')
  }

  const overallColor = issues.length === 0 ? '#22c55e' : issues.some(i =>
    i.includes('replication') || i.includes('service')
  ) ? '#ef4444' : '#eab308'

  const overallLabel = issues.length === 0 ? 'Healthy' : issues.some(i =>
    i.includes('replication') || i.includes('service')
  ) ? 'Critical' : 'Warnings'

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-med)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b"
        style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)' }}>
        <div className="flex items-center gap-2">
          <span className="text-base font-bold" style={{ color: 'var(--text-heading)' }}>🩺 Domain Health Check</span>
          {health && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full ml-1"
              style={{ background: overallColor + '22', color: overallColor, border: `1px solid ${overallColor}44` }}>
              {overallLabel}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-sm px-3 py-1 rounded-lg border hover:opacity-80"
          style={{ borderColor: 'var(--border-med)', color: 'var(--text-muted)' }}>✕ Close</button>
      </div>

      <div style={{ background: 'var(--bg-panel)' }}>
        {loading && (
          <div className="flex flex-col items-center gap-3 py-16">
            <div style={{ width: 28, height: 28, border: '3px solid var(--border-med)', borderTopColor: 'var(--accent-hex)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Running health checks on domain controller…</span>
          </div>
        )}

        {error && (
          <div className="px-5 py-4">
            <p className="text-sm text-red-400 font-medium">Health check failed</p>
            <p className="text-xs font-mono mt-1 text-red-400/70">{error}</p>
          </div>
        )}

        {health && (
          <div className="p-5 space-y-5">

            {/* Issues summary */}
            {issues.length > 0 && (
              <div className="rounded-lg border p-4 space-y-1.5"
                style={{ background: overallColor + '0d', borderColor: overallColor + '33' }}>
                <p className="text-xs font-semibold mb-2" style={{ color: overallColor }}>
                  {issues.length} issue{issues.length > 1 ? 's' : ''} found
                </p>
                {issues.map((issue, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm" style={{ color: overallColor }}>
                    <span className="mt-0.5 flex-shrink-0">⚠</span>
                    <span>{issue}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Domain / Forest info */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Domain', value: health.domain },
                { label: 'Forest', value: health.forest },
                { label: 'Domain Level', value: health.domainMode },
                { label: 'Forest Level', value: health.forestMode },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg border p-3"
                  style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)' }}>
                  <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
                  <p className="text-sm font-medium font-mono" style={{ color: 'var(--text-primary)' }}>{value || '—'}</p>
                </div>
              ))}
            </div>

            {/* Services */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                DC Services
              </h3>
              <div className="flex flex-wrap gap-2">
                {health.services.map(s => (
                  <div key={s.name} className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm"
                    style={{ background: 'var(--bg-panel-alt)', borderColor: svcColor(s.status) + '44' }}>
                    <span style={{ color: svcColor(s.status), fontSize: 10 }}>{svcIcon(s.status)}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{svcLabel[s.name] ?? s.name}</span>
                    <span className="text-xs" style={{ color: svcColor(s.status) }}>{s.status}</span>
                  </div>
                ))}
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm"
                  style={{ background: 'var(--bg-panel-alt)', borderColor: (health.recycleBinEnabled ? '#22c55e' : '#eab308') + '44' }}>
                  <span style={{ color: health.recycleBinEnabled ? '#22c55e' : '#eab308', fontSize: 10 }}>
                    {health.recycleBinEnabled ? '●' : '○'}
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>AD Recycle Bin</span>
                  <span className="text-xs" style={{ color: health.recycleBinEnabled ? '#22c55e' : '#eab308' }}>
                    {health.recycleBinEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>
            </div>

            {/* FSMO Roles */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                FSMO Roles
              </h3>
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-med)' }}>
                <table className="w-full text-sm">
                  <tbody>
                    {[
                      { role: 'PDC Emulator', holder: health.fsmo.pdcEmulator, desc: 'Time sync, password changes, account lockouts' },
                      { role: 'RID Master', holder: health.fsmo.ridMaster, desc: 'Allocates RID pools to DCs' },
                      { role: 'Infrastructure Master', holder: health.fsmo.infraMaster, desc: 'Manages cross-domain object references' },
                      { role: 'Schema Master', holder: health.fsmo.schemaMaster, desc: 'Controls AD schema modifications' },
                      { role: 'Domain Naming Master', holder: health.fsmo.namingMaster, desc: 'Manages domain additions/removals' },
                    ].map(({ role, holder, desc }, i, arr) => (
                      <tr key={role} style={{
                        borderBottom: i < arr.length - 1 ? '1px solid var(--border-weak)' : 'none',
                        background: i % 2 === 0 ? 'var(--bg-panel)' : 'var(--bg-panel-alt)',
                      }}>
                        <td className="px-4 py-2.5 w-52">
                          <div className="font-medium text-xs" style={{ color: 'var(--text-primary)' }}>{role}</div>
                          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{desc}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--accent-hex)' }}>
                          {holder || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Domain Controllers inventory */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                Domain Controllers ({health.dcs.length})
              </h3>
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-med)' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--bg-panel-alt)', borderBottom: '1px solid var(--border-med)' }}>
                      {['Name', 'IP Address', 'Site', 'OS', 'Flags'].map(h => (
                        <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide"
                          style={{ color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody style={{ background: 'var(--bg-panel)' }}>
                    {health.dcs.map((dc, i) => (
                      <tr key={dc.name} style={{ borderBottom: i < health.dcs.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{dc.name}</div>
                          <div className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{dc.hostname}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{dc.ip || '—'}</td>
                        <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{dc.site || '—'}</td>
                        <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>{dc.os || '—'}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1 flex-wrap">
                            {dc.isGlobalCatalog && (
                              <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: '#3b82f622', color: '#60a5fa', border: '1px solid #3b82f644' }}>GC</span>
                            )}
                            {dc.isReadOnly && (
                              <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: '#6b728022', color: '#9ca3af', border: '1px solid #6b728044' }}>RODC</span>
                            )}
                            {!dc.isGlobalCatalog && !dc.isReadOnly && (
                              <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: '#22c55e22', color: '#4ade80', border: '1px solid #22c55e44' }}>Writable</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Replication */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                  Replication Status
                  {health.replFailureCount === 0
                    ? <span className="text-xs font-medium normal-case" style={{ color: '#22c55e' }}>● No failures</span>
                    : <span className="text-xs font-medium normal-case" style={{ color: '#ef4444' }}>✕ {health.replFailureCount} failure(s)</span>
                  }
                </h3>
                <button onClick={runSync} disabled={syncBusy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium disabled:opacity-50 hover:opacity-80 transition-opacity"
                  style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
                  {syncBusy
                    ? <><span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid var(--border-med)', borderTopColor: 'var(--accent-hex)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Syncing…</>
                    : <>🔄 Force Sync</>
                  }
                </button>
              </div>

              {syncResult && (
                <div className="mb-3 px-3 py-2.5 rounded-lg border text-xs font-mono whitespace-pre-wrap break-all"
                  style={{
                    background: syncResult.ok ? '#22c55e11' : '#ef444411',
                    borderColor: syncResult.ok ? '#22c55e44' : '#ef444444',
                    color: syncResult.ok ? '#4ade80' : '#f87171',
                    maxHeight: 160,
                    overflowY: 'auto',
                  }}>
                  {syncResult.message}
                  {syncResult.ok && health.replFailureCount > 0 && (
                    <div className="mt-2 opacity-70 not-italic font-sans" style={{ fontFamily: 'inherit' }}>
                      ⚠ Failure records may take a few minutes to clear — AD tracks them until the next full replication cycle confirms everything is clean.
                    </div>
                  )}
                </div>
              )}

              {health.replFailDetail.length > 0 && (
                <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#ef444444' }}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: '#ef444411', borderBottom: '1px solid #ef444433' }}>
                        {['Partner', 'Last Error', 'Failures', 'First Seen'].map(h => (
                          <th key={h} className="px-4 py-2 text-left text-xs font-semibold" style={{ color: '#f87171' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {health.replFailDetail.map((f, i) => (
                        <tr key={i} style={{ borderBottom: i < health.replFailDetail.length - 1 ? '1px solid var(--border-weak)' : 'none', background: 'var(--bg-panel)' }}>
                          <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--text-primary)' }}>{f.partner}</td>
                          <td className="px-4 py-2 text-xs" style={{ color: '#f87171' }}>{f.lastError}</td>
                          <td className="px-4 py-2 text-xs font-semibold" style={{ color: '#f87171' }}>{f.failureCount}</td>
                          <td className="px-4 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>{f.firstFailure || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Password Policy */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                Default Domain Password Policy
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Min Length', value: String(health.passwordPolicy.minLength), warn: health.passwordPolicy.minLength < 8 },
                  { label: 'History', value: `${health.passwordPolicy.history} passwords`, warn: health.passwordPolicy.history < 5 },
                  { label: 'Max Age', value: health.passwordPolicy.maxAgeDays === 0 ? 'Never expires' : `${health.passwordPolicy.maxAgeDays} days`, warn: health.passwordPolicy.maxAgeDays === 0 },
                  { label: 'Complexity', value: health.passwordPolicy.complexityEnabled ? 'Enabled' : 'Disabled', warn: !health.passwordPolicy.complexityEnabled },
                  { label: 'Lockout After', value: health.passwordPolicy.lockoutThreshold === 0 ? 'Never' : `${health.passwordPolicy.lockoutThreshold} attempts`, warn: health.passwordPolicy.lockoutThreshold === 0 },
                  { label: 'Lockout Duration', value: health.passwordPolicy.lockoutDurationMinutes === 0 ? 'Manual unlock' : `${health.passwordPolicy.lockoutDurationMinutes} min`, warn: false },
                  { label: 'Min Age', value: health.passwordPolicy.minAgeDays === 0 ? 'No minimum' : `${health.passwordPolicy.minAgeDays} days`, warn: false },
                ].map(({ label, value, warn }) => (
                  <div key={label} className="rounded-lg border p-3"
                    style={{ background: 'var(--bg-panel-alt)', borderColor: warn ? '#eab30844' : 'var(--border-med)' }}>
                    <p className="text-xs mb-1" style={{ color: warn ? '#eab308' : 'var(--text-muted)' }}>{label}</p>
                    <p className="text-sm font-medium" style={{ color: warn ? '#eab308' : 'var(--text-primary)' }}>{value}</p>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  )
}

// ── Confirm Modal ─────────────────────────────────────────────────────────────

function ConfirmModal({ title, message, confirmLabel, danger, onConfirm, onClose }: {
  title: string; message: string; confirmLabel: string; danger?: boolean
  onConfirm: () => void; onClose: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="rounded-xl border p-6 w-[400px] space-y-4"
        style={{ background: 'var(--modal-bg)', borderColor: 'var(--modal-border)' }}>
        <h2 className="text-base font-bold" style={{ color: 'var(--text-heading)' }}>{title}</h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{message}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm border"
            style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ background: danger ? '#c0392b' : 'var(--btn-accent-bg)' }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

// ── User Detail Panel ─────────────────────────────────────────────────────────

function UserDetailPanel({ user, serverId }: { user: DomainUser; serverId: string }) {
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [groups, setGroups] = useState<AdGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [groupSearch, setGroupSearch] = useState('')
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    api.get<UserDetail>(`/domain/${serverId}/user-detail/${user.samAccountName}`)
      .then(d => setDetail(d))
      .catch(e => setError(e.data?.error ?? 'Failed to load details'))
      .finally(() => setLoading(false))
  }, [serverId, user.samAccountName])

  const loadGroups = async () => {
    if (groups.length > 0) { setShowAddGroup(true); return }
    setGroupsLoading(true)
    try {
      const g = await api.get<AdGroup[]>(`/domain/${serverId}/groups`)
      setGroups(g)
      setShowAddGroup(true)
    } catch { }
    setGroupsLoading(false)
  }

  const addToGroup = async (groupName: string) => {
    setActionBusy(groupName); setActionError('')
    try {
      await api.post(`/domain/${serverId}/add-to-group`, { samAccountName: user.samAccountName, groupName })
      setDetail(d => d ? { ...d, groups: [...d.groups, { name: groupName, scope: '', category: '' }] } : d)
      setShowAddGroup(false); setGroupSearch('')
    } catch (e: any) { setActionError(e.data?.error ?? 'Failed') }
    setActionBusy(null)
  }

  const removeFromGroup = async (groupName: string) => {
    setActionBusy(groupName); setActionError('')
    try {
      await api.post(`/domain/${serverId}/remove-from-group`, { samAccountName: user.samAccountName, groupName })
      setDetail(d => d ? { ...d, groups: d.groups.filter(g => g.name !== groupName) } : d)
    } catch (e: any) { setActionError(e.data?.error ?? 'Failed') }
    setActionBusy(null)
  }

  const filteredGroups = groups.filter(g =>
    !detail?.groups.some(ug => ug.name === g.name) &&
    g.name.toLowerCase().includes(groupSearch.toLowerCase())
  )

  if (loading) return (
    <td colSpan={6} className="px-6 py-4" style={{ background: 'var(--bg-panel-alt)' }}>
      <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading details…</span>
    </td>
  )

  if (error) return (
    <td colSpan={6} className="px-6 py-4" style={{ background: 'var(--bg-panel-alt)' }}>
      <span className="text-sm text-red-400">{error}</span>
    </td>
  )

  const privilegedGroups = detail?.groups.filter(g => PRIVILEGED_GROUPS.has(g.name)) ?? []
  const regularGroups = detail?.groups.filter(g => !PRIVILEGED_GROUPS.has(g.name)) ?? []

  return (
    <td colSpan={6} style={{ background: 'var(--bg-panel-alt)', borderBottom: '1px solid var(--border-med)' }}>
      <div className="px-6 py-4 space-y-4">

        {/* Info row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Title', value: detail?.title },
            { label: 'Department', value: detail?.department },
            { label: 'Description', value: detail?.description },
            { label: 'Bad Logon Count', value: detail?.badLogonCount != null ? String(detail.badLogonCount) : null },
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>{label}</p>
              <p className="text-sm" style={{ color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>{value || '—'}</p>
            </div>
          ))}
        </div>

        {/* Privileges */}
        {(detail?.adminCount || privilegedGroups.length > 0) && (
          <div>
            <p className="text-xs font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: '#f87171' }}>
              ⚠ Privileged Account
            </p>
            <div className="flex flex-wrap gap-1.5">
              {detail?.adminCount && <Badge label="AdminSDHolder Protected" color="#f87171" />}
              {privilegedGroups.map(g => <Badge key={g.name} label={g.name} color="#f87171" />)}
            </div>
          </div>
        )}

        {/* Group memberships */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Group Memberships ({detail?.groups.length ?? 0})
            </p>
            <button onClick={loadGroups} disabled={groupsLoading}
              className="text-xs px-2.5 py-1 rounded border transition-colors hover:opacity-80 disabled:opacity-50"
              style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
              {groupsLoading ? 'Loading…' : '+ Add to Group'}
            </button>
          </div>

          {/* Add group picker */}
          {showAddGroup && (
            <div className="mb-3 p-3 rounded-lg border space-y-2" style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)' }}>
              <div className="flex gap-2">
                <input value={groupSearch} onChange={e => setGroupSearch(e.target.value)}
                  placeholder="Search groups…" autoFocus
                  className="flex-1 px-3 py-1.5 rounded-lg border text-sm"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />
                <button onClick={() => { setShowAddGroup(false); setGroupSearch('') }}
                  className="px-3 py-1.5 rounded-lg border text-xs"
                  style={{ borderColor: 'var(--border-med)', color: 'var(--text-muted)' }}>✕</button>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {filteredGroups.slice(0, 50).map(g => (
                  <div key={g.name} className="flex items-center justify-between px-2 py-1 rounded hover:bg-black/10 dark:hover:bg-white/5">
                    <div>
                      <span className="text-sm" style={{ color: PRIVILEGED_GROUPS.has(g.name) ? '#f87171' : 'var(--text-primary)' }}>
                        {PRIVILEGED_GROUPS.has(g.name) && '⚠ '}{g.name}
                      </span>
                      {g.description && <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>{g.description}</span>}
                    </div>
                    <button onClick={() => addToGroup(g.name)} disabled={actionBusy === g.name}
                      className="text-xs px-2 py-0.5 rounded border disabled:opacity-50"
                      style={{ borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
                      {actionBusy === g.name ? '…' : '+ Add'}
                    </button>
                  </div>
                ))}
                {filteredGroups.length === 0 && <p className="text-xs px-2 py-1" style={{ color: 'var(--text-muted)' }}>No groups found.</p>}
              </div>
            </div>
          )}

          {actionError && <p className="text-xs text-red-400 mb-2">{actionError}</p>}

          <div className="flex flex-wrap gap-1.5">
            {detail?.groups.length === 0 && (
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>No group memberships.</span>
            )}
            {regularGroups.map(g => (
              <span key={g.name} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full border text-xs"
                style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)', color: 'var(--text-secondary)' }}>
                {g.name}
                <button onClick={() => removeFromGroup(g.name)} disabled={actionBusy === g.name}
                  className="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full hover:bg-red-500/20 hover:text-red-400 disabled:opacity-40 transition-colors"
                  style={{ color: 'var(--text-muted)' }}>
                  {actionBusy === g.name ? '…' : '×'}
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
    </td>
  )
}

// ── User Row ──────────────────────────────────────────────────────────────────

function UserRow({ user, serverId, onRefresh }: {
  user: DomainUser; serverId: string; onRefresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showReset, setShowReset] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const action = async (fn: () => Promise<any>) => {
    setBusy(true); setError('')
    try { await fn(); onRefresh() }
    catch (e: any) { setError(e.data?.error ?? e.message ?? 'Failed') }
    setBusy(false)
  }

  const unlock = () => action(() => api.post(`/domain/${serverId}/unlock`, { samAccountName: user.samAccountName }))
  const toggleEnabled = () => action(() => api.post(`/domain/${serverId}/set-enabled`, { samAccountName: user.samAccountName, enabled: !user.enabled }))
  const toggleNeverExpires = () => action(() => api.post(`/domain/${serverId}/set-password-never-expires`, { samAccountName: user.samAccountName, value: !user.passwordNeverExpires }))

  return (
    <>
      <tr className="border-b transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
        style={{ borderColor: 'var(--border-weak)' }}>

        {/* Expand toggle */}
        <td className="px-3 py-3 w-8">
          <button onClick={() => setExpanded(v => !v)}
            className="w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-black/10 dark:hover:bg-white/10 text-xs"
            style={{ color: 'var(--text-muted)' }}>
            {expanded ? '▼' : '▶'}
          </button>
        </td>

        {/* User info */}
        <td className="px-4 py-3">
          <div className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{user.displayName}</div>
          <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{user.samAccountName}</div>
          {user.email && <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{user.email}</div>}
        </td>

        {/* Status badges */}
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {!user.enabled && <Badge label="Disabled" color="#ef4444" />}
            {user.lockedOut && <Badge label="Locked" color="#f97316" />}
            {user.passwordExpired && <Badge label="Pwd Expired" color="#eab308" />}
            {user.mustChangePassword && <Badge label="Must Change" color="#a855f7" />}
            {user.passwordNeverExpires && <Badge label="Never Expires" color="#6b7280" />}
            {user.enabled && !user.lockedOut && !user.passwordExpired && !user.mustChangePassword && (
              <Badge label="OK" color="#22c55e" />
            )}
          </div>
        </td>

        {/* Password last set */}
        <td className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <div>{user.passwordLastSet ?? '—'}</div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{timeAgo(user.passwordLastSet)}</div>
        </td>

        {/* Last logon */}
        <td className="px-4 py-3 text-sm">
          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{timeAgo(user.lastLogonDate)}</div>
          {user.lastLogonDate && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{user.lastLogonDate}</div>}
        </td>

        {/* OU */}
        <td className="px-4 py-3 max-w-[160px]">
          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }} title={user.ou ?? ''}>
            {ouLabel(user.ou)}
          </div>
        </td>

        {/* Actions */}
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {user.lockedOut && (
              <button onClick={unlock} disabled={busy}
                className="px-2.5 py-1 rounded text-xs font-medium text-white disabled:opacity-50 hover:opacity-90"
                style={{ background: '#f97316' }}>🔓 Unlock</button>
            )}
            <button onClick={() => setShowReset(true)}
              className="px-2.5 py-1 rounded text-xs font-medium border hover:opacity-80"
              style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
              🔑 Reset Pwd
            </button>
            <button onClick={() => setConfirmDisable(true)} disabled={busy}
              className="px-2.5 py-1 rounded text-xs font-medium border hover:opacity-80 disabled:opacity-50"
              style={{
                background: user.enabled ? '#7f1d1d22' : '#14532d22',
                borderColor: user.enabled ? '#f8714844' : '#4ade8044',
                color: user.enabled ? '#f87171' : '#4ade80',
              }}>
              {user.enabled ? '🚫 Disable' : '✅ Enable'}
            </button>
            <button onClick={toggleNeverExpires} disabled={busy}
              className="px-2.5 py-1 rounded text-xs font-medium border hover:opacity-80 disabled:opacity-50"
              style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-muted)' }}
              title={user.passwordNeverExpires ? 'Remove never-expires' : 'Set never expires'}>
              {user.passwordNeverExpires ? '♻ Set Expiry' : '∞ Never Exp'}
            </button>
          </div>
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
        </td>
      </tr>

      {/* Detail panel row */}
      {expanded && (
        <tr style={{ borderColor: 'var(--border-weak)' }}>
          <td /> {/* expand toggle column */}
          <UserDetailPanel user={user} serverId={serverId} />
        </tr>
      )}

      {showReset && (
        <ResetPasswordModal user={user} serverId={serverId}
          onClose={() => setShowReset(false)}
          onDone={() => { setShowReset(false); onRefresh() }} />
      )}
      {confirmDisable && (
        <ConfirmModal
          title={user.enabled ? 'Disable Account' : 'Enable Account'}
          message={user.enabled
            ? `This will prevent ${user.displayName} (${user.samAccountName}) from logging in.`
            : `This will allow ${user.displayName} (${user.samAccountName}) to log in again.`}
          confirmLabel={user.enabled ? 'Disable' : 'Enable'}
          danger={user.enabled}
          onConfirm={() => { setConfirmDisable(false); toggleEnabled() }}
          onClose={() => setConfirmDisable(false)} />
      )}
    </>
  )
}

// ── Groups Panel ──────────────────────────────────────────────────────────────

function GroupsPanel({ serverId }: { serverId: string }) {
  const [groups, setGroups] = useState<AdGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newScope, setNewScope] = useState<'Global' | 'Universal' | 'DomainLocal'>('Global')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [members, setMembers] = useState<Record<string, AdGroupMember[]>>({})
  const [membersLoading, setMembersLoading] = useState<string | null>(null)
  const [addSam, setAddSam] = useState<Record<string, string>>({})
  const [addBusy, setAddBusy] = useState<string | null>(null)
  const [addError, setAddError] = useState<Record<string, string>>({})
  const [removeBusy, setRemoveBusy] = useState<string | null>(null)
  const [editGroup, setEditGroup] = useState<AdGroup | null>(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleteInput, setDeleteInput] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const g = await api.get<AdGroup[]>(`/domain/${serverId}/groups`)
      setGroups(g)
    } catch (e: any) { setError(e.data?.error ?? 'Failed to load groups') }
    setLoading(false)
  }

  useEffect(() => { load() }, [serverId]) // eslint-disable-line react-hooks/exhaustive-deps

  const createGroup = async () => {
    if (!newName.trim()) return
    setCreating(true); setCreateError('')
    try {
      await api.post(`/domain/${serverId}/create-group`, { name: newName.trim(), scope: newScope, description: newDesc.trim() || undefined })
      setNewName(''); setNewDesc(''); setShowCreate(false)
      await load()
    } catch (e: any) { setCreateError(e.data?.error ?? 'Failed to create group') }
    setCreating(false)
  }

  const deleteGroup = async (name: string) => {
    if (deleteInput !== name) return
    setDeleteBusy(true); setDeleteError('')
    try {
      await api.post(`/domain/${serverId}/delete-group`, { groupName: name })
      setConfirmDelete(null); setDeleteInput('')
      setGroups(g => g.filter(x => x.name !== name))
      if (expandedGroup === name) setExpandedGroup(null)
    } catch (e: any) { setDeleteError(e.data?.error ?? 'Failed to delete group') }
    setDeleteBusy(false)
  }

  const loadMembers = async (groupName: string) => {
    if (members[groupName]) return
    setMembersLoading(groupName)
    try {
      const res = await api.get<{ members: AdGroupMember[] }>(`/domain/${serverId}/group-members?groupName=${encodeURIComponent(groupName)}`)
      setMembers(m => ({ ...m, [groupName]: res.members }))
    } catch { setMembers(m => ({ ...m, [groupName]: [] })) }
    setMembersLoading(null)
  }

  const openEdit = (g: AdGroup) => {
    setEditGroup(g); setEditName(g.name); setEditDesc(g.description ?? ''); setEditError('')
  }

  const saveEdit = async () => {
    if (!editGroup) return
    setEditBusy(true); setEditError('')
    try {
      await api.post(`/domain/${serverId}/update-group`, {
        currentName: editGroup.name,
        newName: editName !== editGroup.name ? editName : undefined,
        description: editDesc,
      })
      setGroups(gs => gs.map(g => g.name === editGroup.name ? { ...g, name: editName, description: editDesc } : g))
      if (expandedGroup === editGroup.name && editName !== editGroup.name) setExpandedGroup(editName)
      setEditGroup(null)
    } catch (e: any) { setEditError(e.data?.error ?? 'Failed to update group') }
    setEditBusy(false)
  }

  const toggleExpand = (name: string) => {
    if (expandedGroup === name) { setExpandedGroup(null); return }
    setExpandedGroup(name)
    loadMembers(name)
  }

  const addMember = async (groupName: string) => {
    const sam = (addSam[groupName] ?? '').trim()
    if (!sam) return
    setAddBusy(groupName); setAddError(e => ({ ...e, [groupName]: '' }))
    try {
      await api.post(`/domain/${serverId}/add-to-group`, { samAccountName: sam, groupName })
      setMembers(m => ({ ...m, [groupName]: [...(m[groupName] ?? []), { samAccountName: sam, name: sam, type: 'user' }] }))
      setAddSam(s => ({ ...s, [groupName]: '' }))
    } catch (e: any) { setAddError(err => ({ ...err, [groupName]: e.data?.error ?? 'Failed' })) }
    setAddBusy(null)
  }

  const removeMember = async (groupName: string, sam: string) => {
    setRemoveBusy(sam)
    try {
      await api.post(`/domain/${serverId}/remove-from-group`, { samAccountName: sam, groupName })
      setMembers(m => ({ ...m, [groupName]: (m[groupName] ?? []).filter(x => x.samAccountName !== sam) }))
    } catch (e: any) { alert(e.data?.error ?? 'Failed') }
    setRemoveBusy(null)
  }

  const nonPrivileged = groups.filter(g => !PRIVILEGED_GROUPS.has(g.name))
  const privilegedCount = groups.length - nonPrivileged.length
  const filtered = nonPrivileged.filter(g =>
    g.name.toLowerCase().includes(search.toLowerCase()) ||
    (g.description ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search groups…"
          className="px-3 py-2 rounded-lg border text-sm w-64"
          style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />
        <span className="text-sm ml-auto" style={{ color: 'var(--text-muted)' }}>
          {filtered.length} group{filtered.length !== 1 ? 's' : ''}
          {privilegedCount > 0 && <> · <span style={{ color: '#f87171' }}>{privilegedCount} privileged (read-only)</span></>}
        </span>
        <button onClick={() => setShowCreate(v => !v)}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ background: 'var(--btn-accent-bg)' }}>
          + Create Group
        </button>
        <button onClick={load} disabled={loading}
          className="px-3 py-2 rounded-lg text-sm border disabled:opacity-50 hover:opacity-80"
          style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
          ↺
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="rounded-xl border p-4 space-y-3" style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-heading)' }}>New Security Group</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>Group Name *</label>
              <input value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="e.g. IT-Helpdesk"
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>Scope</label>
              <select value={newScope} onChange={e => setNewScope(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }}>
                <option value="Global">Global</option>
                <option value="Universal">Universal</option>
                <option value="DomainLocal">Domain Local</option>
              </select>
            </div>
            <div className="sm:col-span-3">
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>Description (optional)</label>
              <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
                placeholder="Group description"
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />
            </div>
          </div>
          {createError && <p className="text-xs text-red-400">{createError}</p>}
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowCreate(false); setCreateError(''); setNewName(''); setNewDesc('') }}
              className="px-4 py-2 rounded-lg text-sm border"
              style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>Cancel</button>
            <button onClick={createGroup} disabled={creating || !newName.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--btn-accent-bg)' }}>
              {creating ? 'Creating…' : 'Create Group'}
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && <p className="text-sm text-red-400 px-1">{error}</p>}

      {/* Group list */}
      {loading ? (
        <div className="flex flex-col items-center gap-3 py-16">
          <div style={{ width: 28, height: 28, border: '3px solid var(--border-med)', borderTopColor: 'var(--accent-hex)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading groups…</span>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-med)' }}>
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-sm text-center" style={{ color: 'var(--text-muted)' }}>
              {search ? 'No groups match your search.' : 'No non-privileged groups found.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--bg-panel-alt)', borderBottom: '1px solid var(--border-med)' }}>
                  <th className="w-8" />
                  {['Group Name', 'Scope', 'Description', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide"
                      style={{ color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody style={{ background: 'var(--bg-panel)' }}>
                {filtered.map((g) => (
                  <React.Fragment key={g.name}>
                    <tr className="border-b transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                      style={{ borderColor: 'var(--border-weak)' }}>
                      <td className="px-3 py-3 w-8">
                        <button onClick={() => toggleExpand(g.name)}
                          className="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors hover:bg-black/10 dark:hover:bg-white/10"
                          style={{ color: 'var(--text-muted)' }}>
                          {expandedGroup === g.name ? '▼' : '▶'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{g.name}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded font-medium"
                          style={{ background: 'var(--bg-panel-alt)', color: 'var(--text-muted)', border: '1px solid var(--border-weak)' }}>
                          {g.scope}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs max-w-xs" style={{ color: 'var(--text-muted)' }}>
                        {g.description || '—'}
                      </td>
                      <td className="px-4 py-3">
                        {DEFAULT_WINDOWS_GROUPS.has(g.name) ? (
                          <span className="text-xs px-2 py-0.5 rounded"
                            style={{ background: 'var(--bg-panel-alt)', color: 'var(--text-muted)', border: '1px solid var(--border-weak)' }}>
                            Built-in
                          </span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => openEdit(g)}
                              className="px-2.5 py-1 rounded text-xs font-medium border hover:opacity-80 transition-opacity"
                              style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
                              ✏️ Edit
                            </button>
                            <button onClick={() => { setConfirmDelete(g.name); setDeleteInput(''); setDeleteError('') }}
                              className="px-2.5 py-1 rounded text-xs font-medium border hover:opacity-80 transition-opacity"
                              style={{ background: '#7f1d1d22', borderColor: '#f8714844', color: '#f87171' }}>
                              🗑 Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>

                    {/* Expanded members panel */}
                    {expandedGroup === g.name && (
                      <tr key={g.name + '-members'} style={{ borderBottom: '1px solid var(--border-med)' }}>
                        <td />
                        <td colSpan={4} style={{ background: 'var(--bg-panel-alt)', padding: '16px 20px' }}>
                          <div className="space-y-3">
                            <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                              Members {members[g.name] ? `(${members[g.name].length})` : ''}
                            </p>

                            {/* Add member */}
                            <div className="flex gap-2">
                              <input
                                value={addSam[g.name] ?? ''}
                                onChange={e => setAddSam(s => ({ ...s, [g.name]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') addMember(g.name) }}
                                placeholder="SAM account name (e.g. john.doe)"
                                className="flex-1 px-3 py-1.5 rounded-lg border text-sm"
                                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />
                              <button onClick={() => addMember(g.name)}
                                disabled={addBusy === g.name || !(addSam[g.name] ?? '').trim()}
                                className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                                style={{ background: 'var(--btn-accent-bg)' }}>
                                {addBusy === g.name ? '…' : '+ Add'}
                              </button>
                            </div>
                            {addError[g.name] && <p className="text-xs text-red-400">{addError[g.name]}</p>}

                            {/* Member list */}
                            {membersLoading === g.name ? (
                              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading members…</p>
                            ) : (members[g.name] ?? []).length === 0 ? (
                              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No members.</p>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {(members[g.name] ?? []).map(m => (
                                  <span key={m.samAccountName}
                                    className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full border text-xs"
                                    style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)', color: 'var(--text-secondary)' }}>
                                    {m.type === 'group' ? '👥 ' : m.type === 'computer' ? '🖥 ' : '👤 '}
                                    {m.samAccountName}
                                    <button onClick={() => removeMember(g.name, m.samAccountName)}
                                      disabled={removeBusy === m.samAccountName}
                                      className="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full hover:bg-red-500/20 hover:text-red-400 disabled:opacity-40 transition-colors"
                                      style={{ color: 'var(--text-muted)' }}>
                                      {removeBusy === m.samAccountName ? '…' : '×'}
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Edit group modal */}
      {editGroup && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="rounded-xl border p-6 w-[440px] space-y-4"
            style={{ background: 'var(--modal-bg)', borderColor: 'var(--modal-border)' }}>
            <h2 className="text-base font-bold" style={{ color: 'var(--text-heading)' }}>✏️ Edit Group</h2>
            <div>
              <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>Group Name</label>
              <input value={editName} onChange={e => setEditName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>Description</label>
              <input value={editDesc} onChange={e => setEditDesc(e.target.value)}
                placeholder="Optional description"
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />
            </div>
            {editError && <p className="text-xs text-red-400">{editError}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => setEditGroup(null)}
                className="px-4 py-2 rounded-lg text-sm border"
                style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
                Cancel
              </button>
              <button onClick={saveEdit} disabled={editBusy || !editName.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--btn-accent-bg)' }}>
                {editBusy ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Type-to-confirm delete dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="rounded-xl border p-6 w-[440px] space-y-4"
            style={{ background: 'var(--modal-bg)', borderColor: 'var(--modal-border)' }}>
            <div className="flex items-start gap-3">
              <span className="text-xl mt-0.5">🗑</span>
              <div>
                <h2 className="text-base font-bold" style={{ color: 'var(--text-heading)' }}>Delete Group</h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  This will permanently delete the group from Active Directory. Members will <strong>not</strong> be deleted.
                </p>
              </div>
            </div>
            <div className="px-3 py-2 rounded-lg border font-mono text-sm"
              style={{ background: '#7f1d1d22', borderColor: '#f8714844', color: '#f87171' }}>
              {confirmDelete}
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Type the group name to confirm:
              </label>
              <input
                autoFocus
                value={deleteInput}
                onChange={e => { setDeleteInput(e.target.value); setDeleteError('') }}
                onKeyDown={e => { if (e.key === 'Enter' && deleteInput === confirmDelete) deleteGroup(confirmDelete) }}
                placeholder={confirmDelete}
                className="w-full px-3 py-2 rounded-lg border text-sm font-mono"
                style={{ background: 'var(--input-bg)', borderColor: deleteInput && deleteInput !== confirmDelete ? '#f87171' : 'var(--input-border)', color: 'var(--input-text)' }} />
              {deleteInput && deleteInput !== confirmDelete && (
                <p className="text-xs text-red-400 mt-1">Name does not match.</p>
              )}
            </div>
            {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => { setConfirmDelete(null); setDeleteInput(''); setDeleteError('') }}
                className="px-4 py-2 rounded-lg text-sm border"
                style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
                Cancel
              </button>
              <button
                onClick={() => deleteGroup(confirmDelete)}
                disabled={deleteInput !== confirmDelete || deleteBusy}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40"
                style={{ background: '#c0392b' }}>
                {deleteBusy ? 'Deleting…' : 'Delete Group'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Domain() {
  const [servers, setServers] = useState<DcServer[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [tab, setTab] = useState<Tab>('locked')
  const [search, setSearch] = useState('')
  const [ouFilter, setOuFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [allUsers, setAllUsers] = useState<DomainUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [showHealth, setShowHealth] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadUsers = useCallback(async (serverId: string, currentTab: Tab) => {
    if (!serverId) return
    setLoading(true); setError('')
    try {
      const res = await api.get<{ users: DomainUser[]; total: number }>(
        `/domain/${serverId}/users?filter=${currentTab}`
      )
      setAllUsers(res.users)
      setTotal(res.total)
      setLastRefresh(new Date())
      setOuFilter('')
      setStatusFilter([])
    } catch (e: any) {
      setError(e.data?.error ?? e.message ?? 'Failed to load users')
      setAllUsers([])
    }
    setLoading(false)
  }, [])

  // Keep a ref so the mount effect always calls the latest version without being in its dep array
  const loadUsersRef = useRef(loadUsers)
  loadUsersRef.current = loadUsers

  const load = useCallback(() => loadUsers(selectedId, tab), [selectedId, tab, loadUsers])

  // Load DC list then auto-connect — runs once on mount
  useEffect(() => {
    api.get<DcServer[]>('/domain/servers').then(list => {
      setServers(list)
      if (list.length > 0) {
        const firstId = list[0].id
        setSelectedId(firstId)
        loadUsersRef.current(firstId, 'locked')
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reload when tab or server changes (skip initial empty selectedId)
  useEffect(() => {
    if (!selectedId) return
    if (tab === 'sessions' || tab === 'computers' || tab === 'groups') return
    loadUsers(selectedId, tab)
  }, [tab, selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side filtering for All Users tab
  const uniqueOUs = Array.from(new Set(allUsers.map(u => u.ou).filter(Boolean) as string[])).sort()

  const STATUS_OPTIONS = [
    { key: 'locked',       label: 'Locked',       check: (u: DomainUser) => u.lockedOut },
    { key: 'expired',      label: 'Pwd Expired',  check: (u: DomainUser) => u.passwordExpired },
    { key: 'must_change',  label: 'Must Change',  check: (u: DomainUser) => u.mustChangePassword },
    { key: 'never_expires',label: 'Never Expires',check: (u: DomainUser) => u.passwordNeverExpires },
  ]

  const filteredUsers = allUsers.filter(u => {
    if (search) {
      const q = search.toLowerCase()
      if (!u.samAccountName.toLowerCase().includes(q) &&
          !u.displayName.toLowerCase().includes(q) &&
          !(u.email ?? '').toLowerCase().includes(q)) return false
    }
    if (ouFilter && u.ou !== ouFilter) return false
    if (statusFilter.length > 0) {
      const match = statusFilter.some(k => STATUS_OPTIONS.find(s => s.key === k)?.check(u))
      if (!match) return false
    }
    return true
  })

  const selectedServer = servers.find(s => s.id === selectedId)

  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState('')

  const loadSessions = useCallback(async (serverId: string) => {
    setSessionsLoading(true)
    setSessionsError('')
    try {
      const res = await api.get<{ sessions: Session[] }>(`/domain/${serverId}/sessions`)
      setSessions(res.sessions)
    } catch (err: unknown) {
      setSessionsError((err as Error).message)
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  const [computers, setComputers] = useState<AdComputer[]>([])
  const [computersLoading, setComputersLoading] = useState(false)
  const [computersError, setComputersError] = useState('')
  const [pingingAll, setPingingAll] = useState(false)
  const [psexecTarget, setPsexecTarget] = useState<AdComputer | null>(null)
  const [computerActionBusy, setComputerActionBusy] = useState<string | null>(null)
  const [confirmDeleteComputer, setConfirmDeleteComputer] = useState<string | null>(null)
  const [deleteComputerInput, setDeleteComputerInput] = useState('')
  const [deleteComputerBusy, setDeleteComputerBusy] = useState(false)
  const [deleteComputerError, setDeleteComputerError] = useState('')

  const loadComputers = useCallback(async (serverId: string) => {
    setComputersLoading(true); setComputersError('')
    try {
      const res = await api.get<{ computers: AdComputer[] }>(`/domain/${serverId}/computers`)
      setComputers(res.computers)
    } catch (err: unknown) {
      setComputersError((err as Error).message)
    } finally {
      setComputersLoading(false)
    }
  }, [])

  const pingAllComputers = useCallback(async (list: AdComputer[]) => {
    const hosts = list.map(c => c.IPv4Address ?? c.DNSHostName ?? c.Name).filter(Boolean) as string[]
    if (!hosts.length) return
    setPingingAll(true)
    try {
      const res = await api.post<{ results: { host: string; online: boolean }[] }>('/psexec/ping-many', { hosts })
      const map = Object.fromEntries(res.results.map(r => [r.host, r.online]))
      setComputers(prev => prev.map(c => {
        const host = c.IPv4Address ?? c.DNSHostName ?? c.Name
        return { ...c, online: host ? map[host] : undefined }
      }))
    } finally {
      setPingingAll(false)
    }
  }, [])

  const tabConfig: { key: Tab; label: string; color: string }[] = [
    { key: 'locked',          label: '🔴 Locked',          color: '#f97316' },
    { key: 'password_issues', label: '⚠️ Password Issues',  color: '#eab308' },
    { key: 'disabled',        label: '🚫 Disabled',         color: '#ef4444' },
    { key: 'all',             label: '👥 All Users',        color: 'var(--accent-hex)' },
    { key: 'groups',          label: '🗂 Groups',            color: '#a78bfa' },
    { key: 'sessions',        label: '🟢 Active Sessions',  color: '#22c55e' },
    { key: 'computers',       label: '🖥 Computers',         color: '#818cf8' },
  ]

  // Auto-ping once computers load
  useEffect(() => {
    if (tab === 'computers' && computers.length > 0 && !pingingAll) {
      pingAllComputers(computers)
    }
  }, [computers]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleStatus = (key: string) =>
    setStatusFilter(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])

  const handleSearch = (val: string) => {
    setSearch(val)
    if (searchTimer.current) clearTimeout(searchTimer.current)
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-heading)' }}>🏢 Domain Manager</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Manage Active Directory user accounts on your domain controllers
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {servers.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No domain controllers configured. Edit a Windows server and enable the 🏢 Domain Controller option.</p>
          ) : (
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Domain Controller</label>
              <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
                className="rounded-lg px-3 py-2 text-sm border"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }}>
                {servers.map(s => <option key={s.id} value={s.id}>{s.name}{s.tags?.domain_name ? ` — ${s.tags.domain_name}` : ` (${s.hostname})`}</option>)}
              </select>
            </div>
          )}
          <button onClick={() => { setShowHealth(v => !v) }} disabled={!selectedId}
            className="px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50 hover:opacity-80"
            style={showHealth
              ? { background: 'var(--btn-accent-bg)', borderColor: 'var(--btn-accent-border)', color: 'var(--btn-accent-text)' }
              : { background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
            🩺 Health
          </button>
          <button onClick={load} disabled={loading || !selectedId}
            className="px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50 hover:opacity-80"
            style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
            {loading ? '⏳ Loading…' : '↺ Refresh'}
          </button>
        </div>
      </div>

      {/* Domain info bar */}
      {selectedServer && (
        <div className="flex items-center gap-4 px-4 py-2.5 rounded-xl border text-sm flex-wrap"
          style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)' }}>
          <span style={{ color: 'var(--text-muted)' }}>DC:</span>
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{selectedServer.name}</span>
          {selectedServer.tags?.domain_name && <>
            <span style={{ color: 'var(--border-med)' }}>·</span>
            <span className="font-mono text-xs font-semibold" style={{ color: 'var(--accent-hex)' }}>{selectedServer.tags.domain_name}</span>
          </>}
          <span style={{ color: 'var(--border-med)' }}>·</span>
          <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{selectedServer.hostname}</span>
          {lastRefresh && (<>
            <span style={{ color: 'var(--border-med)' }}>·</span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Refreshed {lastRefresh.toLocaleTimeString()}</span>
          </>)}
          {!loading && total > 0 && (<>
            <span style={{ color: 'var(--border-med)' }}>·</span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{total} total users in domain</span>
          </>)}
        </div>
      )}

      {/* Health Panel */}
      {showHealth && selectedId && (
        <HealthPanel serverId={selectedId} onClose={() => setShowHealth(false)} />
      )}

      {/* Tabs */}
      <div className="flex text-sm">
        {tabConfig.map((t, i, arr) => (
          <button key={t.key} onClick={() => {
            setTab(t.key)
            if (t.key === 'sessions' && selectedId) loadSessions(selectedId)
            if (t.key === 'computers' && selectedId) loadComputers(selectedId)
          }}
            className={[
              'px-4 py-2 border-y border-r font-medium transition-colors',
              i === 0 ? 'border-l rounded-l-lg' : '',
              i === arr.length - 1 ? 'rounded-r-lg' : '',
            ].join(' ')}
            style={tab === t.key
              ? { background: t.color + '22', color: t.color, borderColor: t.color + '66' }
              : { background: 'var(--bg-panel)', color: 'var(--text-secondary)', borderColor: 'var(--border-med)' }
            }>
            {t.label}
          </button>
        ))}
      </div>

      {/* Groups Panel */}
      {tab === 'groups' && selectedId && <GroupsPanel serverId={selectedId} />}

      {/* Filters + table (user tabs only) */}
      {tab !== 'groups' && tab !== 'sessions' && tab !== 'computers' && (<>
        <div className="flex items-center gap-3 flex-wrap">
          <input value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="Search by name, SAM, or email…"
            className="px-3 py-2 rounded-lg border text-sm w-64"
            style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }} />

          {uniqueOUs.length > 0 && (
            <select value={ouFilter} onChange={e => setOuFilter(e.target.value)}
              className="px-3 py-2 rounded-lg border text-sm"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--input-text)' }}>
              <option value="">All OUs</option>
              {uniqueOUs.map(ou => <option key={ou} value={ou}>{ouLabel(ou)}</option>)}
            </select>
          )}

          {tab === 'all' && (
            <div className="flex gap-1.5 flex-wrap">
              {STATUS_OPTIONS.map(s => (
                <button key={s.key} onClick={() => toggleStatus(s.key)}
                  className="px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors"
                  style={statusFilter.includes(s.key)
                    ? { background: 'var(--accent-hex)', color: '#fff', borderColor: 'var(--accent-hex)' }
                    : { background: 'var(--bg-panel)', borderColor: 'var(--border-med)', color: 'var(--text-secondary)' }
                  }>{s.label}</button>
              ))}
            </div>
          )}

          {filteredUsers.length > 0 && (
            <span className="text-sm ml-auto" style={{ color: 'var(--text-muted)' }}>
              {filteredUsers.length}{allUsers.length !== filteredUsers.length ? ` / ${allUsers.length}` : ''} users
            </span>
          )}
        </div>

        {error && (
          <div className="px-4 py-3 rounded-xl border border-red-800/40 bg-red-900/10 text-red-400 text-sm space-y-1">
            <p className="font-medium">Failed to connect to domain controller</p>
            <p className="text-xs font-mono opacity-80">{error}</p>
            <p className="text-xs opacity-70">Make sure the AD PowerShell module (RSAT-AD-PowerShell) is installed on the DC and the management user has AD read/write permissions.</p>
          </div>
        )}

        {!error && (
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-med)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--bg-panel-alt)', borderBottom: '1px solid var(--border-med)' }}>
                  <th className="w-8" />
                  {['User', 'Status', 'Pwd Last Set', 'Last Logon', 'OU', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide"
                      style={{ color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody style={{ background: 'var(--bg-panel)' }}>
                {loading ? (
                  <tr><td colSpan={7} className="px-4 py-16 text-center" style={{ color: 'var(--text-muted)' }}>
                    <div className="flex flex-col items-center gap-2">
                      <div style={{ width: 28, height: 28, border: '3px solid var(--border-med)', borderTopColor: 'var(--accent-hex)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                      <span className="text-sm">Querying domain controller…</span>
                    </div>
                  </td></tr>
                ) : filteredUsers.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-16 text-center" style={{ color: 'var(--text-muted)' }}>
                    {tab === 'locked' && '✅ No locked accounts'}
                    {tab === 'disabled' && '✅ No disabled accounts'}
                    {tab === 'password_issues' && '✅ No password issues'}
                    {tab === 'all' && (search || ouFilter || statusFilter.length > 0 ? 'No users match your filters.' : 'No users found.')}
                  </td></tr>
                ) : (
                  filteredUsers.map(u => (
                    <UserRow key={u.samAccountName} user={u} serverId={selectedId} onRefresh={load} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </>)}

      {/* Sessions Panel */}
      {tab === 'sessions' && selectedId && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-med)' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)' }}>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Active Sessions on DC</span>
            <button onClick={() => loadSessions(selectedId)} disabled={sessionsLoading}
              className="px-3 py-1 text-xs rounded-lg border transition-colors disabled:opacity-50"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-med)', color: 'var(--text-secondary)' }}>
              {sessionsLoading ? '⏳ Loading…' : '🔄 Refresh'}
            </button>
          </div>
          {sessionsError ? (
            <div className="px-4 py-6 text-sm text-center" style={{ color: 'var(--text-muted)' }}>{sessionsError}</div>
          ) : sessionsLoading ? (
            <div className="px-4 py-10 flex flex-col items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <div style={{ width: 28, height: 28, border: '3px solid var(--border-med)', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <span className="text-sm">Querying sessions…</span>
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-4 py-10 text-sm text-center" style={{ color: 'var(--text-muted)' }}>No active sessions found</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                  <th className="px-4 py-2 text-left">Username</th>
                  <th className="px-4 py-2 text-left">Session</th>
                  <th className="px-4 py-2 text-left">ID</th>
                  <th className="px-4 py-2 text-left">State</th>
                  <th className="px-4 py-2 text-left">Idle Time</th>
                </tr>
              </thead>
              <tbody style={{ background: 'var(--bg-panel)' }}>
                {sessions.map((s, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border-weak)' }}>
                    <td className="px-4 py-3 font-mono font-medium" style={{ color: 'var(--text-primary)' }}>{s.username}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{s.sessionName || '—'}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-muted)' }}>{s.id}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium"
                        style={s.state === 'Active'
                          ? { background: 'rgba(34,197,94,0.15)', color: '#22c55e' }
                          : { background: 'rgba(234,179,8,0.15)', color: '#eab308' }}>
                        {s.state}
                      </span>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-muted)' }}>{s.idleTime || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Computers Panel */}
      {tab === 'computers' && selectedId && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-med)' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-med)' }}>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              AD Computers {computers.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({computers.length})</span>}
            </span>
            <div className="flex items-center gap-2">
              {pingingAll && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>⏳ Pinging…</span>}
              <button onClick={() => loadComputers(selectedId)} disabled={computersLoading}
                className="px-3 py-1 text-xs rounded-lg border transition-colors disabled:opacity-50"
                style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-med)', color: 'var(--text-secondary)' }}>
                {computersLoading ? '⏳ Loading…' : '🔄 Refresh'}
              </button>
            </div>
          </div>
          {computersError ? (
            <div className="px-4 py-6 text-sm text-center" style={{ color: 'var(--text-muted)' }}>{computersError}</div>
          ) : computersLoading ? (
            <div className="px-4 py-10 flex flex-col items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <div style={{ width: 28, height: 28, border: '3px solid var(--border-med)', borderTopColor: '#818cf8', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <span className="text-sm">Querying Active Directory…</span>
            </div>
          ) : computers.length === 0 ? (
            <div className="px-4 py-10 text-sm text-center" style={{ color: 'var(--text-muted)' }}>No computers found</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">IP Address</th>
                  <th className="px-4 py-2 text-left">OS</th>
                  <th className="px-4 py-2 text-left">Last Logon</th>
                  <th className="px-4 py-2 text-left">Action</th>
                </tr>
              </thead>
              <tbody style={{ background: 'var(--bg-panel)' }}>
                {computers.map((c, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border-weak)' }}>
                    <td className="px-4 py-3">
                      {c.online === undefined ? (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : c.online ? (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>● Online</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>● Offline</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {c.Name}
                        {c.IsDomainController && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#818cf822', color: '#818cf8', border: '1px solid #818cf844' }}>DC</span>}
                        {!c.Enabled && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>Disabled</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{c.IPv4Address || '—'}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>{c.OperatingSystem || '—'}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {c.LastLogonDate || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          disabled={!c.online}
                          onClick={() => {
                            const target = c.IPv4Address ?? c.DNSHostName ?? c.Name
                            window.open(`/psexec?target=${encodeURIComponent(target)}`, '_self')
                          }}
                          className="px-2 py-1 text-xs rounded border transition-colors disabled:opacity-30"
                          style={{ borderColor: 'var(--border-med)', background: c.online ? '#818cf833' : 'transparent', color: c.online ? '#818cf8' : 'var(--text-muted)', cursor: c.online ? 'pointer' : 'not-allowed' }}>
                          ⚡ Remote Exec
                        </button>
                        {!c.IsDomainController && (
                          <>
                            <button
                              disabled={computerActionBusy === c.Name}
                              onClick={async () => {
                                setComputerActionBusy(c.Name)
                                try {
                                  await api.post(`/domain/${selectedId}/set-computer-enabled`, { name: c.Name, enabled: !c.Enabled })
                                  setComputers(prev => prev.map(x => x.Name === c.Name ? { ...x, Enabled: !c.Enabled } : x))
                                } catch (e: any) { alert(e.data?.error ?? 'Failed') }
                                setComputerActionBusy(null)
                              }}
                              className="px-2 py-1 text-xs rounded border transition-colors disabled:opacity-40"
                              style={c.Enabled
                                ? { background: '#7f1d1d22', borderColor: '#f8714844', color: '#f87171' }
                                : { background: '#14532d22', borderColor: '#4ade8044', color: '#4ade80' }}>
                              {computerActionBusy === c.Name ? '…' : c.Enabled ? '🚫 Disable' : '✅ Enable'}
                            </button>
                            <button
                              onClick={() => { setConfirmDeleteComputer(c.Name); setDeleteComputerInput(''); setDeleteComputerError('') }}
                              className="px-2 py-1 text-xs rounded border transition-colors"
                              style={{ background: '#7f1d1d22', borderColor: '#f8714844', color: '#f87171' }}>
                              🗑
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Delete computer confirmation */}
      {confirmDeleteComputer && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="rounded-xl border p-6 w-[440px] space-y-4"
            style={{ background: 'var(--modal-bg)', borderColor: 'var(--modal-border)' }}>
            <div className="flex items-start gap-3">
              <span className="text-xl mt-0.5">🗑</span>
              <div>
                <h2 className="text-base font-bold" style={{ color: 'var(--text-heading)' }}>Delete Computer Account</h2>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  This will permanently remove the computer account from Active Directory. The machine itself will not be affected until it tries to authenticate.
                </p>
              </div>
            </div>
            <div className="px-3 py-2 rounded-lg border font-mono text-sm"
              style={{ background: '#7f1d1d22', borderColor: '#f8714844', color: '#f87171' }}>
              {confirmDeleteComputer}
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Type the computer name to confirm:
              </label>
              <input autoFocus value={deleteComputerInput}
                onChange={e => { setDeleteComputerInput(e.target.value); setDeleteComputerError('') }}
                onKeyDown={async e => {
                  if (e.key === 'Enter' && deleteComputerInput === confirmDeleteComputer) {
                    setDeleteComputerBusy(true)
                    try {
                      await api.post(`/domain/${selectedId}/delete-computer`, { name: confirmDeleteComputer })
                      setComputers(prev => prev.filter(x => x.Name !== confirmDeleteComputer))
                      setConfirmDeleteComputer(null)
                    } catch (err: any) { setDeleteComputerError(err.data?.error ?? 'Failed') }
                    setDeleteComputerBusy(false)
                  }
                }}
                placeholder={confirmDeleteComputer}
                className="w-full px-3 py-2 rounded-lg border text-sm font-mono"
                style={{ background: 'var(--input-bg)', borderColor: deleteComputerInput && deleteComputerInput !== confirmDeleteComputer ? '#f87171' : 'var(--input-border)', color: 'var(--input-text)' }} />
              {deleteComputerInput && deleteComputerInput !== confirmDeleteComputer && (
                <p className="text-xs text-red-400 mt-1">Name does not match.</p>
              )}
            </div>
            {deleteComputerError && <p className="text-xs text-red-400">{deleteComputerError}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button onClick={() => setConfirmDeleteComputer(null)}
                className="px-4 py-2 rounded-lg text-sm border"
                style={{ background: 'var(--bg-panel-alt)', borderColor: 'var(--border-med)', color: 'var(--text-primary)' }}>
                Cancel
              </button>
              <button
                disabled={deleteComputerInput !== confirmDeleteComputer || deleteComputerBusy}
                onClick={async () => {
                  setDeleteComputerBusy(true)
                  try {
                    await api.post(`/domain/${selectedId}/delete-computer`, { name: confirmDeleteComputer })
                    setComputers(prev => prev.filter(x => x.Name !== confirmDeleteComputer))
                    setConfirmDeleteComputer(null)
                  } catch (err: any) { setDeleteComputerError(err.data?.error ?? 'Failed') }
                  setDeleteComputerBusy(false)
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40"
                style={{ background: '#c0392b' }}>
                {deleteComputerBusy ? 'Deleting…' : 'Delete Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PsExec quick launch modal */}
      {psexecTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setPsexecTarget(null)}>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-5 w-full max-w-xs space-y-3 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-semibold text-sm">⚡ PsExec → {psexecTarget.Name}</h3>
            <p className="text-xs text-gray-400">Opening PsExec with target <span className="font-mono text-white">{psexecTarget.IPv4Address ?? psexecTarget.DNSHostName ?? psexecTarget.Name}</span></p>
            <button onClick={() => setPsexecTarget(null)} className="w-full px-3 py-2 text-xs rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-700">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
