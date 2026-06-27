import { useEffect, useState, useRef } from 'react'
import { api, FirmwareFile, ConfigBackup, DiffResult, Server } from '../api/client'
import Modal from '../components/Modal'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(n: number | null) {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtDate(s: string) { return new Date(s).toLocaleString() }
function fmtDateShort(s: string) { return new Date(s).toLocaleDateString() }


// ── Firmware Library Tab ──────────────────────────────────────────────────────

function FirmwareLibraryTab() {
  const [files, setFiles] = useState<FirmwareFile[]>([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [settingLatest, setSettingLatest] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try { setFiles(await api.get<FirmwareFile[]>('/firmware-repo')) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Group by vendor → model
  const grouped: Record<string, Record<string, FirmwareFile[]>> = {}
  for (const f of files) {
    if (!grouped[f.vendor]) grouped[f.vendor] = {}
    if (!grouped[f.vendor][f.model]) grouped[f.vendor][f.model] = []
    grouped[f.vendor][f.model].push(f)
  }

  const setLatest = async (id: string) => {
    setSettingLatest(id)
    try { await api.patch(`/firmware-repo/${id}/set-latest`, {}); await load() }
    finally { setSettingLatest(null) }
  }

  const del = async (id: string, filename: string) => {
    if (!confirm(`Delete ${filename}?`)) return
    setDeleting(id)
    try { await api.delete(`/firmware-repo/${id}`); await load() }
    finally { setDeleting(null) }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Firmware Library</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Store firmware by vendor/model. Mark a version as "latest" — devices can pull it via TFTP.
          </p>
        </div>
        <button onClick={() => setShowUpload(true)} style={{ fontSize: 12, padding: '7px 16px', borderRadius: 7, cursor: 'pointer', background: 'var(--accent-hex)', border: 'none', color: '#fff', fontWeight: 600 }}>
          ↑ Upload Firmware
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Loading…</div>
      ) : files.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>💾</div>
          No firmware files yet. Upload the first one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {Object.entries(grouped).map(([vendor, models]) => (
            <div key={vendor} style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
              <div style={{ padding: '10px 16px', background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)', fontWeight: 700, fontSize: 13 }}>
                {vendor}
              </div>
              {Object.entries(models).map(([model, modelFiles]) => (
                <div key={model}>
                  <div style={{ padding: '8px 16px 4px', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border-weak)' }}>
                    {model} <span style={{ fontWeight: 400 }}>({modelFiles.length} version{modelFiles.length !== 1 ? 's' : ''})</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <tbody>
                      {modelFiles.map((f, i) => (
                        <tr key={f.id} style={{ borderBottom: i < modelFiles.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                          <td style={{ padding: '9px 16px', fontFamily: 'monospace' }}>
                            v{f.version}
                            {f.is_latest && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: 4, padding: '1px 6px' }}>LATEST</span>}
                          </td>
                          <td style={{ padding: '9px 16px', color: 'var(--text-muted)' }}>{f.filename}</td>
                          <td style={{ padding: '9px 16px', color: 'var(--text-muted)' }}>{fmtBytes(f.file_size)}</td>
                          <td style={{ padding: '9px 16px', color: 'var(--text-muted)' }}>{fmtDateShort(f.uploaded_at)}</td>
                          <td style={{ padding: '9px 16px', color: 'var(--text-muted)', fontSize: 11 }}>{f.uploaded_by ?? '—'}</td>
                          <td style={{ padding: '9px 16px' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                              {!f.is_latest && (
                                <button onClick={() => setLatest(f.id)} disabled={settingLatest === f.id}
                                  style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', color: '#34d399' }}>
                                  {settingLatest === f.id ? '…' : '★ Set latest'}
                                </button>
                              )}
                              <a href={`/api/firmware-repo/${f.id}/download`} download={f.filename}
                                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', background: 'var(--bg-elevated)', border: '1px solid var(--border-med)', color: 'var(--text-secondary)', textDecoration: 'none' }}>
                                ↓ Download
                              </a>
                              <button onClick={() => del(f.id, f.filename)} disabled={deleting === f.id}
                                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171' }}>
                                {deleting === f.id ? '…' : 'Delete'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); load() }} />}
    </div>
  )
}

// ── Upload Modal ──────────────────────────────────────────────────────────────

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [vendor, setVendor]   = useState('')
  const [model, setModel]     = useState('')
  const [version, setVersion] = useState('')
  const [notes, setNotes]     = useState('')
  const [file, setFile]       = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError]     = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const upload = async () => {
    if (!vendor || !model || !version || !file) { setError('All fields are required'); return }
    setUploading(true); setError('')
    try {
      const fd = new FormData()
      fd.append('vendor', vendor); fd.append('model', model)
      fd.append('version', version); fd.append('notes', notes)
      fd.append('file', file)
      await fetch('/api/firmware-repo/upload', { method: 'POST', credentials: 'include', body: fd })
      onDone()
    } catch (e: any) {
      setError(e?.message ?? 'Upload failed')
    } finally { setUploading(false) }
  }

  const inp = (label: string, value: string, onChange: (v: string) => void, placeholder?: string) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
    </div>
  )

  return (
    <Modal title="Upload Firmware" onClose={onClose}>
      <div style={{ minWidth: 420 }}>
        {inp('Vendor', vendor, setVendor, 'e.g. Cisco')}
        {inp('Model', model, setModel, 'e.g. ISR 4321')}
        {inp('Version', version, setVersion, 'e.g. 17.3.6')}
        {inp('Notes (optional)', notes, setNotes, 'Release notes, changelog link…')}

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Firmware File</label>
          <div onClick={() => fileRef.current?.click()}
            style={{ border: '2px dashed var(--border-med)', borderRadius: 8, padding: '20px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg-elevated)' }}>
            {file ? (
              <div style={{ fontSize: 13 }}>{file.name} <span style={{ color: 'var(--text-muted)' }}>({fmtBytes(file.size)})</span></div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Click to select file (.bin, .img, .zip…)</div>
            )}
            <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </div>
        </div>

        {error && <div style={{ marginBottom: 10, fontSize: 12, color: '#f87171' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={upload} disabled={uploading}
            style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: uploading ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: uploading ? 0.6 : 1 }}>
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Config Backups Tab ────────────────────────────────────────────────────────

function ConfigBackupsTab({ servers }: { servers: Server[] }) {
  const [backups, setBackups]       = useState<ConfigBackup[]>([])
  const [selectedServer, setSelectedServer] = useState<string>('all')
  const [pulling, setPulling]       = useState<string | null>(null)
  const [diffModal, setDiffModal]   = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState<string | null>(null)
  const [deleting, setDeleting]     = useState<string | null>(null)
  const [uploadServer, setUploadServer] = useState<string | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading]   = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  const networkDevices = servers.filter(s => s.device_category === 'network')
  const allServers     = servers.filter(s => s.device_category !== 'network')
  const allDevices     = [...networkDevices, ...allServers]

  const load = async () => {
    const q = selectedServer !== 'all' ? `?server_id=${selectedServer}` : ''
    setBackups(await api.get<ConfigBackup[]>(`/config-backups${q}`))
  }

  useEffect(() => { load() }, [selectedServer])

  const pull = async (serverId: string) => {
    setPulling(serverId)
    try { await api.post(`/servers/${serverId}/config-backup`, {}); await load() }
    catch (e: any) { alert(`Backup failed: ${e?.data?.error ?? e?.message}`) }
    finally { setPulling(null) }
  }

  const loadDiff = async (id: string) => {
    setDiffLoading(id)
    try { setDiffModal(await api.get<DiffResult>(`/config-backups/${id}/diff`)) }
    finally { setDiffLoading(null) }
  }

  const del = async (id: string) => {
    if (!confirm('Delete this backup?')) return
    setDeleting(id)
    try { await api.delete(`/config-backups/${id}`); await load() }
    finally { setDeleting(null) }
  }

  const uploadBackup = async () => {
    if (!uploadServer || !uploadFile) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('server_id', uploadServer); fd.append('file', uploadFile)
      await fetch('/api/config-backups/upload', { method: 'POST', credentials: 'include', body: fd })
      setUploadServer(null); setUploadFile(null); await load()
    } finally { setUploading(false) }
  }

  // Group backups by server for the summary sidebar
  const byServer: Record<string, ConfigBackup[]> = {}
  for (const b of backups) {
    if (!byServer[b.server_id]) byServer[b.server_id] = []
    byServer[b.server_id].push(b)
  }

  const displayedBackups = selectedServer === 'all' ? backups : backups.filter(b => b.server_id === selectedServer)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Config Backups</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Pull running config from any device via SSH. Diff between versions. Download for DR.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setUploadServer(allDevices[0]?.id ?? '')}
            style={{ fontSize: 12, padding: '7px 14px', borderRadius: 7, cursor: 'pointer', background: 'var(--bg-surface)', border: '1px solid var(--border-med)', color: 'var(--text-secondary)', fontWeight: 600 }}>
            ↑ Manual Upload
          </button>
          {selectedServer !== 'all' && (
            <button onClick={() => pull(selectedServer)} disabled={!!pulling}
              style={{ fontSize: 12, padding: '7px 16px', borderRadius: 7, cursor: pulling ? 'default' : 'pointer', background: 'var(--accent-hex)', border: 'none', color: '#fff', fontWeight: 600, opacity: pulling ? 0.6 : 1 }}>
              {pulling ? '⟳ Pulling…' : '↓ Pull Backup'}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14 }}>
        {/* Left sidebar — device list */}
        <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button onClick={() => setSelectedServer('all')}
            style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 7, cursor: 'pointer', border: 'none', background: selectedServer === 'all' ? 'var(--accent-hex)' : 'transparent', color: selectedServer === 'all' ? '#fff' : 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}>
            All devices
            <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>({backups.length})</span>
          </button>
          {allDevices.map(s => {
            const count = byServer[s.id]?.length ?? 0
            const active = selectedServer === s.id
            return (
              <button key={s.id} onClick={() => setSelectedServer(s.id)}
                style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 7, cursor: 'pointer', border: 'none', background: active ? 'rgba(59,130,246,0.15)' : 'transparent', color: active ? 'var(--accent-hex)' : 'var(--text-secondary)', fontSize: 12 }}>
                <div style={{ fontWeight: active ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{count} backup{count !== 1 ? 's' : ''}</div>
              </button>
            )
          })}
        </div>

        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {displayedBackups.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              {selectedServer === 'all'
                ? 'No backups yet. Select a device and click "Pull Backup".'
                : 'No backups for this device yet. Click "Pull Backup" above.'}
            </div>
          ) : (
            <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                    {['Date', selectedServer === 'all' ? 'Device' : null, 'Size', 'Method', 'Status', 'Actions']
                      .filter(Boolean).map(h => (
                        <th key={h!} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayedBackups.map((b, i) => (
                    <tr key={b.id} style={{ borderBottom: i < displayedBackups.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                      <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>{fmtDate(b.created_at)}</td>
                      {selectedServer === 'all' && (
                        <td style={{ padding: '9px 14px' }}>
                          <div style={{ fontWeight: 600 }}>{b.server_name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{b.environment}</div>
                        </td>
                      )}
                      <td style={{ padding: '9px 14px', color: 'var(--text-muted)' }}>{fmtBytes(b.file_size)}</td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, fontWeight: 600, background: b.backup_method === 'ssh-pull' ? 'rgba(96,165,250,0.12)' : b.backup_method === 'tftp-push' ? 'rgba(167,139,250,0.12)' : 'rgba(148,163,184,0.12)', color: b.backup_method === 'ssh-pull' ? '#60a5fa' : b.backup_method === 'tftp-push' ? '#a78bfa' : '#94a3b8', border: `1px solid ${b.backup_method === 'ssh-pull' ? 'rgba(96,165,250,0.3)' : b.backup_method === 'tftp-push' ? 'rgba(167,139,250,0.3)' : 'rgba(148,163,184,0.3)'}` }}>
                          {b.backup_method}
                        </span>
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        {b.status === 'ok'
                          ? <span style={{ color: '#34d399', fontSize: 11 }}>✓ OK</span>
                          : <span style={{ color: '#f87171', fontSize: 11 }} title={b.error_message ?? ''}>✗ Error</span>}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ display: 'flex', gap: 5 }}>
                          <button onClick={() => loadDiff(b.id)} disabled={diffLoading === b.id}
                            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24' }}>
                            {diffLoading === b.id ? '…' : '≠ Diff'}
                          </button>
                          <a href={`/api/config-backups/${b.id}/download`} download={b.filename}
                            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', background: 'var(--bg-elevated)', border: '1px solid var(--border-med)', color: 'var(--text-secondary)', textDecoration: 'none' }}>
                            ↓
                          </a>
                          <button onClick={() => del(b.id)} disabled={deleting === b.id}
                            style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171' }}>
                            {deleting === b.id ? '…' : '✕'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Diff Modal */}
      {diffModal && (
        <Modal title={`Config Diff — ${diffModal.current.filename}`} onClose={() => setDiffModal(null)}>
          <div style={{ minWidth: 640, maxHeight: '70vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', gap: 20, marginBottom: 12, fontSize: 11, color: 'var(--text-muted)' }}>
              <span>Current: <strong style={{ color: 'var(--text-primary)' }}>{diffModal.current.filename}</strong></span>
              <span>Previous: <strong style={{ color: 'var(--text-primary)' }}>{diffModal.previous?.filename ?? 'none'}</strong></span>
            </div>
            {diffModal.unchanged ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#34d399', fontSize: 13 }}>✓ No changes detected</div>
            ) : (
              <div style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--bg-elevated)', borderRadius: 8, overflow: 'hidden' }}>
                {diffModal.diff.map((line, i) => (
                  <div key={i} style={{
                    padding: '1px 12px',
                    background: line.type === 'add' ? 'rgba(52,211,153,0.1)' : line.type === 'remove' ? 'rgba(248,113,113,0.1)' : 'transparent',
                    color: line.type === 'add' ? '#34d399' : line.type === 'remove' ? '#f87171' : line.line === '...' ? 'var(--text-muted)' : 'var(--text-secondary)',
                    whiteSpace: 'pre',
                  }}>
                    {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '}{line.line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Manual Upload Modal */}
      {uploadServer !== null && (
        <Modal title="Manual Config Upload" onClose={() => { setUploadServer(null); setUploadFile(null) }}>
          <div style={{ minWidth: 380 }}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Device</label>
              <select value={uploadServer} onChange={e => setUploadServer(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 13 }}>
                {allDevices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Config File</label>
              <div onClick={() => uploadRef.current?.click()}
                style={{ border: '2px dashed var(--border-med)', borderRadius: 8, padding: '20px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg-elevated)' }}>
                {uploadFile ? <span style={{ fontSize: 13 }}>{uploadFile.name}</span> : <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Click to select config file</span>}
                <input ref={uploadRef} type="file" style={{ display: 'none' }} onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setUploadServer(null); setUploadFile(null) }} style={{ padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={uploadBackup} disabled={uploading || !uploadFile}
                style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: uploading || !uploadFile ? 0.6 : 1 }}>
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── OS Health Tab ─────────────────────────────────────────────────────────────

// EOL data: { match: regex on snmp_firmware, eolDate, label }
const EOL_DB: { match: RegExp; label: string; eolDate: Date; extended?: Date }[] = [
  // Ubuntu
  { match: /ubuntu.*(16\.04|xenial)/i,  label: 'Ubuntu 16.04 LTS', eolDate: new Date('2021-04-30') },
  { match: /ubuntu.*(18\.04|bionic)/i,  label: 'Ubuntu 18.04 LTS', eolDate: new Date('2023-04-30'), extended: new Date('2028-04-30') },
  { match: /ubuntu.*(20\.04|focal)/i,   label: 'Ubuntu 20.04 LTS', eolDate: new Date('2025-04-30'), extended: new Date('2030-04-30') },
  { match: /ubuntu.*(22\.04|jammy)/i,   label: 'Ubuntu 22.04 LTS', eolDate: new Date('2027-04-30') },
  { match: /ubuntu.*(24\.04|noble)/i,   label: 'Ubuntu 24.04 LTS', eolDate: new Date('2029-04-30') },
  // Debian
  { match: /debian.*9|stretch/i,        label: 'Debian 9 (Stretch)',   eolDate: new Date('2022-06-30') },
  { match: /debian.*10|buster/i,        label: 'Debian 10 (Buster)',   eolDate: new Date('2024-06-30') },
  { match: /debian.*11|bullseye/i,      label: 'Debian 11 (Bullseye)', eolDate: new Date('2026-06-30') },
  { match: /debian.*12|bookworm/i,      label: 'Debian 12 (Bookworm)', eolDate: new Date('2028-06-30') },
  // CentOS / RHEL
  { match: /centos.*7|rhel.*7/i,        label: 'CentOS/RHEL 7',       eolDate: new Date('2024-06-30') },
  { match: /centos.*8/i,                label: 'CentOS 8',             eolDate: new Date('2021-12-31') },
  { match: /centos.*stream.*9/i,        label: 'CentOS Stream 9',      eolDate: new Date('2027-05-31') },
  { match: /rhel.*8/i,                  label: 'RHEL 8',               eolDate: new Date('2029-05-31') },
  { match: /rhel.*9/i,                  label: 'RHEL 9',               eolDate: new Date('2032-05-31') },
  // Windows Server
  { match: /windows.*2008|server.*2008/i, label: 'Windows Server 2008/R2', eolDate: new Date('2020-01-14') },
  { match: /windows.*2012|server.*2012/i, label: 'Windows Server 2012/R2', eolDate: new Date('2023-10-10') },
  { match: /windows.*2016|server.*2016/i, label: 'Windows Server 2016',    eolDate: new Date('2027-01-12') },
  { match: /windows.*2019|server.*2019/i, label: 'Windows Server 2019',    eolDate: new Date('2029-01-09') },
  { match: /windows.*2022|server.*2022/i, label: 'Windows Server 2022',    eolDate: new Date('2031-10-14') },
  // Alpine
  { match: /alpine.*3\.1[0-6]/i,         label: 'Alpine Linux (old)',      eolDate: new Date('2024-11-01') },
  { match: /alpine.*3\.1[7-9]|3\.2/i,    label: 'Alpine Linux 3.17+',      eolDate: new Date('2026-11-01') },
]

type EolStatus = 'eol' | 'expiring-soon' | 'active' | 'unknown'

function getEolInfo(snmpFirmware: string | null): { status: EolStatus; label: string; eolDate: Date | null; daysLeft: number | null } {
  if (!snmpFirmware) return { status: 'unknown', label: 'Unknown', eolDate: null, daysLeft: null }
  const now = new Date()
  for (const entry of EOL_DB) {
    if (entry.match.test(snmpFirmware)) {
      const daysLeft = Math.floor((entry.eolDate.getTime() - now.getTime()) / 86400000)
      const status: EolStatus = daysLeft < 0 ? 'eol' : daysLeft < 365 ? 'expiring-soon' : 'active'
      return { status, label: entry.label, eolDate: entry.eolDate, daysLeft }
    }
  }
  return { status: 'unknown', label: snmpFirmware.slice(0, 48), eolDate: null, daysLeft: null }
}

const STATUS_STYLE: Record<EolStatus, { bg: string; color: string; text: string }> = {
  'eol':           { bg: 'rgba(248,113,113,0.12)', color: '#f87171', text: 'EOL' },
  'expiring-soon': { bg: 'rgba(251,191,36,0.12)',  color: '#fbbf24', text: 'Expiring Soon' },
  'active':        { bg: 'rgba(52,211,153,0.12)',  color: '#34d399', text: 'Supported' },
  'unknown':       { bg: 'rgba(148,163,184,0.1)',  color: '#94a3b8', text: 'Unknown' },
}

// What's possible per os_type
const OS_CAPABILITIES: Record<string, { icon: string; backupWhat: string; howTo: string; note?: string }> = {
  linux: {
    icon: '🐧',
    backupWhat: '/etc/, crontabs, packages, services, network, firewall',
    howTo: 'SSH Pull (management key or password)',
    note: 'Works on any Linux with SSH access',
  },
  windows: {
    icon: '🪟',
    backupWhat: 'Roles, firewall rules, scheduled tasks, services, installed software, network config',
    howTo: 'SSH Pull (requires OpenSSH — built-in on Windows Server 2019+)',
    note: 'Enable: Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
  },
}

function OsHealthTab({ servers }: { servers: Server[] }) {
  const linuxAndWindows = servers.filter(s => s.os_type === 'linux' || s.os_type === 'windows')

  const counts = {
    eol: 0, 'expiring-soon': 0, active: 0, unknown: 0,
  }
  for (const s of linuxAndWindows) {
    const { status } = getEolInfo((s as any).snmp_firmware)
    counts[status]++
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>OS Health</h2>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          EOL status for Linux and Windows servers. Version detected from SNMP or firmware check.
        </p>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 24 }}>
        {(['eol', 'expiring-soon', 'active', 'unknown'] as EolStatus[]).map(s => {
          const st = STATUS_STYLE[s]
          return (
            <div key={s} style={{ background: st.bg, border: `1px solid ${st.color}33`, borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: st.color }}>{counts[s]}</div>
              <div style={{ fontSize: 11, color: st.color, fontWeight: 600 }}>{st.text}</div>
            </div>
          )
        })}
      </div>

      {/* Server table */}
      {linuxAndWindows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          No Linux or Windows servers found. Add servers with os_type = linux or windows.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)', marginBottom: 24 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                {['Server', 'Type', 'Detected OS', 'EOL Status', 'EOL Date', 'Days Left', 'Capabilities'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linuxAndWindows.map((s, i) => {
                const eol = getEolInfo((s as any).snmp_firmware)
                const st = STATUS_STYLE[eol.status]
                const cap = OS_CAPABILITIES[s.os_type ?? 'linux']
                return (
                  <tr key={s.id} style={{ borderBottom: i < linuxAndWindows.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.environment} · {s.hostname}</div>
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 16 }} title={s.os_type ?? ''}>{cap?.icon ?? '💻'}</td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {eol.label}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: st.bg, color: st.color }}>
                        {st.text}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {eol.eolDate ? eol.eolDate.toLocaleDateString() : '—'}
                    </td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: eol.daysLeft === null ? 'var(--text-muted)' : eol.daysLeft < 0 ? '#f87171' : eol.daysLeft < 365 ? '#fbbf24' : '#34d399' }}>
                      {eol.daysLeft === null ? '—' : eol.daysLeft < 0 ? `${Math.abs(eol.daysLeft)}d ago` : `${eol.daysLeft}d`}
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontSize: 11, maxWidth: 240, lineHeight: 1.4 }}>
                      {cap ? cap.backupWhat : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Capability reference */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {Object.entries(OS_CAPABILITIES).map(([osType, cap]) => (
          <div key={osType} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{cap.icon} {osType === 'linux' ? 'Linux' : 'Windows'} — Backup Capabilities</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              <strong style={{ color: 'var(--text-secondary)' }}>What gets backed up:</strong><br />
              {cap.backupWhat}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              <strong style={{ color: 'var(--text-secondary)' }}>How:</strong> {cap.howTo}
            </div>
            {cap.note && (
              <div style={{ fontSize: 11, padding: '6px 10px', background: 'var(--bg-elevated)', borderRadius: 6, fontFamily: 'monospace', color: 'var(--text-muted)', marginTop: 8 }}>
                {cap.note}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── TFTP Guide Tab ────────────────────────────────────────────────────────────

const VENDOR_GUIDES: {
  vendor: string
  icon: string
  color: string
  entries: { model: string; notes: string; cmd: (ip: string) => string }[]
}[] = [
  {
    vendor: 'Cisco', icon: '🔵', color: '#60a5fa',
    entries: [
      {
        model: 'IOS / IOS-XE (ISR, Catalyst 2960/3750/9xxx)',
        notes: 'Copies firmware to flash then reloads. Replace filename with your .bin.',
        cmd: ip => `copy tftp://${ip}/firmware/cisco/isr4321/isr4321-universalk9.17.06.06.SPA.bin flash:\nverify flash:isr4321-universalk9.17.06.06.SPA.bin\nboot system flash:isr4321-universalk9.17.06.06.SPA.bin\nwrite memory\nreload`,
      },
      {
        model: 'IOS-XR (ASR 9000, NCS)',
        notes: 'Installs a package from TFTP. Adjust pkg name accordingly.',
        cmd: ip => `install add source tftp://${ip}/firmware/cisco/asr9k/ asr9k-mini-x64-7.7.1.iso\ninstall activate pkg asr9k-mini-x64-7.7.1\ninstall commit`,
      },
      {
        model: 'NX-OS (Nexus 5k/7k/9k)',
        notes: 'Copy image to bootflash then set as boot variable.',
        cmd: ip => `copy tftp://${ip}/firmware/cisco/nexus9k/nxos64-cs.10.3.1.F.bin bootflash:\nboot nxos bootflash:nxos64-cs.10.3.1.F.bin\ncopy running-config startup-config\nreload`,
      },
    ],
  },
  {
    vendor: 'MikroTik', icon: '🟤', color: '#fb923c',
    entries: [
      {
        model: 'RouterOS (all RB series)',
        notes: '/tool fetch downloads the package to the router root; update install applies it on next reboot.',
        cmd: ip => `/tool fetch address=${ip} src-path=/firmware/mikrotik/rb750gr3/routeros-7.11.2-mipsbe.npk dst-path=/routeros-7.11.2-mipsbe.npk\n/system package update install`,
      },
      {
        model: 'RouterOS — upgrade via URL (v7.1+)',
        notes: 'Alternative: use the full URL form which avoids specifying address separately.',
        cmd: ip => `/tool fetch url="tftp://${ip}/firmware/mikrotik/rb750gr3/routeros-7.11.2-mipsbe.npk" dst-path=/routeros-7.11.2-mipsbe.npk\n/system reboot`,
      },
    ],
  },
  {
    vendor: 'Fortinet FortiGate', icon: '🔴', color: '#f87171',
    entries: [
      {
        model: 'FortiGate (all models, FortiOS 6.x / 7.x)',
        notes: 'Format: execute restore image tftp <filename> <tftp-server-ip>. File must be a valid .out image for your model.',
        cmd: ip => `execute restore image tftp FGT_60E-v7.2.5.F-build1517-FORTINET.out ${ip}`,
      },
      {
        model: 'FortiSwitch',
        notes: 'Uses the same restore image command pattern.',
        cmd: ip => `execute restore image tftp FS_108E-v7.2.5-build0453-FORTINET.out ${ip}`,
      },
    ],
  },
  {
    vendor: 'Juniper', icon: '🟢', color: '#34d399',
    entries: [
      {
        model: 'Junos (EX, SRX, MX, QFX)',
        notes: 'request system software add fetches and installs. reboot is required after.',
        cmd: ip => `request system software add tftp://${ip}/firmware/juniper/ex2300/junos-arm-32-20.4R3-S6.2.tgz\nrequest system reboot`,
      },
      {
        model: 'Junos — package validate first (recommended)',
        notes: 'Validate before installing to catch model/version mismatches.',
        cmd: ip => `request system software validate tftp://${ip}/firmware/juniper/srx300/junos-srxsme-21.4R1.12.tgz\nrequest system software add tftp://${ip}/firmware/juniper/srx300/junos-srxsme-21.4R1.12.tgz\nrequest system reboot`,
      },
    ],
  },
  {
    vendor: 'Ubiquiti', icon: '⚪', color: '#94a3b8',
    entries: [
      {
        model: 'AirOS (NanoStation, Rocket, Bullet)',
        notes: 'SSH to device then run the upgrade command with the TFTP URL.',
        cmd: ip => `upgrade tftp://${ip}/firmware/ubiquiti/nanostation-m5/XM.v6.3.12.32834.200508.1754.bin`,
      },
      {
        model: 'UniFi Access Points (AirOS-based, legacy)',
        notes: 'upgrade command works on UniFi APs running AirOS firmware via SSH.',
        cmd: ip => `upgrade tftp://${ip}/firmware/ubiquiti/unifi-ap-ac-pro/BZ.mt7621_5.43.36.12539.bin`,
      },
      {
        model: 'EdgeRouter (EdgeOS)',
        notes: 'EdgeOS uses add system image, not upgrade. After add, reboot to apply.',
        cmd: ip => `add system image tftp://${ip}/firmware/ubiquiti/edgerouter-4/ER-e200.v2.0.9.5344684.tar\nreboot`,
      },
    ],
  },
  {
    vendor: 'HPE Aruba', icon: '🟠', color: '#fb923c',
    entries: [
      {
        model: 'ArubaOS Switch (2530, 2930, 3810, 5400)',
        notes: 'Copy to secondary flash, then set boot-source and reboot.',
        cmd: ip => `copy tftp flash ${ip} /firmware/aruba/2930f/WC_16_10_0011.swi secondary\nboot set-default flash secondary\nreload`,
      },
      {
        model: 'HP Comware-based (A-series / V1910 / 5120)',
        notes: 'Comware uses a different syntax: tftp get then boot-loader.',
        cmd: ip => `tftp ${ip} get /firmware/aruba/v1910/V1910-CMW520-R1514.bin\nboot-loader file flash:/V1910-CMW520-R1514.bin main\nreboot`,
      },
    ],
  },
  {
    vendor: 'Huawei', icon: '🔶', color: '#fbbf24',
    entries: [
      {
        model: 'VRP (CloudEngine, AR, S-series switches)',
        notes: 'tftp downloads to flash, startup system-software sets the boot image.',
        cmd: ip => `tftp ${ip} get /firmware/huawei/s5735/S5735-L-V200R022C00SPC500.cc\nstartup system-software flash:/S5735-L-V200R022C00SPC500.cc\nreboot`,
      },
    ],
  },
  {
    vendor: 'H3C / HP FlexNetwork', icon: '🟡', color: '#facc15',
    entries: [
      {
        model: 'Comware 7 (S5130, S6520, MSR)',
        notes: 'tftp get downloads the image; boot-loader applies it on next reboot.',
        cmd: ip => `tftp ${ip} get /firmware/h3c/s5130/s5130ei-cmw710-r3506p04.ipe\nboot-loader file flash:/s5130ei-cmw710-r3506p04.ipe main\nreboot`,
      },
    ],
  },
  {
    vendor: 'Palo Alto', icon: '🟣', color: '#a78bfa',
    entries: [
      {
        model: 'PAN-OS (PA-series, VM-Series)',
        notes: 'Palo Alto does not support TFTP for upgrades. Use SCP or the web UI.',
        cmd: _ip => `# Palo Alto does not support TFTP firmware upgrades.\n# Use SCP instead:\nscp import software from admin@<linux-host>:/path/to/PanOS_800-10.1.11.tgz\n\n# Or via web UI: Device → Software → Download & Install`,
      },
    ],
  },
  {
    vendor: 'pfSense / OPNsense', icon: '🔷', color: '#38bdf8',
    entries: [
      {
        model: 'pfSense / OPNsense (FreeBSD-based)',
        notes: 'These firewalls do not support TFTP upgrades. Use their built-in web updater.',
        cmd: _ip => `# pfSense: System → Update → System Update (web UI)\n# OPNsense: System → Firmware → Updates (web UI)\n\n# For offline upgrade, download the .img.gz or .iso from netgate.com / opnsense.org\n# and upload via: Diagnostics → Command Prompt → or SCP to /tmp/`,
      },
    ],
  },
]

function TftpGuideTab() {
  const serverIp = window.location.hostname
  const [openVendor, setOpenVendor] = useState<string | null>('Cisco')
  const [copied, setCopied] = useState<string | null>(null)

  const copyCmd = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1800)
    })
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>TFTP Server Guide</h2>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          TFTP server address: <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{serverIp}</strong> port <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>69/UDP</strong>.
          Replace filenames in the commands below with your actual firmware filename from the Firmware Library tab.
        </p>
      </div>

      {/* Info bar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div style={{ padding: '12px 16px', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 8, fontSize: 12, lineHeight: 1.7 }}>
          <strong style={{ color: '#34d399' }}>📋 Config Backups</strong> are pulled by SSH Manager directly — no device commands needed.
          Go to <strong>Config Backups</strong> tab → select device → <strong>Pull Backup</strong>.
        </div>
        <div style={{ padding: '12px 16px', background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 8, fontSize: 12, lineHeight: 1.7 }}>
          <strong>📁 TFTP root path:</strong><br />
          <code style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>firmware/&lt;vendor&gt;/&lt;model&gt;/&lt;file&gt;</code><br />
          e.g. <code style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>firmware/cisco/isr4321/isr4321-universalk9.17.06.06.SPA.bin</code>
        </div>
      </div>

      {/* Vendor accordion */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {VENDOR_GUIDES.map(vg => {
          const open = openVendor === vg.vendor
          return (
            <div key={vg.vendor} style={{ border: `1px solid ${open ? vg.color + '44' : 'var(--border-med)'}`, borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)', transition: 'border-color 0.15s' }}>
              {/* Header */}
              <button onClick={() => setOpenVendor(open ? null : vg.vendor)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: open ? `${vg.color}10` : 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontSize: 18 }}>{vg.icon}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: open ? vg.color : 'var(--text-primary)' }}>{vg.vendor}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{vg.entries.length} model{vg.entries.length !== 1 ? 's' : ''}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>{open ? '▲' : '▼'}</span>
              </button>

              {/* Body */}
              {open && (
                <div style={{ borderTop: `1px solid ${vg.color}33`, padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {vg.entries.map((entry, ei) => {
                    const cmdText = entry.cmd(serverIp)
                    const copyKey = `${vg.vendor}-${ei}`
                    return (
                      <div key={ei}>
                        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2, color: 'var(--text-primary)' }}>{entry.model}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{entry.notes}</div>
                        <div style={{ position: 'relative' }}>
                          <div style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-med)', borderRadius: 6, padding: '8px 40px 8px 12px', whiteSpace: 'pre', overflowX: 'auto', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                            {cmdText}
                          </div>
                          <button onClick={() => copyCmd(copyKey, cmdText)}
                            style={{ position: 'absolute', top: 6, right: 6, padding: '3px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border-med)', background: copied === copyKey ? 'rgba(52,211,153,0.15)' : 'var(--bg-panel)', color: copied === copyKey ? '#34d399' : 'var(--text-muted)', cursor: 'pointer' }}>
                            {copied === copyKey ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer note */}
      <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
        <strong style={{ color: 'var(--text-secondary)' }}>Note:</strong> Always verify the firmware filename matches the exact file uploaded in the Firmware Library tab.
        Replace <code style={{ fontFamily: 'monospace' }}>&lt;model&gt;</code> subdirectory paths to match your vendor/model names as entered during upload.
        TFTP has no authentication — ensure firewall rules restrict port 69/UDP to trusted management VLANs only.
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FirmwareRepo() {
  const [tab, setTab] = useState<'firmware' | 'backups' | 'oshealth' | 'guide'>('firmware')
  const [servers, setServers] = useState<Server[]>([])

  useEffect(() => {
    api.get<Server[]>('/servers').then(setServers).catch(() => {})
  }, [])

  const tabs: [typeof tab, string][] = [
    ['firmware',  '💾 Firmware Library'],
    ['backups',   '📋 Config Backups'],
    ['oshealth',  '🩺 OS Health'],
    ['guide',     '📖 TFTP Guide'],
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border-med)', paddingBottom: 0 }}>
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ padding: '8px 18px', fontSize: 13, fontWeight: tab === key ? 700 : 400, border: 'none', borderBottom: `2px solid ${tab === key ? 'var(--accent-hex)' : 'transparent'}`, background: 'transparent', color: tab === key ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer', marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'firmware'  && <FirmwareLibraryTab />}
      {tab === 'backups'   && <ConfigBackupsTab servers={servers} />}
      {tab === 'oshealth'  && <OsHealthTab servers={servers} />}
      {tab === 'guide'     && <TftpGuideTab />}
    </div>
  )
}
