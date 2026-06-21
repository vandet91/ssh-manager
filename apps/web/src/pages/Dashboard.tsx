import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, AuditLog, SshKey, Server, Assignment, User, VaultEntry } from '../api/client'

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

function actionColor(action: string): string {
  if (action.includes('delete') || action.includes('revoke') || action.includes('purge') || action.includes('archive')) return '#f85149'
  if (action.includes('creat') || action.includes('added') || action.includes('restor')) return '#3fb950'
  if (action.includes('login') || action.includes('auth')) return '#58a6ff'
  if (action.includes('rotat') || action.includes('key')) return '#d29922'
  if (action.includes('reveal')) return '#bc8cff'
  return '#8b949e'
}

function actionIcon(action: string): string {
  if (action.includes('login')) return '🔓'
  if (action.includes('logout')) return '🔒'
  if (action.includes('key')) return '🔑'
  if (action.includes('server')) return '🖥'
  if (action.includes('assignment')) return '🔗'
  if (action.includes('vault')) return '🔐'
  if (action.includes('user')) return '👤'
  if (action.includes('rotat')) return '♻'
  if (action.includes('creden')) return '🗂'
  return '•'
}

const ENV_COLOR: Record<string, string> = {
  production: '#f85149',
  staging: '#d29922',
  development: '#3fb950',
  other: '#8b949e',
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub, accent, onClick }: {
  icon: string; label: string; value: number | string
  sub?: string; accent: string; onClick?: () => void
}) {
  return (
    <button onClick={onClick}
      className={`bg-gray-900 border border-gray-800 rounded-2xl p-5 text-left transition-all hover:border-gray-600 hover:bg-gray-800/60 ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ outline: 'none' }}>
      <div className="flex items-start justify-between mb-3">
        <span className="text-2xl">{icon}</span>
        <span className="text-xs text-gray-600 font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-4xl font-bold tracking-tight" style={{ color: accent }}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1.5">{sub}</p>}
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const nav = useNavigate()

  const [servers, setServers] = useState<Server[]>([])
  const [keys, setKeys] = useState<SshKey[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [vault, setVault] = useState<VaultEntry[]>([])
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get<Server[]>('/servers').catch(() => [] as Server[]),
      api.get<SshKey[]>('/keys').catch(() => [] as SshKey[]),
      api.get<Assignment[] | { data: Assignment[] }>('/assignments?limit=200').catch(() => [] as Assignment[]),
      api.get<{ users: User[] }>('/users?limit=200').catch(() => ({ users: [] })),
      api.get<VaultEntry[]>('/vault?limit=1000').catch(() => [] as VaultEntry[]),
      api.get<AuditLog[]>('/logs/audit?limit=20').catch(() => [] as AuditLog[]),
    ]).then(([srv, k, asgn, usrResp, vlt, lg]) => {
      setServers(srv as Server[])
      setKeys(k as SshKey[])
      const aArr = Array.isArray(asgn) ? asgn : ((asgn as { data: Assignment[] }).data ?? [])
      setAssignments(aArr)
      setUsers((usrResp as { users: User[] }).users ?? [])
      setVault(vlt as VaultEntry[])
      setLogs(lg as AuditLog[])
      setLoading(false)
    })
  }, [])

  // ── Derived stats ───────────────────────────────────────────────────────────
  const activeServers = servers.filter(s => s.is_active)
  const now = new Date()
  const in7d = new Date(now.getTime() + 7 * 86400000)
  const in30d = new Date(now.getTime() + 30 * 86400000)

  const overdueKeys = keys.filter(k => k.is_active && k.next_rotation_at && new Date(k.next_rotation_at) < now)
  const soonKeys    = keys.filter(k => k.is_active && k.next_rotation_at && new Date(k.next_rotation_at) >= now && new Date(k.next_rotation_at) <= in7d)
  const upcomingKeys = keys.filter(k => k.is_active && k.next_rotation_at && new Date(k.next_rotation_at) > in7d && new Date(k.next_rotation_at) <= in30d)

  const activeAssignments = assignments.filter(a => a.is_active)
  const expiringAssignments = activeAssignments.filter(a => a.expires_at && new Date(a.expires_at) <= in7d)

  const envCounts = activeServers.reduce<Record<string, number>>((acc, s) => {
    acc[s.environment] = (acc[s.environment] ?? 0) + 1; return acc
  }, {})

  const osCounts = activeServers.reduce<Record<string, number>>((acc, s) => {
    const k = s.os_type ?? 'unknown'; acc[k] = (acc[k] ?? 0) + 1; return acc
  }, {})

  const staleServers = activeServers.filter(s => {
    if (!s.last_connected_at) return true
    return Date.now() - new Date(s.last_connected_at).getTime() > 7 * 86400000
  })

  const rotationAlerts = overdueKeys.length + soonKeys.length
  const alertSub = overdueKeys.length > 0
    ? `${overdueKeys.length} overdue, ${soonKeys.length} this week`
    : soonKeys.length > 0 ? `${soonKeys.length} due this week` : 'All up to date'

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div style={{ width: 32, height: 32, border: '3px solid var(--border-med)', borderTopColor: 'var(--accent-hex)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">

      {/* ── Welcome bar ── */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        {/* Quick Actions */}
        <div className="flex gap-2 flex-wrap">
          {[
            { label: '+ Server',     path: '/servers',   color: '#388bfd' },
            { label: '+ SSH Key',    path: '/keys',      color: '#a371f7' },
            { label: '+ Vault Entry',path: '/vault',     color: '#3fb950' },
            { label: '+ Assignment', path: '/assignments',color: '#d29922' },
          ].map(({ label, path, color }) => (
            <button key={label} onClick={() => nav(path)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90 active:scale-95"
              style={{ background: color + '22', color, border: `1px solid ${color}44` }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard icon="🖥" label="Servers" value={activeServers.length}
          sub={`${servers.length - activeServers.length} inactive`}
          accent="#58a6ff" onClick={() => nav('/servers')} />
        <StatCard icon="⚷" label="SSH Keys" value={keys.filter(k => k.is_active).length}
          sub={`${keys.filter(k => !k.is_active).length} archived`}
          accent="#a371f7" onClick={() => nav('/keys')} />
        <StatCard icon="⊞" label="Assignments" value={activeAssignments.length}
          sub={expiringAssignments.length > 0 ? `${expiringAssignments.length} expiring soon` : 'None expiring'}
          accent="#d29922" onClick={() => nav('/assignments')} />
        <StatCard icon="🔐" label="Vault" value={vault.length}
          sub="stored credentials"
          accent="#3fb950" onClick={() => nav('/vault')} />
        <StatCard icon="👤" label="Users" value={users.filter(u => u.is_active).length}
          sub={`${users.length} total`}
          accent="#ec6547" onClick={() => nav('/users')} />
        <StatCard icon="♻" label="Rotation Alerts" value={rotationAlerts}
          sub={alertSub}
          accent={rotationAlerts > 0 ? '#f85149' : '#3fb950'} onClick={() => nav('/keys')} />
      </div>

      {/* ── Middle row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Server breakdown */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            🖥 Server Overview
            <span className="ml-auto text-xs text-gray-500 font-normal">{activeServers.length} active</span>
          </h2>

          {/* By environment */}
          <div>
            <p className="text-xs text-gray-500 mb-2 uppercase tracking-wide">By Environment</p>
            <div className="space-y-1.5">
              {Object.entries(envCounts).sort((a, b) => b[1] - a[1]).map(([env, cnt]) => (
                <div key={env} className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: ENV_COLOR[env] ?? '#8b949e' }} />
                  <span className="text-sm text-gray-300 capitalize flex-1">{env}</span>
                  <span className="text-sm font-semibold" style={{ color: ENV_COLOR[env] ?? '#8b949e' }}>{cnt}</span>
                  <div className="w-20 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(cnt / activeServers.length) * 100}%`, background: ENV_COLOR[env] ?? '#8b949e' }} />
                  </div>
                </div>
              ))}
              {activeServers.length === 0 && <p className="text-xs text-gray-600">No active servers.</p>}
            </div>
          </div>

          {/* By OS */}
          <div>
            <p className="text-xs text-gray-500 mb-2 uppercase tracking-wide">By OS</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(osCounts).map(([os, cnt]) => (
                <span key={os} className="px-2 py-1 rounded-lg text-xs font-medium bg-gray-800 text-gray-300">
                  {os === 'linux' ? '🐧' : os === 'windows' ? '🪟' : os === 'router' ? '📡' : '📦'} {os} <span className="text-gray-500 ml-1">{cnt}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Stale servers */}
          {staleServers.length > 0 && (
            <div>
              <p className="text-xs text-yellow-600 mb-2 uppercase tracking-wide">⚠ Not seen in 7+ days</p>
              <div className="space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {staleServers.map(s => (
                  <div key={s.id} className="flex items-center justify-between text-xs" style={{ paddingRight: 20 }}>
                    <span className="text-gray-400 truncate">{s.name}</span>
                    <span className="text-yellow-700 shrink-0 ml-2">{timeAgo(s.last_connected_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Key rotation panel */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            ♻ Key Rotation
            {rotationAlerts > 0 && (
              <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-red-900/50 text-red-400 border border-red-800/50">
                {rotationAlerts} need attention
              </span>
            )}
          </h2>

          {overdueKeys.length > 0 && (
            <div>
              <p className="text-xs text-red-500 mb-1.5 uppercase tracking-wide font-medium">🔴 Overdue</p>
              <div className="space-y-1.5">
                {overdueKeys.map(k => (
                  <div key={k.id} className="flex items-center justify-between text-xs bg-red-900/10 border border-red-900/30 rounded-lg px-3 py-1.5">
                    <span className="text-gray-300 truncate">{k.name}</span>
                    <span className="text-red-400 shrink-0 ml-2">{k.next_rotation_at ? new Date(k.next_rotation_at).toLocaleDateString() : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {soonKeys.length > 0 && (
            <div>
              <p className="text-xs text-yellow-500 mb-1.5 uppercase tracking-wide font-medium">🟡 This week</p>
              <div className="space-y-1.5">
                {soonKeys.map(k => (
                  <div key={k.id} className="flex items-center justify-between text-xs bg-yellow-900/10 border border-yellow-900/30 rounded-lg px-3 py-1.5">
                    <span className="text-gray-300 truncate">{k.name}</span>
                    <span className="text-yellow-400 shrink-0 ml-2">{k.next_rotation_at ? new Date(k.next_rotation_at).toLocaleDateString() : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {upcomingKeys.length > 0 && (
            <div>
              <p className="text-xs text-blue-500 mb-1.5 uppercase tracking-wide font-medium">🔵 Next 30 days</p>
              <div className="space-y-1.5">
                {upcomingKeys.map(k => (
                  <div key={k.id} className="flex items-center justify-between text-xs bg-blue-900/10 border border-blue-900/30 rounded-lg px-3 py-1.5">
                    <span className="text-gray-300 truncate">{k.name}</span>
                    <span className="text-blue-400 shrink-0 ml-2">{k.next_rotation_at ? new Date(k.next_rotation_at).toLocaleDateString() : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {overdueKeys.length === 0 && soonKeys.length === 0 && upcomingKeys.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-gray-600">
              <span className="text-3xl mb-2">✅</span>
              <p className="text-sm">All keys are up to date</p>
            </div>
          )}

          {expiringAssignments.length > 0 && (
            <div>
              <p className="text-xs text-orange-500 mb-1.5 uppercase tracking-wide font-medium">⏳ Assignments expiring soon</p>
              <div className="space-y-1.5">
                {expiringAssignments.slice(0, 4).map(a => (
                  <div key={a.id} className="flex items-center justify-between text-xs bg-orange-900/10 border border-orange-900/30 rounded-lg px-3 py-1.5">
                    <span className="text-gray-300 font-mono truncate">{a.linux_user}</span>
                    <span className="text-orange-400 shrink-0 ml-2">{a.expires_at ? new Date(a.expires_at).toLocaleDateString() : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recent servers */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            🕐 Recently Connected
            <button onClick={() => nav('/servers')} className="ml-auto text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-normal">View all →</button>
          </h2>
          <div className="space-y-2">
            {[...activeServers]
              .sort((a, b) => (b.last_connected_at ?? '').localeCompare(a.last_connected_at ?? ''))
              .slice(0, 8)
              .map(s => {
                const stale = !s.last_connected_at || Date.now() - new Date(s.last_connected_at).getTime() > 86400000 * 7
                return (
                  <div key={s.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-gray-800/40 hover:bg-gray-800 border border-transparent transition-colors cursor-pointer" onClick={() => nav('/servers')}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${stale ? 'bg-gray-600' : 'bg-green-500'}`} style={!stale ? { boxShadow: '0 0 6px #3fb950' } : {}} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate font-medium">{s.name}</p>
                      <p className="text-xs text-gray-500 truncate">{s.hostname}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-gray-500">{timeAgo(s.last_connected_at)}</p>
                      <span className="text-xs px-1.5 py-0.5 rounded text-xs capitalize" style={{ color: ENV_COLOR[s.environment] ?? '#8b949e', background: (ENV_COLOR[s.environment] ?? '#8b949e') + '18' }}>
                        {s.environment}
                      </span>
                    </div>
                  </div>
                )
              })}
            {activeServers.length === 0 && <p className="text-xs text-gray-600 py-4 text-center">No servers added yet.</p>}
          </div>
        </div>
      </div>

      {/* ── Activity feed ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          📋 Recent Activity
          <button onClick={() => nav('/logs')} className="ml-auto text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-normal">Full log →</button>
        </h2>
        {logs.length === 0
          ? <p className="text-gray-600 text-sm text-center py-6">No activity yet.</p>
          : (
            <div className="space-y-1">
              {logs.map((log, i) => (
                <div key={log.id} className={`flex items-start gap-3 px-3 py-2.5 rounded-xl text-xs transition-colors hover:bg-gray-800/50 ${i % 2 === 0 ? '' : 'bg-gray-800/20'}`}>
                  <span className="text-base shrink-0 mt-0.5">{actionIcon(log.action)}</span>
                  <span className="font-mono shrink-0 mt-0.5 font-semibold" style={{ color: actionColor(log.action) }}>
                    {log.action}
                  </span>
                  <span className="text-gray-400 truncate flex-1">{log.user_email ?? 'system'}</span>
                  {log.resource_id && <span className="text-gray-600 font-mono shrink-0 hidden sm:block">{log.resource_id.slice(0, 8)}</span>}
                  <span className="text-gray-600 shrink-0">{timeAgo(log.created_at)}</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  )
}
