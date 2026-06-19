import { useEffect, useState } from 'react'
import { api, Server, SecurityScan } from '../api/client'
import Badge from '../components/Badge'

type Finding = {
  check_id: string
  category: string
  description: string
  severity: 'ok' | 'low' | 'medium' | 'high' | 'critical'
  passed: boolean
  status: 'pass' | 'warn' | 'fail' | 'skip'
  output: string
  expected: string
  remediation: string
  reference: string
}

const CAT_LABEL: Record<string, string> = {
  ssh: 'SSH', password_policy: 'Password Policy', accounts: 'Accounts',
  file_permissions: 'File Permissions', kernel: 'Kernel', audit: 'Audit & Logging',
  firewall: 'Firewall', updates: 'Updates',
}

const STATUS_COLOR: Record<string, string> = {
  pass: '#22c55e', warn: '#f59e0b', fail: '#ef4444', skip: '#6b7280',
}
const STATUS_ICON: Record<string, string> = {
  pass: '✓', warn: '⚠', fail: '✗', skip: '—',
}

export default function Security() {
  const [servers, setServers] = useState<Server[]>([])
  const [scans, setScans] = useState<Record<string, SecurityScan>>({})
  const [scanning, setScanning] = useState<string | null>(null)
  const [scanningAll, setScanningAll] = useState(false)
  const [selectedServer, setSelectedServer] = useState<string | null>(null)
  const [catFilter, setCatFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'fail' | 'warn' | 'pass'>('all')
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null)
  const [copiedRemediation, setCopiedRemediation] = useState<string | null>(null)

  const load = async () => {
    const svrs = await api.get<Server[]>('/servers').catch(() => [] as Server[])
    setServers(svrs)
    const scanMap: Record<string, SecurityScan> = {}
    await Promise.all(
      svrs.map(async (s) => {
        const results = await api.get<SecurityScan[]>(`/security/findings/${s.id}`).catch(() => [] as SecurityScan[])
        if (results[0]) scanMap[s.id] = results[0]
      }),
    )
    setScans(scanMap)
  }

  useEffect(() => { load() }, [])

  const scanServer = async (id: string) => {
    setScanning(id)
    setCatFilter('all')
    setStatusFilter('all')
    setExpandedCheck(null)
    try { await api.post(`/security/scan/${id}`) }
    catch { /* ignore */ }
    finally { setScanning(null); load() }
  }

  const scanAll = async () => {
    setScanningAll(true)
    try { await api.post('/security/scan/all') }
    catch { /* ignore */ }
    finally { setScanningAll(false); setTimeout(load, 3000) }
  }

  const selectedScan = selectedServer ? scans[selectedServer] : null
  const findings: Finding[] = selectedScan
    ? (selectedScan.findings ?? []) as Finding[]
    : []

  // Summary counts
  const passCount = findings.filter((f) => f.status === 'pass').length
  const warnCount = findings.filter((f) => f.status === 'warn').length
  const failCount = findings.filter((f) => f.status === 'fail').length
  const skipCount = findings.filter((f) => f.status === 'skip').length
  const scored = findings.length - skipCount
  const score = scored > 0 ? Math.round(((passCount + warnCount * 0.5) / scored) * 100) : 0
  const scoreColor = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'

  // Categories present
  const categories = [...new Set(findings.map((f) => f.category))].filter(Boolean)

  const filtered = findings.filter((f) => {
    const catOk = catFilter === 'all' || f.category === catFilter
    const statusOk = statusFilter === 'all' || f.status === statusFilter
    return catOk && statusOk
  })

  // Sort: fail first, then warn, then pass/skip
  const sorted = [...filtered].sort((a, b) => {
    const order = { fail: 0, warn: 1, pass: 2, skip: 3 }
    return (order[a.status] ?? 2) - (order[b.status] ?? 2)
  })

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-white">Security</h1>
        <button onClick={scanAll} disabled={scanningAll}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
          {scanningAll ? 'Scanning all…' : 'Scan All Servers'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" style={{ alignItems: 'start' }}>
        {/* Server list */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
          <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 260 }}>
            <colgroup>
              <col style={{ width: '40%' }} />
              <col style={{ width: '30%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead className="bg-gray-800/50">
              <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
                <th className="px-3 py-2">Server</th>
                <th className="px-3 py-2">Last Scan</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {servers.map((s) => {
                const scan = scans[s.id]
                return (
                  <tr key={s.id}
                    className={`transition-colors ${s.os_type === 'windows' ? 'opacity-50' : `hover:bg-gray-800/30 cursor-pointer ${selectedServer === s.id ? 'bg-gray-800/50' : ''}`}`}
                    onClick={() => { if (s.os_type !== 'windows') { setSelectedServer(s.id); setCatFilter('all'); setStatusFilter('all'); setExpandedCheck(null) } }}>
                    <td className="px-3 py-2 text-white font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.os_type === 'windows' ? '🪟' : '🐧'} {s.name}
                    </td>
                    <td className="px-3 py-2 text-gray-400 text-xs" style={{ whiteSpace: 'nowrap' }}>
                      {s.os_type === 'windows' ? <span className="text-gray-600 italic">—</span> : scan ? new Date(scan.scanned_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {s.os_type === 'windows'
                        ? <span className="text-xs text-gray-600">—</span>
                        : scan?.severity ? <Badge label={scan.severity.toUpperCase()} variant={scan.severity as 'ok'} /> : <Badge label="N/A" />}
                    </td>
                    <td className="px-3 py-2">
                      {s.os_type !== 'windows' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); scanServer(s.id) }}
                          disabled={scanning === s.id}
                          className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 transition-colors"
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {scanning === s.id ? '…' : '↻'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {servers.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-5 text-center text-gray-500">No servers.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Findings detail — takes 2 columns */}
        <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
          {!selectedServer && (
            <p className="text-gray-500 text-sm py-4 text-center">Select a server to see findings.</p>
          )}

          {selectedServer && scanning === selectedServer && (
            <div className="py-10 text-center">
              <div className="inline-block w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-gray-400 text-sm">Running security benchmark… (15–30 s)</p>
            </div>
          )}

          {selectedServer && scanning !== selectedServer && !selectedScan && (
            <div className="py-8 text-center space-y-3">
              <p className="text-gray-400 text-sm">No scan results yet.</p>
              <button onClick={() => scanServer(selectedServer)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm transition-colors">
                Run Benchmark Now
              </button>
            </div>
          )}

          {selectedScan && scanning !== selectedServer && (
            <>
              {/* Score + summary */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{
                  width: 54, height: 54, borderRadius: '50%',
                  border: `3px solid ${scoreColor}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: scoreColor }}>{score}</span>
                </div>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', margin: '0 0 4px' }}>
                    {servers.find((s) => s.id === selectedServer)?.name} — Security Score
                  </p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(['pass', 'warn', 'fail', 'skip'] as const).map((st) => {
                      const count = { pass: passCount, warn: warnCount, fail: failCount, skip: skipCount }[st]
                      return (
                        <span key={st} style={{
                          fontSize: 11, fontWeight: 600,
                          color: STATUS_COLOR[st],
                          background: `${STATUS_COLOR[st]}18`,
                          border: `1px solid ${STATUS_COLOR[st]}40`,
                          borderRadius: 5, padding: '1px 7px',
                        }}>
                          {STATUS_ICON[st]} {st.toUpperCase()} {count}
                        </span>
                      )
                    })}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>
                      {new Date(selectedScan.scanned_at).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Filters */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {/* Status filter */}
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['all', 'fail', 'warn', 'pass'] as const).map((s) => (
                    <button key={s} onClick={() => setStatusFilter(s)} style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                      fontWeight: statusFilter === s ? 700 : 400,
                      background: statusFilter === s
                        ? (s === 'all' ? 'var(--accent-hex)' : STATUS_COLOR[s])
                        : 'var(--bg-card)',
                      color: statusFilter === s ? 'white' : 'var(--text-secondary)',
                    }}>
                      {s === 'all' ? `All (${findings.length})` : `${STATUS_ICON[s]} ${s.charAt(0).toUpperCase() + s.slice(1)}`}
                    </button>
                  ))}
                </div>

                {/* Category filter */}
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  <button onClick={() => setCatFilter('all')} style={{
                    padding: '3px 8px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                    fontWeight: catFilter === 'all' ? 700 : 400,
                    background: catFilter === 'all' ? 'var(--accent-hex)' : 'var(--bg-input)',
                    color: catFilter === 'all' ? 'white' : 'var(--text-muted)',
                  }}>All categories</button>
                  {categories.map((cat) => {
                    const catFindings = findings.filter((f) => f.category === cat)
                    const hasFail = catFindings.some((f) => f.status === 'fail')
                    const hasWarn = catFindings.some((f) => f.status === 'warn')
                    const dot = hasFail ? '#ef4444' : hasWarn ? '#f59e0b' : '#22c55e'
                    return (
                      <button key={cat} onClick={() => setCatFilter(cat)} style={{
                        padding: '3px 8px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                        fontWeight: catFilter === cat ? 700 : 400,
                        background: catFilter === cat ? 'var(--accent-hex)' : 'var(--bg-input)',
                        color: catFilter === cat ? 'white' : 'var(--text-muted)',
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                        {CAT_LABEL[cat] ?? cat}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Check list */}
              <div className="space-y-1.5">
                {sorted.map((f) => {
                  const isOpen = expandedCheck === f.check_id
                  const st = f.status ?? (f.passed ? 'pass' : 'fail')
                  return (
                    <div key={f.check_id} style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-med)',
                      borderLeft: `3px solid ${STATUS_COLOR[st]}`,
                      borderRadius: 8, overflow: 'hidden',
                    }}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setExpandedCheck(isOpen ? null : f.check_id)}
                        style={{
                          width: '100%', textAlign: 'left', background: 'none', border: 'none',
                          padding: '9px 12px', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 10,
                        }}>
                        <span style={{
                          flexShrink: 0, width: 52, textAlign: 'center',
                          fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                          background: `${STATUS_COLOR[st]}18`,
                          color: STATUS_COLOR[st],
                          border: `1px solid ${STATUS_COLOR[st]}40`,
                          borderRadius: 5, padding: '2px 5px',
                        }}>
                          {STATUS_ICON[st]} {st.toUpperCase()}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', lineHeight: 1.3 }}>{f.description}</p>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            {CAT_LABEL[f.category] ?? f.category}{f.reference ? ` · ${f.reference}` : ''}
                          </span>
                        </div>
                        <Badge label={f.severity} variant={f.severity as 'high'} />
                        <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>{isOpen ? '▲' : '▼'}</span>
                      </button>

                      {isOpen && (
                        <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border-weak)' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, margin: '10px 0' }}>
                            <div style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '8px 10px' }}>
                              <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 3px' }}>Found</p>
                              <code style={{ fontSize: 11, color: STATUS_COLOR[st], wordBreak: 'break-all' }}>{f.output}</code>
                            </div>
                            <div style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '8px 10px' }}>
                              <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 3px' }}>Expected</p>
                              <code style={{ fontSize: 11, color: '#22c55e', wordBreak: 'break-all' }}>{f.expected}</code>
                            </div>
                          </div>

                          {!f.passed && f.remediation && (
                            <div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Remediation</p>
                                <button onClick={() => {
                                  navigator.clipboard.writeText(f.remediation)
                                  setCopiedRemediation(f.check_id)
                                  setTimeout(() => setCopiedRemediation(null), 2000)
                                }} style={{
                                  fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                                  background: copiedRemediation === f.check_id ? '#065f46' : 'var(--bg-input)',
                                  color: copiedRemediation === f.check_id ? '#6ee7b7' : 'var(--text-secondary)',
                                }}>
                                  {copiedRemediation === f.check_id ? '✓ Copied' : '⎘ Copy'}
                                </button>
                              </div>
                              <pre style={{
                                fontSize: 11, lineHeight: 1.6, fontFamily: 'monospace',
                                background: '#0d0d14', border: '1px solid var(--border-med)',
                                borderRadius: 6, padding: '10px 12px', overflowX: 'auto',
                                color: '#e2e8f0', whiteSpace: 'pre-wrap', margin: 0,
                              }}>{f.remediation}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
                {sorted.length === 0 && findings.length > 0 && (
                  <p className="text-gray-500 text-sm text-center py-4">No findings match the current filter.</p>
                )}
              </div>

              <p style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
                CIS Benchmark-inspired controls · {findings.length} checks total
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
