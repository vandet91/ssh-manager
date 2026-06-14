import { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('server_credentials')
    .addColumn('is_archived', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute()

  await db.schema.alterTable('server_credentials')
    .addColumn('archived_at', 'timestamptz')
    .execute()

  await db.schema.alterTable('server_credentials')
    .addColumn('archived_reason', 'varchar(50)')   // 'rotated'
    .execute()

  await db.schema.alterTable('server_credentials')
    .addColumn('predecessor_id', 'uuid')   // points to the credential this replaced
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('server_credentials').dropColumn('is_archived').execute()
  await db.schema.alterTable('server_credentials').dropColumn('archived_at').execute()
  await db.schema.alterTable('server_credentials').dropColumn('archived_reason').execute()
  await db.schema.alterTable('server_credentials').dropColumn('predecessor_id').execute()
}
