import { useEffect, useState, useCallback } from 'react'
import { api, Server } from '../api/client'

// ── Types ─────────────────────────────────────────────────────────────────────

type TriggerType = 'one_time' | 'schedule' | 'after_task'
type Priority = 'low' | 'medium' | 'high' | 'urgent'
type StepType = 'reminder' | 'ssh_command' | 'device_reboot' | 'ad_disable' | 'ad_enable' | 'snmp_reboot'
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

interface TaskStep {
  id?: string
  step_order: number
  step_type: StepType
  label?: string
  config: Record<string, unknown>
  delay_before_s: number
}

interface TaskRun {
  id: string
  task_id: string
  triggered_by: string
  status: RunStatus
  started_at: string | null
  completed_at: string | null
  summary: string | null
  created_at: string
  logs?: RunLog[]
}

interface RunLog {
  id: string
  target_label: string | null
  status: string
  output: string | null
}

interface Task {
  id: string
  title: string
  description: string | null
  trigger_type: TriggerType
  run_at: string | null
  cron_expr: string | null
  after_task_id: string | null
  priority: Priority
  is_active: boolean
  notify_telegram: boolean
  notify_email: boolean
  notify_email_to: string | null
  created_at: string
  steps: TaskStep[]
  last_run_at?: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRIORITY_COLOR: Record<Priority, string> = {
  low: '#6b7280', medium: '#3b82f6', high: '#f59e0b', urgent: '#ef4444',
}
const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
}
const STATUS_COLOR: Record<string, string> = {
  pending: '#6b7280', running: '#3b82f6', completed: '#10b981', failed: '#ef4444', cancelled: '#9ca3af',
}
const STEP_TYPE_LABEL: Record<StepType, string> = {
  reminder:      '🔔 Reminder',
  ssh_command:   '⌨ SSH Command',
  device_reboot: '🔄 Device Reboot',
  ad_disable:    '🚫 AD Disable User',
  ad_enable:     '✅ AD Enable User',
  snmp_reboot:   '📡 SNMP Reboot',
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

function toLocalDatetimeInput(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function cronMatchesDate(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [, , dom, , dow] = parts
  const matchField = (field: string, val: number) => {
    if (field === '*') return true
    if (field.includes(',')) return field.split(',').map(Number).includes(val)
    if (field.includes('-')) { const [a, b] = field.split('-').map(Number); return val >= a && val <= b }
    if (field.includes('/')) { const [, step] = field.split('/').map(Number); return val % step === 0 }
    return Number(field) === val
  }
  return matchField(dom, date.getDate()) && matchField(dow, date.getDay())
}

// ── Calendar ──────────────────────────────────────────────────────────────────

function Calendar({ tasks, onDayClick }: { tasks: Task[]; onDayClick: (date: Date) => void }) {
  const [month, setMonth] = useState(() => {
    const d = new Date(); d.setDate(1); return d
  })

  const year = month.getFullYear()
  const mon  = month.getMonth()
  const firstDay = new Date(year, mon, 1).getDay()
  const daysInMonth = new Date(year, mon + 1, 0).getDate()
  const today = new Date()

  // one_time tasks: show on their specific date
  const tasksByDay: Record<number, Task[]> = {}
  for (const t of tasks) {
    if (!t.run_at || !t.is_active) continue
    // Use local date parts to avoid UTC offset shifting the day
    const d = new Date(t.run_at)
    const ly = d.getFullYear(), lm = d.getMonth(), ld = d.getDate()
    if (ly === year && lm === mon) {
      ;(tasksByDay[ld] ??= []).push(t)
    }
  }

  // cron/recurring tasks: show on every matching day of this month
  const cronTasks = tasks.filter(t => t.is_active && t.trigger_type === 'schedule' && t.cron_expr)
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, mon, day)
    for (const t of cronTasks) {
      if (cronMatchesDate(t.cron_expr!, date)) {
        ;(tasksByDay[day] ??= []).push(t)
      }
    }
  }

  const prevMonth = () => setMonth(new Date(year, mon - 1, 1))
  const nextMonth = () => setMonth(new Date(year, mon + 1, 1))

  const monthName = month.toLocaleString('default', { month: 'long', year: 'numeric' })
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-weak)' }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>‹</button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 700, fontSize: 14, color: 'var(--text-heading)' }}>{monthName}</div>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>›</button>
      </div>

      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: '1px solid var(--border-weak)' }}>
        {days.map(d => (
          <div key={d} style={{ textAlign: 'center', padding: '6px 0', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{d}</div>
        ))}
      </div>

      {/* Cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
        {Array.from({ length: firstDay }).map((_, i) => (
          <div key={`empty-${i}`} style={{ minHeight: 80, borderBottom: '1px solid var(--border-weak)', borderRight: '1px solid var(--border-weak)' }} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
          const isToday = today.getDate() === day && today.getMonth() === mon && today.getFullYear() === year
          const dayTasks = tasksByDay[day] ?? []
          return (
            <div
              key={day}
              onClick={() => onDayClick(new Date(year, mon, day))}
              style={{
                minHeight: 80, padding: 6, cursor: 'pointer',
                borderBottom: '1px solid var(--border-weak)',
                borderRight: '1px solid var(--border-weak)',
                background: isToday ? 'var(--accent-hex)10' : 'transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = isToday ? 'var(--accent-hex)10' : 'transparent')}
            >
              {/* Day number */}
              <div style={{ marginBottom: 4 }}>
                <span style={{
                  fontSize: 12, fontWeight: 700,
                  width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: '50%',
                  background: isToday ? 'var(--accent-hex)' : 'transparent',
                  color: isToday ? '#fff' : 'var(--text-secondary)',
                }}>{day}</span>
              </div>
              {/* Google-style event chips */}
              {dayTasks.slice(0, 3).map(t => (
                <div key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11, fontWeight: 600,
                  padding: '2px 6px', borderRadius: 4, marginBottom: 2,
                  background: PRIORITY_COLOR[t.priority],
                  color: '#fff',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  boxShadow: `0 1px 3px ${PRIORITY_COLOR[t.priority]}60`,
                }}>
                  {t.trigger_type === 'schedule' && <span style={{ fontSize: 9, opacity: 0.85 }}>🔁</span>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                </div>
              ))}
              {dayTasks.length > 3 && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 4, fontWeight: 500 }}>
                  +{dayTasks.length - 3} more
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Step editor ───────────────────────────────────────────────────────────────

