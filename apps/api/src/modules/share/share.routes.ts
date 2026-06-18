import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { getRedis } from '../../jobs/redis'

const DRIVE_PATH = '/tmp/guac-uploads'

const EXPIRY_SECONDS = 24 * 3600
const KEY_PREFIX = 'share:'
const LIST_KEY = 'share:index'

function generateId(): string {
  return crypto.randomBytes(8).toString('hex')
}

function getExpiryTime(): string {
  const date = new Date()
  date.setSeconds(date.getSeconds() + EXPIRY_SECONDS)
  return date.toISOString()
}

async function shareRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /share/text — save sticky note
  fastify.post('/share/text', { preHandler: [] }, async (req, reply) => {
    const body = z.object({
      text: z.string().min(1).max(10000),
      device_type: z.string().max(30).default('general'),
      label: z.string().max(100).optional(),
    }).parse(req.body)
    const redis = getRedis()
    const id = generateId()
    const now = new Date().toISOString()
    const expiresAt = getExpiryTime()

    const item = JSON.stringify({
      id,
      type: 'text',
      device_type: body.device_type,
      name: body.label || 'Note',
      content: body.text,
      createdAt: now,
      expiresAt,
    })

    await redis.set(`${KEY_PREFIX}${id}`, item, 'EX', EXPIRY_SECONDS)
    await redis.zadd(LIST_KEY, Date.now(), id)
    await redis.expire(LIST_KEY, EXPIRY_SECONDS)

    return { id, expiresAt }
  })

  // POST /share/file — upload file as base64
  fastify.post('/share/file', { preHandler: [] }, async (req, reply) => {
    const data = await (req as any).file()
    if (!data) return reply.code(400).send({ error: 'No file uploaded' })

    const buf: Buffer = await data.toBuffer()
    const base64 = buf.toString('base64')
    const filename = (data.filename as string).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file'

    const redis = getRedis()
    const id = generateId()
    const now = new Date().toISOString()
    const expiresAt = getExpiryTime()

    const item = JSON.stringify({
      id,
      type: 'file',
      name: filename,
      size: buf.length,
      data: base64,
      createdAt: now,
      expiresAt,
    })

    await redis.set(`${KEY_PREFIX}${id}`, item, 'EX', EXPIRY_SECONDS)
    await redis.zadd(LIST_KEY, Date.now(), id)
    await redis.expire(LIST_KEY, EXPIRY_SECONDS)

    return { id, expiresAt, name: filename, size: buf.length }
  })

  // GET /share/access/:id — get file/text content
  fastify.get('/share/access/:id', { preHandler: [] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const redis = getRedis()
    const raw = await redis.get(`${KEY_PREFIX}${id}`)
    if (!raw) return reply.code(404).send({ error: 'Not found or expired' })

    const item = JSON.parse(raw)
    if (item.type === 'file') {
      const buffer = Buffer.from(item.data, 'base64')
      return reply.type('application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${item.name}"`)
        .send(buffer)
    }
    return reply.type('text/plain').send(item.content)
  })

  // DELETE /share/:id
  fastify.delete('/share/:id', { preHandler: [] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const redis = getRedis()
    await redis.del(`${KEY_PREFIX}${id}`)
    await redis.zrem(LIST_KEY, id)
    return reply.code(204).send()
  })

  // POST /share/:id/save-to-drive — write file from Redis to guac-uploads so it appears in RDP Upload drive
  fastify.post('/share/:id/save-to-drive', { preHandler: [] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const redis = getRedis()
    const raw = await redis.get(`${KEY_PREFIX}${id}`)
    if (!raw) return reply.code(404).send({ error: 'Not found or expired' })

    const item = JSON.parse(raw)
    if (item.type !== 'file') return reply.code(400).send({ error: 'Not a file' })

    fs.mkdirSync(DRIVE_PATH, { recursive: true })
    const dest = path.join(DRIVE_PATH, item.name)
    fs.writeFileSync(dest, Buffer.from(item.data, 'base64'))

    return { ok: true, filename: item.name }
  })

  // GET /share/list — list all items
  fastify.get('/share/list', { preHandler: [] }, async (req, reply) => {
    const redis = getRedis()
    const ids = await redis.zrevrange(LIST_KEY, 0, -1)
    if (!ids.length) return []

    const items: any[] = []
    for (const id of ids) {
      const raw = await redis.get(`${KEY_PREFIX}${id}`)
      if (!raw) {
        await redis.zrem(LIST_KEY, id)
        continue
      }
      const item = JSON.parse(raw)
      // Don't send file data in list (too large)
      const { data, ...rest } = item
      items.push(rest)
    }

    return items
  })
}

export default shareRoutes
