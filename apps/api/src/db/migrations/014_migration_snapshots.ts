import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS migration_snapshots (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id   uuid REFERENCES servers(id) ON DELETE SET NULL,
      server_name text NOT NULL,
      label       text NOT NULL DEFAULT '',
      snapshot    jsonb NOT NULL,
      created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_migration_snapshots_server ON migration_snapshots (server_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_migration_snapshots_created ON migration_snapshots (created_at DESC)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS migration_snapshots`.execute(db)
}
