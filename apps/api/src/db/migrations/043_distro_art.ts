import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS distro_art (
      key        TEXT PRIMARY KEY,
      art_lines  JSONB NOT NULL DEFAULT '[]',
      color      TEXT NOT NULL DEFAULT '#94a3b8',
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS distro_art`.execute(db)
}
