import { useEffect, useState, useMemo, useCallback } from 'react'
import { api, VaultEntry, VaultType, ServerCredential, Server } from '../api/client'
import Modal from '../components/Modal'

const TYPE_LABELS: Record<VaultType, string> = {
  server_os: '🖥 Server OS',
  service: '⚙ Service / App',
  api_key: '🔑 API Key',
  network_device: '🌐 Network Device',
  domain_ad: '🏢 Domain / AD',
  email: '📧 Email',
  printer: '🖨 Printer',
  dvr: '📹 DVR / Camera',
  other: '📦 Other',
}

const ALL_TYPES = Object.keys(TYPE_LABELS) as VaultType[]

type FormState = {
  title: string
  type: VaultType
  category: string
  ou: string
  tags: string
  username: string
  password: string
  url: string
  notes: string
  server_credential_id: string
}

const BLANK: FormState = {
  title: '', type: 'other', category: '', ou: '', tags: '', username: '',
  password: '', url: '', notes: '', server_credential_id: '',
}

// ── Password Generator ────────────────────────────────────────────────────────

const CHAR_SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}|;:,.<>?',
}

function generatePassword(len: number, useUpper: boolean, useLower: boolean, useDigits: boolean, useSymbols: boolean): string {
  let pool = ''
  const required: string[] = []
  if (useUpper)   { pool += CHAR_SETS.upper;   required.push(CHAR_SETS.upper[Math.floor(Math.random() * CHAR_SETS.upper.length)]) }
  if (useLower)   { pool += CHAR_SETS.lower;   required.push(CHAR_SETS.lower[Math.floor(Math.random() * CHAR_SETS.lower.length)]) }
  if (useDigits)  { pool += CHAR_SETS.digits;  required.push(CHAR_SETS.digits[Math.floor(Math.random() * CHAR_SETS.digits.length)]) }
  if (useSymbols) { pool += CHAR_SETS.symbols; required.push(CHAR_SETS.symbols[Math.floor(Math.random() * CHAR_SETS.symbols.length)]) }
  if (!pool) pool = CHAR_SETS.lower
  const arr = Array.from({ length: Math.max(0, len - required.length) }, () => pool[Math.floor(Math.random() * pool.length)])
  const combined = [...arr, ...required]
  for (let i = combined.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[combined[i], combined[j]] = [combined[j], combined[i]]
  }
  return combined.join('')
}

