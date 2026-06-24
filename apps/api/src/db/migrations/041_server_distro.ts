import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS distro TEXT`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS distro`.execute(db)
}
