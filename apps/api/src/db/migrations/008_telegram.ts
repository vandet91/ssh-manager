import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO settings (key, value) VALUES
      ('telegram_enabled',       'false'::jsonb),
      ('telegram_bot_token',     '""'::jsonb),
      ('telegram_allowed_chats', '[]'::jsonb),
      ('telegram_totp_secret',   '""'::jsonb),
      ('telegram_bot_name',      '"SSH Manager Bot"'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM settings WHERE key IN (
      'telegram_enabled','telegram_bot_token','telegram_allowed_chats',
      'telegram_totp_secret','telegram_bot_name'
    )
  `.execute(db)
}
