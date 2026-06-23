import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('radius_servers')
    .ifNotExists()
    .addColumn('id',          'uuid',        c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('name',        'text',        c => c.notNull())
    .addColumn('description', 'text')
    .addColumn('host',        'text',        c => c.notNull())
    .addColumn('auth_port',   'integer',     c => c.notNull().defaultTo(1812))
    .addColumn('acct_port',   'integer',     c => c.notNull().defaultTo(1813))
    .addColumn('secret_enc',  'text',        c => c.notNull())
    .addColumn('timeout',     'integer',     c => c.notNull().defaultTo(5))
    .addColumn('retries',     'integer',     c => c.notNull().defaultTo(2))
    .addColumn('created_by',  'uuid')
    .addColumn('created_at',  'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at',  'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .execute()

  // Seed TOTP action for RADIUS push
  await db.insertInto('totp_action_rules')
    .values({
      action: 'radius_config_push',
      label: 'Push RADIUS config to device',
      category: 'Network Devices',
      enabled: false,
      updated_at: new Date(),
    })
    .onConflict(oc => oc.column('action').doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('radius_servers').ifExists().execute()
  await db.deleteFrom('totp_action_rules' as any).where('action', '=', 'radius_config_push').execute()
}
