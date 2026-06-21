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

const AUDIT_PAGE_SIZE   = 50
const SESSION_PAGE_SIZE = 25

// ── Action category config ────────────────────────────────────────────────────

type Category = 'auth' | 'server' | 'settings' | 'key' | 'user' | 'vault' | 'logs' | 'session' | 'other'

const CATEGORY_META: Record<Category, { label: string; color: string; bg: string; border: string }> = {
  auth:     { label: 'Auth',     color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',   border: 'rgba(96,165,250,0.3)' },
  server:   { label: 'Server',   color: '#34d399', bg: 'rgba(52,211,153,0.12)',   border: 'rgba(52,211,153,0.3)' },
  settings: { label: 'Settings', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',   border: 'rgba(245,158,11,0.3)' },
  key:      { label: 'Keys',     color: '#a78bfa', bg: 'rgba(167,139,250,0.12)',  border: 'rgba(167,139,250,0.3)' },
  user:     { label: 'Users',    color: '#fb7185', bg: 'rgba(251,113,133,0.12)',  border: 'rgba(251,113,133,0.3)' },
  vault:    { label: 'Vault',    color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',   border: 'rgba(251,191,36,0.3)' },
  logs:     { label: 'Logs',     color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.3)' },
  session:  { label: 'Session',  color: '#22d3ee', bg: 'rgba(34,211,238,0.12)',   border: 'rgba(34,211,238,0.3)' },
  other:    { label: 'Other',    color: '#9ca3af', bg: 'rgba(156,163,175,0.10)', border: 'rgba(156,163,175,0.25)' },
}

function getCategory(action: string): Category {
  const prefix = action.split('.')[0].toLowerCase()
  if (prefix in CATEGORY_META) return prefix as Category
  return 'other'
}

function ActionBadge({ action }: { action: string }) {
  const cat = getCategory(action)
  const m = CATEGORY_META[cat]
  // Show category prefix as a small pill, then the rest of the action
  const parts = action.split('.')
  const rest = parts.slice(1).join('.')
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
      <span style={{ padding: '1px 6px', borderRadius: 4, fontWeight: 700, fontSize: 10, background: m.bg, color: m.color, border: `1px solid ${m.border}`, whiteSpace: 'nowrap' }}>
        {m.label}
      </span>
      {rest && <span style={{ color: '#9ca3af' }}>{rest}</span>}
    </span>
  )
}

// ── Player Modal ──────────────────────────────────────────────────────────────

function PlayerModal({ recording, onClose }: { recording: SessionRecording; onClose: () => void }) {
  const playerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const AsciinemaPlayer = await import('asciinema-player')
        // @ts-ignore
        await import('asciinema-player/dist/bundle/asciinema-player.css')
        if (mounted && playerRef.current) {
          playerRef.current.innerHTML = ''
          AsciinemaPlayer.create(`/api/logs/sessions/${recording.id}/play`, playerRef.current, {
            cols: 220, rows: 40, autoPlay: true, fit: 'width',
          })
        }
      } catch {}
    }
    load()
    return () => { mounted = false }
  }, [recording.id])

  // Close on backdrop click
  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const dur = recording.duration_s != null
    ? `${Math.floor(recording.duration_s / 60)}m ${recording.duration_s % 60}s`
    : null

  return (
    <div
      onClick={onBackdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.75)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{
        width: '92vw', maxWidth: 1400,
        background: '#111827', borderRadius: 14,
        border: '1px solid #374151',
        display: 'flex', flexDirection: 'column',
        maxHeight: '92vh', overflow: 'hidden',
        boxShadow: '0 25px 80px rgba(0,0,0,0.7)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid #1f2937', flexShrink: 0 }}>
          <span style={{ fontSize: 16 }}>▶</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e5e7eb' }}>
              Session Playback
              {recording.linux_user && <span style={{ color: '#818cf8', marginLeft: 8, fontFamily: 'monospace' }}>{recording.linux_user}</span>}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1, display: 'flex', gap: 14 }}>
              <span>Started: {new Date(recording.started_at).toLocaleString()}</span>
              {dur && <span>Duration: {dur}</span>}
              {recording.server_id && <span>Server: {recording.server_id.slice(0, 8)}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {recording.cast_file_path && (
              <a href={`/api/logs/sessions/${recording.id}/download`} download
                style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, background: '#374151', color: '#d1d5db', textDecoration: 'none', border: 'none' }}>
                ↓ Download
              </a>
            )}
            <button onClick={onClose}
              style={{ fontSize: 20, lineHeight: 1, padding: '4px 8px', background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer' }}>
              ×
            </button>
          </div>
        </div>
        {/* Player */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16, minHeight: 0 }}>
          <div ref={playerRef} style={{ width: '100%' }} />
        </div>
      </div>
    </div>
  )
}

