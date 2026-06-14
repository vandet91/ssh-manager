import { useEffect, useState } from 'react'
import { api, AuditLog, SecurityScan, SshKey, Server, Assignment } from '../api/client'
import Badge from '../components/Badge'

interface Stats {
  servers: number; keys: number; assignments: number
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({ servers: 0, keys: 0, assignments: 0 })
  const [recentLogs, setRecentLogs] = useState<AuditLog[]>([])
  const [upcomingRotations, setUpcomingRotations] = useState<SshKey[]>([])
  const [findings, setFindings] = useState<SecurityScan[]>([])

  useEffect(() => {
    Promise.all([
      api.get<Server[]>('/servers').then((r) => r.length).catch(() => 0),
      api.get<SshKey[]>('/keys').then((r) => r.length).catch(() => 0),
      api.get<Assignment[]>('/assignments').then((r) => (Array.isArray(r) ? r : (r as { data: Assignment[] }).data ?? []).length).catch(() => 0),
    ]).then(([servers, keys, assignments]) => setStats({ servers, keys, assignments }))

    api.get<AuditLog[]>('/logs/audit?limit=10').then(setRecentLogs).catch(() => {})

    api.get<SshKey[]>('/keys').then((keys) => {
      const week = new Date(); week.setDate(week.getDate() + 7)
      setUpcomingRotations(keys.filter((k) => k.next_rotation_at && new Date(k.next_rotation_at) <= week))
    }).catch(() => {})

    api.get<SecurityScan[]>('/security/findings?limit=50').then(setFindings).catch(() => {})
  }, [])

  // Count individual failed findings (not scan records) grouped by finding severity
  const severityCounts = findings.reduce<Record<string, number>>((acc, scan) => {
    for (const f of scan.findings ?? []) {
      if (!f.passed) {
        const sev = f.severity ?? 'medium'
        acc[sev] = (acc[sev] ?? 0) + 1
      }
    }
    return acc
  }, {})

  const totalIssues = Object.values(severityCounts).reduce((a, b) => a + b, 0)

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-white">Dashboard</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Servers', value: stats.servers, color: 'text-blue-400' },
          { label: 'SSH Keys', value: stats.keys, color: 'text-indigo-400' },
          { label: 'Assignments', value: stats.assignments, color: 'text-purple-400' },
          { label: 'Security Issues', value: totalIssues, color: 'text-red-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-sm text-gray-400">{label}</p>
            <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent audit log */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Recent Audit Events</h2>
          {recentLogs.length === 0 ? (
            <p className="text-gray-500 text-sm">No events yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentLogs.map((log) => (
                <li key={log.id} className="flex items-start gap-2 text-xs">
                  <span className="text-gray-500 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</span>
                  <span className="text-indigo-400 font-mono">{log.action}</span>
                  <span className="text-gray-400 truncate">{log.user_email}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Keys due for rotation */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Keys Due for Rotation (7 days)</h2>
          {upcomingRotations.length === 0 ? (
            <p className="text-gray-500 text-sm">No keys due soon.</p>
          ) : (
            <ul className="space-y-2">
              {upcomingRotations.map((k) => (
                <li key={k.id} className="flex items-center justify-between text-xs">
                  <span className="text-white">{k.name}</span>
                  <span className="text-yellow-400">{k.next_rotation_at ? new Date(k.next_rotation_at).toLocaleDateString() : '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Security findings summary */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Security Findings Summary</h2>
        <div className="flex gap-3 flex-wrap">
          {(['critical', 'high', 'medium', 'low', 'ok'] as const).map((s) => (
            <div key={s} className="flex items-center gap-2">
              <Badge label={s.toUpperCase()} variant={s} />
              <span className="text-white text-sm font-semibold">{severityCounts[s] ?? 0}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
