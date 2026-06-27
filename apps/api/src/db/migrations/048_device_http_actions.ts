import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS device_http_actions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name          VARCHAR(128) NOT NULL,
      description   TEXT,
      method        VARCHAR(10) NOT NULL DEFAULT 'POST',   -- GET|POST|PUT|PATCH|DELETE
      url_path      TEXT NOT NULL,                         -- path appended to device web_url, e.g. /api/system/reboot
      headers       JSONB NOT NULL DEFAULT '{}',           -- key:value header map
      body          TEXT,                                  -- raw body string (JSON/form)
      content_type  VARCHAR(100) DEFAULT 'application/json',
      auth_type     VARCHAR(20) DEFAULT 'none',            -- none|basic|bearer|vault
      auth_username VARCHAR(256),
      auth_password_enc TEXT,
      vault_id      UUID REFERENCES vault_entries(id) ON DELETE SET NULL,
      follow_redirects BOOLEAN NOT NULL DEFAULT true,
      timeout_ms    INTEGER NOT NULL DEFAULT 10000,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_device_http_actions_device ON device_http_actions(device_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS device_http_actions`.execute(db)
}