// ── Pagination controls ───────────────────────────────────────────────────────

function Pagination({ page, total, pageSize, onChange }: {
  page: number; total: number; pageSize: number; onChange: (p: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null
  const start = page * pageSize + 1
  const end   = Math.min((page + 1) * pageSize, total)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', fontSize: 12, color: '#6b7280' }}>
      <span>{start}–{end} of {total}</span>
      <button onClick={() => onChange(0)} disabled={page === 0}
        style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #374151', background: 'transparent', color: page === 0 ? '#374151' : '#9ca3af', cursor: page === 0 ? 'default' : 'pointer', fontSize: 11 }}>
        «
      </button>
      <button onClick={() => onChange(page - 1)} disabled={page === 0}
        style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #374151', background: 'transparent', color: page === 0 ? '#374151' : '#9ca3af', cursor: page === 0 ? 'default' : 'pointer', fontSize: 11 }}>
        ‹ Prev
      </button>
      <span style={{ color: '#e5e7eb', fontWeight: 600 }}>Page {page + 1} / {totalPages}</span>
      <button onClick={() => onChange(page + 1)} disabled={page >= totalPages - 1}
        style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #374151', background: 'transparent', color: page >= totalPages - 1 ? '#374151' : '#9ca3af', cursor: page >= totalPages - 1 ? 'default' : 'pointer', fontSize: 11 }}>
        Next ›
      </button>
      <button onClick={() => onChange(totalPages - 1)} disabled={page >= totalPages - 1}
        style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #374151', background: 'transparent', color: page >= totalPages - 1 ? '#374151' : '#9ca3af', cursor: page >= totalPages - 1 ? 'default' : 'pointer', fontSize: 11 }}>
        »
      </button>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Logs() {
  const [tab, setTab]               = useState<Tab>('audit')
  const [auditLogs, setAuditLogs]   = useState<AuditLog[]>([])
  const [recordings, setRecordings] = useState<SessionRecording[]>([])
  const [searchText, setSearchText] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<Category | 'all'>('all')
  const [playingRec, setPlayingRec] = useState<SessionRecording | null>(null)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [clearAuditOpen, setClearAuditOpen]     = useState(false)
  const [clearSessionOpen, setClearSessionOpen] = useState(false)
  const [auditPage, setAuditPage]     = useState(0)
  const [sessionPage, setSessionPage] = useState(0)

  useEffect(() => {
    api.get<User>('/auth/me').then(setCurrentUser).catch(() => {})
  }, [])

  const loadAudit = () => {
    api.get<AuditLog[]>('/logs/audit').then(data => {
      setAuditLogs(data)
      setAuditPage(0)
    }).catch(() => {})
  }

  const loadSessions = () => {
    api.get<SessionRecording[]>('/logs/sessions').then(data => {
      setRecordings(data)
      setSessionPage(0)
    }).catch(() => {})
  }

  useEffect(() => { loadAudit() }, [])
  useEffect(() => { loadSessions() }, [])

  const clearAuditLogs = async (age: OlderThan) => {
    setClearAuditOpen(false)
    try { await api.delete(`/logs/audit?older_than=${age}`); loadAudit() }
    catch (err: unknown) { alert((err as Error).message) }
  }

  const clearAllRecordings = async (age: OlderThan) => {
    setClearSessionOpen(false)
    try {
      await api.delete(`/logs/sessions?older_than=${age}`)
      loadSessions()
      setPlayingRec(null)
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const deleteRecording = async (id: string) => {
    try {
      await api.delete(`/logs/sessions/${id}`)
      if (playingRec?.id === id) setPlayingRec(null)
      loadSessions()
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const isAdmin = currentUser?.role === 'admin'

  // Derive available categories from loaded data
  const availableCategories = Array.from(new Set(auditLogs.map(l => getCategory(l.action)))) as Category[]

  // Client-side filtering
  const filteredAudit = auditLogs.filter(l => {
    if (categoryFilter !== 'all' && getCategory(l.action) !== categoryFilter) return false
    if (searchText) {
      const s = searchText.toLowerCase()
      return l.action.toLowerCase().includes(s)
        || (l.user_email ?? '').toLowerCase().includes(s)
        || (l.resource ?? '').toLowerCase().includes(s)
        || (l.ip_address ?? '').toLowerCase().includes(s)
    }
    return true
  })

  // Paginated slices
  const pagedAudit    = filteredAudit.slice(auditPage * AUDIT_PAGE_SIZE, (auditPage + 1) * AUDIT_PAGE_SIZE)
  const pagedSessions = recordings.slice(sessionPage * SESSION_PAGE_SIZE, (sessionPage + 1) * SESSION_PAGE_SIZE)

  const handleCategoryChange = (cat: Category | 'all') => {
    setCategoryFilter(cat)
    setAuditPage(0)
  }

  const handleSearchChange = (val: string) => {
    setSearchText(val)
    setAuditPage(0)
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold text-white">Logs</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-800">
        {(['audit', 'sessions'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${tab === t ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>
            {t === 'audit' ? `Audit Log${auditLogs.length ? ` (${auditLogs.length})` : ''}` : `Session Recordings${recordings.length ? ` (${recordings.length})` : ''}`}
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
                      <div className="px-3 py-1.5 text-xs text-gray-400 font-semibold uppercase tracking-wide border-b border-gray-700 mb-1">Delete entries…</div>
                      {(['30', '60', '90', 'all'] as OlderThan[]).map((opt) => (
                        <button key={opt} onClick={() => clearAuditLogs(opt)}
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
                  <div className="px-3 py-1.5 text-xs text-gray-400 font-semibold uppercase tracking-wide border-b border-gray-700 mb-1">Delete recordings…</div>
                  {(['30', '60', '90', 'all'] as OlderThan[]).map((opt) => (
                    <button key={opt} onClick={() => clearAllRecordings(opt)}
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

      {/* ── Audit Log ── */}
      {tab === 'audit' && (
        <div className="space-y-3">
          {/* Category filter pills */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <button
              onClick={() => handleCategoryChange('all')}
              style={{
                padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                background: categoryFilter === 'all' ? '#4f46e5' : 'transparent',
                color: categoryFilter === 'all' ? '#fff' : '#9ca3af',
                border: `1px solid ${categoryFilter === 'all' ? '#4f46e5' : '#374151'}`,
              }}>
              All <span style={{ fontWeight: 400, opacity: 0.75 }}>({auditLogs.length})</span>
            </button>
            {availableCategories.sort().map(cat => {
              const m = CATEGORY_META[cat]
              const count = auditLogs.filter(l => getCategory(l.action) === cat).length
              const active = categoryFilter === cat
              return (
                <button key={cat} onClick={() => handleCategoryChange(cat)}
                  style={{
                    padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: active ? m.bg : 'transparent',
                    color: active ? m.color : '#6b7280',
                    border: `1px solid ${active ? m.border : '#374151'}`,
                  }}>
                  {m.label} <span style={{ fontWeight: 400, opacity: 0.75 }}>({count})</span>
                </button>
              )
            })}
          </div>

          {/* Search bar + stats */}
          <div className="flex items-center gap-2">
            <input value={searchText} onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search action, user, resource, IP…"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 w-72" />
            {(searchText || categoryFilter !== 'all') && (
              <button onClick={() => { setSearchText(''); setCategoryFilter('all'); setAuditPage(0) }}
                className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded border border-gray-700 hover:border-gray-500">
                ✕ Clear
              </button>
            )}
            <span className="text-xs text-gray-500 ml-1">
              {filteredAudit.length !== auditLogs.length
                ? `${filteredAudit.length} of ${auditLogs.length} entries`
                : `${auditLogs.length} entries`}
            </span>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
            <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 560 }}>
              <colgroup>
                <col style={{ width: '18%' }} /><col style={{ width: '18%' }} />
                <col style={{ width: '26%' }} /><col style={{ width: '24%' }} />
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
                {pagedAudit.map((l) => (
                  <tr key={l.id} className="hover:bg-gray-800/30">
                    <td className="px-3 py-2 text-gray-500 text-xs" style={{ whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-gray-300 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.user_email ?? '—'}</td>
                    <td className="px-3 py-2" style={{ maxWidth: 260 }}><ActionBadge action={l.action} /></td>
                    <td className="px-3 py-2 text-gray-400 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.resource ?? '—'}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{l.ip_address ?? '—'}</td>
                  </tr>
                ))}
                {pagedAudit.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                    {searchText || categoryFilter !== 'all' ? 'No entries match your filter.' : 'No entries.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination page={auditPage} total={filteredAudit.length} pageSize={AUDIT_PAGE_SIZE} onChange={setAuditPage} />
        </div>
      )}

      {/* ── Session Recordings ── */}
      {tab === 'sessions' && (
        <div className="space-y-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
            <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 580 }}>
              <colgroup>
                <col style={{ width: '20%' }} /><col style={{ width: '14%' }} />
                <col style={{ width: '14%' }} /><col style={{ width: '14%' }} />
                <col style={{ width: '10%' }} /><col style={{ width: '28%' }} />
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
                {pagedSessions.map((r) => {
                  const dur = r.duration_s != null
                    ? `${Math.floor(r.duration_s / 60)}m ${r.duration_s % 60}s`
                    : '—'
                  return (
                    <tr key={r.id} className="hover:bg-gray-800/30">
                      <td className="px-3 py-2 text-gray-400 text-xs" style={{ whiteSpace: 'nowrap' }}>{new Date(r.started_at).toLocaleString()}</td>
                      <td className="px-3 py-2 text-gray-300 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.user_id?.slice(0, 8) ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-300 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.server_id?.slice(0, 8) ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-indigo-300" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.linux_user ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-400 text-xs">{dur}</td>
                      <td className="px-3 py-2">
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'center' }}>
                          {r.cast_file_path && (
                            <button onClick={() => setPlayingRec(r)}
                              className={`px-2 py-1 text-xs rounded transition-colors text-white ${playingRec?.id === r.id ? 'bg-indigo-700' : 'bg-indigo-600 hover:bg-indigo-500'}`}
                              style={{ whiteSpace: 'nowrap' }}>
                              ▶ Play
                            </button>
                          )}
                          {r.cast_file_path && (
                            <a href={`/api/logs/sessions/${r.id}/download`}
                              className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                              style={{ whiteSpace: 'nowrap' }} download>
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
                  )
                })}
                {pagedSessions.length === 0 && <tr><td colSpan={6} className="px-3 py-5 text-center text-gray-500">No recordings.</td></tr>}
              </tbody>
            </table>
          </div>

          <Pagination page={sessionPage} total={recordings.length} pageSize={SESSION_PAGE_SIZE} onChange={setSessionPage} />
        </div>
      )}

      {/* ── Player Modal ── */}
      {playingRec && <PlayerModal recording={playingRec} onClose={() => setPlayingRec(null)} />}
    </div>
  )
}
