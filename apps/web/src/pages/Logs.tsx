import { useEffect, useRef, useState } from 'react'
import { api, AuditLog, SessionRecording, User } from '../api/client'

type Tab = 'audit' | 'sessions'
type OlderThan = '30' | '60' | '90' | 'all'

const OLDER_THAN_LABELS: Record<OlderThan, string> = {
  '30': 'Older than 30 days',
  '60': 'Older than 60 days',
  '90': 'Older than 90 days',
  'all': 'All entries',
}

export default function Logs() {
  const [tab, setTab] = useState<Tab>('audit')
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [recordings, setRecordings] = useState<SessionRecording[]>([])
  const [filter, setFilter] = useState({ action: '', user_id: '' })
  const playerRef = useRef<HTMLDivElement>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [clearAuditOpen, setClearAuditOpen] = useState(false)
  const [clearSessionOpen, setClearSessionOpen] = useState(false)

  useEffect(() => {
    api.get<User>('/auth/me').then(setCurrentUser).catch(() => {})
  }, [])

  const loadAudit = () => {
    const params = new URLSearchParams()
    if (filter.action) params.set('action', filter.action)
    api.get<AuditLog[]>(`/logs/audit?${params}`).then(setAuditLogs).catch(() => {})
  }

  const loadSessions = () => {
    api.get<SessionRecording[]>('/logs/sessions').then(setRecordings).catch(() => {})
  }

  useEffect(() => { loadAudit() }, [filter.action])
  useEffect(() => { loadSessions() }, [])

  const playRecording = async (id: string) => {
    setPlayingId(id)
    try {
      const AsciinemaPlayer = await import('asciinema-player')
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — CSS module, no type declarations
      await import('asciinema-player/dist/bundle/asciinema-player.css')
      if (playerRef.current) {
        playerRef.current.innerHTML = ''
        AsciinemaPlayer.create(`/api/logs/sessions/${id}/play`, playerRef.current, {
          cols: 120, rows: 30, autoPlay: true, fit: 'width',
        })
      }
    } catch { setPlayingId(null) }
  }

  const clearAuditLogs = async (age: OlderThan) => {
    setClearAuditOpen(false)
    try {
      await api.delete(`/logs/audit?older_than=${age}`)
      loadAudit()
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const clearAllRecordings = async (age: OlderThan) => {
    setClearSessionOpen(false)
    try {
      await api.delete(`/logs/sessions?older_than=${age}`)
      loadSessions()
      setPlayingId(null)
      if (playerRef.current) playerRef.current.innerHTML = ''
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const deleteRecording = async (id: string) => {
    try {
      await api.delete(`/logs/sessions/${id}`)
      if (playingId === id) {
        setPlayingId(null)
        if (playerRef.current) playerRef.current.innerHTML = ''
      }
      loadSessions()
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const isAdmin = currentUser?.role === 'admin'

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold text-white">Logs</h1>

      <div className="flex gap-1 border-b border-gray-800">
        {(['audit', 'sessions'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${tab === t ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
            {t === 'audit' ? 'Audit Log' : 'Session Recordings'}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {tab === 'audit' && (
            <>
              <a href="/api/logs/export" className="px-3 py-1.5 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors">
                Export CSV
              </a>
              {isAdmin && (
                <div className="relative">
                  <button onClick={() => { setClearAuditOpen((o) => !o); setClearSessionOpen(false) }}
                    className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors flex items-center gap-1">
                    🗑 Clear Logs <span className="opacity-70">▾</span>
                  </button>
                  {clearAuditOpen && (
                    <div className="absolute right-0 top-full mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl w-52 py-1">
                      <div className="px-3 py-1.5 text-xs text-gray-400 font-semibold uppercase tracking-wide border-b border-gray-700 mb-1">
                        Delete entries…
                      </div>
                      {(['30', '60', '90', 'all'] as OlderThan[]).map((opt) => (
                        <button key={opt}
                          onClick={() => clearAuditLogs(opt)}
                          className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors">
                          {OLDER_THAN_LABELS[opt]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {tab === 'sessions' && isAdmin && (
            <div className="relative">
              <button onClick={() => { setClearSessionOpen((o) => !o); setClearAuditOpen(false) }}
                className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors flex items-center gap-1">
                🗑 Clear Recordings <span className="opacity-70">▾</span>
              </button>
              {clearSessionOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl w-52 py-1">
                  <div className="px-3 py-1.5 text-xs text-gray-400 font-semibold uppercase tracking-wide border-b border-gray-700 mb-1">
                    Delete recordings…
                  </div>
                  {(['30', '60', '90', 'all'] as OlderThan[]).map((opt) => (
                    <button key={opt}
                      onClick={() => clearAllRecordings(opt)}
                      className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors">
                      {OLDER_THAN_LABELS[opt]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {tab === 'audit' && (
        <>
          <div className="flex gap-2">
            <input value={filter.action} onChange={(e) => setFilter((f) => ({ ...f, action: e.target.value }))}
              placeholder="Filter by action…"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 w-56" />
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
            <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 560 }}>
              <colgroup>
                <col style={{ width: '20%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '14%' }} />
              </colgroup>
              <thead className="bg-gray-800/50">
                <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Resource</th>
                  <th className="px-3 py-2">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {auditLogs.map((l) => (
                  <tr key={l.id} className="hover:bg-gray-800/30">
                    <td className="px-3 py-2 text-gray-500 text-xs" style={{ whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-gray-300 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.user_email ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-indigo-400" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.action}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.resource ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{l.ip_address ?? '—'}</td>
                  </tr>
                ))}
                {auditLogs.length === 0 && <tr><td colSpan={5} className="px-3 py-5 text-center text-gray-500">No entries.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'sessions' && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
            <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 580 }}>
              <colgroup>
                <col style={{ width: '20%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '28%' }} />
              </colgroup>
              <thead className="bg-gray-800/50">
                <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Server</th>
                  <th className="px-3 py-2">Linux User</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {recordings.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-800/30">
                    <td className="px-3 py-2 text-gray-400 text-xs" style={{ whiteSpace: 'nowrap' }}>{new Date(r.started_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-gray-300 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.user_id?.slice(0, 8) ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-300 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.server_id?.slice(0, 8) ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-indigo-300" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.linux_user ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs">{r.duration_s != null ? `${r.duration_s}s` : '—'}</td>
                    <td className="px-3 py-2">
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'center' }}>
                        {r.cast_file_path && (
                          <button onClick={() => playRecording(r.id)}
                            className={`px-2 py-1 text-xs rounded transition-colors text-white ${playingId === r.id ? 'bg-indigo-700' : 'bg-indigo-600 hover:bg-indigo-500'}`}
                            style={{ whiteSpace: 'nowrap' }}>
                            {playingId === r.id ? 'Playing…' : '▶ Play'}
                          </button>
                        )}
                        {r.cast_file_path && (
                          <a href={`/api/logs/sessions/${r.id}/download`}
                            className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                            style={{ whiteSpace: 'nowrap' }}
                            download>
                            ↓ Download
                          </a>
                        )}
                        {isAdmin && (
                          <button onClick={() => deleteRecording(r.id)}
                            className="px-2 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
                            style={{ whiteSpace: 'nowrap' }}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {recordings.length === 0 && <tr><td colSpan={6} className="px-3 py-5 text-center text-gray-500">No recordings.</td></tr>}
              </tbody>
            </table>
          </div>

          {playingId && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-300">Session Playback</h3>
                <button onClick={() => { setPlayingId(null); if (playerRef.current) playerRef.current.innerHTML = '' }}
                  className="text-gray-500 hover:text-white text-sm">&times; Close</button>
              </div>
              <div ref={playerRef} className="w-full" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
