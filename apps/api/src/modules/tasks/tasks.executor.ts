/**
 * Task executor — runs a task_run by executing each step in order.
 * Called by the scheduler worker and by manual trigger.
 */
import pino from 'pino'
import { db } from '../../db/client'
import { withServerSsh } from '../../utils/server-ssh'

const log = pino({ name: 'task-executor' })

// ── Telegram helper ───────────────────────────────────────────────────────────

async function sendTelegram(text: string): Promise<void> {
  try {
    const settings = await db.selectFrom('settings' as any)
      .select(['key', 'value'] as any)
      .where('key' as any, 'in', ['telegram_enabled', 'telegram_bot_token', 'telegram_allowed_chats'])
      .execute() as { key: string; value: unknown }[]

    const map = Object.fromEntries(settings.map((s) => [s.key, s.value]))
    if (!map['telegram_enabled']) return
    const token = map['telegram_bot_token'] as string
    const chats = map['telegram_allowed_chats'] as number[]
    if (!token || !chats?.length) return

    for (const chatId of chats) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      })
    }
  } catch {
    // Telegram errors should never abort task execution
  }
}

// ── SSH command executor ──────────────────────────────────────────────────────

async function runSshCommand(serverId: string, command: string, ignoreExitCode = false): Promise<string> {
  return withServerSsh(serverId, (client) =>
    new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err)
        let out = ''
        stream.on('data', (d: Buffer) => { out += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { out += d.toString() })
        stream.on('close', (code: number) => {
          if (!ignoreExitCode && code !== 0) {
            reject(new Error(out.trim() || `Command exited with code ${code}`))
          } else {
            resolve(out.trim())
          }
        })
      })
    })
  )
}

// ── Step executors ────────────────────────────────────────────────────────────

async function executeStep(step: {
  id: string; step_type: string; config: unknown; label: string | null
}, runId: string): Promise<void> {
  const cfg = (step.config ?? {}) as Record<string, unknown>

  // Collect targets
  const targetIds = (cfg['target_ids'] as string[] | undefined) ?? []
  const targetType = (cfg['target_type'] as string | undefined) ?? 'server'

  if (targetIds.length === 0) {
    // No targets — just log the step (e.g. reminder)
    await db.insertInto('task_run_logs').values({
      run_id:      runId,
      step_id:     step.id,
      target_type: null,
      target_id:   null,
      target_label: step.label ?? step.step_type,
      status:      'success',
      output:      'Step completed (no target)',
      started_at:  new Date(),
      completed_at: new Date(),
    }).execute()
    return
  }

  for (const targetId of targetIds) {
    let targetLabel = targetId
    try {
      // Resolve label
      if (targetType === 'server') {
        const srv = await db.selectFrom('servers').select(['name']).where('id', '=', targetId).executeTakeFirst()
        targetLabel = srv?.name ?? targetId
      } else if (targetType === 'device') {
        const dev = await db.selectFrom('servers').select(['name']).where('id', '=', targetId).executeTakeFirst()
        targetLabel = dev?.name ?? targetId
      }

      const logRow = await db.insertInto('task_run_logs').values({
        run_id:       runId,
        step_id:      step.id,
        target_type:  targetType,
        target_id:    targetId,
        target_label: targetLabel,
        status:       'running',
        started_at:   new Date(),
      }).returningAll().executeTakeFirstOrThrow()

      let output = ''
      let status = 'success'

      try {
        switch (step.step_type) {
          case 'ssh_command': {
            const cmd = cfg['command'] as string
            if (!cmd) throw new Error('No command specified')
            output = await runSshCommand(targetId, cmd)
            break
          }
          case 'device_reboot': {
            const cmd = (cfg['reboot_command'] as string | undefined) ?? 'shutdown -r now'
            // SSH will drop mid-reboot on real servers — treat disconnect as success
            output = await runSshCommand(targetId, cmd, true).catch(() => 'Reboot command sent')
            break
          }
          case 'reminder': {
            output = 'Reminder delivered'
            break
          }
          case 'ad_disable': {
            const user = cfg['ad_username'] as string
            if (!user) throw new Error('No AD username specified')
            output = await runSshCommand(targetId, `powershell -Command "Disable-ADAccount -Identity '${user}'"`)
            break
          }
          case 'ad_enable': {
            const user = cfg['ad_username'] as string
            if (!user) throw new Error('No AD username specified')
            output = await runSshCommand(targetId, `powershell -Command "Enable-ADAccount -Identity '${user}'"`)
            break
          }
          case 'snmp_reboot': {
            // SNMP reboot via OID 1.3.6.1.4.1.9.2.9.9.0 (Cisco) — generic fallback
            output = 'SNMP reboot not yet implemented'
            break
          }
          default:
            output = `Unknown step type: ${step.step_type}`
        }
      } catch (err) {
        status = 'failed'
        output = (err as Error).message
      }

      await db.updateTable('task_run_logs')
        .set({ status, output, completed_at: new Date() })
        .where('id', '=', logRow.id)
        .execute()

    } catch (err) {
      log.error({ targetId, err }, 'Step target failed')
    }
  }
}

