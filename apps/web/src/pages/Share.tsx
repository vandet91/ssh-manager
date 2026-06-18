import { useState, useRef, useEffect } from 'react'
import { api } from '../api/client'

type Server = { id: string; name: string; hostname: string; os_type?: string; management_key_id?: string | null }

const DEVICE_TYPES = [
  { value: 'windows', label: '🪟 Windows', color: '#0078d4' },
  { value: 'linux',   label: '🐧 Linux',   color: '#e95420' },
  { value: 'router',  label: '🔀 Router',  color: '#16a34a' },
  { value: 'switch',  label: '🔌 Switch',  color: '#7c3aed' },
  { value: 'ap',      label: '📡 AP',      color: '#0891b2' },
  { value: 'general', label: '📋 General', color: '#6b7280' },
]

function typeInfo(dt: string) {
  return DEVICE_TYPES.find(t => t.value === dt) ?? { value: dt, label: `📌 ${dt}`, color: '#6b7280' }
}

type ShareItem = {
  id: string
  type: 'text' | 'file'
  device_type?: string
  name: string
  size?: number
  content?: string
  createdAt: string
  expiresAt: string
}

export default function Share() {
  const [items, setItems]         = useState<ShareItem[]>([])
  const [clipText, setClipText]   = useState('')
  const [deviceType, setDeviceType] = useState('windows')
  const [label, setLabel]         = useState('')
  const [filterType, setFilterType] = useState('all')
  const [textError, setTextError] = useState('')
  const [fileError, setFileError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText]   = useState('')
  const [editLabel, setEditLabel] = useState('')
  const [editType, setEditType]   = useState('windows')
  const [servers, setServers]     = useState<Server[]>([])
  const [grabServerId, setGrabServerId] = useState('')
  const [grabPath, setGrabPath]   = useState('')
  const [grabLoading, setGrabLoading] = useState(false)
  const [grabError, setGrabError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadShares()
    api.get<Server[]>('/servers').then(s => setServers(s.filter(sv => sv.management_key_id))).catch(() => {})
  }, [])

  const loadShares = async () => {
    try { setItems(await api.get<ShareItem[]>('/share/list')) } catch {}
  }

  const shareText = async () => {
    if (!clipText.trim()) return
    setTextError('')
    try {
      const res = await api.post<{ id: string; expiresAt: string }>('/share/text', {
        text: clipText, device_type: deviceType, label: label.trim() || undefined,
      })
      setItems(prev => [{ id: res.id, type: 'text', device_type: deviceType,
        name: label.trim() || 'Note', content: clipText,
        createdAt: new Date().toISOString(), expiresAt: res.expiresAt }, ...prev])
      setClipText(''); setLabel('')
    } catch (e: any) { setTextError(e?.data?.error ?? 'Failed to save') }
  }

  const saveEdit = async (id: string) => {
    try {
      await api.delete(`/share/${id}`)
      const res = await api.post<{ id: string; expiresAt: string }>('/share/text', {
        text: editText, device_type: editType, label: editLabel.trim() || undefined,
      })
      setItems(prev => prev.map(x => x.id === id
        ? { ...x, id: res.id, content: editText, device_type: editType, name: editLabel.trim() || 'Note', expiresAt: res.expiresAt }
        : x))
      setEditingId(null)
    } catch {}
  }

  const uploadFiles = async (files: File[]) => {
    setFileError('')
    setUploading(true)
    try {
      for (const file of files) {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch('/api/share/file', { method: 'POST', body: form, credentials: 'include' })
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `Upload failed (${res.status})`) }
        const data = await res.json()
        setItems(prev => [{ id: data.id, type: 'file', name: data.name ?? file.name, size: data.size ?? file.size,
          createdAt: new Date().toISOString(), expiresAt: data.expiresAt }, ...prev])
      }
    } catch (err: unknown) {
      setFileError((err as Error).message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const grabFromServer = async () => {
    if (!grabServerId || !grabPath.trim()) return
    setGrabError('')
    setGrabLoading(true)
    try {
      const res = await fetch(`/api/servers/${grabServerId}/fs/download?path=${encodeURIComponent(grabPath.trim())}`, { credentials: 'include' })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `Failed (${res.status})`) }
      const buf = await res.arrayBuffer()
      const filename = grabPath.trim().split('/').pop()?.split('\\').pop() || 'file'
      const form = new FormData()
      form.append('file', new File([buf], filename))
      const shareRes = await fetch('/api/share/file', { method: 'POST', body: form, credentials: 'include' })
      if (!shareRes.ok) { const j = await shareRes.json().catch(() => ({})); throw new Error(j.error ?? 'Share failed') }
      const data = await shareRes.json()
      setItems(prev => [{ id: data.id, type: 'file', name: data.name ?? filename, size: buf.byteLength,
        createdAt: new Date().toISOString(), expiresAt: data.expiresAt }, ...prev])
      setGrabPath('')
    } catch (err: unknown) {
      setGrabError((err as Error).message)
    } finally {
      setGrabLoading(false)
    }
  }

  const deleteItem = async (id: string) => {
    try { await api.delete(`/share/${id}`); setItems(prev => prev.filter(x => x.id !== id)) } catch {}
  }

  const textItems = items.filter(x => x.type === 'text')
  const fileItems = items.filter(x => x.type === 'file')

  const usedTypes = Array.from(new Set(textItems.map(x => x.device_type || 'general')))
  const filteredNotes = filterType === 'all' ? textItems : textItems.filter(x => (x.device_type || 'general') === filterType)

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>🔗 Share</h1>
      <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--text-muted)' }}>
        Sticky notes and files shared to your sessions — filtered by device type in each panel.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20 }}>

        {/* ── Left: create note + file upload ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* New sticky note */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 16 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>📌 New sticky note</h2>

            {/* Device type selector */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {DEVICE_TYPES.map(t => (
                <button key={t.value} onClick={() => setDeviceType(t.value)} style={{
                  padding: '4px 10px', borderRadius: 999, border: '1.5px solid',
                  borderColor: deviceType === t.value ? t.color : 'transparent',
                  background: deviceType === t.value ? t.color + '22' : 'var(--bg-input)',
                  color: deviceType === t.value ? t.color : 'var(--text-muted)',
                  fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}>{t.label}</button>
              ))}
            </div>

            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (optional)"
              style={{ ...inp, marginBottom: 8 }} />
            <textarea value={clipText} onChange={e => setClipText(e.target.value)}
              placeholder="Command or text…" rows={4}
              style={{ ...inp, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} />
            {textError && <p style={{ margin: '6px 0 0', fontSize: 11, color: '#ef4444' }}>{textError}</p>}
            <button onClick={shareText} disabled={!clipText.trim()}
              style={{ marginTop: 10, width: '100%', padding: '8px', borderRadius: 6, border: 'none',
                background: clipText.trim() ? typeInfo(deviceType).color : '#4b5563',
                color: '#fff', cursor: clipText.trim() ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 600 }}>
              Save as {typeInfo(deviceType).label} note
            </button>
          </div>

          {/* File upload */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 16 }}>
            <h2 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>📁 File Share</h2>
            <input ref={fileInputRef} type="file" multiple onChange={e => { uploadFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} style={{ display: 'none' }} />
            <div onClick={() => !uploading && fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); (e.currentTarget as HTMLDivElement).style.borderColor = '#1f6feb' }}
              onDragLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-med)' }}
              onDrop={e => { e.preventDefault(); (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-med)'; if (!uploading) uploadFiles(Array.from(e.dataTransfer.files)) }}
              style={{ padding: 20, borderRadius: 8, border: '2px dashed var(--border-med)',
                background: 'var(--bg-input)', cursor: uploading ? 'default' : 'pointer', textAlign: 'center', opacity: uploading ? 0.6 : 1 }}>
              <div style={{ fontSize: 26, marginBottom: 4 }}>{uploading ? '⏳' : '📤'}</div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{uploading ? 'Uploading…' : 'Click or drop files'}</p>
            </div>
            {fileError && <p style={{ margin: '8px 0 0', fontSize: 11, color: '#ef4444' }}>⚠️ {fileError}</p>}
          </div>

          {/* Grab from server */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 16 }}>
            <h2 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>🖥 Grab file from server</h2>
            <select value={grabServerId} onChange={e => setGrabServerId(e.target.value)}
              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12, marginBottom: 8 }}>
              <option value=''>— Select server —</option>
              {servers.map(s => <option key={s.id} value={s.id}>{s.os_type === 'windows' ? '🪟' : '🐧'} {s.name} ({s.hostname})</option>)}
            </select>
            <input value={grabPath} onChange={e => setGrabPath(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && grabFromServer()}
              placeholder='/var/log/syslog  or  C:\path\to\file.txt'
              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'monospace', marginBottom: 8, boxSizing: 'border-box' }} />
            {grabError && <p style={{ margin: '0 0 8px', fontSize: 11, color: '#ef4444' }}>⚠️ {grabError}</p>}
            <button onClick={grabFromServer} disabled={grabLoading || !grabServerId || !grabPath.trim()}
              style={{ width: '100%', padding: '8px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 600, cursor: grabLoading || !grabServerId || !grabPath.trim() ? 'not-allowed' : 'pointer',
                background: grabLoading || !grabServerId || !grabPath.trim() ? '#4b5563' : '#0e7490', color: '#fff' }}>
              {grabLoading ? '⏳ Fetching…' : '⬇ Fetch & Share'}
            </button>
          </div>

          {/* Shared files */}
          {fileItems.length > 0 && (
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-med)', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>
                📂 SHARED FILES ({fileItems.length})
              </div>
              {fileItems.map(item => (
                <div key={item.id} style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border-weak)', fontSize: 12 }}>
                  <span>📄</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.size ? `${(item.size / 1024).toFixed(1)} KB` : ''}</div>
                  </div>
                  <a href={`/api/share/access/${item.id}`} download={item.name}
                    style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid var(--border-med)', color: 'var(--accent-hex)', fontSize: 11, textDecoration: 'none', fontWeight: 600 }}>
                    ⬇
                  </a>
                  <button onClick={() => deleteItem(item.id)}
                    style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 13 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Right: sticky notes grouped by type ── */}
        <div>
          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={() => setFilterType('all')} style={filterBtn(filterType === 'all', '#6b7280')}>All ({textItems.length})</button>
            {usedTypes.map(t => {
              const info = typeInfo(t)
              return (
                <button key={t} onClick={() => setFilterType(t)} style={filterBtn(filterType === t, info.color)}>
                  {info.label} ({textItems.filter(x => (x.device_type || 'general') === t).length})
                </button>
              )
            })}
            <button onClick={loadShares} style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>🔄</button>
          </div>

          {filteredNotes.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              No notes yet. Create one on the left.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {filteredNotes.map(item => {
                const info = typeInfo(item.device_type || 'general')
                const isEditing = editingId === item.id
                return (
                  <div key={item.id} style={{ background: '#fff9e6', border: `2px solid ${info.color}33`, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                        background: info.color + '22', color: info.color }}>{info.label}</span>
                      {item.name && item.name !== 'Note' && item.name !== 'Clipboard' && (
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#555', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                      )}
                      <button onClick={() => deleteItem(item.id)}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0 }}>✕</button>
                    </div>

                    {/* Content or edit form */}
                    {isEditing ? (
                      <>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {DEVICE_TYPES.map(t => (
                            <button key={t.value} onClick={() => setEditType(t.value)} style={{
                              padding: '2px 7px', borderRadius: 999, border: '1.5px solid',
                              borderColor: editType === t.value ? t.color : 'transparent',
                              background: editType === t.value ? t.color + '22' : '#f5f5f5',
                              color: editType === t.value ? t.color : '#666',
                              fontSize: 10, fontWeight: 600, cursor: 'pointer',
                            }}>{t.label}</button>
                          ))}
                        </div>
                        <input value={editLabel} onChange={e => setEditLabel(e.target.value)} placeholder="Label"
                          style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid #ddd', fontSize: 12, background: '#fffde7' }} />
                        <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={4}
                          style={{ padding: '6px 8px', borderRadius: 5, border: '1px solid #ddd', fontSize: 12, fontFamily: 'monospace', resize: 'vertical', background: '#fffde7' }} />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => saveEdit(item.id)}
                            style={{ flex: 1, padding: '5px', borderRadius: 5, border: 'none', background: '#22c55e', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                            ✓ Save
                          </button>
                          <button onClick={() => setEditingId(null)}
                            style={{ padding: '5px 10px', borderRadius: 5, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 11, cursor: 'pointer' }}>
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <pre style={{ margin: 0, fontSize: 11, color: '#333', lineHeight: 1.5, maxHeight: 120,
                          overflow: 'auto', wordBreak: 'break-all', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                          {item.content}
                        </pre>
                        <div style={{ display: 'flex', gap: 5, marginTop: 'auto' }}>
                          <button onClick={() => navigator.clipboard.writeText(item.content || '')}
                            style={{ flex: 1, padding: '5px', borderRadius: 5, border: 'none', background: '#f0e68c', color: '#333', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                            📋 Copy
                          </button>
                          <button onClick={() => { setEditingId(item.id); setEditText(item.content || ''); setEditLabel(item.name === 'Note' || item.name === 'Clipboard' ? '' : item.name); setEditType(item.device_type || 'general') }}
                            style={{ padding: '5px 10px', borderRadius: 5, border: '1px solid #e0d88a', background: '#fff', color: '#666', fontSize: 11, cursor: 'pointer' }}>
                            ✏️
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6,
  border: '1px solid var(--border-med)', background: 'var(--bg-input)',
  color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
}

function filterBtn(active: boolean, color: string): React.CSSProperties {
  return {
    padding: '4px 12px', borderRadius: 999, border: `1.5px solid ${active ? color : 'transparent'}`,
    background: active ? color + '22' : 'var(--bg-input)', color: active ? color : 'var(--text-muted)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  }
}
