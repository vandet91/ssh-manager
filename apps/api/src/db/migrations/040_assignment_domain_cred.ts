import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE key_assignments
      ADD COLUMN IF NOT EXISTS domain_user text,
      ADD COLUMN IF NOT EXISTS domain_password_enc text
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE key_assignments
      DROP COLUMN IF EXISTS domain_user,
      DROP COLUMN IF EXISTS domain_password_enc
  `.execute(db)
}
