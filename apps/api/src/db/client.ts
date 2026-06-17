import { Kysely, PostgresDialect, Generated, ColumnType } from 'kysely'
import { Pool } from 'pg'

// Opt<T> = column has a DB default, so it's optional on INSERT
type Opt<T> = ColumnType<T, T | undefined, T>

export interface UserTable {
  id: Generated<string>
  email: string
  display_name: string | null
  provider: 'microsoft' | 'google' | 'local' | null
  provider_id: string | null
  password_hash: string | null
  provider_groups: Opt<unknown>
  role: Opt<'admin' | 'operator' | 'developer' | 'viewer'>
  mfa_secret: string | null
  mfa_enabled: Opt<boolean>
  mfa_backup_codes: Opt<unknown>
  is_active: Opt<boolean>
  last_login_at: Date | null
  failed_login_attempts: Opt<number>
  locked_until: Date | null
  password_changed_at: Date | null
  created_at: ColumnType<Date, never, never>
  updated_at: Opt<Date>
}

export interface ServerTable {
  id: Generated<string>
  name: string
  hostname: string
  ssh_port: Opt<number>
  environment: 'production' | 'staging' | 'development' | 'other'
  tags: Opt<unknown>
  host_key_fingerprint: string | null
  host_key_verified: Opt<boolean>
  host_key_last_seen: Date | null
  management_key_id: string | null
  management_linux_user: Opt<string>
  is_active: Opt<boolean>
  last_connected_at: Date | null
  added_by: string | null
  os_type: Opt<string>
  device_category: Opt<string>
  host_type: Opt<string>
  host_type_detail: Opt<string>
  windows_rdp_ready: Opt<boolean>
  created_at: ColumnType<Date, never, never>
  updated_at: Opt<Date>
}

export interface SshKeyTable {
  id: Generated<string>
  name: string
  description: string | null
  key_type: Opt<'ed25519' | 'rsa4096'>
  public_key: string
  private_key_enc: string
  fingerprint: string
  rotation_policy: Opt<'manual' | '7d' | '30d' | '90d' | '180d' | '365d'>
  last_rotated_at: Date | null
  next_rotation_at: Date | null
  is_active: Opt<boolean>
  archived_at: Date | null
  archive_reason: 'rotated' | 'deleted' | 'reverted' | null
  archived_by: string | null
  purge_after: Date | null
  successor_key_id: string | null
  predecessor_key_id: string | null
  created_by: string | null
  created_at: ColumnType<Date, never, never>
  updated_at: Opt<Date>
}

export interface KeyAssignmentTable {
  id: Generated<string>
  user_id: string
  key_id: string
  server_id: string
  linux_user: string
  can_terminal: Opt<boolean>
  is_active: Opt<boolean>
  expires_at: Date | null
  granted_by: string | null
  created_at: ColumnType<Date, never, never>
}

export interface AuditLogTable {
  id: Generated<number>
  user_id: string | null
  user_email: string | null
  action: string
  resource: string | null
  resource_id: string | null
  server_id: string | null
  details: Opt<unknown>
  ip_address: string | null
  user_agent: string | null
  created_at: ColumnType<Date, never, never>
}

export interface SessionRecordingTable {
  id: Generated<string>
  user_id: string | null
  server_id: string | null
  linux_user: string | null
  started_at: ColumnType<Date, never, never>
  ended_at: Date | null
  duration_s: number | null
  cast_file_path: string | null
  cast_size_bytes: number | null
  created_at: ColumnType<Date, never, never>
}

export interface SecurityScanTable {
  id: Generated<string>
  server_id: string | null
  scanned_at: ColumnType<Date, never, never>
  findings: Opt<unknown>
  severity: 'ok' | 'low' | 'medium' | 'high' | 'critical' | null
  scan_type: string | null
}

export interface RotationJobTable {
  id: Generated<string>
  key_id: string | null
  status: Opt<'pending' | 'running' | 'success' | 'failed' | 'rolled_back'>
  triggered_by: string | null
  started_at: Date | null
  completed_at: Date | null
  error_message: string | null
  affected_servers: Opt<unknown>
  created_at: ColumnType<Date, never, never>
}

export interface ServerCredentialTable {
  id: Generated<string>
  server_id: string
  category: Opt<string>            // 'linux' | 'database' | 'web' | 'application' | 'service' | 'other'
  linux_user: string | null        // linux user (category='linux') or null for service creds
  service_name: string | null      // e.g. "MySQL 8.0", "PostgreSQL", "Redis"
  service_username: string | null  // e.g. "root", "admin", "myapp_user"
  label: string
  password_enc: string
  notes: string | null
  created_by: string | null
  last_revealed_at: Date | null
  last_changed_on_server_at: Date | null
  is_archived: Opt<boolean>
  archived_at: Date | null
  archived_reason: string | null   // 'rotated'
  predecessor_id: string | null
  created_at: ColumnType<Date, never, never>
  updated_at: Opt<Date>
}

export interface MigrationSnapshotTable {
  id: Generated<string>
  server_id: string | null
  server_name: string
  label: Opt<string>
  snapshot: unknown
  created_by: string | null
  created_at: ColumnType<Date, never, never>
}

export interface Database {
  users: UserTable
  servers: ServerTable
  ssh_keys: SshKeyTable
  key_assignments: KeyAssignmentTable
  audit_logs: AuditLogTable
  session_recordings: SessionRecordingTable
  security_scans: SecurityScanTable
  rotation_jobs: RotationJobTable
  server_credentials: ServerCredentialTable
  migration_snapshots: MigrationSnapshotTable
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
})

export async function closeDb(): Promise<void> {
  await db.destroy()
}
