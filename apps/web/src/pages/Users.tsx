import { useEffect, useState } from 'react'
import { api, User, Server, VaultEntry } from '../api/client'
import Modal from '../components/Modal'
import Badge from '../components/Badge'
import { usePermissions } from '../context/PermissionContext'

type ServerGrant = { id: string; server_id: string; server_name: string; hostname: string; environment: string; os_type: string; granted_at: string; expires_at: string | null }
type VaultGrant  = { id: string; vault_entry_id: string; title: string; type: string; can_write: boolean; granted_at: string; expires_at: string | null }

export default function Users() {
  const { isAdmin } = usePermissions()
  const [users, setUsers] = useState<User[]>([])
  const [currentUser, setCurrentUser] = useState<User | null>(null)

  // Modals
  const [editUser, setEditUser]   = useState<User | null>(null)
  const [editForm, setEditForm]   = useState({ is_active: true })
  const [editError, setEditError] = useState('')
  const [showCreate, setShowCreate]   = useState(false)
  const [createForm, setCreateForm]   = useState({ email: '', display_name: '', password: '' })
  const [createError, setCreateError] = useState('')
  const [showPwd, setShowPwd]   = useState<User | null>(null)
  const [newPwd, setNewPwd]     = useState('')
  const [pwdError, setPwdError] = useState('')
  const [mfaResetting, setMfaResetting] = useState<string | null>(null)

  // Grant management
  const [grantUser, setGrantUser]       = useState<User | null>(null)
  const [allServers, setAllServers]     = useState<Server[]>([])
  const [allVault, setAllVault]         = useState<VaultEntry[]>([])
  const [grantSaving, setGrantSaving]   = useState(false)
  const [grantMsg, setGrantMsg]         = useState('')
  const [grantTab, setGrantTab]         = useState<'servers' | 'vault'>('servers')

  // Draft grant state (pending save)
  const [draftServers, setDraftServers] = useState<Set<string>>(new Set())
  const [draftVault, setDraftVault]     = useState<Map<string, { can_write: boolean; expires_at: string }>>(new Map())

  const load = () =>
    api.get<{ users: User[] }>('/users?limit=200').then(r => setUsers(r.users)).catch(() => {})

  useEffect(() => {
    load()
    api.get<User>('/users/me').then(setCurrentUser).catch(() => {})
  }, [])

  const openGrants = async (u: User) => {
    setGrantUser(u)
    setGrantMsg('')
    setGrantTab('servers')
    const [grants, servers, vault] = await Promise.all([
      api.get<{ server_grants: ServerGrant[]; vault_grants: VaultGrant[] }>(`/users/${u.id}/grants`),
      api.get<Server[]>('/servers?limit=500'),
      api.get<VaultEntry[]>('/vault?limit=1000'),
    ])
    setAllServers(servers)
    setAllVault(vault)
    setDraftServers(new Set(grants.server_grants.map(g => g.server_id)))
    const vm = new Map<string, { can_write: boolean; expires_at: string }>()
    grants.vault_grants.forEach(g => vm.set(g.vault_entry_id, { can_write: g.can_write, expires_at: g.expires_at ?? '' }))
    setDraftVault(vm)
  }

  const saveGrants = async () => {
    if (!grantUser) return
    setGrantSaving(true); setGrantMsg('')
    try {
      await Promise.all([
        api.put(`/users/${grantUser.id}/grants/servers`, {
          grants: Array.from(draftServers).map(server_id => ({ server_id })),
        }),
        api.put(`/users/${grantUser.id}/grants/vault`, {
          grants: Array.from(draftVault.entries()).map(([vault_entry_id, g]) => ({
            vault_entry_id, can_write: g.can_write,
            ...(g.expires_at ? { expires_at: g.expires_at } : {}),
          })),
        }),
      ])
      await openGrants(grantUser)
      setGrantMsg('✓ Access grants saved')
      setTimeout(() => setGrantMsg(''), 3000)
    } catch (err) {
      setGrantMsg('✗ ' + (err as Error).message)
    } finally { setGrantSaving(false) }
  }

  const openEdit = (u: User) => { setEditUser(u); setEditForm({ is_active: u.is_active }); setEditError('') }

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault(); setEditError('')
    try { await api.patch(`/users/${editUser!.id}`, editForm); setEditUser(null); load() }
    catch (err: unknown) { setEditError((err as Error).message) }
  }

  const toggleActive = async (u: User) => {
    if (!confirm(`${u.is_active ? 'Deactivate' : 'Reactivate'} user "${u.email}"?`)) return
    try { await api.patch(`/users/${u.id}`, { is_active: !u.is_active }); load() }
    catch (err: unknown) { alert((err as Error).message) }
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setCreateError('')
    try {
      await api.post('/auth/register', { email: createForm.email, displayName: createForm.display_name, password: createForm.password })
      setShowCreate(false); setCreateForm({ email: '', display_name: '', password: '' }); load()
    } catch (err: unknown) { setCreateError((err as Error).message) }
  }

  const resetPwd = async (e: React.FormEvent) => {
    e.preventDefault(); setPwdError('')
    try { await api.post('/auth/admin/set-password', { user_id: showPwd!.id, new_password: newPwd }); setShowPwd(null); setNewPwd('') }
    catch (err: unknown) { setPwdError((err as Error).message) }
  }

  const resetMfa = async (u: User) => {
    if (!confirm(`Reset MFA for "${u.email}"? They will need to re-enroll on next login.`)) return
    setMfaResetting(u.id)
    try { await api.delete(`/users/${u.id}/mfa`); load() }
    catch (err: unknown) { alert((err as Error).message) }
    finally { setMfaResetting(null) }
  }

  const toggleMfaExempt = async (u: User, exempt: boolean) => {
    const msg = exempt
      ? `Disable MFA for "${u.email}"? They will be able to log in without MFA.`
      : `Require MFA for "${u.email}"? They will need to set up MFA on next login.`
    if (!confirm(msg)) return
    setMfaResetting(u.id)
    try { await api.patch(`/users/${u.id}/mfa`, { exempt }); load() }
    catch (err: unknown) { alert((err as Error).message) }
    finally { setMfaResetting(null) }
  }

  const inp = "mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Users</h1>
        {isAdmin && (
          <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors">
            + Add User
          </button>
        )}
      </div>

      {/* Users table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 640 }}>
          <thead className="bg-gray-800/50">
            <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">MFA</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last Login</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {users.map(u => {
              const isSelf = u.id === currentUser?.id
              return (
                <tr key={u.id} className={`hover:bg-gray-800/30 transition-colors ${isSelf ? 'bg-indigo-950/20' : ''}`}>
                  <td className="px-3 py-2 text-white font-medium truncate max-w-[200px]">
                    {u.email}{isSelf && <span className="ml-2 text-xs text-indigo-400 font-normal">(you)</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-300 truncate max-w-[140px]">{u.display_name ?? '—'}</td>
                  <td className="px-3 py-2">
                    {u.mfa_enabled
                      ? <Badge label="On" variant="ok" />
                      : u.mfa_exempt
                        ? <Badge label="Disabled" variant="low" />
                        : <Badge label="Off" variant="low" />
                    }
                  </td>
                  <td className="px-3 py-2">
                    <Badge label={u.is_active ? 'Active' : 'Inactive'} variant={u.is_active ? 'ok' : 'high'} />
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-xs">
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {isAdmin ? (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'nowrap' }}>
                        <button onClick={() => openEdit(u)} disabled={isSelf}
                          className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          style={{ whiteSpace: 'nowrap' }}>
                          Edit
                        </button>
                        <button onClick={() => { setShowPwd(u); setNewPwd(''); setPwdError('') }}
                          className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                          style={{ whiteSpace: 'nowrap' }}>
                          Reset Pwd
                        </button>
                        {u.mfa_exempt ? (
                          <button onClick={() => toggleMfaExempt(u, false)} disabled={mfaResetting === u.id}
                            className="px-2 py-1 text-xs rounded bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
                            style={{ whiteSpace: 'nowrap' }}>
                            {mfaResetting === u.id ? '…' : 'Require MFA'}
                          </button>
                        ) : u.mfa_enabled ? (
                          <>
                            <button onClick={() => resetMfa(u)} disabled={mfaResetting === u.id}
                              className="px-2 py-1 text-xs rounded bg-amber-700 hover:bg-amber-600 text-white transition-colors disabled:opacity-50"
                              style={{ whiteSpace: 'nowrap' }}>
                              {mfaResetting === u.id ? '…' : 'Reset MFA'}
                            </button>
                            <button onClick={() => toggleMfaExempt(u, true)} disabled={mfaResetting === u.id}
                              className="px-2 py-1 text-xs rounded bg-slate-600 hover:bg-slate-500 text-white transition-colors disabled:opacity-50"
                              style={{ whiteSpace: 'nowrap' }}>
                              {mfaResetting === u.id ? '…' : 'Disable MFA'}
                            </button>
                          </>
                        ) : (
                          <button onClick={() => toggleMfaExempt(u, true)} disabled={mfaResetting === u.id}
                            className="px-2 py-1 text-xs rounded bg-slate-600 hover:bg-slate-500 text-white transition-colors disabled:opacity-50"
                            style={{ whiteSpace: 'nowrap' }}>
                            {mfaResetting === u.id ? '…' : 'Disable MFA'}
                          </button>
                        )}
                        <button onClick={() => toggleActive(u)} disabled={isSelf}
                          className={`px-2 py-1 text-xs rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${u.is_active ? 'bg-red-700 hover:bg-red-600 text-white' : 'bg-green-700 hover:bg-green-600 text-white'}`}
                          style={{ whiteSpace: 'nowrap' }}>
                          {u.is_active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    ) : <span className="text-gray-600 text-xs">—</span>}
                  </td>
                </tr>
              )
            })}
            {users.length === 0 && <tr><td colSpan={6} className="px-3 py-5 text-center text-gray-500">No users found.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* ── Grant Management Modal ─────────────────────────────────────────── */}
      {grantUser && (
        <Modal title={`Access Grants — ${grantUser.email}`} onClose={() => setGrantUser(null)} size="lg">
          <div style={{ width: '100%', minWidth: 480 }}>
            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
              {(['servers', 'vault'] as const).map(tab => (
                <button key={tab} onClick={() => setGrantTab(tab)}
                  style={{
                    padding: '6px 16px', fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer',
                    background: 'none', borderBottom: grantTab === tab ? '2px solid var(--accent-hex)' : '2px solid transparent',
                    color: grantTab === tab ? 'var(--accent-hex)' : 'var(--text-muted)',
                    marginBottom: -1,
                  }}>
                  {tab === 'servers' ? `🖥 Servers (${draftServers.size})` : `🔐 Vault (${draftVault.size})`}
                </button>
              ))}
            </div>

            {/* Servers tab */}
            {grantTab === 'servers' && (
              <div style={{ maxHeight: 380, overflowY: 'auto', paddingRight: 8 }}>
                {allServers.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No servers available.</p>
                ) : allServers.map(s => (
                  <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={draftServers.has(s.id)}
                      onChange={e => {
                        const next = new Set(draftServers)
                        e.target.checked ? next.add(s.id) : next.delete(s.id)
                        setDraftServers(next)
                      }}
                      style={{ accentColor: 'var(--accent-hex)', width: 14, height: 14, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.hostname} · {s.environment}</div>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, fontFamily: 'monospace' }}>{s.os_type ?? '—'}</span>
                  </label>
                ))}
              </div>
            )}

            {/* Vault tab */}
            {grantTab === 'vault' && (
              <div style={{ maxHeight: 380, overflowY: 'auto', paddingRight: 8 }}>
                {allVault.length === 0 ? (
                  <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No vault entries available.</p>
                ) : allVault.map(e => {
                  const grant = draftVault.get(e.id)
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--border)' }}>
                      <input type="checkbox" checked={!!grant}
                        onChange={ev => {
                          const next = new Map(draftVault)
                          ev.target.checked ? next.set(e.id, { can_write: false, expires_at: '' }) : next.delete(e.id)
                          setDraftVault(next)
                        }}
                        style={{ accentColor: 'var(--accent-hex)', width: 15, height: 15, flexShrink: 0, cursor: 'pointer' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{e.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.type}{e.username ? ` · ${e.username}` : ''}</div>
                      </div>
                      {grant && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0 }}>
                          <input type="checkbox" checked={grant.can_write}
                            onChange={ev => {
                              const next = new Map(draftVault)
                              next.set(e.id, { ...grant, can_write: ev.target.checked })
                              setDraftVault(next)
                            }}
                            style={{ accentColor: '#f59e0b' }} />
                          Can write
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: grantMsg.startsWith('✓') ? '#3fb950' : '#f85149' }}>{grantMsg}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setGrantUser(null)} style={{ padding: '7px 16px', fontSize: 13, borderRadius: 8, background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={saveGrants} disabled={grantSaving}
                  style={{ padding: '7px 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: 'var(--accent-hex)', border: 'none', color: '#fff', cursor: 'pointer', opacity: grantSaving ? 0.6 : 1 }}>
                  {grantSaving ? 'Saving…' : 'Save Grants'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Create User Modal */}
      {isAdmin && showCreate && (
        <Modal title="Add User" onClose={() => setShowCreate(false)}>
          <form onSubmit={create} className="space-y-3">
            {createError && <p className="text-red-400 text-sm">{createError}</p>}
            <label className="block"><span className="text-sm text-gray-400">Email</span>
              <input type="email" value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} required className={inp} /></label>
            <label className="block"><span className="text-sm text-gray-400">Display Name (optional)</span>
              <input value={createForm.display_name} onChange={e => setCreateForm(f => ({ ...f, display_name: e.target.value }))} className={inp} /></label>
            <label className="block"><span className="text-sm text-gray-400">Password</span>
              <input type="password" value={createForm.password} onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))} required className={inp} /></label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Create</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit User Modal */}
      {isAdmin && editUser && (
        <Modal title={`Edit User — ${editUser.email}`} onClose={() => setEditUser(null)}>
          <form onSubmit={saveEdit} className="space-y-3">
            {editError && <p className="text-red-400 text-sm">{editError}</p>}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={editForm.is_active} onChange={e => setEditForm(f => ({ ...f, is_active: e.target.checked }))} />
              <span className="text-sm text-gray-400">Account active</span>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setEditUser(null)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Save</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Reset Password Modal */}
      {isAdmin && showPwd && (
        <Modal title={`Reset Password — ${showPwd.email}`} onClose={() => setShowPwd(null)}>
          <form onSubmit={resetPwd} className="space-y-3">
            {pwdError && <p className="text-red-400 text-sm">{pwdError}</p>}
            <label className="block"><span className="text-sm text-gray-400">New Password</span>
              <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} required autoFocus className={inp} /></label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowPwd(null)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Set Password</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
