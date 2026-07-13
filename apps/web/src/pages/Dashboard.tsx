import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, AuditLog, SshKey, Server, VaultEntry, User } from '../api/client'
import { usePermissions } from '../context/PermissionContext'

// ── helpers ───────────────────────────────────────────────────────────────────

function timeAgo(date: string | null): string {
  if (!date) return 'Never'
  const diff = Date.now() - new Date(date).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function actionColor(action: string): string {
  if (action.includes('delete') || action.includes('revoke') || action.includes('purge') || action.includes('archive')) return '#ef4444'
  if (action.includes('creat') || action.includes('added') || action.includes('restor')) return '#10b981'
  if (action.includes('login') || action.includes('auth')) return '#3b82f6'
  if (action.includes('rotat') || action.includes('key')) return '#f59e0b'
  if (action.includes('reveal')) return '#8b5cf6'
  return 'var(--text-muted)'
}

function actionIcon(action: string): string {
  if (action.includes('login')) return '🔓'
  if (action.includes('logout')) return '🔒'
  if (action.includes('key')) return '🔑'
  if (action.includes('server')) return '🖥'
  if (action.includes('vault')) return '🔐'
  if (action.includes('user')) return '👤'
  if (action.includes('rotat')) return '♻'
  return '·'
}

const ENV_COLOR: Record<string, string> = {
  production: '#ef4444',
  staging:    '#f59e0b',
  development:'#10b981',
  other:      '#6b7280',
}

const OS_ICON: Record<string, string> = {
  linux: '🐧', windows: '🪟', router: '📡', switch: '🔀',
  'access-point': '📶', dvr: '📹', nvr: '🎥', 'other-network': '🌐',
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const card = {
  background: 'var(--card-bg)',
  border: '1px solid var(--card-border)',
  borderRadius: 12,
  padding: '20px',
} as const

const fixedCard = {
  ...card,
  height: 440,
  display: 'flex',
  flexDirection: 'column',
} as const

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub, color, onClick }: {
  icon: string; label: string; value: number | string
  sub?: string; color: string; onClick?: () => void
}) {
  return (
    <button onClick={onClick} style={{
      ...card,
      display: 'block', width: '100%', textAlign: 'left',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'border-color 0.15s, background 0.15s',
      outline: 'none',
    }}
    onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLElement).style.borderColor = color }}
    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--card-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 36, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{sub}</div>}
    </button>
  )
}

// ── SectionHeader ─────────────────────────────────────────────────────────────

function SectionHeader({ icon, title, action, onAction }: { icon: string; title: string; action?: string; onAction?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <span style={{ fontSize: 15 }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
      {action && onAction && (
        <button onClick={onAction} style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent-hex)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>
          {action} →
        </button>
      )}
    </div>
  )
}

// ── KeyBadge ──────────────────────────────────────────────────────────────────

