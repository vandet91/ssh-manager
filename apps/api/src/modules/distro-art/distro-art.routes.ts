import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { AiProvider } from '../../utils/ai-analyst'

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
    }))
  })

  // Admin: upsert a distro logo
  app.put<{ Params: { key: string } }>('/distro-art/:key', { preHandler: [requireAuth, requireAdmin] }, async (req, reply) => {
    const { key } = req.params
    const body = z.object({
      art_lines: z.array(z.string()).min(1),
      color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
    }).parse(req.body)

    const userId = req.session.user!.id

    await db.insertInto('distro_art')
      .values({
        key,
        art_lines: JSON.stringify(body.art_lines) as any,
        color: body.color,
        updated_by: userId,
        updated_at: new Date(),
      })
      .onConflict(oc => oc.column('key').doUpdateSet({
        art_lines: JSON.stringify(body.art_lines) as any,
        color: body.color,
        updated_by: userId,
        updated_at: new Date(),
      }))
      .execute()

    return { ok: true }
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
    await db.deleteFrom('distro_art').where('key', '=', key).execute()
    return { ok: true }
  })
}
