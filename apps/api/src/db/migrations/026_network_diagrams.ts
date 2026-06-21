import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS network_diagrams (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(256) NOT NULL,
      data        JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_network_diagrams_created_by ON network_diagrams(created_by)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS network_diagrams`.execute(db)
}
