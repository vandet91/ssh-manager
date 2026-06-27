/**
 * Task scheduler — runs every 60 seconds, checks for due tasks, fires execution.
 */
import pino from 'pino'
import { db } from '../db/client'
import { executeTaskRun } from '../modules/tasks/tasks.executor'

const log = pino({ name: 'tasks-worker' })

function matchesCron(expr: string, now: Date): boolean {
  // Simple cron matcher: "min hour dom month dow"
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, , , dow] = parts

  const matches = (field: string, val: number) => {
    if (field === '*') return true
    if (field.includes(',')) return field.split(',').map(Number).includes(val)
    if (field.includes('-')) {
      const [a, b] = field.split('-').map(Number)
      return val >= a && val <= b
    }
    if (field.includes('/')) {
      const [, step] = field.split('/').map(Number)
      return val % step === 0
    }
    return Number(field) === val
  }

  return (
    matches(min,  now.getMinutes()) &&
    matches(hour, now.getHours()) &&
    matches(dow,  now.getDay())
  )
}

async function tick() {
  const now = new Date()

  try {
    const tasks = await db.selectFrom('task_definitions').selectAll()
      .where('is_active', '=', true).execute()

    for (const task of tasks) {
      try {
        let shouldRun = false

        if (task.trigger_type === 'one_time' && task.run_at) {
          const runAt = new Date(task.run_at)
          const diffMs = now.getTime() - runAt.getTime()
          // Due within this minute and not yet run
          if (diffMs >= 0 && diffMs < 60_000) {
            const existing = await db.selectFrom('task_runs').selectAll()
              .where('task_id', '=', task.id)
              .where('triggered_by', '=', 'scheduler')
              .executeTakeFirst()
            if (!existing) shouldRun = true
          }
        } else if (task.trigger_type === 'schedule' && task.cron_expr) {
          if (matchesCron(task.cron_expr, now)) {
            // Check not already run this minute
            const minuteStart = new Date(now)
            minuteStart.setSeconds(0, 0)
            const existing = await db.selectFrom('task_runs')
              .selectAll()
              .where('task_id', '=', task.id)
              .where('created_at', '>=', minuteStart)
              .executeTakeFirst()
            if (!existing) shouldRun = true
          }
        }

        if (shouldRun) {
          log.info({ taskId: task.id, title: task.title }, 'Scheduling task run')
          const run = await db.insertInto('task_runs').values({
            task_id:      task.id,
            triggered_by: 'scheduler',
            status:       'pending',
          }).returningAll().executeTakeFirstOrThrow()

          executeTaskRun(run.id).catch((err) => {
            log.error({ taskId: task.id, err }, 'Task run failed')
          })
        }
      } catch (err) {
        log.error({ taskId: task.id, err }, 'Error checking task')
      }
    }
  } catch (err) {
    log.error({ err }, 'Task scheduler tick failed')
  }
}

export function startTasksWorker(): () => void {
  log.info('Task scheduler started')
  tick() // run immediately on start
  const interval = setInterval(tick, 60_000)
  return () => {
    clearInterval(interval)
    log.info('Task scheduler stopped')
  }
}
