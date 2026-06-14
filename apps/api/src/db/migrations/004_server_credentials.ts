import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('server_credentials')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('server_id', 'uuid', (col) => col.references('servers.id').onDelete('cascade').notNull())
    .addColumn('linux_user', 'varchar(100)', (col) => col.notNull())
    .addColumn('label', 'varchar(200)', (col) => col.notNull())  // e.g. "root password", "db admin"
    .addColumn('password_enc', 'text', (col) => col.notNull())   // encrypted with vault key
    .addColumn('notes', 'text')
    .addColumn('created_by', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('last_revealed_at', 'timestamptz')
    .addColumn('last_changed_on_server_at', 'timestamptz')   // set when we pushed chpasswd
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('server_credentials_server_id_idx').on('server_credentials').column('server_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('server_credentials').execute()
}
