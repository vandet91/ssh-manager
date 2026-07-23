import { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.insertInto('totp_action_rules')
    .values({ action: 'fs_acl_modify', enabled: false, label: 'Modify file/folder ACL', category: 'File Manager', updated_at: new Date() })
    .onConflict(oc => oc.column('action').doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('totp_action_rules').where('action', '=', 'fs_acl_modify').execute()
}
