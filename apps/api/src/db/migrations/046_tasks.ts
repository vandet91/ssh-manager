import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<never>): Promise<void> {
  // Main task definition
  await sql`
    CREATE TABLE IF NOT EXISTS task_definitions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title           TEXT NOT NULL,
      description     TEXT,
      trigger_type    TEXT NOT NULL DEFAULT 'one_time', -- one_time | schedule | after_task
      run_at          TIMESTAMPTZ,                      -- for one_time
      cron_expr       TEXT,                             -- for schedule (e.g. "0 2 * * 0")
      after_task_id   UUID REFERENCES task_definitions(id) ON DELETE SET NULL,
      priority        TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high | urgent
      is_active       BOOLEAN NOT NULL DEFAULT TRUE,
      notify_telegram BOOLEAN NOT NULL DEFAULT TRUE,
      notify_email    BOOLEAN NOT NULL DEFAULT FALSE,
      notify_email_to TEXT,
      created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  // Steps within a task (executed in order)
  await sql`
    CREATE TABLE IF NOT EXISTS task_steps (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id         UUID NOT NULL REFERENCES task_definitions(id) ON DELETE CASCADE,
      step_order      INTEGER NOT NULL DEFAULT 0,
      step_type       TEXT NOT NULL, -- reminder | ssh_command | device_reboot | ad_disable | ad_enable | firmware_upload | snmp_reboot
      label           TEXT,
      config          JSONB NOT NULL DEFAULT '{}',      -- step-specific params
      delay_before_s  INTEGER NOT NULL DEFAULT 0,       -- seconds to wait before this step
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, step_order)`.execute(db)

  // Each execution of a task
  await sql`
    CREATE TABLE IF NOT EXISTS task_runs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id         UUID NOT NULL REFERENCES task_definitions(id) ON DELETE CASCADE,
      triggered_by    TEXT NOT NULL DEFAULT 'scheduler', -- scheduler | manual | after_task
      status          TEXT NOT NULL DEFAULT 'pending',   -- pending | running | completed | failed | cancelled
      started_at      TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      summary         TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status)`.execute(db)

  // Per-step, per-target execution log
  await sql`
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id          UUID NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
      step_id         UUID REFERENCES task_steps(id) ON DELETE SET NULL,
      target_type     TEXT,   -- server | device | user
      target_id       TEXT,   -- UUID of the target
      target_label    TEXT,   -- display name
      status          TEXT NOT NULL DEFAULT 'pending', -- pending | running | success | failed | skipped
      output          TEXT,
      started_at      TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ
    )
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_task_run_logs_run ON task_run_logs(run_id)`.execute(db)
}

export async function down(db: Kysely<never>): Promise<void> {
  await sql`DROP TABLE IF EXISTS task_run_logs`.execute(db)
  await sql`DROP TABLE IF EXISTS task_runs`.execute(db)
  await sql`DROP TABLE IF EXISTS task_steps`.execute(db)
  await sql`DROP TABLE IF EXISTS task_definitions`.execute(db)
}
