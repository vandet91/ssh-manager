import { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Category: 'linux' | 'database' | 'web' | 'application' | 'service' | 'other'
  await db.schema.alterTable('server_credentials')
    .addColumn('category', 'varchar(50)', (col) => col.notNull().defaultTo('linux'))
    .execute()

  // Name of the service (e.g. "MySQL 8.0", "PostgreSQL", "Redis", "Nginx")
  await db.schema.alterTable('server_credentials')
    .addColumn('service_name', 'varchar(100)')
    .execute()

  // Username for the service (e.g. "root", "admin", "myapp_user") — separate from linux_user
  await db.schema.alterTable('server_credentials')
    .addColumn('service_username', 'varchar(100)')
    .execute()

  // Allow linux_user to be null so non-linux credentials don't need it
  await db.schema.alterTable('server_credentials')
    .alterColumn('linux_user', (col) => col.dropNotNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('server_credentials').dropColumn('category').execute()
  await db.schema.alterTable('server_credentials').dropColumn('service_name').execute()
  await db.schema.alterTable('server_credentials').dropColumn('service_username').execute()
}
