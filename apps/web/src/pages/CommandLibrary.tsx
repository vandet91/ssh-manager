import { useEffect, useState } from 'react'
import { api } from '../api/client'

type OS = 'windows' | 'linux'

type Cmd = {
  id: string
  os: OS
  category: string
  label: string
  command: string
  description: string
  sort_order: number
}

type FormState = {
  os: OS
  category: string
  label: string
  command: string
  description: string
}

const EMPTY_FORM: FormState = { os: 'windows', category: '', label: '', command: '', description: '' }

export default function CommandLibrary() {
  const [cmds, setCmds]         = useState<Cmd[]>([])
  const [os, setOs]             = useState<OS>('windows')
  const [category, setCategory] = useState('All')
  const [search, setSearch]     = useState('')
  const [loading, setLoading]   = useState(true)
  const [seeding, setSeeding]   = useState(false)
  const [seedingMore, setSeedingMore] = useState(false)
  const [page, setPage]         = useState(1)
  const PAGE_SIZE = 20
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing]   = useState<Cmd | null>(null)
  const [form, setForm]         = useState<FormState>(EMPTY_FORM)
  const [copied, setCopied]     = useState<string | null>(null)
  const [pinned, setPinned]     = useState<string | null>(null)
  const [saving, setSaving]     = useState(false)
  const [customCat, setCustomCat] = useState('')
  const [pinnedCmds, setPinnedCmds] = useState<Set<string>>(new Set())

  const loadPinned = async () => {
    try {
      const pins = await api.get<{content:string}[]>('/share/pins')
      setPinnedCmds(new Set(pins.map(p => p.content)))
    } catch {}
  }

  const load = async () => {
    setLoading(true)
    try {
      const data = await api.get<Cmd[]>(`/commands?os=${os}`)
      setCmds(data)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [os])
  useEffect(() => { loadPinned() }, [])

  const seed = async () => {
    setSeeding(true)
    try { await api.post('/commands/seed'); await load() } catch {}
    setSeeding(false)
  }

  const seedMore = async () => {
    setSeedingMore(true)
    try { await api.post('/commands/seed-more'); await load() } catch {}
    setSeedingMore(false)
  }

  const normCat = (s: string) => s.trim().toLowerCase()
  const categories = ['All', ...Array.from(
    new Map(cmds.map(c => [normCat(c.category), c.category.trim()])).values()
  ).sort((a, b) => a.localeCompare(b))]

  const visible = cmds.filter(c => {
    const matchCat = category === 'All' || normCat(c.category) === normCat(category)
    const q = search.toLowerCase()
    const matchQ = !q || c.label.toLowerCase().includes(q) || c.command.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q)
    return matchCat && matchQ
  })

  const totalPages = Math.ceil(visible.length / PAGE_SIZE)
  const paged = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Always render exactly 5 page slots so the bar never changes width
  const pageSlots = (() => {
    if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const half = 2
    let start = Math.max(1, page - half)
    let end   = Math.min(totalPages, start + 4)
    start = Math.max(1, end - 4)
    return Array.from({ length: 5 }, (_, i) => start + i)
  })()

  useEffect(() => { setPage(1) }, [os, category, search])

  const openAdd = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM, os, category: category !== 'All' ? category : '' })
    setCustomCat('')
    setShowForm(true)
  }

  const openEdit = (c: Cmd) => {
    setEditing(c)
    setForm({ os: c.os, category: c.category, label: c.label, command: c.command, description: c.description || '' })
    setCustomCat('')
    setShowForm(true)
  }

  const save = async () => {
    setSaving(true)
    const payload = { ...form, category: form.category || customCat }
    try {
      if (editing) {
        await api.put(`/commands/${editing.id}`, payload)
      } else {
        await api.post('/commands', payload)
      }
      setShowForm(false)
      await load()
    } catch {}
    setSaving(false)
  }

  const del = async (id: string) => {
    if (!confirm('Delete this command?')) return
    await api.delete(`/commands/${id}`)
    setCmds(prev => prev.filter(c => c.id !== id))
  }

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }

  const WIN_CATS = ['General','Services (SC)','Print Server','File Sharing','NPS / RADIUS','Network']
  const LIN_CATS = ['System','Services','Network','Logs','Files & Disk','Packages']
  const presetCats = form.os === 'windows' ? WIN_CATS : LIN_CATS

  const tagColor = (cat: string): React.CSSProperties => {
    const map: Record<string, string> = {
      'General': '#6b7280', 'System': '#6b7280',
      'Services (SC)': '#059669', 'Services': '#059669',
      'Print Server': '#7c3aed',
      'File Sharing': '#d97706', 'Files & Disk': '#d97706',
      'NPS / RADIUS': '#dc2626',
      'Network': '#2563eb',
      'Logs': '#0891b2',
      'Packages': '#db2777',
    }
    return { background: map[cat] ?? '#374151', color: '#fff', fontSize: 10, padding: '2px 7px', borderRadius: 4, fontWeight: 600, whiteSpace: 'nowrap' }
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 960, width: '100%', margin: '0 auto', fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #e6edf3)' }}>📚 Command Library</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-muted, #8b949e)' }}>
            Saved commands for Windows & Linux — click Copy or send directly from the RDP/Terminal panel
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {cmds.length === 0 && !loading && (
            <button onClick={seed} disabled={seeding} style={btn('accent')}>
              {seeding ? '⏳ Seeding…' : '⚡ Load defaults'}
            </button>
          )}
          <button onClick={seedMore} disabled={seedingMore} style={btn('purple')} title="Add missing built-in commands (AD, GPO, DNS, DHCP…)">
            {seedingMore ? '⏳ Loading…' : '➕ Load more defaults'}
          </button>
          <button onClick={openAdd} style={btn('success')}>+ Add command</button>
        </div>
      </div>

      {/* OS toggle */}
      <div style={{ display: 'flex', marginBottom: 16, border: '1px solid var(--border-med)', borderRadius: 8, width: 'fit-content', overflow: 'hidden' }}>
        {(['windows', 'linux'] as OS[]).map(o => (
          <button key={o} onClick={() => { setOs(o); setCategory('All') }}
            style={{ padding: '7px 22px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
              background: os === o ? 'var(--btn-accent-bg)' : 'transparent',
              color: os === o ? '#fff' : 'var(--text-secondary)' }}>
            {o === 'windows' ? '🪟 Windows' : '🐧 Linux'}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search commands…"
          style={{ ...inp, width: 220 }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {categories.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)}
              style={{ padding: '4px 12px', borderRadius: 999, border: '1px solid', fontSize: 12, cursor: 'pointer', fontWeight: 500,
                borderColor: category === cat ? 'var(--accent-hex)' : 'var(--border-med)',
                background: category === cat ? 'rgba(var(--accent)/0.12)' : 'transparent',
                color: category === cat ? 'var(--accent-hex)' : 'var(--text-secondary)' }}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Count + pagination info */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
          {visible.length} command{visible.length !== 1 ? 's' : ''}
          {totalPages > 1 && ` — page ${page} of ${totalPages}`}
        </p>
        {totalPages > 1 && <Paginator page={page} totalPages={totalPages} pageSlots={pageSlots} setPage={setPage} />}
      </div>

      {/* Command list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-secondary)' }}>
          {cmds.length === 0
            ? <span>No commands yet. Click <strong>⚡ Load defaults</strong> to seed built-in commands.</span>
            : 'No commands match your filter.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: `${PAGE_SIZE * 56}px` }}>
          {paged.map((c: Cmd) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px',
              background: 'var(--bg-panel)', border: '1px solid var(--border-weak)', borderRadius: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.label}</span>
                  <span style={tagColor(c.category)}>{c.category}</span>
                </div>
                <code style={{ display: 'block', fontSize: 12, color: 'var(--accent-lite-hex)', wordBreak: 'break-all', fontFamily: 'monospace', marginBottom: c.description ? 3 : 0 }}>
                  {c.command}
                </code>
                {c.description && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{c.description}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, paddingTop: 2 }}>
                <button onClick={() => copy(c.command, c.id)} style={btn(copied === c.id ? 'success' : 'default')}>
                  {copied === c.id ? '✓ Copied' : '📋 Copy'}
                </button>
                <button onClick={async () => {
                  if (pinnedCmds.has(c.command)) return
                  try {
                    await api.post('/share/pins', { content: c.command, device_type: c.os, label: c.label })
                    setPinnedCmds(prev => new Set(prev).add(c.command))
                    setPinned(c.id)
                    setTimeout(() => setPinned(null), 1500)
                  } catch {}
                }} disabled={pinnedCmds.has(c.command)}
                style={btn(pinnedCmds.has(c.command) || pinned === c.id ? 'success' : 'default')}
                title={pinnedCmds.has(c.command) ? 'Already pinned (permanent)' : 'Pin permanently'}>
                  {pinnedCmds.has(c.command) ? '✓ Pinned' : pinned === c.id ? '✓ Added' : '📌 Pin'}
                </button>
                <button onClick={() => openEdit(c)} style={btn('default')}>✏️</button>
                <button onClick={() => del(c.id)} style={btn('danger')}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bottom pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
          <Paginator page={page} totalPages={totalPages} pageSlots={pageSlots} setPage={setPage} />
        </div>
      )}

      {/* Add/Edit modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div style={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-border)', borderRadius: 12, padding: 24, width: 520, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-heading)' }}>{editing ? 'Edit command' : 'Add command'}</h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>OS</label>
                <select value={form.os} onChange={e => setForm(f => ({ ...f, os: e.target.value as OS, category: '' }))} style={inp}>
                  <option value="windows">🪟 Windows</option>
                  <option value="linux">🐧 Linux</option>
                </select>
              </div>
              <div>
                <label style={lbl}>Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={inp}>
                  <option value="">— custom —</option>
                  {presetCats.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {!form.category && (
              <div>
                <label style={lbl}>Custom category</label>
                <input value={customCat} onChange={e => setCustomCat(e.target.value)} placeholder="e.g. Active Directory" style={inp} />
              </div>
            )}

            <div>
              <label style={lbl}>Label</label>
              <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Short name, e.g. Restart spooler" style={inp} />
            </div>
            <div>
              <label style={lbl}>Command</label>
              <textarea value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))} placeholder="net stop spooler && net start spooler"
                rows={3} style={{ ...inp, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
            </div>
            <div>
              <label style={lbl}>Description <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What this command does" style={inp} />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} style={btn('default')}>Cancel</button>
              <button onClick={save} disabled={saving || !form.label || !form.command || (!form.category && !customCat)}
                style={btn('accent')}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add command'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Paginator({ page, totalPages, pageSlots, setPage }: {
  page: number; totalPages: number; pageSlots: number[]; setPage: (p: number) => void
}) {
  const b = (active: boolean, disabled = false): React.CSSProperties => ({
    padding: '5px 0', width: 34, textAlign: 'center', borderRadius: 6,
    border: '1px solid var(--border-med)',
    background: active ? 'var(--btn-accent-bg)' : 'var(--bg-panel-alt)',
    color: active ? '#fff' : 'var(--text-secondary)',
    cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600,
    opacity: disabled ? 0.4 : 1, flexShrink: 0,
  })
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} style={b(false, page === 1)}>‹</button>
      {pageSlots[0] > 1 && <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 34, textAlign: 'center' }}>…</span>}
      {pageSlots.map(p => (
        <button key={p} onClick={() => setPage(p)} style={b(p === page)}>{p}</button>
      ))}
      {pageSlots[pageSlots.length - 1] < totalPages && <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 34, textAlign: 'center' }}>…</span>}
      <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} style={b(false, page === totalPages)}>›</button>
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--input-border)', background: 'var(--input-bg)',
  color: 'var(--input-text)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
}
const lbl: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4,
}
function btn(variant: 'default' | 'accent' | 'success' | 'danger' | 'purple'): React.CSSProperties {
  const map = {
    default: { bg: 'var(--bg-panel-alt)', border: 'var(--border-med)', color: 'var(--text-primary)' },
    accent:  { bg: 'var(--btn-accent-bg)', border: 'var(--btn-accent-border)', color: 'var(--btn-accent-text)' },
    success: { bg: '#238636', border: 'rgba(35,134,54,0.5)', color: '#fff' },
    danger:  { bg: '#6e1010', border: 'rgba(110,16,16,0.5)', color: '#fff' },
    purple:  { bg: '#6e40c9', border: 'rgba(110,64,201,0.5)', color: '#fff' },
  }
  const v = map[variant]
  return { padding: '5px 12px', borderRadius: 6, border: `1px solid ${v.border}`, background: v.bg, color: v.color, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }
}
