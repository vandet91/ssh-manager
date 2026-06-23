import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Server, ServerInfo, SshKey, ServerCredential, CredentialCategory, SoftwareItem, Recommendation, RecSeverity, HostType, BenchmarkResult, BenchmarkCheck, CheckStatus, CheckCategory, RdpCredential } from '../api/client'
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

type AiIssue = { severity: 'critical'|'warning'|'info'; title: string; description: string; service?: string|null; timestamp?: string|null; root_cause?: string|null; fix_commands?: string[]; prevention?: string|null }
type AiResult = { summary: string; health_score: number; issues: AiIssue[]; security_alerts: AiIssue[]; recommendations: string[]; raw_provider: string; raw_model: string; analysed_at: string }

const AI_PROVIDERS = [
  { id: 'claude',   label: '🟠 Claude',   models: ['claude-sonnet-4-6','claude-haiku-4-5-20251001','claude-opus-4-8'] },
  { id: 'openai',   label: '🟢 GPT',      models: ['gpt-4o','gpt-4o-mini','gpt-4-turbo'] },
  { id: 'gemini',   label: '🔵 Gemini',   models: ['gemini-1.5-pro','gemini-1.5-flash','gemini-2.0-flash'] },
  { id: 'deepseek', label: '🔴 DeepSeek', models: ['deepseek-chat','deepseek-reasoner'] },
] as const

const ANALYSIS_FOCUS_INFO: Record<string, { icon: string; label: string; desc: string }> = {
  health:      { icon: '🏥', label: 'General Health Check',      desc: 'Scans everything — errors, warnings, crashes, resource issues, anomalies. Best starting point.' },
  security:    { icon: '🔒', label: 'Security & Intrusion',      desc: 'Failed logins, brute force, privilege escalation, suspicious IPs, cron changes, unusual processes.' },
  performance: { icon: '⚡', label: 'Performance Issues',        desc: 'High CPU/memory/disk, OOM kills, slow queries, timeouts, swap usage, I/O bottlenecks.' },
  errors:      { icon: '💥', label: 'Errors & Service Failures', desc: 'Crashes, panics, segfaults, failed systemd units, application exceptions, database errors.' },
  custom:      { icon: '💬', label: 'Custom Question',           desc: 'Ask anything specific, e.g. "Why did nginx crash at 3am?" or "Why is disk usage growing?"' },
}

const LOG_SOURCES = [
  { label: 'System Journal (warnings+)',  cmd: 'journalctl -n {lines} --no-pager -p warning..emerg', focus: 'health',      hint: 'System-wide warnings/errors from all services — good first check' },
  { label: 'System Journal (all)',         cmd: 'journalctl -n {lines} --no-pager',                  focus: 'health',      hint: 'Full system log — use fewer lines (100–200) to avoid noise' },
  { label: 'Auth log (SSH logins)',        cmd: 'sudo tail -n {lines} /var/log/auth.log 2>/dev/null || sudo journalctl -n {lines} -u ssh --no-pager', focus: 'security', hint: 'SSH logins, sudo usage, failed auth attempts — use Security focus' },
  { label: 'Syslog',                       cmd: 'sudo tail -n {lines} /var/log/syslog 2>/dev/null',  focus: 'health',      hint: 'General system messages from kernel and daemons' },
  { label: 'Nginx error log',              cmd: 'sudo tail -n {lines} /var/log/nginx/error.log 2>/dev/null',  focus: 'errors', hint: '4xx/5xx errors, upstream failures, config issues' },
  { label: 'Apache error log',             cmd: 'sudo tail -n {lines} /var/log/apache2/error.log 2>/dev/null', focus: 'errors', hint: 'Request errors, module failures, permission issues' },
  { label: 'MySQL error log',              cmd: 'sudo tail -n {lines} /var/log/mysql/error.log 2>/dev/null',  focus: 'performance', hint: 'Slow queries, deadlocks, crash recovery, InnoDB errors' },
  { label: 'PostgreSQL log',               cmd: 'sudo tail -n {lines} /var/log/postgresql/*.log 2>/dev/null', focus: 'performance', hint: 'Slow queries, lock waits, connection limits, crashes' },
  { label: 'Docker daemon log',            cmd: 'sudo journalctl -n {lines} -u docker --no-pager',   focus: 'errors',      hint: 'Container failures, image pull errors, daemon issues' },
  { label: 'Kernel / dmesg (errors)',      cmd: 'sudo dmesg --level=err,warn -T 2>/dev/null | tail -n {lines}', focus: 'performance', hint: 'OOM kills, hardware errors, driver issues, disk failures' },
  { label: 'Fail2ban log',                 cmd: 'sudo tail -n {lines} /var/log/fail2ban.log 2>/dev/null',      focus: 'security', hint: 'Banned IPs, brute force detection — always use Security focus' },
  { label: 'UFW / iptables firewall',      cmd: 'sudo tail -n {lines} /var/log/ufw.log 2>/dev/null || sudo journalctl -n {lines} -k --no-pager | grep -i "ufw\\|iptables"', focus: 'security', hint: 'Blocked/allowed connections, port scans, firewall rule hits' },
  { label: 'Cron log',                     cmd: 'sudo grep -i cron /var/log/syslog 2>/dev/null | tail -n {lines} || sudo journalctl -n {lines} -u cron --no-pager', focus: 'errors', hint: 'Scheduled job failures, missed runs, permission errors' },
  { label: 'Custom command…',              cmd: '', focus: 'health', hint: 'Run any shell command and analyse its output' },
]

const OS_OPTS = [
  { value: 'linux',   label: '🐧 Linux' },
  { value: 'windows', label: '🪟 Windows' },
]

