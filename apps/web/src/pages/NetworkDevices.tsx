import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Server } from '../api/client'
import Modal from '../components/Modal'

type NetworkOsType = 'router' | 'access-point' | 'switch' | 'dvr' | 'nvr' | 'other-network'

const DEVICE_META: Record<NetworkOsType, { icon: string; label: string; color: string; bg: string; border: string }> = {
  'router':        { icon: '📡', label: 'Router',       color: '#34d399', bg: 'rgba(6,78,59,0.2)',   border: 'rgba(52,211,153,0.35)' },
  'access-point':  { icon: '📶', label: 'Access Point', color: '#60a5fa', bg: 'rgba(29,78,216,0.2)', border: 'rgba(96,165,250,0.35)' },
  'switch':        { icon: '🔀', label: 'Switch',       color: '#a78bfa', bg: 'rgba(91,33,182,0.2)', border: 'rgba(167,139,250,0.35)' },
  'dvr':           { icon: '📹', label: 'DVR',          color: '#fb923c', bg: 'rgba(154,52,18,0.2)', border: 'rgba(249,115,22,0.35)' },
  'nvr':           { icon: '🎥', label: 'NVR',          color: '#f472b6', bg: 'rgba(131,24,67,0.2)', border: 'rgba(244,114,182,0.35)' },
  'other-network': { icon: '🌐', label: 'Network Dev',  color: '#9ca3af', bg: 'rgba(55,65,81,0.3)',  border: 'rgba(107,114,128,0.4)' },
}

function DeviceBadge({ type }: { type: string | null | undefined }) {
  if (!type) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
  const m = DEVICE_META[type as NetworkOsType] ?? DEVICE_META['other-network']
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: m.bg, border: `1px solid ${m.border}`,
      color: m.color, borderRadius: 5, padding: '1px 7px',
    }}>
      {m.icon} {m.label}
    </span>
  )
}