function StepEditor({ step, servers, onChange, onRemove }: {
  step: TaskStep
  servers: Server[]
  onChange: (s: TaskStep) => void
  onRemove: () => void
}) {
  const cfg = step.config

  const setCfg = (key: string, val: unknown) => onChange({ ...step, config: { ...cfg, [key]: val } })
  const targetIds = (cfg['target_ids'] as string[] | undefined) ?? []

  const toggleTarget = (id: string) => {
    const next = targetIds.includes(id) ? targetIds.filter(x => x !== id) : [...targetIds, id]
    setCfg('target_ids', next)
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '5px 8px', borderRadius: 5,
    border: '1px solid var(--border-med)', background: 'var(--bg-input)',
    color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box',
  }

  return (
    <div style={{ border: '1px solid var(--border-med)', borderRadius: 8, padding: 12, background: 'var(--bg-body)', marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <select value={step.step_type} onChange={e => onChange({ ...step, step_type: e.target.value as StepType, config: {} })}
          style={{ ...inp, flex: 1 }}>
          {Object.entries(STEP_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input value={step.label ?? ''} onChange={e => onChange({ ...step, label: e.target.value })}
          placeholder="Step label (optional)" style={{ ...inp, flex: 1 }} />
        <button onClick={onRemove} style={{ padding: '4px 8px', borderRadius: 5, border: 'none', background: '#7f1d1d', color: '#ef4444', cursor: 'pointer', fontSize: 12 }}>✕</button>
      </div>

      {/* Delay */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Wait before (seconds):</label>
        <input type="number" min={0} value={step.delay_before_s}
          onChange={e => onChange({ ...step, delay_before_s: Number(e.target.value) })}
          style={{ ...inp, width: 80 }} />
      </div>

      {/* Step-specific config */}
      {step.step_type === 'ssh_command' && (
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Command</label>
          <input value={(cfg['command'] as string) ?? ''} onChange={e => setCfg('command', e.target.value)}
            placeholder="e.g. systemctl restart nginx" style={inp} />
        </div>
      )}

      {(step.step_type === 'ad_disable' || step.step_type === 'ad_enable') && (
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>AD Username (sAMAccountName)</label>
          <input value={(cfg['ad_username'] as string) ?? ''} onChange={e => setCfg('ad_username', e.target.value)}
            placeholder="e.g. john.doe" style={inp} />
        </div>
      )}

      {step.step_type === 'device_reboot' && (
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Reboot command (default: reboot)</label>
          <input value={(cfg['reboot_command'] as string) ?? ''} onChange={e => setCfg('reboot_command', e.target.value)}
            placeholder="reboot" style={inp} />
        </div>
      )}

      {/* Target servers (for steps that need targets) */}
      {step.step_type !== 'reminder' && (
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Target servers</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 120, overflowY: 'auto' }}>
            {servers.map(s => {
              const sel = targetIds.includes(s.id)
              return (
                <button key={s.id} onClick={() => toggleTarget(s.id)} style={{
                  padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${sel ? 'var(--accent-hex)' : 'var(--border-med)'}`,
                  background: sel ? 'var(--accent-hex)20' : 'transparent',
                  color: sel ? 'var(--accent-hex)' : 'var(--text-secondary)',
                }}>
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Task form modal ───────────────────────────────────────────────────────────

const defaultRunAt = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.toISOString()
}

const EMPTY_TASK = (): Partial<Task> & { steps: TaskStep[] } => ({
  title: '', description: '', trigger_type: 'one_time', run_at: defaultRunAt(),
  cron_expr: '', priority: 'medium', is_active: true,
  notify_telegram: true, notify_email: false, steps: [],
})

function TaskForm({ task, tasks, servers, onSave, onClose }: {
  task: (Partial<Task> & { steps: TaskStep[] }) | null
  tasks: Task[]
  servers: Server[]
  onSave: (t: Partial<Task> & { steps: TaskStep[] }) => Promise<void>
  onClose: () => void
}) {
  const [form, setForm] = useState<Partial<Task> & { steps: TaskStep[] }>(task ?? EMPTY_TASK())
  const [saving, setSaving] = useState(false)

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }))

  const addStep = () => setForm(f => ({
    ...f, steps: [...f.steps, { step_order: f.steps.length, step_type: 'reminder', config: {}, delay_before_s: 0 }]
  }))

  const updateStep = (i: number, s: TaskStep) => setForm(f => {
    const steps = [...f.steps]; steps[i] = s; return { ...f, steps }
  })
  const removeStep = (i: number) => setForm(f => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) }))

  const handleSave = async () => {
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '7px 10px', borderRadius: 6,
    border: '1px solid var(--border-med)', background: 'var(--bg-input)',
    color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box',
  }
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        width: 680, maxHeight: '90vh', overflow: 'auto',
        background: 'var(--bg-card)', borderRadius: 12,
        border: '1px solid var(--border-med)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        padding: 28,
      }}>
        <h3 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: 'var(--text-heading)' }}>
          {form.id ? 'Edit Task' : 'New Task'}
        </h3>

        {/* Title */}
        <div style={{ marginBottom: 14 }}>
          <label style={label}>Title *</label>
          <input value={form.title ?? ''} onChange={e => set('title', e.target.value)} placeholder="Task title" style={inp} />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 14 }}>
          <label style={label}>Description</label>
          <textarea value={form.description ?? ''} onChange={e => set('description', e.target.value)}
            placeholder="What does this task do?" rows={2}
            style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        {/* Priority + Trigger */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={label}>Priority</label>
            <select value={form.priority ?? 'medium'} onChange={e => set('priority', e.target.value)} style={inp}>
              {(['low','medium','high','urgent'] as Priority[]).map(p => (
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={label}>Trigger type</label>
            <select value={form.trigger_type ?? 'one_time'} onChange={e => set('trigger_type', e.target.value)} style={inp}>
              <option value="one_time">One-time (specific date/time)</option>
              <option value="schedule">Recurring (cron schedule)</option>
              <option value="after_task">After another task completes</option>
            </select>
          </div>
        </div>

        {/* Trigger-specific fields */}
        {form.trigger_type === 'one_time' && (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Run at</label>
            <input type="datetime-local" value={toLocalDatetimeInput(form.run_at ?? null)}
              onChange={e => {
                if (!e.target.value) { set('run_at', null); return }
                const [dp, tp] = e.target.value.split('T')
                const [yr, mo, dy] = dp.split('-').map(Number)
                const [hr, mn] = tp.split(':').map(Number)
                set('run_at', new Date(yr, mo - 1, dy, hr, mn).toISOString())
              }}
              style={inp} />
          </div>
        )}

        {form.trigger_type === 'schedule' && (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Cron expression <span style={{ fontWeight: 400, opacity: 0.6 }}>(min hour dom month dow)</span></label>
            <input value={form.cron_expr ?? ''} onChange={e => set('cron_expr', e.target.value)}
              placeholder="0 2 * * 0  →  every Sunday at 2am" style={inp} />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Examples: <code>0 9 * * 1-5</code> weekdays 9am · <code>0 0 1 * *</code> monthly · <code>*/30 * * * *</code> every 30 min
            </p>
          </div>
        )}

        {form.trigger_type === 'after_task' && (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Run after task</label>
            <select value={form.after_task_id ?? ''} onChange={e => set('after_task_id', e.target.value || null)} style={inp}>
              <option value="">— select task —</option>
              {tasks.filter(t => t.id !== form.id).map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
          </div>
        )}

        {/* Notifications */}
        <div style={{ marginBottom: 16, display: 'flex', gap: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.notify_telegram} onChange={e => set('notify_telegram', e.target.checked)} />
            Telegram notification
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.notify_email} onChange={e => set('notify_email', e.target.checked)} />
            Email notification
          </label>
          {form.notify_email && (
            <input value={form.notify_email_to ?? ''} onChange={e => set('notify_email_to', e.target.value)}
              placeholder="Email address" style={{ ...inp, flex: 1 }} />
          )}
        </div>

        {/* Steps */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <label style={{ ...label, marginBottom: 0 }}>Steps ({form.steps.length})</label>
            <button onClick={addStep} style={{
              padding: '4px 10px', borderRadius: 5, border: 'none',
              background: 'var(--accent-hex)', color: '#fff', fontSize: 12, cursor: 'pointer',
            }}>+ Add Step</button>
          </div>
          {form.steps.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
              No steps — this task will just send a reminder notification.
            </p>
          )}
          {form.steps.map((s, i) => (
            <StepEditor key={i} step={s} servers={servers}
              onChange={ns => updateStep(i, { ...ns, step_order: i })}
              onRemove={() => removeStep(i)} />
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{
            padding: '8px 18px', borderRadius: 6, border: '1px solid var(--border-med)',
            background: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !form.title?.trim()} style={{
            padding: '8px 22px', borderRadius: 6, border: 'none',
            background: 'var(--accent-hex)', color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: 'pointer', opacity: saving ? 0.6 : 1,
          }}>
            {saving ? 'Saving…' : form.id ? 'Update Task' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Run history panel ─────────────────────────────────────────────────────────

function RunHistory({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    api.get<TaskRun[]>(`/tasks/${taskId}/runs`).then(setRuns).catch(() => {})
  }, [taskId])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        width: 600, maxHeight: '80vh', overflow: 'auto',
        background: 'var(--bg-card)', borderRadius: 12,
        border: '1px solid var(--border-med)', padding: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-heading)', flex: 1 }}>Run History</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        {runs.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>No runs yet.</p>}

        {runs.map(run => (
          <div key={run.id} style={{ marginBottom: 8, border: '1px solid var(--border-weak)', borderRadius: 8, overflow: 'hidden' }}>
            <div onClick={() => setOpen(open === run.id ? null : run.id)}
              style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-body)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[run.status] ?? '#6b7280', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>{fmtDate(run.created_at)}</span>
              <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 10, background: (STATUS_COLOR[run.status] ?? '#6b7280') + '20', color: STATUS_COLOR[run.status] ?? '#6b7280' }}>{run.status}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{run.triggered_by}</span>
            </div>
            {open === run.id && (
              <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-weak)' }}>
                {run.summary && <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 8px' }}>{run.summary}</p>}
                {(run.logs ?? []).map(l => (
                  <div key={l.id} style={{ marginBottom: 6, fontSize: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: l.status === 'success' ? '#10b981' : '#ef4444' }}>{l.status === 'success' ? '✅' : '❌'}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{l.target_label ?? '—'}</span>
                    </div>
                    {l.output && <pre style={{ margin: '4px 0 0 20px', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l.output}</pre>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Tasks() {
  const [tasks, setTasks]       = useState<Task[]>([])
  const [servers, setServers]   = useState<Server[]>([])
  const [view, setView]         = useState<'list' | 'calendar'>('list')
  const [formTask, setFormTask] = useState<(Partial<Task> & { steps: TaskStep[] }) | null | false>(false)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [toast, setToast]       = useState<{ msg: string; ok: boolean } | null>(null)
  const [running, setRunning]   = useState<Set<string>>(new Set())

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const load = useCallback(async () => {
    const [t, s] = await Promise.all([
      api.get<Task[]>('/tasks').catch(() => [] as Task[]),
      api.get<Server[]>('/servers').catch(() => [] as Server[]),
    ])
    setTasks(t)
    setServers(s)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async (form: Partial<Task> & { steps: TaskStep[] }) => {
    if (form.id) {
      await api.put(`/tasks/${form.id}`, form)
    } else {
      await api.post('/tasks', form)
    }
    setFormTask(false)
    await load()
    showToast(form.id ? 'Task updated' : 'Task created')
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this task?')) return
    await api.delete(`/tasks/${id}`)
    await load()
    showToast('Task deleted')
  }

  const handleToggle = async (id: string) => {
    await api.patch(`/tasks/${id}/toggle`, {})
    await load()
  }

  const handleRun = async (id: string) => {
    setRunning(r => new Set(r).add(id))
    try {
      await api.post(`/tasks/${id}/run`)
      showToast('Task queued — check run history for results')
      setTimeout(load, 2000)
    } catch {
      showToast('Failed to trigger task', false)
    } finally {
      setRunning(r => { const n = new Set(r); n.delete(id); return n })
    }
  }

  const btnStyle: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 5, border: '1px solid var(--border-med)',
    background: 'var(--bg-input)', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer',
  }

  const upcoming = tasks.filter(t => t.is_active && t.trigger_type !== 'schedule')
    .filter(t => t.run_at && new Date(t.run_at) > new Date())
    .sort((a, b) => new Date(a.run_at!).getTime() - new Date(b.run_at!).getTime())

  const scheduled = tasks.filter(t => t.trigger_type === 'schedule')
  const oneTime   = tasks.filter(t => t.trigger_type === 'one_time')
  const afterTask = tasks.filter(t => t.trigger_type === 'after_task')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 48px)', overflow: 'hidden', background: 'var(--bg-body)' }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: toast.ok ? '#065f46' : '#7f1d1d',
          border: `1px solid ${toast.ok ? '#047857' : '#991b1b'}`,
          borderRadius: 8, padding: '10px 20px',
          color: toast.ok ? '#6ee7b7' : '#fca5a5',
          fontSize: 13, fontWeight: 500, zIndex: 9999,
        }}>{toast.msg}</div>
      )}

      {/* Header */}
      <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border-weak)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, background: 'var(--bg-card)' }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-heading)' }}>Tasks</h1>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
            {tasks.length} task{tasks.length !== 1 ? 's' : ''} · {upcoming.length} upcoming
          </p>
        </div>

        {/* View toggle */}
        <div style={{ display: 'flex', background: 'var(--bg-input)', borderRadius: 6, padding: 2, gap: 2 }}>
          {(['list','calendar'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              padding: '4px 12px', borderRadius: 5, border: 'none', fontSize: 12,
              background: view === v ? 'var(--accent-hex)' : 'transparent',
              color: view === v ? '#fff' : 'var(--text-secondary)', cursor: 'pointer',
            }}>{v === 'list' ? '☰ List' : '📅 Calendar'}</button>
          ))}
        </div>

        <button onClick={() => setFormTask(EMPTY_TASK())} style={{
          padding: '8px 16px', borderRadius: 6, border: 'none',
          background: 'var(--accent-hex)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer',
        }}>+ New Task</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {view === 'calendar' ? (
          <Calendar
            tasks={tasks}
            onDayClick={(date) => {
              date.setHours(9, 0, 0, 0)
              setFormTask({ ...EMPTY_TASK(), run_at: date.toISOString() })
            }}
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 24 }}>
            {/* Task list */}
            <div>
              {tasks.length === 0 && (
                <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
                  <p style={{ fontSize: 14 }}>No tasks yet. Create one to get started.</p>
                </div>
              )}

              {[
                { label: '🕐 One-time', items: oneTime },
                { label: '🔁 Recurring (cron)', items: scheduled },
                { label: '⛓ After another task', items: afterTask },
              ].map(({ label, items }) => items.length === 0 ? null : (
                <div key={label} style={{ marginBottom: 24 }}>
                  <h3 style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</h3>
                  {items.map(task => (
                    <div key={task.id} style={{
                      border: '1px solid var(--border-med)', borderRadius: 10, marginBottom: 8,
                      background: 'var(--bg-card)', overflow: 'hidden',
                      opacity: task.is_active ? 1 : 0.55,
                      borderLeft: `3px solid ${PRIORITY_COLOR[task.priority]}`,
                    }}>
                      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-heading)' }}>{task.title}</span>
                            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: PRIORITY_COLOR[task.priority] + '20', color: PRIORITY_COLOR[task.priority], fontWeight: 600 }}>
                              {PRIORITY_LABEL[task.priority]}
                            </span>
                            {!task.is_active && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>INACTIVE</span>}
                          </div>
                          {task.description && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{task.description}</div>}
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 14 }}>
                            {task.trigger_type === 'one_time' && task.run_at && <span>⏰ {fmtDate(task.run_at)}</span>}
                            {task.trigger_type === 'schedule' && task.cron_expr && <span>🔁 {task.cron_expr}</span>}
                            {task.trigger_type === 'after_task' && <span>⛓ After: {tasks.find(t => t.id === task.after_task_id)?.title ?? '—'}</span>}
                            <span>{task.steps.length} step{task.steps.length !== 1 ? 's' : ''}</span>
                            {task.notify_telegram && <span>📱 Telegram</span>}
                            {task.last_run_at && <span>Last run: {fmtDate(task.last_run_at)}</span>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                          <button onClick={() => handleRun(task.id)} disabled={running.has(task.id)} title="Run now" style={{ ...btnStyle, background: '#065f46', color: '#6ee7b7', border: 'none' }}>
                            {running.has(task.id) ? '⏳' : '▶ Run'}
                          </button>
                          <button onClick={() => setHistoryId(task.id)} style={btnStyle} title="Run history">📋</button>
                          <button onClick={() => handleToggle(task.id)} style={btnStyle} title={task.is_active ? 'Disable' : 'Enable'}>
                            {task.is_active ? '⏸' : '▶'}
                          </button>
                          <button onClick={() => setFormTask({ ...task })} style={btnStyle} title="Edit">✏</button>
                          <button onClick={() => handleDelete(task.id)} style={{ ...btnStyle, border: '1px solid #7f1d1d', color: '#ef4444' }} title="Delete">🗑</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Upcoming sidebar */}
            <div>
              <h3 style={{ margin: '0 0 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Upcoming</h3>
              {upcoming.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No upcoming tasks.</p>}
              {upcoming.map(t => (
                <div key={t.id} style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 6, background: 'var(--bg-card)', border: '1px solid var(--border-weak)', borderLeft: `3px solid ${PRIORITY_COLOR[t.priority]}` }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 3 }}>{t.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(t.run_at)}</div>
                </div>
              ))}

              {/* Cron tasks */}
              {scheduled.filter(t => t.is_active).length > 0 && (
                <>
                  <h3 style={{ margin: '20px 0 8px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recurring</h3>
                  {scheduled.filter(t => t.is_active).map(t => (
                    <div key={t.id} style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 5, background: 'var(--bg-card)', border: '1px solid var(--border-weak)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 2 }}>{t.title}</div>
                      <code style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.cron_expr}</code>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Form modal */}
      {formTask !== false && (
        <TaskForm
          task={formTask}
          tasks={tasks}
          servers={servers}
          onSave={handleSave}
          onClose={() => setFormTask(false)}
        />
      )}

      {/* History modal */}
      {historyId && <RunHistory taskId={historyId} onClose={() => setHistoryId(null)} />}
    </div>
  )
}
