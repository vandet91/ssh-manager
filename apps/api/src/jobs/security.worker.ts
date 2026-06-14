import { Worker, Queue } from 'bullmq'
import { getBullMqConnection } from './redis'
import { runSecurityScan } from '../modules/security/security.service'
import pino from 'pino'

const log = pino({ name: 'security-worker' })

export function startSecurityWorker(): { worker: Worker; queue: Queue } {
  const connection = getBullMqConnection()

  const queue = new Queue('security', { connection })

  const worker = new Worker(
    'security',
    async (job) => {
      const { serverId } = job.data as { serverId: string }
      log.info({ serverId }, 'Running security scan')
      await runSecurityScan(serverId)
      log.info({ serverId }, 'Security scan completed')
    },
    { connection, concurrency: 5 },
  )

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err }, 'Security scan job failed')
  })

  return { worker, queue }
}
