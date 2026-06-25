import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import { createReadStream } from 'fs'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'

const FIRMWARE_ROOT = process.env.TFTP_ROOT
  ? path.join(process.env.TFTP_ROOT, 'firmware')
  : '/var/lib/ssh-manager/tftp-root/firmware'

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

function sanitize(s: string) {
  // Replace anything not alphanumeric/dash/underscore/dot, then strip leading dots to block traversal
  return s.replace(/[^a-zA-Z0-9._\-]/g, '_').replace(/^\.+/, '_').slice(0, 80)
}

function assertInsideRoot(resolvedPath: string, root: string) {
  if (!resolvedPath.startsWith(root + '/') && resolvedPath !== root) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 })
  }
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}

export default async function firmwareRepoRoutes(fastify: FastifyInstance) {
  // ── List all firmware files ──────────────────────────────────────────────────
  fastify.get('/firmware-repo', { preHandler: requireAuth }, async () => {
    const rows = await db
      .selectFrom('firmware_files')
      .selectAll()
      .orderBy('vendor asc')
      .orderBy('model asc')
      .orderBy('uploaded_at desc')
      .execute()
    return rows
  })

  // ── Upload firmware file ─────────────────────────────────────────────────────
  fastify.post('/firmware-repo/upload', { preHandler: requireAuth }, async (req, reply) => {
    const parts = req.parts()
    let vendor = '', model = '', version = '', notes = ''
    let fileBuffer: Buffer | null = null
    let originalFilename = ''

    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname === 'vendor')  vendor  = String(part.value)
        if (part.fieldname === 'model')   model   = String(part.value)
        if (part.fieldname === 'version') version = String(part.value)
        if (part.fieldname === 'notes')   notes   = String(part.value)
      } else if (part.type === 'file') {
        originalFilename = part.filename
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
      }
    }

    if (!vendor || !model || !version || !fileBuffer || !originalFilename) {
      return reply.status(400).send({ error: 'vendor, model, version and file are required' })
    }

    const dir = path.resolve(FIRMWARE_ROOT, sanitize(vendor), sanitize(model))
    assertInsideRoot(dir, path.resolve(FIRMWARE_ROOT))
    await ensureDir(dir)

    const filename = `${sanitize(version)}_${sanitize(originalFilename)}`
    const filePath = path.resolve(dir, filename)
    assertInsideRoot(filePath, path.resolve(FIRMWARE_ROOT))
    await fs.writeFile(filePath, fileBuffer)
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex')

    const user = (req as any).session?.user
    const row = await db
      .insertInto('firmware_files')
      .values({
        vendor, model, version,
        filename,
        file_path: filePath,
        file_size: fileBuffer.length,
        checksum,
        notes: notes || null,
        uploaded_by: user?.email ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return row
  })

  // ── Set latest ───────────────────────────────────────────────────────────────
  fastify.patch('/firmware-repo/:id/set-latest', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const file = await db.selectFrom('firmware_files').selectAll().where('id', '=', id).executeTakeFirst()
    if (!file) return reply.status(404).send({ error: 'Not found' })

    // Clear is_latest for same vendor+model
    await db.updateTable('firmware_files')
      .set({ is_latest: false })
      .where('vendor', '=', file.vendor)
      .where('model', '=', file.model)
      .execute()

    await db.updateTable('firmware_files')
      .set({ is_latest: true, updated_at: new Date() })
      .where('id', '=', id)
      .execute()

    return { ok: true }
  })

  // ── Download firmware file ───────────────────────────────────────────────────
  fastify.get('/firmware-repo/:id/download', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const file = await db.selectFrom('firmware_files').selectAll().where('id', '=', id).executeTakeFirst()
    if (!file) return reply.status(404).send({ error: 'Not found' })

    try {
      await fs.access(file.file_path)
    } catch {
      return reply.status(404).send({ error: 'File not found on disk' })
    }

    reply.header('Content-Disposition', `attachment; filename="${file.filename}"`)
    reply.header('Content-Type', 'application/octet-stream')
    return reply.send(createReadStream(file.file_path))
  })

  // ── Delete firmware file ─────────────────────────────────────────────────────
  fastify.delete('/firmware-repo/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const file = await db.selectFrom('firmware_files').selectAll().where('id', '=', id).executeTakeFirst()
    if (!file) return reply.status(404).send({ error: 'Not found' })

    await db.deleteFrom('firmware_files').where('id', '=', id).execute()
    try { await fs.unlink(file.file_path) } catch { /* file may already be gone */ }

    return { ok: true }
  })

  // ── Update notes ─────────────────────────────────────────────────────────────
  fastify.patch('/firmware-repo/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ notes: z.string().optional() }).parse(req.body)
    await db.updateTable('firmware_files').set({ notes: body.notes ?? null, updated_at: new Date() }).where('id', '=', id).execute()
    return { ok: true }
  })
}
