import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop old constraint and recreate with extended policy set
  await sql`ALTER TABLE ssh_keys DROP CONSTRAINT IF EXISTS ssh_keys_rotation_policy_check`.execute(db)
  await sql`ALTER TABLE ssh_keys ADD CONSTRAINT ssh_keys_rotation_policy_check CHECK (rotation_policy IN ('manual', '7d', '30d', '90d', '180d', '365d'))`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ssh_keys DROP CONSTRAINT IF EXISTS ssh_keys_rotation_policy_check`.execute(db)
  await sql`ALTER TABLE ssh_keys ADD CONSTRAINT ssh_keys_rotation_policy_check CHECK (rotation_policy IN ('manual', '7d', '30d', '90d'))`.execute(db)
}