function KeyStatusBadge({ k, now, in7d, in30d }: { k: SshKey; now: Date; in7d: Date; in30d: Date }) {
  if (k.rotation_policy === 'manual') {
    return <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'rgba(107,114,128,0.15)', color: '#6b7280', border: '1px solid rgba(107,114,128,0.3)', fontWeight: 600 }}>Manual</span>
  }
  if (!k.next_rotation_at) {
    return <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'rgba(107,114,128,0.15)', color: '#6b7280', border: '1px solid rgba(107,114,128,0.3)', fontWeight: 600 }}>No date</span>
  }
  const d = new Date(k.next_rotation_at)
  if (d < now) return <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.4)', fontWeight: 600 }}>Overdue</span>
  if (d <= in7d) return <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.4)', fontWeight: 600 }}>This week</span>
  if (d <= in30d) return <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'rgba(59,130,246,0.15)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.4)', fontWeight: 600 }}>30 days</span>
  return <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid rgba(16,185,129,0.4)', fontWeight: 600 }}>OK</span>
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const nav = useNavigate()
  const { isAdmin, loaded: permLoaded } = usePermissions()

  const [servers, setServers] = useState<Server[]>([])
  const [keys, setKeys]       = useState<SshKey[]>([])
  const [users, setUsers]     = useState<User[]>([])
  const [vault, setVault]     = useState<VaultEntry[]>([])
  const [logs, setLogs]       = useState<AuditLog[]>([])
  const [certServers, setCertServers] = useState<Array<Server & { days_remaining: number | null }>>([])
  const [loading, setLoading] = useState(true)
  const [recentPage, setRecentPage] = useState(0)

  useEffect(() => {
    if (!permLoaded) return
    const all: Promise<unknown>[] = [
      api.get<Server[]>('/servers').catch(() => [] as Server[]),
      api.get<SshKey[]>('/keys').catch(() => [] as SshKey[]),
      api.get<VaultEntry[]>('/vault?limit=1000').catch(() => [] as VaultEntry[]),
    ]
    if (isAdmin) {
      all.push(
        api.get<{ users: User[] }>('/users?limit=200').then(r => r.users).catch(() => [] as User[]),
        api.get<AuditLog[]>('/logs/audit?limit=25').catch(() => [] as AuditLog[]),
      )
    } else {
      all.push(Promise.resolve([] as User[]), api.get<AuditLog[]>('/logs/my-activity?limit=25').catch(() => [] as AuditLog[]))
    }
    // Fetch expiring certs in background — don't block main load
    api.get<Array<Server & { days_remaining: number | null }>>('/cert/expiring')
      .then(r => setCertServers(r))
      .catch(() => {})

    Promise.all(all).then(([srv, k, vlt, usr, lg]) => {
      setServers(srv as Server[]); setKeys(k as SshKey[])
      setVault(vlt as VaultEntry[]); setUsers(usr as User[])
      setLogs(lg as AuditLog[]); setLoading(false)
    })
  }, [isAdmin, permLoaded])

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeServers = servers.filter(s => s.is_active)
  const activeKeys    = keys.filter(k => k.is_active)
  const now   = new Date()
  const in7d  = new Date(now.getTime() + 7  * 86400000)
  const in30d = new Date(now.getTime() + 30 * 86400000)

  const overdueKeys  = activeKeys.filter(k => k.next_rotation_at && new Date(k.next_rotation_at) < now)
  const soonKeys     = activeKeys.filter(k => k.next_rotation_at && new Date(k.next_rotation_at) >= now && new Date(k.next_rotation_at) <= in7d)
  const upcomingKeys = activeKeys.filter(k => k.next_rotation_at && new Date(k.next_rotation_at) > in7d && new Date(k.next_rotation_at) <= in30d)
  const manualKeys   = activeKeys.filter(k => k.rotation_policy === 'manual')
  const rotationAlerts = overdueKeys.length + soonKeys.length

  const staleServers = activeServers.filter(s => !s.last_connected_at || Date.now() - new Date(s.last_connected_at).getTime() > 7 * 86400000)

  const certAlerts = certServers.filter(s => s.days_remaining !== null && s.days_remaining <= 30)
  const certExpired = certServers.filter(s => s.days_remaining !== null && s.days_remaining < 0)
  const certCritical = certServers.filter(s => s.days_remaining !== null && s.days_remaining >= 0 && s.days_remaining < 7)
  const envCounts = activeServers.reduce<Record<string, number>>((acc, s) => { acc[s.environment] = (acc[s.environment] ?? 0) + 1; return acc }, {})
  const osCounts  = activeServers.reduce<Record<string, number>>((acc, s) => { const k = s.os_type ?? 'unknown'; acc[k] = (acc[k] ?? 0) + 1; return acc }, {})

  if (loading) return (
    <div style={{ padding: 40, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
      <div style={{ width: 32, height: 32, border: '3px solid var(--border-med)', borderTopColor: 'var(--accent-hex)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
    </div>
  )

  return (
    <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: 'var(--text-primary)' }}>Dashboard</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isAdmin ? (<>
            <QuickBtn label="+ Server"      color="#3b82f6" onClick={() => nav('/servers')} />
            <QuickBtn label="+ SSH Key"     color="#8b5cf6" onClick={() => nav('/keys')} />
            <QuickBtn label="+ Vault Entry" color="#10b981" onClick={() => nav('/vault')} />
            <QuickBtn label="+ User"        color="#ef4444" onClick={() => nav('/users')} />
          </>) : (
            <QuickBtn label="+ Vault Entry" color="#10b981" onClick={() => nav('/vault')} />
          )}
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <StatCard icon="🖥"  label="Active Servers" value={activeServers.length}
          sub={`${servers.length - activeServers.length} inactive · ${staleServers.length} stale`}
          color="#3b82f6" onClick={() => nav('/servers')} />
        <StatCard icon="⚷"  label="SSH Keys"       value={activeKeys.length}
          sub={`${keys.filter(k => !k.is_active).length} archived`}
          color="#8b5cf6" onClick={() => nav('/keys')} />
        <StatCard icon="🔐" label="Vault Entries"   value={vault.filter(v => !v.is_archived).length}
          sub={`${vault.filter(v => v.is_archived).length} archived`}
          color="#10b981" onClick={() => nav('/vault')} />
        {isAdmin && <StatCard icon="👤" label="Active Users"   value={users.filter(u => u.is_active).length}
          sub={`${users.length} total`}
          color="#f59e0b" onClick={() => nav('/users')} />}
        <StatCard icon="♻"  label="Key Alerts"     value={rotationAlerts || '✓'}
          sub={rotationAlerts > 0 ? `${overdueKeys.length} overdue · ${soonKeys.length} this week` : 'All auto-rotate keys OK'}
          color={rotationAlerts > 0 ? '#ef4444' : '#10b981'} onClick={() => nav('/keys')} />
        {certServers.length > 0 && (
          <StatCard icon="🔒" label="TLS Certs"
            value={certAlerts.length > 0 ? certAlerts.length : '✓'}
            sub={certAlerts.length > 0 ? `${certExpired.length} expired · ${certCritical.length} < 7d` : `${certServers.length} monitored, all OK`}
            color={certExpired.length > 0 ? '#ef4444' : certCritical.length > 0 ? '#f59e0b' : '#10b981'}
            onClick={() => nav('/servers')} />
        )}
      </div>

      {/* ── Middle row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>

        {/* Server overview */}
        <div style={fixedCard}>
          <SectionHeader icon="🖥" title="Server Overview" action="View all" onAction={() => nav('/servers')} />

          <div className="thin-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 6 }}>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>By Environment</div>
              {Object.entries(envCounts).sort((a, b) => b[1] - a[1]).map(([env, cnt]) => (
                <div key={env} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: ENV_COLOR[env] ?? '#6b7280', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1, textTransform: 'capitalize' }}>{env}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: ENV_COLOR[env] ?? '#6b7280', minWidth: 20, textAlign: 'right' }}>{cnt}</span>
                  <div style={{ width: 60, height: 4, background: 'var(--bg-panel-alt)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 2, background: ENV_COLOR[env] ?? '#6b7280', width: `${(cnt / activeServers.length) * 100}%` }} />
                  </div>
                </div>
              ))}
              {activeServers.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No servers yet.</p>}
            </div>

            <div style={{ marginBottom: staleServers.length > 0 ? 14 : 0 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>By OS / Type</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(osCounts).map(([os, cnt]) => (
                  <span key={os} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'var(--bg-panel-alt)', color: 'var(--text-primary)', border: '1px solid var(--border-med)' }}>
                    {OS_ICON[os] ?? '📦'} {os} <span style={{ color: 'var(--text-muted)', marginLeft: 2 }}>{cnt}</span>
                  </span>
                ))}
              </div>
            </div>

            {staleServers.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>⚠ Not seen in 7+ days</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {staleServers.map(s => (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                      <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span style={{ color: '#f59e0b', flexShrink: 0, marginLeft: 8 }}>{timeAgo(s.last_connected_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Key rotation */}
        <div style={fixedCard}>
          <SectionHeader icon="♻" title="Key Rotation" action="Manage" onAction={() => nav('/keys')} />

          {rotationAlerts > 0 && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 14, padding: '4px 10px', borderRadius: 6, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', fontSize: 11, fontWeight: 600 }}>
              ⚠ {rotationAlerts} key{rotationAlerts > 1 ? 's' : ''} need attention
            </div>
          )}

          {activeKeys.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>No SSH keys found.</p>
          ) : (
            <div className="thin-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 10 }}>
              {[...activeKeys]
                .sort((a, b) => {
                  const aOver = a.next_rotation_at && new Date(a.next_rotation_at) < now ? -2 : 0
                  const bOver = b.next_rotation_at && new Date(b.next_rotation_at) < now ? -2 : 0
                  const aSoon = a.next_rotation_at && new Date(a.next_rotation_at) <= in7d ? -1 : 0
                  const bSoon = b.next_rotation_at && new Date(b.next_rotation_at) <= in7d ? -1 : 0
                  return (aOver + aSoon) - (bOver + bSoon)
                })
                .map(k => (
                  <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, background: 'var(--bg-panel-alt)', border: '1px solid var(--border-med)' }}>
                    <span style={{ fontSize: 13 }}>🔑</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        {k.rotation_policy === 'manual' ? 'Manual rotation' : k.next_rotation_at ? `Due ${fmtDate(k.next_rotation_at)}` : `Policy: ${k.rotation_policy}`}
                      </div>
                    </div>
                    <KeyStatusBadge k={k} now={now} in7d={in7d} in30d={in30d} />
                  </div>
                ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-med)', fontSize: 11, color: 'var(--text-muted)' }}>
            <span>🔴 {overdueKeys.length} overdue</span>
            <span>🟡 {soonKeys.length} this week</span>
            <span>🔵 {upcomingKeys.length} upcoming</span>
            <span>⚙ {manualKeys.length} manual</span>
          </div>
        </div>

        {/* Recently connected */}
        <div style={fixedCard}>
          <SectionHeader icon="🕐" title="Recently Connected" action="View all" onAction={() => nav('/servers')} />
          {(() => {
            const PAGE = 5
            const sorted = [...activeServers].sort((a, b) => (b.last_connected_at ?? '').localeCompare(a.last_connected_at ?? ''))
            const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE))
            const page = Math.min(recentPage, totalPages - 1)
            const slice = sorted.slice(page * PAGE, page * PAGE + PAGE)
            return (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0, overflowY: 'auto' }}>
                  {slice.map(s => {
                    const stale = !s.last_connected_at || Date.now() - new Date(s.last_connected_at).getTime() > 86400000 * 7
                    return (
                      <div key={s.id} onClick={() => nav('/servers')} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 7, background: 'var(--bg-panel-alt)', border: '1px solid var(--border-med)', cursor: 'pointer', transition: 'border-color 0.1s' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent-hex)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-med)'}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: stale ? '#6b7280' : '#10b981', flexShrink: 0, boxShadow: stale ? 'none' : '0 0 6px #10b981' }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.hostname}</div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{timeAgo(s.last_connected_at)}</div>
                          <div style={{ fontSize: 10, color: ENV_COLOR[s.environment] ?? '#6b7280', fontWeight: 600, textTransform: 'capitalize' }}>{s.environment}</div>
                        </div>
                      </div>
                    )
                  })}
                  {activeServers.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>No servers available.</p>}
                </div>
                {totalPages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-med)', flexShrink: 0 }}>
                    <button onClick={() => setRecentPage(p => Math.max(0, p - 1))} disabled={page === 0}
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-panel-alt)', color: page === 0 ? 'var(--text-muted)' : 'var(--text-primary)', cursor: page === 0 ? 'default' : 'pointer' }}>← Prev</button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{page + 1} / {totalPages}</span>
                    <button onClick={() => setRecentPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-panel-alt)', color: page === totalPages - 1 ? 'var(--text-muted)' : 'var(--text-primary)', cursor: page === totalPages - 1 ? 'default' : 'pointer' }}>Next →</button>
                  </div>
                )}
              </>
            )
          })()}
        </div>
      </div>

      {/* ── TLS Certificates ── */}
      {certServers.length > 0 && (
        <div style={card}>
          <SectionHeader icon="🔒" title="TLS Certificate Expiry" action="Manage servers" onAction={() => nav('/servers')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {certServers.slice(0, 8).map(s => {
              const days = s.days_remaining
              const expired = days !== null && days < 0
              const critical = days !== null && days >= 0 && days < 7
              const warning = days !== null && days >= 7 && days < 30
              const color = expired ? '#f87171' : critical ? '#fb923c' : warning ? '#fbbf24' : '#4ade80'
              const bg = expired ? 'rgba(239,68,68,0.08)' : critical ? 'rgba(249,115,22,0.08)' : warning ? 'rgba(251,191,36,0.08)' : 'rgba(74,222,128,0.06)'
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8, background: bg, border: `1px solid ${color}33` }}>
                  <span style={{ fontSize: 14 }}>{expired ? '✗' : '🔒'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.cert_host ?? s.hostname}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color }}>{expired ? 'Expired' : days === 0 ? 'Today' : `${days}d`}</div>
                    {s.cert_expires_at && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{new Date(s.cert_expires_at).toLocaleDateString()}</div>}
                  </div>
                </div>
              )
            })}
            {certServers.length > 8 && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>
                +{certServers.length - 8} more — <button onClick={() => nav('/servers')} style={{ background: 'none', border: 'none', color: 'var(--accent-hex)', cursor: 'pointer', fontSize: 11, padding: 0 }}>View all</button>
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Activity feed ── */}
      <div style={card}>
        <SectionHeader icon="📋" title={isAdmin ? 'Recent Activity' : 'My Recent Activity'} action={isAdmin ? 'Full log' : 'Full history'} onAction={() => nav(isAdmin ? '/logs' : '/activity')} />
        {logs.length === 0
          ? <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>No activity yet.</p>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {logs.map(log => (
                <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6, fontSize: 12 }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-panel-alt)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}>
                  <span style={{ fontSize: 14, flexShrink: 0 }}>{actionIcon(log.action)}</span>
                  <span style={{ fontWeight: 600, color: actionColor(log.action), flexShrink: 0, minWidth: 120 }}>{log.action}</span>
                  {isAdmin && <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.user_email ?? 'system'}</span>}
                  {log.resource && <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>{log.resource}</span>}
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, marginLeft: 'auto' }}>{timeAgo(log.created_at)}</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}

function QuickBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
      background: `${color}18`, color, border: `1px solid ${color}44`,
      transition: 'opacity 0.15s',
    }}
    onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '0.8'}
    onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '1'}>
      {label}
    </button>
  )
}
