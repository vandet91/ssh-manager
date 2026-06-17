import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('pingcastle_reports')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('server_id', 'uuid', (c) => c.references('servers.id').onDelete('cascade').notNull())
    .addColumn('domain_fqdn', 'text')
    .addColumn('generation_date', 'timestamptz')
    .addColumn('global_score', 'integer')
    .addColumn('stale_score', 'integer')
    .addColumn('privileged_score', 'integer')
    .addColumn('trust_score', 'integer')
    .addColumn('anomaly_score', 'integer')
    .addColumn('risk_rules', 'jsonb')
    .addColumn('domain_controllers', 'jsonb')
    .addColumn('uploaded_by', 'text')
    .addColumn('uploaded_at', 'timestamptz', (c) => c.defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('pingcastle_reports_server_id_idx')
    .on('pingcastle_reports')
    .column('server_id')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('pingcastle_reports').execute()
}
