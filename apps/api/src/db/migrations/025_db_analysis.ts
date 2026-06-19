import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS db_analysis_rules (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id UUID NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
      name          VARCHAR(128) NOT NULL,
      rule_type     VARCHAR(32) NOT NULL,  -- row_count|null_rate|uniqueness|range|custom_sql|referential
      table_name    VARCHAR(256) NOT NULL DEFAULT '',
      column_name   VARCHAR(256),
      params        JSONB NOT NULL DEFAULT '{}',
      is_active     BOOLEAN NOT NULL DEFAULT true,
      created_by    UUID REFERENCES users(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS db_analysis_results (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id     UUID NOT NULL REFERENCES db_analysis_rules(id) ON DELETE CASCADE,
      status      VARCHAR(16) NOT NULL,  -- pass|fail|error
      actual      TEXT,
      expected    TEXT,
      details     JSONB,
      ran_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_db_analysis_rules_conn ON db_analysis_rules(connection_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_db_analysis_results_rule ON db_analysis_results(rule_id, ran_at DESC)`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS db_analysis_results`.execute(db)
  await sql`DROP TABLE IF EXISTS db_analysis_rules`.execute(db)
}
