import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createReadStream, existsSync } from 'fs'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require('mammoth') as { convertToHtml: (opts: { buffer: Buffer }) => Promise<{ value: string; messages: { message: string }[] }> }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, string> }>

const UPLOAD_DIR = '/app/uploads/documents'

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true })
}

const DocBody = z.object({
  title:     z.string().min(1).max(512).default('Untitled'),
  doc_type:  z.string().default('reference'),
  tags:      z.array(z.string()).default([]),
  content:   z.string().default(''),
  server_id: z.string().uuid().nullable().optional(),
  is_pinned: z.boolean().default(false),
})

export default async function docsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth)

  // GET /docs — list with search + type filter
  fastify.get('/docs', async (req) => {
    const q = z.object({
      search:   z.string().optional(),
      doc_type: z.string().optional(),
      tag:      z.string().optional(),
    }).parse(req.query)

    let qb = db.selectFrom('documents')
      .leftJoin('servers', 'servers.id', 'documents.server_id')
      .leftJoin('users',   'users.id',   'documents.created_by')
      .select([
        'documents.id', 'documents.title', 'documents.doc_type',
        'documents.tags', 'documents.is_pinned', 'documents.server_id',
        'documents.created_at', 'documents.updated_at',
        'servers.name as server_name',
        'users.display_name as creator_name',
      ])
      .orderBy('documents.is_pinned', 'desc')
      .orderBy('documents.updated_at', 'desc')

    if (q.doc_type && q.doc_type !== 'all') {
      qb = qb.where('documents.doc_type', '=', q.doc_type)
    }
    if (q.search) {
      const term = `%${q.search}%`
      qb = qb.where((eb) => eb.or([
        eb('documents.title', 'ilike', term),
        eb('documents.content', 'ilike', term),
      ]))
    }

    const rows = await qb.execute()

    // tag filter (post-query since tags is JSONB array)
    if (q.tag) {
      return rows.filter((r) => {
        const tags = (r.tags as string[]) ?? []
        return tags.includes(q.tag!)
      })
    }
    return rows
  })

  // POST /docs — create
  fastify.post('/docs', async (req, reply) => {
    const body = DocBody.parse(req.body)
    const userId = req.session.user!.id
    const row = await db.insertInto('documents').values({
      title:     body.title,
      doc_type:  body.doc_type,
      tags:      JSON.stringify(body.tags),
      content:   body.content,
      server_id: body.server_id ?? null,
      is_pinned: body.is_pinned,
      created_by: userId,
    }).returningAll().executeTakeFirstOrThrow()
    return reply.code(201).send(row)
  })

  // GET /docs/:id — single doc with content
  fastify.get('/docs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const row = await db.selectFrom('documents')
      .leftJoin('servers', 'servers.id', 'documents.server_id')
      .leftJoin('users',   'users.id',   'documents.created_by')
      .select([
        'documents.id', 'documents.title', 'documents.doc_type',
        'documents.tags', 'documents.content', 'documents.is_pinned',
        'documents.server_id', 'documents.created_at', 'documents.updated_at',
        'servers.name as server_name',
        'users.display_name as creator_name',
      ])
      .where('documents.id', '=', id)
      .executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return row
  })

  // PATCH /docs/:id — update
  fastify.patch('/docs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = DocBody.partial().parse(req.body)
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.title     !== undefined) updates.title     = body.title
    if (body.doc_type  !== undefined) updates.doc_type  = body.doc_type
    if (body.tags      !== undefined) updates.tags      = JSON.stringify(body.tags)
    if (body.content   !== undefined) updates.content   = body.content
    if (body.server_id !== undefined) updates.server_id = body.server_id ?? null
    if (body.is_pinned !== undefined) updates.is_pinned = body.is_pinned
    const row = await db.updateTable('documents').set(updates)
      .where('id', '=', id).returningAll().executeTakeFirst()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return row
  })

  // DELETE /docs/:id
  fastify.delete('/docs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    // Clean up images from disk
    const images = await db.selectFrom('document_images')
      .select(['id', 'filename'])
      .where('document_id', '=', id)
      .execute()
    for (const img of images) {
      const filePath = path.join(UPLOAD_DIR, img.filename)
      await fs.unlink(filePath).catch(() => {})
    }
    await db.deleteFrom('documents').where('id', '=', id).execute()
    return { ok: true }
  })

  // POST /docs/images — upload image (not tied to a specific doc yet)
  fastify.post('/docs/images', async (req, reply) => {
    await ensureUploadDir()
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file' })

    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']
    if (!allowed.includes(data.mimetype)) {
      return reply.code(400).send({ error: 'Only image files allowed' })
    }

    const ext = data.mimetype.split('/')[1].replace('svg+xml', 'svg')
    const row = await db.insertInto('document_images').values({
      filename:    `tmp_${Date.now()}.${ext}`,
      mime_type:   data.mimetype,
      size_bytes:  0,
    }).returningAll().executeTakeFirstOrThrow()

    const filename = `${row.id}.${ext}`
    const filePath = path.join(UPLOAD_DIR, filename)
    const buf = await data.toBuffer()
    await fs.writeFile(filePath, buf)
    await db.updateTable('document_images').set({ filename, size_bytes: buf.length })
      .where('id', '=', row.id).execute()

    return { id: row.id, url: `/docs/images/${row.id}` }
  })

  // GET /docs/images/:imageId — serve image
  fastify.get('/docs/images/:imageId', async (req, reply) => {
    const { imageId } = z.object({ imageId: z.string().uuid() }).parse(req.params)
    const img = await db.selectFrom('document_images').selectAll()
      .where('id', '=', imageId).executeTakeFirst()
    if (!img) return reply.code(404).send({ error: 'Not found' })

    const filePath = path.join(UPLOAD_DIR, img.filename)
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'File missing' })

    reply.header('Content-Type', img.mime_type)
    reply.header('Cache-Control', 'public, max-age=31536000')
    return reply.send(createReadStream(filePath))
  })

  // POST /docs/import/docx — convert .docx → HTML
  fastify.post('/docs/import/docx', async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file' })
    const buf = await data.toBuffer()
    const result = await mammoth.convertToHtml({ buffer: buf })
    return { html: result.value, warnings: result.messages.map((m) => m.message) }
  })

  // POST /docs/import/pdf — extract text from PDF
  fastify.post('/docs/import/pdf', async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file' })
    const buf = await data.toBuffer()
    try {
      const result = await pdfParse(buf)
      // Wrap paragraphs in <p> tags for the editor
      const html = result.text
        .split(/\n{2,}/)
        .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
        .join('')
      return { html, pages: result.numpages, info: result.info?.Title ?? '' }
    } catch {
      return reply.code(422).send({ error: 'Could not parse PDF' })
    }
  })
}
