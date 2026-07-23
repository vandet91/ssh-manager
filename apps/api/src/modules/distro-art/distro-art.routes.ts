import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { AiProvider } from '../../utils/ai-analyst'

// Same assets directory used for the login background/logo uploads.
const ASSETS_PATH = process.env.RECORDINGS_STORAGE_PATH
  ? path.join(process.env.RECORDINGS_STORAGE_PATH, '..', 'assets')
  : '/var/lib/ssh-manager/assets'

async function getAiConfig(): Promise<{ provider: AiProvider; model: string; apiKey: string } | null> {
  const keys = ['ai_key_claude', 'ai_key_openai', 'ai_key_gemini', 'ai_key_deepseek', 'ai_default_provider', 'ai_default_model']
  const rows = await (db as any).selectFrom('settings').selectAll().where('key', 'in', keys).execute() as Array<{ key: string; value: string }>
  const m = Object.fromEntries(rows.map((r: any) => [r.key, JSON.parse(r.value ?? 'null')]))
  const provider = (m['ai_default_provider'] ?? 'claude') as AiProvider
  const model = (m['ai_default_model'] ?? '') as string
  const apiKey = (m[`ai_key_${provider}`] ?? '') as string
  if (!apiKey) return null
  return { provider, model, apiKey }
}

async function callAiRaw(provider: AiProvider, model: string, apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
    })
    if (!res.ok) throw new Error(`Anthropic error ${res.status}`)
    const data = await res.json() as any
    return data.content?.[0]?.text ?? ''
  }
  if (provider === 'openai' || provider === 'deepseek') {
    const base = provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com'
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: 1024, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
    })
    if (!res.ok) throw new Error(`${provider} error ${res.status}`)
    const data = await res.json() as any
    return data.choices?.[0]?.message?.content ?? ''
  }
  if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-1.5-flash'}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }], generationConfig: { maxOutputTokens: 1024 } }),
    })
    if (!res.ok) throw new Error(`Gemini error ${res.status}`)
    const data = await res.json() as any
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }
  throw new Error('Unknown provider')
}

