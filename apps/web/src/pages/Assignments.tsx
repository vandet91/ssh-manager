import { useEffect, useState } from 'react'
import { api, Assignment, User, SshKey, Server } from '../api/client'
import Modal from '../components/Modal'
import Badge from '../components/Badge'

type ServerUser = { username: string; uid: number; home: string; shell: string }

export default function Assignments() {
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [keys, setKeys] = useState<SshKey[]>([])
  const [servers, setServers] = useState<Server[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ user_id: '', key_id: '', server_id: '', linux_user: '', can_terminal: true, expires_at: '' })
  const [error, setError] = useState('')
  const [serverUsers, setServerUsers] = useState<ServerUser[]>([])
  const [loadingServerUsers, setLoadingServerUsers] = useState(false)

  const load = () => {
    api.get<{ data: Assignment[] } | Assignment[]>('/assignments').then((r) => setAssignments(Array.isArray(r) ? r : (r as { data: Assignment[] }).data ?? [])).catch(() => {})
    api.get<{ users: User[] }>('/users?limit=200').then((r) => setUsers(r.users)).catch(() => {})
    api.get<SshKey[]>('/keys').then(setKeys).catch(() => {})
    api.get<Server[]>('/servers').then(setServers).catch(() => {})
  }

  useEffect(() => { load() }, [])

  const onServerChange = async (serverId: string) => {
    setForm((f) => ({ ...f, server_id: serverId, linux_user: '' }))
    setServerUsers([])
    if (!serverId) return
    setLoadingServerUsers(true)
    try {
      const users = await api.get<ServerUser[]>(`/assignments/server-users/${serverId}`)
      setServerUsers(users)
    } catch {
      // server not configured or SSH failed — fall back to free-text
    } finally {
      setLoadingServerUsers(false)
    }
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError('')
    try {
      await api.post('/assignments', { ...form, expires_at: form.expires_at || undefined })
      setShowCreate(false)
      setForm({ user_id: '', key_id: '', server_id: '', linux_user: '', can_terminal: true, expires_at: '' })
      load()
    } catch (err: unknown) { setError((err as Error).message) }
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke this assignment? The key will be removed from the server.')) return
    await api.delete(`/assignments/${id}`)
    load()
  }

  const userMap = Object.fromEntries(users.map((u) => [u.id, u.email]))
  const keyMap = Object.fromEntries(keys.map((k) => [k.id, k.name]))
  const serverMap = Object.fromEntries(servers.map((s) => [s.id, s.name]))

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Assignments</h1>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors">
          + Assign Key
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
        <table className="w-full text-xs" style={{ tableLayout: 'fixed', borderCollapse: 'collapse', minWidth: 780 }}>
          <colgroup>
            <col style={{ width: '16%' }} />  {/* User */}
            <col style={{ width: '13%' }} />  {/* Key */}
            <col style={{ width: '13%' }} />  {/* Server */}
            <col style={{ width: '10%' }} />  {/* Linux User */}
            <col style={{ width: '8%'  }} />  {/* Terminal */}
            <col style={{ width: '9%'  }} />  {/* Expires */}
            <col style={{ width: '8%'  }} />  {/* Status */}
            <col style={{ width: '9%'  }} />  {/* Assigned On */}
            <col style={{ width: '14%' }} />  {/* Actions */}
          </colgroup>
          <thead className="bg-gray-800/50">
            <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Key</th>
              <th className="px-3 py-2">Server</th>
              <th className="px-3 py-2">Linux User</th>
              <th className="px-3 py-2">Terminal</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Assigned On</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {assignments.map((a) => (
              <tr key={a.id} className="hover:bg-gray-800/30">
                <td className="px-3 py-2 text-gray-300 text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userMap[a.user_id] ?? a.user_id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-gray-300" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{keyMap[a.key_id] ?? '—'}</td>
                <td className="px-3 py-2 text-gray-300" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{serverMap[a.server_id] ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-indigo-300" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.linux_user}</td>
                <td className="px-3 py-2">{a.can_terminal ? <Badge label="Yes" variant="ok" /> : <Badge label="No" />}</td>
                <td className="px-3 py-2 text-gray-400 text-xs">{a.expires_at ? new Date(a.expires_at).toLocaleDateString() : '—'}</td>
                <td className="px-3 py-2"><Badge label={a.is_active ? 'Active' : 'Revoked'} variant={a.is_active ? 'ok' : 'default'} /></td>
                <td className="px-3 py-2 text-gray-400 text-xs" title={new Date(a.created_at).toLocaleString()}>{new Date(a.created_at).toLocaleDateString()}</td>
                <td className="px-3 py-2">
                  {a.is_active && (
                    <button onClick={() => revoke(a.id)} className="px-2 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors" style={{ whiteSpace: 'nowrap' }}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
            {assignments.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-5 text-center text-gray-500">No assignments.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <Modal title="Assign Key to Server" onClose={() => setShowCreate(false)}>
          <form onSubmit={create} className="space-y-3">
            {error && <p className="text-red-400 text-sm">{error}</p>}
            {[['User', 'user_id', users.map((u) => ({ v: u.id, l: u.email }))],
              ['SSH Key', 'key_id', keys.map((k) => ({ v: k.id, l: k.name }))]].map(([label, field, opts]) => (
              <label key={field as string} className="block">
                <span className="text-sm text-gray-400">{label as string}</span>
                <select value={(form as Record<string, unknown>)[field as string] as string} onChange={(e) => setForm((f) => ({ ...f, [field as string]: e.target.value }))} required
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">— select —</option>
                  {(opts as { v: string; l: string }[]).map(({ v, l }) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            ))}
            <label className="block">
              <span className="text-sm text-gray-400">Server</span>
              <select value={form.server_id} onChange={(e) => onServerChange(e.target.value)} required
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="">— select —</option>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Linux User (on server)</span>
              {serverUsers.length > 0 ? (
                <select value={form.linux_user} onChange={(e) => setForm((f) => ({ ...f, linux_user: e.target.value }))} required
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="">— select user —</option>
                  {serverUsers.map((u) => (
                    <option key={u.username} value={u.username}>
                      {u.username} (uid {u.uid}{u.home ? `, ${u.home}` : ''})
                    </option>
                  ))}
                </select>
              ) : (
                <input value={form.linux_user} onChange={(e) => setForm((f) => ({ ...f, linux_user: e.target.value }))} required
                  placeholder={loadingServerUsers ? 'Loading users…' : form.server_id ? 'Could not load users — type manually' : 'Select a server first'}
                  disabled={loadingServerUsers}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50" />
              )}
            </label>
            <label className="block">
              <span className="text-sm text-gray-400">Expires (optional)</span>
              <input type="datetime-local" value={form.expires_at} onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
            <label className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={form.can_terminal} onChange={(e) => setForm((f) => ({ ...f, can_terminal: e.target.checked }))} className="rounded" />
              <span className="text-sm text-gray-400">Allow web terminal access</span>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-2 rounded-lg bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Assign</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
