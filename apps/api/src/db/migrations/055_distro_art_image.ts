import { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('distro_art')
    .addColumn('art_type', 'text', c => c.notNull().defaultTo('ascii'))
    .addColumn('image_file', 'text')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('distro_art').dropColumn('art_type').execute()
  await db.schema.alterTable('distro_art').dropColumn('image_file').execute()
}
