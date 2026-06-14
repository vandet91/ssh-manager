import { Redis } from 'ioredis'
import { config } from '../config'

let redis: Redis | null = null

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  }
  return redis
}

// BullMQ bundles its own ioredis internally — pass a plain connection object,
// never a Redis instance, to avoid the type/version conflict.
export function getBullMqConnection(): { host: string; port: number; password?: string } {
  const url = new URL(config.REDIS_URL)
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password || undefined,
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit()
    redis = null
  }
}
