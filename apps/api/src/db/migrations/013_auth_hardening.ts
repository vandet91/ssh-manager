import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0`.execute(db)
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz DEFAULT NULL`.execute(db)
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz DEFAULT NULL`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_users_locked_until ON users (locked_until) WHERE locked_until IS NOT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_users_locked_until`.execute(db)
  await db.schema.alterTable('users').dropColumn('failed_login_attempts').execute()
  await db.schema.alterTable('users').dropColumn('locked_until').execute()
  await db.schema.alterTable('users').dropColumn('password_changed_at').execute()
}
