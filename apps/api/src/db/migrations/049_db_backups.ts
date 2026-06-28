import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS db_backups (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      filename    TEXT NOT NULL,
      size_bytes  BIGINT,
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
      error       TEXT,
      started_at  TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS db_backups`.execute(db)
}
