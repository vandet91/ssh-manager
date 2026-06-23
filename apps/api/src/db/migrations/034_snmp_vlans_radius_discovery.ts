import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // VLANs discovered via SNMP per device (dot1qVlanStaticName)
  await db.schema
    .createTable('snmp_vlans')
    .ifNotExists()
    .addColumn('id',          'uuid',        c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('server_id',   'uuid',        c => c.notNull().references('servers.id').onDelete('cascade'))
    .addColumn('vlan_id',     'integer',     c => c.notNull())
    .addColumn('name',        'text',        c => c.notNull().defaultTo(''))
    .addColumn('description', 'text')
    .addColumn('discovered_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('snmp_vlans_server_vlan_idx')
    .ifNotExists()
    .on('snmp_vlans')
    .columns(['server_id', 'vlan_id'])
    .unique()
    .execute()

  // RADIUS servers discovered via SNMP per device (RADIUS-AUTH-CLIENT-MIB)
  await db.schema
    .createTable('snmp_discovered_radius')
    .ifNotExists()
    .addColumn('id',           'uuid',        c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('server_id',    'uuid',        c => c.notNull().references('servers.id').onDelete('cascade'))
    .addColumn('radius_index', 'integer',     c => c.notNull())
    .addColumn('address',      'text',        c => c.notNull())
    .addColumn('auth_port',    'integer')
    .addColumn('access_requests',  'bigint')
    .addColumn('access_accepts',   'bigint')
    .addColumn('access_rejects',   'bigint')
    .addColumn('discovered_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('snmp_discovered_radius_server_idx_idx')
    .ifNotExists()
    .on('snmp_discovered_radius')
    .columns(['server_id', 'radius_index'])
    .unique()
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('snmp_discovered_radius').ifExists().execute()
  await db.schema.dropTable('snmp_vlans').ifExists().execute()
}
