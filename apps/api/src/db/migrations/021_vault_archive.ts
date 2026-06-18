import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('vault_entries')
    .addColumn('is_archived', 'boolean', c => c.defaultTo(false).notNull())
    .execute()
  await db.schema.alterTable('vault_entries')
    .addColumn('archived_at', 'timestamptz')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('vault_entries').dropColumn('archived_at').execute()
  await db.schema.alterTable('vault_entries').dropColumn('is_archived').execute()
}
