import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('vault_entries')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull().defaultTo('other'))
    // server_os | service | api_key | network_device | domain_ad | email | printer | dvr | other
    .addColumn('category', 'text')
    .addColumn('tags', sql`text[]`, (c) => c.defaultTo(sql`'{}'::text[]`))
    .addColumn('username', 'text')
    .addColumn('password_enc', 'text')
    .addColumn('url', 'text')
    .addColumn('notes', 'text')
    // Optional link to a server_credential for bidirectional sync
    .addColumn('server_credential_id', 'uuid', (c) => c.references('server_credentials.id').onDelete('set null'))
    .addColumn('created_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (c) => c.defaultTo(sql`now()`).notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.defaultTo(sql`now()`).notNull())
    .execute()

  await db.schema.createIndex('vault_entries_type_idx').on('vault_entries').column('type').execute()
  await db.schema.createIndex('vault_entries_category_idx').on('vault_entries').column('category').execute()
  await db.schema.createIndex('vault_entries_credential_idx').on('vault_entries').column('server_credential_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('vault_entries').execute()
}
