import { Redis } from 'ioredis'

const KEY_PREFIX = 'sess:'

/**
 * A minimal @fastify/session-compatible store backed by ioredis.
 * @fastify/session expects the classic callback-based Store interface:
 *   get(sid, cb), set(sid, session, cb), destroy(sid, cb)
 */
export class RedisSessionStore {
  private client: Redis
  private ttlSeconds: number

  constructor(client: Redis, ttlMs: number) {
    this.client = client
    this.ttlSeconds = Math.floor(ttlMs / 1000)
  }

  get(sid: string, cb: (err: any, session?: Record<string, unknown> | null) => void): void {
    this.client.get(KEY_PREFIX + sid)
      .then((data) => cb(null, data ? JSON.parse(data) : null))
      .catch(cb)
  }

  set(sid: string, session: Record<string, unknown>, cb: (err?: any) => void): void {
    const ttl = (session?.cookie as any)?.maxAge
      ? Math.floor((session.cookie as any).maxAge / 1000)
      : this.ttlSeconds
    this.client.setex(KEY_PREFIX + sid, ttl, JSON.stringify(session))
      .then(() => cb())
      .catch(cb)
  }

  destroy(sid: string, cb: (err?: any) => void): void {
    this.client.del(KEY_PREFIX + sid)
      .then(() => cb())
      .catch(cb)
  }
}
