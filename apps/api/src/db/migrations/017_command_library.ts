import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS command_library (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      os          VARCHAR(10)  NOT NULL CHECK (os IN ('windows', 'linux')),
      category    VARCHAR(50)  NOT NULL,
      label       VARCHAR(200) NOT NULL,
      command     TEXT         NOT NULL,
      description TEXT,
      sort_order  INT          NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_command_library_os_cat ON command_library(os, category)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS command_library`.execute(db)
}
