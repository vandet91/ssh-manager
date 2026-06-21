const BASE = '/api'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw Object.assign(new Error(err.error ?? 'Request failed'), { status: res.status, data: err })
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = void>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}

export type User = {
  id: string; email: string; display_name: string | null
  role: 'admin' | 'operator' | 'developer' | 'viewer'
  mfa_enabled: boolean; is_active: boolean; last_login_at: string | null; created_at: string
}

export type HostType = 'vmware' | 'hyperv' | 'proxmox' | 'kvm' | 'virtualbox' | 'xen' | 'lxc' | 'docker' | 'aws' | 'azure' | 'gcp' | 'physical' | 'unknown'

export type VirtInfo = {
  host_type: HostType
  label: string
  detail: string | null
  icon: string
  color: string
}

export type Server = {
  id: string; name: string; hostname: string; ssh_port: number
  environment: string; tags: Record<string, string>
  host_key_fingerprint: string | null; host_key_verified: boolean
  management_key_id: string | null; management_linux_user: string
  is_active: boolean; last_connected_at: string | null; created_at: string
  os_type: 'linux' | 'windows' | 'router' | 'access-point' | 'switch' | 'dvr' | 'nvr' | 'other-network' | null
  device_category: 'server' | 'network' | null
  host_type: HostType | null
  host_type_detail: string | null
  windows_rdp_ready: boolean
  is_domain_controller: boolean
  // Network device access
  access_ssh_enabled: boolean
  access_ssh_auth_type: 'key' | 'password' | null
  web_enabled: boolean
  web_url: string | null
  snmp_enabled: boolean
  snmp_version: string
  snmp_last_fetched_at: string | null
}

export type NetworkProfile = {
  access_ssh_enabled: boolean
  access_ssh_auth_type: 'key' | 'password' | null
  management_key_id: string | null
  management_linux_user: string | null
  ssh_credential_id: string | null
  ssh_credential_username: string | null
  web_enabled: boolean
  web_url: string | null
  snmp_enabled: boolean
  snmp_version: string
  snmp_community: string
  snmp_port: number
  snmp_v3_user: string | null
  snmp_v3_auth_proto: string | null
  snmp_v3_auth_key: string
  snmp_v3_priv_proto: string | null
  snmp_v3_priv_key: string
  snmp_profile_id: string | null
  snmp_last_fetched_at: string | null
  snmp_last_data: Record<string, string> | null
  ping_enabled: boolean
  in_stock: boolean
  ping_last_at: string | null
  ping_last_status: string | null
  ping_last_latency_ms: number | null
  snmp_hostname: string | null
  snmp_firmware: string | null
  snmp_model: string | null
  snmp_serial: string | null
  snmp_mac_address: string | null
  snmp_vendor: string | null
  snmp_interfaces: unknown | null
  firmware_check_at: string | null
  firmware_check_result: FirmwareCheckResult | null
}

export type SnmpProfile = {
  id: string
  name: string
  description: string | null
  version: string
  community: string
  port: number
  v3_user: string | null
  v3_auth_proto: string | null
  v3_auth_key: string
  v3_priv_proto: string | null
  v3_priv_key: string
  created_at: string
  updated_at: string
}

export type PingResult = {
  id: string; name: string; hostname: string
  status: 'online' | 'offline' | 'skipped'
  latency_ms: number | null
  skipped_reason: string | null
}

export type PingStatus = {
  id: string; name: string; hostname: string; os_type: string | null; environment: string
  ping_enabled: boolean; in_stock: boolean
  ping_last_at: string | null; ping_last_status: string | null; ping_last_latency_ms: number | null
}

export type FirmwareFile = {
  id: string
  vendor: string
  model: string
  version: string
  filename: string
  file_size: number | null
  checksum: string | null
  is_latest: boolean
  notes: string | null
  uploaded_by: string | null
  uploaded_at: string
}

export type ConfigBackup = {
  id: string
  server_id: string
  server_name: string
  os_type: string | null
  environment: string
  filename: string
  file_size: number | null
  backup_method: string
  status: 'ok' | 'error'
  error_message: string | null
  content_preview: string | null
  created_at: string
}

export type DiffLine = { type: 'add' | 'remove' | 'context'; line: string; lineNum?: number }

export type DiffResult = {
  current: { id: string; filename: string; created_at: string }
  previous: { id: string; filename: string; created_at: string } | null
  diff: DiffLine[]
  unchanged: boolean
}

export type FirmwareCheckResult = {
  status: 'current' | 'outdated' | 'unknown'
  current_version: string | null
  latest_version: string | null
  release_date: string | null
  eol: boolean | null
  cves: Array<{ id: string; severity: string; summary: string }>
  recommendation: string
  notes: string
}

