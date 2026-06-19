import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE db_connections ALTER COLUMN server_id DROP NOT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE db_connections ALTER COLUMN server_id SET NOT NULL`.execute(db)
}
