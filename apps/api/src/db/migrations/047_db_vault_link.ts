import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE db_connections
      ADD COLUMN IF NOT EXISTS vault_id UUID REFERENCES vault_entries(id) ON DELETE SET NULL
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_db_connections_vault ON db_connections(vault_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE db_connections DROP COLUMN IF EXISTS vault_id`.execute(db)
}