export type RdpCredential = {
  id: string
  label: string
  service_username: string | null
  notes: string | null
  category: string
  updated_at: string
  is_archived: boolean
}

export type SshKey = {
  id: string; name: string; description: string | null; key_type: string
  public_key: string; fingerprint: string; rotation_policy: 'manual' | '7d' | '30d' | '90d' | '180d' | '365d'
  last_rotated_at: string | null; next_rotation_at: string | null
  is_active: boolean; created_at: string
}

export type ArchivedKey = {
  id: string; name: string; description: string | null; key_type: string
  fingerprint: string; rotation_policy: 'manual' | '7d' | '30d' | '90d' | '180d' | '365d'
  archived_at: string; archive_reason: 'rotated' | 'deleted' | 'reverted'
  purge_after: string; successor_key_id: string | null; predecessor_key_id: string | null
  last_rotated_at: string | null; created_at: string
}

export type Assignment = {
  id: string; user_id: string; key_id: string; server_id: string
  linux_user: string; can_terminal: boolean; is_active: boolean
  expires_at: string | null; granted_by: string | null; created_at: string
  server_name?: string | null; server_is_active?: boolean | null
  key_name?: string | null; key_is_active?: boolean | null
}

export type AuditLog = {
  id: number; user_email: string | null; action: string; resource: string | null
  resource_id: string | null; server_id: string | null; ip_address: string | null
  user_agent: string | null; created_at: string; details: Record<string, unknown>
}

export type SessionRecording = {
  id: string; user_id: string | null; server_id: string | null; linux_user: string | null
  started_at: string; ended_at: string | null; duration_s: number | null
  cast_file_path: string | null; created_at: string
}

export type SecurityScan = {
  id: string; server_id: string | null; scanned_at: string; severity: string | null
  findings: Array<{ check_id: string; description: string; severity: string; passed: boolean; output: string }>
  scan_type: string | null
}

export type AuthorizedKey = {
  linux_user: string
  key_type: string
  comment: string
  fingerprint: string
  key_body: string           // full base64 body — for revoke
  key_body_short: string     // truncated for display
  db_key_id: string | null
  db_key_name: string | null
  is_known: boolean          // true = matched a key in our DB
  is_archived: boolean       // true = matched key is archived/inactive
}

export type ServerInfo = {
  management_key_id: string | null
  active_key_id: string
  active_key_name: string
  active_key_is_fallback: boolean
  os_type?: 'linux' | 'windows'
  virt?: VirtInfo
  os: { name: string; pretty_name: string; version: string; id: string; kernel: string; build?: string; edition?: string }
  uptime: string
  memory: string
  memory_total_mb?: number
  cpu_count?: number
  users: Array<{ username: string; uid: number; gecos: string; home: string; shell: string }>
  logged_in: string[]
  authorized_keys: AuthorizedKey[]
  hostname?: string
  domain?: string | null
  roles?: string[]
}

export type CredentialCategory = 'linux' | 'windows' | 'database' | 'web' | 'application' | 'service' | 'other'

export type ServerCredential = {
  id: string; server_id: string
  category: CredentialCategory; label: string
  linux_user: string | null
  service_name: string | null; service_username: string | null
  notes: string | null; created_by: string | null; created_by_name: string | null
  last_revealed_at: string | null; last_changed_on_server_at: string | null
  is_archived: boolean; archived_at: string | null; archived_reason: string | null
  predecessor_id: string | null
  created_at: string; updated_at: string
}

export type SoftwareCategory = 'language' | 'webserver' | 'database' | 'container' | 'process_manager' | 'monitoring' | 'security'
export type ServiceStatus = 'active' | 'inactive' | 'failed' | 'unknown' | null

export type SoftwareItem = {
  name: string
  category: SoftwareCategory
  installed: boolean
  version: string | null
  service_name: string | null
  status: ServiceStatus
  enabled: string | null
}

export type RecSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type RecCategory = 'performance' | 'security' | 'stability' | 'monitoring'

