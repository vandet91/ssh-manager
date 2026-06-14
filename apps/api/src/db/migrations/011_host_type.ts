import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS host_type VARCHAR(50) DEFAULT NULL`.execute(db)
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS host_type_detail VARCHAR(200) DEFAULT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS host_type`.execute(db)
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS host_type_detail`.execute(db)
}
