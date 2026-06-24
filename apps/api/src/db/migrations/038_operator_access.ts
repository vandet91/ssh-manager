import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // db_connections: add owner_id + is_shared so operators can manage their own connections
  await sql`ALTER TABLE db_connections ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL`.execute(db)
  await sql`ALTER TABLE db_connections ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE`.execute(db)

  // Backfill owner_id from created_by
  await sql`UPDATE db_connections SET owner_id = created_by::uuid WHERE owner_id IS NULL AND created_by IS NOT NULL AND created_by::text ~ '^[0-9a-f-]{36}$'`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE db_connections DROP COLUMN IF EXISTS owner_id`.execute(db)
  await sql`ALTER TABLE db_connections DROP COLUMN IF EXISTS is_shared`.execute(db)
}
