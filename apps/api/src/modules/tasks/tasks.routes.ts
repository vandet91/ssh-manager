import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'

const stepSchema = z.object({
  step_order:    z.number().int().default(0),
  step_type:     z.enum(['reminder', 'ssh_command', 'device_reboot', 'ad_disable', 'ad_enable', 'firmware_upload', 'snmp_reboot']),
  label:         z.string().nullish(),
  config:        z.record(z.unknown()).default({}),
  delay_before_s: z.number().int().default(0),
})

const taskSchema = z.object({
  title:           z.string().min(1).max(200),
  description:     z.string().nullish(),
  trigger_type:    z.enum(['one_time', 'schedule', 'after_task']).default('one_time'),
  run_at:          z.string().datetime().nullish(),
  cron_expr:       z.string().nullish(),
  after_task_id:   z.string().uuid().nullish(),
  priority:        z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  is_active:       z.boolean().default(true),
  notify_telegram: z.boolean().default(true),
  notify_email:    z.boolean().default(false),
  notify_email_to: z.string().nullish(),
  steps:           z.array(stepSchema).default([]),
})

export default async function tasksRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth)

  // ── List tasks ────────────────────────────────────────────────────────────────
  fastify.get('/tasks', async () => {
    const tasks = await db.selectFrom('task_definitions').selectAll()
      .orderBy('created_at', 'desc').execute()

    const steps = await db.selectFrom('task_steps').selectAll()
      .orderBy('step_order', 'asc').execute()

    const lastRuns = await db
      .selectFrom('task_runs')
      .select(['task_id', db.fn.max('created_at' as any).as('last_run_at')])
      .where('status', 'in', ['completed', 'failed'])
      .groupBy('task_id')
      .execute()

    const lastRunMap = Object.fromEntries(lastRuns.map(r => [r.task_id, r.last_run_at]))
    const stepsMap: Record<string, typeof steps> = {}
    for (const s of steps) {
      ;(stepsMap[s.task_id] ??= []).push(s)
    }

    return tasks.map(t => ({
      ...t,
      steps: stepsMap[t.id] ?? [],
      last_run_at: lastRunMap[t.id] ?? null,
    }))
  })

  // ── Get single task ───────────────────────────────────────────────────────────
  fastify.get('/tasks/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const task = await db.selectFrom('task_definitions').selectAll()
      .where('id', '=', id).executeTakeFirst()
    if (!task) return reply.code(404).send({ error: 'Not found' })

    const steps = await db.selectFrom('task_steps').selectAll()
      .where('task_id', '=', id).orderBy('step_order', 'asc').execute()

    const runs = await db.selectFrom('task_runs').selectAll()
      .where('task_id', '=', id).orderBy('created_at', 'desc').limit(20).execute()

    return { ...task, steps, runs }
  })

  // ── Create task ───────────────────────────────────────────────────────────────
  fastify.post('/tasks', { preHandler: requireAdmin }, async (req, reply) => {
    const body = taskSchema.parse(req.body)
    const userId = req.session.user!.id

    const task = await db.insertInto('task_definitions').values({
      title:           body.title,
      description:     body.description,
      trigger_type:    body.trigger_type,
      run_at:          body.run_at ? new Date(body.run_at) : null,
      cron_expr:       body.cron_expr,
      after_task_id:   body.after_task_id,
      priority:        body.priority,
      is_active:       body.is_active,
      notify_telegram: body.notify_telegram,
      notify_email:    body.notify_email,
      notify_email_to: body.notify_email_to,
      created_by:      userId,
    }).returningAll().executeTakeFirstOrThrow()

    if (body.steps.length) {
      await db.insertInto('task_steps').values(
        body.steps.map(s => ({ ...s, task_id: task.id, config: JSON.stringify(s.config) }))
      ).execute()
    }

    return reply.code(201).send(task)
  })

  // ── Update task ───────────────────────────────────────────────────────────────
  fastify.put('/tasks/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = taskSchema.parse(req.body)

    const task = await db.updateTable('task_definitions').set({
      title:           body.title,
      description:     body.description,
      trigger_type:    body.trigger_type,
      run_at:          body.run_at ? new Date(body.run_at) : null,
      cron_expr:       body.cron_expr,
      after_task_id:   body.after_task_id,
      priority:        body.priority,
      is_active:       body.is_active,
      notify_telegram: body.notify_telegram,
      notify_email:    body.notify_email,
      notify_email_to: body.notify_email_to,
      updated_at:      new Date(),
    }).where('id', '=', id).returningAll().executeTakeFirst()

    if (!task) return reply.code(404).send({ error: 'Not found' })

    // Replace steps
    await db.deleteFrom('task_steps').where('task_id', '=', id).execute()
    if (body.steps.length) {
      await db.insertInto('task_steps').values(
        body.steps.map(s => ({ ...s, task_id: id, config: JSON.stringify(s.config) }))
      ).execute()
    }

    return task
  })

  // ── Delete task ───────────────────────────────────────────────────────────────
  fastify.delete('/tasks/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await db.deleteFrom('task_definitions').where('id', '=', id).execute()
    return reply.code(200).send({ ok: true })
  })

  // ── Toggle active ─────────────────────────────────────────────────────────────
  fastify.patch('/tasks/:id/toggle', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const task = await db.selectFrom('task_definitions').select(['is_active'])
      .where('id', '=', id).executeTakeFirstOrThrow()
    return db.updateTable('task_definitions')
      .set({ is_active: !task.is_active, updated_at: new Date() })
      .where('id', '=', id).returningAll().executeTakeFirst()
  })

  // ── Manual trigger ────────────────────────────────────────────────────────────
  fastify.post('/tasks/:id/run', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const task = await db.selectFrom('task_definitions').selectAll()
      .where('id', '=', id).executeTakeFirst()
    if (!task) return reply.code(404).send({ error: 'Not found' })

    const run = await db.insertInto('task_runs').values({
      task_id:      id,
      triggered_by: 'manual',
      status:       'pending',
    }).returningAll().executeTakeFirstOrThrow()

    // Import and execute asynchronously
    const { executeTaskRun } = await import('./tasks.executor')
    executeTaskRun(run.id).catch(() => {})

    return reply.code(202).send(run)
  })

  // ── Run history ───────────────────────────────────────────────────────────────
  fastify.get('/tasks/:id/runs', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const runs = await db.selectFrom('task_runs').selectAll()
      .where('task_id', '=', id)
      .orderBy('created_at', 'desc').limit(50).execute()

    const logs = runs.length
      ? await db.selectFrom('task_run_logs').selectAll()
          .where('run_id', 'in', runs.map(r => r.id)).execute()
      : []

    const logsByRun = Object.fromEntries(runs.map(r => [r.id, [] as typeof logs]))
    for (const l of logs) {
      ;(logsByRun[l.run_id] ??= []).push(l)
    }

    return runs.map(r => ({ ...r, logs: logsByRun[r.id] ?? [] }))
  })

  // ── All upcoming tasks (for calendar) ────────────────────────────────────────
  fastify.get('/tasks/upcoming', async () => {
    return db.selectFrom('task_definitions').selectAll()
      .where('is_active', '=', true)
      .where('trigger_type', '!=', 'schedule')
      .where('run_at', '>=', new Date())
      .orderBy('run_at', 'asc')
      .execute()
  })
}