function PasswordGenerator({ onUse }: { onUse: (pw: string) => void }) {
  const [len, setLen] = useState(20)
  const [useUpper, setUseUpper] = useState(true)
  const [useLower, setUseLower] = useState(true)
  const [useDigits, setUseDigits] = useState(true)
  const [useSymbols, setUseSymbols] = useState(true)
  const [generated, setGenerated] = useState('')
  const [copied, setCopied] = useState(false)

  const generate = useCallback(() => {
    setGenerated(generatePassword(len, useUpper, useLower, useDigits, useSymbols))
    setCopied(false)
  }, [len, useUpper, useLower, useDigits, useSymbols])

  useEffect(() => { generate() }, [generate])

  const copy = () => {
    navigator.clipboard.writeText(generated)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="border border-gray-700 rounded-xl p-4 space-y-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
      <span className="text-sm font-medium text-gray-300">🎲 Password Generator</span>

      <div className="flex gap-2 items-center">
        <span className="flex-1 font-mono text-sm text-green-300 bg-gray-900 rounded-lg px-3 py-2 break-all select-all">{generated || '—'}</span>
        <button type="button" onClick={generate} title="Regenerate"
          className="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm transition-colors">↻</button>
        <button type="button" onClick={copy}
          className={`px-3 py-2 rounded-lg text-sm transition-colors ${copied ? 'bg-green-700 text-green-200' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
          {copied ? '✓' : '📋'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 shrink-0">Length</span>
        <input type="number" min={8} max={64} value={len} onChange={e => setLen(Math.min(64, Math.max(8, +e.target.value)))}
          className="w-14 shrink-0 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white text-center focus:outline-none focus:ring-1 focus:ring-indigo-500" />
        <input type="range" min={8} max={64} value={len} onChange={e => setLen(+e.target.value)}
          className="flex-1 accent-indigo-500" />
      </div>

      <div className="flex flex-wrap gap-2">
        {([['A–Z', useUpper, setUseUpper], ['a–z', useLower, setUseLower], ['0–9', useDigits, setUseDigits], ['!@#', useSymbols, setUseSymbols]] as [string, boolean, (v: boolean) => void][]).map(([label, active, setter]) => (
          <button type="button" key={label} onClick={() => setter(!active)}
            className={`px-3 py-1 rounded-full text-xs font-mono transition-colors ${active ? 'bg-indigo-700 text-indigo-100' : 'bg-gray-700 text-gray-400'}`}>
            {label}
          </button>
        ))}
      </div>

      <button type="button" onClick={() => onUse(generated)}
        className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
        Use This Password
      </button>
    </div>
  )
}

// ── Move-to-OU modal ──────────────────────────────────────────────────────────

function MoveModal({ entry, allOUs, onClose, onSave }: {
  entry: VaultEntry; allOUs: string[]
  onClose: () => void; onSave: (ou: string) => Promise<void>
}) {
  const [value, setValue] = useState(entry.ou ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => { setSaving(true); await onSave(value); setSaving(false) }

  return (
    <Modal title={`Move: ${entry.title}`} onClose={onClose}>
      <p className="text-sm text-gray-400 mb-3">Set or change the OU for this entry.</p>
      <label className="block mb-1 text-xs text-gray-500">OU</label>
      <input list="ou-move-list" value={value} onChange={e => setValue(e.target.value)}
        placeholder="e.g. IT / Production / Head Office"
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 mb-3" />
      <datalist id="ou-move-list">{allOUs.map(o => <option key={o} value={o} />)}</datalist>
      {value && <button type="button" onClick={() => setValue('')} className="text-xs text-red-400 hover:text-red-300 mb-3 block">✕ Clear OU (move to no OU)</button>}
      <div className="flex gap-3">
        <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
        <button onClick={save} disabled={saving}
          className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50">
          {saving ? 'Moving…' : 'Move'}
        </button>
      </div>
    </Modal>
  )
}

// ── OU Manager modal ──────────────────────────────────────────────────────────

type OURow = { ou: string; count: number }

type DeleteOUState = { ou: OURow; moveTo: string } | null

function OUManager({ onClose, onDone }: {
  allOUs: string[]; onClose: () => void; onDone: () => void
}) {
  const [ous, setOus] = useState<OURow[]>([])
  const [loadingOUs, setLoadingOUs] = useState(true)

  // Rename
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)

  // Delete
  const [deleteState, setDeleteState] = useState<DeleteOUState>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const loadOUs = async () => {
    setLoadingOUs(true)
    try {
      const data = await api.get<OURow[]>('/vault/ous')
      setOus(data)
    } catch {}
    setLoadingOUs(false)
  }

  useEffect(() => { loadOUs() }, [])

  const startRename = (ou: OURow) => {
    setRenaming(ou.ou)
    setRenameValue(ou.ou)
    setRenameError('')
  }

  const doRename = async () => {
    const newVal = renameValue.trim()
    if (!newVal || !renaming) return
    if (newVal === renaming) { setRenaming(null); return }
    if (ous.some(o => o.ou === newVal)) { setRenameError('An OU with that name already exists'); return }
    setRenameSaving(true)
    try {
      await api.post('/vault/ous/rename', { from: renaming, to: newVal })
      setRenaming(null)
      await loadOUs()
      onDone()
    } catch (err: unknown) {
      setRenameError((err as Error).message)
    } finally {
      setRenameSaving(false)
    }
  }

  const openDelete = (ou: OURow) => {
    setDeleteState({ ou, moveTo: '' })
    setDeleteError('')
  }

  const doDelete = async () => {
    if (!deleteState) return
    setDeleting(true)
    setDeleteError('')
    try {
      await api.post('/vault/ous/delete', {
        ou: deleteState.ou.ou,
        move_to: deleteState.moveTo || undefined,
      })
      setDeleteState(null)
      await loadOUs()
      onDone()
    } catch (err: unknown) {
      setDeleteError((err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const otherOUs = deleteState ? ous.filter(o => o.ou !== deleteState.ou.ou).map(o => o.ou) : []

  return (
    <Modal title="Manage OUs" onClose={onClose}>
      <p className="text-xs text-gray-500 mb-3">OUs are created automatically when you assign one to a vault entry. Here you can rename or delete them.</p>
      <div className="border-t border-gray-800 pt-3">
        <p className="text-xs text-gray-500 mb-2">Existing OUs</p>
        {loadingOUs && <p className="text-gray-500 text-xs py-4 text-center">Loading…</p>}
        {!loadingOUs && ous.length === 0 && (
          <p className="text-gray-600 text-xs py-4 text-center">No OUs yet. Create one above.</p>
        )}
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {ous.map(ou => (
            <div key={ou.ou} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-800">
              {renaming === ou.ou ? (
                <>
                  <input value={renameValue} onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') setRenaming(null) }}
                    className="flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    autoFocus />
                  {renameError && <span className="text-red-400 text-xs">{renameError}</span>}
                  <button onClick={doRename} disabled={renameSaving}
                    className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">
                    {renameSaving ? '…' : 'Save'}
                  </button>
                  <button onClick={() => setRenaming(null)}
                    className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-gray-300 transition-colors">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-white">{ou.ou}</span>
                  <span className="text-xs text-gray-500 shrink-0">{ou.count} {ou.count === 1 ? 'entry' : 'entries'}</span>
                  <button onClick={() => startRename(ou)}
                    className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
                    Rename
                  </button>
                  <button onClick={() => openDelete(ou)}
                    className="px-2 py-1 text-xs rounded bg-red-900/50 hover:bg-red-800 text-red-300 transition-colors">
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Delete confirmation inline */}
      {deleteState && (
        <div className="mt-4 border border-red-800/60 rounded-xl p-4 bg-red-900/10 space-y-3">
          <p className="text-sm text-red-300 font-medium">Delete OU: <strong>{deleteState.ou.ou}</strong></p>
          {deleteState.ou.count > 0 ? (
            <>
              <p className="text-xs text-gray-400">
                This OU has <strong className="text-white">{deleteState.ou.count}</strong> {deleteState.ou.count === 1 ? 'entry' : 'entries'}.
                Choose what to do with them:
              </p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input type="radio" checked={deleteState.moveTo === ''}
                    onChange={() => setDeleteState(s => s ? { ...s, moveTo: '' } : s)}
                    className="accent-indigo-500" />
                  Remove OU (entries stay, no OU assigned)
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input type="radio" checked={deleteState.moveTo !== ''}
                    onChange={() => setDeleteState(s => s ? { ...s, moveTo: otherOUs[0] ?? '' } : s)}
                    className="accent-indigo-500" />
                  Move entries to another OU
                </label>
                {deleteState.moveTo !== '' && (
                  <select value={deleteState.moveTo}
                    onChange={e => setDeleteState(s => s ? { ...s, moveTo: e.target.value } : s)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ml-5">
                    <option value="">— select target OU —</option>
                    {otherOUs.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-400">This OU is empty. It will be removed.</p>
          )}
          {deleteError && <p className="text-red-400 text-xs">{deleteError}</p>}
          <div className="flex gap-2">
            <button onClick={() => setDeleteState(null)}
              className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">
              Cancel
            </button>
            <button onClick={doDelete} disabled={deleting || (deleteState.moveTo !== '' && !deleteState.moveTo.trim())}
              className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors disabled:opacity-50">
              {deleting ? 'Deleting…' : 'Confirm Delete'}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button onClick={onClose}
          className="px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">
          Close
        </button>
      </div>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Vault() {
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // View mode
  const [groupBy, setGroupBy] = useState<'type' | 'ou' | 'category'>('type')

  // Filters
  const [filterType, setFilterType] = useState<VaultType | ''>('')
  const [filterOU, setFilterOU] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterTag, setFilterTag] = useState('')
  const [search, setSearch] = useState('')

  // Create / Edit modal
  const [showForm, setShowForm] = useState(false)
  const [editTarget, setEditTarget] = useState<VaultEntry | null>(null)
  const [form, setForm] = useState<FormState>(BLANK)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showGenerator, setShowGenerator] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<VaultEntry | null>(null)
  const [deleteError, setDeleteError] = useState('')

  // Move-OU modal
  const [moveTarget, setMoveTarget] = useState<VaultEntry | null>(null)

  // OU Manager
  const [showOUManager, setShowOUManager] = useState(false)

  // Tab: active / archived
  const [tab, setTab] = useState<'active' | 'archived'>('active')

  // Archived tab state
  const [archived, setArchived] = useState<VaultEntry[]>([])
  const [archivedLoading, setArchivedLoading] = useState(false)
  const [selectedArchived, setSelectedArchived] = useState<Set<string>>(new Set())
  const [bulkPurging, setBulkPurging] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState<VaultEntry | null>(null)
  const [purgeError, setPurgeError] = useState('')
  const [archivedSearch, setArchivedSearch] = useState('')

  // Reveal (shared between tabs)
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({})
  const [revealing, setRevealing] = useState<string | null>(null)

  // Server credentials for link picker
  const [allServers, setAllServers] = useState<Server[]>([])
  const [serverCreds, setServerCreds] = useState<(ServerCredential & { server_name?: string })[]>([])
  const [loadingCreds, setLoadingCreds] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await api.get<VaultEntry[]>('/vault?limit=1000')
      setEntries(data)
    } catch {
      setError('Failed to load vault')
    } finally {
      setLoading(false)
    }
  }

  const loadArchived = async () => {
    setArchivedLoading(true)
    try {
      const data = await api.get<VaultEntry[]>('/vault?limit=1000&archived=true')
      setArchived(data)
    } catch {}
    setArchivedLoading(false)
  }

  useEffect(() => { if (tab === 'archived') loadArchived() }, [tab])

  const loadServerCreds = async () => {
    setLoadingCreds(true)
    try {
      const servers = await api.get<Server[]>('/servers')
      setAllServers(servers)
      const credLists = await Promise.all(
        servers.map(async (s) => {
          try {
            const creds = await api.get<ServerCredential[]>(`/servers/${s.id}/credentials`)
            return creds.filter(c => !c.is_archived).map(c => ({ ...c, server_name: s.name }))
          } catch { return [] }
        })
      )
      setServerCreds(credLists.flat())
    } catch {}
    setLoadingCreds(false)
  }

  useEffect(() => { load() }, [])

  // Derive the "current OU context" — used to auto-fill OU on new entries
  const contextOU = useMemo(() => {
    if (filterOU) return filterOU
    return ''
  }, [filterOU])

  const openCreate = (presetOU?: string) => {
    setEditTarget(null)
    setForm({ ...BLANK, ou: presetOU ?? contextOU })
    setFormError('')
    setShowGenerator(false)
    setShowPassword(false)
    if (allServers.length === 0) loadServerCreds()
    setShowForm(true)
  }

  const openEdit = (e: VaultEntry) => {
    setEditTarget(e)
    setForm({
      title: e.title, type: e.type,
      category: e.category ?? '', ou: e.ou ?? '',
      tags: e.tags?.join(', ') ?? '', username: e.username ?? '',
      password: '', url: e.url ?? '', notes: e.notes ?? '',
      server_credential_id: e.server_credential_id ?? '',
    })
    setFormError('')
    setShowGenerator(false)
    setShowPassword(false)
    if (allServers.length === 0) loadServerCreds()
    setShowForm(true)
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    setSaving(true)
    try {
      const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean)
      const payload = {
        title: form.title, type: form.type,
        category: form.category || undefined, ou: form.ou || undefined,
        tags, username: form.username || undefined, password: form.password || undefined,
        url: form.url || undefined, notes: form.notes || undefined,
        server_credential_id: form.server_credential_id || undefined,
      }
      if (editTarget) {
        await api.patch(`/vault/${editTarget.id}`, payload)
      } else {
        await api.post('/vault', payload)
      }
      setShowForm(false)
      load()
    } catch (err: unknown) {
      setFormError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const deleteEntry = async () => {
    if (!deleteTarget) return
    setDeleteError('')
    try {
      await api.delete(`/vault/${deleteTarget.id}`)
      setDeleteTarget(null)
      load()
    } catch (err: unknown) {
      setDeleteError((err as Error).message)
    }
  }

  const moveEntry = async (ou: string) => {
    if (!moveTarget) return
    await api.patch(`/vault/${moveTarget.id}`, { ou: ou || undefined })
    setMoveTarget(null)
    load()
  }

  const reveal = async (id: string) => {
    if (revealedPasswords[id]) {
      setRevealedPasswords(p => { const n = { ...p }; delete n[id]; return n })
      return
    }
    setRevealing(id)
    try {
      const { password } = await api.post<{ password: string }>(`/vault/${id}/reveal`)
      setRevealedPasswords(p => ({ ...p, [id]: password }))
    } catch (err: unknown) {
      alert((err as Error).message)
    } finally {
      setRevealing(null)
    }
  }

  const duplicateEntry = async (e: VaultEntry) => {
    try {
      await api.post('/vault', {
        title: `Copy of ${e.title}`,
        type: e.type,
        category: e.category ?? undefined,
        ou: e.ou ?? undefined,
        tags: e.tags ?? [],
        username: e.username ?? undefined,
        url: e.url ?? undefined,
        notes: e.notes ?? undefined,
        // password and server_credential_id intentionally not copied
      })
      load()
    } catch (err: unknown) {
      alert((err as Error).message)
    }
  }

  const pullFromCredential = async (id: string) => {
    try {
      await api.post(`/vault/${id}/pull-from-credential`)
      load()
    } catch (err: unknown) {
      alert((err as Error).message)
    }
  }

  const copyPassword = async (id: string) => {
    try {
      const { password } = await api.post<{ password: string }>(`/vault/${id}/reveal`)
      await navigator.clipboard.writeText(password)
    } catch (err: unknown) {
      alert((err as Error).message)
    }
  }

  const restoreEntry = async (id: string) => {
    try {
      await api.post(`/vault/${id}/restore`)
      loadArchived()
      load()
    } catch (err: unknown) {
      alert((err as Error).message)
    }
  }

  const purgeEntry = async () => {
    if (!purgeTarget) return
    setPurgeError('')
    try {
      await api.delete(`/vault/${purgeTarget.id}/purge`)
      setPurgeTarget(null)
      setSelectedArchived(s => { const n = new Set(s); n.delete(purgeTarget.id); return n })
      loadArchived()
    } catch (err: unknown) {
      setPurgeError((err as Error).message)
    }
  }

  const bulkPurge = async () => {
    if (selectedArchived.size === 0) return
    setBulkPurging(true)
    try {
      await api.post('/vault/purge-bulk', { ids: [...selectedArchived] })
      setSelectedArchived(new Set())
      loadArchived()
    } catch (err: unknown) {
      alert((err as Error).message)
    } finally {
      setBulkPurging(false)
    }
  }

  const toggleSelectArchived = (id: string) =>
    setSelectedArchived(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const toggleAllArchived = (items: VaultEntry[]) =>
    setSelectedArchived(s => s.size === items.length ? new Set() : new Set(items.map(e => e.id)))

  // Derived values
  const allOUs = useMemo(() => [...new Set(entries.map(e => e.ou).filter(Boolean) as string[])].sort(), [entries])
  const categories = useMemo(() => [...new Set(entries.map(e => e.category).filter(Boolean) as string[])].sort(), [entries])
  const tags = useMemo(() => [...new Set(entries.flatMap(e => e.tags ?? []))].sort(), [entries])

  const filtered = useMemo(() => entries.filter(e => {
    if (filterType && e.type !== filterType) return false
    if (filterOU && e.ou !== filterOU) return false
    if (filterCategory && e.category !== filterCategory) return false
    if (filterTag && !e.tags?.includes(filterTag)) return false
    if (search) {
      const s = search.toLowerCase()
      if (!(e.title.toLowerCase().includes(s) || e.username?.toLowerCase().includes(s) ||
            e.notes?.toLowerCase().includes(s) || e.category?.toLowerCase().includes(s) ||
            e.ou?.toLowerCase().includes(s))) return false
    }
    return true
  }), [entries, filterType, filterOU, filterCategory, filterTag, search])

  const grouped = useMemo(() => {
    const map: Record<string, VaultEntry[]> = {}
    for (const e of filtered) {
      const key = groupBy === 'type'
        ? (TYPE_LABELS[e.type] ?? e.type)
        : groupBy === 'ou'
          ? (e.ou ?? '(No OU)')
          : (e.category ?? '(No Category)')
      if (!map[key]) map[key] = []
      map[key].push(e)
    }
    return map
  }, [filtered, groupBy])

  const groupKeys = useMemo(() => {
    if (groupBy === 'type') return ALL_TYPES.map(t => TYPE_LABELS[t]).filter(k => grouped[k]?.length)
    return Object.keys(grouped).sort((a, b) => {
      // Always put "(No OU)" / "(No Category)" last
      if (a.startsWith('(')) return 1
      if (b.startsWith('(')) return -1
      return a.localeCompare(b)
    })
  }, [grouped, groupBy])

  // For "add in this group" button — extract the OU value from a group key when groupBy==='ou'
  const ouFromGroupKey = (key: string) => {
    if (groupBy !== 'ou') return contextOU
    if (key === '(No OU)') return ''
    return key
  }

  const renderTable = (items: VaultEntry[], groupKey: string) => (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <table className="w-full text-xs" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
        <colgroup>
          <col style={{ width: '20%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '13%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '30%' }} />
        </colgroup>
        <thead className="bg-gray-800/50">
          <tr className="text-left text-gray-500 uppercase tracking-wide font-medium">
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">OU</th>
            <th className="px-3 py-2">Username</th>
            <th className="px-3 py-2">Password</th>
            <th className="px-3 py-2">Linked Server</th>
            <th className="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {items.map(e => (
            <tr key={e.id} className="hover:bg-gray-800/30">
              <td className="px-3 py-2" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <div className="text-white font-medium truncate">{e.title}</div>
                {e.tags && e.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {e.tags.map(t => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-xs bg-indigo-900/50 text-indigo-300 leading-none">{t}</span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-gray-400" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.ou ?? <span className="text-gray-600">—</span>}
              </td>
              <td className="px-3 py-2 font-mono text-indigo-300" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.username ?? <span className="text-gray-600">—</span>}
              </td>
              <td className="px-3 py-2">
                {revealedPasswords[e.id]
                  ? <span className="font-mono text-green-300 break-all select-all">{revealedPasswords[e.id]}</span>
                  : <span className="text-gray-600 font-mono">••••••••</span>}
              </td>
              <td className="px-3 py-2 text-gray-400" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.linked_server_name
                  ? <span><span className="text-blue-400">{e.linked_server_name}</span><span className="text-gray-500"> / {e.linked_credential_label}</span></span>
                  : <span className="text-gray-600">—</span>}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  <button onClick={() => reveal(e.id)} disabled={revealing === e.id}
                    className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50"
                    title={revealedPasswords[e.id] ? 'Hide' : 'Reveal'}>
                    {revealing === e.id ? '…' : revealedPasswords[e.id] ? '🙈' : '🔍'}
                  </button>
                  {revealedPasswords[e.id] && (
                    <button onClick={() => navigator.clipboard.writeText(revealedPasswords[e.id])}
                      className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors" title="Copy">
                      📋
                    </button>
                  )}
                  <button onClick={() => openEdit(e)}
                    className="px-2 py-1 text-xs rounded bg-indigo-900/60 hover:bg-indigo-800 text-indigo-300 transition-colors">
                    Edit
                  </button>
                  <button onClick={() => duplicateEntry(e)} title="Duplicate entry"
                    className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
                    ⧉
                  </button>
                  <button onClick={() => setMoveTarget(e)}
                    className="px-2 py-1 text-xs rounded bg-yellow-900/50 hover:bg-yellow-800 text-yellow-300 transition-colors" title="Move to OU">
                    Move
                  </button>
                  {e.server_credential_id && (
                    <button onClick={() => pullFromCredential(e.id)} title="Pull from linked credential"
                      className="px-2 py-1 text-xs rounded bg-blue-900/60 hover:bg-blue-800 text-blue-300 transition-colors">
                      ↓ Sync
                    </button>
                  )}
                  <button onClick={() => setDeleteTarget(e)}
                    className="px-2 py-1 text-xs rounded bg-red-900/50 hover:bg-red-800 text-red-300 transition-colors">
                    Del
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Per-group "add entry here" button — auto-fills the group's OU */}
      <div className="border-t border-gray-800 px-3 py-2">
        <button onClick={() => openCreate(ouFromGroupKey(groupKey))}
          className="text-xs text-gray-500 hover:text-indigo-400 transition-colors">
          + Add entry {ouFromGroupKey(groupKey) ? `in "${ouFromGroupKey(groupKey)}"` : 'here'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">🔐 Vault Manager</h1>
        <div className="flex gap-2 flex-wrap">
          {tab === 'active' && (
            <>
              {/* Group by */}
              <div className="flex text-xs">
                {(['type', 'ou', 'category'] as const).map((g, i, arr) => (
                  <button key={g} onClick={() => setGroupBy(g)}
                    className={[
                      'px-3 py-2 border-y border-r transition-colors',
                      i === 0 ? 'border-l rounded-l-lg' : '',
                      i === arr.length - 1 ? 'rounded-r-lg' : '',
                      'border-gray-300 dark:border-gray-700',
                      groupBy === g
                        ? 'bg-indigo-600 text-white border-indigo-600 dark:border-indigo-600'
                        : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700',
                    ].join(' ')}>
                    {g === 'ou' ? 'OU' : g === 'type' ? 'Type' : 'Category'}
                  </button>
                ))}
              </div>
              <button onClick={() => setShowOUManager(true)}
                className="px-3 py-2 text-sm rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors">
                🗂 Manage OUs
              </button>
              <button onClick={() => openCreate()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors">
                + New Entry
              </button>
            </>
          )}
          {/* Tab switcher */}
          <div className="flex text-xs">
            <button onClick={() => setTab('active')}
              className={[
                'px-3 py-2 border-y border-l border-r rounded-l-lg transition-colors border-gray-300 dark:border-gray-700',
                tab === 'active'
                  ? 'bg-indigo-600 text-white border-indigo-600 dark:border-indigo-600'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700',
              ].join(' ')}>
              Active
            </button>
            <button onClick={() => setTab('archived')}
              className={[
                'px-3 py-2 border-y border-r rounded-r-lg transition-colors border-gray-300 dark:border-gray-700',
                tab === 'archived'
                  ? 'bg-yellow-600 text-white border-yellow-600 dark:border-yellow-600'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700',
              ].join(' ')}>
              🗑 Archived {archived.length > 0 && <span className="ml-1 bg-yellow-500 text-white rounded-full px-1.5 text-xs">{archived.length}</span>}
            </button>
          </div>
        </div>
      </div>

      {/* Filters — active tab only */}
      {tab === 'active' && <div className="flex flex-wrap gap-2 items-center">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48" />

        <select value={filterType} onChange={e => setFilterType(e.target.value as VaultType | '')}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">All types</option>
          {ALL_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>

        {allOUs.length > 0 && (
          <select value={filterOU} onChange={e => setFilterOU(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">All OUs</option>
            {allOUs.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )}

        {categories.length > 0 && (
          <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}

        {tags.length > 0 && (
          <select value={filterTag} onChange={e => setFilterTag(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">All tags</option>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}

        {(filterType || filterOU || filterCategory || filterTag || search) && (
          <button onClick={() => { setFilterType(''); setFilterOU(''); setFilterCategory(''); setFilterTag(''); setSearch('') }}
            className="px-3 py-1.5 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
            Clear
          </button>
        )}

        {filterOU && (
          <span className="text-xs bg-indigo-900/40 text-indigo-300 border border-indigo-800/50 rounded-full px-3 py-1">
            OU: {filterOU}
          </span>
        )}

        <span className="text-xs text-gray-500 ml-auto">{filtered.length} / {entries.length} entries</span>
      </div>}

      {tab === 'active' && (
        <>
          {loading && <p className="text-gray-400 text-sm">Loading…</p>}
          {error && <p className="text-red-400 text-sm">{error}</p>}

          {!loading && groupKeys.length === 0 && (
            <div className="text-center py-16 text-gray-500">
              <div className="text-5xl mb-3">🔐</div>
              <p className="text-lg">No vault entries yet.</p>
              <p className="text-sm mt-1">Click <strong className="text-gray-300">+ New Entry</strong> to add your first credential.</p>
            </div>
          )}

          {!loading && groupKeys.map(key => (
            <div key={key} className="space-y-1">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide px-1 mt-2 flex items-center gap-2">
                {key}
                <span className="text-gray-600 font-normal normal-case tracking-normal">({grouped[key].length})</span>
              </h2>
              {renderTable(grouped[key], key)}
            </div>
          ))}
        </>
      )}

      {tab === 'archived' && (() => {
        const archivedFiltered = archived.filter(e => {
          if (!archivedSearch) return true
          const s = archivedSearch.toLowerCase()
          return e.title.toLowerCase().includes(s) || e.username?.toLowerCase().includes(s) || e.ou?.toLowerCase().includes(s)
        })
        const allSelected = archivedFiltered.length > 0 && archivedFiltered.every(e => selectedArchived.has(e.id))
        return (
          <>
            <div className="flex flex-wrap gap-2 items-center">
              <input value={archivedSearch} onChange={e => setArchivedSearch(e.target.value)} placeholder="Search archived…"
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48" />
              {selectedArchived.size > 0 && (
                <button onClick={bulkPurge} disabled={bulkPurging}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium transition-colors disabled:opacity-50">
                  {bulkPurging ? 'Deleting…' : `🗑 Clean ${selectedArchived.size} selected`}
                </button>
              )}
              <span className="text-xs text-gray-500 ml-auto">{archivedFiltered.length} archived entries</span>
            </div>

            {archivedLoading && <p className="text-gray-400 text-sm">Loading…</p>}
            {!archivedLoading && archivedFiltered.length === 0 && (
              <div className="text-center py-16 text-gray-500">
                <div className="text-4xl mb-3">🗑</div>
                <p>No archived entries.</p>
              </div>
            )}
            {!archivedLoading && archivedFiltered.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-xs" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                  <colgroup>
                    <col style={{ width: '3%' }} />
                    <col style={{ width: '20%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '36%' }} />
                  </colgroup>
                  <thead className="bg-gray-800/50">
                    <tr className="text-left text-gray-500 uppercase tracking-wide font-medium">
                      <th className="px-3 py-2">
                        <input type="checkbox" checked={allSelected}
                          onChange={() => toggleAllArchived(archivedFiltered)}
                          className="accent-indigo-500" />
                      </th>
                      <th className="px-3 py-2">Title</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">OU</th>
                      <th className="px-3 py-2">Username</th>
                      <th className="px-3 py-2">Archived</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {archivedFiltered.map(e => (
                      <tr key={e.id} className={`hover:bg-gray-800/30 ${selectedArchived.has(e.id) ? 'bg-yellow-900/10' : ''}`}>
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={selectedArchived.has(e.id)}
                            onChange={() => toggleSelectArchived(e.id)}
                            className="accent-indigo-500" />
                        </td>
                        <td className="px-3 py-2 text-gray-400" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <span className="line-through opacity-60">{e.title}</span>
                        </td>
                        <td className="px-3 py-2 text-gray-500" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {TYPE_LABELS[e.type] ?? e.type}
                        </td>
                        <td className="px-3 py-2 text-gray-500" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.ou ?? '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-500" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.username ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-600 text-xs">
                          {e.archived_at ? new Date(e.archived_at).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button onClick={() => restoreEntry(e.id)}
                              className="px-2 py-1 text-xs rounded bg-green-900/60 hover:bg-green-800 text-green-300 transition-colors">
                              ↩ Restore
                            </button>
                            <button onClick={() => reveal(e.id)} disabled={revealing === e.id}
                              className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50"
                              title={revealedPasswords[e.id] ? 'Hide' : 'Reveal password'}>
                              {revealing === e.id ? '…' : revealedPasswords[e.id] ? '🙈' : '🔍'}
                            </button>
                            {revealedPasswords[e.id] && (
                              <span className="font-mono text-green-300 text-xs px-2 py-1 bg-gray-900 rounded select-all max-w-[120px] truncate">{revealedPasswords[e.id]}</span>
                            )}
                            <button onClick={() => copyPassword(e.id)} title="Copy password to clipboard (without revealing)"
                              className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
                              📋 Copy
                            </button>
                            <button onClick={() => { setPurgeTarget(e); setPurgeError('') }}
                              className="px-2 py-1 text-xs rounded bg-red-900/50 hover:bg-red-800 text-red-300 transition-colors">
                              🗑 Clean
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Purge confirm modal */}
            {purgeTarget && (
              <Modal title="Permanently Delete" onClose={() => setPurgeTarget(null)}>
                <p className="text-sm text-gray-300 mb-2">
                  Permanently delete <strong className="text-white">{purgeTarget.title}</strong>?
                </p>
                <p className="text-xs text-red-400 mb-4">This cannot be undone. The entry and its password will be gone forever.</p>
                {purgeError && <p className="text-red-400 text-sm mb-3">{purgeError}</p>}
                <div className="flex gap-3">
                  <button onClick={() => setPurgeTarget(null)}
                    className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
                  <button onClick={purgeEntry}
                    className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors">Delete Forever</button>
                </div>
              </Modal>
            )}
          </>
        )
      })()}

      {/* ── Create / Edit modal ── */}
      {showForm && (
        <Modal title={editTarget ? `Edit: ${editTarget.title}` : 'New Vault Entry'} onClose={() => setShowForm(false)}>
          <form onSubmit={save} className="space-y-3">
            {formError && <p className="text-red-400 text-sm">{formError}</p>}

            <label className="block">
              <span className="text-sm text-gray-400">Title *</span>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-gray-400">Type</span>
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as VaultType }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {ALL_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-gray-400">Category</span>
                <input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  placeholder="e.g. Production, Office"
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </label>
            </div>

            <label className="block">
              <span className="text-sm text-gray-400">OU / Organisational Unit</span>
              <input list="ou-form-list" value={form.ou} onChange={e => setForm(f => ({ ...f, ou: e.target.value }))}
                placeholder="e.g. IT / Head Office / Branch A"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <datalist id="ou-form-list">{allOUs.map(o => <option key={o} value={o} />)}</datalist>
              {form.ou && <p className="text-xs text-indigo-400 mt-1">📂 Will be placed in "{form.ou}"</p>}
            </label>

            <label className="block">
              <span className="text-sm text-gray-400">Tags <span className="text-gray-500">(comma-separated)</span></span>
              <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                placeholder="e.g. linux, admin, backup"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-gray-400">Username</span>
                <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </label>
              <div>
                <span className="text-sm text-gray-400">
                  Password {editTarget && <span className="text-gray-500">(blank = keep)</span>}
                </span>
                <div className="mt-1 flex gap-1">
                  <input type={showPassword ? 'text' : 'password'} value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <button type="button" onClick={() => setShowPassword(p => !p)}
                    className="px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm transition-colors">
                    {showPassword ? '🙈' : '👁'}
                  </button>
                  <button type="button" onClick={() => setShowGenerator(g => !g)}
                    className={`px-2 py-1 rounded-lg text-sm transition-colors ${showGenerator ? 'bg-indigo-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
                    🎲
                  </button>
                </div>
              </div>
            </div>

            {showGenerator && (
              <PasswordGenerator onUse={(pw) => { setForm(f => ({ ...f, password: pw })); setShowPassword(true); setShowGenerator(false) }} />
            )}

            <label className="block">
              <span className="text-sm text-gray-400">URL / Host</span>
              <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
                placeholder="https://… or 192.168.x.x"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>

            <label className="block">
              <span className="text-sm text-gray-400">Link to Server Credential <span className="text-gray-500">(bidirectional sync)</span></span>
              <select value={form.server_credential_id} onChange={e => setForm(f => ({ ...f, server_credential_id: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="">— None —</option>
                {loadingCreds && <option disabled>Loading…</option>}
                {serverCreds.map(c => (
                  <option key={c.id} value={c.id}>{c.server_name} › {c.label}{c.linux_user ? ` (${c.linux_user})` : ''}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm text-gray-400">Notes</span>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
            </label>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowForm(false)}
                className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" disabled={saving}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50">
                {saving ? 'Saving…' : editTarget ? 'Save Changes' : 'Create Entry'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Delete modal ── */}
      {deleteTarget && (
        <Modal title="Delete Vault Entry" onClose={() => setDeleteTarget(null)}>
          <p className="text-sm text-gray-300 mb-4">
            Delete <strong className="text-white">{deleteTarget.title}</strong>? This cannot be undone.
          </p>
          {deleteError && <p className="text-red-400 text-sm mb-3">{deleteError}</p>}
          <div className="flex gap-3">
            <button onClick={() => setDeleteTarget(null)}
              className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
            <button onClick={deleteEntry}
              className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors">Delete</button>
          </div>
        </Modal>
      )}

      {/* ── Move-to-OU modal ── */}
      {moveTarget && (
        <MoveModal entry={moveTarget} allOUs={allOUs} onClose={() => setMoveTarget(null)} onSave={moveEntry} />
      )}

      {/* ── OU Manager modal ── */}
      {showOUManager && (
        <OUManager allOUs={allOUs} onClose={() => setShowOUManager(false)} onDone={load} />
      )}
    </div>
  )
}
