import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_environment_check`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers ADD CONSTRAINT servers_environment_check CHECK (environment IN ('production','staging','development','other'))`.execute(db)
}
