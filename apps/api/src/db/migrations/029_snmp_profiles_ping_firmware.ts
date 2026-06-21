import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // SNMP shared profiles table
  await sql`
    CREATE TABLE IF NOT EXISTS snmp_profiles (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      version     VARCHAR(10)  NOT NULL DEFAULT 'v2c',
      community_enc TEXT,
      port        INTEGER      NOT NULL DEFAULT 161,
      v3_user     VARCHAR(255),
      v3_auth_proto VARCHAR(10),
      v3_auth_key_enc TEXT,
      v3_priv_proto VARCHAR(10),
      v3_priv_key_enc TEXT,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // Link servers to a shared SNMP profile
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_profile_id UUID REFERENCES snmp_profiles(id) ON DELETE SET NULL`.execute(db)

  // Ping monitoring
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS ping_enabled BOOLEAN NOT NULL DEFAULT true`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS in_stock BOOLEAN NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS ping_last_at TIMESTAMPTZ`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS ping_last_status VARCHAR(10)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS ping_last_latency_ms INTEGER`.execute(db)

  // Enriched SNMP discovery data
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_hostname VARCHAR(255)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_firmware VARCHAR(255)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_model VARCHAR(255)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_serial VARCHAR(255)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_mac_address VARCHAR(100)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_vendor VARCHAR(255)`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS snmp_interfaces JSONB`.execute(db)

  // AI firmware check results
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS firmware_check_at TIMESTAMPTZ`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS firmware_check_result JSONB`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS firmware_check_result`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS firmware_check_at`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_interfaces`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_vendor`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_mac_address`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_serial`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_model`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_firmware`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_hostname`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS ping_last_latency_ms`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS ping_last_status`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS ping_last_at`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS in_stock`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS ping_enabled`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS snmp_profile_id`.execute(db)
  await sql`DROP TABLE IF EXISTS snmp_profiles`.execute(db)
}
