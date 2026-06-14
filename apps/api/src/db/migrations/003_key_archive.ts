import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Archive tracking columns on ssh_keys
  await db.schema.alterTable('ssh_keys').addColumn('archived_at', 'timestamptz').execute()
  await db.schema.alterTable('ssh_keys').addColumn('archive_reason', 'varchar(20)').execute()
  await db.schema.alterTable('ssh_keys').addColumn('archived_by', 'uuid').execute()
  await db.schema.alterTable('ssh_keys').addColumn('purge_after', 'timestamptz').execute()
  // Links between old and new key after rotation
  await db.schema.alterTable('ssh_keys').addColumn('successor_key_id', 'uuid').execute()
  await db.schema.alterTable('ssh_keys').addColumn('predecessor_key_id', 'uuid').execute()

  await sql`ALTER TABLE ssh_keys ADD CONSTRAINT ssh_keys_archive_reason_check
    CHECK (archive_reason IN ('rotated', 'deleted', 'reverted'))`.execute(db)

  // Index for purge job
  await sql`CREATE INDEX idx_ssh_keys_purge ON ssh_keys (purge_after) WHERE purge_after IS NOT NULL AND is_active = false`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('ssh_keys').dropColumn('predecessor_key_id').execute()
  await db.schema.alterTable('ssh_keys').dropColumn('successor_key_id').execute()
  await db.schema.alterTable('ssh_keys').dropColumn('purge_after').execute()
  await db.schema.alterTable('ssh_keys').dropColumn('archived_by').execute()
  await db.schema.alterTable('ssh_keys').dropColumn('archive_reason').execute()
  await db.schema.alterTable('ssh_keys').dropColumn('archived_at').execute()
}
