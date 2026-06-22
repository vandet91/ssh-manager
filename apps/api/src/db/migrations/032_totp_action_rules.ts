import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('totp_action_rules')
    .ifNotExists()
    .addColumn('action', 'text', c => c.primaryKey())
    .addColumn('enabled', 'boolean', c => c.notNull().defaultTo(false))
    .addColumn('label', 'text', c => c.notNull())
    .addColumn('category', 'text', c => c.notNull())
    .addColumn('updated_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .execute()

  // Seed default actions — all disabled by default
  const actions = [
    // Servers
    { action: 'server_reboot',           label: 'Reboot server',              category: 'Servers' },
    { action: 'server_shutdown',         label: 'Shutdown server',            category: 'Servers' },
    { action: 'server_root_activate',    label: 'Activate root account',      category: 'Servers' },
    { action: 'server_key_revoke',       label: 'Revoke SSH key',             category: 'Servers' },
    { action: 'server_key_rotation',     label: 'Rotate SSH key',             category: 'Servers' },
    { action: 'server_delete',           label: 'Delete server',              category: 'Servers' },
    // Credentials
    { action: 'credential_reveal',       label: 'Reveal credential',          category: 'Credentials' },
    { action: 'credential_delete',       label: 'Delete credential',          category: 'Credentials' },
    // Network Devices
    { action: 'network_device_reboot',   label: 'Reboot network device',      category: 'Network Devices' },
    { action: 'network_device_reset',    label: 'Factory reset network device', category: 'Network Devices' },
    { action: 'network_port_shutdown',   label: 'Shut down port',             category: 'Network Devices' },
    { action: 'network_vlan_change',     label: 'Change port VLAN',           category: 'Network Devices' },
    { action: 'network_config_push',     label: 'Push config via SSH',        category: 'Network Devices' },
    // Users
    { action: 'user_deactivate',         label: 'Deactivate user',            category: 'Users' },
    { action: 'user_delete',             label: 'Delete user',                category: 'Users' },
    { action: 'user_role_change',        label: 'Change user role',           category: 'Users' },
  ]

  for (const row of actions) {
    await db.insertInto('totp_action_rules')
      .values({ ...row, enabled: false, updated_at: new Date() })
      .onConflict(oc => oc.column('action').doNothing())
      .execute()
  }

  // Elevation window: how long a TOTP verification stays valid (minutes)
  await db.insertInto('settings' as any)
    .values({ key: 'totp_elevation_minutes', value: JSON.stringify(15) })
    .onConflict(oc => oc.column('key').doUpdateSet({ value: JSON.stringify(15) }))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('totp_action_rules').ifExists().execute()
  await db.deleteFrom('settings' as any).where('key', '=', 'totp_elevation_minutes').execute()
}
