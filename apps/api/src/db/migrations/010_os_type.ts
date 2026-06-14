import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add os_type column to servers: 'linux' (default) | 'windows'
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS os_type VARCHAR(20) DEFAULT 'linux'`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS os_type`.execute(db)
}
