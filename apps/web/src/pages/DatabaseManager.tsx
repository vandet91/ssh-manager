import { useEffect, useState, useCallback } from 'react'
import { api } from '../api/client'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Overview {
  version: string
  size: string
  size_bytes: number
  connections: { total: string; active: string; idle: string; waiting: string }
  cache_hit_ratio: string
  transactions: { total_txn: string; commits: string; rollbacks: string }
  uptime: string
  started_at: string
}

interface TableInfo {
  schemaname: string
  tablename: string
  total_size: string
  total_size_bytes: number
  table_size: string
  index_size: string
  row_count: number
  dead_rows: number
  last_vacuum: string | null
  last_analyze: string | null
}

interface IndexInfo {
  schemaname: string
  tablename: string
  indexname: string
  index_size: string
  size_bytes: number
  scans: number
  tuples_read: number
  indexdef: string
}

interface Connection {
  pid: number
  usename: string
  application_name: string
  client_addr: string
  state: string
  wait_event_type: string | null
  wait_event: string | null
  query_duration: string | null
  query: string | null
}

interface SlowQuery {
  queryid: string
  query: string
  calls: number
  avg_ms: number
  total_ms: number
  min_ms: number
  max_ms: number
  rows: number
}

interface Backup {
  id: string
  filename: string
  size_bytes: number | null
  status: 'pending' | 'running' | 'completed' | 'failed'
  error: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

interface QueryResult {
  rows: Record<string, unknown>[]
  fields: { name: string }[]
  row_count: number | null
  duration_ms: number
  command: string
}

type Tab = 'overview' | 'tables' | 'indexes' | 'connections' | 'slow-queries' | 'maintenance' | 'query' | 'backups'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString()
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

function fmtBytes(b: number | null) {
  if (b == null) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const TAB_LABELS: Record<Tab, string> = {
  overview: '📊 Overview',
  tables: '📋 Tables',
  indexes: '🗂 Indexes',
  connections: '🔌 Connections',
  'slow-queries': '🐢 Slow Queries',
  maintenance: '🔧 Maintenance',
  query: '⌨ Query Runner',
  backups: '💾 Backups',
}

const STATUS_COLOR: Record<string, string> = {
  active: '#10b981', idle: '#6b7280', 'idle in transaction': '#f59e0b',
  completed: '#10b981', failed: '#ef4444', running: '#3b82f6', pending: '#6b7280',
}

// ── Shared card style ─────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '16px 20px',
}

const tblHead: React.CSSProperties = {
  background: 'var(--bg-hover)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
}

const td: React.CSSProperties = {
  padding: '7px 12px',
  fontSize: 13,
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...card, minWidth: 160 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Spinner() {
  return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab() {
  const [data, setData] = useState<Overview | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get('/db-manager/overview').then((r: any) => setData(r)).catch(e => setErr(e.message))
    const t = setInterval(() => {
      api.get('/db-manager/overview').then((r: any) => setData(r)).catch(() => {})
    }, 10000)
    return () => clearInterval(t)
  }, [])

  if (err) return <div style={{ color: '#ef4444', padding: 16 }}>{err}</div>
  if (!data) return <Spinner />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <StatCard label="Database Size" value={data.size} sub={fmtBytes(data.size_bytes)} />
        <StatCard label="Cache Hit Ratio" value={`${data.cache_hit_ratio ?? '—'}%`} />
        <StatCard label="Uptime" value={data.uptime ?? '—'} sub={`Since ${fmtDate(data.started_at)}`} />
        <StatCard label="Total Connections" value={fmt(+data.connections.total)} sub={`Active: ${data.connections.active} · Idle: ${data.connections.idle} · Waiting: ${data.connections.waiting}`} />
        <StatCard label="Commits" value={fmt(+data.transactions.commits)} sub={`Rollbacks: ${fmt(+data.transactions.rollbacks)}`} />
      </div>
      <div style={{ ...card }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>PostgreSQL Version</div>
        <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{data.version}</code>
      </div>
    </div>
  )
}

// ── Tables tab ────────────────────────────────────────────────────────────────

function TablesTab() {
  const [rows, setRows] = useState<TableInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<{ col: keyof TableInfo; dir: 1 | -1 }>({ col: 'total_size_bytes', dir: -1 })

  useEffect(() => {
    api.get('/db-manager/tables').then((r: any) => { setRows(r) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  function toggle(col: keyof TableInfo) {
    setSort(s => s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: -1 })
  }

  const sorted = [...rows].sort((a, b) => {
    const av = a[sort.col] ?? '', bv = b[sort.col] ?? ''
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir
  })

  const ColH = ({ col, label }: { col: keyof TableInfo; label: string }) => (
    <th style={{ ...th, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggle(col)}>
      {label}{sort.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  )

  if (loading) return <Spinner />
  return (
    <div style={{ ...card, padding: 0, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={tblHead}><tr>
          <ColH col="tablename" label="Table" />
          <ColH col="total_size_bytes" label="Total Size" />
          <ColH col="table_size" label="Table" />
          <ColH col="index_size" label="Indexes" />
          <ColH col="row_count" label="Rows" />
          <ColH col="dead_rows" label="Dead Rows" />
          <ColH col="last_vacuum" label="Last Vacuum" />
          <ColH col="last_analyze" label="Last Analyze" />
        </tr></thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.tablename} style={{ background: 'transparent' }}>
              <td style={td}><code style={{ fontSize: 12 }}>{r.tablename}</code></td>
              <td style={{ ...td, color: 'var(--text-muted)' }}>{r.total_size}</td>
              <td style={{ ...td, color: 'var(--text-muted)' }}>{r.table_size}</td>
              <td style={{ ...td, color: 'var(--text-muted)' }}>{r.index_size}</td>
              <td style={td}>{fmt(r.row_count)}</td>
              <td style={{ ...td, color: r.dead_rows > 1000 ? '#f59e0b' : 'inherit' }}>{fmt(r.dead_rows)}</td>
              <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(r.last_vacuum)}</td>
              <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(r.last_analyze)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Indexes tab ───────────────────────────────────────────────────────────────

function IndexesTab() {
  const [rows, setRows] = useState<IndexInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/db-manager/indexes').then((r: any) => { setRows(r) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner />
  return (
    <div style={{ ...card, padding: 0, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={tblHead}><tr>
          <th style={th}>Table</th>
          <th style={th}>Index</th>
          <th style={th}>Size</th>
          <th style={th}>Scans</th>
          <th style={th}>Tuples Read</th>
          <th style={th}>Definition</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.indexname}>
              <td style={td}><code style={{ fontSize: 12 }}>{r.tablename}</code></td>
              <td style={td}><code style={{ fontSize: 12 }}>{r.indexname}</code></td>
              <td style={{ ...td, color: 'var(--text-muted)' }}>{r.index_size}</td>
              <td style={td}>{fmt(r.scans)}</td>
              <td style={td}>{fmt(r.tuples_read)}</td>
              <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)', maxWidth: 400, wordBreak: 'break-all' }}>{r.indexdef}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Connections tab ───────────────────────────────────────────────────────────

function ConnectionsTab() {
  const [rows, setRows] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [killing, setKilling] = useState<number | null>(null)

  const load = useCallback(() => {
    api.get('/db-manager/connections').then((r: any) => { setRows(r) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  async function kill(pid: number) {
    if (!confirm(`Terminate connection PID ${pid}?`)) return
    setKilling(pid)
    try { await api.delete(`/db-manager/connections/${pid}`); load() }
    finally { setKilling(null) }
  }

  if (loading) return <Spinner />
  return (
    <div style={{ ...card, padding: 0, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={tblHead}><tr>
          <th style={th}>PID</th>
          <th style={th}>User</th>
          <th style={th}>App</th>
          <th style={th}>Client</th>
          <th style={th}>State</th>
          <th style={th}>Wait</th>
          <th style={th}>Duration</th>
          <th style={th}>Query</th>
          <th style={th}></th>
        </tr></thead>
        <tbody>
          {rows.length === 0
            ? <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>No connections</td></tr>
            : rows.map(r => (
              <tr key={r.pid}>
                <td style={td}><code>{r.pid}</code></td>
                <td style={td}>{r.usename}</td>
                <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{r.application_name}</td>
                <td style={{ ...td, fontSize: 11 }}>{r.client_addr ?? 'local'}</td>
                <td style={td}><span style={{ color: STATUS_COLOR[r.state] ?? 'inherit', fontWeight: 600, fontSize: 12 }}>{r.state}</span></td>
                <td style={{ ...td, fontSize: 11, color: r.wait_event_type === 'Lock' ? '#ef4444' : 'var(--text-muted)' }}>{r.wait_event ?? '—'}</td>
                <td style={{ ...td, fontSize: 11 }}>{r.query_duration ?? '—'}</td>
                <td style={{ ...td, fontSize: 11, maxWidth: 300, wordBreak: 'break-all', color: 'var(--text-muted)' }}>{r.query?.slice(0, 120) ?? '—'}</td>
                <td style={td}>
                  <button onClick={() => kill(r.pid)} disabled={killing === r.pid}
                    style={{ padding: '2px 8px', fontSize: 11, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                    Kill
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Slow queries tab ──────────────────────────────────────────────────────────

function SlowQueriesTab() {
  const [rows, setRows] = useState<SlowQuery[]>([])
  const [loading, setLoading] = useState(true)
  const [noExt, setNoExt] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [resetting, setResetting] = useState(false)

  async function load() {
    try {
      const r: any = await api.get('/db-manager/slow-queries')
      setRows(r); setLoading(false)
    } catch (e: any) {
      if (e.status === 404) setNoExt(true)
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function enable() {
    setEnabling(true)
    try { await api.post('/db-manager/slow-queries/enable'); await load() }
    finally { setEnabling(false) }
  }

  async function reset() {
    if (!confirm('Reset pg_stat_statements statistics?')) return
    setResetting(true)
    try { await api.post('/db-manager/slow-queries/reset'); await load() }
    finally { setResetting(false) }
  }

  if (loading) return <Spinner />
  if (noExt) return (
    <div style={{ ...card, textAlign: 'center', padding: 40 }}>
      <div style={{ fontSize: 18, marginBottom: 8 }}>pg_stat_statements not enabled</div>
      <div style={{ color: 'var(--text-muted)', marginBottom: 16 }}>Enable this extension to track slow queries.</div>
      <button onClick={enable} disabled={enabling}
        style={{ padding: '8px 20px', background: 'var(--accent-hex)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
        {enabling ? 'Enabling…' : 'Enable Extension'}
      </button>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={reset} disabled={resetting}
          style={{ padding: '6px 14px', fontSize: 12, background: 'var(--bg-hover)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
          {resetting ? 'Resetting…' : '🗑 Reset Stats'}
        </button>
      </div>
      <div style={{ ...card, padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={tblHead}><tr>
            <th style={th}>Query</th>
            <th style={{ ...th, textAlign: 'right' }}>Calls</th>
            <th style={{ ...th, textAlign: 'right' }}>Avg (ms)</th>
            <th style={{ ...th, textAlign: 'right' }}>Total (ms)</th>
            <th style={{ ...th, textAlign: 'right' }}>Min (ms)</th>
            <th style={{ ...th, textAlign: 'right' }}>Max (ms)</th>
            <th style={{ ...th, textAlign: 'right' }}>Rows</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.queryid ?? i}>
                <td style={{ ...td, maxWidth: 500, wordBreak: 'break-all', fontSize: 11, fontFamily: 'monospace' }}>{r.query}</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(r.calls)}</td>
                <td style={{ ...td, textAlign: 'right', color: r.avg_ms > 1000 ? '#ef4444' : r.avg_ms > 100 ? '#f59e0b' : 'inherit' }}>{r.avg_ms}</td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>{r.total_ms}</td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>{r.min_ms}</td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>{r.max_ms}</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(r.rows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Maintenance tab ────────────────────────────────────────────────────────────

function MaintenanceTab({ tables }: { tables: string[] }) {
  const [op, setOp] = useState('vacuum_analyze')
  const [table, setTable] = useState('')

  useEffect(() => { setTable('') }, [tables])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; duration_ms: number } | null>(null)
  const [err, setErr] = useState('')

  async function run() {
    setRunning(true); setResult(null); setErr('')
    try {
      const r: any = await api.post('/db-manager/maintenance', { operation: op, table: table || undefined })
      setResult(r)
    } catch (e: any) {
      setErr(e.data?.error ?? e.message)
    } finally {
      setRunning(false)
    }
  }

  const ops = [
    { value: 'vacuum', label: 'VACUUM — reclaim dead row space' },
    { value: 'vacuum_analyze', label: 'VACUUM ANALYZE — reclaim + update stats' },
    { value: 'vacuum_full', label: 'VACUUM FULL — full rewrite (locks table)' },
    { value: 'analyze', label: 'ANALYZE — update planner statistics' },
    { value: 'reindex', label: 'REINDEX — rebuild indexes' },
  ]

  const sel: React.CSSProperties = {
    background: 'var(--bg-input, var(--bg-hover))',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text)',
    padding: '8px 12px',
    fontSize: 13,
    width: '100%',
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Operation</label>
        <select value={op} onChange={e => setOp(e.target.value)} style={sel}>
          {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Table (optional — leave empty for entire database)</label>
        <select value={table} onChange={e => setTable(e.target.value)} style={sel}>
          <option value="">— All tables —</option>
          {tables.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <button onClick={run} disabled={running}
        style={{ display: 'block', padding: '10px 28px', background: 'var(--accent-hex)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
        {running ? '⏳ Running…' : '▶ Run'}
      </button>
      {result && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: '#10b98122', border: '1px solid #10b981', borderRadius: 6, color: '#10b981' }}>
          ✅ Completed in {result.duration_ms}ms
        </div>
      )}
      {err && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: '#ef444422', border: '1px solid #ef4444', borderRadius: 6, color: '#ef4444' }}>
          ❌ {err}
        </div>
      )}
    </div>
  )
}

// ── Query Runner tab ──────────────────────────────────────────────────────────

function QueryTab() {
  const [sql, setSql] = useState('SELECT * FROM pg_stat_user_tables LIMIT 20;')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [err, setErr] = useState('')
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<string[]>([])

  async function run() {
    setRunning(true); setErr(''); setResult(null)
    try {
      const r: any = await api.post('/db-manager/query', { sql })
      setResult(r)
      setHistory(h => [sql, ...h.filter(q => q !== sql)].slice(0, 20))
    } catch (e: any) {
      setErr(e.data?.error ?? e.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {history.length > 0 && (
            <select onChange={e => { if (e.target.value) setSql(e.target.value) }}
              style={{ flex: 1, background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 12 }}>
              <option value="">History…</option>
              {history.map((q, i) => <option key={i} value={q}>{q.slice(0, 80)}</option>)}
            </select>
          )}
          <button onClick={run} disabled={running}
            style={{ padding: '6px 18px', background: 'var(--accent-hex)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
            {running ? 'Running…' : '▶ Run'}
          </button>
        </div>
        <textarea value={sql} onChange={e => setSql(e.target.value)}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run() } }}
          rows={8}
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text)', padding: '10px 12px', fontSize: 13, fontFamily: 'monospace',
            resize: 'vertical',
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Ctrl+Enter to run</div>
      </div>

      {err && <div style={{ padding: '10px 14px', background: '#ef444422', border: '1px solid #ef4444', borderRadius: 6, color: '#ef4444', fontFamily: 'monospace', fontSize: 12 }}>{err}</div>}

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {result.command} · {fmt(result.row_count)} rows · {result.duration_ms}ms
          </div>
          {result.fields.length > 0 && (
            <div style={{ ...card, padding: 0, overflow: 'auto', maxHeight: 400 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={tblHead}><tr>
                  {result.fields.map(f => <th key={f.name} style={th}>{f.name}</th>)}
                </tr></thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {result.fields.map(f => (
                        <td key={f.name} style={{ ...td, fontFamily: 'monospace', fontSize: 12, maxWidth: 300, wordBreak: 'break-all' }}>
                          {row[f.name] == null ? <span style={{ color: 'var(--text-muted)' }}>NULL</span> : String(row[f.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Backups tab ───────────────────────────────────────────────────────────────

function BackupsTab() {
  const [rows, setRows] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function load() {
    const r: any = await api.get('/db-manager/backups')
    setRows(r); setLoading(false)
  }

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [])

  async function create() {
    setCreating(true)
    try { await api.post('/db-manager/backups'); load() }
    finally { setCreating(false) }
  }

  async function del(id: string) {
    if (!confirm('Delete this backup?')) return
    setDeleting(id)
    try { await api.delete(`/db-manager/backups/${id}`); load() }
    finally { setDeleting(null) }
  }

  if (loading) return <Spinner />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={create} disabled={creating}
          style={{ padding: '8px 18px', background: 'var(--accent-hex)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
          {creating ? '⏳ Starting…' : '💾 Create Backup'}
        </button>
      </div>
      <div style={{ ...card, padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={tblHead}><tr>
            <th style={th}>Filename</th>
            <th style={th}>Status</th>
            <th style={th}>Size</th>
            <th style={th}>Started</th>
            <th style={th}>Completed</th>
            <th style={th}>Actions</th>
          </tr></thead>
          <tbody>
            {rows.length === 0
              ? <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>No backups yet</td></tr>
              : rows.map(r => (
                <tr key={r.id}>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{r.filename}</td>
                  <td style={td}>
                    <span style={{ color: STATUS_COLOR[r.status] ?? 'inherit', fontWeight: 600, fontSize: 12 }}>
                      {r.status === 'running' ? '⏳ ' : ''}{r.status}
                    </span>
                    {r.error && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>{r.error}</div>}
                  </td>
                  <td style={td}>{r.size_bytes ? fmtBytes(r.size_bytes) : '—'}</td>
                  <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(r.started_at)}</td>
                  <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(r.completed_at)}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {r.status === 'completed' && (
                        <a href={`/api/db-manager/backups/${r.id}/download`} download
                          style={{ padding: '3px 10px', fontSize: 12, background: 'var(--accent-hex)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', textDecoration: 'none' }}>
                          ⬇ Download
                        </a>
                      )}
                      <button onClick={() => del(r.id)} disabled={deleting === r.id}
                        style={{ padding: '3px 10px', fontSize: 12, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DatabaseManager() {
  const [tab, setTab] = useState<Tab>('overview')
  const [tableNames, setTableNames] = useState<string[]>([])

  useEffect(() => {
    api.get('/db-manager/tables').then((r: any) => setTableNames(r.map((t: TableInfo) => t.tablename))).catch(() => {})
  }, [])

  return (
    <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 22 }}>🗄</span>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Database Manager</h1>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '8px 14px', fontSize: 13, border: 'none', cursor: 'pointer',
              borderBottom: t === tab ? '2px solid var(--accent-hex)' : '2px solid transparent',
              background: 'transparent',
              color: t === tab ? 'var(--accent-hex)' : 'var(--text-muted)',
              fontWeight: t === tab ? 600 : 400,
              marginBottom: -1,
            }}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'overview'      && <OverviewTab />}
        {tab === 'tables'        && <TablesTab />}
        {tab === 'indexes'       && <IndexesTab />}
        {tab === 'connections'   && <ConnectionsTab />}
        {tab === 'slow-queries'  && <SlowQueriesTab />}
        {tab === 'maintenance'   && <MaintenanceTab tables={tableNames} />}
        {tab === 'query'         && <QueryTab />}
        {tab === 'backups'       && <BackupsTab />}
      </div>
    </div>
  )
}
