import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // SSH access profile for network devices
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS access_ssh_enabled BOOLEAN NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS access_ssh_auth_type VARCHAR(10)`.execute(db) // 'key' | 'password'

  // Web UI access
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS web_enabled BOOLEAN NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS web_url TEXT`.execute(db)

  // SNMP
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_enabled BOOLEAN NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_version VARCHAR(5) NOT NULL DEFAULT 'v2c'`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_community_enc TEXT`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_port INT NOT NULL DEFAULT 161`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_v3_user VARCHAR(100)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_v3_auth_proto VARCHAR(10)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_v3_auth_key_enc TEXT`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_v3_priv_proto VARCHAR(10)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_v3_priv_key_enc TEXT`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_last_fetched_at TIMESTAMPTZ`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_last_data JSONB`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const col of [
    'access_ssh_enabled', 'access_ssh_auth_type',
    'web_enabled', 'web_url',
    'snmp_enabled', 'snmp_version', 'snmp_community_enc', 'snmp_port',
    'snmp_v3_user', 'snmp_v3_auth_proto', 'snmp_v3_auth_key_enc',
    'snmp_v3_priv_proto', 'snmp_v3_priv_key_enc',
    'snmp_last_fetched_at', 'snmp_last_data',
  ]) {
    await sql`ALTER TABLE servers DROP COLUMN IF EXISTS ${sql.ref(col)}`.execute(db)
  }
}
