import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE servers
      ADD COLUMN IF NOT EXISTS cert_protocol TEXT NOT NULL DEFAULT 'https'
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS cert_protocol`.execute(db)
}
