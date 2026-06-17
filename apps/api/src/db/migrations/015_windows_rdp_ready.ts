import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS windows_rdp_ready BOOLEAN NOT NULL DEFAULT FALSE`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS windows_rdp_ready`.execute(db)
}
