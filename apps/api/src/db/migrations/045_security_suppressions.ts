import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<never>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS security_suppressions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      check_id     TEXT NOT NULL,
      reason       TEXT,
      suppressed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      suppressed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, check_id)
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_security_suppressions_server ON security_suppressions(server_id)`.execute(db)
}

export async function down(db: Kysely<never>): Promise<void> {
  await sql`DROP TABLE IF EXISTS security_suppressions`.execute(db)
}
