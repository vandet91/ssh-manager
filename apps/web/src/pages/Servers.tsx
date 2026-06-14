import { useEffect, useState } from 'react'
import { api, Server, ServerInfo, SshKey, ServerCredential, CredentialCategory, SoftwareItem, Recommendation, RecSeverity, HostType } from '../api/client'
import Modal from '../components/Modal'
import Badge from '../components/Badge'

type SetupStep = 'credentials' | 'working' | 'done' | 'error'

// ── Host platform badge ───────────────────────────────────────────────────────

const HOST_META: Record<string, { icon: string; label: string; color: string; bg: string; border: string }> = {
  vmware:      { icon: '🟦', label: 'VMware',      color: '#60a5fa', bg: 'rgba(30,64,175,0.2)',  border: 'rgba(59,130,246,0.35)' },
  hyperv:      { icon: '🪟', label: 'Hyper-V',     color: '#60a5fa', bg: 'rgba(0,120,212,0.15)', border: 'rgba(0,120,212,0.35)' },
  proxmox:     { icon: '🟧', label: 'Proxmox',     color: '#fb923c', bg: 'rgba(194,65,12,0.2)',  border: 'rgba(249,115,22,0.35)' },
  kvm:         { icon: '🟩', label: 'KVM/QEMU',    color: '#4ade80', bg: 'rgba(21,128,61,0.2)',  border: 'rgba(34,197,94,0.35)' },
  virtualbox:  { icon: '🔵', label: 'VirtualBox',  color: '#818cf8', bg: 'rgba(67,56,202,0.2)',  border: 'rgba(129,140,248,0.35)' },
  xen:         { icon: '🔷', label: 'Xen',         color: '#a78bfa', bg: 'rgba(91,33,182,0.2)',  border: 'rgba(167,139,250,0.35)' },
  lxc:         { icon: '📦', label: 'LXC',         color: '#c084fc', bg: 'rgba(107,33,168,0.2)', border: 'rgba(192,132,252,0.35)' },
  docker:      { icon: '🐳', label: 'Docker',      color: '#38bdf8', bg: 'rgba(7,89,133,0.2)',   border: 'rgba(56,189,248,0.35)' },
  aws:         { icon: '☁️', label: 'AWS',          color: '#fb923c', bg: 'rgba(154,52,18,0.2)',  border: 'rgba(249,115,22,0.35)' },
  azure:       { icon: '☁️', label: 'Azure',        color: '#60a5fa', bg: 'rgba(29,78,216,0.2)',  border: 'rgba(96,165,250,0.35)' },
  gcp:         { icon: '☁️', label: 'GCP',          color: '#34d399', bg: 'rgba(6,78,59,0.2)',    border: 'rgba(52,211,153,0.35)' },
  physical:    { icon: '🖥️', label: 'Physical',    color: '#9ca3af', bg: 'rgba(55,65,81,0.3)',   border: 'rgba(107,114,128,0.4)' },
  unknown:     { icon: '❓', label: 'Unknown',      color: '#6b7280', bg: 'rgba(55,65,81,0.2)',   border: 'rgba(107,114,128,0.3)' },
}

function HostBadge({ type, detail }: { type: HostType | null | undefined; detail?: string | null }) {
  if (!type) return <span className="text-xs text-gray-600">—</span>
  const m = HOST_META[type] ?? HOST_META['unknown']
  return (
    <span title={detail ?? m.label} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: m.bg, border: `1px solid ${m.border}`,
      color: m.color, borderRadius: 5, padding: '1px 7px',
    }}>
      {m.icon} {m.label}
    </span>
  )
}

