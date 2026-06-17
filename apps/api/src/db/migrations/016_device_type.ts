import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Extend os_type to support network device types alongside server OSes
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS device_category VARCHAR(20) DEFAULT 'server'`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS device_category`.execute(db)
}
