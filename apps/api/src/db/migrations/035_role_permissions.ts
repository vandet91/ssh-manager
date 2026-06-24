import { Kysely, sql } from 'kysely'

const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  operator: [
    'servers:read', 'servers:write',
    'keys:read', 'keys:write', 'keys:rotate',
    'assignments:read', 'assignments:write',
    'terminal:connect',
    'logs:read',
    'security:scan', 'security:read',
  ],
  developer: [
    'servers:read',
    'keys:read',
    'assignments:read',
    'terminal:connect',
    'logs:read',
  ],
  viewer: [
    'servers:read',
    'keys:read',
    'logs:read',
  ],
}

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('role_permissions')
    .ifNotExists()
    .addColumn('id',         'uuid',        c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('role',       'text',        c => c.notNull())
    .addColumn('permission', 'text',        c => c.notNull())
    .addColumn('updated_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('role_permissions_role_perm_idx')
    .ifNotExists()
    .on('role_permissions')
    .columns(['role', 'permission'])
    .unique()
    .execute()

  // Seed defaults
  const rows: { role: string; permission: string }[] = []
  for (const [role, perms] of Object.entries(DEFAULT_PERMISSIONS)) {
    for (const permission of perms) {
      rows.push({ role, permission })
    }
  }
  await db.insertInto('role_permissions').values(rows)
    .onConflict(oc => oc.columns(['role', 'permission']).doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('role_permissions').ifExists().execute()
}
