import { useEffect, useState } from 'react'
import { api, User } from '../api/client'
import Modal from '../components/Modal'
import Badge from '../components/Badge'

const PERMISSION_LABELS: Record<string, { label: string; desc: string; group: string }> = {
  'servers:read':      { label: 'View Servers',        desc: 'List servers, view info & credentials', group: 'Servers' },
  'servers:write':     { label: 'Manage Servers',      desc: 'Add, edit, delete servers; manage credentials', group: 'Servers' },
  'servers:admin':     { label: 'Server Admin',        desc: 'Root activation, SSHD settings, destructive ops', group: 'Servers' },
  'keys:read':         { label: 'View SSH Keys',       desc: 'List and view SSH keys', group: 'SSH Keys' },
  'keys:write':        { label: 'Manage SSH Keys',     desc: 'Create and delete SSH keys', group: 'SSH Keys' },
  'keys:rotate':       { label: 'Rotate Keys',         desc: 'Rotate SSH keys on servers', group: 'SSH Keys' },
  'assignments:read':  { label: 'View Assignments',    desc: 'View key-to-server assignments', group: 'Assignments' },
  'assignments:write': { label: 'Manage Assignments',  desc: 'Create and revoke key assignments', group: 'Assignments' },
  'terminal:connect':  { label: 'Terminal Access',     desc: 'Open SSH terminal sessions', group: 'Terminal' },
  'logs:read':         { label: 'View Audit Logs',     desc: 'Read audit and activity logs', group: 'Logs' },
  'security:read':     { label: 'View Security',       desc: 'View security scan results', group: 'Security' },
  'security:scan':     { label: 'Run Security Scans',  desc: 'Trigger security scans on servers', group: 'Security' },
}

const PERMISSION_GROUPS = ['Servers', 'SSH Keys', 'Assignments', 'Terminal', 'Logs', 'Security']

const ALL_PERMISSIONS = Object.keys(PERMISSION_LABELS)

const ROLES = ['operator', 'developer', 'viewer'] as const
type NonAdminRole = typeof ROLES[number]

