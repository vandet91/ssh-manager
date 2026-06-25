import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE servers
      ADD COLUMN IF NOT EXISTS os_name        TEXT,
      ADD COLUMN IF NOT EXISTS os_pretty_name TEXT,
      ADD COLUMN IF NOT EXISTS os_version     TEXT,
      ADD COLUMN IF NOT EXISTS os_id          TEXT,
      ADD COLUMN IF NOT EXISTS kernel_version TEXT,
      ADD COLUMN IF NOT EXISTS cpu_count      INTEGER,
      ADD COLUMN IF NOT EXISTS last_seen_at   TIMESTAMPTZ
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE servers
      DROP COLUMN IF EXISTS os_name,
      DROP COLUMN IF EXISTS os_pretty_name,
      DROP COLUMN IF EXISTS os_version,
      DROP COLUMN IF EXISTS os_id,
      DROP COLUMN IF EXISTS kernel_version,
      DROP COLUMN IF EXISTS cpu_count,
      DROP COLUMN IF EXISTS last_seen_at
  `.execute(db)
}
