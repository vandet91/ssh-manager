import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // operator_server_access — admin explicitly grants which servers an operator can see
  await sql`
    CREATE TABLE IF NOT EXISTS operator_server_access (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id   UUID        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      granted_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ,
      UNIQUE(operator_id, server_id)
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS osa_operator_idx ON operator_server_access(operator_id)`.execute(db)

  // operator_vault_access — admin explicitly grants which vault entries an operator can access
  await sql`
    CREATE TABLE IF NOT EXISTS operator_vault_access (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vault_entry_id UUID        NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
      can_write      BOOLEAN     NOT NULL DEFAULT false,
      granted_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
      granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ,
      UNIQUE(operator_id, vault_entry_id)
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS ova_operator_idx ON operator_vault_access(operator_id)`.execute(db)

  // Migrate developer/viewer → operator
  await sql`UPDATE users SET role = 'operator' WHERE role IN ('developer', 'viewer')`.execute(db)

  // Drop old role_permissions (replaced by explicit grant tables)
  await sql`DROP TABLE IF EXISTS role_permissions`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS operator_vault_access`.execute(db)
  await sql`DROP TABLE IF EXISTS operator_server_access`.execute(db)
}
