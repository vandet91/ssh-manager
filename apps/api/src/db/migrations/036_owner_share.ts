import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // ssh_keys: owner_id + is_shared
  await sql`ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL`.execute(db)
  await sql`ALTER TABLE ssh_keys ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE`.execute(db)

  // Backfill owner_id from created_by (already a UUID string in that column)
  await sql`UPDATE ssh_keys SET owner_id = created_by::uuid WHERE owner_id IS NULL AND created_by IS NOT NULL AND created_by::text ~ '^[0-9a-f-]{36}$'`.execute(db)

  // vault_entries: owner_id + is_shared
  await sql`ALTER TABLE vault_entries ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL`.execute(db)
  await sql`ALTER TABLE vault_entries ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE`.execute(db)

  // Backfill vault owner_id from created_by if it exists
  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'vault_entries' AND column_name = 'created_by'
  `.execute(db)
  if (cols.rows.length > 0) {
    await sql`UPDATE vault_entries SET owner_id = created_by::uuid WHERE owner_id IS NULL AND created_by IS NOT NULL AND created_by::text ~ '^[0-9a-f-]{36}$'`.execute(db)
  }

  // Remove viewer role permissions (role still exists but has no permissions)
  await sql`DELETE FROM role_permissions WHERE role = 'viewer'`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE ssh_keys DROP COLUMN IF EXISTS owner_id`.execute(db)
  await sql`ALTER TABLE ssh_keys DROP COLUMN IF EXISTS is_shared`.execute(db)
  await sql`ALTER TABLE vault_entries DROP COLUMN IF EXISTS owner_id`.execute(db)
  await sql`ALTER TABLE vault_entries DROP COLUMN IF EXISTS is_shared`.execute(db)
}
