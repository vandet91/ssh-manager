import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Generic key/value settings table
  await db.schema
    .createTable('settings')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value', 'jsonb', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute()

  // Insert default password policy
  await sql`
    INSERT INTO settings (key, value) VALUES (
      'password_policy',
      '{"min_length":8,"require_uppercase":false,"require_lowercase":false,"require_numbers":false,"require_special":false,"max_age_days":0,"max_login_attempts":5,"lockout_duration_minutes":30}'::jsonb
    )
  `.execute(db)

  // Add lockout tracking columns to users
  await db.schema
    .alterTable('users')
    .addColumn('failed_login_attempts', 'integer', (col) => col.defaultTo(0).notNull())
    .execute()

  await db.schema
    .alterTable('users')
    .addColumn('locked_until', 'timestamptz', (col) => col.defaultTo(null))
    .execute()

  await db.schema
    .alterTable('users')
    .addColumn('password_changed_at', 'timestamptz', (col) => col.defaultTo(null))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('failed_login_attempts').execute()
  await db.schema.alterTable('users').dropColumn('locked_until').execute()
  await db.schema.alterTable('users').dropColumn('password_changed_at').execute()
  await db.schema.dropTable('settings').execute()
}
