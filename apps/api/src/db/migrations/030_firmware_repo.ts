import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('firmware_files')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('vendor', 'text', col => col.notNull())
    .addColumn('model', 'text', col => col.notNull())
    .addColumn('version', 'text', col => col.notNull())
    .addColumn('filename', 'text', col => col.notNull())
    .addColumn('file_path', 'text', col => col.notNull())
    .addColumn('file_size', 'bigint')
    .addColumn('checksum', 'text')
    .addColumn('is_latest', 'boolean', col => col.defaultTo(false))
    .addColumn('notes', 'text')
    .addColumn('uploaded_by', 'text')
    .addColumn('uploaded_at', 'timestamptz', col => col.defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', col => col.defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('config_backups')
    .addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('server_id', 'uuid', col => col.notNull().references('servers.id').onDelete('cascade'))
    .addColumn('filename', 'text', col => col.notNull())
    .addColumn('file_path', 'text', col => col.notNull())
    .addColumn('file_size', 'bigint')
    .addColumn('backup_method', 'text', col => col.defaultTo('ssh-pull'))
    .addColumn('status', 'text', col => col.defaultTo('ok'))
    .addColumn('error_message', 'text')
    .addColumn('content_preview', 'text')
    .addColumn('created_at', 'timestamptz', col => col.defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('config_backups_server_id_idx')
    .on('config_backups')
    .column('server_id')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('config_backups').execute()
  await db.schema.dropTable('firmware_files').execute()
}
