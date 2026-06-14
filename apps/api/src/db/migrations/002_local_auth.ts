import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add password_hash column for local auth users
  await db.schema
    .alterTable('users')
    .addColumn('password_hash', 'text', (col) => col.defaultTo(null))
    .execute()

  // Allow provider to be null (local users won't have a provider)
  await sql`ALTER TABLE users ALTER COLUMN provider DROP NOT NULL`.execute(db)
  await sql`ALTER TABLE users ALTER COLUMN provider_id DROP NOT NULL`.execute(db)

  // Update check constraint to include 'local' provider
  await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_provider_check`.execute(db)
  await sql`ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (provider IN ('microsoft', 'google', 'local'))`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('password_hash').execute()
  await sql`ALTER TABLE users ALTER COLUMN provider SET NOT NULL`.execute(db)
  await sql`ALTER TABLE users ALTER COLUMN provider_id SET NOT NULL`.execute(db)
}
