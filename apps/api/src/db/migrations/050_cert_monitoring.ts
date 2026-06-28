import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE servers
      ADD COLUMN IF NOT EXISTS cert_host            TEXT,
      ADD COLUMN IF NOT EXISTS cert_port            INTEGER DEFAULT 443,
      ADD COLUMN IF NOT EXISTS cert_expires_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cert_issuer          TEXT,
      ADD COLUMN IF NOT EXISTS cert_subject         TEXT,
      ADD COLUMN IF NOT EXISTS cert_sans            TEXT[],
      ADD COLUMN IF NOT EXISTS cert_is_self_signed  BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS cert_last_checked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cert_renewal_cmd     TEXT,
      ADD COLUMN IF NOT EXISTS cert_auto_renew      BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS cert_error           TEXT
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE servers
      DROP COLUMN IF EXISTS cert_host,
      DROP COLUMN IF EXISTS cert_port,
      DROP COLUMN IF EXISTS cert_expires_at,
      DROP COLUMN IF EXISTS cert_issuer,
      DROP COLUMN IF EXISTS cert_subject,
      DROP COLUMN IF EXISTS cert_sans,
      DROP COLUMN IF EXISTS cert_is_self_signed,
      DROP COLUMN IF EXISTS cert_last_checked_at,
      DROP COLUMN IF EXISTS cert_renewal_cmd,
      DROP COLUMN IF EXISTS cert_auto_renew,
      DROP COLUMN IF EXISTS cert_error
  `.execute(db)
}
