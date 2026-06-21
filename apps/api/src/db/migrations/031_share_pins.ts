import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('share_pins')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('label', 'text')
    .addColumn('content', 'text', col => col.notNull())
    .addColumn('device_type', 'text', col => col.defaultTo('general'))
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('share_pins').execute()
}
