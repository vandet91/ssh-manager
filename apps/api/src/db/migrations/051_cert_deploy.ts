import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE servers
      ADD COLUMN IF NOT EXISTS cert_pending_apply_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cert_pending_apply_config JSONB
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE servers
      DROP COLUMN IF EXISTS cert_pending_apply_at,
      DROP COLUMN IF EXISTS cert_pending_apply_config
  `.execute(db)
}
