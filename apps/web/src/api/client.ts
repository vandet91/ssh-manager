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
  os_type: 'linux' | 'windows' | null
  host_type: HostType | null
  host_type_detail: string | null
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

export type CredentialCategory = 'linux' | 'database' | 'web' | 'application' | 'service' | 'other'

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

export type TelegramSettings = {
  enabled: boolean
  bot_token: string
  allowed_chats: number[]
  totp_secret: string
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
