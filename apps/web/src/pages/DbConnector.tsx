import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api/client'

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function summaryFromRules(rules: AnalysisRule[]) {
  const withResult = rules.filter(r => r.last_result)
  if (withResult.length === 0) return null
  return {
    total: withResult.length,
    pass: withResult.filter(r => r.last_result!.status === 'pass').length,
    fail: withResult.filter(r => r.last_result!.status === 'fail').length,
    error: withResult.filter(r => r.last_result!.status === 'error').length,
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type DbType = 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'mssql'

interface DbConnection {
  id: string
  server_id: string | null
  server_name?: string
  server_hostname?: string
  vault_id: string | null
  vault_title?: string | null
  name: string
  db_type: DbType
  host: string
  port: number
  database_name: string
  db_user: string | null
  use_ssh_tunnel: boolean
  ssl_enabled: boolean
  notes: string | null
  created_at: string
}

interface VaultEntry { id: string; title: string; username: string | null; url: string | null; linked_server_id: string | null }
interface Server { id: string; name: string; hostname: string; os_type?: string | null }

interface QueryResult {
  columns: string[]
  rows: unknown[][]
  duration_ms: number
  row_count: number
  total?: number
}

interface TableInfo { name: string; type: string; row_count?: number }
interface ColumnInfo { name: string; type: string; nullable: boolean; default_value: string | null; is_primary: boolean }
interface HistoryEntry { id: string; query: string; duration_ms: number | null; row_count: number | null; error: string | null; executed_at: string }

type Panel = 'query' | 'tables' | 'history' | 'backup' | 'analysis'

type RuleType = 'row_count' | 'null_rate' | 'uniqueness' | 'range' | 'custom_sql' | 'referential'

interface AnalysisRule {
  id: string
  connection_id: string
  name: string
  rule_type: RuleType
  table_name: string
  column_name: string | null
  params: Record<string, any>
  is_active: boolean
  created_at: string
  last_result?: { status: string; actual: string; expected: string; ran_at: string } | null
}

interface RunResult {
  rule_id: string
  rule_name: string
  status: 'pass' | 'fail' | 'error'
  actual: string
  expected: string
  details: any
  ran_at: string
}

interface CompareResult {
  table: string
  conn_a: { id: string; name: string; db_type: string; count: number | null; error: string | null }
  conn_b: { id: string; name: string; db_type: string; count: number | null; error: string | null }
  match: boolean
  diff: number | null
}

const DB_COLORS: Record<DbType, string> = {
  postgresql: '#336791',
  mysql:      '#f29111',
  sqlite:     '#003b57',
  mongodb:    '#47a248',
  mssql:      '#cc2927',
}

const DB_LABELS: Record<DbType, string> = {
  postgresql: 'PostgreSQL',
  mysql:      'MySQL',
  sqlite:     'SQLite',
  mongodb:    'MongoDB',
  mssql:      'SQL Server',
}

const DEFAULT_PORTS: Record<DbType, number> = {
  postgresql: 5432,
  mysql:      3306,
  sqlite:     0,
  mongodb:    27017,
  mssql:      1433,
}

const PLACEHOLDER_QUERY: Record<DbType, string> = {
  postgresql: 'SELECT * FROM users LIMIT 100;',
  mysql:      'SELECT * FROM users LIMIT 100;',
  sqlite:     'SELECT * FROM sqlite_master;',
  mongodb:    '{"find": "users", "filter": {}, "limit": 100}',
  mssql:      'SELECT TOP 100 * FROM users;',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Badge({ label, color }: { label: string; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 4, fontSize: 11,
      fontWeight: 600, background: color ?? 'var(--bg-panel-alt)', color: 'var(--text-primary)',
    }}>{label}</span>
  )
}

function Spinner() {
  return <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DbConnector() {
  const [connections, setConnections] = useState<DbConnection[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(true)
  const [servers, setServers] = useState<Server[]>([])
  const [filterServerId, setFilterServerId] = useState('')
  const filteredConnections = filterServerId ? connections.filter(c => c.server_id === filterServerId) : connections

  const [activeConn, setActiveConn] = useState<DbConnection | null>(null)
  const [useTunnel, setUseTunnel] = useState(false)
  const [panel, setPanel] = useState<Panel>('query')

  // Connection form
  const [showForm, setShowForm] = useState(false)
  const [editConn, setEditConn] = useState<DbConnection | null>(null)
  const [formServerId, setFormServerId] = useState('')
  const [formVaultId, setFormVaultId] = useState<string>('')
  const [formVaultTitle, setFormVaultTitle] = useState<string>('')
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([])
  const [form, setForm] = useState({
    name: '', db_type: 'postgresql' as DbType, host: '127.0.0.1', port: 5432,
    database_name: '', db_user: '', password: '', use_ssh_tunnel: false,
    ssl_enabled: false, notes: '',
  })
  const [formError, setFormError] = useState('')
  const [formBusy, setFormBusy] = useState(false)

  // Query runner
  const [query, setQuery] = useState('')
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState('')
  const [queryBusy, setQueryBusy] = useState(false)
  const [resultPage, setResultPage] = useState(0)
  const PAGE_SIZE = 100

  // Table browser
  const [tables, setTables] = useState<TableInfo[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([])
  const [tableRows, setTableRows] = useState<QueryResult | null>(null)
  const [tableRowPage, setTableRowPage] = useState(0)
  const [tableLoading, setTableLoading] = useState(false)
  const [tableFilter, setTableFilter] = useState('')
  const [schemaVisible, setSchemaVisible] = useState(false)

  // History
  const [history, setHistory] = useState<HistoryEntry[]>([])

  // Test connection
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; duration_ms?: number; error?: string }>>({})
  const [testBusyId, setTestBusyId] = useState<string | null>(null)

  // Backup
  const [backupPath, setBackupPath] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupResult, setBackupResult] = useState<string | null>(null)

  // Analysis
  const [analysisRules, setAnalysisRules] = useState<AnalysisRule[]>([])
  const [analysisRunning, setAnalysisRunning] = useState(false)
  const [analysisRunResults, setAnalysisRunResults] = useState<RunResult[] | null>(null)
  const [analysisSummary, setAnalysisSummary] = useState<{ total: number; pass: number; fail: number; error: number } | null>(null)
  const [showRuleForm, setShowRuleForm] = useState(false)
  const [editRule, setEditRule] = useState<AnalysisRule | null>(null)
  const [ruleForm, setRuleForm] = useState<{ name: string; rule_type: RuleType; table_name: string; column_name: string; params: string }>({
    name: '', rule_type: 'row_count', table_name: '', column_name: '', params: '{}',
  })
  const [ruleFormError, setRuleFormError] = useState('')
  // Compare
  const [compareConnB, setCompareConnB] = useState('')
  const [compareTable, setCompareTable] = useState('')
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null)
  const [compareBusy, setCompareBusy] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(() => {
    setConnectionsLoading(true)
    api.get<{ connections: DbConnection[] }>('/db/connections')
      .then(r => setConnections(r.connections))
      .catch(() => {})
      .finally(() => setConnectionsLoading(false))
    api.get<Server[]>('/servers').then(all => setServers(all.filter(s => s.os_type === 'linux' || s.os_type === 'windows'))).catch(() => {})
    api.get<VaultEntry[]>('/vault?type=database&limit=200')
      .then(rows => setVaultEntries(rows))
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  // ── Form helpers ─────────────────────────────────────────────────────────────

  function openCreate() {
    setEditConn(null)
    setFormServerId('')
    setFormVaultId('')
    setFormVaultTitle('')
    setForm({ name: '', db_type: 'postgresql', host: '127.0.0.1', port: 5432, database_name: '', db_user: '', password: '', use_ssh_tunnel: true, ssl_enabled: false, notes: '' })
    setFormError('')
    setShowForm(true)
  }

  function openEdit(c: DbConnection) {
    setEditConn(c)
    setFormServerId(c.server_id ?? '')
    setFormVaultId(c.vault_id ?? '')
    setFormVaultTitle(c.vault_title ?? '')
    setForm({ name: c.name, db_type: c.db_type, host: c.host, port: c.port, database_name: c.database_name, db_user: c.db_user ?? '', password: '', use_ssh_tunnel: c.use_ssh_tunnel, ssl_enabled: c.ssl_enabled, notes: c.notes ?? '' })
    setFormError('')
    setShowForm(true)
  }

  function applyVaultEntry(v: VaultEntry) {
    setFormVaultId(v.id)
    setFormVaultTitle(v.title)
    // Auto-fill username
    if (v.username) setForm(f => ({ ...f, db_user: v.username ?? f.db_user, password: '' }))
    // Parse host/port/db from url if it looks like a DB connection string
    if (v.url) {
      try {
        const u = new URL(v.url)
        if (u.hostname) setForm(f => ({ ...f, host: u.hostname }))
        if (u.port) setForm(f => ({ ...f, port: parseInt(u.port, 10) }))
        const dbName = u.pathname.replace(/^\//, '')
        if (dbName) setForm(f => ({ ...f, database_name: dbName }))
      } catch { /* not a valid URL, leave fields as-is */ }
    }
    // Auto-set SSH tunnel if vault entry is linked to a server
    if (v.linked_server_id) {
      setFormServerId(v.linked_server_id)
      setForm(f => ({ ...f, use_ssh_tunnel: true }))
    }
  }

  function clearVault() {
    setFormVaultId('')
    setFormVaultTitle('')
  }


  async function saveForm(e: React.FormEvent) {
    e.preventDefault(); setFormError(''); setFormBusy(true)
    const payload = {
      ...form,
      server_id: formServerId || null,
      vault_id: formVaultId || null,
      // Only send password if manually entered (vault-linked connections skip this)
      password: (formVaultId && !form.password) ? undefined : form.password || undefined,
    }
    try {
      if (editConn) {
        await api.patch(`/db/connections/${editConn.id}`, payload)
      } else {
        await api.post('/db/connections', payload)
      }
      setShowForm(false); load()
    } catch (err: any) { setFormError(err.message) }
    finally { setFormBusy(false) }
  }

  async function deleteConn(id: string) {
    if (!confirm('Delete this connection?')) return
    await api.delete(`/db/connections/${id}`)
    if (activeConn?.id === id) setActiveConn(null)
    load()
  }

  // ── Connect ───────────────────────────────────────────────────────────────────

  function connect(c: DbConnection) {
    setActiveConn(c)
    setUseTunnel(c.use_ssh_tunnel && !!c.server_id)
    setPanel('query')
    setQueryResult(null)
    setQueryError('')
    setQuery(PLACEHOLDER_QUERY[c.db_type])
    setTables([])
    setSelectedTable(null)
    setHistory([])
    setBackupResult(null)
  }

  // ── Test ──────────────────────────────────────────────────────────────────────

  async function testConnection(id: string) {
    setTestBusyId(id)
    setTestResults(prev => { const n = { ...prev }; delete n[id]; return n })
    try {
      const r = await api.post<any>(`/db/connections/${id}/test`, {})
      setTestResults(prev => ({ ...prev, [id]: r }))
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [id]: { ok: false, error: err.message } }))
    } finally { setTestBusyId(null) }
  }

  // ── Query runner ──────────────────────────────────────────────────────────────

  async function runQuery(q?: string) {
    if (!activeConn) return
    const sql = q ?? query
    if (!sql.trim()) return
    setQueryBusy(true); setQueryError(''); setQueryResult(null); setResultPage(0)
    try {
      const r = await api.post<QueryResult>(`/db/connections/${activeConn.id}/query`, { query: sql, use_ssh_tunnel: useTunnel })
      setQueryResult(r)
      loadHistory()
    } catch (err: any) {
      setQueryError(err.message)
      loadHistory()
    } finally { setQueryBusy(false) }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery() }
  }

  // ── Table browser ─────────────────────────────────────────────────────────────

  async function loadTables() {
    if (!activeConn) return
    setTablesLoading(true); setTables([])
    try {
      const r = await api.get<{ tables: TableInfo[] }>(`/db/connections/${activeConn.id}/schema?tunnel=${useTunnel}`)
      setTables(r.tables)
    } catch (err: any) { setQueryError(err.message) }
    finally { setTablesLoading(false) }
  }

  async function selectTable(name: string, page = 0) {
    if (!activeConn) return
    setSelectedTable(name); setTableLoading(true); setTableRows(null); setSchemaVisible(false)
    setTableRowPage(page)
    try {
      const [colsRes, rowsRes] = await Promise.all([
        api.get<{ columns: ColumnInfo[] }>(`/db/connections/${activeConn.id}/schema/${encodeURIComponent(name)}?tunnel=${useTunnel}`),
        api.post<QueryResult>(`/db/connections/${activeConn.id}/rows/${encodeURIComponent(name)}`, {
          limit: PAGE_SIZE, offset: page * PAGE_SIZE, where_clause: tableFilter || undefined, use_ssh_tunnel: useTunnel,
        }),
      ])
      setTableColumns(colsRes.columns)
      setTableRows(rowsRes)
    } catch (err: any) { setQueryError(err.message) }
    finally { setTableLoading(false) }
  }

  // ── History ───────────────────────────────────────────────────────────────────

  async function loadHistory() {
    if (!activeConn) return
    try {
      const r = await api.get<{ history: HistoryEntry[] }>(`/db/connections/${activeConn.id}/history`)
      setHistory(r.history)
    } catch {}
  }

  useEffect(() => {
    if (panel === 'tables' && activeConn) loadTables()
    if (panel === 'history' && activeConn) loadHistory()
    if (panel === 'analysis' && activeConn) { loadRules(); setAnalysisRunResults(null) }
  }, [panel, activeConn])

  // ── Backup ────────────────────────────────────────────────────────────────────

  async function runBackup() {
    if (!activeConn) return
    setBackupBusy(true); setBackupResult(null)
    try {
      const r = await api.post<any>(`/db/connections/${activeConn.id}/backup`, { save_path: backupPath || undefined, use_ssh_tunnel: useTunnel })
      setBackupResult(`✓ Backup saved to: ${r.path}`)
    } catch (err: any) { setBackupResult(`✗ ${err.message}`) }
    finally { setBackupBusy(false) }
  }

  // ── Analysis ──────────────────────────────────────────────────────────────────

  async function loadRules() {
    if (!activeConn) return
    const r = await api.get<{ rules: AnalysisRule[] }>(`/db/analysis/rules?connection_id=${activeConn.id}`)
    setAnalysisRules(r.rules)
    setAnalysisSummary(summaryFromRules(r.rules))
  }

  async function runAllRules() {
    if (!activeConn) return
    setAnalysisRunning(true); setAnalysisRunResults(null); setAnalysisSummary(null)
    try {
      const r = await api.post<{ summary: any; results: RunResult[] }>(`/db/analysis/connections/${activeConn.id}/run-all`, { use_ssh_tunnel: useTunnel })
      setAnalysisRunResults(r.results)
      setAnalysisSummary(r.summary)
      loadRules()
    } catch (err: any) { alert(err.message) }
    finally { setAnalysisRunning(false) }
  }

  async function runSingleRule(ruleId: string) {
    try {
      await api.post(`/db/analysis/rules/${ruleId}/run`, { use_ssh_tunnel: useTunnel })
      loadRules()
    } catch (err: any) { alert(err.message) }
  }

  async function deleteRule(ruleId: string) {
    if (!confirm('Delete this rule?')) return
    await api.delete(`/db/analysis/rules/${ruleId}`)
    loadRules()
  }

  function openRuleCreate() {
    setEditRule(null)
    setRuleForm({ name: '', rule_type: 'row_count', table_name: '', column_name: '', params: '{}' })
    setRuleFormError('')
    setShowRuleForm(true)
  }

  function openRuleEdit(rule: AnalysisRule) {
    setEditRule(rule)
    setRuleForm({ name: rule.name, rule_type: rule.rule_type, table_name: rule.table_name, column_name: rule.column_name ?? '', params: JSON.stringify(rule.params, null, 2) })
    setRuleFormError('')
    setShowRuleForm(true)
  }

  async function saveRule(e: React.FormEvent) {
    e.preventDefault(); setRuleFormError('')
    let params: any
    try { params = JSON.parse(ruleForm.params || '{}') } catch { setRuleFormError('Params must be valid JSON'); return }
    const body = { name: ruleForm.name, rule_type: ruleForm.rule_type, table_name: ruleForm.table_name, column_name: ruleForm.column_name || null, params }
    try {
      if (editRule) {
        await api.patch(`/db/analysis/rules/${editRule.id}`, body)
      } else {
        await api.post(`/db/analysis/rules?connection_id=${activeConn!.id}`, body)
      }
      setShowRuleForm(false); loadRules()
    } catch (err: any) { setRuleFormError(err.message) }
  }

  async function runCompare() {
    if (!activeConn || !compareConnB || !compareTable) return
    setCompareBusy(true); setCompareResult(null)
    try {
      const r = await api.post<CompareResult>('/db/analysis/compare', {
        conn_a: activeConn.id, conn_b: compareConnB, table_name: compareTable,
        use_tunnel_a: useTunnel, use_tunnel_b: false,
      })
      setCompareResult(r)
    } catch (err: any) { alert(err.message) }
    finally { setCompareBusy(false) }
  }

  // ── Export CSV ────────────────────────────────────────────────────────────────

  function exportCsv(result: QueryResult) {
    const header = result.columns.join(',')
    const rows = result.rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `query_result_${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  // ── Styles ─────────────────────────────────────────────────────────────────────

  const card: React.CSSProperties = { background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }
  const inputCls = 'db-input'
  const btnPrimary: React.CSSProperties = { padding: '6px 16px', borderRadius: 6, background: '#4f46e5', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
  const btnSecondary: React.CSSProperties = { padding: '6px 12px', borderRadius: 6, background: 'var(--bg-panel-alt)', color: 'var(--text-secondary)', border: '1px solid var(--border-med)', cursor: 'pointer', fontSize: 13 }
  const btnDanger: React.CSSProperties = { padding: '5px 10px', borderRadius: 6, background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12 }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 6, background: active ? '#4f46e5' : 'transparent',
    color: active ? '#fff' : 'var(--text-muted)', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400,
  })

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', gap: 0 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* ── Left sidebar — connections ── */}
      <div style={{ width: 280, minWidth: 220, borderRight: '1px solid var(--border-med)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-panel)' }}>
        <div style={{ padding: '14px 12px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>🗄 DB Connector</span>
          <button style={btnPrimary} onClick={openCreate}>+ New</button>
        </div>

        {/* Server filter */}
        {servers.length > 0 && (
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
            <select
              value={filterServerId}
              onChange={e => setFilterServerId(e.target.value)}
              style={{ width: '100%', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '4px 6px' }}
            >
              <option value="">All servers</option>
              {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {!connectionsLoading && connections.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
              No connections yet.<br />Click "+ New" to add one.
            </div>
          )}
          {filteredConnections.map(c => (
            <div key={c.id} onClick={() => connect(c)}
              style={{
                padding: '10px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                background: activeConn?.id === c.id ? 'rgba(79,70,229,0.15)' : 'transparent',
                border: `1px solid ${activeConn?.id === c.id ? '#4f46e5' : 'transparent'}`,
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (activeConn?.id !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-panel-alt)' }}
              onMouseLeave={e => { if (activeConn?.id !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: DB_COLORS[c.db_type], flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {DB_LABELS[c.db_type]} · {c.database_name || '—'}
                  {c.vault_id && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--accent-hex)20', color: 'var(--accent-hex)', fontWeight: 600 }}>🔐 vault</span>}
                </div>
                <div style={{ marginTop: 2 }}>{c.server_name ?? (c.server_id ? c.server_id.slice(0, 8) : 'Direct')}</div>
              </div>
              <div style={{ display: 'flex', gap: 4, marginTop: 6, paddingLeft: 14 }} onClick={e => e.stopPropagation()}>
                <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px' }} onClick={() => testConnection(c.id)}>
                  {testBusyId === c.id ? <Spinner /> : 'Test'}
                </button>
                <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px' }} onClick={() => openEdit(c)}>Edit</button>
                <button style={{ ...btnDanger, fontSize: 11, padding: '2px 8px' }} onClick={() => deleteConn(c.id)}>Del</button>
              </div>
              {testResults[c.id] && (
                <div style={{ marginTop: 4, paddingLeft: 14, fontSize: 11, color: testResults[c.id].ok ? 'var(--success)' : 'var(--error)' }}>
                  {testResults[c.id].ok ? `✓ Connected (${testResults[c.id].duration_ms}ms)` : `✗ ${testResults[c.id].error}`}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!activeConn ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 48 }}>🗄</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)' }}>Select a connection to start</div>
            <div style={{ fontSize: 13 }}>or create a new one with "+ New"</div>
          </div>
        ) : (
          <>
            {/* Connection header */}
            <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' }}>
              {/* Top row: connection info */}
              <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: DB_COLORS[activeConn.db_type], flexShrink: 0 }} />
                <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: 15 }}>{activeConn.name}</span>
                <Badge label={DB_LABELS[activeConn.db_type]} color={DB_COLORS[activeConn.db_type]} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{activeConn.database_name}{activeConn.server_name ? ` · ${activeConn.server_name}` : ' · Direct'}</span>
                {activeConn.server_id && (
                  <button
                    onClick={() => setUseTunnel(t => !t)}
                    style={{
                      padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                      background: useTunnel ? 'rgba(37,99,235,0.15)' : 'var(--bg-panel-alt)',
                      color: useTunnel ? '#3b82f6' : 'var(--text-muted)',
                    }}
                    title={useTunnel ? 'Connected via SSH tunnel — click to switch to direct' : 'Connected directly — click to switch to SSH tunnel'}
                  >
                    {useTunnel ? '🔒 SSH Tunnel' : '🌐 Direct'}
                  </button>
                )}
              </div>
              {/* Tab row */}
              <div style={{ padding: '0 12px 0', display: 'flex', gap: 4, overflowX: 'auto' }}>
                {(['query', 'tables', 'history', 'backup', 'analysis'] as Panel[]).map(p => (
                  <button key={p} style={{ ...tabStyle(panel === p), borderRadius: '6px 6px 0 0', padding: '6px 14px', whiteSpace: 'nowrap' }} onClick={() => setPanel(p)}>
                    {p === 'query' ? '▶ Query' : p === 'tables' ? '📋 Tables' : p === 'history' ? '🕐 History' : p === 'backup' ? '💾 Backup' : '🔍 Analysis'}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Query panel ── */}
            {panel === 'query' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16, gap: 10 }}>
                <div style={{ position: 'relative' }}>
                  <textarea
                    ref={textareaRef}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={PLACEHOLDER_QUERY[activeConn.db_type]}
                    rows={activeConn.db_type === 'mongodb' ? 6 : 5}
                    style={{
                      width: '100%', background: '#0d1117', border: '1px solid #30363d', borderRadius: 8,
                      padding: '12px 14px', color: '#e6edf3', fontSize: 13, fontFamily: 'monospace',
                      resize: 'vertical', outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                  <div style={{ position: 'absolute', bottom: 10, right: 10, display: 'flex', gap: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>Ctrl+Enter to run</span>
                    <button style={btnPrimary} onClick={() => runQuery()} disabled={queryBusy}>
                      {queryBusy ? <><Spinner /> Running…</> : '▶ Run'}
                    </button>
                  </div>
                </div>

                {queryError && (
                  <div style={{ padding: '10px 14px', background: 'rgba(192,57,43,0.08)', border: '1px solid var(--error)', borderRadius: 8, color: 'var(--error)', fontSize: 13 }}>
                    ✗ {queryError}
                  </div>
                )}

                {queryResult && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', ...card }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {queryResult.row_count.toLocaleString()} row{queryResult.row_count !== 1 ? 's' : ''} · {queryResult.duration_ms}ms
                      </span>
                      <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }} onClick={() => exportCsv(queryResult)}>⬇ Export CSV</button>
                    </div>
                    <ResultTable result={queryResult} page={resultPage} pageSize={PAGE_SIZE} onPage={setResultPage} />
                  </div>
                )}
              </div>
            )}

            {/* ── Tables panel ── */}
            {panel === 'tables' && (
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* Table list */}
                <div style={{ width: 220, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                    <input placeholder="Filter tables…" value={tableFilter}
                      onChange={e => setTableFilter(e.target.value)}
                      className={inputCls} style={{ fontSize: 12, padding: '4px 8px' }} />
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
                    {tablesLoading && <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}><Spinner /> Loading…</div>}
                    {tables.filter(t => t.name.toLowerCase().includes(tableFilter.toLowerCase())).map(t => (
                      <div key={t.name} onClick={() => selectTable(t.name)}
                        style={{
                          padding: '7px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 2,
                          background: selectedTable === t.name ? 'rgba(79,70,229,0.15)' : 'transparent',
                          border: `1px solid ${selectedTable === t.name ? '#4f46e5' : 'transparent'}`,
                        }}
                        onMouseEnter={e => { if (selectedTable !== t.name) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-panel-alt)' }}
                        onMouseLeave={e => { if (selectedTable !== t.name) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{t.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                          {t.type === 'VIEW' || t.type === 'view' ? 'View' : 'Table'}
                          {t.row_count != null ? ` · ~${t.row_count.toLocaleString()} rows` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Table content */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 }}>
                  {!selectedTable && (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                      Select a table to browse rows
                    </div>
                  )}
                  {selectedTable && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{selectedTable}</span>
                        {tableRows && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{tableRows.total?.toLocaleString() ?? tableRows.row_count.toLocaleString()} rows</span>}
                        <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px' }} onClick={() => setSchemaVisible(v => !v)}>
                          {schemaVisible ? 'Hide Schema' : 'Show Schema'}
                        </button>
                        <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px', marginLeft: 'auto' }}
                          onClick={() => { setQuery(`SELECT * FROM "${selectedTable}" LIMIT 100;`); setPanel('query') }}>
                          Open in Query
                        </button>
                        {tableRows && <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px' }} onClick={() => exportCsv(tableRows)}>⬇ CSV</button>}
                      </div>

                      {schemaVisible && tableColumns.length > 0 && (
                        <div style={{ marginBottom: 12, ...card, overflowX: 'auto' }}>
                          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                                {['Column', 'Type', 'Nullable', 'Default', 'PK'].map(h => (
                                  <th key={h} style={{ padding: '4px 10px', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {tableColumns.map(col => (
                                <tr key={col.name} style={{ borderBottom: '1px solid var(--border)' }}>
                                  <td style={{ padding: '4px 10px', fontFamily: 'monospace', color: col.is_primary ? '#818cf8' : 'var(--text)' }}>
                                    {col.is_primary ? '🔑 ' : ''}{col.name}
                                  </td>
                                  <td style={{ padding: '4px 10px', color: '#f59e0b', fontFamily: 'monospace' }}>{col.type}</td>
                                  <td style={{ padding: '4px 10px', color: col.nullable ? 'var(--text-muted)' : 'var(--success)' }}>{col.nullable ? 'YES' : 'NO'}</td>
                                  <td style={{ padding: '4px 10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{col.default_value ?? '—'}</td>
                                  <td style={{ padding: '4px 10px' }}>{col.is_primary ? '✓' : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {tableLoading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><Spinner /> Loading rows…</div>}
                      {tableRows && !tableLoading && (
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', ...card }}>
                          <ResultTable result={tableRows} page={tableRowPage} pageSize={PAGE_SIZE}
                            onPage={p => { setTableRowPage(p); selectTable(selectedTable!, p) }}
                            total={tableRows.total}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── History panel ── */}
            {panel === 'history' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
                {history.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No query history yet.</div>}
                {history.map(h => (
                  <div key={h.id} style={{ ...card, marginBottom: 8, cursor: 'pointer' }}
                    onClick={() => { setQuery(h.query); setPanel('query') }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: h.error ? 'var(--error)' : 'var(--success)' }}>{h.error ? '✗' : '✓'}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new Date(h.executed_at).toLocaleString()}</span>
                      {h.duration_ms != null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.duration_ms}ms</span>}
                      {h.row_count != null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.row_count} rows</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: '#818cf8' }}>Click to reuse →</span>
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#e6edf3', background: '#0d1117', padding: '8px 10px', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {h.query.slice(0, 300)}{h.query.length > 300 ? '…' : ''}
                    </div>
                    {h.error && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--error)' }}>{h.error}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* ── Analysis panel ── */}
            {panel === 'analysis' && (
              <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                  <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Data Quality Rules</h2>
                  <button style={btnPrimary} onClick={openRuleCreate}>+ Add Rule</button>
                  <button style={{ ...btnSecondary, marginLeft: 'auto' }} onClick={runAllRules} disabled={analysisRunning || analysisRules.filter(r => r.is_active).length === 0}>
                    {analysisRunning ? <><Spinner /> Running…</> : `▶ Run All (${analysisRules.filter(r => r.is_active).length})`}
                  </button>
                </div>

                {/* Summary bar */}
                {analysisSummary && (
                  <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                    {[
                      { label: 'Total', val: analysisSummary.total, color: 'var(--text-secondary)' },
                      { label: 'Pass', val: analysisSummary.pass, color: 'var(--success)' },
                      { label: 'Fail', val: analysisSummary.fail, color: 'var(--error)' },
                      { label: 'Error', val: analysisSummary.error, color: 'var(--warning)' },
                    ].map(s => (
                      <div key={s.label} style={{ ...card, padding: '8px 16px', textAlign: 'center', minWidth: 70 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.val}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Rules list */}
                {analysisRules.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>
                    No rules yet. Add one to start checking data quality.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 32 }}>
                    {analysisRules.map(rule => {
                      const last = rule.last_result
                      const runResult = analysisRunResults?.find(r => r.rule_id === rule.id)
                      const display = runResult ?? last
                      return (
                        <div key={rule.id} style={{ ...card, padding: '12px 16px', opacity: rule.is_active ? 1 : 0.5 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            {display && (
                              <span style={{ fontSize: 16 }}>
                                {display.status === 'pass' ? '✅' : display.status === 'fail' ? '❌' : '⚠️'}
                              </span>
                            )}
                            {!display && <span style={{ fontSize: 16, color: 'var(--text-muted)' }}>○</span>}
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{rule.name}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                {rule.rule_type} · {rule.table_name}{rule.column_name ? `.${rule.column_name}` : ''}
                                {display?.ran_at && <span style={{ marginLeft: 8, opacity: 0.6 }}>· {timeAgo(display.ran_at)}</span>}
                              </div>
                            </div>
                            {display && (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
                                <div style={{ color: display.status === 'pass' ? 'var(--success)' : display.status === 'fail' ? 'var(--error)' : 'var(--warning)' }}>
                                  {display.actual}
                                </div>
                                <div>expected: {display.expected}</div>
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px' }} onClick={() => runSingleRule(rule.id)}>Run</button>
                              <button style={{ ...btnSecondary, fontSize: 11, padding: '2px 8px' }} onClick={() => openRuleEdit(rule)}>Edit</button>
                              <button style={{ ...btnDanger, fontSize: 11, padding: '2px 8px' }} onClick={() => deleteRule(rule.id)}>Del</button>
                            </div>
                          </div>
                          {display && display.status !== 'pass' && (display as any).details?.message && (
                            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--error)', background: 'rgba(192,57,43,0.08)', padding: '4px 8px', borderRadius: 4 }}>
                              {(display as any).details.message}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Compare section */}
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>Compare with Another Connection</h3>
                <div style={{ ...card, padding: 16, maxWidth: 560 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ display: 'block' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Compare with connection</span>
                      <select value={compareConnB} onChange={e => setCompareConnB(e.target.value)} className={inputCls}>
                        <option value="">— Select connection —</option>
                        {connections.filter(c => c.id !== activeConn.id).map(c => (
                          <option key={c.id} value={c.id}>{c.name} ({c.db_type})</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: 'block' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Table name</span>
                      <input value={compareTable} onChange={e => setCompareTable(e.target.value)} placeholder="e.g. users" className={inputCls} />
                    </label>
                    <button style={btnPrimary} onClick={runCompare} disabled={compareBusy || !compareConnB || !compareTable}>
                      {compareBusy ? <><Spinner /> Comparing…</> : '🔄 Compare'}
                    </button>
                  </div>
                  {compareResult && (
                    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                      <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                        {[compareResult.conn_a, compareResult.conn_b].map((c, i) => (
                          <div key={i} style={{ flex: 1, background: 'var(--bg-panel-alt)', borderRadius: 8, padding: '10px 14px' }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{i === 0 ? 'THIS connection' : 'OTHER connection'}</div>
                            <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{c.name}</div>
                            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{c.db_type}</div>
                            {c.error ? (
                              <div style={{ color: 'var(--error)', fontSize: 12, marginTop: 6 }}>{c.error}</div>
                            ) : (
                              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-heading)', marginTop: 6 }}>{c.count?.toLocaleString()}</div>
                            )}
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>rows in "{compareResult.table}"</div>
                          </div>
                        ))}
                      </div>
                      <div style={{
                        padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, textAlign: 'center',
                        background: compareResult.match ? 'rgba(61,139,78,0.1)' : 'rgba(192,57,43,0.1)',
                        color: compareResult.match ? 'var(--success)' : 'var(--error)',
                        border: `1px solid ${compareResult.match ? 'var(--success)' : 'var(--error)'}`,
                      }}>
                        {compareResult.match ? '✅ Row counts match' : `❌ Difference: ${compareResult.diff !== null ? (compareResult.diff > 0 ? '+' : '') + compareResult.diff.toLocaleString() : 'N/A'} rows`}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Backup panel ── */}
            {panel === 'backup' && (
              <div style={{ flex: 1, padding: 24, maxWidth: 600 }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 16 }}>Database Backup</h2>
                <div style={{ ...card, marginBottom: 16 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                    Creates a backup on the remote server using the native dump tool for <strong style={{ color: 'var(--text)' }}>{DB_LABELS[activeConn.db_type]}</strong>.
                    The file is saved on the server (not downloaded here).
                  </div>
                  <label style={{ display: 'block', marginBottom: 12 }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Save path on server (optional)</span>
                    <input value={backupPath} onChange={e => setBackupPath(e.target.value)}
                      placeholder={`/tmp/${activeConn.database_name || 'backup'}.sql`}
                      className={inputCls} />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>Leave blank for auto-generated path in /tmp</span>
                  </label>
                  <button style={btnPrimary} onClick={runBackup} disabled={backupBusy}>
                    {backupBusy ? <><Spinner /> Running backup…</> : '💾 Run Backup'}
                  </button>
                </div>
                {backupResult && (
                  <div style={{
                    padding: '12px 16px', borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                    background: backupResult.startsWith('✓') ? '#052e16' : '#1c0a0a',
                    border: `1px solid ${backupResult.startsWith('✓') ? 'var(--success)' : 'var(--error)'}`,
                    color: backupResult.startsWith('✓') ? 'var(--success)' : 'var(--error)',
                  }}>
                    {backupResult}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Rule form modal ── */}
      {showRuleForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: 460, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 16 }}>
              {editRule ? 'Edit Rule' : 'New Analysis Rule'}
            </h2>
            <form onSubmit={saveRule} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {ruleFormError && <div style={{ color: 'var(--error)', fontSize: 13 }}>{ruleFormError}</div>}

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Rule Name *</span>
                <input value={ruleForm.name} onChange={e => setRuleForm(f => ({ ...f, name: e.target.value }))} required placeholder="Users count > 0" className={inputCls} />
              </label>

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Rule Type *</span>
                <select value={ruleForm.rule_type} onChange={e => setRuleForm(f => ({ ...f, rule_type: e.target.value as RuleType }))} className={inputCls}>
                  <option value="row_count">Row Count — table must have N rows</option>
                  <option value="null_rate">Null Rate — column null % must be low</option>
                  <option value="uniqueness">Uniqueness — column must have no duplicates</option>
                  <option value="range">Range — column min/max within bounds</option>
                  <option value="referential">Referential Integrity — no orphan FK rows</option>
                  <option value="custom_sql">Custom SQL — query must return truthy</option>
                </select>
              </label>

              {ruleForm.rule_type !== 'custom_sql' && (
                <label style={{ display: 'block' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Table Name *</span>
                  <input value={ruleForm.table_name} onChange={e => setRuleForm(f => ({ ...f, table_name: e.target.value }))} required placeholder="users" className={inputCls} />
                </label>
              )}

              {['null_rate', 'uniqueness', 'range', 'referential'].includes(ruleForm.rule_type) && (
                <label style={{ display: 'block' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Column Name *</span>
                  <input value={ruleForm.column_name} onChange={e => setRuleForm(f => ({ ...f, column_name: e.target.value }))} required placeholder="email" className={inputCls} />
                </label>
              )}

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                  Params (JSON) &nbsp;
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    {ruleForm.rule_type === 'row_count' ? '{"min": 1, "max": 10000}' :
                     ruleForm.rule_type === 'null_rate' ? '{"max_pct": 5}' :
                     ruleForm.rule_type === 'range' ? '{"min": 0, "max": 999}' :
                     ruleForm.rule_type === 'referential' ? '{"ref_table": "roles", "ref_column": "id"}' :
                     ruleForm.rule_type === 'custom_sql' ? '{"sql": "SELECT COUNT(*) FROM users WHERE active = true"}' : '{}'}
                  </span>
                </span>
                <textarea
                  value={ruleForm.params}
                  onChange={e => setRuleForm(f => ({ ...f, params: e.target.value }))}
                  rows={4} className={inputCls}
                  style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                />
              </label>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" style={btnSecondary} onClick={() => setShowRuleForm(false)}>Cancel</button>
                <button type="submit" style={btnPrimary}>{editRule ? 'Save' : 'Create Rule'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Connection form modal ── */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: 480, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)', marginBottom: 16 }}>
              {editConn ? 'Edit Connection' : 'New DB Connection'}
            </h2>
            <form onSubmit={saveForm} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {formError && <div style={{ color: 'var(--error)', fontSize: 13 }}>{formError}</div>}

              {/* ── Vault link ── */}
              <div style={{ background: 'var(--bg-body)', border: '1px solid var(--border-med)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  🔐 Vault Credentials <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional — password pulled from vault at connect time)</span>
                </div>
                {formVaultId ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--accent-hex)', fontWeight: 600 }}>🔐 {formVaultTitle}</span>
                    <button type="button" onClick={clearVault} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕ Remove</button>
                  </div>
                ) : (
                  <select
                    value=""
                    onChange={e => {
                      const v = vaultEntries.find(x => x.id === e.target.value)
                      if (v) applyVaultEntry(v)
                    }}
                    className={inputCls}
                  >
                    <option value="">— Select vault entry to import credentials —</option>
                    {vaultEntries.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.title}{v.username ? ` (${v.username})` : ''}{v.linked_server_id ? ' 🔗 SSH' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Server <span style={{ color: 'var(--text-muted)' }}>(optional — required for SSH tunnel)</span></span>
                <select value={formServerId} onChange={e => setFormServerId(e.target.value)} className={inputCls}>
                  <option value="">— Direct connection (no server) —</option>
                  {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>)}
                </select>
              </label>

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Connection Name *</span>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="My PostgreSQL DB" className={inputCls} />
              </label>

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Database Type *</span>
                <select value={form.db_type} onChange={e => {
                  const t = e.target.value as DbType
                  setForm(f => ({ ...f, db_type: t, port: DEFAULT_PORTS[t] }))
                }} className={inputCls}>
                  {(Object.keys(DB_LABELS) as DbType[]).map(t => <option key={t} value={t}>{DB_LABELS[t]}</option>)}
                </select>
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 8 }}>
                <label style={{ display: 'block' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Host</span>
                  <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} placeholder="127.0.0.1" className={inputCls} />
                </label>
                <label style={{ display: 'block' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Port</span>
                  <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: Number(e.target.value) }))} className={inputCls} />
                </label>
              </div>

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                  {form.db_type === 'sqlite' ? 'File path on server' : 'Database Name'}
                </span>
                <input value={form.database_name} onChange={e => setForm(f => ({ ...f, database_name: e.target.value }))}
                  placeholder={form.db_type === 'sqlite' ? '/var/app/database.sqlite' : 'mydb'} className={inputCls} />
              </label>

              {form.db_type !== 'sqlite' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label style={{ display: 'block' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>DB Username</span>
                    <input value={form.db_user} onChange={e => setForm(f => ({ ...f, db_user: e.target.value }))}
                      placeholder={form.db_type === 'postgresql' ? 'postgres' : form.db_type === 'mssql' ? 'sa' : 'root'} className={inputCls} />
                  </label>
                  <label style={{ display: 'block' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                      {formVaultId ? 'Override Password' : (editConn ? 'Password (leave blank to keep)' : 'Password')}
                    </span>
                    {formVaultId && !form.password ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 34 }}>
                        <span style={{ fontSize: 12, color: 'var(--accent-hex)', padding: '4px 10px', background: 'var(--accent-hex)15', borderRadius: 6, border: '1px solid var(--accent-hex)40' }}>
                          🔐 from vault
                        </span>
                        <button type="button" onClick={() => setForm(f => ({ ...f, password: ' ' }))}
                          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                          Override
                        </button>
                      </div>
                    ) : (
                      <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                        placeholder={formVaultId ? 'Override vault password…' : (editConn ? '••••••••' : '')} className={inputCls} />
                    )}
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.use_ssh_tunnel} onChange={e => setForm(f => ({ ...f, use_ssh_tunnel: e.target.checked }))} />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Use SSH Tunnel</span>
                </label>
                {form.db_type !== 'sqlite' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.ssl_enabled} onChange={e => setForm(f => ({ ...f, ssl_enabled: e.target.checked }))} />
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>SSL/TLS</span>
                  </label>
                )}
              </div>

              <label style={{ display: 'block' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Notes</span>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2} placeholder="Optional notes…" className={inputCls} style={{ resize: 'vertical' }} />
              </label>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" style={btnSecondary} onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" style={btnPrimary} disabled={formBusy}>
                  {formBusy ? <><Spinner /> Saving…</> : (editConn ? 'Save Changes' : 'Create Connection')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Result table component ────────────────────────────────────────────────────

function ResultTable({ result, page, pageSize, onPage, total }: {
  result: QueryResult
  page: number
  pageSize: number
  onPage: (p: number) => void
  total?: number
}) {
  const totalRows = total ?? result.row_count
  const totalPages = Math.ceil(totalRows / pageSize)
  const visibleRows = result.rows.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', fontFamily: 'monospace' }}>
          <thead style={{ position: 'sticky', top: 0, background: '#111827', zIndex: 1 }}>
            <tr>
              <th style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text-muted)', borderBottom: '1px solid #374151', minWidth: 40 }}>#</th>
              {result.columns.map(col => (
                <th key={col} style={{ padding: '6px 10px', textAlign: 'left', color: '#818cf8', borderBottom: '1px solid #374151', whiteSpace: 'nowrap', fontWeight: 600 }}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, ri) => (
              <tr key={ri} style={{ borderBottom: '1px solid #1f2937' }}
                onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = '#1f2937'}
                onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'}
              >
                <td style={{ padding: '4px 8px', textAlign: 'right', color: '#4b5563', userSelect: 'none' }}>{page * pageSize + ri + 1}</td>
                {row.map((cell, ci) => (
                  <td key={ci} style={{ padding: '4px 10px', color: cell === null ? '#6b7280' : '#e6edf3', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={String(cell ?? '')}>
                    {cell === null ? <em style={{ color: 'var(--text-muted)' }}>NULL</em> : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 0', borderTop: '1px solid #1f2937' }}>
          <button onClick={() => onPage(0)} disabled={page === 0} style={{ padding: '3px 8px', borderRadius: 4, background: '#374151', color: '#d1d5db', border: 'none', cursor: 'pointer', fontSize: 12 }}>«</button>
          <button onClick={() => onPage(page - 1)} disabled={page === 0} style={{ padding: '3px 8px', borderRadius: 4, background: '#374151', color: '#d1d5db', border: 'none', cursor: 'pointer', fontSize: 12 }}>‹</button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {page + 1} of {totalPages} · {totalRows.toLocaleString()} rows</span>
          <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1} style={{ padding: '3px 8px', borderRadius: 4, background: '#374151', color: '#d1d5db', border: 'none', cursor: 'pointer', fontSize: 12 }}>›</button>
          <button onClick={() => onPage(totalPages - 1)} disabled={page >= totalPages - 1} style={{ padding: '3px 8px', borderRadius: 4, background: '#374151', color: '#d1d5db', border: 'none', cursor: 'pointer', fontSize: 12 }}>»</button>
        </div>
      )}
    </div>
  )
}