export type Recommendation = {
  id: string
  software: string
  category: RecCategory
  severity: RecSeverity
  title: string
  description: string
  parameter?: string
  recommended?: string
  rationale: string
  snippet?: string
  reference?: string
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type CheckCategory = 'ssh' | 'password_policy' | 'accounts' | 'file_permissions' | 'kernel' | 'audit' | 'firewall' | 'updates'

export type BenchmarkCheck = {
  id: string
  category: CheckCategory
  title: string
  description: string
  status: CheckStatus
  actual: string
  expected: string
  remediation: string
  reference?: string
}

export type BenchmarkResult = {
  ran_at: string
  checks: BenchmarkCheck[]
  summary: {
    total: number
    pass: number
    warn: number
    fail: number
    skip: number
    score: number
  }
}

export type MigrationSnapshotMeta = {
  id: string
  server_id: string | null
  server_name: string
  label: string
  created_by: string | null
  created_at: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MigrationSnapshotFull = MigrationSnapshotMeta & { snapshot: any }

export type DiffStatus = 'match' | 'missing' | 'mismatch' | 'extra'

export type DiffItem = {
  section: string
  key: string
  status: DiffStatus
  source_value: string
  target_value: string
  note: string
}

export type CompareResult = {
  source: MigrationSnapshotMeta
  target: MigrationSnapshotMeta
  diff: DiffItem[]
  summary: { total: number; match: number; missing: number; mismatch: number; extra: number }
}

export type BrowseEntry = {
  name: string
  type: 'dir' | 'file' | 'link' | 'other'
  permissions: string
  owner: string
  group: string
  size: number
  modified: string
}

export type BrowseResult = {
  path: string
  parent: string
  entries: BrowseEntry[]
}

export type TransferType = 'mysql' | 'postgresql' | 'mongodb' | 'redis' | 'files' | 'configs' | 'cron'

export type DumpResult = {
  dump_file: string
  size_bytes: number
  size_human: string
}

export type ReadinessStatus = 'ok' | 'warn' | 'fail'

export type ReadinessItem = {
  label: string
  status: ReadinessStatus
  value: string
  note?: string
}

export type ReadinessReport = {
  items: ReadinessItem[]
  ready: boolean
}

export type VerifyStatus = 'match' | 'mismatch' | 'warning' | 'error' | 'skip'

export type VerifyItem = {
  label: string
  source: string
  target: string
  status: VerifyStatus
  note?: string
}

export type VerifyReport = {
  job_id: string
  ran_at: string
  type: TransferType
  items: VerifyItem[]
  passed: number
  failed: number
  warnings: number
}

export type TransferJob = {
  id: string
  source_server_id: string
  target_server_id: string
  type: TransferType
  options: { database?: string; source_path?: string; target_path?: string; users?: string }
  status: 'pending' | 'running' | 'done' | 'error'
  log: string[]
  started_at: string
  ended_at?: string
  bytes_transferred: number
  created_by: string
}

export type CommandGroupConfig = { enabled: boolean; totp: boolean }

export type TelegramCommands = {
  servers:    CommandGroupConfig
  status:     CommandGroupConfig
  software:   CommandGroupConfig
  linux_info: CommandGroupConfig
  linux_svc:  CommandGroupConfig
  ad_read:    CommandGroupConfig
  ad_write:   CommandGroupConfig
}

export type TelegramSettings = {
  enabled: boolean
  bot_token: string
  allowed_chats: number[]
  totp_secret: string
  commands: TelegramCommands
}

export type RotationJob = {
  id: string; key_id: string | null; status: string; triggered_by: string | null
  started_at: string | null; completed_at: string | null; error_message: string | null
  affected_servers: Array<{ server_id: string; linux_user: string; status: string; error?: string }>
  created_at: string
}

export type AlertEvents = {
  rotation_failed: boolean
  rotation_success: boolean
  security_critical: boolean
  security_high: boolean
  key_expiring: boolean
  login_failed: boolean
  new_login: boolean
  server_unreachable: boolean
  key_revoked: boolean
  user_deactivated: boolean
}

export type VaultType = 'server_os' | 'service' | 'api_key' | 'network_device' | 'domain_ad' | 'email' | 'printer' | 'dvr' | 'hypervisor' | 'storage' | 'database' | 'firewall' | 'vpn' | 'wireless' | 'ipmi' | 'other'

export type VaultEntry = {
  id: string
  title: string
  type: VaultType
  category: string | null
  ou: string | null
  tags: string[]
  username: string | null
  url: string | null
  notes: string | null
  server_credential_id: string | null
  is_archived: boolean
  archived_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  linked_credential_label?: string | null
  linked_server_id?: string | null
  linked_server_name?: string | null
}

export type DiagramNode = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  label: string
  ip: string
  notes: string
  serverId?: string | null
  isZone?: boolean
  color?: string
}

export type DiagramEdge = {
  id: string
  from: string
  to: string
  type: 'lan' | 'uplink' | 'fiber' | 'mgmt' | 'vpn'
  label: string
}

export type DiagramData = {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

export type NetworkDiagram = {
  id: string
  name: string
  data?: DiagramData
  created_by: string | null
  creator_name: string | null
  creator_email: string | null
  created_at: string
  updated_at: string
}

export type AlertSettings = {
  webhook_enabled: boolean
  webhook_url: string
  email_enabled: boolean
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  smtp_user: string
  smtp_pass: string
  smtp_from: string
  email_recipients: string[]
  telegram_enabled: boolean
  telegram_chat_id: number
  events: AlertEvents
}