export default function Servers() {
  const [servers, setServers] = useState<Server[]>([])
  const [allKeys, setAllKeys] = useState<SshKey[]>([])
  const [showAdd, setShowAdd] = useState(false)
  type OsType = 'linux' | 'windows'
  const [addForm, setAddForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'production', os_type: 'linux' as OsType, is_domain_controller: false, domain_name: '' })
  const [addError, setAddError] = useState('')

  const [editServer, setEditServer] = useState<Server | null>(null)
  const [editForm, setEditForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'production', os_type: 'linux' as OsType, is_domain_controller: false, domain_name: '', management_linux_user: '' })
  const [editError, setEditError] = useState('')

  const [setupServerId, setSetupServerId] = useState<string | null>(null)
  const [setupForm, setSetupForm] = useState({ linux_user: 'root', password: '' })
  const [setupStep, setSetupStep] = useState<SetupStep>('credentials')
  const [setupError, setSetupError] = useState('')
  const [setupResult, setSetupResult] = useState<{ key_name: string } | null>(null)

  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'failed' | 'testing'>>({})
  const [testKeyInfo, setTestKeyInfo] = useState<Record<string, { key_name: string; is_fallback: boolean }>>({})
  const [verifyResults, setVerifyResults] = useState<Record<string, 'ok' | 'failed' | 'mismatch' | 'verifying'>>({})

  const navigate = useNavigate()
  const openRdpTab = useCallback((s: Server) => {
    navigate(`/remote-desktop?rdp=${s.id}`)
  }, [navigate])
  const [rdpCheckResults, setRdpCheckResults] = useState<Record<string, 'checking' | 'up' | 'down'>>({})

  const checkRdpPort = async (s: Server) => {
    setRdpCheckResults(r => ({ ...r, [s.id]: 'checking' }))
    try {
      const res = await api.get<{ reachable: boolean }>(`/servers/${s.id}/rdp-check`)
      setRdpCheckResults(r => ({ ...r, [s.id]: res.reachable ? 'up' : 'down' }))
    } catch {
      setRdpCheckResults(r => ({ ...r, [s.id]: 'down' }))
    }
  }

  // Windows RDP setup modal
  const [winSetupServer, setWinSetupServer] = useState<Server | null>(null)
  const [winSetupForm, setWinSetupForm] = useState({ username: 'Administrator', password: '', domain: '', rdp_port: 3389, show_pw: false })
  const [winSetupWorking, setWinSetupWorking] = useState(false)
  const [winSetupError, setWinSetupError] = useState('')
  const [winSetupDone, setWinSetupDone] = useState(false)

  // Windows RDP credential management (in Info modal)
  const [winCreds, setWinCreds] = useState<RdpCredential[]>([])
  const [winCredsLoading, setWinCredsLoading] = useState(false)
  const [showAddWinCred, setShowAddWinCred] = useState(false)
  const [addWinCredForm, setAddWinCredForm] = useState({ username: 'Administrator', password: '', domain: '', show_pw: false, use_for_ssh: false })
  const [addWinCredWorking, setAddWinCredWorking] = useState(false)
  const [addWinCredError, setAddWinCredError] = useState('')
  const [editWinCred, setEditWinCred] = useState<RdpCredential | null>(null)
  const [editWinCredForm, setEditWinCredForm] = useState({ username: '', password: '', domain: '', label: '', use_for_ssh: false })
  const [editWinCredWorking, setEditWinCredWorking] = useState(false)
  const [revealedWinPasswords, setRevealedWinPasswords] = useState<Record<string, string>>({})

  const [infoServer, setInfoServer] = useState<Server | null>(null)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState('')
  const [infoTab, setInfoTab] = useState<'overview' | 'users' | 'keys' | 'credentials' | 'software' | 'recommendations' | 'benchmark' | 'ai'>('overview')
  const [recommendations, setRecommendations] = useState<Recommendation[]>([])
  const [recLoading, setRecLoading] = useState(false)
  const [recError, setRecError] = useState('')
  const [recFilter, setRecFilter] = useState<'all' | 'security' | 'performance' | 'stability' | 'monitoring'>('all')
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null)
  const [expandedRec, setExpandedRec] = useState<string | null>(null)
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null)
  const [benchmarkLoading, setBenchmarkLoading] = useState(false)
  const [benchmarkError, setBenchmarkError] = useState('')
  const [benchmarkCatFilter, setBenchmarkCatFilter] = useState<'all' | CheckCategory>('all')
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null)
  const [copiedRemediation, setCopiedRemediation] = useState<string | null>(null)


  const [software, setSoftware] = useState<SoftwareItem[]>([])
  const [softwareLoading, setSoftwareLoading] = useState(false)
  const [softwareError, setSoftwareError] = useState('')
  const [serviceWorking, setServiceWorking] = useState<string | null>(null)  // 'svcName:action'
  const [serviceResults, setServiceResults] = useState<Record<string, string>>({})  // svcName → new status
  const [ndbNodes, setNdbNodes] = useState<Array<{ id: number; type: 'mgmd' | 'ndbd' | 'mysqld'; host: string; status: 'connected' | 'not_connected' | 'unknown'; nodegroup?: number; master?: boolean }>>([])
  const [ndbLoading, setNdbLoading] = useState(false)
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
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false)
  const [confirmRevokeKey, setConfirmRevokeKey] = useState<{ linux_user: string; key_body: string } | null>(null)
  const [revokeWorking, setRevokeWorking] = useState(false)
  const [enableRootSshWorking, setEnableRootSshWorking] = useState(false)
  const [enableRootSshResult, setEnableRootSshResult] = useState<{ ok: boolean; steps: string[] } | null>(null)
  const [sshdStatus, setSshdStatus] = useState<{ permitRootLogin: string; rootLocked: boolean } | null>(null)
  const [sshdStatusLoading, setSshdStatusLoading] = useState(false)
  const [activateRootWorking, setActivateRootWorking] = useState(false)
  const [activateRootResult, setActivateRootResult] = useState<{ ok: boolean; steps: string[] } | null>(null)
  const [activateRootPassword, setActivateRootPassword] = useState('')
  const [activateRootPrompt, setActivateRootPrompt] = useState(false)
  const [permitLoginWorking, setPermitLoginWorking] = useState(false)
  const [permitLoginResult, setPermitLoginResult] = useState<{ ok: boolean; steps: string[]; value?: string } | null>(null)
  const [verifyingCred, setVerifyingCred] = useState<string | null>(null)
  const [verifyCredResult, setVerifyCredResult] = useState<Record<string, 'match' | 'mismatch' | 'error'>>({})
  const [openCredMenu, setOpenCredMenu] = useState<string | null>(null)
  const [confirmDeleteCred, setConfirmDeleteCred] = useState<{ id: string; label: string; isArchived: boolean } | null>(null)
  const [setMgmtKeyWorking, setSetMgmtKeyWorking] = useState(false)
  const [srvSearch, setSrvSearch] = useState('')
  const [srvOsFilter, setSrvOsFilter] = useState('')
  const [srvEnvFilter, setSrvEnvFilter] = useState('')
  const [srvHostFilter, setSrvHostFilter] = useState('')

  // User management state (within info modal)
  const [showAddUser, setShowAddUser] = useState(false)
  const [addUserForm, setAddUserForm] = useState({ username: '', comment: '', shell: '/bin/bash', system_user: false, password: '', save_to_vault: true })
  const [addUserError, setAddUserError] = useState('')
  const [addUserWorking, setAddUserWorking] = useState(false)
  const [editUserTarget, setEditUserTarget] = useState<string | null>(null)
  const [editUserForm, setEditUserForm] = useState({ shell: '/bin/bash', comment: '', password: '', save_to_vault: true })
  const [editUserError, setEditUserError] = useState('')
  const [editUserWorking, setEditUserWorking] = useState(false)
  const [pushKeyTarget, setPushKeyTarget] = useState<string | null>(null)  // username being targeted for key push
  const [pushKeyId, setPushKeyId] = useState('')
  const [pushKeyWorking, setPushKeyWorking] = useState(false)
  const [pushKeyError, setPushKeyError] = useState('')
  const [deleteUserWorking, setDeleteUserWorking] = useState<string | null>(null)

  // AI Analyst
  const [aiForm, setAiForm] = useState({ log_source_idx: 0, custom_cmd: '', lines: 300, analysis_type: 'health' as string, custom_question: '', provider: 'claude', model: 'claude-sonnet-4-6' })
  const [aiDefaultsLoaded, setAiDefaultsLoaded] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiResult, setAiResult] = useState<AiResult | null>(null)
  const [aiError, setAiError] = useState('')
  const [aiCopied, setAiCopied] = useState<string | null>(null)

  const runAiAnalysis = async () => {
    if (!infoServer) return
    setAiRunning(true); setAiResult(null); setAiError('')
    const src = LOG_SOURCES[aiForm.log_source_idx]
    const cmd = src.cmd === '' ? aiForm.custom_cmd : src.cmd.replace('{lines}', String(aiForm.lines))
    try {
      const res = await api.post<AiResult>(`/servers/${infoServer.id}/ai-analyse`, {
        log_source: cmd, lines: aiForm.lines,
        analysis_type: aiForm.analysis_type,
        custom_question: aiForm.analysis_type === 'custom' ? aiForm.custom_question : undefined,
        provider: aiForm.provider, model: aiForm.model,
      })
      setAiResult(res)
    } catch (err: unknown) { setAiError((err as Error).message) }
    finally { setAiRunning(false) }
  }

  const copyCmd = (cmd: string) => {
    navigator.clipboard.writeText(cmd)
    setAiCopied(cmd)
    setTimeout(() => setAiCopied(null), 2000)
  }

  const load = () => {
    api.get<Server[]>('/servers?device_category=server').then(list => setServers(list)).catch(() => {})
    api.get<SshKey[]>('/keys').then(setAllKeys).catch(() => {})
  }
  useEffect(() => {
    load()
    api.get<{ default_provider: string; default_model: string }>('/settings/ai-keys').then(s => {
      if (s.default_provider) {
        const providerDef = AI_PROVIDERS.find(p => p.id === s.default_provider)
        const model = s.default_model || providerDef?.models[0] || ''
        setAiForm(f => ({ ...f, provider: s.default_provider, model }))
      }
      setAiDefaultsLoaded(true)
    }).catch(() => setAiDefaultsLoaded(true))
  }, [])

  const addServer = async (e: React.FormEvent) => {
    e.preventDefault(); setAddError('')
    try {
      const { domain_name, ...rest } = addForm
      const payload = { ...rest, tags: domain_name ? { domain_name } : {} }
      await api.post('/servers', payload)
      setShowAdd(false)
      setAddForm({ name: '', hostname: '', ssh_port: 22, environment: 'production', os_type: 'linux' as OsType, is_domain_controller: false, domain_name: '' })
      load()
    } catch (err: unknown) { setAddError((err as Error).message) }
  }

  const openEdit = (s: Server) => {
    setEditServer(s)
    setEditForm({ name: s.name, hostname: s.hostname, ssh_port: s.ssh_port, environment: s.environment, os_type: (s.os_type ?? 'linux') as OsType, is_domain_controller: s.is_domain_controller ?? false, domain_name: s.tags?.domain_name ?? '', management_linux_user: s.management_linux_user ?? '' })
    setEditError('')
  }

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault(); setEditError('')
    try {
      const { domain_name, management_linux_user, ...rest } = editForm
      const existing = editServer!.tags ?? {}
      const payload = { ...rest, tags: { ...existing, domain_name: domain_name || undefined }, management_linux_user: management_linux_user || undefined }
      await api.patch(`/servers/${editServer!.id}`, payload)
      setEditServer(null)
      load()
    } catch (err: unknown) { setEditError((err as Error).message) }
  }

  const deleteServer = async (s: Server) => {
    if (!confirm(`Delete server "${s.name}"? This cannot be undone.`)) return
    await api.delete(`/servers/${s.id}`)
    load()
  }

  const openSetup = (server: Server) => {
    if (server.os_type === 'windows') {
      setWinSetupServer(server)
      setWinSetupForm({ username: 'Administrator', password: '', domain: '', rdp_port: 3389, show_pw: false })
      setWinSetupError('')
      setWinSetupDone(false)
      return
    }
    setSetupServerId(server.id)
    setSetupStep('credentials')
    setSetupForm({ linux_user: 'root', password: '' })
    setSetupError('')
    setSetupResult(null)
  }

  const openSshSetup = (server: Server) => {
    setSetupServerId(server.id)
    setSetupStep('credentials')
    setSetupForm({ linux_user: 'Administrator', password: '' })
    setSetupError('')
    setSetupResult(null)
  }

  const runWindowsSetup = async () => {
    if (!winSetupServer) return
    setWinSetupWorking(true)
    setWinSetupError('')
    try {
      await api.post(`/servers/${winSetupServer.id}/windows-setup`, {
        username: winSetupForm.username,
        password: winSetupForm.password,
        domain:   winSetupForm.domain || undefined,
        rdp_port: winSetupForm.rdp_port,
      })
      setWinSetupDone(true)
      setServers(prev => prev.map(s => s.id === winSetupServer.id ? { ...s, windows_rdp_ready: true, os_type: 'windows' } : s))
    } catch (err: unknown) {
      setWinSetupError((err as Error).message)
    } finally {
      setWinSetupWorking(false)
    }
  }

  const loadWinCreds = async (serverId: string) => {
    setWinCredsLoading(true)
    try {
      const list = await api.get<RdpCredential[]>(`/servers/${serverId}/rdp-credentials`)
      setWinCreds(list)
    } catch { /* silent */ }
    finally { setWinCredsLoading(false) }
  }

  const addWinCred = async (serverId: string) => {
    setAddWinCredWorking(true); setAddWinCredError('')
    try {
      await api.post(`/servers/${serverId}/windows-setup`, {
        username:    addWinCredForm.username,
        password:    addWinCredForm.password,
        domain:      addWinCredForm.domain || undefined,
        rdp_port:    3389,
        use_for_ssh: addWinCredForm.use_for_ssh,
      })
      await Promise.all([loadWinCreds(serverId), loadCredentials(serverId)])
      setShowAddWinCred(false)
      setAddWinCredForm({ username: 'Administrator', password: '', domain: '', show_pw: false, use_for_ssh: false })
    } catch (err: unknown) { setAddWinCredError((err as Error).message) }
    finally { setAddWinCredWorking(false) }
  }

  const saveWinCred = async (serverId: string, credId: string) => {
    setEditWinCredWorking(true)
    try {
      await api.put(`/servers/${serverId}/rdp-credentials/${credId}`, {
        label:       editWinCredForm.label,
        username:    editWinCredForm.username,
        password:    editWinCredForm.password || undefined,
        domain:      editWinCredForm.domain || undefined,
        use_for_ssh: editWinCredForm.use_for_ssh,
      })
      await loadWinCreds(serverId)
      await loadCredentials(serverId)
      setEditWinCred(null)
    } catch (err: unknown) { alert((err as Error).message) }
    finally { setEditWinCredWorking(false) }
  }

  const deleteWinCred = async (serverId: string, credId: string, isArchived: boolean) => {
    const msg = isArchived
      ? 'Permanently delete this archived RDP credential? This cannot be undone.'
      : 'Archive this RDP credential? It will be hidden but not deleted.'
    if (!confirm(msg)) return
    await api.delete(`/servers/${serverId}/rdp-credentials/${credId}`, { permanent: isArchived })
    await Promise.all([loadWinCreds(serverId), loadCredentials(serverId)])
  }

  const revealWinPassword = async (serverId: string, credId: string) => {
    try {
      const res = await api.post<{ password: string }>(`/servers/${serverId}/rdp-credentials/${credId}/reveal`)
      setRevealedWinPasswords(p => ({ ...p, [credId]: res.password }))
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const copyPasswordSilently = async (serverId: string, credId: string, type: 'rdp' | 'linux') => {
    try {
      const url = type === 'rdp'
        ? `/servers/${serverId}/rdp-credentials/${credId}/reveal`
        : `/servers/${serverId}/credentials/${credId}/reveal`
      const res = await api.post<{ password: string }>(url)
      await navigator.clipboard.writeText(res.password)
      setCopiedCred(credId)
      setTimeout(() => setCopiedCred(x => x === credId ? null : x), 2000)
    } catch (err: unknown) { alert('Failed to copy password') }
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
    setShowAddUser(false)
    setPushKeyTarget(null)
    setRevealedPasswords({})
    setShowCredForm(false)
    setEditCred(null)
    setSoftware([])
    setSoftwareError('')
    setServiceResults({})
    setNdbNodes([])
    setRecommendations([])
    setRecError('')
    setRecFilter('all')
    setExpandedRec(null)
    setBenchmark(null)
    setBenchmarkError('')
    setBenchmarkCatFilter('all')
    setExpandedCheck(null)
    setWinCreds([])
    setShowAddWinCred(false)
    setEditWinCred(null)
    setRevealedWinPasswords({})
    if (s.os_type === 'windows') {
      setInfoTab('credentials')
      // Load credentials immediately; scan SSH info in background (requires OpenSSH on Windows)
      await Promise.all([loadCredentials(s.id), loadWinCreds(s.id)])
      if (s.management_key_id) refreshInfo(s.id).catch(() => {})
    } else {
      setInfoTab('overview')
      setSshdStatus(null)
      setActivateRootResult(null)
      setPermitLoginResult(null)
      setEnableRootSshResult(null)
      await Promise.all([refreshInfo(s.id), loadCredentials(s.id)])
      loadSshdStatus(s.id)
    }
  }

  const loadSshdStatus = async (serverId: string) => {
    setSshdStatus(null)
    setSshdStatusLoading(true)
    try {
      const data = await api.get<{ permitRootLogin: string; rootLocked: boolean }>(`/servers/${serverId}/sshd-status`)
      setSshdStatus(data)
    } catch { /* non-fatal */ }
    finally { setSshdStatusLoading(false) }
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

  const loadBenchmark = async (serverId: string) => {
    setBenchmarkLoading(true)
    setBenchmarkError('')
    try {
      const result = await api.get<BenchmarkResult>(`/servers/${serverId}/benchmark`)
      setBenchmark(result)
    } catch (err: unknown) {
      setBenchmarkError((err as Error).message)
    } finally {
      setBenchmarkLoading(false)
    }
  }

  const loadNdbStatus = async (serverId: string) => {
    setNdbLoading(true)
    try {
      const res = await api.get<{ detected: boolean; nodes: typeof ndbNodes }>(`/servers/${serverId}/ndb-status`)
      setNdbNodes(res.nodes)
    } catch {
      setNdbNodes([])
    } finally {
      setNdbLoading(false)
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

  const deleteCredential = async (serverId: string, credId: string, permanent = false) => {
    try {
      await api.delete(`/servers/${serverId}/credentials/${credId}`, permanent ? { permanent: true } : undefined)
      await Promise.all([
        loadCredentials(serverId),
        infoServer?.os_type === 'windows' ? loadWinCreds(serverId) : Promise.resolve(),
      ])
      setRevealedPasswords((p) => { const n = { ...p }; delete n[credId]; return n })
      setConfirmDeleteCred(null)
    } catch (err: unknown) { alert((err as Error).message) }
  }

  const promptDeleteCred = (credId: string) => {
    const cred = credentials.find((c) => c.id === credId)
    if (!cred) return
    setConfirmDeleteCred({ id: credId, label: cred.label, isArchived: !!cred.is_archived })
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
    setConfirmPurgeAll(false)
    try {
      await Promise.allSettled(archivedList.map((c) => api.delete(`/servers/${serverId}/credentials/${c.id}`)))
      await loadCredentials(serverId)
      setRevealedPasswords((p) => {
        const n = { ...p }
        archivedList.forEach((c) => delete n[c.id])
        return n
      })
    } catch (err: any) { console.error('Purge failed', err) }
  }

  const setAsManagementKey = async (serverId: string, keyId: string, linuxUser?: string) => {
    setSetMgmtKeyWorking(true)
    try {
      const res = await api.patch<{ ok: boolean; key_name: string }>(`/servers/${serverId}/management-key`, { key_id: keyId, ...(linuxUser ? { linux_user: linuxUser } : {}) })
      alert(`✓ Management key updated to "${res.key_name}"`)
      load()
      await refreshInfo(serverId)
    } catch (err: unknown) { alert('Failed: ' + (err as Error).message) }
    finally { setSetMgmtKeyWorking(false) }
  }

  const revokeAuthorizedKey = async (serverId: string, linux_user: string, key_body: string) => {
    setRevokeWorking(true)
    try {
      await api.delete(`/servers/${serverId}/authorized-keys`, { linux_user, key_body })
      await refreshInfo(serverId)
    } catch (err: unknown) { alert((err as Error).message) }
    finally { setRevokeWorking(false); setConfirmRevokeKey(null) }
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
      const e = err as { status?: number; data?: { error?: string; incoming?: string } }
      if (e.status === 409) {
        setVerifyResults((p) => ({ ...p, [id]: 'mismatch' }))
        const trust = window.confirm(
          `⚠ Host key mismatch!\n\nThe server's SSH host key has changed. This can happen after an OS reinstall or SSH key regeneration — but could also indicate a MITM attack.\n\nNew fingerprint: ${e.data?.incoming ?? 'unknown'}\n\nDo you want to trust the new key and update the stored fingerprint?`
        )
        if (trust) {
          try {
            await api.post(`/servers/${id}/reset-host-key`)
            load()
            setVerifyResults((p) => ({ ...p, [id]: 'ok' }))
            setTimeout(() => setVerifyResults((p) => { const n = { ...p }; delete n[id]; return n }), 3000)
          } catch {
            setVerifyResults((p) => ({ ...p, [id]: 'failed' }))
            setTimeout(() => setVerifyResults((p) => { const n = { ...p }; delete n[id]; return n }), 3000)
          }
        } else {
          setTimeout(() => setVerifyResults((p) => { const n = { ...p }; delete n[id]; return n }), 5000)
        }
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
      setAddUserForm({ username: '', comment: '', shell: '/bin/bash', system_user: false, password: '', save_to_vault: true })
      await refreshInfo(infoServer!.id)
    } catch (err: unknown) { setAddUserError((err as Error).message) }
    finally { setAddUserWorking(false) }
  }

  const openEditUser = (u: { username: string; shell: string }) => {
    setEditUserTarget(u.username)
    setEditUserForm({ shell: u.shell, comment: '', password: '', save_to_vault: true })
    setEditUserError('')
    setShowAddUser(false)
    setPushKeyTarget(null)
  }

  const saveEditUser = async (e: React.FormEvent) => {
    e.preventDefault(); setEditUserError(''); setEditUserWorking(true)
    try {
      const payload: Record<string, unknown> = { save_to_vault: editUserForm.save_to_vault }
      if (editUserForm.shell) payload.shell = editUserForm.shell
      if (editUserForm.comment) payload.comment = editUserForm.comment
      if (editUserForm.password) payload.password = editUserForm.password
      await api.patch(`/servers/${infoServer!.id}/users/${editUserTarget}`, payload)
      setEditUserTarget(null)
      await refreshInfo(infoServer!.id)
    } catch (err: unknown) { setEditUserError((err as Error).message) }
    finally { setEditUserWorking(false) }
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

  const q = srvSearch.toLowerCase()
  const filteredServers = servers.filter(s => {
    if (srvSearch && !(s.name ?? '').toLowerCase().includes(q) && !(s.hostname ?? '').toLowerCase().includes(q)) return false
    if (srvOsFilter && (s.os_type ?? '') !== srvOsFilter) return false
    if (srvEnvFilter && (s.environment ?? '') !== srvEnvFilter) return false
    if (srvHostFilter && (s.host_type ?? 'unknown') !== srvHostFilter) return false
    return true
  })
  const hostTypes = Array.from(new Set(servers.map(s => s.host_type ?? 'unknown').filter(Boolean))).sort()

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Servers</h1>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors">
          + Add Server
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <input value={srvSearch} onChange={e => setSrvSearch(e.target.value)} placeholder="Search name or hostname…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-52" />
        <select value={srvOsFilter} onChange={e => setSrvOsFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">All OS</option>
          {OS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={srvEnvFilter} onChange={e => setSrvEnvFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">All Environments</option>
          {envOptions.map(e => <option key={e} value={e}>{e.charAt(0).toUpperCase() + e.slice(1)}</option>)}
        </select>
        {hostTypes.length > 1 && (
          <select value={srvHostFilter} onChange={e => setSrvHostFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">All Platforms</option>
            {hostTypes.map(h => <option key={h} value={h}>{HOST_META[h]?.label ?? h}</option>)}
          </select>
        )}
        {(srvSearch || srvOsFilter || srvEnvFilter || srvHostFilter) && (
          <button onClick={() => { setSrvSearch(''); setSrvOsFilter(''); setSrvEnvFilter(''); setSrvHostFilter('') }}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg">
            ✕ Clear
          </button>
        )}
        <span className="text-xs text-gray-500 ml-auto">{filteredServers.length} / {servers.length}</span>
      </div>

      {/* overflow-x:auto lets the table scroll on narrow screens without
          breaking the outer layout; min-width keeps columns stable */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
        <table className="w-full text-xs" style={{ minWidth: 900, tableLayout: 'auto', borderCollapse: 'collapse' }}>
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
            {filteredServers.map((s) => (
              <tr key={s.id} className="hover:bg-gray-800/30 transition-colors"
                style={{ borderBottom: '1px solid var(--border-weak)' }}>
                <td className="px-3 py-2 text-white font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</td>
                <td className="px-3 py-2" style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {s.os_type === 'windows'
                    ? <span className="inline-flex items-center gap-1 text-xs text-blue-300 bg-blue-900/30 border border-blue-700/40 rounded px-1.5 py-0.5 font-medium">🪟 Win</span>
                    : s.os_type === 'linux'
                      ? <span className="inline-flex items-center gap-1 text-xs text-green-300 bg-green-900/30 border border-green-700/40 rounded px-1.5 py-0.5 font-medium">🐧 Linux</span>
                    : s.os_type === 'router'
                      ? <span className="inline-flex items-center gap-1 text-xs text-orange-300 bg-orange-900/30 border border-orange-700/40 rounded px-1.5 py-0.5 font-medium">📡 Router</span>
                    : s.os_type === 'access-point'
                      ? <span className="inline-flex items-center gap-1 text-xs text-purple-300 bg-purple-900/30 border border-purple-700/40 rounded px-1.5 py-0.5 font-medium">📶 AP</span>
                    : s.os_type === 'switch'
                      ? <span className="inline-flex items-center gap-1 text-xs text-cyan-300 bg-cyan-900/30 border border-cyan-700/40 rounded px-1.5 py-0.5 font-medium">🔀 Switch</span>
                      : <span className="text-xs text-gray-500">—</span>
                  }
                </td>
                <td className="px-3 py-2" style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  <HostBadge type={s.host_type} detail={s.host_type_detail} />
                </td>
                <td className="px-3 py-2 text-gray-300 font-mono text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.hostname}:{s.ssh_port}</td>
                <td className="px-3 py-2" style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}><Badge label={s.environment} /></td>
                <td className="px-3 py-2" style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {s.os_type === 'windows'
                    ? s.windows_rdp_ready
                      ? <Badge label="RDP Ready" variant="ok" />
                      : <Badge label="Not set up" variant="high" />
                    : !s.management_key_id
                      ? <Badge label="Not set up" variant="high" />
                      : s.host_key_verified
                        ? <Badge label="Ready" variant="ok" />
                        : <Badge label="Unverified" variant="medium" />}
                </td>
                <td className="px-3 py-2 text-gray-400 text-xs" style={{ overflow: 'hidden', whiteSpace: 'nowrap' }} title={new Date(s.created_at).toLocaleString()}>{new Date(s.created_at).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-gray-400 text-xs" style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{s.last_connected_at ? new Date(s.last_connected_at).toLocaleDateString() : <span className="text-gray-600">—</span>}</td>
                <td className="px-3 py-2">
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'center' }}>
                    {s.os_type === 'windows' ? (
                      <>
                        {!s.windows_rdp_ready && (
                          <button onClick={() => openSetup(s)}
                            className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium whitespace-nowrap">
                            ⚙ Setup RDP
                          </button>
                        )}
                        {!s.management_key_id ? (
                          <button onClick={() => openSshSetup(s)}
                            title="Setup SSH access (OpenSSH must be installed on the Windows server)"
                            className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium whitespace-nowrap">
                            ⚙ Setup SSH
                          </button>
                        ) : (
                          <button onClick={() => openSshSetup(s)}
                            title="Re-run SSH setup with username & password"
                            className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-yellow-600 text-gray-300 hover:text-white transition-colors whitespace-nowrap">
                            ⚙ Re-setup SSH
                          </button>
                        )}
                      </>
                    ) : (s.os_type === 'router' || s.os_type === 'access-point' || s.os_type === 'switch') ? (
                      !s.management_key_id && (
                        <button onClick={() => openSetup(s)}
                          className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium whitespace-nowrap">
                          ⚙ Setup SSH
                        </button>
                      )
                    ) : !s.management_key_id ? (
                      <button onClick={() => openSetup(s)}
                        className="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium whitespace-nowrap">
                        ⚙ Setup
                      </button>
                    ) : (
                      <>
                      <button onClick={() => openSetup(s)}
                        title="Re-run setup with username & password (fixes host key mismatch)"
                        className="px-2 py-1 text-xs rounded bg-gray-700 hover:bg-yellow-600 text-gray-300 hover:text-white transition-colors whitespace-nowrap">
                        ⚙ Re-setup
                      </button>
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
                      </>
                    )}
                    {s.os_type !== 'windows' && (
                      <button onClick={() => verifyHostKey(s.id)} disabled={verifyResults[s.id] === 'verifying'}
                        className={`px-2 py-1 text-xs rounded transition-colors disabled:opacity-60 whitespace-nowrap ${
                          verifyResults[s.id] === 'ok' ? 'bg-green-700 text-white'
                          : verifyResults[s.id] === 'mismatch' || verifyResults[s.id] === 'failed' ? 'bg-red-700 text-white'
                          : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                        {verifyResults[s.id] === 'verifying' ? '…' : verifyResults[s.id] === 'ok' ? '✓ Verified'
                          : verifyResults[s.id] === 'mismatch' ? '✗ Mismatch' : verifyResults[s.id] === 'failed' ? '✗ Failed' : 'Verify'}
                      </button>
                    )}
                    <button onClick={() => openEdit(s)}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors whitespace-nowrap">
                      Edit
                    </button>
                    {(s.management_key_id || s.os_type === 'windows') && (
                      <button onClick={() => openInfo(s)}
                        className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors whitespace-nowrap">
                        Info
                      </button>
                    )}
                    {s.os_type === 'windows' && (
                      <>
                        <button
                          onClick={() => checkRdpPort(s)}
                          disabled={rdpCheckResults[s.id] === 'checking'}
                          title="Check if RDP port (3389) is reachable"
                          className={`px-2 py-1 text-xs rounded transition-colors whitespace-nowrap disabled:opacity-60 ${
                            rdpCheckResults[s.id] === 'up'   ? 'bg-green-700 text-white' :
                            rdpCheckResults[s.id] === 'down' ? 'bg-red-700 text-white' :
                            'bg-gray-600 hover:bg-gray-500 text-white'
                          }`}>
                          {rdpCheckResults[s.id] === 'checking' ? '…' :
                           rdpCheckResults[s.id] === 'up'       ? '✓ RDP Up' :
                           rdpCheckResults[s.id] === 'down'     ? '✗ Unreachable' :
                           'Check'}
                        </button>
                        <button onClick={() => openRdpTab(s)}
                          className="px-2 py-1 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors whitespace-nowrap"
                          title="Open Remote Desktop (RDP) in browser">
                          🖥 RDP
                        </button>
                      </>
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
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-gray-400">Environment</span>
                <select value={addForm.environment} onChange={(e) => setAddForm((f) => ({ ...f, environment: e.target.value }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {envOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-gray-400">Device Type</span>
                <select value={addForm.os_type} onChange={(e) => setAddForm((f) => ({ ...f, os_type: e.target.value as typeof f.os_type }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="linux">🐧 Linux Server</option>
                  <option value="windows">🪟 Windows Server</option>
                </select>
              </label>
            </div>
            {addForm.os_type === 'windows' && (
              <div className="space-y-2">
                <label className="flex items-center gap-3 cursor-pointer select-none p-3 rounded-lg bg-gray-800 border border-gray-700">
                  <input type="checkbox" checked={addForm.is_domain_controller}
                    onChange={(e) => setAddForm((f) => ({ ...f, is_domain_controller: e.target.checked }))}
                    className="w-4 h-4 accent-indigo-500" />
                  <div>
                    <div className="text-sm text-white font-medium">🏢 Domain Controller</div>
                    <div className="text-xs text-gray-400">This server runs Active Directory and will appear in Domain Manager</div>
                  </div>
                </label>
                {addForm.is_domain_controller && (
                  <label className="block">
                    <span className="text-sm text-gray-400">AD Domain Name <span className="text-gray-600">(e.g. staff.company.local)</span></span>
                    <input type="text" value={addForm.domain_name}
                      onChange={(e) => setAddForm((f) => ({ ...f, domain_name: e.target.value }))}
                      placeholder="staff.company.local"
                      className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </label>
                )}
              </div>
            )}
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
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-gray-400">Environment</span>
                <select value={editForm.environment} onChange={(e) => setEditForm((f) => ({ ...f, environment: e.target.value }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {envOptions.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-gray-400">Device Type</span>
                <select value={editForm.os_type} onChange={(e) => setEditForm((f) => ({ ...f, os_type: e.target.value as typeof f.os_type }))}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="linux">🐧 Linux Server</option>
                  <option value="windows">🪟 Windows Server</option>
                </select>
              </label>
            </div>
            {editForm.os_type === 'linux' && (
              <label className="block">
                <span className="text-sm text-gray-400">SSH Username <span className="text-gray-600">(management user, e.g. root or vandet)</span></span>
                <input type="text" value={editForm.management_linux_user}
                  onChange={(e) => setEditForm((f) => ({ ...f, management_linux_user: e.target.value }))}
                  placeholder="root"
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </label>
            )}
            {editForm.os_type === 'windows' && (
              <div className="space-y-2">
                <label className="flex items-center gap-3 cursor-pointer select-none p-3 rounded-lg bg-gray-800 border border-gray-700">
                  <input type="checkbox" checked={editForm.is_domain_controller}
                    onChange={(e) => setEditForm((f) => ({ ...f, is_domain_controller: e.target.checked }))}
                    className="w-4 h-4 accent-indigo-500" />
                  <div>
                    <div className="text-sm text-white font-medium">🏢 Domain Controller</div>
                    <div className="text-xs text-gray-400">This server runs Active Directory and will appear in Domain Manager</div>
                  </div>
                </label>
                {editForm.is_domain_controller && (
                  <label className="block">
                    <span className="text-sm text-gray-400">AD Domain Name <span className="text-gray-600">(e.g. staff.company.local)</span></span>
                    <input type="text" value={editForm.domain_name}
                      onChange={(e) => setEditForm((f) => ({ ...f, domain_name: e.target.value }))}
                      placeholder="staff.company.local"
                      className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </label>
                )}
              </div>
            )}
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
          {infoLoading && !serverInfo && infoServer?.os_type !== 'windows' && (
            <div className="py-8 text-center space-y-3">
              <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-gray-300 text-sm">Connecting and gathering system info…</p>
            </div>
          )}
          {infoError && <p className="text-red-400 text-sm py-4">{infoError}</p>}
          {/* Windows servers render the credential UI; SSH scan runs in background */}
          {infoServer?.os_type === 'windows' && !serverInfo && (
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-med)', flexShrink: 0 }}>
                {(['credentials', 'users'] as const).map(t => (
                  <button key={t} type="button" onMouseDown={e => e.preventDefault()} onClick={() => setInfoTab(t)}
                    style={{ padding: '9px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer', background: 'none', border: 'none', borderBottom: infoTab === t ? '2px solid var(--accent-hex)' : '2px solid transparent', color: infoTab === t ? 'var(--accent-hex)' : 'var(--text-secondary)', marginBottom: -1 }}>
                    {t === 'credentials' ? `🔑 RDP Credentials (${winCreds.filter(c => !c.is_archived).length})` : `🐧 SSH Users (${credentials.filter(c => ['linux','windows'].includes(c.category) && !c.is_archived).length})`}
                  </button>
                ))}
              </div>
              <div style={{ height: 480, overflowY: 'auto', paddingTop: 16, paddingRight: 18 }}>
                {/* reuse same windows creds UI via a synthetic tab check */}
                {/* RDP Credentials tab */}
                {infoTab === 'credentials' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-gray-500">RDP credentials stored in the vault. Use these to connect via Remote Desktop.</p>
                        <button onClick={() => { setShowAddWinCred(true); setAddWinCredError('') }}
                          className="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded-lg transition-colors font-medium">+ Add Credential</button>
                      </div>
                      {showAddWinCred && (
                        <div className="bg-gray-800 border border-blue-700/50 rounded-lg p-4 space-y-3">
                          <p className="text-sm font-semibold text-white">New RDP Credential</p>
                          {addWinCredError && <p className="text-red-400 text-xs">{addWinCredError}</p>}
                          <div className="grid grid-cols-2 gap-3">
                            <label className="block"><span className="text-xs text-gray-400">Username</span>
                              <input value={addWinCredForm.username} onChange={e => setAddWinCredForm(f => ({ ...f, username: e.target.value }))} placeholder="Administrator"
                                className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></label>
                            <label className="block"><span className="text-xs text-gray-400">Domain <span className="text-gray-600">(optional)</span></span>
                              <input value={addWinCredForm.domain} onChange={e => setAddWinCredForm(f => ({ ...f, domain: e.target.value }))} placeholder="CONTOSO"
                                className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></label>
                          </div>
                          <label className="block"><span className="text-xs text-gray-400">Password</span>
                            <div className="relative mt-1">
                              <input type={addWinCredForm.show_pw ? 'text' : 'password'} value={addWinCredForm.password} onChange={e => setAddWinCredForm(f => ({ ...f, password: e.target.value }))}
                                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 pr-14" />
                              <button type="button" onClick={() => setAddWinCredForm(f => ({ ...f, show_pw: !f.show_pw }))}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-200">{addWinCredForm.show_pw ? 'Hide' : 'Show'}</button>
                            </div>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input type="checkbox" checked={addWinCredForm.use_for_ssh} onChange={e => setAddWinCredForm(f => ({ ...f, use_for_ssh: e.target.checked }))}
                              className="rounded border-gray-600 bg-gray-700 text-blue-500" />
                            <span className="text-xs text-gray-300">Also use for SSH (domain admin)</span>
                          </label>
                          <div className="flex gap-2 pt-1">
                            <button onClick={() => setShowAddWinCred(false)} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                            <button onClick={() => addWinCred(infoServer!.id)} disabled={addWinCredWorking || !addWinCredForm.username || !addWinCredForm.password}
                              className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium transition-colors">{addWinCredWorking ? 'Saving…' : 'Save Credential'}</button>
                          </div>
                        </div>
                      )}
                      {winCredsLoading && <p className="text-center text-gray-500 text-sm py-4">Loading…</p>}
                      {winCreds.filter(c => !c.is_archived).map(c => {
                        const domain = c.notes?.match(/^Domain:\s*(.+)$/im)?.[1]
                        return (
                          <div key={c.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2">
                            {editWinCred?.id === c.id ? (
                              <div className="space-y-2">
                                <p className="text-xs font-semibold text-white">Edit Credential</p>
                                <div className="grid grid-cols-2 gap-2">
                                  {[['Label','label'],['Username','username'],['Domain','domain']].map(([lbl, fld]) => (
                                    <label key={fld} className="block"><span className="text-xs text-gray-400">{lbl}</span>
                                      <input value={(editWinCredForm as Record<string, string | boolean>)[fld] as string} onChange={e => setEditWinCredForm(f => ({ ...f, [fld]: e.target.value }))}
                                        className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" /></label>
                                  ))}
                                  <label className="block"><span className="text-xs text-gray-400">New Password <span className="text-gray-600">(blank = keep)</span></span>
                                    <input type="password" value={editWinCredForm.password} onChange={e => setEditWinCredForm(f => ({ ...f, password: e.target.value }))} placeholder="Leave blank to keep current"
                                      className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" /></label>
                                </div>
                                <label className="flex items-center gap-2 mt-1">
                                  <input type="checkbox" checked={editWinCredForm.use_for_ssh} onChange={e => setEditWinCredForm(f => ({ ...f, use_for_ssh: e.target.checked }))} className="rounded" />
                                  <span className="text-xs text-gray-300">Also use for SSH (domain admin)</span>
                                </label>
                                <div className="flex gap-2">
                                  <button onClick={() => setEditWinCred(null)} className="flex-1 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs">Cancel</button>
                                  <button onClick={() => saveWinCred(infoServer!.id, c.id)} disabled={editWinCredWorking || !editWinCredForm.username}
                                    className="flex-1 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium">{editWinCredWorking ? 'Saving…' : 'Save Changes'}</button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-sm font-medium text-white">🔑 {c.label}</p>
                                      {c.category === 'windows' && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 font-medium">RDP+SSH</span>}
                                    </div>
                                    <p className="text-xs text-gray-400 mt-0.5">User: <span className="text-gray-200 font-mono">{c.service_username ?? '—'}</span>{domain && <span className="ml-2">Domain: <span className="text-gray-200 font-mono">{domain}</span></span>}</p>
                                  </div>
                                  <div className="flex gap-1.5 shrink-0">
                                    <button onClick={() => copyPasswordSilently(infoServer!.id, c.id, 'rdp')}
                                      className={`px-2 py-0.5 text-xs rounded transition-colors ${copiedCred === c.id ? 'bg-green-700 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                                      {copiedCred === c.id ? '✓ Copied' : '📋 Copy'}
                                    </button>
                                    <button onClick={() => { setEditWinCred(c); const dom = c.notes?.match(/^Domain:\s*(.+)$/im)?.[1] ?? ''; setEditWinCredForm({ label: c.label, username: c.service_username ?? '', password: '', domain: dom, use_for_ssh: c.category === 'windows' }) }}
                                      className="px-2 py-0.5 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white">Edit</button>
                                    <button onClick={() => deleteWinCred(infoServer!.id, c.id, false)}
                                      className="px-2 py-0.5 text-xs rounded bg-red-800 hover:bg-red-700 text-white">Archive</button>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {revealedWinPasswords[c.id]
                                    ? <span className="font-mono text-xs text-green-300 bg-gray-900 px-2 py-1 rounded select-all">{revealedWinPasswords[c.id]}</span>
                                    : <button onClick={() => revealWinPassword(infoServer!.id, c.id)} className="text-xs text-blue-400 hover:text-blue-300">🔍 Reveal password</button>
                                  }
                                  {revealedWinPasswords[c.id] && <button onClick={() => setRevealedWinPasswords(p => { const n = { ...p }; delete n[c.id]; return n })} className="text-xs text-gray-500 hover:text-gray-300">Hide</button>}
                                </div>
                              </>
                            )}
                          </div>
                        )
                      })}
                      {winCreds.some(c => c.is_archived) && (
                        <details className="mt-2">
                          <summary className="text-xs text-gray-500 cursor-pointer">Archived ({winCreds.filter(c => c.is_archived).length})</summary>
                          <div className="mt-2 space-y-1.5">
                            {winCreds.filter(c => c.is_archived).map(c => (
                              <div key={c.id} className="bg-gray-900 border border-gray-700/50 rounded p-2.5 space-y-1.5 opacity-70">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-gray-400">🗄 {c.label} — {c.service_username}</span>
                                  <div className="flex gap-1.5 shrink-0">
                                    <button onClick={() => revealedWinPasswords[c.id] ? setRevealedWinPasswords(p => { const n={...p}; delete n[c.id]; return n }) : revealWinPassword(infoServer!.id, c.id)}
                                      className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300">{revealedWinPasswords[c.id] ? 'Hide' : '🔍 Reveal'}</button>
                                    <button onClick={() => deleteWinCred(infoServer!.id, c.id, true)} className="px-2 py-0.5 text-xs rounded bg-red-900 hover:bg-red-800 text-red-300">Delete</button>
                                  </div>
                                </div>
                                {revealedWinPasswords[c.id] && <span className="font-mono text-xs text-green-300 bg-gray-950 px-2 py-1 rounded select-all block break-all">{revealedWinPasswords[c.id]}</span>}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                      {winCreds.length === 0 && !winCredsLoading && !showAddWinCred && (
                        <p className="text-gray-500 text-sm text-center py-6">No RDP credentials stored. Click "Add Credential" to save one.</p>
                      )}
                    </div>
                )}
                {/* SSH Users tab */}
                {infoTab === 'users' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-gray-500">SSH user credentials for Windows OpenSSH. Stored encrypted in the vault.</p>
                      <button onClick={() => { setShowCredForm(true); setCredFormError(''); setCredForm({ category: 'linux', linux_user: '', service_name: '', service_username: '', label: '', password: '', notes: '', apply_on_server: false }) }}
                        className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors font-medium">+ Add SSH User</button>
                    </div>
                    {showCredForm && (
                      <div className="bg-gray-800 border border-indigo-700/50 rounded-lg p-4 space-y-3">
                        <p className="text-sm font-semibold text-white">New SSH User</p>
                        {credFormError && <p className="text-red-400 text-xs">{credFormError}</p>}
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block"><span className="text-xs text-gray-400">Label</span>
                            <input value={credForm.label} onChange={e => setCredForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. admin account"
                              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                          <label className="block"><span className="text-xs text-gray-400">Username</span>
                            <input value={credForm.linux_user} onChange={e => setCredForm(f => ({ ...f, linux_user: e.target.value }))} placeholder="Administrator"
                              className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                        </div>
                        <label className="block"><span className="text-xs text-gray-400">Password</span>
                          <input type="password" value={credForm.password} onChange={e => setCredForm(f => ({ ...f, password: e.target.value }))}
                            className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                        <label className="block"><span className="text-xs text-gray-400">Notes <span className="text-gray-600">(optional)</span></span>
                          <input value={credForm.notes} onChange={e => setCredForm(f => ({ ...f, notes: e.target.value }))}
                            className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                        <div className="flex gap-2 pt-1">
                          <button onClick={() => setShowCredForm(false)} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                          <button onClick={() => createCredential(infoServer!.id)} disabled={credFormWorking || !credForm.label || !credForm.password}
                            className="flex-1 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition-colors">{credFormWorking ? 'Saving…' : 'Save to Vault'}</button>
                        </div>
                      </div>
                    )}
                    {credLoading && <p className="text-center text-gray-500 text-sm py-4">Loading…</p>}
                    {credentials.filter(c => ['linux','windows'].includes(c.category) && !c.is_archived).map(c => {
                      const isRevealed = !!revealedPasswords[c.id]
                      return (
                        <div key={c.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium text-white">🐧 {c.label}</p>
                                {c.category === 'windows' && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 font-medium">RDP+SSH</span>}
                              </div>
                              {c.linux_user && <p className="text-xs text-gray-400 mt-0.5">User: <span className="text-gray-200 font-mono">{c.linux_user}</span></p>}
                              {c.notes && <p className="text-xs text-gray-500 mt-0.5">{c.notes}</p>}
                            </div>
                            <div className="flex gap-1.5 shrink-0">
                              <button onClick={() => copyPasswordSilently(infoServer!.id, c.id, 'linux')}
                                className={`px-2 py-0.5 text-xs rounded transition-colors ${copiedCred === c.id ? 'bg-green-700 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                                {copiedCred === c.id ? '✓ Copied' : '📋 Copy'}
                              </button>
                              <button onClick={() => isRevealed ? hidePassword(c.id) : revealPassword(infoServer!.id, c.id)}
                                className="px-2 py-0.5 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors">
                                {isRevealed ? 'Hide' : '🔍 Reveal'}
                              </button>
                              <button onClick={() => promptDeleteCred(c.id)}
                                className="px-2 py-0.5 text-xs rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Archive</button>
                            </div>
                          </div>
                          {isRevealed && (
                            <span className="font-mono text-xs text-green-300 bg-gray-900 px-2 py-1 rounded select-all block break-all">{revealedPasswords[c.id]}</span>
                          )}
                        </div>
                      )
                    })}
                    {credentials.filter(c => ['linux','windows'].includes(c.category) && !c.is_archived).length === 0 && !credLoading && !showCredForm && (
                      <p className="text-gray-500 text-sm text-center py-6">No SSH users stored. Click "Add SSH User" to save one.</p>
                    )}
                    {credentials.some(c => ['linux','windows'].includes(c.category) && c.is_archived) && (
                      <details className="mt-2">
                        <summary className="text-xs text-gray-500 cursor-pointer">Archived ({credentials.filter(c => ['linux','windows'].includes(c.category) && c.is_archived).length})</summary>
                        <div className="mt-2 space-y-1.5">
                          {credentials.filter(c => ['linux','windows'].includes(c.category) && c.is_archived).map(c => (
                            <div key={c.id} className="bg-gray-900 border border-gray-700/50 rounded p-2.5 space-y-1.5 opacity-70">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs text-gray-400">🗄 {c.label} — {c.linux_user}</span>
                                <div className="flex gap-1.5 shrink-0">
                                  <button onClick={() => revealedPasswords[c.id] ? hidePassword(c.id) : revealPassword(infoServer!.id, c.id)}
                                    className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300">{revealedPasswords[c.id] ? 'Hide' : '🔍 Reveal'}</button>
                                  <button onClick={() => promptDeleteCred(c.id)} className="px-2 py-0.5 text-xs rounded bg-red-900 hover:bg-red-800 text-red-300">Delete</button>
                                </div>
                              </div>
                              {revealedPasswords[c.id] && <span className="font-mono text-xs text-green-300 bg-gray-950 px-2 py-1 rounded select-all block break-all">{revealedPasswords[c.id]}</span>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {serverInfo && (
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {/* Tabs */}
              <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-med)', flexShrink: 0, flexWrap: 'wrap' }}>
                {(infoServer?.os_type === 'windows'
                  ? (['overview', 'credentials', 'users', 'keys'] as const)
                  : (['overview', 'users', 'keys', 'credentials', 'software', 'recommendations', 'benchmark', 'ai'] as const)
                ).map((t) => (
                  <button key={t}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setInfoTab(t as typeof infoTab)
                      setShowAddUser(false)
                      setEditUserTarget(null)
                      setPushKeyTarget(null)
                      if (t === 'software' && software.length === 0 && !softwareLoading) loadSoftware(infoServer!.id)
                      if (t === 'recommendations' && recommendations.length === 0 && !recLoading) loadRecommendations(infoServer!.id)
                      if (t === 'benchmark' && !benchmark && !benchmarkLoading) loadBenchmark(infoServer!.id)
                    }}
                    style={{
                      padding: '9px 14px', fontSize: 13, fontWeight: 500,
                      cursor: 'pointer', background: 'none', border: 'none',
                      borderBottom: infoTab === t ? '2px solid var(--accent-hex)' : '2px solid transparent',
                      color: infoTab === t ? 'var(--accent-hex)' : 'var(--text-secondary)',
                      marginBottom: -1, transition: 'color 0.1s', whiteSpace: 'nowrap',
                    }}>
                    {t === 'keys' ? 'Auth Keys'
                      : t === 'users'
                        ? infoServer?.os_type === 'windows'
                          ? `🐧 SSH Users (${credentials.filter(c => ['linux','windows'].includes(c.category) && !c.is_archived).length})`
                          : `Users (${serverInfo.users.length})`
                      : t === 'credentials'
                        ? infoServer?.os_type === 'windows'
                          ? `🔑 RDP Credentials (${winCreds.filter(c => !c.is_archived).length})`
                          : `Vault (${credentials.filter((c) => !c.is_archived).length})`
                      : t === 'software' ? '📦 Software'
                      : t === 'recommendations' ? '💡 Best Practices'
                      : t === 'benchmark' ? '🔐 Security Benchmark'
                      : t === 'ai' ? '🤖 AI Analyst'
                      : 'Overview'}
                  </button>
                ))}
              </div>

              {/* Tab content — fixed height prevents layout shift when content changes */}
              <div style={{ height: 480, overflowY: 'auto', paddingTop: 16, paddingRight: 18 }}>

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
                  {/* PermitRootLogin status / alert — Linux only */}
                  {serverInfo.os_type !== 'windows' && (
                    sshdStatusLoading ? (
                      <div className="bg-gray-800 rounded-lg p-3 text-xs text-gray-500 animate-pulse">Reading sshd config…</div>
                    ) : sshdStatus && (
                      <div className={`rounded-lg p-3 space-y-1 ${sshdStatus.permitRootLogin === 'yes' ? 'bg-orange-950 border border-orange-700' : 'bg-gray-800'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className={`text-xs font-medium uppercase tracking-wide ${sshdStatus.permitRootLogin === 'yes' ? 'text-orange-300' : 'text-gray-400'}`}>Root Login (sshd)</p>
                          <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                            sshdStatus.permitRootLogin === 'yes' ? 'bg-orange-700 text-white' :
                            sshdStatus.permitRootLogin === 'prohibit-password' ? 'bg-green-900/50 text-green-300' :
                            'bg-gray-700 text-gray-300'
                          }`}>{sshdStatus.permitRootLogin}</span>
                        </div>
                        {sshdStatus.rootLocked && (
                          <p className="text-xs text-amber-300">⚠ Root account is locked (no password set)</p>
                        )}
                        {sshdStatus.permitRootLogin === 'yes' && (
                          <p className="text-xs text-orange-200">⚠ Root can log in with password — consider hardening to <span className="font-mono">prohibit-password</span> after SSH key is set up</p>
                        )}
                        {sshdStatus.permitRootLogin === 'prohibit-password' && (
                          <p className="text-xs text-green-400">✓ Root login via SSH key only (recommended)</p>
                        )}
                      </div>
                    )
                  )}

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
              {infoTab === 'users' && infoServer?.os_type === 'windows' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">SSH user credentials for Windows OpenSSH. Stored encrypted in the vault.</p>
                    <button onClick={() => { setShowCredForm(true); setCredFormError(''); setCredForm({ category: 'linux', linux_user: '', service_name: '', service_username: '', label: '', password: '', notes: '', apply_on_server: false }) }}
                      className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors font-medium">+ Add SSH User</button>
                  </div>
                  {showCredForm && (
                    <div className="bg-gray-800 border border-indigo-700/50 rounded-lg p-4 space-y-3">
                      <p className="text-sm font-semibold text-white">New SSH User</p>
                      {credFormError && <p className="text-red-400 text-xs">{credFormError}</p>}
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block"><span className="text-xs text-gray-400">Label</span>
                          <input value={credForm.label} onChange={e => setCredForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. admin account"
                            className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                        <label className="block"><span className="text-xs text-gray-400">Username</span>
                          <input value={credForm.linux_user} onChange={e => setCredForm(f => ({ ...f, linux_user: e.target.value }))} placeholder="Administrator"
                            className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                      </div>
                      <label className="block"><span className="text-xs text-gray-400">Password</span>
                        <input type="password" value={credForm.password} onChange={e => setCredForm(f => ({ ...f, password: e.target.value }))}
                          className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                      <label className="block"><span className="text-xs text-gray-400">Notes <span className="text-gray-600">(optional)</span></span>
                        <input value={credForm.notes} onChange={e => setCredForm(f => ({ ...f, notes: e.target.value }))}
                          className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => setShowCredForm(false)} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                        <button onClick={() => createCredential(infoServer!.id)} disabled={credFormWorking || !credForm.label || !credForm.password}
                          className="flex-1 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition-colors">{credFormWorking ? 'Saving…' : 'Save to Vault'}</button>
                      </div>
                    </div>
                  )}
                  {credLoading && <p className="text-center text-gray-500 text-sm py-4">Loading…</p>}
                  {credentials.filter(c => ['linux','windows'].includes(c.category) && !c.is_archived).map(c => {
                    const isRevealed = !!revealedPasswords[c.id]
                    const verifyState = verifyCredResult[c.id]
                    return (
                      <div key={c.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-medium text-white">🐧 {c.label}</p>
                              {c.category === 'windows' && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 font-medium">RDP+SSH</span>}
                            </div>
                            {c.linux_user && <p className="text-xs text-gray-400 mt-0.5">User: <span className="text-gray-200 font-mono">{c.linux_user}</span></p>}
                            {c.notes && <p className="text-xs text-gray-500 mt-0.5">{c.notes}</p>}
                          </div>
                          <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                            <button onClick={() => copyPasswordSilently(infoServer!.id, c.id, 'linux')}
                              className={`px-2 py-0.5 text-xs rounded transition-colors ${copiedCred === c.id ? 'bg-green-700 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                              {copiedCred === c.id ? '✓ Copied' : '📋 Copy'}
                            </button>
                            <button onClick={() => isRevealed ? hidePassword(c.id) : revealPassword(infoServer!.id, c.id)}
                              className="px-2 py-0.5 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors">
                              {isRevealed ? 'Hide' : '🔍 Reveal'}
                            </button>
                            <button
                              onClick={() => verifyCredential(infoServer!.id, c.id)}
                              disabled={verifyingCred === c.id}
                              className={`px-2 py-0.5 text-xs rounded transition-colors disabled:opacity-50 ${
                                verifyState === 'match' ? 'bg-green-800 text-green-200' :
                                verifyState === 'mismatch' ? 'bg-red-800 text-red-200' :
                                verifyState === 'error' ? 'bg-yellow-800 text-yellow-200' :
                                'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                              {verifyingCred === c.id ? '⏳' :
                               verifyState === 'match' ? '✓ Matches' :
                               verifyState === 'mismatch' ? '✗ Mismatch' :
                               verifyState === 'error' ? '⚠ Error' : '🔎 Verify'}
                            </button>
                            <button onClick={() => promptDeleteCred(c.id)}
                              className="px-2 py-0.5 text-xs rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Archive</button>
                          </div>
                        </div>
                        {verifyState === 'mismatch' && (
                          <p className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-2 py-1">
                            ⚠ Stored password does not match the server — it may have been changed outside SSH Manager. Update it here to stay in sync.
                          </p>
                        )}
                        {isRevealed && (
                          <span className="font-mono text-xs text-green-300 bg-gray-900 px-2 py-1 rounded select-all block break-all">{revealedPasswords[c.id]}</span>
                        )}
                      </div>
                    )
                  })}
                  {credentials.filter(c => ['linux','windows'].includes(c.category) && !c.is_archived).length === 0 && !credLoading && !showCredForm && (
                    <p className="text-gray-500 text-sm text-center py-6">No SSH users stored. Click "Add SSH User" to save one.</p>
                  )}
                  {credentials.some(c => ['linux','windows'].includes(c.category) && c.is_archived) && (
                    <details className="mt-2">
                      <summary className="text-xs text-gray-500 cursor-pointer">Archived ({credentials.filter(c => ['linux','windows'].includes(c.category) && c.is_archived).length})</summary>
                      <div className="mt-2 space-y-1.5">
                        {credentials.filter(c => ['linux','windows'].includes(c.category) && c.is_archived).map(c => (
                          <div key={c.id} className="bg-gray-900 border border-gray-700/50 rounded p-2.5 space-y-1.5 opacity-70">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs text-gray-400">🗄 {c.label} — {c.linux_user}</span>
                              <div className="flex gap-1.5 shrink-0">
                                <button onClick={() => revealedPasswords[c.id] ? hidePassword(c.id) : revealPassword(infoServer!.id, c.id)}
                                  className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300">{revealedPasswords[c.id] ? 'Hide' : '🔍 Reveal'}</button>
                                <button onClick={() => promptDeleteCred(c.id)} className="px-2 py-0.5 text-xs rounded bg-red-900 hover:bg-red-800 text-red-300">Delete</button>
                              </div>
                            </div>
                            {revealedPasswords[c.id] && <span className="font-mono text-xs text-green-300 bg-gray-950 px-2 py-1 rounded select-all block break-all">{revealedPasswords[c.id]}</span>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
              {infoTab === 'users' && infoServer?.os_type !== 'windows' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-xs text-gray-500">Linux users with uid ≥ 1000 (and root). Click a row to push an SSH key or delete.</p>
                    <div className="flex gap-2 flex-wrap">
                      {/* Ubuntu: Activate root (unlock password) */}
                      {sshdStatus?.rootLocked && (
                        activateRootPrompt ? (
                          <div className="flex items-center gap-1">
                            <input type="password" autoFocus placeholder="new root password"
                              value={activateRootPassword} onChange={e => setActivateRootPassword(e.target.value)}
                              onKeyDown={async e => {
                                if (e.key === 'Escape') { setActivateRootPrompt(false); setActivateRootPassword('') }
                                if (e.key === 'Enter' && activateRootPassword) {
                                  setActivateRootPrompt(false); setActivateRootWorking(true); setActivateRootResult(null)
                                  try {
                                    const res = await api.post<{ ok: boolean; steps: string[] }>(`/servers/${infoServer!.id}/root/activate`, { root_password: activateRootPassword })
                                    setActivateRootResult(res)
                                    if (res.ok) loadSshdStatus(infoServer!.id)
                                  } catch (err: any) {
                                    setActivateRootResult({ ok: false, steps: [err?.data?.error ?? err?.message ?? 'Failed'] })
                                  } finally { setActivateRootWorking(false); setActivateRootPassword('') }
                                }
                              }}
                              className="px-2 py-0.5 text-xs rounded bg-gray-900 border border-purple-700 text-white w-36 focus:outline-none" />
                            <button disabled={!activateRootPassword || activateRootWorking}
                              onClick={async () => {
                                setActivateRootPrompt(false); setActivateRootWorking(true); setActivateRootResult(null)
                                try {
                                  const res = await api.post<{ ok: boolean; steps: string[] }>(`/servers/${infoServer!.id}/root/activate`, { root_password: activateRootPassword })
                                  setActivateRootResult(res)
                                  if (res.ok) loadSshdStatus(infoServer!.id)
                                } catch (err: any) {
                                  setActivateRootResult({ ok: false, steps: [err?.data?.error ?? err?.message ?? 'Failed'] })
                                } finally { setActivateRootWorking(false); setActivateRootPassword('') }
                              }}
                              className="px-2 py-0.5 text-xs rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50">→</button>
                            <button onClick={() => { setActivateRootPrompt(false); setActivateRootPassword('') }}
                              className="px-2 py-0.5 text-xs rounded bg-gray-700 text-gray-300 hover:bg-gray-600">✕</button>
                          </div>
                        ) : (
                          <button onClick={() => { setActivateRootResult(null); setActivateRootPrompt(true) }}
                            disabled={activateRootWorking}
                            title="Root account is locked — run sudo passwd root to set a root password and unlock the account"
                            className="px-3 py-1 text-xs rounded bg-purple-700/40 hover:bg-purple-700/60 text-purple-300 transition-colors font-medium disabled:opacity-50">
                            {activateRootWorking ? '⏳ Working…' : '🔓 Activate Root'}
                          </button>
                        )
                      )}
                      {/* Setup Root SSH — push management key to root */}
                      <button
                        onClick={async () => {
                          setEnableRootSshResult(null)
                          setEnableRootSshWorking(true)
                          try {
                            const res = await api.post<{ ok: boolean; steps: string[] }>(`/servers/${infoServer!.id}/enable-root-ssh`, {})
                            setEnableRootSshResult(res)
                            if (res.ok) loadSshdStatus(infoServer!.id)
                          } catch (err: any) {
                            setEnableRootSshResult({ ok: false, steps: [err?.data?.error ?? err?.message ?? 'Failed'] })
                          } finally { setEnableRootSshWorking(false) }
                        }}
                        disabled={enableRootSshWorking}
                        title="Uses the root vault credential to elevate privileges and push the management SSH key to /root/.ssh/authorized_keys"
                        className="px-3 py-1 text-xs rounded bg-amber-700/40 hover:bg-amber-700/60 text-amber-300 transition-colors font-medium disabled:opacity-50">
                        {enableRootSshWorking ? '⏳ Working…' : '🔑 Setup Root SSH'}
                      </button>
                      {/* PermitRootLogin controls */}
                      {sshdStatus && sshdStatus.permitRootLogin !== 'yes' && (
                        <button
                          onClick={async () => {
                            setPermitLoginResult(null); setPermitLoginWorking(true)
                            try {
                              const res = await api.post<{ ok: boolean; steps: string[]; value: string }>(`/servers/${infoServer!.id}/root/permit-login`, { value: 'yes' })
                              setPermitLoginResult(res)
                              if (res.ok) loadSshdStatus(infoServer!.id)
                            } catch (err: any) {
                              setPermitLoginResult({ ok: false, steps: [err?.data?.error ?? err?.message ?? 'Failed'] })
                            } finally { setPermitLoginWorking(false) }
                          }}
                          disabled={permitLoginWorking}
                          title="Set PermitRootLogin yes — allows root password SSH login (needed to push SSH key to root)"
                          className="px-3 py-1 text-xs rounded bg-orange-700/40 hover:bg-orange-700/60 text-orange-300 transition-colors font-medium disabled:opacity-50">
                          {permitLoginWorking ? '⏳' : '🔓 Allow Root Password Login'}
                        </button>
                      )}
                      {sshdStatus && sshdStatus.permitRootLogin === 'yes' && (
                        <button
                          onClick={async () => {
                            setPermitLoginResult(null); setPermitLoginWorking(true)
                            try {
                              const res = await api.post<{ ok: boolean; steps: string[]; value: string }>(`/servers/${infoServer!.id}/root/permit-login`, { value: 'prohibit-password' })
                              setPermitLoginResult(res)
                              if (res.ok) loadSshdStatus(infoServer!.id)
                            } catch (err: any) {
                              setPermitLoginResult({ ok: false, steps: [err?.data?.error ?? err?.message ?? 'Failed'] })
                            } finally { setPermitLoginWorking(false) }
                          }}
                          disabled={permitLoginWorking}
                          title="Set PermitRootLogin prohibit-password — SSH key only for root (recommended)"
                          className="px-3 py-1 text-xs rounded bg-green-700/40 hover:bg-green-700/60 text-green-300 transition-colors font-medium disabled:opacity-50">
                          {permitLoginWorking ? '⏳' : '🛡 Harden Root (Key Only)'}
                        </button>
                      )}
                      <button onClick={() => { setShowAddUser(true); setPushKeyTarget(null) }}
                        className="px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors font-medium">
                        + Add User
                      </button>
                    </div>
                  </div>

                  {/* Result panels */}
                  {activateRootResult && (
                    <div className={`rounded-lg p-3 text-xs space-y-1 ${activateRootResult.ok ? 'bg-green-900/30 border border-green-700/50' : 'bg-red-900/30 border border-red-700/50'}`}>
                      <p className={`font-semibold ${activateRootResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                        {activateRootResult.ok ? '✓ Root activated' : '✗ Failed'}
                      </p>
                      {activateRootResult.steps.map((s, i) => <p key={i} className="text-gray-400 font-mono">{s}</p>)}
                      {activateRootResult.ok && <p className="text-gray-500 pt-1">Root password set. Now add a <strong className="text-white">root</strong> vault credential and click <strong className="text-white">Setup Root SSH</strong>.</p>}
                    </div>
                  )}
                  {permitLoginResult && (
                    <div className={`rounded-lg p-3 text-xs space-y-1 ${permitLoginResult.ok ? 'bg-green-900/30 border border-green-700/50' : 'bg-red-900/30 border border-red-700/50'}`}>
                      <p className={`font-semibold ${permitLoginResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                        {permitLoginResult.ok ? `✓ PermitRootLogin set to ${permitLoginResult.value}` : '✗ Failed'}
                      </p>
                      {permitLoginResult.steps.map((s, i) => <p key={i} className="text-gray-400 font-mono">{s}</p>)}
                    </div>
                  )}
                  {enableRootSshResult && (
                    <div className={`rounded-lg p-3 text-xs space-y-1 ${enableRootSshResult.ok ? 'bg-green-900/30 border border-green-700/50' : 'bg-red-900/30 border border-red-700/50'}`}>
                      <p className={`font-semibold ${enableRootSshResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                        {enableRootSshResult.ok ? '✓ Root SSH login enabled' : '✗ Failed'}
                      </p>
                      {enableRootSshResult.steps.map((s, i) => (
                        <p key={i} className="text-gray-400 font-mono">{s}</p>
                      ))}
                      {enableRootSshResult.ok && (
                        <p className="text-gray-500 pt-1">SSH key pushed to root. Now go to <strong className="text-white">Edit Server</strong> and change the SSH username to <span className="font-mono text-white">root</span>.</p>
                      )}
                    </div>
                  )}

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
                        <label className="block col-span-2">
                          <span className="text-xs text-gray-400">Password <span className="text-gray-600">(optional — set login password via chpasswd)</span></span>
                          <input type="password" value={addUserForm.password} onChange={(e) => setAddUserForm((f) => ({ ...f, password: e.target.value }))}
                            placeholder="Leave blank for no password (SSH key only)"
                            className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                      </div>
                      <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={addUserForm.system_user} onChange={(e) => setAddUserForm((f) => ({ ...f, system_user: e.target.checked }))} className="rounded" />
                          <span className="text-xs text-gray-400">System user</span>
                        </label>
                        {addUserForm.password && (
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={addUserForm.save_to_vault} onChange={(e) => setAddUserForm((f) => ({ ...f, save_to_vault: e.target.checked }))} className="rounded" />
                            <span className="text-xs text-gray-400">Save password to vault</span>
                          </label>
                        )}
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button type="button" onClick={() => setShowAddUser(false)} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                        <button type="submit" disabled={addUserWorking}
                          className="flex-1 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors disabled:opacity-50">
                          {addUserWorking ? 'Creating…' : 'Create User'}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Edit User Panel */}
                  {editUserTarget && (
                    <form onSubmit={saveEditUser} className="bg-gray-800 border border-indigo-700 rounded-lg p-3 space-y-3">
                      <p className="text-sm font-medium text-white">Edit User — <span className="font-mono text-indigo-300">{editUserTarget}</span></p>
                      {editUserError && <p className="text-red-400 text-xs">{editUserError}</p>}
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="text-xs text-gray-400">Shell</span>
                          <select value={editUserForm.shell} onChange={(e) => setEditUserForm((f) => ({ ...f, shell: e.target.value }))}
                            className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                            <option value="/bin/bash">/bin/bash</option>
                            <option value="/bin/sh">/bin/sh</option>
                            <option value="/usr/sbin/nologin">/usr/sbin/nologin (no login)</option>
                            <option value="/bin/false">/bin/false (no login)</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-xs text-gray-400">Full Name / Comment</span>
                          <input value={editUserForm.comment} onChange={(e) => setEditUserForm((f) => ({ ...f, comment: e.target.value }))}
                            placeholder="Leave blank to keep current"
                            className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block col-span-2">
                          <span className="text-xs text-gray-400">New Password <span className="text-gray-600">(leave blank to keep current)</span></span>
                          <input type="password" value={editUserForm.password} onChange={(e) => setEditUserForm((f) => ({ ...f, password: e.target.value }))}
                            placeholder="New login password"
                            className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                      </div>
                      {editUserForm.password && (
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={editUserForm.save_to_vault} onChange={(e) => setEditUserForm((f) => ({ ...f, save_to_vault: e.target.checked }))} className="rounded" />
                          <span className="text-xs text-gray-400">Save new password to vault (archives old)</span>
                        </label>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button type="button" onClick={() => setEditUserTarget(null)} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                        <button type="submit" disabled={editUserWorking}
                          className="flex-1 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors disabled:opacity-50">
                          {editUserWorking ? 'Saving…' : 'Save Changes'}
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
                                    onClick={() => { setPushKeyTarget(u.username); setShowAddUser(false); setEditUserTarget(null); setPushKeyId(''); setPushKeyError('') }}
                                    className="px-2 py-0.5 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
                                    Push Key
                                  </button>
                                  {!isProtected && (
                                    <button
                                      onClick={() => openEditUser(u)}
                                      className="px-2 py-0.5 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors">
                                      Edit
                                    </button>
                                  )}
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
                    const userKeyCount = serverInfo.authorized_keys.filter(x => x.linux_user === k.linux_user).length
                    const canSetMgmt = !isManagementKey && !isArchived && k.is_known && k.db_key_id && userKeyCount > 1
                    const borderClass = isArchived
                      ? 'bg-orange-950/30 border-orange-700/60'
                      : k.is_known ? 'bg-gray-800 border-gray-700'
                      : 'bg-red-950/30 border-red-800/60'
                    return (
                      <div key={i} className={`rounded-lg border ${borderClass} overflow-hidden`}>
                        {/* Header row */}
                        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                          {/* Left: key type + user + name badges */}
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-700/80 text-indigo-300 shrink-0">{k.key_type}</span>
                            <span className="text-xs text-gray-400 shrink-0">for <span className="text-white font-semibold font-mono">{k.linux_user}</span></span>
                            {isArchived ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-300 border border-orange-700/60">🗄 {k.db_key_name} (archived)</span>
                            ) : k.is_known ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-800/60">✓ {k.db_key_name}</span>
                            ) : (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-800/60">⚠ Unknown key</span>
                            )}
                            {isManagementKey && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-800/60">🔒 Management</span>
                            )}
                          </div>
                          {/* Right: action buttons grouped together */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            {canSetMgmt && (
                              <button
                                disabled={setMgmtKeyWorking}
                                onClick={() => setAsManagementKey(infoServer!.id, k.db_key_id!, k.linux_user)}
                                title="Use this key as the management key for SSH connections"
                                className="px-2 py-1 text-xs rounded border border-blue-700 bg-blue-900/40 hover:bg-blue-700 text-blue-300 hover:text-white cursor-pointer font-medium transition-colors disabled:opacity-50 whitespace-nowrap">
                                {setMgmtKeyWorking ? '…' : '🔒 Set as Management'}
                              </button>
                            )}
                            {confirmRevokeKey?.key_body === k.key_body && confirmRevokeKey?.linux_user === k.linux_user ? (
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-gray-400">Remove?</span>
                                <button
                                  disabled={revokeWorking}
                                  onClick={() => revokeAuthorizedKey(infoServer!.id, k.linux_user, k.key_body)}
                                  className="px-2 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white cursor-pointer font-medium disabled:opacity-50">
                                  {revokeWorking ? '…' : 'Yes'}
                                </button>
                                <button
                                  disabled={revokeWorking}
                                  onClick={() => setConfirmRevokeKey(null)}
                                  className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white cursor-pointer font-medium">
                                  No
                                </button>
                              </div>
                            ) : (
                              <button
                                disabled={isManagementKey}
                                onClick={() => !isManagementKey && setConfirmRevokeKey({ linux_user: k.linux_user, key_body: k.key_body })}
                                title={isManagementKey ? 'Cannot remove — this is the active management key' : 'Remove from authorized_keys'}
                                className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                                  isManagementKey
                                    ? 'border border-gray-700 text-gray-600 cursor-not-allowed'
                                    : isArchived
                                    ? 'border border-orange-700 bg-orange-900/40 hover:bg-orange-700 text-orange-300 hover:text-white cursor-pointer'
                                    : 'border border-red-800 bg-red-900/40 hover:bg-red-700 text-red-400 hover:text-white cursor-pointer'}`}>
                                Revoke
                              </button>
                            )}
                          </div>
                        </div>
                        {/* Footer: fingerprint + optional comment */}
                        <div className="px-3 pb-2.5 space-y-0.5">
                          {isArchived && (
                            <p className="text-xs text-orange-400/80">⚠ Archived — still on server. Revoke to close the access gap.</p>
                          )}
                          {k.comment && <p className="text-xs text-gray-500">Comment: <span className="text-gray-400 font-mono">{k.comment}</span></p>}
                          <p className="text-xs font-mono text-gray-600 break-all">fp: <span className="text-gray-500">{k.fingerprint || '—'}</span></p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Windows RDP Credentials Tab (only for Windows servers) */}
              {infoTab === 'credentials' && infoServer?.os_type === 'windows' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">RDP credentials stored in the vault. Use these to connect via Remote Desktop.</p>
                    <button onClick={() => { setShowAddWinCred(true); setAddWinCredError('') }}
                      className="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded-lg transition-colors font-medium">
                      + Add Credential
                    </button>
                  </div>

                  {showAddWinCred && (
                    <div className="bg-gray-800 border border-blue-700/50 rounded-lg p-4 space-y-3">
                      <p className="text-sm font-semibold text-white">New RDP Credential</p>
                      {addWinCredError && <p className="text-red-400 text-xs">{addWinCredError}</p>}
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                          <span className="text-xs text-gray-400">Username</span>
                          <input value={addWinCredForm.username} onChange={e => setAddWinCredForm(f => ({ ...f, username: e.target.value }))}
                            placeholder="Administrator"
                            className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </label>
                        <label className="block">
                          <span className="text-xs text-gray-400">Domain <span className="text-gray-600">(optional)</span></span>
                          <input value={addWinCredForm.domain} onChange={e => setAddWinCredForm(f => ({ ...f, domain: e.target.value }))}
                            placeholder="CONTOSO"
                            className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                        </label>
                      </div>
                      <label className="block">
                        <span className="text-xs text-gray-400">Password</span>
                        <div className="relative mt-1">
                          <input type={addWinCredForm.show_pw ? 'text' : 'password'} value={addWinCredForm.password}
                            onChange={e => setAddWinCredForm(f => ({ ...f, password: e.target.value }))}
                            className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 pr-14" />
                          <button type="button" onClick={() => setAddWinCredForm(f => ({ ...f, show_pw: !f.show_pw }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-200">
                            {addWinCredForm.show_pw ? 'Hide' : 'Show'}
                          </button>
                        </div>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input type="checkbox" checked={addWinCredForm.use_for_ssh} onChange={e => setAddWinCredForm(f => ({ ...f, use_for_ssh: e.target.checked }))}
                          className="rounded border-gray-600 bg-gray-700 text-blue-500" />
                        <span className="text-xs text-gray-300">Also use for SSH (domain admin)</span>
                      </label>
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => setShowAddWinCred(false)} className="flex-1 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                        <button onClick={() => addWinCred(infoServer!.id)} disabled={addWinCredWorking || !addWinCredForm.username || !addWinCredForm.password}
                          className="flex-1 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium transition-colors">
                          {addWinCredWorking ? 'Saving…' : 'Save Credential'}
                        </button>
                      </div>
                    </div>
                  )}

                  {winCredsLoading && <p className="text-center text-gray-500 text-sm py-4">Loading…</p>}

                  {/* Active credentials */}
                  {winCreds.filter(c => !c.is_archived).map(c => {
                    const domain = c.notes?.match(/^Domain:\s*(.+)$/im)?.[1]
                    return (
                      <div key={c.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2">
                        {editWinCred?.id === c.id ? (
                          <div className="space-y-2">
                            <p className="text-xs font-semibold text-white">Edit Credential</p>
                            <div className="grid grid-cols-2 gap-2">
                              <label className="block">
                                <span className="text-xs text-gray-400">Label</span>
                                <input value={editWinCredForm.label} onChange={e => setEditWinCredForm(f => ({ ...f, label: e.target.value }))}
                                  className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                              </label>
                              <label className="block">
                                <span className="text-xs text-gray-400">Username</span>
                                <input value={editWinCredForm.username} onChange={e => setEditWinCredForm(f => ({ ...f, username: e.target.value }))}
                                  className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                              </label>
                              <label className="block">
                                <span className="text-xs text-gray-400">Domain <span className="text-gray-600">(optional)</span></span>
                                <input value={editWinCredForm.domain} onChange={e => setEditWinCredForm(f => ({ ...f, domain: e.target.value }))}
                                  className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                              </label>
                              <label className="block">
                                <span className="text-xs text-gray-400">New Password <span className="text-gray-600">(blank = keep)</span></span>
                                <input type="password" value={editWinCredForm.password} onChange={e => setEditWinCredForm(f => ({ ...f, password: e.target.value }))}
                                  placeholder="Leave blank to keep current"
                                  className="mt-1 w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                              </label>
                            </div>
                            <label className="flex items-center gap-2 mt-1">
                              <input type="checkbox" checked={editWinCredForm.use_for_ssh} onChange={e => setEditWinCredForm(f => ({ ...f, use_for_ssh: e.target.checked }))} className="rounded" />
                              <span className="text-xs text-gray-300">Also use for SSH (domain admin)</span>
                            </label>
                            <div className="flex gap-2">
                              <button onClick={() => setEditWinCred(null)} className="flex-1 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white text-xs transition-colors">Cancel</button>
                              <button onClick={() => saveWinCred(infoServer!.id, c.id)} disabled={editWinCredWorking || !editWinCredForm.username}
                                className="flex-1 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium transition-colors">
                                {editWinCredWorking ? 'Saving…' : 'Save Changes'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-sm font-medium text-white">🔑 {c.label}</p>
                                  {c.category === 'windows' && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 font-medium">RDP+SSH</span>}
                                </div>
                                <p className="text-xs text-gray-400 mt-0.5">
                                  User: <span className="text-gray-200 font-mono">{c.service_username ?? '—'}</span>
                                  {domain && <span className="ml-2">Domain: <span className="text-gray-200 font-mono">{domain}</span></span>}
                                </p>
                              </div>
                              <div className="flex gap-1.5 shrink-0">
                                <button onClick={() => copyPasswordSilently(infoServer!.id, c.id, 'rdp')}
                                  className={`px-2 py-0.5 text-xs rounded transition-colors ${copiedCred === c.id ? 'bg-green-700 text-white' : 'bg-gray-600 hover:bg-gray-500 text-white'}`}>
                                  {copiedCred === c.id ? '✓ Copied' : '📋 Copy'}
                                </button>
                                <button onClick={() => {
                                    setEditWinCred(c)
                                    const dom = c.notes?.match(/^Domain:\s*(.+)$/im)?.[1] ?? ''
                                    setEditWinCredForm({ label: c.label, username: c.service_username ?? '', password: '', domain: dom, use_for_ssh: c.category === 'windows' })
                                  }}
                                  className="px-2 py-0.5 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white transition-colors">Edit</button>
                                <button onClick={() => deleteWinCred(infoServer!.id, c.id, false)}
                                  className="px-2 py-0.5 text-xs rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Archive</button>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {revealedWinPasswords[c.id]
                                ? <span className="font-mono text-xs text-green-300 bg-gray-900 px-2 py-1 rounded select-all">{revealedWinPasswords[c.id]}</span>
                                : <button onClick={() => revealWinPassword(infoServer!.id, c.id)}
                                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors">🔍 Reveal password</button>
                              }
                              {revealedWinPasswords[c.id] && (
                                <button onClick={() => setRevealedWinPasswords(p => { const n = { ...p }; delete n[c.id]; return n })}
                                  className="text-xs text-gray-500 hover:text-gray-300">Hide</button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })}

                  {/* Archived credentials */}
                  {winCreds.some(c => c.is_archived) && (
                    <details className="mt-2">
                      <summary className="text-xs text-gray-500 cursor-pointer">Archived credentials ({winCreds.filter(c => c.is_archived).length})</summary>
                      <div className="mt-2 space-y-1.5">
                        {winCreds.filter(c => c.is_archived).map(c => (
                          <div key={c.id} className="bg-gray-900 border border-gray-700/50 rounded p-2.5 space-y-1.5 opacity-70">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs text-gray-400">🗄 {c.label} — {c.service_username}</span>
                              <div className="flex gap-1.5 shrink-0">
                                <button onClick={() => revealedWinPasswords[c.id] ? setRevealedWinPasswords(p => { const n={...p}; delete n[c.id]; return n }) : revealWinPassword(infoServer!.id, c.id)}
                                  className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">{revealedWinPasswords[c.id] ? 'Hide' : '🔍 Reveal'}</button>
                                <button onClick={() => deleteWinCred(infoServer!.id, c.id, true)}
                                  className="px-2 py-0.5 text-xs rounded bg-red-900 hover:bg-red-800 text-red-300 transition-colors">Delete</button>
                              </div>
                            </div>
                            {revealedWinPasswords[c.id] && <span className="font-mono text-xs text-green-300 bg-gray-950 px-2 py-1 rounded select-all block break-all">{revealedWinPasswords[c.id]}</span>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {winCreds.length === 0 && !winCredsLoading && !showAddWinCred && (
                    <p className="text-gray-500 text-sm text-center py-6">No RDP credentials stored. Click "Add Credential" to save one.</p>
                  )}
                </div>
              )}

              {/* Credentials / Password Vault Tab */}
              {infoTab === 'credentials' && infoServer?.os_type !== 'windows' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500">Passwords are encrypted with AES-256-GCM and stored in the vault. Reveal is audit-logged.</p>
                    <div className="flex gap-2">
                      <button onClick={() => {
                        const a = document.createElement('a')
                        a.href = '/api/vault/export/keepass'
                        a.download = ''
                        document.body.appendChild(a)
                        a.click()
                        document.body.removeChild(a)
                      }} className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors" title="Export all vault entries as KeePass XML">
                        ⬇ KeePass Export
                      </button>
                      <button onClick={() => { setShowCredForm(true); setCredForm({ category: 'linux', linux_user: '', service_name: '', service_username: '', label: '', password: '', notes: '', apply_on_server: false }) }}
                        className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors">
                        + Add Credential
                      </button>
                    </div>
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
                                        onClick={() => { setOpenCredMenu(null); promptDeleteCred(c.id) }}
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
                              : c.last_changed_on_server_at || thisVerifyResult === 'match' ? 'bg-gray-700/40 text-gray-400'
                              : 'bg-orange-900/20 border border-orange-700/30 text-orange-400'}`}>
                              {thisApplyStatus === 'ok' ? (
                                <><span>✓</span><span>Password successfully applied on server just now.</span></>
                              ) : c.last_changed_on_server_at ? (
                                <><span>✓</span><span>Active on server since <strong>{new Date(c.last_changed_on_server_at).toLocaleString()}</strong></span></>
                              ) : thisVerifyResult === 'match' ? (
                                <><span>✓</span><span>Password verified correct on server.</span></>
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
                        {confirmPurgeAll ? (
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-xs text-red-400">Delete all?</span>
                            <button onClick={() => purgeAllArchivedCredentials(infoServer!.id)}
                              className="px-2 py-0.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors">Yes</button>
                            <button onClick={() => setConfirmPurgeAll(false)}
                              className="px-2 py-0.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">No</button>
                          </div>
                        ) : (
                          <button onClick={() => setConfirmPurgeAll(true)}
                            title="Permanently delete all archived passwords for this server"
                            className="px-2.5 py-1 text-xs rounded bg-red-900/30 hover:bg-red-800/50 text-red-500 hover:text-red-300 transition-colors shrink-0">
                            🗑 Purge All
                          </button>
                        )}
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
                                      onClick={() => promptDeleteCred(c.id)}
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

                            const isNdbCluster = item.category === 'database' && item.name === 'MySQL' && item.version?.toLowerCase().includes('cluster')

                            return (
                              <div key={item.name}>
                              <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 flex items-center gap-3">
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
                              {/* NDB Cluster panel — shown below MySQL when cluster version detected */}
                              {isNdbCluster && (
                                <div className="mt-1.5 bg-gray-900 border border-blue-900/50 rounded-lg p-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-medium text-blue-400 uppercase tracking-wide">NDB Cluster Nodes</span>
                                    <button
                                      onClick={() => loadNdbStatus(infoServer!.id)}
                                      disabled={ndbLoading}
                                      className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50">
                                      {ndbLoading ? '…' : '↻ Refresh'}
                                    </button>
                                  </div>
                                  {ndbLoading && ndbNodes.length === 0 && (
                                    <p className="text-xs text-gray-500">Querying cluster…</p>
                                  )}
                                  {!ndbLoading && ndbNodes.length === 0 && (
                                    <p className="text-xs text-gray-500">Click Refresh to load cluster topology.</p>
                                  )}
                                  {ndbNodes.length > 0 && (
                                    <div className="space-y-1">
                                      {ndbNodes.map((node) => {
                                        const typeBadge = node.type === 'mgmd'
                                          ? 'bg-blue-900/60 text-blue-300 border border-blue-800'
                                          : node.type === 'ndbd'
                                          ? 'bg-purple-900/60 text-purple-300 border border-purple-800'
                                          : 'bg-green-900/60 text-green-300 border border-green-800'
                                        const typeLabel = node.type === 'mgmd' ? 'MGM' : node.type === 'ndbd' ? 'DATA' : 'SQL'
                                        return (
                                          <div key={node.id} className="flex items-center gap-2 text-xs">
                                            <span className="text-gray-600 w-5 text-right shrink-0">#{node.id}</span>
                                            <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] shrink-0 ${typeBadge}`}>{typeLabel}</span>
                                            <span className="text-gray-400 font-mono flex-1 truncate">{node.host}{node.nodegroup !== undefined ? ` · ng${node.nodegroup}` : ''}{node.master ? ' ★' : ''}</span>
                                            <span className={node.status === 'connected' ? 'text-green-400' : 'text-red-400'}>
                                              {node.status === 'connected' ? '●' : '○'}
                                            </span>
                                          </div>
                                        )
                                      })}
                                    </div>
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

              {infoTab === 'benchmark' && (() => {
                const STATUS_COLOR: Record<CheckStatus, string> = {
                  pass: '#22c55e', warn: '#f59e0b', fail: '#ef4444', skip: '#6b7280',
                }
                const STATUS_BG: Record<CheckStatus, string> = {
                  pass: 'rgba(34,197,94,0.1)', warn: 'rgba(245,158,11,0.1)', fail: 'rgba(239,68,68,0.1)', skip: 'rgba(107,114,128,0.08)',
                }
                const STATUS_ICON: Record<CheckStatus, string> = {
                  pass: '✓', warn: '⚠', fail: '✗', skip: '—',
                }
                const CAT_LABEL: Record<CheckCategory, string> = {
                  ssh: 'SSH', password_policy: 'Password Policy', accounts: 'Accounts',
                  file_permissions: 'File Permissions', kernel: 'Kernel', audit: 'Audit & Logging',
                  firewall: 'Firewall', updates: 'Updates',
                }
                const categories: CheckCategory[] = ['ssh', 'password_policy', 'accounts', 'file_permissions', 'kernel', 'audit', 'firewall', 'updates']

                const filteredChecks = benchmarkCatFilter === 'all'
                  ? (benchmark?.checks ?? [])
                  : (benchmark?.checks ?? []).filter((c) => c.category === benchmarkCatFilter)

                const score = benchmark?.summary.score ?? 0
                const scoreColor = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'

                return (
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        {benchmark && (
                          <>
                            <div style={{
                              width: 52, height: 52, borderRadius: '50%',
                              border: `3px solid ${scoreColor}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              flexShrink: 0,
                            }}>
                              <span style={{ fontSize: 15, fontWeight: 700, color: scoreColor }}>{score}</span>
                            </div>
                            <div>
                              <p style={{ fontSize: 12, color: 'var(--text-heading)', fontWeight: 600, margin: 0 }}>Security Score</p>
                              <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                                {(['pass', 'warn', 'fail', 'skip'] as CheckStatus[]).map((s) => (
                                  <span key={s} style={{
                                    fontSize: 11, fontWeight: 600,
                                    color: STATUS_COLOR[s],
                                    background: STATUS_BG[s],
                                    border: `1px solid ${STATUS_COLOR[s]}40`,
                                    borderRadius: 5, padding: '1px 7px',
                                  }}>
                                    {STATUS_ICON[s]} {s.toUpperCase()} {benchmark.summary[s]}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                      <button onClick={() => loadBenchmark(infoServer!.id)} disabled={benchmarkLoading}
                        style={{
                          padding: '6px 14px', fontSize: 12, borderRadius: 7, border: 'none', cursor: 'pointer',
                          background: 'var(--bg-card)', color: 'var(--text-secondary)', opacity: benchmarkLoading ? 0.5 : 1,
                        }}>
                        {benchmarkLoading ? 'Running…' : '↻ Re-run'}
                      </button>
                    </div>

                    {/* Loading */}
                    {benchmarkLoading && !benchmark && (
                      <div className="py-10 text-center text-gray-500 text-sm">
                        <div className="inline-block w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
                        <p>Running security benchmark checks… (15–30 s)</p>
                      </div>
                    )}
                    {benchmarkError && <p className="text-red-400 text-sm">{benchmarkError}</p>}

                    {benchmark && (
                      <>
                        {/* Category filter */}
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <button onClick={() => setBenchmarkCatFilter('all')} style={{
                            padding: '3px 10px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                            fontWeight: benchmarkCatFilter === 'all' ? 700 : 400,
                            background: benchmarkCatFilter === 'all' ? 'var(--accent-hex)' : 'var(--bg-card)',
                            color: benchmarkCatFilter === 'all' ? 'white' : 'var(--text-secondary)',
                          }}>All ({benchmark.checks.length})</button>
                          {categories.filter((cat) => benchmark.checks.some((c) => c.category === cat)).map((cat) => {
                            const catChecks = benchmark.checks.filter((c) => c.category === cat)
                            const hasFail = catChecks.some((c) => c.status === 'fail')
                            const hasWarn = catChecks.some((c) => c.status === 'warn')
                            const dotColor = hasFail ? '#ef4444' : hasWarn ? '#f59e0b' : '#22c55e'
                            return (
                              <button key={cat} onClick={() => setBenchmarkCatFilter(cat)} style={{
                                padding: '3px 10px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                                fontWeight: benchmarkCatFilter === cat ? 700 : 400,
                                background: benchmarkCatFilter === cat ? 'var(--accent-hex)' : 'var(--bg-card)',
                                color: benchmarkCatFilter === cat ? 'white' : 'var(--text-secondary)',
                                display: 'flex', alignItems: 'center', gap: 4,
                              }}>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                                {CAT_LABEL[cat]}
                              </button>
                            )
                          })}
                        </div>

                        {/* Check cards */}
                        <div className="space-y-1.5">
                          {filteredChecks.map((chk: BenchmarkCheck) => {
                            const isOpen = expandedCheck === chk.id
                            return (
                              <div key={chk.id} style={{
                                background: 'var(--bg-card)',
                                border: `1px solid var(--border-med)`,
                                borderLeft: `3px solid ${STATUS_COLOR[chk.status]}`,
                                borderRadius: 8, overflow: 'hidden',
                              }}>
                                <button onClick={() => setExpandedCheck(isOpen ? null : chk.id)}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  style={{
                                    width: '100%', textAlign: 'left', background: 'none', border: 'none',
                                    padding: '9px 12px', cursor: 'pointer',
                                    display: 'flex', alignItems: 'center', gap: 10,
                                  }}>
                                  {/* Status badge */}
                                  <span style={{
                                    flexShrink: 0, width: 52, textAlign: 'center',
                                    fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                                    background: STATUS_BG[chk.status], color: STATUS_COLOR[chk.status],
                                    border: `1px solid ${STATUS_COLOR[chk.status]}40`,
                                    borderRadius: 5, padding: '2px 6px',
                                  }}>
                                    {STATUS_ICON[chk.status]} {chk.status.toUpperCase()}
                                  </span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', lineHeight: 1.3 }}>{chk.title}</p>
                                    {chk.reference && (
                                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{chk.reference}</span>
                                    )}
                                  </div>
                                  <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-muted)' }}>{isOpen ? '▲' : '▼'}</span>
                                </button>

                                {isOpen && (
                                  <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border-weak)' }}>
                                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '8px 0 10px' }}>{chk.description}</p>

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                                      <div style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '8px 10px' }}>
                                        <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 3px' }}>Found</p>
                                        <code style={{ fontSize: 11, color: STATUS_COLOR[chk.status], wordBreak: 'break-all' }}>{chk.actual}</code>
                                      </div>
                                      <div style={{ background: 'var(--bg-input)', borderRadius: 6, padding: '8px 10px' }}>
                                        <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 3px' }}>Expected</p>
                                        <code style={{ fontSize: 11, color: '#22c55e', wordBreak: 'break-all' }}>{chk.expected}</code>
                                      </div>
                                    </div>

                                    {chk.status !== 'pass' && chk.remediation && (
                                      <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                          <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>Remediation</p>
                                          <button onClick={() => {
                                            navigator.clipboard.writeText(chk.remediation)
                                            setCopiedRemediation(chk.id)
                                            setTimeout(() => setCopiedRemediation(null), 2000)
                                          }} style={{
                                            fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                                            background: copiedRemediation === chk.id ? '#065f46' : 'var(--bg-input)',
                                            color: copiedRemediation === chk.id ? '#6ee7b7' : 'var(--text-secondary)',
                                          }}>
                                            {copiedRemediation === chk.id ? '✓ Copied' : '⎘ Copy'}
                                          </button>
                                        </div>
                                        <pre style={{
                                          fontSize: 11, lineHeight: 1.6, fontFamily: 'monospace',
                                          background: '#0d0d14', border: '1px solid var(--border-med)',
                                          borderRadius: 6, padding: '10px 12px', overflowX: 'auto',
                                          color: '#e2e8f0', whiteSpace: 'pre-wrap', margin: 0,
                                        }}>{chk.remediation}</pre>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>

                        <p style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>
                          Last run: {new Date(benchmark.ran_at).toLocaleString()} — CIS Benchmark-inspired controls
                        </p>
                      </>
                    )}
                  </div>
                )
              })()}

              {/* ── AI Analyst Tab ─────────────────────────────────────────── */}
              {infoTab === 'ai' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                  {/* Controls */}
                  <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-weak)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

                      {/* Log source */}
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Log Source</label>
                        <select value={aiForm.log_source_idx} onChange={e => {
                          const idx = Number(e.target.value)
                          setAiForm(f => ({ ...f, log_source_idx: idx, analysis_type: LOG_SOURCES[idx].focus }))
                        }}
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12 }}>
                          {LOG_SOURCES.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
                        </select>
                        <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, padding: '4px 6px', background: 'rgba(99,102,241,0.06)', borderRadius: 5 }}>
                          ℹ️ {LOG_SOURCES[aiForm.log_source_idx].hint}
                        </div>
                        {LOG_SOURCES[aiForm.log_source_idx].cmd === '' && (
                          <input value={aiForm.custom_cmd} onChange={e => setAiForm(f => ({ ...f, custom_cmd: e.target.value }))}
                            placeholder="e.g. docker logs myapp --tail 200"
                            style={{ marginTop: 6, width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box' }} />
                        )}
                      </div>

                      {/* Analysis type */}
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                          Analysis Focus
                          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--accent-hex)', textTransform: 'none', letterSpacing: 0 }}>← auto-set from log source</span>
                        </div>
                        <select value={aiForm.analysis_type} onChange={e => setAiForm(f => ({ ...f, analysis_type: e.target.value }))}
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12 }}>
                          {Object.entries(ANALYSIS_FOCUS_INFO).map(([val, { icon, label }]) => (
                            <option key={val} value={val}>{icon} {label}</option>
                          ))}
                        </select>
                        <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, padding: '4px 6px', background: 'rgba(99,102,241,0.06)', borderRadius: 5 }}>
                          🔍 {ANALYSIS_FOCUS_INFO[aiForm.analysis_type]?.desc}
                        </div>
                        {aiForm.analysis_type === 'custom' && (
                          <input value={aiForm.custom_question} onChange={e => setAiForm(f => ({ ...f, custom_question: e.target.value }))}
                            placeholder="e.g. Why did nginx crash at 3am?"
                            style={{ marginTop: 6, width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box' }} />
                        )}
                      </div>

                      {/* Provider */}
                      <div>
                        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>AI Provider</label>
                        <select value={aiForm.provider} onChange={e => {
                          const p = e.target.value
                          const models = AI_PROVIDERS.find(x => x.id === p)?.models ?? []
                          setAiForm(f => ({ ...f, provider: p, model: models[0] ?? '' }))
                        }}
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12 }}>
                          {AI_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                      </div>

                      {/* Model + lines */}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Model</label>
                          <select value={aiForm.model} onChange={e => setAiForm(f => ({ ...f, model: e.target.value }))}
                            style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12 }}>
                            {(AI_PROVIDERS.find(p => p.id === aiForm.provider)?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </div>
                        <div style={{ width: 80 }}>
                          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>Lines</label>
                          <input type="number" min={50} max={2000} value={aiForm.lines} onChange={e => setAiForm(f => ({ ...f, lines: Number(e.target.value) }))}
                            style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: 12 }} />
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <button onClick={runAiAnalysis} disabled={!aiDefaultsLoaded || aiRunning || (LOG_SOURCES[aiForm.log_source_idx].cmd === '' && !aiForm.custom_cmd)}
                        style={{ padding: '8px 24px', borderRadius: 7, border: 'none', background: aiRunning ? 'var(--border-med)' : 'var(--accent-hex)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: aiRunning ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                        {aiRunning ? <><span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />Analysing…</> : '🤖 Run Analysis'}
                      </button>
                      {aiError && <span style={{ fontSize: 12, color: 'var(--error)' }}>✗ {aiError}</span>}
                    </div>
                  </div>

                  {/* Results */}
                  {aiResult && (() => {
                    const score = aiResult.health_score
                    const scoreColor = score >= 90 ? '#22c55e' : score >= 70 ? '#84cc16' : score >= 50 ? '#eab308' : score >= 30 ? '#f97316' : '#ef4444'
                    const allIssues = [...aiResult.issues, ...aiResult.security_alerts]
                    const critCount = allIssues.filter(i => i.severity === 'critical').length
                    const warnCount = allIssues.filter(i => i.severity === 'warning').length

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                        {/* Header row — score + summary */}
                        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-weak)', borderRadius: 10, padding: 16, display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                          {/* Score gauge */}
                          <div style={{ flexShrink: 0, textAlign: 'center', width: 80 }}>
                            <svg width={80} height={80} viewBox="0 0 80 80">
                              <circle cx={40} cy={40} r={34} fill="none" stroke="var(--border-med)" strokeWidth={8} />
                              <circle cx={40} cy={40} r={34} fill="none" stroke={scoreColor} strokeWidth={8}
                                strokeDasharray={`${(score / 100) * 213.6} 213.6`}
                                strokeDashoffset={53.4} strokeLinecap="round" transform="rotate(-90 40 40)" />
                              <text x={40} y={44} textAnchor="middle" fill={scoreColor} fontSize={18} fontWeight={700}>{score}</text>
                            </svg>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -4 }}>Health Score</div>
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                              {critCount > 0 && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>🔴 {critCount} Critical</span>}
                              {warnCount > 0 && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(234,179,8,0.15)', color: '#eab308' }}>🟡 {warnCount} Warning</span>}
                              {allIssues.length === 0 && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>✓ No issues found</span>}
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                                {aiResult.raw_provider} / {aiResult.raw_model} · {new Date(aiResult.analysed_at).toLocaleTimeString()}
                              </span>
                            </div>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{aiResult.summary}</p>
                          </div>
                        </div>

                        {/* Issues */}
                        {allIssues.length > 0 && (
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
                              Issues Found ({allIssues.length})
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {allIssues.map((issue, i) => {
                                const isSec = aiResult.security_alerts.includes(issue)
                                const borderColor = issue.severity === 'critical' ? '#ef4444' : issue.severity === 'warning' ? '#eab308' : '#6366f1'
                                const bgColor = issue.severity === 'critical' ? 'rgba(239,68,68,0.06)' : issue.severity === 'warning' ? 'rgba(234,179,8,0.06)' : 'rgba(99,102,241,0.06)'
                                return (
                                  <div key={i} style={{ border: `1px solid ${borderColor}40`, borderLeft: `3px solid ${borderColor}`, background: bgColor, borderRadius: 8, padding: 12 }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: `${borderColor}20`, color: borderColor, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                        {issue.severity.toUpperCase()}
                                      </span>
                                      {isSec && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: 'rgba(239,68,68,0.1)', color: '#ef4444', whiteSpace: 'nowrap', flexShrink: 0 }}>🔒 SECURITY</span>}
                                      {issue.service && <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: 'var(--border-weak)', color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 }}>{issue.service}</span>}
                                      {issue.timestamp && <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{issue.timestamp}</span>}
                                      <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-heading)' }}>{issue.title}</span>
                                    </div>
                                    <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-secondary)' }}>{issue.description}</p>
                                    {issue.root_cause && (
                                      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
                                        <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Root cause: </span>{issue.root_cause}
                                      </p>
                                    )}
                                    {issue.fix_commands && issue.fix_commands.length > 0 && (
                                      <div style={{ marginBottom: 6 }}>
                                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Fix commands:</div>
                                        {issue.fix_commands.map((cmd, ci) => (
                                          <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                            <code style={{ flex: 1, fontSize: 11, background: 'var(--bg-input,#111)', color: '#a5f3fc', padding: '3px 8px', borderRadius: 4, fontFamily: 'monospace', wordBreak: 'break-all' }}>{cmd}</code>
                                            <button onClick={() => copyCmd(cmd)}
                                              style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border-med)', background: aiCopied === cmd ? '#1a7f37' : 'var(--card-bg)', color: aiCopied === cmd ? '#fff' : 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                              {aiCopied === cmd ? '✓ Copied' : 'Copy'}
                                            </button>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {issue.prevention && (
                                      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                        💡 {issue.prevention}
                                      </p>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {/* Recommendations */}
                        {aiResult.recommendations.length > 0 && (
                          <div style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 10, padding: 14 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#818cf8', marginBottom: 10 }}>
                              💡 Recommendations
                            </div>
                            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {aiResult.recommendations.map((r, i) => (
                                <li key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{r}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                      </div>
                    )
                  })()}

                </div>
              )}

              </div>{/* end tab-content min-height wrapper */}
            </div>
          )}

          {/* Windows servers: credentials panel (no SSH required) */}
          {!serverInfo && !infoLoading && infoServer?.os_type === 'windows' && (
            <div className="space-y-3 mt-2">
              {credLoading && <p className="text-xs text-gray-500">Loading…</p>}

              {/* RDP Credentials */}
              {(() => {
                const rdpCreds = credentials.filter(c => !c.is_archived && c.category !== 'linux')
                return (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-blue-400">🖥 RDP Credentials ({rdpCreds.length})</p>
                      <button onClick={() => { setShowCredForm(true); setCredForm({ category: 'other', linux_user: '', service_name: 'RDP', service_username: '', label: '', password: '', notes: '', apply_on_server: false }) }}
                        className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors">
                        + Add RDP Credential
                      </button>
                    </div>
                    {rdpCreds.length === 0 && !credLoading && (
                      <p className="text-xs text-gray-500 py-3 text-center">No RDP credentials saved.</p>
                    )}
                    {rdpCreds.map(cred => (
                      <div key={cred.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                        {editCred?.id === cred.id ? (
                          <div className="space-y-2">
                            <label className="block"><span className="text-xs text-gray-400">Label</span>
                              <input value={editCred.label} onChange={e => setEditCred({ ...editCred, label: e.target.value })}
                                className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                            <label className="block"><span className="text-xs text-gray-400">New Password <span className="text-gray-600">(leave blank to keep)</span></span>
                              <input type="password" value={editCredPwd} onChange={e => setEditCredPwd(e.target.value)} placeholder="••••••••"
                                className="mt-1 w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" /></label>
                            <div className="flex gap-2 pt-1">
                              <button onClick={() => { setEditCred(null); setEditCredPwd('') }} className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors">Cancel</button>
                              <button onClick={() => updateCredential(infoServer!.id, cred.id)} disabled={editCredWorking} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-60">{editCredWorking ? 'Saving…' : 'Save'}</button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 2 }}>{cred.label}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {cred.service_username && <span>👤 {cred.service_username}</span>}
                                {cred.notes && <span style={{ marginLeft: 8 }}>{cred.notes}</span>}
                              </div>
                            </div>
                            <button onClick={() => { setEditCred(cred); setEditCredPwd('') }} className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors">✎ Edit</button>
                            <button onClick={() => { setInfoServer(null); infoServer && openRdpTab(infoServer) }} className="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded-lg transition-colors whitespace-nowrap">🖥 Connect RDP</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* SSH Credentials */}
              {(() => {
                const sshCreds = credentials.filter(c => !c.is_archived && c.category === 'linux')
                if (sshCreds.length === 0) return null
                return (
                  <div className="pt-2 border-t border-gray-700">
                    <p className="text-xs font-semibold text-green-400 mb-2">🐧 SSH Credentials ({sshCreds.length})</p>
                    {sshCreds.map(cred => {
                      const isRevealed = !!revealedPasswords[cred.id]
                      const isCopied = copiedCred === cred.id
                      return (
                        <div key={cred.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 2 }}>{cred.label}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {cred.linux_user && <span>👤 {cred.linux_user}</span>}
                                {cred.notes && <span style={{ marginLeft: 8 }}>{cred.notes}</span>}
                              </div>
                            </div>
                            <button
                              onClick={() => copyPasswordSilently(infoServer!.id, cred.id, 'linux')}
                              className={`px-2 py-1 text-xs rounded transition-colors whitespace-nowrap ${isCopied ? 'bg-green-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
                              {isCopied ? '✓ Copied' : '📋 Copy Password'}
                            </button>
                            {isRevealed && (
                              <button onClick={() => hidePassword(cred.id)} className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-400 rounded transition-colors">Hide</button>
                            )}
                            <button onClick={() => promptDeleteCred(cred.id)} className="px-2 py-1 text-xs bg-red-800 hover:bg-red-700 text-white rounded transition-colors">Archive</button>
                          </div>
                          {isRevealed && (
                            <span className="mt-2 font-mono text-xs text-green-300 bg-gray-900 px-2 py-1 rounded select-all block break-all">{revealedPasswords[cred.id]}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
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

      {/* Windows RDP Setup Modal */}
      {winSetupServer && (
        <Modal title={`Setup RDP — ${winSetupServer.name}`} onClose={() => setWinSetupServer(null)}>
          {winSetupDone ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-green-900/30 border border-green-700/40">
                <span className="text-green-400 text-lg mt-0.5">✓</span>
                <div>
                  <p className="text-green-300 font-semibold text-sm">RDP credentials saved!</p>
                  <p className="text-green-400/80 text-xs mt-1">
                    Credentials saved to the vault. Click <strong>🖥 RDP</strong> in the server list to open a Remote Desktop session.
                  </p>
                </div>
              </div>
              <button onClick={() => { const s = winSetupServer; setWinSetupServer(null); s && openRdpTab(s) }}
                className="w-full py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-sm font-semibold transition-colors">
                🖥 Open Remote Desktop Now
              </button>
              <button onClick={() => setWinSetupServer(null)}
                className="w-full py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm transition-colors">
                Close
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-xs text-gray-400 bg-gray-800/60 rounded-lg p-3 space-y-1">
                <p>🪟 This is a <strong className="text-gray-200">Windows Server</strong>. Enter the RDP credentials to save them to the vault.</p>
                <p>These will be used when you click <strong className="text-gray-200">🖥 RDP</strong> to connect via browser.</p>
              </div>

              {winSetupError && (
                <div className="p-3 rounded-lg bg-red-900/30 border border-red-700/40 text-red-300 text-sm">
                  ✗ {winSetupError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">Windows Username</label>
                <input value={winSetupForm.username}
                  onChange={e => setWinSetupForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="Administrator"
                  className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">Password</label>
                <div className="relative">
                  <input type={winSetupForm.show_pw ? 'text' : 'password'}
                    value={winSetupForm.password}
                    onChange={e => setWinSetupForm(f => ({ ...f, password: e.target.value }))}
                    placeholder="Windows login password"
                    className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-white text-sm focus:outline-none focus:border-blue-500 pr-16" />
                  <button type="button" onClick={() => setWinSetupForm(f => ({ ...f, show_pw: !f.show_pw }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-200 px-2 py-1">
                    {winSetupForm.show_pw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-400 mb-1.5">Domain <span className="text-gray-600 font-normal">(optional)</span></label>
                  <input value={winSetupForm.domain}
                    onChange={e => setWinSetupForm(f => ({ ...f, domain: e.target.value }))}
                    placeholder="CONTOSO"
                    className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-400 mb-1.5">RDP Port</label>
                  <input type="number" value={winSetupForm.rdp_port}
                    onChange={e => setWinSetupForm(f => ({ ...f, rdp_port: Number(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button onClick={() => setWinSetupServer(null)}
                  className="flex-1 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm transition-colors">
                  Cancel
                </button>
                <button
                  onClick={runWindowsSetup}
                  disabled={winSetupWorking || !winSetupForm.username || !winSetupForm.password}
                  className="flex-1 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
                  {winSetupWorking ? 'Saving…' : '💾 Save & Set Ready'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Credential archive / delete confirm modal */}
      {confirmDeleteCred && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setConfirmDeleteCred(null)}>
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm space-y-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-semibold text-base">
              {confirmDeleteCred.isArchived ? '🗑 Permanently Delete?' : '🗄 Archive Credential?'}
            </h3>
            <p className="text-sm text-gray-300">
              <span className="font-mono text-white">{confirmDeleteCred.label}</span>
            </p>
            <p className="text-xs text-gray-400">
              {confirmDeleteCred.isArchived
                ? 'This will permanently remove the credential. This cannot be undone.'
                : 'The credential will be moved to the archived section. You can still reveal or permanently delete it later.'}
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmDeleteCred(null)}
                className="flex-1 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm transition-colors">
                Cancel
              </button>
              <button onClick={() => deleteCredential(infoServer!.id, confirmDeleteCred.id, confirmDeleteCred.isArchived)}
                className={`flex-1 py-2 rounded-lg text-white text-sm font-medium transition-colors ${confirmDeleteCred.isArchived ? 'bg-red-700 hover:bg-red-600' : 'bg-orange-700 hover:bg-orange-600'}`}>
                {confirmDeleteCred.isArchived ? 'Delete Forever' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
