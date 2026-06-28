import { useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'ssh-mgr-debug'

interface LogEntry {
  id: number
  type: 'error' | 'warn' | 'info' | 'api'
  time: string
  message: string
  detail?: string
}

let _addEntry: ((e: Omit<LogEntry, 'id' | 'time'>) => void) | null = null
let _seq = 0

export function debugLog(type: LogEntry['type'], message: string, detail?: string) {
  _addEntry?.({ type, message, detail })
}

export default function DebugPanel() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [filter, setFilter] = useState<LogEntry['type'] | 'all'>('all')
  const bottomRef = useRef<HTMLDivElement>(null)

  function toggle() {
    setEnabled(v => {
      const next = !v
      localStorage.setItem(STORAGE_KEY, String(next))
      if (!next) { setOpen(false); setEntries([]) }
      return next
    })
  }

  useEffect(() => {
    if (!enabled) { _addEntry = null; return }
    _addEntry = (e) => {
      setEntries(prev => [...prev.slice(-199), { ...e, id: ++_seq, time: new Date().toLocaleTimeString() }])
    }
    return () => { _addEntry = null }
  }, [enabled])

  // Intercept console.error and console.warn
  useEffect(() => {
    if (!enabled) return
    const origError = console.error.bind(console)
    const origWarn = console.warn.bind(console)
    console.error = (...args) => {
      origError(...args)
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
      _addEntry?.({ type: 'error', message: msg.slice(0, 300) })
    }
    console.warn = (...args) => {
      origWarn(...args)
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
      _addEntry?.({ type: 'warn', message: msg.slice(0, 300) })
    }
    return () => { console.error = origError; console.warn = origWarn }
  }, [enabled])

  // Intercept unhandled promise rejections
  useEffect(() => {
    if (!enabled) return
    const handler = (e: PromiseRejectionEvent) => {
      _addEntry?.({ type: 'error', message: `Unhandled rejection: ${e.reason?.message ?? String(e.reason)}`, detail: e.reason?.stack })
    }
    window.addEventListener('unhandledrejection', handler)
    return () => window.removeEventListener('unhandledrejection', handler)
  }, [enabled])

  // Intercept global JS errors
  useEffect(() => {
    if (!enabled) return
    const handler = (e: ErrorEvent) => {
      _addEntry?.({ type: 'error', message: `${e.message} (${e.filename}:${e.lineno})`, detail: e.error?.stack })
    }
    window.addEventListener('error', handler)
    return () => window.removeEventListener('error', handler)
  }, [enabled])

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView()
  }, [open, entries.length])

  const visible = filter === 'all' ? entries : entries.filter(e => e.type === filter)
  const counts = { error: 0, warn: 0, api: 0, info: 0 }
  entries.forEach(e => counts[e.type]++)

  const TYPE_COLOR: Record<LogEntry['type'], string> = {
    error: '#ef4444',
    warn: '#f59e0b',
    api: '#3b82f6',
    info: '#10b981',
  }

  return (
    <>
      {/* Floating trigger button — left-click opens panel, right-click toggles enabled */}
      <button
        onClick={() => enabled && setOpen(o => !o)}
        onContextMenu={e => { e.preventDefault(); toggle() }}
        title={enabled ? 'Debug Panel (right-click to disable)' : 'Debug disabled (right-click to enable)'}
        style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 9998,
          width: 40, height: 40, borderRadius: '50%',
          background: !enabled ? '#374151' : counts.error > 0 ? '#ef4444' : '#1f2937',
          border: `2px solid ${enabled ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'}`,
          color: enabled ? '#fff' : '#6b7280', cursor: 'pointer', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
          opacity: enabled ? 1 : 0.5,
        }}
      >
        {enabled ? (counts.error > 0 ? `${counts.error}` : '🐛') : '🐛'}
      </button>

      {/* Panel */}
      {open && (
        <div style={{
          position: 'fixed', bottom: 64, right: 16, zIndex: 9997,
          width: 580, maxHeight: '60vh',
          background: '#0f172a', border: '1px solid #334155',
          borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          display: 'flex', flexDirection: 'column', fontFamily: 'monospace',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid #334155' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', flex: 1 }}>🐛 Debug Panel</span>
            <button onClick={toggle} style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid #334155', background: '#10b98133', color: '#10b981' }}>Disable</button>
            {(['all', 'error', 'warn', 'api', 'info'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: 'none',
                background: filter === f ? '#334155' : 'transparent',
                color: f === 'all' ? '#94a3b8' : f === 'error' ? '#ef4444' : f === 'warn' ? '#f59e0b' : f === 'api' ? '#3b82f6' : '#10b981',
                fontWeight: filter === f ? 700 : 400,
              }}>
                {f}{f !== 'all' ? ` (${counts[f]})` : ` (${entries.length})`}
              </button>
            ))}
            <button onClick={() => setEntries([])} style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: '1px solid #334155', background: 'transparent', color: '#94a3b8' }}>Clear</button>
            <button onClick={() => setOpen(false)} style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: 'none', background: 'transparent', color: '#94a3b8' }}>✕</button>
          </div>

          {/* Log list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
            {visible.length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#475569', fontSize: 12 }}>No entries</div>
            )}
            {visible.map(e => (
              <div key={e.id} style={{ padding: '4px 14px', borderBottom: '1px solid #1e293b' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 10, color: '#475569', flexShrink: 0 }}>{e.time}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: TYPE_COLOR[e.type], flexShrink: 0, textTransform: 'uppercase' }}>{e.type}</span>
                  <span style={{ fontSize: 11, color: '#cbd5e1', wordBreak: 'break-all' }}>{e.message}</span>
                </div>
                {e.detail && (
                  <pre style={{ margin: '2px 0 0 60px', fontSize: 10, color: '#64748b', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{e.detail.slice(0, 400)}</pre>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </>
  )
}