export default function NetworkDevices() {
  const [devices, setDevices] = useState<Server[]>([])
  const [filter, setFilter] = useState('')

  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'office', os_type: 'router' as NetworkOsType })
  const [addError, setAddError] = useState('')

  const [editDevice, setEditDevice] = useState<Server | null>(null)
  const [editForm, setEditForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'production', os_type: 'router' as NetworkOsType })
  const [editError, setEditError] = useState('')

  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'failed' | 'testing'>>({})

  const navigate = useNavigate()

  const load = () => {
    api.get<Server[]>('/servers?device_category=network').then(setDevices).catch(() => {})
  }

  useEffect(() => { load() }, [])

  const testConnection = useCallback(async (d: Server) => {
    setTestResults(r => ({ ...r, [d.id]: 'testing' }))
    try {
      await api.post(`/servers/${d.id}/test-connection`, {})
      setTestResults(r => ({ ...r, [d.id]: 'ok' }))
    } catch {
      setTestResults(r => ({ ...r, [d.id]: 'failed' }))
    }
  }, [])

  const openTerminal = useCallback((d: Server) => {
    navigate(`/terminal?server=${d.id}`)
  }, [navigate])

  const handleAdd = async () => {
    setAddError('')
    try {
      await api.post('/servers', { ...addForm, device_category: 'network' })
      setShowAdd(false)
      setAddForm({ name: '', hostname: '', ssh_port: 22, environment: 'production', os_type: 'router' })
      load()
    } catch (e: any) {
      setAddError(e?.data?.error ?? e?.message ?? 'Failed to add device')
    }
  }

  const handleEdit = async () => {
    if (!editDevice) return
    setEditError('')
    try {
      await api.put(`/servers/${editDevice.id}`, { ...editForm, device_category: 'network' })
      setEditDevice(null)
      load()
    } catch (e: any) {
      setEditError(e?.data?.error ?? e?.message ?? 'Failed to update device')
    }
  }

  const handleDelete = async (d: Server) => {
    if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return
    try {
      await api.delete(`/servers/${d.id}`)
      load()
    } catch {}
  }

  const filtered = devices.filter(d => {
    const q = filter.toLowerCase()
    return !q || d.name.toLowerCase().includes(q) || d.hostname.toLowerCase().includes(q)
  })

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 13,
    background: 'var(--bg-input)', border: '1px solid var(--border-med)',
    color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
  }

  const osTypeOptions: { value: NetworkOsType; label: string }[] = [
    { value: 'router', label: '📡 Router' },
    { value: 'access-point', label: '📶 Access Point' },
    { value: 'switch', label: '🔀 Switch' },
    { value: 'dvr', label: '📹 DVR' },
    { value: 'nvr', label: '🎥 NVR' },
    { value: 'other-network', label: '🌐 Other Network Device' },
  ]

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
            🌐 Network Devices
          </h1>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            Routers, access points, switches, DVR/NVR — SSH-accessible network equipment
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by name or hostname…"
          style={{ ...inputStyle, width: 220 }}
        />
        <button
          onClick={() => setShowAdd(true)}
          style={{
            padding: '7px 14px', borderRadius: 7, border: 'none',
            background: 'var(--accent-hex)', color: '#fff',
            cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          + Add Device
        </button>
      </div>

      {/* Stats bar */}
      {devices.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {Object.entries(DEVICE_META).map(([type, m]) => {
            const count = devices.filter(d => d.os_type === type).length
            if (!count) return null
            return (
              <span key={type} style={{
                fontSize: 11, fontWeight: 600,
                background: m.bg, border: `1px solid ${m.border}`,
                color: m.color, borderRadius: 5, padding: '2px 8px',
              }}>
                {m.icon} {count} {m.label}
              </span>
            )
          })}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 4px' }}>
            {devices.length} total
          </span>
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 14 }}>
          {devices.length === 0
            ? 'No network devices yet. Click "+ Add Device" to add your first router, switch, or AP.'
            : 'No devices match your filter.'}
        </div>
      ) : (
        <div style={{
          border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden',
          background: 'var(--bg-surface)',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                {['Device', 'Type', 'Hostname / IP', 'SSH Port', 'Environment', 'Connection', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => {
                const tr = testResults[d.id]
                return (
                  <tr key={d.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {d.name}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <DeviceBadge type={d.os_type} />
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {d.hostname}
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                      {d.ssh_port}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, borderRadius: 5, padding: '1px 7px',
                        ...({
                          office:     { background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' },
                          branch:     { background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)' },
                          datacenter: { background: 'rgba(251,146,60,0.15)', color: '#fb923c', border: '1px solid rgba(251,146,60,0.3)' },
                          home:       { background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' },
                          warehouse:  { background: 'rgba(156,163,175,0.15)', color: '#9ca3af', border: '1px solid rgba(156,163,175,0.3)' },
                        }[d.environment] ?? { background: 'rgba(99,102,241,0.15)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' }),
                      }}>
                        {d.environment}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {tr === 'testing' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Testing…</span>}
                      {tr === 'ok' && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }}>✓ Connected</span>}
                      {tr === 'failed' && <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 600 }}>✗ Failed</span>}
                      {!tr && (
                        <button
                          onClick={() => testConnection(d)}
                          style={{
                            fontSize: 11, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
                            background: 'transparent', border: '1px solid var(--border-med)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          Test SSH
                        </button>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button
                          onClick={() => openTerminal(d)}
                          title="Open SSH terminal"
                          style={{
                            fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                            background: 'var(--accent-hex)', border: 'none', color: '#fff', fontWeight: 600,
                          }}
                        >
                          ⌨ SSH
                        </button>
                        <button
                          onClick={() => {
                            setEditDevice(d)
                            setEditForm({ name: d.name, hostname: d.hostname, ssh_port: d.ssh_port, environment: d.environment, os_type: (d.os_type as NetworkOsType) ?? 'other-network' })
                            setEditError('')
                          }}
                          title="Edit"
                          style={{
                            fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                            background: 'transparent', border: '1px solid var(--border-med)', color: 'var(--text-muted)',
                          }}
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => handleDelete(d)}
                          title="Delete"
                          style={{
                            fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                            background: 'transparent', border: '1px solid var(--border-med)', color: 'var(--danger)',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Device Modal */}
      {showAdd && (
        <Modal title="Add Network Device" onClose={() => setShowAdd(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 380 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Device Type</label>
              <select
                value={addForm.os_type}
                onChange={e => setAddForm(f => ({ ...f, os_type: e.target.value as NetworkOsType }))}
                style={inputStyle}
              >
                {osTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
              <input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Office Router" style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Hostname / IP Address</label>
              <input value={addForm.hostname} onChange={e => setAddForm(f => ({ ...f, hostname: e.target.value }))} placeholder="192.168.1.1" style={inputStyle} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>SSH Port</label>
                <input type="number" value={addForm.ssh_port} onChange={e => setAddForm(f => ({ ...f, ssh_port: Number(e.target.value) }))} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Environment</label>
                <select value={addForm.environment} onChange={e => setAddForm(f => ({ ...f, environment: e.target.value }))} style={inputStyle}>
                  <option value="office">office</option>
                  <option value="branch">branch</option>
                  <option value="datacenter">datacenter</option>
                  <option value="home">home</option>
                  <option value="warehouse">warehouse</option>
                </select>
              </div>
            </div>
            {addError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{addError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleAdd} style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Add Device</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit Device Modal */}
      {editDevice && (
        <Modal title={`Edit — ${editDevice.name}`} onClose={() => setEditDevice(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 380 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Device Type</label>
              <select value={editForm.os_type} onChange={e => setEditForm(f => ({ ...f, os_type: e.target.value as NetworkOsType }))} style={inputStyle}>
                {osTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
              <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Hostname / IP Address</label>
              <input value={editForm.hostname} onChange={e => setEditForm(f => ({ ...f, hostname: e.target.value }))} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>SSH Port</label>
                <input type="number" value={editForm.ssh_port} onChange={e => setEditForm(f => ({ ...f, ssh_port: Number(e.target.value) }))} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Environment</label>
                <select value={editForm.environment} onChange={e => setEditForm(f => ({ ...f, environment: e.target.value }))} style={inputStyle}>
                  <option value="office">office</option>
                  <option value="branch">branch</option>
                  <option value="datacenter">datacenter</option>
                  <option value="home">home</option>
                  <option value="warehouse">warehouse</option>
                </select>
              </div>
            </div>
            {editError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setEditDevice(null)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleEdit} style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Save Changes</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
