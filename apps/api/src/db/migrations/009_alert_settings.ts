import { Kysely, sql } from 'kysely'

const DEFAULT_EVENTS = JSON.stringify({
  rotation_failed: true,
  rotation_success: false,
  security_critical: true,
  security_high: true,
  key_expiring: true,
  login_failed: true,
  new_login: false,
  server_unreachable: true,
  key_revoked: true,
  user_deactivated: false,
})

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO settings (key, value) VALUES
      ('alert_webhook_url',      '""'::jsonb),
      ('alert_webhook_enabled',  'false'::jsonb),
      ('alert_email_enabled',    'false'::jsonb),
      ('alert_smtp_host',        '""'::jsonb),
      ('alert_smtp_port',        '587'::jsonb),
      ('alert_smtp_secure',      'false'::jsonb),
      ('alert_smtp_user',        '""'::jsonb),
      ('alert_smtp_pass',        '""'::jsonb),
      ('alert_smtp_from',        '""'::jsonb),
      ('alert_email_recipients', '[]'::jsonb),
      ('alert_telegram_enabled', 'false'::jsonb),
      ('alert_telegram_chat_id', '0'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `.execute(db)

  // Insert alert_events separately to avoid the parameter limitation
  await (db as any)
    .insertInto('settings')
    .values({ key: 'alert_events', value: DEFAULT_EVENTS, updated_at: new Date() })
    .onConflict((oc: any) => oc.column('key').doNothing())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM settings WHERE key IN (
      'alert_webhook_url', 'alert_webhook_enabled', 'alert_email_enabled',
      'alert_smtp_host', 'alert_smtp_port', 'alert_smtp_secure',
      'alert_smtp_user', 'alert_smtp_pass', 'alert_smtp_from',
      'alert_email_recipients', 'alert_telegram_enabled', 'alert_telegram_chat_id', 'alert_events'
    )
  `.execute(db)
}