export default async function distroArtRoutes(app: FastifyInstance) {
  // All authenticated users can read (Terminal needs this)
  app.get('/distro-art', { preHandler: requireAuth }, async () => {
    const rows = await db.selectFrom('distro_art').selectAll().orderBy('key').execute()
    return rows.map(r => ({
      key: r.key,
      art_lines: r.art_lines as string[],
      color: r.color,
      art_type: (r as any).art_type ?? 'ascii',
      has_image: !!(r as any).image_file,
    }))
  })

  // Admin: upsert a distro logo as ASCII text (switches this key back to text mode)
  app.put<{ Params: { key: string } }>('/distro-art/:key', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { key } = req.params
    const body = z.object({
      art_lines: z.array(z.string()).min(1),
      color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
    }).parse(req.body)

    const userId = req.session.user!.id

    // Switching back to text mode — drop any stored image file for this key.
    const existing = await db.selectFrom('distro_art').select(['image_file' as any]).where('key', '=', key).executeTakeFirst()
    const oldImage = (existing as any)?.image_file as string | undefined
    if (oldImage) { try { fs.unlinkSync(path.join(ASSETS_PATH, oldImage)) } catch { /* ignore */ } }

    await db.insertInto('distro_art')
      .values({
        key,
        art_lines: JSON.stringify(body.art_lines) as any,
        color: body.color,
        art_type: 'ascii' as any,
        image_file: null as any,
        updated_by: userId,
        updated_at: new Date(),
      } as any)
      .onConflict(oc => oc.column('key').doUpdateSet({
        art_lines: JSON.stringify(body.art_lines) as any,
        color: body.color,
        art_type: 'ascii' as any,
        image_file: null as any,
        updated_by: userId,
        updated_at: new Date(),
      } as any))
      .execute()

    return { ok: true }
  })

  // Admin: upload a PNG/JPEG/WebP/GIF logo (switches this key to image mode)
  app.post<{ Params: { key: string } }>('/distro-art/:key/image', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { key } = req.params
    if (!/^[a-z0-9_-]+$/.test(key)) return reply.code(400).send({ error: 'Invalid key' })

    await fsp.mkdir(ASSETS_PATH, { recursive: true })

    const parts = req.parts()
    let fileBuffer: Buffer | null = null
    let originalFilename = ''
    for await (const part of parts) {
      if (part.type === 'file') {
        originalFilename = part.filename
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
      }
    }
    if (!fileBuffer || !originalFilename) return reply.code(400).send({ error: 'No file provided' })

    const ext = path.extname(originalFilename).toLowerCase()
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
    if (!allowed.includes(ext)) return reply.code(400).send({ error: 'Only PNG, JPEG, WebP, GIF allowed' })
    if (fileBuffer.length > 3 * 1024 * 1024) return reply.code(400).send({ error: 'Max 3 MB' })

    // Remove any prior image for this key (may have a different extension)
    const existing = await db.selectFrom('distro_art').select(['image_file' as any]).where('key', '=', key).executeTakeFirst()
    const oldImage = (existing as any)?.image_file as string | undefined
    if (oldImage) { try { fs.unlinkSync(path.join(ASSETS_PATH, oldImage)) } catch { /* ignore */ } }

    const filename = `distro-art-${key}${ext}`
    await fsp.writeFile(path.join(ASSETS_PATH, filename), fileBuffer)

    const userId = req.session.user!.id
    await db.insertInto('distro_art')
      .values({
        key,
        art_lines: JSON.stringify([]) as any,
        color: '#94a3b8',
        art_type: 'image' as any,
        image_file: filename as any,
        updated_by: userId,
        updated_at: new Date(),
      } as any)
      .onConflict(oc => oc.column('key').doUpdateSet({
        art_type: 'image' as any,
        image_file: filename as any,
        updated_by: userId,
        updated_at: new Date(),
      } as any))
      .execute()

    return { ok: true }
  })

  // Any authenticated user: fetch the uploaded image (Terminal needs this to render it)
  app.get<{ Params: { key: string } }>('/distro-art/:key/image', { preHandler: requireAuth }, async (req, reply) => {
    const { key } = req.params
    const row = await db.selectFrom('distro_art').select(['image_file' as any]).where('key', '=', key).executeTakeFirst()
    const filename = (row as any)?.image_file as string | undefined
    if (!filename) return reply.code(404).send({ error: 'No image set for this key' })
    const filePath = path.join(ASSETS_PATH, filename)
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'Image file missing' })
    const ext = path.extname(filename).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    reply.header('Content-Type', mime)
    reply.header('Cache-Control', 'private, max-age=300')
    return reply.send(fs.createReadStream(filePath))
  })

  // Admin: generate art via AI
  app.post('/distro-art/generate', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { distro, style } = z.object({
      distro: z.string().min(1),
      style:  z.string().optional(),
    }).parse(req.body)

    const cfg = await getAiConfig()
    if (!cfg) return reply.code(400).send({ error: 'No AI provider configured. Add an API key in Settings → AI Providers.' })

    const systemPrompt = `You are an ASCII art designer specializing in terminal/neofetch-style distro logos.
Return ONLY a valid JSON object with this exact structure:
{
  "art_lines": ["line1", "line2", ...],
  "color": "#hexcolor"
}
Rules:
- art_lines: array of strings forming the ASCII art logo, each line the SAME width (pad with spaces)
- Lines should be 14-20 characters wide
- Use Unicode block characters (█ ▀ ▄ ▌ ▐ ░ ▒ ▓) for filled shapes, or classic ASCII (/ \\ | _ . - #)
- 7-12 lines tall is ideal
- color: the brand hex color of the distro (e.g. Debian=#d40000, Ubuntu=#E95420, Arch=#1793D1)
- Return ONLY the JSON. No markdown, no explanation.`

    const userPrompt = `Design an ASCII art logo for: ${distro}${style ? `\nStyle hint: ${style}` : ''}`

    try {
      let raw = await callAiRaw(cfg.provider, cfg.model, cfg.apiKey, systemPrompt, userPrompt)
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed.art_lines) || !parsed.color) throw new Error('Invalid response structure')
      return { art_lines: parsed.art_lines as string[], color: parsed.color as string }
    } catch (e: any) {
      return reply.code(500).send({ error: `AI generation failed: ${e.message}` })
    }
  })

  // Admin: delete a distro logo (reverts to hardcoded default)
  app.delete<{ Params: { key: string } }>('/distro-art/:key', { preHandler: [requireAuth, requireAdmin] }, async (req) => {
    const { key } = req.params
    const row = await db.selectFrom('distro_art').select(['image_file' as any]).where('key', '=', key).executeTakeFirst()
    const filename = (row as any)?.image_file as string | undefined
    if (filename) { try { fs.unlinkSync(path.join(ASSETS_PATH, filename)) } catch { /* ignore */ } }
    await db.deleteFrom('distro_art').where('key', '=', key).execute()
    return { ok: true }
  })
}
