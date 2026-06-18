import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_domain_controller BOOLEAN DEFAULT false`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS is_domain_controller`.execute(db)
}
