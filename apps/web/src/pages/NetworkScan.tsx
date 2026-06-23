import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenPort  { port: number; service: string; banner: string | null; risk: string }
interface ScanHost  {
  ip: string; hostname: string | null; latency_ms: number | null
  os_hint: string | null; open_ports: OpenPort[]; status: string
  mac_address: string | null; mac_vendor: string | null
}
type ScanMode = 'quick' | 'standard' | 'deep' | 'custom'
type ScanStatus = 'idle' | 'running' | 'complete' | 'cancelled' | 'error'

// ── Helpers ───────────────────────────────────────────────────────────────────

const RISK_STYLE: Record<string, { bg: string; color: string }> = {
  critical: { bg: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
  high:     { bg: 'rgba(249,115,22,0.15)',  color: '#f97316' },
  medium:   { bg: 'rgba(234,179,8,0.15)',   color: '#eab308' },
  low:      { bg: 'rgba(34,197,94,0.15)',   color: '#22c55e' },
}

const DEVICE_ICONS: Record<string, string> = {
  'Linux / Ubuntu':    '🐧',
  'Linux / Debian':    '🐧',
  'Linux / CentOS':    '🐧',
  'Linux / Fedora':    '🐧',
  'Linux / Alpine':    '🐧',
  'Linux / Unix':      '🐧',
  'Linux / Raspberry Pi': '🍓',
  'FreeBSD':           '👿',
  'OpenBSD':           '🐡',
  'Windows PC':        '🖥',
  'Windows Server':    '🖥',
  'Mac':               '💻',
  'iPhone / iPad':     '📱',
  'Android Phone':     '📲',
  'Mobile Phone':      '📱',
  'IP Camera':         '📷',
  'NAS / Storage':     '💾',
  'Printer':           '🖨',
  'Smart TV / Media':  '📺',
  'Smart Appliance':   '🔌',
  'Game Console':      '🎮',
  'VoIP / Phone':      '☎',
  'IoT / MQTT':        '💡',
  'Unknown Device':    '❓',
}

function osIcon(hint: string | null): string {
  if (!hint) return '❓'
  // Exact match
  if (DEVICE_ICONS[hint]) return DEVICE_ICONS[hint]
  // Prefix match for compound types like "Network Device (Cisco)", "Router/Gateway (TP-Link)"
  const h = hint.toLowerCase()
  if (h.startsWith('linux'))            return '🐧'
  if (h.startsWith('windows'))          return '🖥'
  if (h.startsWith('network device'))   return '📡'
  if (h.startsWith('router'))           return '🌐'
  if (h.startsWith('firewall'))         return '🛡'
  if (h.startsWith('ip camera'))        return '📷'
  if (h.startsWith('nas'))              return '💾'
  if (h.startsWith('vm '))              return '⚙'
  if (h.startsWith('smart appliance'))  return '🔌'
  if (h.startsWith('game console'))     return '🎮'
  if (h.startsWith('android phone'))    return '📲'
  if (h.startsWith('mobile phone'))     return '📱'
  if (h.startsWith('freebsd'))          return '👿'
  return '💻'
}

function portTag(p: OpenPort) {
  const s = RISK_STYLE[p.risk] ?? RISK_STYLE.low
  return (
    <span key={p.port} title={p.banner ?? p.service}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600, fontFamily: 'monospace', background: s.bg, color: s.color, border: `1px solid ${s.color}44`, whiteSpace: 'nowrap', cursor: 'default' }}>
      {p.port}/{p.service}
    </span>
  )
}