// ── Main executor ─────────────────────────────────────────────────────────────

export async function executeTaskRun(runId: string): Promise<void> {
  // Mark running
  await db.updateTable('task_runs')
    .set({ status: 'running', started_at: new Date() })
    .where('id', '=', runId)
    .execute()

  const run = await db.selectFrom('task_runs').selectAll()
    .where('id', '=', runId).executeTakeFirst()
  if (!run) return

  const task = await db.selectFrom('task_definitions')
    .selectAll()
    .where('id', '=', run.task_id).executeTakeFirst()
  if (!task) return

  const steps = await db.selectFrom('task_steps')
    .selectAll()
    .where('task_id', '=', run.task_id)
    .orderBy('step_order', 'asc').execute()

  if (task.notify_telegram) {
    await sendTelegram(`🔔 <b>Task started</b>: ${task.title}`)
  }

  let overallStatus = 'completed'
  const stepResults: string[] = []

  try {
    for (const step of steps) {
      if (step.delay_before_s > 0) {
        log.info({ runId, stepId: step.id, delay: step.delay_before_s }, 'Waiting before step')
        await new Promise(r => setTimeout(r, step.delay_before_s * 1000))
      }

      log.info({ runId, stepType: step.step_type }, 'Executing step')
      await executeStep(step, runId)

      // Check if any logs for this step failed
      const stepLogs = await db.selectFrom('task_run_logs').selectAll()
        .where('run_id', '=', runId)
        .where('step_id', '=', step.id)
        .execute()

      const failed = stepLogs.filter(l => l.status === 'failed')
      const success = stepLogs.filter(l => l.status === 'success')
      stepResults.push(`${step.label ?? step.step_type}: ✅${success.length} ❌${failed.length}`)
      if (failed.length) overallStatus = 'failed'
    }
  } catch (err) {
    overallStatus = 'failed'
    log.error({ runId, err }, 'Task run failed')
  }

  const summary = stepResults.join(' | ') || 'No steps'

  await db.updateTable('task_runs')
    .set({ status: overallStatus, completed_at: new Date(), summary })
    .where('id', '=', runId)
    .execute()

  if (task.notify_telegram) {
    const icon = overallStatus === 'completed' ? '✅' : '❌'
    await sendTelegram(`${icon} <b>Task ${overallStatus}</b>: ${task.title}\n${summary}`)
  }

  // Trigger after_task dependents
  if (overallStatus === 'completed') {
    const dependents = await db.selectFrom('task_definitions').selectAll()
      .where('after_task_id', '=', run.task_id)
      .where('is_active', '=', true)
      .execute()

    for (const dep of dependents) {
      const depRun = await db.insertInto('task_runs').values({
        task_id:      dep.id,
        triggered_by: 'after_task',
        status:       'pending',
      }).returningAll().executeTakeFirstOrThrow()
      executeTaskRun(depRun.id).catch(() => {})
    }
  }
}
