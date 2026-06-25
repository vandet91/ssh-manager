import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title      TEXT NOT NULL DEFAULT 'Untitled',
      doc_type   TEXT NOT NULL DEFAULT 'reference',
      tags       JSONB NOT NULL DEFAULT '[]',
      content    TEXT NOT NULL DEFAULT '',
      server_id  UUID REFERENCES servers(id) ON DELETE SET NULL,
      is_pinned  BOOLEAN NOT NULL DEFAULT false,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS document_images (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
      filename    TEXT NOT NULL,
      mime_type   TEXT NOT NULL DEFAULT 'image/jpeg',
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_documents_type    ON documents(doc_type)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS document_images`.execute(db)
  await sql`DROP TABLE IF EXISTS documents`.execute(db)
}
