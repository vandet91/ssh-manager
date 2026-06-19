import { useEffect, useRef, useState } from 'react'
import { api, SshKey, ArchivedKey, Assignment, Server, User } from '../api/client'
import Modal from '../components/Modal'
import Badge from '../components/Badge'

export default function Keys() {
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [downloadDropOpen, setDownloadDropOpen] = useState<string | null>(null) // key id
  const [keys, setKeys] = useState<SshKey[]>([])
  const [archivedKeys, setArchivedKeys] = useState<ArchivedKey[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [showGenerate, setShowGenerate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [genForm, setGenForm] = useState({ name: '', key_type: 'ed25519', rotation_policy: 'manual', description: '' })
  const [importForm, setImportForm] = useState({ name: '', private_key: '', passphrase: '', rotation_policy: 'manual' })
  const [importFileName, setImportFileName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [rotating, setRotating] = useState<string | null>(null)
  const [rotateResult, setRotateResult] = useState<{ keyId: string; status: string; message: string } | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)

  const [editKey, setEditKey] = useState<SshKey | null>(null)
  const [editForm, setEditForm] = useState({ name: '', description: '', rotation_policy: 'manual' })
  const [editError, setEditError] = useState('')

  type OrphanRow = { key_id: string; key_name: string; server_id: string; linux_user: string; server_name: string | null; server_active: boolean | null }
  const [orphans, setOrphans] = useState<OrphanRow[]>([])
  const [cleaningOrphans, setCleaningOrphans] = useState(false)
  const [orphanConfirm, setOrphanConfirm] = useState(false)
  const [orphanResult, setOrphanResult] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SshKey | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [revertTarget, setRevertTarget] = useState<ArchivedKey | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<ArchivedKey | null>(null)
  const [archiveActionError, setArchiveActionError] = useState('')
  const [selectedActive, setSelectedActive] = useState<Set<string>>(new Set())
  const [selectedArchived, setSelectedArchived] = useState<Set<string>>(new Set())
  const [bulkDeleteError, setBulkDeleteError] = useState('')
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [showBulkActiveConfirm, setShowBulkActiveConfirm] = useState(false)
  const [showBulkArchivedConfirm, setShowBulkArchivedConfirm] = useState(false)

  const load = () => {
    api.get<SshKey[]>('/keys').then(setKeys).catch(() => {})
    api.get<ArchivedKey[]>('/keys/archived').then(setArchivedKeys).catch(() => {})
    api.get<{ data: Assignment[] } | Assignment[]>('/assignments?limit=1000').then((r) => setAssignments(Array.isArray(r) ? r : (r as { data: Assignment[] }).data ?? [])).catch(() => {})
    api.get<Server[]>('/servers').then(setServers).catch(() => {})
    api.get<OrphanRow[]>('/keys/orphaned-assignments').then(setOrphans).catch(() => {})
  }
  useEffect(() => {
    load()
    api.get<User>('/auth/me').then(setCurrentUser).catch(() => {})
  }, [])

  const cleanupOrphans = async () => {
    setCleaningOrphans(true)
    setOrphanResult('')
    try {
      const r = await api.post<{ cleaned: number }>('/keys/cleanup-orphans')
      setOrphanResult(`Cleaned up ${r.cleaned} orphaned assignment(s).`)
      setOrphanConfirm(false)
      load()
    } catch (err: unknown) { setOrphanResult((err as Error).message) }
    finally { setCleaningOrphans(false) }
  }

  useEffect(() => {
    if (!downloadDropOpen) return
    const close = () => setDownloadDropOpen(null)
    document.addEventListener('click', close, { capture: true, once: true })
    return () => document.removeEventListener('click', close, { capture: true })
  }, [downloadDropOpen])

  const generateKey = async (e: React.FormEvent) => {
    e.preventDefault(); setError('')
    try { await api.post('/keys/generate', genForm); setShowGenerate(false); load() }
    catch (err: unknown) { setError((err as Error).message) }
  }

  const importKey = async (e: React.FormEvent) => {
    e.preventDefault(); setError('')
    try { await api.post('/keys/import', importForm); setShowImport(false); load() }
    catch (err: unknown) { setError((err as Error).message) }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const name = file.name.replace(/\.(ppk|pem|key)$/i, '')
      setImportForm((f) => ({ ...f, name: f.name || name, private_key: ev.target?.result as string }))
    }
    reader.readAsText(file)
  }

  const rotateKey = async (id: string) => {
    setRotating(id)
    setRotateResult(null)
    try {
      const result = await api.post<{ status: string; affected_servers: Array<{ server_id: string; linux_user: string; status: string; error?: string }> }>(`/keys/${id}/rotate`)
      const failed = result.affected_servers?.filter((s) => s.status === 'failed') ?? []
      if (result.status === 'success') {
        setRotateResult({ keyId: id, status: 'success', message: `Rotation succeeded across ${result.affected_servers?.length ?? 0} server(s).` })
      } else {
        setRotateResult({ keyId: id, status: 'rolled_back', message: `Rotation failed on ${failed.length} server(s) and was rolled back. Errors: ${failed.map((s) => s.error).join('; ')}` })
      }
    } catch (err: unknown) {
      setRotateResult({ keyId: id, status: 'error', message: (err as Error).message })
    } finally {
      setRotating(null); load()
    }
  }

  const openEdit = (k: SshKey) => {
    setEditKey(k)
    setEditForm({ name: k.name, description: k.description ?? '', rotation_policy: k.rotation_policy })
    setEditError('')
  }

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault(); setEditError('')
    try {
      await api.patch(`/keys/${editKey!.id}`, editForm)
      setEditKey(null)
      load()
    } catch (err: unknown) { setEditError((err as Error).message) }
  }

  const deleteKey = async () => {
    if (!deleteTarget) return
    setDeleteError('')
    try {
      await api.delete(`/keys/${deleteTarget.id}`)
      setDeleteTarget(null)
      load()
    } catch (err: unknown) {
      const e = err as Error & { data?: { error?: string } }
      setDeleteError(e.data?.error ?? e.message)
    }
  }

  const bulkDeleteActive = async () => {
    setBulkDeleting(true)
    setBulkDeleteError('')
    const errors: string[] = []
    for (const id of selectedActive) {
      try { await api.delete(`/keys/${id}`) }
      catch (err: unknown) {
        const e = err as Error & { data?: { error?: string } }
        const k = keys.find(k => k.id === id)
        errors.push(`${k?.name ?? id}: ${e.data?.error ?? e.message}`)
      }
    }
    setBulkDeleting(false)
    setShowBulkActiveConfirm(false)
    setSelectedActive(new Set())
    if (errors.length) setBulkDeleteError(errors.join(' | '))
    load()
  }

  const bulkPurgeArchived = async () => {
    setBulkDeleting(true)
    setBulkDeleteError('')
    const errors: string[] = []
    for (const id of selectedArchived) {
      try { await api.delete(`/keys/archived/${id}`) }
      catch (err: unknown) {
        const e = err as Error & { data?: { error?: string } }
        const k = archivedKeys.find(k => k.id === id)
        errors.push(`${k?.name ?? id}: ${e.data?.error ?? e.message}`)
      }
    }
    setBulkDeleting(false)
    setShowBulkArchivedConfirm(false)
    setSelectedArchived(new Set())
    if (errors.length) setBulkDeleteError(errors.join(' | '))
    load()
  }

  const toggleActive = (id: string) => setSelectedActive(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  const toggleArchived = (id: string) => setSelectedArchived(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  const toggleAllActive = () => setSelectedActive(prev => prev.size === keys.length ? new Set() : new Set(keys.map(k => k.id)))
  const toggleAllArchived = () => setSelectedArchived(prev => prev.size === archivedKeys.length ? new Set() : new Set(archivedKeys.map(k => k.id)))

  const revertKey = async (k: ArchivedKey) => {
    setArchiveActionError('')
    setReverting(k.id)
    try {
      await api.post(`/keys/${k.id}/revert`)
      setRevertTarget(null)
      load()
      setTab('active')
    } catch (err: unknown) {
      setArchiveActionError((err as Error).message)
    } finally {
      setReverting(null)
    }
  }

  const purgeKey = async (k: ArchivedKey) => {
    setArchiveActionError('')
    try {
      await api.delete(`/keys/archived/${k.id}`)
      setPurgeTarget(null)
      load()
    } catch (err: unknown) { setArchiveActionError((err as Error).message) }
  }

  const isPpk = importForm.private_key.trimStart().startsWith('PuTTY-User-Key-File-')

  const reasonBadge = (r: ArchivedKey['archive_reason']) => {
    if (r === 'rotated') return <Badge label="Rotated" variant="low" />
    if (r === 'reverted') return <Badge label="Reverted" variant="medium" />
    return <Badge label="Deleted" variant="high" />
  }

  const daysUntilPurge = (purge_after: string) => {
    const days = Math.ceil((new Date(purge_after).getTime() - Date.now()) / 86400000)
    return days <= 0 ? 'overdue' : `${days}d`
  }

  return (
    <div className="p-6 space-y-4">
      {(orphans.length > 0 || orphanResult) && (
        <div className="bg-yellow-900/40 border border-yellow-700 rounded-xl px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-yellow-300 font-medium text-sm">⚠ Orphaned key assignments detected</p>
              <p className="text-yellow-400/80 text-xs mt-0.5">
                {orphans.length} assignment(s) still marked active but point to deleted servers:&nbsp;
                {[...new Set(orphans.map(o => o.key_name))].join(', ')}
              </p>
            </div>
            {!orphanConfirm && (
              <button onClick={() => { setOrphanConfirm(true); setOrphanResult('') }}
                className="shrink-0 px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 text-white rounded-lg text-xs font-medium transition-colors">
                Clean up
              </button>
            )}
          </div>
          {orphanConfirm && (
            <div className="flex items-center gap-3 pt-1 border-t border-yellow-700/50">
              <p className="text-yellow-300 text-xs flex-1">Remove all {orphans.length} orphaned assignment(s)? This cannot be undone.</p>
              <button onClick={() => setOrphanConfirm(false)} className="px-3 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
              <button onClick={cleanupOrphans} disabled={cleaningOrphans}
                className="px-3 py-1 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-medium transition-colors">
                {cleaningOrphans ? 'Cleaning…' : 'Yes, clean up'}
              </button>
            </div>
          )}
          {orphanResult && <p className="text-green-400 text-xs pt-1 border-t border-yellow-700/50">{orphanResult}</p>}
        </div>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">SSH Keys</h1>
        <div className="flex gap-2">
          {tab === 'active' && <>
            <button onClick={() => setShowImport(true)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors">
              Import Key
            </button>
            <button onClick={() => setShowGenerate(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors">
              + Generate
            </button>
          </>}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-700">
        {(['active', 'archived'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${tab === t ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-400 hover:text-gray-300'}`}>
            {t === 'active' ? `Active (${keys.length})` : `Archived (${archivedKeys.length})`}
          </button>
        ))}
      </div>

      {/* ── Archived Keys Tab ─────────────────────────────────────────── */}
      {tab === 'archived' && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Archived keys are kept for <span className="text-gray-300 font-medium">30 days</span> then permanently deleted.
            Rotated keys can be reverted if the new key causes issues.
          </p>
          {archivedKeys.length === 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-5 text-center text-gray-500">No archived keys.</div>
          )}
          {archivedKeys.length > 0 && (
            <>
            {selectedArchived.size > 0 && (
              <div className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 mb-2">
                <span className="text-gray-300 text-sm">{selectedArchived.size} selected</span>
                <button onClick={() => { setBulkDeleteError(''); setShowBulkArchivedConfirm(true) }}
                  className="px-3 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors">
                  Delete Now Selected
                </button>
                <button onClick={() => setSelectedArchived(new Set())} className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">
                  Clear
                </button>
                {bulkDeleteError && <span className="text-red-400 text-xs flex-1">{bulkDeleteError}</span>}
              </div>
            )}
            <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
              <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 800 }}>
                <colgroup>
                  <col style={{ width: '3%'  }} />  {/* Checkbox */}
                  <col style={{ width: '18%' }} />  {/* Name */}
                  <col style={{ width: '7%'  }} />  {/* Type */}
                  <col style={{ width: '16%' }} />  {/* Fingerprint */}
                  <col style={{ width: '8%'  }} />  {/* Reason */}
                  <col style={{ width: '9%'  }} />  {/* Created */}
                  <col style={{ width: '9%'  }} />  {/* Archived */}
                  <col style={{ width: '9%'  }} />  {/* Auto-purge in */}
                  <col style={{ width: '21%' }} />  {/* Actions */}
                </colgroup>
                <thead className="bg-gray-800/50">
                  <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
                    <th className="px-3 py-2">
                      <input type="checkbox" checked={archivedKeys.length > 0 && selectedArchived.size === archivedKeys.length}
                        onChange={toggleAllArchived} className="accent-indigo-500 cursor-pointer" />
                    </th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Fingerprint</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Archived</th>
                    <th className="px-3 py-2">Auto-purge in</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {archivedKeys.map((k) => (
                    <tr key={k.id} className={`hover:bg-gray-800/30 ${selectedArchived.has(k.id) ? 'bg-indigo-950/30' : ''}`}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selectedArchived.has(k.id)} onChange={() => toggleArchived(k.id)} className="accent-indigo-500 cursor-pointer" />
                      </td>
                      <td className="px-3 py-2 text-white font-medium">
                        {k.name}
                        {k.description && <p className="text-xs text-gray-500 font-normal">{k.description}</p>}
                        {k.predecessor_key_id && <p className="text-xs text-gray-600">← replaced previous key</p>}
                      </td>
                      <td className="px-3 py-2"><Badge label={k.key_type} /></td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-400" style={{ wordBreak: 'break-all' }}>{k.fingerprint.slice(0, 28)}…</td>
                      <td className="px-3 py-2">{reasonBadge(k.archive_reason)}</td>
                      <td className="px-3 py-2 text-gray-400 text-xs">{new Date(k.created_at).toLocaleDateString()}</td>
                      <td className="px-3 py-2 text-gray-400 text-xs">{new Date(k.archived_at).toLocaleDateString()}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs font-mono ${daysUntilPurge(k.purge_after) === 'overdue' ? 'text-red-400' : Number(daysUntilPurge(k.purge_after).replace('d','')) <= 3 ? 'text-yellow-400' : 'text-gray-400'}`}>
                          {daysUntilPurge(k.purge_after)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                          {k.archive_reason === 'rotated' && k.successor_key_id && revertTarget?.id !== k.id && (
                            <button onClick={() => { setArchiveActionError(''); setRevertTarget(k) }} disabled={reverting === k.id}
                              className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50"
                              style={{ whiteSpace: 'nowrap' }}>
                              ↩ Revert
                            </button>
                          )}
                          {revertTarget?.id === k.id && (
                            <div className="flex flex-col gap-1">
                              <span className="text-yellow-400 text-xs">Push OLD key back to servers?</span>
                              {archiveActionError && <span className="text-red-400 text-xs">{archiveActionError}</span>}
                              <div className="flex gap-1">
                                <button onClick={() => revertKey(k)} disabled={reverting === k.id}
                                  className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">
                                  {reverting === k.id ? 'Reverting…' : 'Yes, revert'}
                                </button>
                                <button onClick={() => { setRevertTarget(null); setArchiveActionError('') }} className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">Cancel</button>
                              </div>
                            </div>
                          )}
                          {purgeTarget?.id !== k.id && (
                            <button onClick={() => { setArchiveActionError(''); setPurgeTarget(k) }}
                              className="px-2 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
                              style={{ whiteSpace: 'nowrap' }}>
                              Delete Now
                            </button>
                          )}
                          {purgeTarget?.id === k.id && (
                            <div className="flex flex-col gap-1">
                              <span className="text-yellow-400 text-xs">Permanently delete "{k.name}"?</span>
                              {archiveActionError && <span className="text-red-400 text-xs">{archiveActionError}</span>}
                              <div className="flex gap-1">
                                <button onClick={() => purgeKey(k)} className="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-500 text-white transition-colors">Yes, delete</button>
                                <button onClick={() => { setPurgeTarget(null); setArchiveActionError('') }} className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">Cancel</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      )}

      {/* ── Active Keys Tab ────────────────────────────────────────────── */}
      {tab === 'active' && <>
      {(() => {
        const now = Date.now()
        const overdueKeys = keys.filter((k) => k.rotation_policy !== 'manual' && k.next_rotation_at && new Date(k.next_rotation_at).getTime() <= now)
        if (overdueKeys.length === 0) return null
        return (
          <div className="rounded-lg px-4 py-3 bg-red-900/30 border border-red-700 text-red-300 text-sm flex items-center gap-3">
            <span className="text-lg">🔴</span>
            <span>
              <span className="font-semibold">{overdueKeys.length} key{overdueKeys.length > 1 ? 's are' : ' is'} overdue for rotation</span>
              {' '}— the scheduler will rotate {overdueKeys.length > 1 ? 'them' : 'it'} automatically within the next hour, or you can rotate manually now.
            </span>
          </div>
        )
      })()}

      {rotateResult && (
        <div className={`rounded-lg px-3 py-2 text-sm flex items-start gap-3 ${rotateResult.status === 'success' ? 'bg-green-900/40 text-green-300 border border-green-800' : 'bg-red-900/40 text-red-300 border border-red-800'}`}>
          <span>{rotateResult.status === 'success' ? '✓' : '✗'}</span>
          <span className="flex-1">{rotateResult.message}</span>
          <button onClick={() => setRotateResult(null)} className="text-gray-400 hover:text-white ml-2">✕</button>
        </div>
      )}


      {selectedActive.size > 0 && (
        <div className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2">
          <span className="text-gray-300 text-sm">{selectedActive.size} selected</span>
          <button onClick={() => { setBulkDeleteError(''); setShowBulkActiveConfirm(true) }}
            className="px-3 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors">
            Delete Selected
          </button>
          <button onClick={() => setSelectedActive(new Set())} className="px-3 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">
            Clear
          </button>
          {bulkDeleteError && <span className="text-red-400 text-xs flex-1">{bulkDeleteError}</span>}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
        <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 800 }}>
          <colgroup>
            <col style={{ width: '3%'  }} />  {/* Checkbox */}
            <col style={{ width: '17%' }} />  {/* Name */}
            <col style={{ width: '7%'  }} />  {/* Type */}
            <col style={{ width: '16%' }} />  {/* Fingerprint */}
            <col style={{ width: '10%' }} />  {/* In Use */}
            <col style={{ width: '8%'  }} />  {/* Rotation */}
            <col style={{ width: '9%'  }} />  {/* Next Rotation */}
            <col style={{ width: '9%'  }} />  {/* Created */}
            <col style={{ width: '21%' }} />  {/* Actions */}
          </colgroup>
          <thead className="bg-gray-800/50">
            <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
              <th className="px-3 py-2">
                <input type="checkbox" checked={keys.length > 0 && selectedActive.size === keys.length}
                  onChange={toggleAllActive}
                  className="accent-indigo-500 cursor-pointer" />
              </th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Fingerprint</th>
              <th className="px-3 py-2">In Use</th>
              <th className="px-3 py-2">Rotation</th>
              <th className="px-3 py-2">Next Rotation</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {keys.map((k) => {
              const activeAssignCount = assignments.filter((a) => a.key_id === k.id && a.is_active && servers.some(s => s.id === a.server_id)).length
              const isMgmtKey = servers.some((s) => s.management_key_id === k.id && s.is_active)
              const orphanCount = orphans.filter(o => o.key_id === k.id).length
              const inUse = activeAssignCount > 0 || isMgmtKey

              const now = Date.now()
              const nextRot = k.next_rotation_at ? new Date(k.next_rotation_at).getTime() : null
              const isOverdue = k.rotation_policy !== 'manual' && nextRot !== null && nextRot <= now
              const isDueSoon = !isOverdue && nextRot !== null && nextRot - now < 3 * 24 * 60 * 60 * 1000 // within 3 days

              return (
                <tr key={k.id} className={`hover:bg-gray-800/30 ${isOverdue ? 'bg-red-950/20' : ''} ${selectedActive.has(k.id) ? 'bg-indigo-950/30' : ''}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selectedActive.has(k.id)} onChange={() => toggleActive(k.id)} className="accent-indigo-500 cursor-pointer" />
                  </td>
                  <td className="px-3 py-2 text-white font-medium">
                    {k.name}
                    {k.description && <p className="text-xs text-gray-500 font-normal">{k.description}</p>}
                  </td>
                  <td className="px-3 py-2"><Badge label={k.key_type} /></td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-400" style={{ wordBreak: 'break-all' }}>{k.fingerprint.slice(0, 28)}…</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      {activeAssignCount > 0 && <Badge label={`${activeAssignCount} assignment${activeAssignCount > 1 ? 's' : ''}`} variant="ok" />}
                      {isMgmtKey && <Badge label="mgmt key" variant="low" />}
                      {orphanCount > 0 && <Badge label={`${orphanCount} orphaned`} variant="high" />}
                      {!inUse && orphanCount === 0 && <span className="text-gray-600 text-xs">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-300">{k.rotation_policy}</td>
                  <td className="px-3 py-2">
                    {k.rotation_policy === 'manual' || !nextRot ? (
                      <span className="text-gray-500 text-xs">—</span>
                    ) : isOverdue ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-red-900/60 text-red-300 border border-red-700">
                        🔴 Overdue · {new Date(nextRot).toLocaleDateString()}
                      </span>
                    ) : isDueSoon ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-yellow-900/50 text-yellow-300 border border-yellow-700">
                        ⚠️ Soon · {new Date(nextRot).toLocaleDateString()}
                      </span>
                    ) : (
                      <span className="text-gray-300 text-xs">{new Date(nextRot).toLocaleDateString()}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-xs">{new Date(k.created_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'center' }}>
                      <button onClick={() => rotateKey(k.id)} disabled={rotating === k.id}
                        className="px-2 py-1 text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-white transition-colors disabled:opacity-50"
                        style={{ whiteSpace: 'nowrap' }}>
                        {rotating === k.id ? 'Rotating…' : 'Rotate'}
                      </button>
                      <div className="relative">
                        <button
                          onClick={() => setDownloadDropOpen(downloadDropOpen === k.id ? null : k.id)}
                          className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors flex items-center gap-1"
                          style={{ whiteSpace: 'nowrap' }}>
                          ↓ Download <span className="opacity-70">▾</span>
                        </button>
                        {downloadDropOpen === k.id && (
                          <div className="absolute left-0 top-full mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl w-52 py-1">
                            <a href={`/api/keys/${k.id}/public`} download
                              onClick={() => setDownloadDropOpen(null)}
                              className="flex items-center gap-2 px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 transition-colors">
                              📄 Public Key (.pub)
                            </a>
                            {(currentUser?.role === 'admin' || currentUser?.role === 'operator') && (
                              <>
                                <div className="border-t border-gray-700 my-1" />
                                <div className="px-3 py-1 text-xs text-gray-500 font-semibold uppercase tracking-wide">Private Key</div>
                                <a href={`/api/keys/${k.id}/private?format=openssh`} download
                                  onClick={() => setDownloadDropOpen(null)}
                                  className="flex items-center gap-2 px-3 py-2 text-xs text-yellow-300 hover:bg-gray-700 transition-colors">
                                  🔑 OpenSSH format
                                </a>
                                <a href={`/api/keys/${k.id}/private?format=ppk`} download
                                  onClick={() => setDownloadDropOpen(null)}
                                  className="flex items-center gap-2 px-3 py-2 text-xs text-yellow-300 hover:bg-gray-700 transition-colors">
                                  🐢 PuTTY PPK format
                                </a>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <button onClick={() => openEdit(k)}
                        className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                        style={{ whiteSpace: 'nowrap' }}>
                        Edit
                      </button>
                      <button onClick={() => { setDeleteError(''); setDeleteTarget(k) }}
                        className="px-2 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
                        style={{ whiteSpace: 'nowrap' }}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {keys.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-5 text-center text-gray-500">No keys yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      </>}
      {/* ── Modals (outside tab blocks so they render regardless of active tab) ── */}

      {/* Bulk Delete Active Keys Modal */}
      {showBulkActiveConfirm && (
        <Modal title="Delete Selected Keys" onClose={() => setShowBulkActiveConfirm(false)}>
          <div className="space-y-4">
            <p className="text-gray-300 text-sm">Archive <span className="font-semibold text-white">{selectedActive.size} key{selectedActive.size > 1 ? 's' : ''}</span>? Keys with active assignments will be skipped and shown as errors.</p>
            {bulkDeleteError && <p className="text-red-400 text-sm bg-red-900/30 border border-red-800 rounded px-3 py-2">{bulkDeleteError}</p>}
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowBulkActiveConfirm(false)} className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">Cancel</button>
              <button onClick={bulkDeleteActive} disabled={bulkDeleting} className="px-4 py-2 text-sm rounded bg-red-600 hover:bg-red-500 text-white transition-colors font-medium disabled:opacity-50">
                {bulkDeleting ? 'Deleting…' : `Yes, delete ${selectedActive.size}`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Bulk Purge Archived Keys Modal */}
      {showBulkArchivedConfirm && (
        <Modal title="Permanently Delete Selected" onClose={() => setShowBulkArchivedConfirm(false)}>
          <div className="space-y-4">
            <p className="text-gray-300 text-sm">Permanently delete <span className="font-semibold text-white">{selectedArchived.size} archived key{selectedArchived.size > 1 ? 's' : ''}</span>? This cannot be undone.</p>
            {bulkDeleteError && <p className="text-red-400 text-sm bg-red-900/30 border border-red-800 rounded px-3 py-2">{bulkDeleteError}</p>}
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowBulkArchivedConfirm(false)} className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">Cancel</button>
              <button onClick={bulkPurgeArchived} disabled={bulkDeleting} className="px-4 py-2 text-sm rounded bg-red-600 hover:bg-red-500 text-white transition-colors font-medium disabled:opacity-50">
                {bulkDeleting ? 'Deleting…' : `Yes, delete ${selectedArchived.size}`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete Key Modal */}
      {deleteTarget && (
        <Modal title={`Delete Key — ${deleteTarget.name}`} onClose={() => { setDeleteTarget(null); setDeleteError('') }}>
          <div className="space-y-4">
            {orphans.filter(o => o.key_id === deleteTarget.id).length > 0 && (
              <p className="text-yellow-400 text-sm">
                {orphans.filter(o => o.key_id === deleteTarget.id).length} orphaned assignment(s) from deleted servers will be auto-cleaned.
              </p>
            )}
            <p className="text-gray-300 text-sm">
              Archive key <span className="font-semibold text-white">"{deleteTarget.name}"</span>? It will be moved to the archived tab and permanently purged after 30 days.
            </p>
            {deleteError && (
              <p className="text-red-400 text-sm bg-red-900/30 border border-red-800 rounded px-3 py-2">{deleteError}</p>
            )}
            <div className="flex gap-3 justify-end">
              <button onClick={() => { setDeleteTarget(null); setDeleteError('') }}
                className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">
                Cancel
              </button>
              <button onClick={deleteKey}
                className="px-4 py-2 text-sm rounded bg-red-600 hover:bg-red-500 text-white transition-colors font-medium">
                Yes, delete
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit Key Modal */}
      {editKey && (
        <Modal title={`Edit Key — ${editKey.name}`} onClose={() => setEditKey(null)}>
          <form onSubmit={saveEdit} className="space-y-3">
            {editError && <p className="text-red-400 text-sm">{editError}</p>}
            <label className="block">
              <span className="text-sm text-gray-400">Name</span>
              <input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} required
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Description</span>
              <input value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Rotation Policy</span>
              <select value={editForm.rotation_policy} onChange={(e) => setEditForm((f) => ({ ...f, rotation_policy: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {[
  { value: 'manual', label: 'Manual only' },
  { value: '7d',   label: '7 days' },
  { value: '30d',  label: '30 days' },
  { value: '90d',  label: '90 days' },
  { value: '180d', label: '180 days (6 months)' },
  { value: '365d', label: '365 days (1 year)' },
].map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setEditKey(null)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Save Changes</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Generate Key Modal */}
      {showGenerate && (
        <Modal title="Generate SSH Key" onClose={() => setShowGenerate(false)}>
          <form onSubmit={generateKey} className="space-y-3">
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <label className="block">
              <span className="text-sm text-gray-400">Name</span>
              <input value={genForm.name} onChange={(e) => setGenForm((f) => ({ ...f, name: e.target.value }))} required
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Description</span>
              <input value={genForm.description} onChange={(e) => setGenForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Key Type</span>
              <select value={genForm.key_type} onChange={(e) => setGenForm((f) => ({ ...f, key_type: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="ed25519">Ed25519 (recommended)</option>
                <option value="rsa4096">RSA 4096</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Rotation Policy</span>
              <select value={genForm.rotation_policy} onChange={(e) => setGenForm((f) => ({ ...f, rotation_policy: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {[
  { value: 'manual', label: 'Manual only' },
  { value: '7d',   label: '7 days' },
  { value: '30d',  label: '30 days' },
  { value: '90d',  label: '90 days' },
  { value: '180d', label: '180 days (6 months)' },
  { value: '365d', label: '365 days (1 year)' },
].map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowGenerate(false)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Generate</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Import Key Modal */}
      {showImport && (
        <Modal title="Import SSH Key" onClose={() => setShowImport(false)}>
          <form onSubmit={importKey} className="space-y-3">
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <p className="text-xs text-gray-400">Supports PEM (OpenSSH) and <span className="text-indigo-400 font-medium">PuTTY (.ppk)</span> key files — v2 and v3.</p>

            <div
              className="border-2 border-dashed border-gray-700 hover:border-indigo-500 rounded-lg p-4 text-center cursor-pointer transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const file = e.dataTransfer.files[0]
                if (file) { const dt = new DataTransfer(); dt.items.add(file); fileInputRef.current!.files = dt.files; handleFileSelect({ target: fileInputRef.current } as React.ChangeEvent<HTMLInputElement>) }
              }}
            >
              <input ref={fileInputRef} type="file" accept=".ppk,.pem,.key,*" className="hidden" onChange={handleFileSelect} />
              {importFileName
                ? <p className="text-indigo-400 text-sm">{importFileName} {isPpk && <span className="ml-1 text-xs text-purple-400">[PuTTY PPK]</span>}</p>
                : <p className="text-gray-500 text-sm">Click or drag a .ppk or PEM key file here</p>}
            </div>

            <label className="block">
              <span className="text-sm text-gray-400">Or paste key content</span>
              <textarea value={importForm.private_key} onChange={(e) => setImportForm((f) => ({ ...f, private_key: e.target.value }))}
                rows={4} placeholder="PuTTY-User-Key-File-... or -----BEGIN ...-----"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>

            {isPpk && (
              <label className="block">
                <span className="text-sm text-gray-400">Passphrase (if key is protected)</span>
                <input type="password" value={importForm.passphrase} onChange={(e) => setImportForm((f) => ({ ...f, passphrase: e.target.value }))}
                  placeholder="Leave blank if not encrypted"
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </label>
            )}

            <label className="block">
              <span className="text-sm text-gray-400">Name</span>
              <input value={importForm.name} onChange={(e) => setImportForm((f) => ({ ...f, name: e.target.value }))} required
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowImport(false)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Import</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