const ROLE_COLORS: Record<NonAdminRole, string> = {
  operator:  'text-blue-400',
  developer: 'text-purple-400',
  viewer:    'text-gray-400',
}

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [editForm, setEditForm] = useState({ role: 'viewer' as User['role'], is_active: true })
  const [editError, setEditError] = useState('')

  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ email: '', display_name: '', password: '', role: 'viewer' as User['role'] })
  const [createError, setCreateError] = useState('')

  const [showPwd, setShowPwd] = useState<User | null>(null)
  const [newPwd, setNewPwd] = useState('')
  const [pwdError, setPwdError] = useState('')

  // Role permissions
  const [rolePerms, setRolePerms] = useState<Record<NonAdminRole, string[]>>({ operator: [], developer: [], viewer: [] })
  const [permSaving, setPermSaving] = useState<NonAdminRole | null>(null)
  const [permMsg, setPermMsg] = useState('')

  const load = () =>
    api.get<{ users: User[] }>('/users?limit=200').then((r) => setUsers(r.users)).catch(() => {})

  const loadPerms = () =>
    api.get<{ permissions: Record<NonAdminRole, string[]> }>('/users/role-permissions')
      .then((r) => setRolePerms(r.permissions))
      .catch(() => {})

  useEffect(() => {
    load()
    loadPerms()
    api.get<User>('/auth/me').then(setCurrentUser).catch(() => {})
  }, [])

  const openEdit = (u: User) => {
    setEditUser(u)
    setEditForm({ role: u.role, is_active: u.is_active })
    setEditError('')
  }

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault(); setEditError('')
    try {
      await api.patch(`/users/${editUser!.id}`, editForm)
      setEditUser(null)
      load()
    } catch (err: unknown) { setEditError((err as Error).message) }
  }

  const toggleActive = async (u: User) => {
    const action = u.is_active ? 'deactivate' : 'reactivate'
    if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} user "${u.email}"?`)) return
    try {
      await api.patch(`/users/${u.id}`, { is_active: !u.is_active })
      load()
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setCreateError('')
    try {
      await api.post('/auth/register', {
        email: createForm.email,
        displayName: createForm.display_name,
        password: createForm.password,
        role: createForm.role,
      })
      setShowCreate(false)
      setCreateForm({ email: '', display_name: '', password: '', role: 'viewer' })
      load()
    } catch (err: unknown) { setCreateError((err as Error).message) }
  }

  const resetPwd = async (e: React.FormEvent) => {
    e.preventDefault(); setPwdError('')
    try {
      await api.post('/auth/admin/set-password', { user_id: showPwd!.id, new_password: newPwd })
      setShowPwd(null)
      setNewPwd('')
    } catch (err: unknown) { setPwdError((err as Error).message) }
  }

  const togglePerm = (role: NonAdminRole, perm: string) => {
    setRolePerms((prev) => {
      const cur = prev[role]
      return { ...prev, [role]: cur.includes(perm) ? cur.filter((p) => p !== perm) : [...cur, perm] }
    })
  }

  const savePerms = async (role: NonAdminRole) => {
    setPermSaving(role); setPermMsg('')
    try {
      await api.put(`/users/role-permissions/${role}`, { permissions: rolePerms[role] })
      setPermMsg(`✓ ${role} permissions saved`)
      setTimeout(() => setPermMsg(''), 3000)
    } catch (err: unknown) {
      setPermMsg('✗ ' + (err as Error).message)
    } finally { setPermSaving(null) }
  }

  const roles: User['role'][] = ['admin', 'operator', 'developer', 'viewer']

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Users</h1>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors">
          + Add User
        </button>
      </div>

      {/* Users table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
        <table className="w-full text-xs" style={{ tableLayout: 'auto', borderCollapse: 'collapse', minWidth: 620 }}>
          <colgroup>
            <col style={{ width: '24%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '24%' }} />
          </colgroup>
          <thead className="bg-gray-800/50">
            <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last Login</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {users.map((u) => {
              const isSelf = u.id === currentUser?.id
              return (
              <tr key={u.id} className={`hover:bg-gray-800/30 transition-colors ${isSelf ? 'bg-indigo-950/20' : ''}`}>
                <td className="px-3 py-2 text-white font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.email}
                  {isSelf && <span className="ml-2 text-xs text-indigo-400 font-normal">(you)</span>}
                </td>
                <td className="px-3 py-2 text-gray-300" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.display_name ?? '—'}</td>
                <td className="px-3 py-2"><Badge label={u.role} /></td>
                <td className="px-3 py-2">
                  <Badge label={u.is_active ? 'Active' : 'Inactive'} variant={u.is_active ? 'ok' : 'high'} />
                </td>
                <td className="px-3 py-2 text-gray-400 text-xs">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2">
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'center' }}>
                    <button onClick={() => openEdit(u)} disabled={isSelf}
                      title={isSelf ? 'You cannot change your own role' : undefined}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ whiteSpace: 'nowrap' }}>
                      Edit Role
                    </button>
                    <button onClick={() => { setShowPwd(u); setNewPwd(''); setPwdError('') }}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                      style={{ whiteSpace: 'nowrap' }}>
                      Reset Pwd
                    </button>
                    <button onClick={() => toggleActive(u)} disabled={isSelf}
                      title={isSelf ? 'You cannot deactivate your own account' : undefined}
                      className={`px-2 py-1 text-xs rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${u.is_active ? 'bg-red-700 hover:bg-red-600 text-white' : 'bg-green-700 hover:bg-green-600 text-white'}`}
                      style={{ whiteSpace: 'nowrap' }}>
                      {u.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </td>
              </tr>
              )
            })}
            {users.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-5 text-center text-gray-500">No users found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Role Permissions Panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="bg-gray-800/50 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-white">Role Permissions</div>
            <div className="text-xs text-gray-500 mt-0.5">Customize which actions each role can perform. Admin always has full access.</div>
          </div>
          {permMsg && <span className={`text-xs font-medium ${permMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{permMsg}</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 600 }}>
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-4 py-3 text-left text-gray-500 font-medium uppercase tracking-wide" style={{ width: '38%' }}>Permission</th>
                {ROLES.map((role) => (
                  <th key={role} className="px-4 py-3 text-center" style={{ width: '20%' }}>
                    <span className={`font-semibold uppercase tracking-wide ${ROLE_COLORS[role]}`}>{role}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_GROUPS.map((group) => {
                const permsInGroup = ALL_PERMISSIONS.filter((p) => PERMISSION_LABELS[p].group === group)
                return [
                  <tr key={`group-${group}`} className="bg-gray-800/30">
                    <td colSpan={4} className="px-4 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">{group}</td>
                  </tr>,
                  ...permsInGroup.map((perm) => (
                    <tr key={perm} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                      <td className="px-4 py-2.5">
                        <div className="text-gray-200 font-medium">{PERMISSION_LABELS[perm].label}</div>
                        <div className="text-gray-500 text-xs mt-0.5">{PERMISSION_LABELS[perm].desc}</div>
                      </td>
                      {ROLES.map((role) => (
                        <td key={role} className="px-4 py-2.5 text-center">
                          <input
                            type="checkbox"
                            checked={rolePerms[role].includes(perm)}
                            onChange={() => togglePerm(role, perm)}
                            className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-indigo-500 cursor-pointer"
                          />
                        </td>
                      ))}
                    </tr>
                  )),
                ]
              })}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-gray-800 flex items-center gap-3">
          {ROLES.map((role) => (
            <button key={role} onClick={() => savePerms(role)}
              disabled={permSaving !== null}
              className="px-4 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50">
              {permSaving === role ? 'Saving…' : `Save ${role}`}
            </button>
          ))}
        </div>
      </div>

      {/* Create User Modal */}
      {showCreate && (
        <Modal title="Add User" onClose={() => setShowCreate(false)}>
          <form onSubmit={create} className="space-y-3">
            {createError && <p className="text-red-400 text-sm">{createError}</p>}
            <label className="block">
              <span className="text-sm text-gray-400">Email</span>
              <input type="email" value={createForm.email} onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))} required
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Display Name</span>
              <input value={createForm.display_name} onChange={(e) => setCreateForm((f) => ({ ...f, display_name: e.target.value }))}
                placeholder="Optional"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Password</span>
              <input type="password" value={createForm.password} onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))} required
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Role</span>
              <select value={createForm.role} onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as User['role'] }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {roles.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Create User</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit Role Modal */}
      {editUser && (
        <Modal title={`Edit User — ${editUser.email}`} onClose={() => setEditUser(null)}>
          <form onSubmit={saveEdit} className="space-y-3">
            {editError && <p className="text-red-400 text-sm">{editError}</p>}
            <label className="block">
              <span className="text-sm text-gray-400">Role</span>
              <select value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value as User['role'] }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {roles.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={editForm.is_active} onChange={(e) => setEditForm((f) => ({ ...f, is_active: e.target.checked }))} className="rounded" />
              <span className="text-sm text-gray-400">Account active</span>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setEditUser(null)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Save Changes</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Reset Password Modal */}
      {showPwd && (
        <Modal title={`Reset Password — ${showPwd.email}`} onClose={() => setShowPwd(null)}>
          <form onSubmit={resetPwd} className="space-y-3">
            {pwdError && <p className="text-red-400 text-sm">{pwdError}</p>}
            <label className="block">
              <span className="text-sm text-gray-400">New Password</span>
              <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} required autoFocus
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
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