function downloadCSV(hosts: ScanHost[]) {
  const rows = [['IP', 'Hostname', 'MAC', 'Vendor', 'OS', 'Latency(ms)', 'Open Ports', 'Services', 'Banners']]
  for (const h of hosts) {
    rows.push([
      h.ip, h.hostname ?? '', h.mac_address ?? '', h.mac_vendor ?? '', h.os_hint ?? '',
      h.latency_ms?.toFixed(1) ?? '',
      h.open_ports.map(p => p.port).join(' '),
      h.open_ports.map(p => p.service).join(' | '),
      h.open_ports.map(p => p.banner ?? '').join(' | '),
    ])
  }
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = `scan-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
}

// ── Add to inventory modal ────────────────────────────────────────────────────

function AddModal({ host, onClose, onDone }: { host: ScanHost; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<'server' | 'network'>('server')
  const [name, setName] = useState(host.hostname?.split('.')[0] ?? host.ip.replace(/\./g, '-'))
  const [env, setEnv] = useState('production')
  const [osType, setOsType] = useState(() => {
    const h = host.os_hint?.toLowerCase() ?? ''
    if (h.includes('windows')) return 'windows'
    if (h.includes('linux') || h.includes('unix')) return 'linux'
    if (h.includes('router') || h.includes('network')) return 'router'
    return 'linux'
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!name.trim()) { setErr('Name is required'); return }
    setSaving(true); setErr('')
    try {
      if (type === 'server') {
        await api.post('/servers', {
          name: name.trim(), hostname: host.ip, environment: env,
          os_type: osType, ssh_port: host.open_ports.find(p => p.port === 22 || p.port === 2222)?.port ?? 22,
        })
      } else {
        await api.post('/servers', {
          name: name.trim(), hostname: host.ip, environment: env,
          device_category: 'network', os_type: osType,
        })
      }
      onDone()
    } catch (e: any) { setErr(e?.data?.error ?? e?.message ?? 'Failed') }
    finally { setSaving(false) }
  }

  const inp = (label: string, val: string, onChange: (v: string) => void) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{label}</label>
      <input value={val} onChange={e => onChange(e.target.value)}
        style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #374151', background: '#111827', color: '#e5e7eb', fontSize: 13, boxSizing: 'border-box' }} />
    </div>
  )

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 12, padding: 24, width: 380 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#e5e7eb' }}>Add {host.ip} to Inventory</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {(['server', 'network'] as const).map(t => (
            <button key={t} onClick={() => setType(t)}
              style={{ flex: 1, padding: '6px', borderRadius: 7, border: '1px solid', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                borderColor: type === t ? '#6366f1' : '#374151',
                background: type === t ? 'rgba(99,102,241,0.15)' : 'transparent',
                color: type === t ? '#818cf8' : '#9ca3af' }}>
              {t === 'server' ? '🖥 Server' : '🔀 Network Device'}
            </button>
          ))}
        </div>

        {inp('Name', name, setName)}
        {inp('Environment', env, setEnv)}

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>OS Type</label>
          <select value={osType} onChange={e => setOsType(e.target.value)}
            style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #374151', background: '#111827', color: '#e5e7eb', fontSize: 13 }}>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
            <option value="router">Router</option>
            <option value="switch">Switch</option>
            <option value="firewall">Firewall</option>
            <option value="access-point">Access Point</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 14 }}>
          IP: <strong style={{ color: '#9ca3af' }}>{host.ip}</strong>
          {host.open_ports.length > 0 && <> · {host.open_ports.length} open ports</>}
          {host.hostname && <> · {host.hostname}</>}
        </div>

        {err && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
          <button onClick={save} disabled={saving}
            style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Adding…' : 'Add to Inventory'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Host row ─────────────────────────────────────────────────────────────────

function HostRow({ host, onAdd }: { host: ScanHost; onAdd: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const criticalCount = host.open_ports.filter(p => p.risk === 'critical' || p.risk === 'high').length

  return (
    <>
      <tr onClick={() => setExpanded(e => !e)}
        style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', background: expanded ? 'rgba(99,102,241,0.07)' : 'transparent' }}>
        <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>
          <span style={{ marginRight: 6, opacity: 0.4 }}>{expanded ? '▾' : '▸'}</span>
          {host.ip}
        </td>
        <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {host.hostname ?? <span style={{ color: 'var(--border-med)' }}>—</span>}
        </td>
        <td style={{ padding: '10px 14px', fontSize: 11 }}>
          <div style={{ fontFamily: 'monospace', color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
            {host.mac_address ?? <span style={{ color: 'var(--border-med)' }}>—</span>}
          </div>
          {host.mac_vendor && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{host.mac_vendor}</div>
          )}
        </td>
        <td style={{ padding: '10px 14px', fontSize: 13 }}>
          <span title={host.os_hint ?? 'Unknown'}>{osIcon(host.os_hint)}</span>
          {host.os_hint && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 5 }}>{host.os_hint}</span>}
        </td>
        <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {host.latency_ms != null ? `${host.latency_ms.toFixed(1)} ms` : '—'}
        </td>
        <td style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 360 }}>
            {host.open_ports.slice(0, 7).map(p => portTag(p))}
            {host.open_ports.length > 7 && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>+{host.open_ports.length - 7} more</span>
            )}
            {host.open_ports.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No open ports</span>}
          </div>
        </td>
        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
            {criticalCount > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                ⚠ {criticalCount} risk
              </span>
            )}
            <button onClick={e => { e.stopPropagation(); onAdd() }}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              + Add
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: 'var(--bg-body)', borderBottom: '1px solid var(--border)' }}>
          <td colSpan={7} style={{ padding: '12px 28px 16px' }}>
            {host.open_ports.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No open ports found on this host.</span>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left', fontSize: 11 }}>
                    <th style={{ padding: '4px 10px 8px 0', width: 70 }}>Port</th>
                    <th style={{ padding: '4px 10px 8px', width: 140 }}>Service</th>
                    <th style={{ padding: '4px 10px 8px', width: 80 }}>Risk</th>
                    <th style={{ padding: '4px 10px 8px' }}>Banner / Info</th>
                  </tr>
                </thead>
                <tbody>
                  {host.open_ports.map(p => {
                    const rs = RISK_STYLE[p.risk] ?? RISK_STYLE.low
                    return (
                      <tr key={p.port} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 10px 6px 0', fontFamily: 'monospace', color: '#a5b4fc', fontWeight: 700 }}>{p.port}</td>
                        <td style={{ padding: '6px 10px', color: 'var(--text)' }}>{p.service}</td>
                        <td style={{ padding: '6px 10px' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: rs.bg, color: rs.color, textTransform: 'uppercase' }}>{p.risk}</span>
                        </td>
                        <td style={{ padding: '6px 10px', color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>
                          {p.banner ?? <span style={{ color: 'var(--border-med)' }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NetworkScan() {
  const [target, setTarget]     = useState('')
  const [mode, setMode]         = useState<ScanMode>('standard')
  const [portFrom, setPortFrom] = useState('1')
  const [portTo, setPortTo]     = useState('10000')
  const [status, setStatus]     = useState<ScanStatus>('idle')
  const [jobId, setJobId]       = useState<string | null>(null)
  const [hosts, setHosts]       = useState<Record<string, ScanHost>>({})
  const [pinged, setPinged]     = useState(0)
  const [totalIps, setTotalIps] = useState(0)
  const [aliveCount, setAliveCount] = useState(0)
  const [err, setErr]           = useState('')
  const [addHost, setAddHost]   = useState<ScanHost | null>(null)
  const [history, setHistory]   = useState<any[]>([])
  const [sortBy, setSortBy]     = useState<'ip' | 'ports' | 'risk'>('ip')
  const esRef                   = useRef<EventSource | null>(null)

  useEffect(() => {
    api.get<any[]>('/network-scan').then(setHistory).catch(() => {})
  }, [])

  const hostList = Object.values(hosts).sort((a, b) => {
    if (sortBy === 'ports') return b.open_ports.length - a.open_ports.length
    if (sortBy === 'risk') {
      const riskScore = (h: ScanHost) => h.open_ports.filter(p => p.risk === 'critical').length * 4 + h.open_ports.filter(p => p.risk === 'high').length * 2
      return riskScore(b) - riskScore(a)
    }
    return a.ip.split('.').reduce((acc, o, i) => acc + parseInt(o) * Math.pow(256, 3 - i), 0) -
           b.ip.split('.').reduce((acc, o, i) => acc + parseInt(o) * Math.pow(256, 3 - i), 0)
  })

  const startScan = async () => {
    if (!target.trim()) return
    setStatus('running'); setHosts({}); setPinged(0); setAliveCount(0); setErr('')

    try {
      const body: any = { target: target.trim(), mode }
      if (mode === 'custom') { body.port_from = parseInt(portFrom); body.port_to = parseInt(portTo) }
      const { jobId: id } = await api.post<{ jobId: string }>('/network-scan', body)
      setJobId(id)

      if (esRef.current) esRef.current.close()
      const es = new EventSource(`/api/network-scan/${id}/stream`, { withCredentials: true })
      esRef.current = es

      es.addEventListener('start', (e: any) => {
        const d = JSON.parse(e.data); setTotalIps(d.total)
      })
      es.addEventListener('ping', (e: any) => {
        const d = JSON.parse(e.data); setPinged(d.scanned)
      })
      es.addEventListener('host_alive', (e: any) => {
        const d = JSON.parse(e.data)
        setAliveCount(c => c + 1)
        setHosts(prev => ({ ...prev, [d.ip]: { ip: d.ip, hostname: null, latency_ms: d.latency_ms, os_hint: d.os_hint, mac_address: null, mac_vendor: null, open_ports: [], status: 'scanning' } }))
      })
      es.addEventListener('host_done', (e: any) => {
        const d = JSON.parse(e.data)
        setHosts(prev => ({ ...prev, [d.ip]: { ...prev[d.ip], ...d, status: 'done' } }))
      })
      es.addEventListener('complete', (e: any) => {
        const d = JSON.parse(e.data)
        setStatus('complete'); setAliveCount(d.alive ?? 0); es.close()
        api.get<any[]>('/network-scan').then(setHistory).catch(() => {})
      })
      es.addEventListener('cancelled', () => { setStatus('cancelled'); es.close() })
      es.addEventListener('error', (e: any) => {
        try { const d = JSON.parse((e as any).data); setErr(d.message) } catch {}
        setStatus('error'); es.close()
      })
      es.onerror = () => { if (status === 'running') { setStatus('error'); setErr('Connection lost') } }

    } catch (e: any) {
      setErr(e?.data?.error ?? e?.message ?? 'Failed to start scan')
      setStatus('error')
    }
  }

  const cancelScan = async () => {
    if (!jobId) return
    await api.delete(`/network-scan/${jobId}`).catch(() => {})
    esRef.current?.close(); setStatus('cancelled')
  }

  const modeInfo: Record<ScanMode, { label: string; desc: string; color: string }> = {
    quick:    { label: 'Quick',    desc: '~30 common ports · fast',            color: '#22c55e' },
    standard: { label: 'Standard', desc: '~100 ports + banners · recommended', color: '#3b82f6' },
    deep:     { label: 'Deep',     desc: '1–65535 all ports · slow',           color: '#f97316' },
    custom:   { label: 'Custom',   desc: 'Define port range',                  color: '#a78bfa' },
  }

  const progressPct = totalIps > 0 ? Math.round((pinged / totalIps) * 100) : 0
  const scanning = status === 'running'
  const done     = status === 'complete' || status === 'cancelled'

  return (
    <div style={{ padding: 24, maxWidth: 1400 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>Network Scanner</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 24 }}>Discover hosts and scan open ports across your network. Deep scan includes service detection and banner grabbing.</p>

      {/* ── Scan Setup ── */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {/* Target */}
          <div style={{ flex: '1 1 280px' }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>TARGET</label>
            <input value={target} onChange={e => setTarget(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !scanning && startScan()}
              placeholder="192.168.1.0/24  ·  10.0.0.1-254  ·  192.168.1.100"
              disabled={scanning}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box', fontFamily: 'monospace' }} />
          </div>

          {/* Mode selector */}
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>SCAN MODE</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {(Object.keys(modeInfo) as ScanMode[]).map(m => {
                const mi = modeInfo[m]; const active = mode === m
                return (
                  <button key={m} onClick={() => setMode(m)} disabled={scanning}
                    style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${active ? mi.color : 'var(--border)'}`, background: active ? `${mi.color}22` : 'transparent', color: active ? mi.color : 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {mi.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Custom range */}
          {mode === 'custom' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>FROM PORT</label>
                <input type="number" value={portFrom} onChange={e => setPortFrom(e.target.value)} min={1} max={65535}
                  style={{ width: 80, padding: '9px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>TO PORT</label>
                <input type="number" value={portTo} onChange={e => setPortTo(e.target.value)} min={1} max={65535}
                  style={{ width: 80, padding: '9px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }} />
              </div>
            </div>
          )}

          {/* Start / Cancel */}
          <div style={{ display: 'flex', gap: 8 }}>
            {!scanning ? (
              <button onClick={startScan} disabled={!target.trim()}
                style={{ padding: '9px 24px', borderRadius: 8, border: 'none', background: target.trim() ? '#6366f1' : 'var(--border)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: target.trim() ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
                ▶ Start Scan
              </button>
            ) : (
              <button onClick={cancelScan}
                style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                ■ Cancel
              </button>
            )}
            {done && hostList.length > 0 && (
              <button onClick={() => downloadCSV(hostList)}
                style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
                ↓ CSV
              </button>
            )}
          </div>
        </div>

        {/* Mode description */}
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
          {modeInfo[mode].desc}
          {mode === 'deep' && totalIps > 8 && (
            <span style={{ color: '#f97316', marginLeft: 8 }}>⚠ Deep scan on large ranges can take a long time. Consider custom range 1–10000.</span>
          )}
        </div>
      </div>

      {/* ── Progress ── */}
      {(scanning || done) && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px', marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {scanning ? (
                pinged < totalIps
                  ? `🔍 Discovering hosts… ${pinged} / ${totalIps} IPs pinged`
                  : `📡 Scanning ports on ${aliveCount} live host${aliveCount !== 1 ? 's' : ''}…`
              ) : status === 'complete' ? (
                `✅ Scan complete — ${aliveCount} host${aliveCount !== 1 ? 's' : ''} found, ${hostList.filter(h => h.open_ports.length > 0).length} with open ports`
              ) : status === 'cancelled' ? '⚪ Scan cancelled' : `❌ Error: ${err}`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {aliveCount > 0 && <span style={{ color: '#22c55e', marginRight: 12 }}>● {aliveCount} alive</span>}
              {hostList.filter(h => h.open_ports.some(p => p.risk === 'critical')).length > 0 && (
                <span style={{ color: '#ef4444' }}>⚠ {hostList.filter(h => h.open_ports.some(p => p.risk === 'critical')).length} critical risk</span>
              )}
            </div>
          </div>
          {totalIps > 0 && (
            <div style={{ background: 'var(--input-bg)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progressPct}%`, background: done ? '#22c55e' : '#6366f1', transition: 'width 0.3s ease', borderRadius: 4 }} />
            </div>
          )}
        </div>
      )}

      {err && status === 'error' && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#f87171' }}>
          ❌ {err}
        </div>
      )}

      {/* ── Results ── */}
      {hostList.length > 0 && (
        <div style={{ background: 'var(--bg-body)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{hostList.length} Host{hostList.length !== 1 ? 's' : ''} Found</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>Sort:</span>
              {(['ip', 'ports', 'risk'] as const).map(s => (
                <button key={s} onClick={() => setSortBy(s)}
                  style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    borderColor: sortBy === s ? '#6366f1' : 'var(--border)',
                    background: sortBy === s ? 'rgba(99,102,241,0.15)' : 'transparent',
                    color: sortBy === s ? '#818cf8' : 'var(--text-muted)' }}>
                  {s === 'ip' ? 'IP' : s === 'ports' ? 'Most Ports' : 'Risk'}
                </button>
              ))}
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-panel)', fontSize: 11, color: 'var(--text-muted)', textAlign: 'left', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th style={{ padding: '8px 14px' }}>IP Address</th>
                <th style={{ padding: '8px 14px' }}>Hostname</th>
                <th style={{ padding: '8px 14px' }}>MAC / Vendor</th>
                <th style={{ padding: '8px 14px' }}>OS</th>
                <th style={{ padding: '8px 14px' }}>Latency</th>
                <th style={{ padding: '8px 14px' }}>Open Ports</th>
                <th style={{ padding: '8px 14px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hostList.map(h => (
                <HostRow key={h.ip} host={h} onAdd={() => setAddHost(h)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Scan History ── */}
      {history.length > 0 && status === 'idle' && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Recent Scans</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-body)', color: 'var(--text-muted)', textAlign: 'left', fontSize: 11 }}>
                {['Target', 'Mode', 'Status', 'Hosts Found', 'Started'].map(h => (
                  <th key={h} style={{ padding: '8px 14px', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map(j => (
                <tr key={j.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '9px 14px', fontFamily: 'monospace', color: '#a5b4fc' }}>{j.target}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{j.mode}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                      background: j.status === 'complete' ? 'rgba(34,197,94,0.1)' : j.status === 'running' ? 'rgba(99,102,241,0.1)' : 'rgba(107,114,128,0.1)',
                      color: j.status === 'complete' ? '#22c55e' : j.status === 'running' ? '#818cf8' : '#9ca3af' }}>
                      {j.status}
                    </span>
                  </td>
                  <td style={{ padding: '9px 14px', color: 'var(--text-muted)' }}>{j.alive_count}</td>
                  <td style={{ padding: '9px 14px', color: 'var(--text-muted)' }}>{new Date(j.started_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addHost && (
        <AddModal host={addHost} onClose={() => setAddHost(null)} onDone={() => { setAddHost(null) }} />
      )}
    </div>
  )
}
