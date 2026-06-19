import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // DB connection profiles — stores connection config per server
  await sql`
    CREATE TABLE IF NOT EXISTS db_connections (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name        VARCHAR(128) NOT NULL,
      db_type     VARCHAR(32) NOT NULL,   -- postgresql|mysql|sqlite|mongodb|mssql
      host        VARCHAR(256) NOT NULL DEFAULT '127.0.0.1',
      port        INTEGER NOT NULL,
      database_name VARCHAR(256) NOT NULL DEFAULT '',
      db_user     VARCHAR(128),
      password_enc TEXT,
      use_ssh_tunnel BOOLEAN NOT NULL DEFAULT true,
      ssl_enabled BOOLEAN NOT NULL DEFAULT false,
      notes       TEXT,
      created_by  UUID REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // Query history per connection
  await sql`
    CREATE TABLE IF NOT EXISTS db_query_history (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id UUID NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
      user_id       UUID REFERENCES users(id),
      query         TEXT NOT NULL,
      duration_ms   INTEGER,
      row_count     INTEGER,
      error         TEXT,
      executed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_db_connections_server ON db_connections(server_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_db_query_history_conn ON db_query_history(connection_id)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS db_query_history`.execute(db)
  await sql`DROP TABLE IF EXISTS db_connections`.execute(db)
}