export default function Servers() {
  const [servers, setServers] = useState<Server[]>([])
  const [allKeys, setAllKeys] = useState<SshKey[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'production' })
  const [addError, setAddError] = useState('')

  const [editServer, setEditServer] = useState<Server | null>(null)
  const [editForm, setEditForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'production' })
  const [editError, setEditError] = useState('')

  const [setupServerId, setSetupServerId] = useState<string | null>(null)
  const [setupForm, setSetupForm] = useState({ linux_user: 'root', password: '' })
  const [setupStep, setSetupStep] = useState<SetupStep>('credentials')
  const [setupError, setSetupError] = useState('')
  const [setupResult, setSetupResult] = useState<{ key_name: string } | null>(null)

  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'failed' | 'testing'>>({})
  const [testKeyInfo, setTestKeyInfo] = useState<Record<string, { key_name: string; is_fallback: boolean }>>({})
  const [verifyResults, setVerifyResults] = useState<Record<string, 'ok' | 'failed' | 'mismatch' | 'verifying'>>({})

  const [infoServer, setInfoServer] = useState<Server | null>(null)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState('')
  const [infoTab, setInfoTab] = useState<'overview' | 'users' | 'keys' | 'credentials' | 'software' | 'recommendations'>('overview')
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [recLoading, setRecLoading] = useState(false)
  const [recError, setRecError] = useState('')
  const [recFilter, setRecFilter] = useState<'all' | 'security' | 'performance' | 'stability' | 'monitoring'>('all')
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null)
  const [expandedRec, setExpandedRec] = useState<string | null>(null)
  const [software, setSoftware] = useState<SoftwareItem[]>([])
  const [softwareLoading, setSoftwareLoading] = useState(false)
  const [softwareError, setSoftwareError] = useState('')
  const [serviceWorking, setServiceWorking] = useState<string | null>(null)  // 'svcName:action'
  const [serviceResults, setServiceResults] = useState<Record<string, string>>({})  // svcName → new status
  const [credentials, setCredentials] = useState<ServerCredential[]>([])
  const [credLoading, setCredLoading] = useState(false)
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({})
  const [copiedCred, setCopiedCred] = useState<string | null>(null)
  const [rotatingCred, setRotatingCred] = useState<string | null>(null)
  const [applyingCred, setApplyingCred] = useState<string | null>(null)
  const [applyStatus, setApplyStatus] = useState<Record<string, 'ok' | 'failed'>>({})
  const [credFormApplyStatus, setCredFormApplyStatus] = useState<'idle' | 'ok' | 'warning'>('idle')
  const [credFormApplyWarning, setCredFormApplyWarning] = useState('')
  const [showCredForm, setShowCredForm] = useState(false)
  const [credForm, setCredForm] = useState({ category: 'linux' as CredentialCategory, linux_user: '', service_name: '', service_username: '', label: '', password: '', notes: '', apply_on_server: false })
  const [credFormWorking, setCredFormWorking] = useState(false)
  const [credFormError, setCredFormError] = useState('')
  const [editCred, setEditCred] = useState<ServerCredential | null>(null)
  const [editCredPwd, setEditCredPwd] = useState('')
  const [editCredWorking, setEditCredWorking] = useState(false)
  const [showArchivedCreds, setShowArchivedCreds] = useState(false)
  const [verifyingCred, setVerifyingCred] = useState<string | null>(null)
  const [verifyCredResult, setVerifyCredResult] = useState<Record<string, 'match' | 'mismatch' | 'error'>>({})
  const [openCredMenu, setOpenCredMenu] = useState<string | null>(null)
  const [setMgmtKeyWorking, setSetMgmtKeyWorking] = useState(false)

  // User management state (within info modal)
  const [showAddUser, setShowAddUser] = useState(false)
  const [addUserForm, setAddUserForm] = useState({ username: '', comment: '', shell: '/bin/bash', system_user: false })
  const [addUserError, setAddUserError] = useState('')
  const [addUserWorking, setAddUserWorking] = useState(false)
  const [pushKeyTarget, setPushKeyTarget] = useState<string | null>(null)  // username being targeted for key push
  const [pushKeyId, setPushKeyId] = useState('')
  const [pushKeyWorking, setPushKeyWorking] = useState(false)
  const [pushKeyError, setPushKeyError] = useState('')
  const [deleteUserWorking, setDeleteUserWorking] = useState<string | null>(null)

  const load = () => {
    api.get<Server[]>('/servers').then(setServers).catch(() => {})
    api.get<SshKey[]>('/keys').then(setAllKeys).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const addServer = async (e: React.FormEvent) => {
    e.preventDefault(); setAddError('')
    try {
      await api.post('/servers', addForm)
      setShowAdd(false)
      setAddForm({ name: '', hostname: '', ssh_port: 22, environment: 'production' })
      load()
    } catch (err: unknown) { setAddError((err as Error).message) }
  }

  const openEdit = (s: Server) => {
    setEditServer(s)
    setEditForm({ name: s.name, hostname: s.hostname, ssh_port: s.ssh_port, environment: s.environment })
    setEditError('')
  }

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault(); setEditError('')
    try {
      await api.patch(`/servers/${editServer!.id}`, editForm)
      setEditServer(null)
      load()
    } catch (err: unknown) { setEditError((err as Error).message) }
  }

  const deleteServer = async (s: Server) => {
    if (!confirm(`Delete server "${s.name}"? This cannot be undone.`)) return
    await api.delete(`/servers/${s.id}`)
    load()
  }

  const openSetup = (id: string) => {
    setSetupServerId(id)
    setSetupStep('credentials')
    setSetupForm({ linux_user: 'root', password: '' })
    setSetupError('')
    setSetupResult(null)
  }

  const runSetup = async (e: React.FormEvent) => {
    e.preventDefault()
    setSetupStep('working')
    setSetupError('')
    try {
      const res = await api.post<{ ok: boolean; key_name: string }>(`/servers/${setupServerId}/setup`, setupForm)
      setSetupResult({ key_name: res.key_name })
      setSetupStep('done')
      load()
    } catch (err: unknown) {
      setSetupError((err as Error).message)
      setSetupStep('error')
    }
  }

  const refreshInfo = async (serverId: string) => {
    setInfoLoading(true)
    try {
      const data = await api.get<ServerInfo>(`/servers/${serverId}/info`)
      setServerInfo(data)
    } catch (err: unknown) { setInfoError((err as Error).message) }
    finally { setInfoLoading(false) }
  }

  const loadCredentials = async (serverId: string) => {
    setCredLoading(true)
    try {
      const data = await api.get<ServerCredential[]>(`/servers/${serverId}/credentials`)
      setCredentials(data)
    } catch { /* silent */ }
    finally { setCredLoading(false) }
  }

  const openInfo = async (s: Server) => {
    setInfoServer(s)
    setServerInfo(null)
    setInfoError('')
    setInfoTab('overview')
    setShowAddUser(false)
    setPushKeyTarget(null)
    setRevealedPasswords({})
    setShowCredForm(false)
    setEditCred(null)
    setSoftware([])
    setSoftwareError('')
    setServiceResults({})
    setRecommendations([])
    setRecError('')
    setRecFilter('all')
    setExpandedRec(null)
    await Promise.all([refreshInfo(s.id), loadCredentials(s.id)])
  }

  const loadRecommendations = async (serverId: string) => {
    setRecLoading(true)
    setRecError('')
    try {
      const recs = await api.get<Recommendation[]>(`/servers/${serverId}/recommendations`)
      setRecommendations(recs)
    } catch (err: unknown) {
      setRecError((err as Error).message)
    } finally {
      setRecLoading(false)
    }
  }

  const loadSoftware = async (serverId: string) => {
    setSoftwareLoading(true)
    setSoftwareError('')
    try {
      const res = await api.get<{ items: SoftwareItem[]; scanned_at: string }>(`/servers/${serverId}/software`)
      setSoftware(res.items)
    } catch (err: unknown) {
      setSoftwareError((err as Error).message)
    } finally {
      setSoftwareLoading(false)
    }
  }

  const controlService = async (serverId: string, service: string, action: 'start' | 'stop' | 'restart') => {
    const key = `${service}:${action}`
    setServiceWorking(key)
    try {
      const res = await api.post<{ new_status: string }>(`/servers/${serverId}/services/${service}/control`, { action })
      setServiceResults((prev) => ({ ...prev, [service]: res.new_status }))
      // Reload software to refresh statuses
      await loadSoftware(serverId)
    } catch (err: unknown) {
      alert(`Service control failed: ${(err as Error).message}`)
    } finally {
      setServiceWorking(null)
    }
  }

  const revealPassword = async (serverId: string, credId: string) => {
    try {
      const res = await api.post<{ password: string }>(`/servers/${serverId}/credentials/${credId}/reveal`)
      setRevealedPasswords((p) => ({ ...p, [credId]: res.password }))
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const hidePassword = (credId: string) => {
    setRevealedPasswords((p) => { const n = { ...p }; delete n[credId]; return n })
  }

  const copyPassword = async (serverId: string, credId: string) => {
    try {
      const res = await api.post<{ password: string }>(`/servers/${serverId}/credentials/${credId}/copy`)
      await navigator.clipboard.writeText(res.password)
      setCopiedCred(credId)
      setTimeout(() => setCopiedCred((c) => c === credId ? null : c), 2000)
    } catch (err: unknown) { alert('Copy failed: ' + (err as Error).message) }
  }

  const rotatePassword = async (serverId: string, credId: string, label: string, linuxUser: string) => {
    if (!confirm(`Rotate password for "${label}" (${linuxUser})?\n\nA new secure password will be generated, applied on the server via SSH, and saved to the vault. The old password will be overwritten.`)) return
    setRotatingCred(credId)
    try {
      await api.post(`/servers/${serverId}/credentials/${credId}/rotate`)
      // Clear any revealed version since it's now stale
      hidePassword(credId)
      await loadCredentials(serverId)
    } catch (err: unknown) { alert('Rotation failed: ' + (err as Error).message) }
    finally { setRotatingCred(null) }
  }

  const createCredential = async (serverId: string) => {
    setCredFormWorking(true)
    setCredFormError('')
    setCredFormApplyStatus('idle')
    setCredFormApplyWarning('')
    try {
      const res = await api.post<{ warning?: string }>(`/servers/${serverId}/credentials`, credForm)
      await loadCredentials(serverId)
      if (credForm.apply_on_server && res?.warning) {
        // Saved but SSH apply failed — stay open to show the warning
        setCredFormApplyStatus('warning')
        setCredFormApplyWarning(res.warning)
      } else if (credForm.apply_on_server) {
        setCredFormApplyStatus('ok')
        // Close after brief success display
        setTimeout(() => {
          setShowCredForm(false)
          setCredFormApplyStatus('idle')
          setCredForm({ category: 'linux', linux_user: '', service_name: '', service_username: '', label: '', password: '', notes: '', apply_on_server: false })
        }, 1500)
      } else {
        setShowCredForm(false)
        setCredForm({ category: 'linux', linux_user: '', service_name: '', service_username: '', label: '', password: '', notes: '', apply_on_server: false })
      }
    } catch (err: unknown) { setCredFormError((err as Error).message) }
    finally { setCredFormWorking(false) }
  }

  const applyCredentialToServer = async (serverId: string, credId: string, linuxUser: string, label: string) => {
    if (!confirm(`Apply password to server?\n\nThis changes the Linux OS login password for:\n  Server user: "${linuxUser}"\n  Credential: ${label}\n\nThis runs "chpasswd" on the server via SSH and does NOT affect your SSH Manager account.\n\nProceed?`)) return
    setApplyingCred(credId)
    setApplyStatus((p) => { const n = { ...p }; delete n[credId]; return n })
    try {
      await api.post(`/servers/${serverId}/credentials/${credId}/apply`)
      setApplyStatus((p) => ({ ...p, [credId]: 'ok' }))
      await loadCredentials(serverId)
      setTimeout(() => setApplyStatus((p) => { const n = { ...p }; delete n[credId]; return n }), 4000)
    } catch (err: unknown) {
      setApplyStatus((p) => ({ ...p, [credId]: 'failed' }))
      alert('Failed to apply: ' + (err as Error).message)
    }
    finally { setApplyingCred(null) }
  }

  const updateCredential = async (serverId: string, credId: string) => {
    setEditCredWorking(true)
    try {
      const body: Record<string, unknown> = {
        label: editCred!.label,
        notes: editCred!.notes ?? '',
        apply_on_server: false,
      }
      if (editCredPwd) { body.password = editCredPwd; body.apply_on_server = true }
      const res = await api.patch<{ ok: boolean; warning?: string }>(`/servers/${serverId}/credentials/${credId}`, body)
      if (res.warning) alert('⚠ ' + res.warning)
      await loadCredentials(serverId)
      setEditCred(null)
      setEditCredPwd('')
    } catch (err: unknown) { alert((err as Error).message) }
    finally { setEditCredWorking(false) }
  }

  const deleteCredential = async (serverId: string, credId: string) => {
    const cred = credentials.find((c) => c.id === credId)
    const isArchived = cred?.is_archived
    const msg = isArchived
      ? `Permanently delete this archived entry?\n\nLabel: ${cred?.label}\nThis cannot be undone.`
      : `Archive this credential?\n\nLabel: ${cred?.label}\nIt will move to the archived section where you can still reveal or permanently delete it later.`
    if (!confirm(msg)) return
    try {
      await api.delete(`/servers/${serverId}/credentials/${credId}`)
      await loadCredentials(serverId)
      setRevealedPasswords((p) => { const n = { ...p }; delete n[credId]; return n })
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const verifyCredential = async (serverId: string, credId: string) => {
    setVerifyingCred(credId)
    setVerifyCredResult((p) => { const n = { ...p }; delete n[credId]; return n })
    try {
      const res = await api.post<{ match: boolean; checked_at: string }>(`/servers/${serverId}/credentials/${credId}/verify`)
      setVerifyCredResult((p) => ({ ...p, [credId]: res.match ? 'match' : 'mismatch' }))
    } catch {
      setVerifyCredResult((p) => ({ ...p, [credId]: 'error' }))
    } finally {
      setVerifyingCred(null)
    }
  }

  const purgeAllArchivedCredentials = async (serverId: string) => {
    const archivedList = credentials.filter((c) => c.is_archived)
    if (archivedList.length === 0) return
    if (!confirm(`Permanently delete all ${archivedList.length} archived password(s) for this server?\n\nThis cannot be undone.`)) return
    try {
      await Promise.all(archivedList.map((c) => api.delete(`/servers/${serverId}/credentials/${c.id}`)))
      await loadCredentials(serverId)
      setRevealedPasswords((p) => {
        const n = { ...p }
        archivedList.forEach((c) => delete n[c.id])
        return n
      })
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const setAsManagementKey = async (serverId: string, keyId: string) => {
    setSetMgmtKeyWorking(true)
    try {
      const res = await api.patch<{ ok: boolean; key_name: string }>(`/servers/${serverId}/management-key`, { key_id: keyId })
      alert(`✓ Management key updated to "${res.key_name}"`)
      load()
      await refreshInfo(serverId)
    } catch (err: unknown) { alert('Failed: ' + (err as Error).message) }
    finally { setSetMgmtKeyWorking(false) }
  }

  const revokeAuthorizedKey = async (serverId: string, linux_user: string, key_body: string) => {
    if (!confirm(`Remove this key from ${linux_user}'s authorized_keys on the server? This cannot be undone.`)) return
    try {
      await api.delete(`/servers/${serverId}/authorized-keys`, { linux_user, key_body })
      await refreshInfo(serverId)
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const testConnection = async (id: string) => {
    setTestResults((p) => ({ ...p, [id]: 'testing' }))
    try {
      const res = await api.post<{ ok: boolean; key_name: string; is_fallback: boolean }>(`/servers/${id}/test-connection`)
      setTestResults((p) => ({ ...p, [id]: 'ok' }))
      setTestKeyInfo((p) => ({ ...p, [id]: { key_name: res.key_name, is_fallback: res.is_fallback } }))
    } catch { setTestResults((p) => ({ ...p, [id]: 'failed' })) }
  }

  const verifyHostKey = async (id: string) => {
    setVerifyResults((p) => ({ ...p, [id]: 'verifying' }))
    try {
      await api.post(`/servers/${id}/verify-host-key`)
      load()
      setVerifyResults((p) => ({ ...p, [id]: 'ok' }))
      setTimeout(() => setVerifyResults((p) => { const n = { ...p }; delete n[id]; return n }), 3000)
    } catch (err: unknown) {
      const e = err as { status?: number; data?: { error?: string } }
      if (e.status === 409) {
        setVerifyResults((p) => ({ ...p, [id]: 'mismatch' }))
        alert(`⚠ Host key mismatch detected!\n\n${e.data?.error ?? 'Fingerprint has changed — possible MITM attack.'}`)
      } else {
        setVerifyResults((p) => ({ ...p, [id]: 'failed' }))
        setTimeout(() => setVerifyResults((p) => { const n = { ...p }; delete n[id]; return n }), 3000)
      }
    }
  }

  // ── Server user management ──────────────────────────────────────────────

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault(); setAddUserError(''); setAddUserWorking(true)
    try {
      await api.post(`/servers/${infoServer!.id}/users`, addUserForm)
      setShowAddUser(false)
      setAddUserForm({ username: '', comment: '', shell: '/bin/bash', system_user: false })
      await refreshInfo(infoServer!.id)
    } catch (err: unknown) { setAddUserError((err as Error).message) }
    finally { setAddUserWorking(false) }
  }

  const deleteUser = async (username: string) => {
    const removeHome = confirm(`Delete user "${username}"?\n\nClick OK to also remove their home directory, or Cancel to keep it.\n\n(Click OK only to delete WITH home dir removal)`)
    // We need a two-step confirm since we want to ask about home dir too
    if (!window.confirm(`Are you sure you want to delete user "${username}"? This cannot be undone.`)) return
    setDeleteUserWorking(username)
    try {
      await api.delete(`/servers/${infoServer!.id}/users/${username}`, { remove_home: removeHome })
      await refreshInfo(infoServer!.id)
    } catch (err: unknown) { alert((err as Error).message) }
    finally { setDeleteUserWorking(null) }
  }

  const pushKey = async (e: React.FormEvent) => {
    e.preventDefault(); setPushKeyError(''); setPushKeyWorking(true)
    try {
      await api.post(`/servers/${infoServer!.id}/users/${pushKeyTarget}/keys`, { key_id: pushKeyId })
      setPushKeyTarget(null)
      setPushKeyId('')
      await refreshInfo(infoServer!.id)
    } catch (err: unknown) { setPushKeyError((err as Error).message) }
    finally { setPushKeyWorking(false) }
  }

  const setupServer = servers.find((s) => s.id === setupServerId)
  const envOptions = ['production', 'staging', 'development', 'other']

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Servers</h1>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors">
          + Add Server
        </button>
      </div>

      {/* overflow-x:auto lets the table scroll on narrow screens without
          breaking the outer layout; min-width keeps columns stable */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
        <table className="w-full text-xs" style={{ minWidth: 860, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
          <colgroup>
            <col style={{ width: '13%' }} />  {/* Name          */}
            <col style={{ width: '7%'  }} />  {/* OS            */}
            <col style={{ width: '10%' }} />  {/* Host          */}
            <col style={{ width: '14%' }} />  {/* Hostname      */}
            <col style={{ width: '7%'  }} />  {/* Env           */}
            <col style={{ width: '8%'  }} />  {/* Status        */}
            <col style={{ width: '7%'  }} />  {/* Added         */}
            <col style={{ width: '8%'  }} />  {/* Last Connected */}
            <col style={{ width: '26%' }} />  {/* Actions       */}
          </colgroup>
          <thead className="bg-gray-800/50">
            <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium" style={{ borderBottom: '1px solid var(--border-med)' }}>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">OS</th>
              <th className="px-3 py-2">Host Platform</th>
              <th className="px-3 py-2">Hostname</th>
              <th className="px-3 py-2">Env</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Added</th>
              <th className="px-3 py-2">Last Connected</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="hover:bg-gray-800/30 transition-colors"
                style={{ borderBottom: '1px solid var(--border-weak)' }}>
                <td className="px-3 py-2 text-white font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</td>
                <td className="px-3 py-2">
                  {s.os_type === 'windows'
                    ? <span className="inline-flex items-center gap-1 text-xs text-blue-300 bg-blue-900/30 border border-blue-700/40 rounded px-1.5 py-0.5 font-medium" style={{ whiteSpace: 'nowrap' }}>🪟 Windows</span>
                    : s.os_type === 'linux'
                      ? <span className="inline-flex items-center gap-1 text-xs text-green-300 bg-green-900/30 border border-green-700/40 rounded px-1.5 py-0.5 font-medium" style={{ whiteSpace: 'nowrap' }}>🐧 Linux</span>
                      : <span className="text-xs text-gray-500">—</span>
                  }
                </td>
                <td className="px-3 py-2" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <HostBadge type={s.host_type} detail={s.host_type_detail} />
                </td>
                <td className="px-3 py-2 text-gray-300 font-mono text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.hostname}:{s.ssh_port}</td>
                <td className="px-3 py-2"><Badge label={s.environment} /></td>
                <td className="px-3 py-2">
                  {!s.management_key_id
                    ? <Badge label="Not set up" variant="high" />
                    : s.host_key_verified
                      ? <Badge label="Ready" variant="ok" />
                      : <Badge label="Unverified" variant="medium" />}
                </td>
                <td className="px-3 py-2 text-gray-400 text-xs" title={new Date(s.created_at).toLocaleString()}>{new Date(s.created_at).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-gray-400 text-xs">{s.last_connected_at ? new Date(s.last_connected_at).toLocaleDateString() : <span className="text-gray-600">Never</span>}</td>
                <td className="px-3 py-2">
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'center' }}>
                    {!s.management_key_id ? (
                      <button onClick={() => openSetup(s.id)}
                        className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium whitespace-nowrap">
                        ⚙ Setup
                      </button>
                    ) : (
                      <button onClick={() => testConnection(s.id)}
                        title={
                          testResults[s.id] === 'ok' && testKeyInfo[s.id]
                            ? `${testKeyInfo[s.id].is_fallback ? '⚠ Fallback key' : '🔑 Key'}: ${testKeyInfo[s.id].key_name}`
                            : testResults[s.id] === 'failed'
                            ? 'Connection failed — check server SSH config'
                            : 'Test SSH connection to this server'
                        }
                        className={`px-2 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                          testResults[s.id] === 'ok'
                            ? testKeyInfo[s.id]?.is_fallback ? 'bg-yellow-700 text-white' : 'bg-green-700 text-white'
                            : testResults[s.id] === 'failed' ? 'bg-red-700 text-white'
                            : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                        {testResults[s.id] === 'testing' ? '…'
                          : testResults[s.id] === 'ok' ? (testKeyInfo[s.id]?.is_fallback ? '⚠ OK' : '✓ OK')
                          : testResults[s.id] === 'failed' ? '✗ Fail'
                          : 'Test'}
                      </button>
                    )}
                    <button onClick={() => verifyHostKey(s.id)} disabled={verifyResults[s.id] === 'verifying'}
                      className={`px-2 py-1 text-xs rounded transition-colors disabled:opacity-60 whitespace-nowrap ${
                        verifyResults[s.id] === 'ok' ? 'bg-green-700 text-white'
                        : verifyResults[s.id] === 'mismatch' || verifyResults[s.id] === 'failed' ? 'bg-red-700 text-white'
                        : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                      {verifyResults[s.id] === 'verifying' ? '…' : verifyResults[s.id] === 'ok' ? '✓ Verified'
                        : verifyResults[s.id] === 'mismatch' ? '✗ Mismatch' : verifyResults[s.id] === 'failed' ? '✗ Failed' : 'Verify'}
                    </button>
                    <button onClick={() => openEdit(s)}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors whitespace-nowrap">
                      Edit
                    </button>
                    {s.management_key_id && (
                      <button onClick={() => openInfo(s)}
                        className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors whitespace-nowrap">
                        Info
                      </button>
                    )}
                    <button onClick={() => deleteServer(s)}
                      className="px-2 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors whitespace-nowrap">
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {servers.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-gray-500">
                  No servers registered. Click "+ Add Server" to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add Server Modal */}
      {showAdd && (
        <Modal title="Add Server" onClose={() => setShowAdd(false)}>
          <form onSubmit={addServer} className="space-y-3">
            {addError && <p className="text-red-400 text-sm">{addError}</p>}
            <p className="text-gray-400 text-xs">Fill in the server details. You'll configure SSH access in the next step.</p>
            {([['Name', 'name', 'text'], ['Hostname / IP', 'hostname', 'text'], ['SSH Port', 'ssh_port', 'number']] as const).map(([label, field, type]) => (
              <label key={field} className="block">
                <span className="text-sm text-gray-400">{label}</span>
                <input type={type} value={String((addForm as Record<string, unknown>)[field])}
                  onChange={(e) => setAddForm((f) => ({ ...f, [field]: type === 'number' ? Number(e.target.value) : e.target.value }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" required />
              </label>
            ))}
            <label className="block">
              <span className="text-sm text-gray-400">Environment</span>
              <select value={addForm.environment} onChange={(e) => setAddForm((f) => ({ ...f, environment: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {envOptions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowAdd(false)} className="flex-1 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Add Server</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit Server Modal */}
      {editServer && (
        <Modal title={`Edit Server — ${editServer.name}`} onClose={() => setEditServer(null)}>
          <form onSubmit={saveEdit} className="space-y-3">
            {editError && <p className="text-red-400 text-sm">{editError}</p>}
            {([['Name', 'name', 'text'], ['Hostname / IP', 'hostname', 'text'], ['SSH Port', 'ssh_port', 'number']] as const).map(([label, field, type]) => (
              <label key={field} className="block">
                <span className="text-sm text-gray-400">{label}</span>
                <input type={type} value={String((editForm as Record<string, unknown>)[field])}
                  onChange={(e) => setEditForm((f) => ({ ...f, [field]: type === 'number' ? Number(e.target.value) : e.target.value }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" required />
              </label>
            ))}
            <label className="block">
              <span className="text-sm text-gray-400">Environment</span>
              <select value={editForm.environment} onChange={(e) => setEditForm((f) => ({ ...f, environment: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {envOptions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setEditServer(null)} className="flex-1 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Save Changes</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Server Info Modal */}
      {infoServer && (
        <Modal title={`Server Info — ${infoServer.name}`} onClose={() => setInfoServer(null)} size="lg">
          {infoLoading && !serverInfo && (
            <div className="py-8 text-center space-y-3">
              <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-gray-300 text-sm">Connecting and gathering system info…</p>
            </div>
          )}
          {infoError && <p className="text-red-400 text-sm py-4">{infoError}</p>}
          {serverInfo && (
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {/* Tabs */}
              <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-med)', flexShrink: 0, flexWrap: 'wrap' }}>
                {(['overview', 'users', 'keys', 'credentials', 'software', 'recommendations'] as const).map((t) => (
                  <button key={t}
                    onClick={() => {
                      setInfoTab(t as typeof infoTab)
                      setShowAddUser(false)
                      setPushKeyTarget(null)
                      if (t === 'software' && software.length === 0 && !softwareLoading) {
                        loadSoftware(infoServer!.id)
                      }
                      if (t === 'recommendations' && recommendations.length === 0 && !recLoading) {
                        loadRecommendations(infoServer!.id)
                      }
                    }}
                    style={{
                      padding: '9px 14px',
                      fontSize: 13, fontWeight: 500,
                      cursor: 'pointer', background: 'none', border: 'none',
                      borderBottom: infoTab === t ? '2px solid var(--accent-hex)' : '2px solid transparent',
                      color: infoTab === t ? 'var(--accent-hex)' : 'var(--text-secondary)',
                      marginBottom: -1,
                      transition: 'color 0.1s',
                      whiteSpace: 'nowrap',
                    }}>
                    {t === 'keys' ? 'Auth Keys'
                      : t === 'users' ? `Users (${serverInfo.users.length})`
                      : t === 'credentials' ? `Vault (${credentials.filter((c) => !c.is_archived).length})`
                      : t === 'software' ? '📦 Software'
                      : t === 'recommendations' ? '💡 Best Practices'
                      : 'Overview'}
                  </button>
                ))}
              </div>

              {/* Tab content — fixed height with scroll so modal doesn't grow unbounded */}
              <div style={{ minHeight: 420, maxHeight: 520, overflowY: 'auto', paddingTop: 16 }}>

              {/* Overview Tab */}
              {infoTab === 'overview' && (
                <div className="space-y-3 text-sm">
                  {/* Active key banner */}
                  <div className={`rounded-lg p-3 flex items-start justify-between gap-2 ${serverInfo.active_key_is_fallback ? 'bg-yellow-900/40 border border-yellow-700/50' : 'bg-gray-800'}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{serverInfo.active_key_is_fallback ? '⚠' : '🔑'}</span>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Connected via</p>
                        <p className={`font-medium ${serverInfo.active_key_is_fallback ? 'text-yellow-300' : 'text-white'}`}>{serverInfo.active_key_name}</p>
                        {serverInfo.active_key_is_fallback && (
                          <p className="text-yellow-400 text-xs mt-0.5">Management key failed — fallback key used. Promote the current key to fix this.</p>
                        )}
                      </div>
                    </div>
                    {serverInfo.active_key_is_fallback && serverInfo.active_key_id && (
                      <button
                        onClick={() => setAsManagementKey(infoServer!.id, serverInfo.active_key_id)}
                        disabled={setMgmtKeyWorking}
                        className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-yellow-600 hover:bg-yellow-500 text-white font-medium transition-colors disabled:opacity-50">
                        {setMgmtKeyWorking ? 'Updating…' : '🔒 Set as Management Key'}
                      </button>
                    )}
                  </div>
                  <div className="bg-gray-800 rounded-lg p-3 space-y-2" style={{ overflow: 'hidden' }}>
                    <p className="text-gray-400 text-xs font-medium uppercase tracking-wide flex items-center gap-1.5">
                      {serverInfo.os_type === 'windows' ? '🪟' : '🐧'} Operating System
                    </p>
                    <p className="text-white font-medium">{serverInfo.os.pretty_name || serverInfo.os.name}</p>
                    {serverInfo.os_type === 'windows' && serverInfo.os.edition && (
                      <p className="text-gray-400 text-xs">Edition: <span className="text-gray-200">{serverInfo.os.edition}</span></p>
                    )}
                    {serverInfo.os.version && <p className="text-gray-400 text-xs">Version: {serverInfo.os.version}</p>}
                    <p className="text-gray-400 font-mono text-xs" style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>
                      {serverInfo.os_type === 'windows' ? 'Build' : 'Kernel'}: {serverInfo.os.kernel.trim()}
                    </p>
                    {serverInfo.hostname && (
                      <p className="text-gray-400 text-xs">Hostname: <span className="text-gray-200 font-mono">{serverInfo.hostname}</span>
                        {serverInfo.domain && <span className="text-gray-500"> ({serverInfo.domain})</span>}
                      </p>
                    )}
                  </div>
                  {serverInfo.virt && (
                    <div className="bg-gray-800 rounded-lg p-3 space-y-2" style={{ overflow: 'hidden' }}>
                      <p className="text-gray-400 text-xs font-medium uppercase tracking-wide">Host Platform</p>
                      <div className="flex items-center gap-2">
                        <HostBadge type={serverInfo.virt.host_type} detail={serverInfo.virt.detail} />
                        {serverInfo.virt.detail && (
                          <span className="text-gray-400 text-xs">{serverInfo.virt.detail}</span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="bg-gray-800 rounded-lg p-3 space-y-2" style={{ overflow: 'hidden' }}>
                    <p className="text-gray-400 text-xs font-medium uppercase tracking-wide">System</p>
                    <p className="text-gray-300 text-xs">Uptime: <span className="text-white">{serverInfo.uptime.trim()}</span></p>
                    <p className="text-gray-300 text-xs" style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>Memory: <span className="text-white font-mono text-xs">{serverInfo.memory.trim()}</span></p>
                    {serverInfo.cpu_count != null && (
                      <p className="text-gray-300 text-xs">CPU Cores: <span className="text-white">{serverInfo.cpu_count}</span></p>
                    )}
                  </div>
                  {/* Windows Server Roles */}
                  {serverInfo.os_type === 'windows' && (serverInfo.roles?.length ?? 0) > 0 && (
                    <div className="bg-gray-800 rounded-lg p-3 space-y-2">
                      <p className="text-gray-400 text-xs font-medium uppercase tracking-wide">Installed Roles & Features</p>
                      <div className="flex flex-wrap gap-1.5">
                        {serverInfo.roles!.slice(0, 30).map((role) => (
                          <span key={role} className="text-xs px-2 py-0.5 rounded bg-blue-900/40 border border-blue-700/50 text-blue-300 font-mono">
                            {role}
                          </span>
                        ))}
                        {(serverInfo.roles!.length > 30) && (
                          <span className="text-xs text-gray-500">+{serverInfo.roles!.length - 30} more</span>
                        )}
                      </div>
                    </div>
                  )}
                  {serverInfo.logged_in.length > 0 && (
                    <div className="bg-gray-800 rounded-lg p-3 space-y-2">
                      <p className="text-gray-400 text-xs font-medium uppercase tracking-wide">Currently Logged In</p>
                      {serverInfo.logged_in.map((line, i) => (
                        <p key={i} className="text-gray-300 font-mono text-xs">{line}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Users Tab */}
              {infoTab === 'users' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">{serverInfo?.os_type === 'windows' ? 'Local user accounts on this Windows Server.' : 'Linux users with uid ≥ 1000 (and root). Click a row to push an SSH key or delete.'}</p>
                    <button onClick={() => { setShowAddUser(true); setPushKeyTarget(null) }}
                      className="px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium">
                      + Add User
                    </button>
                  </div>

                  {/* Add User Form */}
                  {showAddUser && (
                    <form onSubmit={createUser} className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-3">
                      <p className="text-sm font-medium text-white">Create Linux User</p>
                      {addUserError && <p className="text-red-400 text-xs">{addUserError}</p>}
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block col-span-2">
                          <span className="text-xs text-gray-400">Username <span className="text-gray-600">(lowercase, no spaces)</span></span>
                          <input value={addUserForm.username} onChange={(e) => setAddUserForm((f) => ({ ...f, username: e.target.value }))}
                            pattern="^[a-z_][a-z0-9_-]*$" required placeholder="e.g. deploy, dbadmin"
                            className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block">
                          <span className="text-xs text-gray-400">Full Name / Comment</span>
                          <input value={addUserForm.comment} onChange={(e) => setAddUserForm((f) => ({ ...f, comment: e.target.value }))}
                            placeholder="Optional"
                            className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block">
                          <span className="text-xs text-gray-400">Shell</span>
                          <select value={addUserForm.shell} onChange={(e) => setAddUserForm((f) => ({ ...f, shell: e.target.value }))}
                            className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                            <option value="/bin/bash">/bin/bash</option>
                            <option value="/bin/sh">/bin/sh</option>
                            <option value="/usr/sbin/nologin">/usr/sbin/nologin (no login)</option>
                            <option value="/bin/false">/bin/false (no login)</option>
                          </select>
                        </label>
                      </div>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={addUserForm.system_user} onChange={(e) => setAddUserForm((f) => ({ ...f, system_user: e.target.checked }))} className="rounded" />
                        <span className="text-xs text-gray-400">System user <span className="text-gray-600">(uid &lt; 1000, no home dir, for services/daemons)</span></span>
                      </label>
                      <div className="flex gap-2 pt-1">
                        <button type="button" onClick={() => setShowAddUser(false)} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                        <button type="submit" disabled={addUserWorking}
                          className="flex-1 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors disabled:opacity-50">
                          {addUserWorking ? 'Creating…' : 'Create User'}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Push Key Form */}
                  {pushKeyTarget && (
                    <form onSubmit={pushKey} className="bg-gray-800 border border-indigo-700 rounded-lg p-3 space-y-3">
                      <p className="text-sm font-medium text-white">Push SSH Key → <span className="text-indigo-300 font-mono">{pushKeyTarget}</span></p>
                      {pushKeyError && <p className="text-red-400 text-xs">{pushKeyError}</p>}
                      <label className="block">
                        <span className="text-xs text-gray-400">Select SSH Key from vault</span>
                        <select value={pushKeyId} onChange={(e) => setPushKeyId(e.target.value)} required
                          className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                          <option value="">— choose key —</option>
                          {allKeys.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.key_type})</option>)}
                        </select>
                      </label>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => { setPushKeyTarget(null); setPushKeyId('') }} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                        <button type="submit" disabled={pushKeyWorking || !pushKeyId}
                          className="flex-1 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors disabled:opacity-50">
                          {pushKeyWorking ? 'Pushing…' : 'Push Key'}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* User table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-gray-400 text-xs border-b border-gray-700">
                          <th className="pb-2 pr-3">Username</th>
                          <th className="pb-2 pr-3">UID</th>
                          <th className="pb-2 pr-3">Home</th>
                          <th className="pb-2 pr-3">Shell</th>
                          <th className="pb-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {serverInfo.users.map((u) => {
                          const isProtected = u.uid === 0 || u.username === 'root'
                          const noLoginShell = u.shell.includes('nologin') || u.shell === '/bin/false'
                          return (
                            <tr key={u.username} className="text-gray-300 hover:bg-gray-800/30">
                              <td className="py-2 pr-3 font-medium text-white font-mono text-xs">
                                {u.username}
                                {isProtected && <span className="ml-1.5 text-xs text-yellow-500">root</span>}
                                {noLoginShell && <span className="ml-1.5 text-xs text-gray-600">no-login</span>}
                              </td>
                              <td className="py-2 pr-3 font-mono text-xs text-gray-500">{u.uid}</td>
                              <td className="py-2 pr-3 font-mono text-xs text-gray-400">{u.home || '—'}</td>
                              <td className="py-2 pr-3 font-mono text-xs text-gray-500">{u.shell.split('/').pop()}</td>
                              <td className="py-2">
                                <div className="flex gap-1.5">
                                  <button
                                    onClick={() => { setPushKeyTarget(u.username); setShowAddUser(false); setPushKeyId(''); setPushKeyError('') }}
                                    className="px-2 py-0.5 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
                                    Push Key
                                  </button>
                                  {!isProtected && (
                                    <button
                                      onClick={() => deleteUser(u.username)}
                                      disabled={deleteUserWorking === u.username}
                                      className="px-2 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors disabled:opacity-50">
                                      {deleteUserWorking === u.username ? '…' : 'Delete'}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {serverInfo.users.length === 0 && <p className="text-gray-500 text-sm py-4 text-center">No users found</p>}
                  </div>
                </div>
              )}

              {/* Authorized Keys Tab */}
              {infoTab === 'keys' && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">Keys currently in <span className="font-mono">authorized_keys</span> on the server. Known keys are matched against your SSH Keys database.</p>
                  {serverInfo.authorized_keys.length === 0 && (
                    <p className="text-gray-500 text-sm py-4 text-center">No authorized keys found</p>
                  )}
                  {serverInfo.authorized_keys.map((k, i) => {
                    const isManagementKey = k.db_key_id !== null && k.db_key_id === serverInfo.management_key_id
                    const isArchived = k.is_archived
                    const borderClass = isArchived
                      ? 'bg-orange-950/30 border-orange-700/60'
                      : k.is_known ? 'bg-gray-800 border-gray-700'
                      : 'bg-red-950/30 border-red-800/60'
                    return (
                      <div key={i} className={`rounded-lg border p-3 space-y-1.5 ${borderClass}`}>
                        {isArchived && (
                          <div className="flex items-center gap-2 text-orange-400 text-xs bg-orange-900/30 rounded px-2 py-1.5">
                            <span>⚠</span>
                            <span><strong>Archived key still on server.</strong> This key was rotated or deleted from the vault but is still authorized on this server. Revoke it to close the access gap.</span>
                          </div>
                        )}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-700 text-indigo-300">{k.key_type}</span>
                            <span className="text-xs text-gray-400">for <span className="text-white font-medium font-mono">{k.linux_user}</span></span>
                            {isArchived ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-300 border border-orange-700">🗄 {k.db_key_name} (archived)</span>
                            ) : k.is_known ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/50 text-green-400 border border-green-800">✓ {k.db_key_name}</span>
                            ) : (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/50 text-red-400 border border-red-800">⚠ Unknown key</span>
                            )}
                            {isManagementKey && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-800">🔒 Management key</span>
                            )}
                          </div>
                          <button
                            disabled={isManagementKey}
                            onClick={() => revokeAuthorizedKey(infoServer!.id, k.linux_user, k.key_body)}
                            title={isManagementKey ? 'Cannot remove — this is the active management key' : 'Remove from authorized_keys'}
                            className={`shrink-0 px-2 py-1 text-xs rounded transition-colors font-medium ${
                              isManagementKey ? 'bg-gray-700/40 text-gray-500 cursor-not-allowed'
                              : isArchived ? 'bg-orange-700 hover:bg-orange-600 text-white cursor-pointer'
                              : 'bg-red-700 hover:bg-red-600 text-white cursor-pointer'}`}>
                            Revoke
                          </button>
                        </div>
                        {k.comment && <p className="text-xs text-gray-400">Comment: <span className="text-gray-300 font-mono">{k.comment}</span></p>}
                        <p className="text-xs font-mono text-gray-500 break-all">Fingerprint: <span className="text-gray-400">{k.fingerprint || '—'}</span></p>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Credentials / Password Vault Tab */}
              {infoTab === 'credentials' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">Passwords are encrypted with AES-256-GCM and stored in the vault. Reveal is audit-logged.</p>
                    <button onClick={() => { setShowCredForm(true); setCredForm({ category: 'linux', linux_user: '', service_name: '', service_username: '', label: '', password: '', notes: '', apply_on_server: false }) }}
                      className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors">
                      + Add Credential
                    </button>
                  </div>

                  {/* Add credential form */}
                  {showCredForm && (() => {
                    const CATEGORIES: { value: CredentialCategory; label: string; icon: string }[] = [
                      { value: 'linux', label: 'Linux User', icon: '🐧' },
                      { value: 'database', label: 'Database', icon: '🗄' },
                      { value: 'web', label: 'Web Server', icon: '🌐' },
                      { value: 'application', label: 'Application', icon: '📦' },
                      { value: 'service', label: 'Service', icon: '⚙' },
                      { value: 'other', label: 'Other', icon: '🔑' },
                    ]
                    const cat = credForm.category
                    const isLinux = cat === 'linux'
                    const isDb = cat === 'database'
                    const canApply = isLinux && !!credForm.linux_user
                    const DB_SERVICES = ['MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'MariaDB', 'SQLite', 'MS SQL Server', 'Oracle']
                    const WEB_SERVICES = ['Nginx', 'Apache', 'Caddy', 'Traefik', 'HAProxy']
                    const SERVICE_SUGGESTIONS = isDb ? DB_SERVICES : cat === 'web' ? WEB_SERVICES : []
                    return (
                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 space-y-3">
                      <p className="text-sm font-medium text-white">New Credential</p>
                      {credFormError && <p className="text-red-400 text-xs">{credFormError}</p>}

                      {/* Category picker */}
                      <div>
                        <span className="text-xs text-gray-400 block mb-1.5">Category</span>
                        <div className="flex flex-wrap gap-1.5">
                          {CATEGORIES.map((c) => (
                            <button key={c.value} type="button"
                              onClick={() => setCredForm((f) => ({ ...f, category: c.value }))}
                              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${credForm.category === c.value ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600'}`}>
                              {c.icon} {c.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        {/* Linux user (linux category only) */}
                        {isLinux && (
                          <label className="block">
                            <span className="text-xs text-gray-400">Linux OS Username</span>
                            <input value={credForm.linux_user} onChange={(e) => setCredForm((f) => ({ ...f, linux_user: e.target.value }))}
                              placeholder="e.g. root, ubuntu, deploy" list="cred-users"
                              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            <datalist id="cred-users">
                              {serverInfo && serverInfo.users.map((u) => <option key={u.username} value={u.username} />)}
                            </datalist>
                            {credForm.linux_user.includes('@') ? (
                              <p className="text-xs text-red-400 mt-1">⚠ This looks like an email — enter the Linux OS username (e.g. <strong>root</strong>), not your SSH Manager login.</p>
                            ) : (
                              <p className="text-xs text-gray-600 mt-1">OS username on the server, not your SSH Manager email</p>
                            )}
                          </label>
                        )}

                        {/* Service name (non-linux) */}
                        {!isLinux && (
                          <label className="block">
                            <span className="text-xs text-gray-400">Service Name</span>
                            <input value={credForm.service_name} onChange={(e) => setCredForm((f) => ({ ...f, service_name: e.target.value }))}
                              placeholder={isDb ? 'e.g. MySQL, PostgreSQL' : 'e.g. Nginx, Redis'}
                              list="cred-services"
                              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            <datalist id="cred-services">
                              {SERVICE_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
                            </datalist>
                          </label>
                        )}

                        {/* Service username (non-linux) */}
                        {!isLinux && (
                          <label className="block">
                            <span className="text-xs text-gray-400">Username</span>
                            <input value={credForm.service_username} onChange={(e) => setCredForm((f) => ({ ...f, service_username: e.target.value }))}
                              placeholder={isDb ? 'e.g. root, admin' : 'e.g. admin'}
                              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                          </label>
                        )}

                        <label className={`block ${isLinux ? '' : 'col-span-2'}`}>
                          <span className="text-xs text-gray-400">Label <span className="text-gray-600">(description)</span></span>
                          <input value={credForm.label} onChange={(e) => setCredForm((f) => ({ ...f, label: e.target.value }))}
                            placeholder={isLinux ? 'e.g. root password' : isDb ? 'e.g. DB admin password' : 'e.g. Panel login'}
                            className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                      </div>

                      <label className="block">
                        <span className="text-xs text-gray-400">Password</span>
                        <input type="password" value={credForm.password} onChange={(e) => setCredForm((f) => ({ ...f, password: e.target.value }))}
                          className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        {credForm.password && (
                          <span className={`text-xs mt-1 inline-block ${credForm.password.length < 8 ? 'text-red-400' : credForm.password.length < 12 ? 'text-yellow-400' : 'text-green-400'}`}>
                            {credForm.password.length < 8 ? '⚠ Too short' : credForm.password.length < 12 ? 'Fair' : '✓ Strong'}
                          </span>
                        )}
                      </label>
                      <label className="block">
                        <span className="text-xs text-gray-400">Notes (optional)</span>
                        <input value={credForm.notes} onChange={(e) => setCredForm((f) => ({ ...f, notes: e.target.value }))}
                          placeholder={isDb ? 'e.g. port 3306, db name: myapp' : ''}
                          className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                      </label>
                      {canApply && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={credForm.apply_on_server} onChange={(e) => { setCredForm((f) => ({ ...f, apply_on_server: e.target.checked })); setCredFormApplyStatus('idle') }}
                            className="rounded" />
                          <span className="text-sm text-gray-300">Apply password on server now (runs <code className="text-indigo-300">chpasswd</code> via SSH)</span>
                        </label>
                      )}
                      {/* Apply status feedback */}
                      {credFormApplyStatus === 'ok' && (
                        <div className="flex items-center gap-2 bg-green-900/30 border border-green-700/50 rounded-lg px-3 py-2 text-green-300 text-sm">
                          <span>✓</span><span>Password saved to vault and successfully applied on the server.</span>
                        </div>
                      )}
                      {credFormApplyStatus === 'warning' && (
                        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-lg px-3 py-2 space-y-1">
                          <p className="text-yellow-300 text-sm font-medium">⚠ Saved to vault, but SSH apply failed</p>
                          <p className="text-yellow-400 text-xs">{credFormApplyWarning}</p>
                          <p className="text-gray-400 text-xs">The password is safely stored in the vault. You can apply it later using the "Apply to Server" button on the credential card.</p>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => createCredential(infoServer!.id)} disabled={credFormWorking || !credForm.label || !credForm.password || credFormApplyStatus === 'ok'}
                          className={`px-4 py-2 disabled:opacity-50 text-white text-sm rounded-lg transition-colors ${credFormWorking ? 'bg-indigo-700' : 'bg-indigo-600 hover:bg-indigo-500'}`}>
                          {credFormWorking ? (credForm.apply_on_server ? '⟳ Saving & applying…' : 'Saving…') : 'Save to Vault'}
                        </button>
                        <button onClick={() => { setShowCredForm(false); setCredFormApplyStatus('idle') }} className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded-lg transition-colors">Cancel</button>
                      </div>
                    </div>
                    )
                  })()}

                  {credLoading && <p className="text-gray-500 text-sm text-center py-4">Loading…</p>}

                  {/* Active credentials */}
                  {!credLoading && credentials.filter((c) => !c.is_archived).length === 0 && !showCredForm && (
                    <p className="text-gray-500 text-sm text-center py-6">No credentials stored yet. Click "Add Credential" to save a password.</p>
                  )}

                  {(() => {
                    const CATEGORY_META: Record<string, { icon: string; label: string }> = {
                      linux: { icon: '🐧', label: 'Linux User' },
                      database: { icon: '🗄', label: 'Database' },
                      web: { icon: '🌐', label: 'Web Server' },
                      application: { icon: '📦', label: 'Application' },
                      service: { icon: '⚙', label: 'Service' },
                      other: { icon: '🔑', label: 'Other' },
                    }
                    const active = credentials.filter((c) => !c.is_archived)
                    // Group by category
                    const grouped = active.reduce<Record<string, ServerCredential[]>>((acc, c) => {
                      const cat = c.category ?? 'linux'
                      ;(acc[cat] ??= []).push(c)
                      return acc
                    }, {})
                    const catOrder = ['linux', 'database', 'web', 'application', 'service', 'other']
                    return catOrder.filter((cat) => grouped[cat]?.length).map((cat) => (
                      <div key={cat} className="space-y-2">
                        <p className="text-xs font-medium text-gray-500 flex items-center gap-1.5 pt-1">
                          <span>{CATEGORY_META[cat]?.icon}</span>
                          <span className="uppercase tracking-wide">{CATEGORY_META[cat]?.label}</span>
                          <span className="text-gray-700">({grouped[cat].length})</span>
                        </p>
                        {grouped[cat].map((c) => {
                    const isRevealed = !!revealedPasswords[c.id]
                    const isCopied = copiedCred === c.id
                    const isRotating = rotatingCred === c.id
                    const isApplying = applyingCred === c.id
                    const isVerifying = verifyingCred === c.id
                    const thisApplyStatus = applyStatus[c.id]
                    const thisVerifyResult = verifyCredResult[c.id]
                    const neverApplied = !c.last_changed_on_server_at && c.category === 'linux'
                    const canApplyToServer = c.category === 'linux' && !!c.linux_user && !c.is_archived
                    return (
                    <div key={c.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2">
                      {editCred?.id === c.id ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <label className="block">
                              <span className="text-xs text-gray-400">Label</span>
                              <input value={editCred.label} onChange={(e) => setEditCred({ ...editCred, label: e.target.value })}
                                className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            </label>
                            <label className="block">
                              <span className="text-xs text-gray-400">New Password (leave blank to keep)</span>
                              <input type="password" value={editCredPwd} onChange={(e) => setEditCredPwd(e.target.value)}
                                placeholder="••••••••"
                                className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            </label>
                          </div>
                          <label className="block">
                            <span className="text-xs text-gray-400">Notes</span>
                            <input value={editCred.notes ?? ''} onChange={(e) => setEditCred({ ...editCred, notes: e.target.value })}
                              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                          </label>
                          {editCredPwd && (
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={credForm.apply_on_server} onChange={(e) => setCredForm((f) => ({ ...f, apply_on_server: e.target.checked }))} className="rounded" />
                              <span className="text-xs text-gray-300">Apply new password on server via SSH now</span>
                            </label>
                          )}
                          <div className="flex gap-2">
                            <button onClick={() => updateCredential(infoServer!.id, c.id)} disabled={editCredWorking}
                              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs rounded-lg transition-colors">
                              {editCredWorking ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={() => { setEditCred(null); setEditCredPwd('') }} className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white text-xs rounded-lg transition-colors">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {/* Header row — label + badges + compact actions */}
                          <div className="flex items-center justify-between gap-3">
                            {/* Left: identity */}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-white font-semibold text-sm">{c.label}</span>
                                {c.category === 'linux' && c.linux_user && (
                                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-700 text-indigo-300">{c.linux_user}</span>
                                )}
                                {c.service_name && (
                                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-blue-300">{c.service_name}</span>
                                )}
                                {c.service_username && (
                                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-400">@{c.service_username}</span>
                                )}
                                {/* Verify status badge */}
                                {canApplyToServer && (
                                  <button
                                    onClick={() => verifyCredential(infoServer!.id, c.id)}
                                    disabled={isVerifying}
                                    title={
                                      thisVerifyResult === 'match' ? 'Password matches server — click to re-check'
                                      : thisVerifyResult === 'mismatch' ? 'Mismatch! Password was changed on server directly — click to re-check'
                                      : thisVerifyResult === 'error' ? 'Could not verify (password auth may be disabled) — click to retry'
                                      : 'Check if vault password matches the server'
                                    }
                                    style={{ border: 'none', padding: '2px 6px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 500 }}
                                    className={`transition-colors disabled:opacity-50 ${
                                      thisVerifyResult === 'match' ? 'bg-green-700 text-white'
                                      : thisVerifyResult === 'mismatch' ? 'bg-red-700 text-white'
                                      : thisVerifyResult === 'error' ? 'bg-yellow-600 text-white'
                                      : 'bg-gray-600 hover:bg-gray-500 text-gray-200'}`}>
                                    {isVerifying ? '⟳'
                                      : thisVerifyResult === 'match' ? '✓ Match'
                                      : thisVerifyResult === 'mismatch' ? '⚠ Mismatch'
                                      : thisVerifyResult === 'error' ? '? N/A'
                                      : '⊘ Verify'}
                                  </button>
                                )}
                                {neverApplied && !thisVerifyResult && (
                                  <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-500 border border-yellow-800/50" title="Never pushed to server">vault only</span>
                                )}
                              </div>
                              {c.notes && <p className="text-gray-500 text-xs mt-0.5 truncate">{c.notes}</p>}
                            </div>

                            {/* Right: primary actions + overflow menu */}
                            <div className="flex items-center gap-1 shrink-0">
                              {/* Reveal */}
                              <button
                                onClick={() => isRevealed ? hidePassword(c.id) : revealPassword(infoServer!.id, c.id)}
                                className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${isRevealed ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                                {isRevealed ? '🙈 Hide' : '👁 Reveal'}
                              </button>
                              {/* Copy */}
                              <button
                                onClick={() => copyPassword(infoServer!.id, c.id)}
                                className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${isCopied ? 'bg-green-700 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                                {isCopied ? '✓' : '📋 Copy'}
                              </button>
                              {/* ⋯ overflow menu */}
                              <div style={{ position: 'relative' }}>
                                <button
                                  onClick={() => setOpenCredMenu(openCredMenu === c.id ? null : c.id)}
                                  className="px-2 py-1 text-xs rounded-lg bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                                  title="More actions">
                                  ⋯
                                </button>
                                {openCredMenu === c.id && (
                                  <>
                                    {/* backdrop to close */}
                                    <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setOpenCredMenu(null)} />
                                    <div style={{
                                      position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
                                      background: 'var(--bg-elevated)', border: '1px solid var(--border-med)',
                                      borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                                      minWidth: 180, overflow: 'hidden',
                                    }}>
                                      {canApplyToServer && (
                                        <button
                                          onClick={() => { setOpenCredMenu(null); applyCredentialToServer(infoServer!.id, c.id, c.linux_user ?? '', c.label) }}
                                          disabled={isApplying}
                                          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                                          className={`hover:bg-gray-700/60 transition-colors disabled:opacity-50 ${
                                            thisApplyStatus === 'ok' ? 'text-green-400'
                                            : thisApplyStatus === 'failed' ? 'text-red-400'
                                            : neverApplied ? 'text-orange-300'
                                            : 'text-gray-300'}`}>
                                          <span>🖥</span>
                                          <span>
                                            {isApplying ? 'Applying…'
                                              : thisApplyStatus === 'ok' ? 'Applied ✓'
                                              : thisApplyStatus === 'failed' ? 'Apply failed ✗'
                                              : `Apply to server`}
                                          </span>
                                          {c.linux_user && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>{c.linux_user}</span>}
                                        </button>
                                      )}
                                      {canApplyToServer && (
                                        <button
                                          onClick={() => { setOpenCredMenu(null); rotatePassword(infoServer!.id, c.id, c.label, c.linux_user ?? c.service_username ?? c.service_name ?? '') }}
                                          disabled={isRotating}
                                          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                                          className="text-gray-300 hover:bg-gray-700/60 transition-colors disabled:opacity-50">
                                          <span>⟳</span><span>{isRotating ? 'Rotating…' : 'Rotate password'}</span>
                                        </button>
                                      )}
                                      <div style={{ height: 1, background: 'var(--border-weak)', margin: '2px 0' }} />
                                      <button
                                        onClick={() => { setOpenCredMenu(null); setEditCred(c); setEditCredPwd('') }}
                                        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                                        className="text-gray-300 hover:bg-gray-700/60 transition-colors">
                                        <span>✏</span><span>Edit</span>
                                      </button>
                                      <button
                                        onClick={() => { setOpenCredMenu(null); deleteCredential(infoServer!.id, c.id) }}
                                        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                                        className="text-red-400 hover:bg-red-900/30 transition-colors">
                                        <span>🗄</span><span>Archive</span>
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Password mismatch alert */}
                          {thisVerifyResult === 'mismatch' && (
                            <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs bg-red-900/30 border border-red-700/40 text-red-300">
                              <span>⚠</span>
                              <div>
                                <span className="font-semibold">Password mismatch — </span>
                                someone changed this password directly on the server (e.g. via <code className="font-mono">passwd</code>).
                                Use <strong>⋯ → Rotate</strong> to generate &amp; sync a new one.
                              </div>
                            </div>
                          )}

                          {/* Revealed password */}
                          {isRevealed && (
                            <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2">
                              <span className="font-mono text-green-300 text-sm flex-1 break-all select-all">{revealedPasswords[c.id]}</span>
                              <button onClick={() => { navigator.clipboard.writeText(revealedPasswords[c.id]); setCopiedCred(c.id); setTimeout(() => setCopiedCred((x) => x === c.id ? null : x), 2000) }}
                                className="text-xs text-gray-400 hover:text-white shrink-0 transition-colors">📋</button>
                              <button onClick={() => hidePassword(c.id)} className="text-xs text-gray-400 hover:text-white shrink-0 transition-colors" title="Hide">✕</button>
                            </div>
                          )}

                          {/* Server apply status banner (linux creds only) */}
                          {canApplyToServer && (
                            <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
                              thisApplyStatus === 'ok' ? 'bg-green-900/30 border border-green-700/40 text-green-300'
                              : c.last_changed_on_server_at ? 'bg-gray-700/40 text-gray-400'
                              : 'bg-orange-900/20 border border-orange-700/30 text-orange-400'}`}>
                              {thisApplyStatus === 'ok' ? (
                                <><span>✓</span><span>Password successfully applied on server just now.</span></>
                              ) : c.last_changed_on_server_at ? (
                                <><span>✓</span><span>Active on server since <strong>{new Date(c.last_changed_on_server_at).toLocaleString()}</strong></span></>
                              ) : (
                                <><span>⚠</span><span>Password saved in vault but <strong>not yet applied on server</strong> — click "Apply to Server" to push it.</span></>
                              )}
                            </div>
                          )}

                          {/* Metadata row */}
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
                            {c.last_revealed_at && (
                              <span title={new Date(c.last_revealed_at).toLocaleString()}>👁 Last accessed: {new Date(c.last_revealed_at).toLocaleDateString()}</span>
                            )}
                            {c.created_by_name && <span>👤 {c.created_by_name}</span>}
                            <span title={new Date(c.created_at).toLocaleString()}>📅 {new Date(c.created_at).toLocaleDateString()}</span>
                          </div>
                        </>
                      )}
                    </div>
                    )
                  })}
                      </div>
                    ))
                  })()}

                  {/* Archived credentials */}
                  {!credLoading && credentials.filter((c) => c.is_archived).length > 0 && (
                    <div className="mt-2 border-t border-gray-700 pt-3">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          onClick={() => setShowArchivedCreds((v) => !v)}
                          className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors text-left">
                          <span className={`transition-transform ${showArchivedCreds ? 'rotate-90' : ''}`}>▶</span>
                          <span>🗄 Archived passwords ({credentials.filter((c) => c.is_archived).length}) — kept for reference</span>
                        </button>
                        <button
                          onClick={() => purgeAllArchivedCredentials(infoServer!.id)}
                          title="Permanently delete all archived passwords for this server"
                          className="px-2.5 py-1 text-xs rounded bg-red-900/30 hover:bg-red-800/50 text-red-500 hover:text-red-300 transition-colors shrink-0">
                          🗑 Purge All
                        </button>
                      </div>

                      {showArchivedCreds && (
                        <div className="mt-2 space-y-2">
                          {credentials.filter((c) => c.is_archived).map((c) => {
                            const isRevealed = !!revealedPasswords[c.id]
                            const isCopied = copiedCred === c.id
                            return (
                              <div key={c.id} className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 space-y-2 opacity-80">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-gray-300 font-medium text-sm line-through decoration-gray-600">{c.label}</p>
                                      <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{c.linux_user}</span>
                                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-500 border border-gray-600">
                                        {c.archived_reason === 'rotated' ? '🔄 rotated'
                                          : c.archived_reason === 'updated' ? '✏ password changed'
                                          : c.archived_reason === 'deleted' ? '🗄 archived'
                                          : '🗄 archived'}
                                      </span>
                                    </div>
                                    {c.archived_at && (
                                      <p className="text-gray-500 text-xs mt-0.5">Archived {new Date(c.archived_at).toLocaleDateString()}</p>
                                    )}
                                  </div>
                                  <div className="flex gap-1 shrink-0">
                                    <button
                                      onClick={() => isRevealed ? hidePassword(c.id) : revealPassword(infoServer!.id, c.id)}
                                      className="px-2 py-1 text-xs rounded bg-gray-700/60 hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors">
                                      {isRevealed ? '🙈 Hide' : '👁 Reveal'}
                                    </button>
                                    <button
                                      onClick={() => copyPassword(infoServer!.id, c.id)}
                                      className={`px-2 py-1 text-xs rounded transition-colors ${isCopied ? 'bg-green-800/60 text-green-300' : 'bg-gray-700/60 hover:bg-gray-700 text-gray-400 hover:text-gray-200'}`}>
                                      {isCopied ? '✓ Copied!' : '📋 Copy'}
                                    </button>
                                    <button
                                      onClick={() => deleteCredential(infoServer!.id, c.id)}
                                      title="Permanently delete this archived entry — cannot be undone"
                                      className="px-2 py-1 text-xs rounded bg-red-900/30 hover:bg-red-800/50 text-red-500 hover:text-red-300 transition-colors">
                                      🗑 Purge
                                    </button>
                                  </div>
                                </div>
                                {isRevealed && (
                                  <div className="flex items-center gap-2 bg-gray-900/60 border border-gray-700/50 rounded-lg px-3 py-2">
                                    <span className="font-mono text-yellow-300/80 text-sm flex-1 break-all select-all">{revealedPasswords[c.id]}</span>
                                    <button onClick={() => hidePassword(c.id)} className="text-xs text-gray-500 hover:text-white shrink-0">✕</button>
                                  </div>
                                )}
                                {c.last_changed_on_server_at && (
                                  <p className="text-xs text-gray-600">🖥 Was applied: {new Date(c.last_changed_on_server_at).toLocaleDateString()}</p>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* ── Software Tab ──────────────────────────────────────────── */}
              {infoTab === 'software' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">Detected via SSH. Click Refresh to re-scan.</p>
                    <button
                      onClick={() => loadSoftware(infoServer!.id)}
                      disabled={softwareLoading}
                      className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors disabled:opacity-50">
                      {softwareLoading ? 'Scanning…' : '↻ Refresh'}
                    </button>
                  </div>

                  {softwareLoading && software.length === 0 && (
                    <div className="py-10 text-center text-gray-500 text-sm">
                      <div className="inline-block w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
                      <p>Scanning installed software… (10–20 s)</p>
                    </div>
                  )}
                  {softwareError && <p className="text-red-400 text-sm">{softwareError}</p>}

                  {!softwareLoading && software.length === 0 && !softwareError && (
                    <p className="text-gray-500 text-sm text-center py-8">Click Refresh to scan this server.</p>
                  )}

                  {(() => {
                    const CATS: Array<{ key: SoftwareItem['category']; icon: string; label: string }> = [
                      { key: 'webserver',       icon: '🌐', label: 'Web Servers' },
                      { key: 'database',        icon: '🗄', label: 'Databases' },
                      { key: 'language',        icon: '💻', label: 'Languages & Runtimes' },
                      { key: 'container',       icon: '🐳', label: 'Containers' },
                      { key: 'process_manager', icon: '⚙', label: 'Process Managers' },
                      { key: 'monitoring',      icon: '📊', label: 'Monitoring' },
                      { key: 'security',        icon: '🔒', label: 'Security' },
                    ]
                    const grouped = software.reduce<Record<string, SoftwareItem[]>>((acc, item) => {
                      ;(acc[item.category] ??= []).push(item)
                      return acc
                    }, {})

                    return CATS.filter((c) => grouped[c.key]?.length).map(({ key, icon, label }) => (
                      <div key={key}>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                          <span>{icon}</span>{label}
                        </p>
                        <div className="space-y-1.5">
                          {grouped[key].map((item) => {
                            const statusColor = item.status === 'active' ? 'text-green-400'
                              : item.status === 'failed' ? 'text-red-400'
                              : item.status === 'inactive' ? 'text-gray-500'
                              : 'text-gray-600'
                            const statusDot = item.status === 'active' ? '●'
                              : item.status === 'failed' ? '●'
                              : item.status === 'inactive' ? '○'
                              : null
                            const isWorking = serviceWorking?.startsWith(item.service_name ?? '§')
                            const currentStatus = item.service_name
                              ? (serviceResults[item.service_name] ?? item.status)
                              : item.status
                            const isActive = currentStatus === 'active'

                            return (
                              <div key={item.name} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 flex items-center gap-3">
                                {/* Status dot */}
                                {statusDot && (
                                  <span className={`text-xs ${statusColor} shrink-0`}>{statusDot}</span>
                                )}
                                {/* Name + version */}
                                <div className="flex-1 min-w-0">
                                  <span className="text-sm font-medium text-white">{item.name}</span>
                                  {item.version && (
                                    <span className="ml-2 text-xs text-gray-500 font-mono truncate">
                                      {item.version.split('\n')[0].slice(0, 60)}
                                    </span>
                                  )}
                                </div>
                                {/* Status badge */}
                                {item.service_name && (
                                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono shrink-0 ${
                                    currentStatus === 'active' ? 'bg-green-900/50 text-green-400 border border-green-800'
                                    : currentStatus === 'failed' ? 'bg-red-900/50 text-red-400 border border-red-800'
                                    : 'bg-gray-700 text-gray-400'
                                  }`}>
                                    {currentStatus ?? 'unknown'}
                                  </span>
                                )}
                                {/* Service control buttons */}
                                {item.service_name && (
                                  <div className="flex gap-1 shrink-0">
                                    {isActive ? (
                                      <>
                                        <button
                                          onClick={() => controlService(infoServer!.id, item.service_name!, 'restart')}
                                          disabled={!!isWorking}
                                          className="px-2 py-0.5 text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-white transition-colors disabled:opacity-50"
                                          title="Restart service">
                                          {isWorking ? '…' : '↺'}
                                        </button>
                                        <button
                                          onClick={() => controlService(infoServer!.id, item.service_name!, 'stop')}
                                          disabled={!!isWorking}
                                          className="px-2 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
                                          title="Stop service">
                                          {isWorking ? '…' : '■'}
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        onClick={() => controlService(infoServer!.id, item.service_name!, 'start')}
                                        disabled={!!isWorking}
                                        className="px-2 py-0.5 text-xs rounded bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
                                        title="Start service">
                                        {isWorking ? '…' : '▶'}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))
                  })()}
                </div>
              )}

              {infoTab === 'recommendations' && (() => {
                const SEV_COLOR: Record<RecSeverity, string> = {
                  critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', info: '#6b7280',
                }
                const SEV_BG: Record<RecSeverity, string> = {
                  critical: 'rgba(239,68,68,0.1)', high: 'rgba(249,115,22,0.1)', medium: 'rgba(234,179,8,0.1)',
                  low: 'rgba(59,130,246,0.1)', info: 'rgba(107,114,128,0.1)',
                }
                const CAT_ICON: Record<string, string> = {
                  performance: '⚡', security: '🔒', stability: '🛡', monitoring: '📊',
                }

                const filtered = recFilter === 'all'
                  ? recommendations
                  : recommendations.filter((r) => r.category === recFilter)

                const severityOrder: RecSeverity[] = ['critical', 'high', 'medium', 'low', 'info']
                const sorted = [...filtered].sort((a, b) =>
                  severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
                )

                const counts = recommendations.reduce<Record<string, number>>((acc, r) => {
                  acc[r.severity] = (acc[r.severity] ?? 0) + 1
                  return acc
                }, {})

                return (
                  <div className="space-y-3">
                    {/* Header bar */}
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex gap-2 flex-wrap">
                        {severityOrder.filter((s) => counts[s]).map((s) => (
                          <span key={s} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            background: SEV_BG[s], border: `1px solid ${SEV_COLOR[s]}40`,
                            color: SEV_COLOR[s], borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600,
                          }}>
                            {s.toUpperCase()} {counts[s]}
                          </span>
                        ))}
                      </div>
                      <button onClick={() => loadRecommendations(infoServer!.id)} disabled={recLoading}
                        className="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors disabled:opacity-50">
                        {recLoading ? 'Scanning…' : '↻ Re-scan'}
                      </button>
                    </div>

                    {/* Category filter */}
                    {recommendations.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {(['all', 'security', 'performance', 'stability', 'monitoring'] as const).map((cat) => (
                          <button key={cat} onClick={() => setRecFilter(cat)}
                            style={{
                              padding: '3px 10px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                              fontWeight: recFilter === cat ? 700 : 400,
                              background: recFilter === cat ? 'var(--accent-hex)' : 'var(--bg-card)',
                              color: recFilter === cat ? 'white' : 'var(--text-secondary)',
                              transition: 'all 0.1s',
                            }}>
                            {cat === 'all' ? `All (${recommendations.length})` : `${CAT_ICON[cat]} ${cat.charAt(0).toUpperCase() + cat.slice(1)}`}
                          </button>
                        ))}
                      </div>
                    )}

                    {recLoading && recommendations.length === 0 && (
                      <div className="py-10 text-center text-gray-500 text-sm">
                        <div className="inline-block w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
                        <p>Connecting to server and analysing configuration… (10–20 s)</p>
                      </div>
                    )}
                    {recError && <p className="text-red-400 text-sm">{recError}</p>}
                    {!recLoading && recommendations.length === 0 && !recError && (
                      <p className="text-gray-500 text-sm text-center py-8">Click Re-scan to analyse this server.</p>
                    )}

                    {sorted.length === 0 && recommendations.length > 0 && (
                      <p className="text-gray-500 text-sm text-center py-4">No {recFilter} recommendations.</p>
                    )}

                    {/* Recommendation cards */}
                    <div className="space-y-2">
                      {sorted.map((rec) => {
                        const isOpen = expandedRec === rec.id
                        return (
                          <div key={rec.id} style={{
                            background: 'var(--bg-card)', border: `1px solid var(--border-med)`,
                            borderLeft: `3px solid ${SEV_COLOR[rec.severity]}`,
                            borderRadius: 8, overflow: 'hidden',
                          }}>
                            {/* Summary row — always visible */}
                            <button onClick={() => setExpandedRec(isOpen ? null : rec.id)}
                              style={{
                                width: '100%', textAlign: 'left', background: 'none', border: 'none',
                                padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 10,
                              }}>
                              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
                                color: SEV_COLOR[rec.severity], background: SEV_BG[rec.severity],
                                border: `1px solid ${SEV_COLOR[rec.severity]}40`,
                                borderRadius: 4, padding: '1px 6px', flexShrink: 0, marginTop: 1 }}>
                                {rec.severity.toUpperCase()}
                              </span>
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginRight: 4,
                                flexShrink: 0, marginTop: 2 }}>
                                {CAT_ICON[rec.category]}
                              </span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                                  {rec.title}
                                </p>
                                <p style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{rec.description}</p>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)',
                                  background: 'var(--bg-input)', borderRadius: 4, padding: '1px 6px' }}>
                                  {rec.software}
                                </span>
                                <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>{isOpen ? '▲' : '▼'}</span>
                              </div>
                            </button>

                            {/* Expanded detail */}
                            {isOpen && (
                              <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border-med)' }}>
                                <div className="space-y-3 pt-3">
                                  {/* Rationale */}
                                  <div>
                                    <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                                      textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Why</p>
                                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{rec.rationale}</p>
                                  </div>

                                  {/* Parameter + recommended value */}
                                  {rec.parameter && (
                                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                                      <div>
                                        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                                          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Parameter</p>
                                        <code style={{ fontSize: 12, color: '#a78bfa', background: 'var(--bg-input)',
                                          padding: '1px 6px', borderRadius: 4 }}>{rec.parameter}</code>
                                      </div>
                                      {rec.recommended && (
                                        <div>
                                          <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                                            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Recommended</p>
                                          <code style={{ fontSize: 12, color: '#34d399', background: 'var(--bg-input)',
                                            padding: '1px 6px', borderRadius: 4 }}>{rec.recommended}</code>
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* Config snippet */}
                                  {rec.snippet && (
                                    <div>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                                          textTransform: 'uppercase', letterSpacing: '0.06em' }}>Config Snippet</p>
                                        <button onClick={() => {
                                          navigator.clipboard.writeText(rec.snippet!)
                                          setCopiedSnippet(rec.id)
                                          setTimeout(() => setCopiedSnippet(null), 2000)
                                        }}
                                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none',
                                            cursor: 'pointer', background: copiedSnippet === rec.id ? '#065f46' : 'var(--bg-input)',
                                            color: copiedSnippet === rec.id ? '#6ee7b7' : 'var(--text-secondary)' }}>
                                          {copiedSnippet === rec.id ? '✓ Copied' : '⎘ Copy'}
                                        </button>
                                      </div>
                                      <pre style={{
                                        fontSize: 11, lineHeight: 1.6, fontFamily: 'monospace',
                                        background: '#0d0d14', border: '1px solid var(--border-med)',
                                        borderRadius: 6, padding: '10px 12px', overflowX: 'auto',
                                        color: '#e2e8f0', whiteSpace: 'pre', margin: 0,
                                      }}>{rec.snippet}</pre>
                                    </div>
                                  )}

                                  {/* Reference link */}
                                  {rec.reference && (
                                    <a href={rec.reference} target="_blank" rel="noopener noreferrer"
                                      style={{ fontSize: 11, color: 'var(--accent-hex)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                      📖 Official documentation ↗
                                    </a>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              </div>{/* end tab-content min-height wrapper */}
            </div>
          )}
        </Modal>
      )}

      {/* Setup SSH Modal */}
      {setupServerId && (
        <Modal title={`Setup SSH — ${setupServer?.name}`} onClose={() => setSetupServerId(null)}>
          {setupStep === 'credentials' && (
            <form onSubmit={runSetup} className="space-y-4">
              <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-3 text-blue-300 text-xs space-y-1">
                <p className="font-medium">How this works:</p>
                <p>1. App connects to your server using the password you provide</p>
                <p>2. A new Ed25519 SSH key is auto-generated and deployed</p>
                <p>3. All future connections use the key (password no longer needed)</p>
              </div>
              <label className="block">
                <span className="text-sm text-gray-400">Linux Username</span>
                <input type="text" value={setupForm.linux_user} onChange={(e) => setSetupForm((f) => ({ ...f, linux_user: e.target.value }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" required />
              </label>
              <label className="block">
                <span className="text-sm text-gray-400">Password</span>
                <input type="password" value={setupForm.password} onChange={(e) => setSetupForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="SSH password for this user"
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  required autoFocus />
              </label>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setSetupServerId(null)} className="flex-1 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors">Cancel</button>
                <button type="submit" className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Connect & Setup</button>
              </div>
            </form>
          )}
          {setupStep === 'working' && (
            <div className="py-8 text-center space-y-3">
              <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-gray-300 text-sm">Connecting and deploying SSH key…</p>
            </div>
          )}
          {setupStep === 'done' && (
            <div className="space-y-4">
              <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 text-green-300 text-sm space-y-2">
                <p className="font-medium text-green-200">✓ Server configured successfully!</p>
                <p>Management key <span className="font-mono bg-green-900/50 px-1 rounded">{setupResult?.key_name}</span> was generated and deployed.</p>
                <p>You can now assign SSH keys to users for this server.</p>
              </div>
              <button onClick={() => setSetupServerId(null)} className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Done</button>
            </div>
          )}
          {setupStep === 'error' && (
            <div className="space-y-4">
              <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm space-y-2">
                <p className="font-medium text-red-200">✗ Setup failed</p>
                <p className="font-mono text-xs break-all">{setupError}</p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setSetupServerId(null)} className="flex-1 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors">Cancel</button>
                <button onClick={() => setSetupStep('credentials')} className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">Try Again</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
