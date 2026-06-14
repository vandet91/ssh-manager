import { Worker, Queue } from 'bullmq'
import { getBullMqConnection } from './redis'
import { rotateKey } from '../modules/rotation/rotation.service'
import { db } from '../db/client'
import pino from 'pino'

const log = pino({ name: 'rotation-worker' })

export function startRotationWorker(): { worker: Worker; queue: Queue } {
  const connection = getBullMqConnection()

  const queue = new Queue('rotation', { connection })

  const worker = new Worker(
    'rotation',
    async (job) => {
      const { keyId, triggeredBy } = job.data as { keyId: string; triggeredBy?: string }
      log.info({ keyId }, 'Starting rotation job')
      await rotateKey(keyId, triggeredBy)
      log.info({ keyId }, 'Rotation job completed')
    },
    { connection, concurrency: 3 },
  )

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Rotation job failed')
  })

  return { worker, queue }
}

// Scheduled rotation: runs every hour
export async function scheduleRotations(queue: Queue): Promise<void> {
  const now = new Date()
  const keys = await db.selectFrom('ssh_keys')
    .select(['id'])
    .where('is_active', '=', true)
    .where('next_rotation_at', '<=', now)
    .where('rotation_policy', '!=', 'manual')
    .execute()

  for (const key of keys) {
    await queue.add('rotate', { keyId: key.id }, { jobId: `rotation-${key.id}-${Date.now()}` })
    log.info({ keyId: key.id }, 'Enqueued scheduled rotation')
  }
}
