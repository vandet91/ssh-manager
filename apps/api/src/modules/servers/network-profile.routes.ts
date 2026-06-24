import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'
import { type AiProvider } from '../../utils/ai-analyst'
import { requireTotpElevation } from '../../utils/totp-guard'
import { Client } from 'ssh2'

// â”€â”€ Zod schemas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ProfileBody = z.object({
  // SNMP profile link
  snmp_profile_id: z.string().uuid().nullable().optional(),
  // Ping flags
  ping_enabled: z.boolean().optional(),
  in_stock: z.boolean().optional(),
  // SSH
  access_ssh_enabled: z.boolean().optional(),
  access_ssh_auth_type: z.enum(['key', 'password']).nullable().optional(),
  // Key auth reuses management_key_id / management_linux_user (existing fields)
  management_key_id: z.string().uuid().nullable().optional(),
  management_linux_user: z.string().nullable().optional(),
  // Password auth: stored as a server_credential with category='linux'
  ssh_password: z.string().optional(),   // plaintext on write, never returned
  ssh_username: z.string().optional(),   // used when creating the credential

  // Web
  web_enabled: z.boolean().optional(),
  web_url: z.string().url().nullable().optional(),

  // SNMP
  snmp_enabled: z.boolean().optional(),
  snmp_version: z.enum(['v1', 'v2c', 'v3']).optional(),
  snmp_community: z.string().optional(),  // plaintext on write
  snmp_port: z.number().int().min(1).max(65535).optional(),
  snmp_v3_user: z.string().nullable().optional(),
  snmp_v3_auth_proto: z.enum(['MD5', 'SHA']).nullable().optional(),
  snmp_v3_auth_key: z.string().optional(),
  snmp_v3_priv_proto: z.enum(['DES', 'AES']).nullable().optional(),
  snmp_v3_priv_key: z.string().optional(),
})

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function maybeEncrypt(value: string | undefined | null, key: Buffer): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return encryptSecret(value, key)
}

// â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default async function networkProfileRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /servers/:id/network-profile
  fastify.get('/servers/:id/network-profile', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const vaultKey = getVaultKey()

    // Find password SSH credential if exists
    const sshCred = await db.selectFrom('server_credentials')
      .select(['id', 'linux_user', 'label'])
      .where('server_id', '=', id)
      .where('category', '=', 'linux')
      .where('is_archived', '=', false)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()

    return {
      access_ssh_enabled: server.access_ssh_enabled ?? false,
      access_ssh_auth_type: server.access_ssh_auth_type ?? null,
      management_key_id: server.management_key_id,
      management_linux_user: server.management_linux_user,
      ssh_credential_id: sshCred?.id ?? null,
      ssh_credential_username: sshCred?.linux_user ?? null,

      web_enabled: server.web_enabled ?? false,
      web_url: server.web_url ?? null,

      snmp_enabled: server.snmp_enabled ?? false,
      snmp_version: server.snmp_version ?? 'v2c',
      snmp_community: server.snmp_community_enc ? decryptSecret(server.snmp_community_enc, vaultKey) : '',
      snmp_port: server.snmp_port ?? 161,
      snmp_v3_user: server.snmp_v3_user ?? null,
      snmp_v3_auth_proto: server.snmp_v3_auth_proto ?? null,
      snmp_v3_auth_key: server.snmp_v3_auth_key_enc ? decryptSecret(server.snmp_v3_auth_key_enc, vaultKey) : '',
      snmp_v3_priv_proto: server.snmp_v3_priv_proto ?? null,
      snmp_v3_priv_key: server.snmp_v3_priv_key_enc ? decryptSecret(server.snmp_v3_priv_key_enc, vaultKey) : '',

      snmp_profile_id: server.snmp_profile_id ?? null,
      snmp_last_fetched_at: server.snmp_last_fetched_at ?? null,
      snmp_last_data: server.snmp_last_data ?? null,

      ping_enabled: server.ping_enabled ?? true,
      in_stock: server.in_stock ?? false,
      ping_last_at: server.ping_last_at ?? null,
      ping_last_status: server.ping_last_status ?? null,
      ping_last_latency_ms: server.ping_last_latency_ms ?? null,

      snmp_hostname: server.snmp_hostname ?? null,
      snmp_firmware: server.snmp_firmware ?? null,
      snmp_model: server.snmp_model ?? null,
      snmp_serial: server.snmp_serial ?? null,
      snmp_mac_address: server.snmp_mac_address ?? null,
      snmp_vendor: server.snmp_vendor ?? null,
      snmp_interfaces: server.snmp_interfaces ?? null,

      firmware_check_at: server.firmware_check_at ?? null,
      firmware_check_result: server.firmware_check_result ?? null,
    }
  })

  // PUT /servers/:id/network-profile
  fastify.put('/servers/:id/network-profile', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = ProfileBody.parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const vaultKey = getVaultKey()

    // Handle password SSH credential
    if (body.access_ssh_auth_type === 'password' && body.ssh_password && body.ssh_username) {
      const existing = await db.selectFrom('server_credentials')
        .select(['id'])
        .where('server_id', '=', id)
        .where('category', '=', 'linux')
        .where('is_archived', '=', false)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst()

      const enc = encryptSecret(body.ssh_password, vaultKey)

      if (existing) {
        await db.updateTable('server_credentials')
          .set({ linux_user: body.ssh_username, password_enc: enc, updated_at: new Date() })
          .where('id', '=', existing.id)
          .execute()
      } else {
        await db.insertInto('server_credentials').values({
          server_id: id,
          category: 'linux',
          linux_user: body.ssh_username,
          label: `SSH â€“ ${body.ssh_username}`,
          password_enc: enc,
          created_by: (req.session.user as any)?.id ?? null,
        }).execute()
      }
    }

    const updates: Record<string, unknown> = { updated_at: new Date() }

    if (body.snmp_profile_id !== undefined) updates.snmp_profile_id = body.snmp_profile_id ?? null
    if (body.ping_enabled !== undefined) updates.ping_enabled = body.ping_enabled
    if (body.in_stock !== undefined) updates.in_stock = body.in_stock
    if (body.access_ssh_enabled !== undefined) updates.access_ssh_enabled = body.access_ssh_enabled
    if (body.access_ssh_auth_type !== undefined) updates.access_ssh_auth_type = body.access_ssh_auth_type
    if (body.management_key_id !== undefined) updates.management_key_id = body.management_key_id
    if (body.management_linux_user !== undefined) updates.management_linux_user = body.management_linux_user
    if (body.web_enabled !== undefined) updates.web_enabled = body.web_enabled
    if (body.web_url !== undefined) updates.web_url = body.web_url ?? null
    if (body.snmp_enabled !== undefined) updates.snmp_enabled = body.snmp_enabled
    if (body.snmp_version !== undefined) updates.snmp_version = body.snmp_version
    if (body.snmp_port !== undefined) updates.snmp_port = body.snmp_port
    if (body.snmp_v3_user !== undefined) updates.snmp_v3_user = body.snmp_v3_user
    if (body.snmp_v3_auth_proto !== undefined) updates.snmp_v3_auth_proto = body.snmp_v3_auth_proto
    if (body.snmp_v3_priv_proto !== undefined) updates.snmp_v3_priv_proto = body.snmp_v3_priv_proto

    const encComm = maybeEncrypt(body.snmp_community, vaultKey)
    if (encComm !== undefined) updates.snmp_community_enc = encComm
    const encAuthKey = maybeEncrypt(body.snmp_v3_auth_key, vaultKey)
    if (encAuthKey !== undefined) updates.snmp_v3_auth_key_enc = encAuthKey
    const encPrivKey = maybeEncrypt(body.snmp_v3_priv_key, vaultKey)
    if (encPrivKey !== undefined) updates.snmp_v3_priv_key_enc = encPrivKey

    await db.updateTable('servers').set(updates as any).where('id', '=', id).execute()
    await writeAuditLog({ userId: (req.session.user as any)?.id, userEmail: (req.session.user as any)?.email, action: 'server.network_profile_updated', resource: 'server', resourceId: id, request: req })

    reply.code(204).send()
  })

  // POST /servers/:id/snmp-fetch  â€” enhanced: profile fallback + Entity MIB enrichment
  fastify.post('/servers/:id/snmp-fetch', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.snmp_enabled) return reply.code(400).send({ error: 'SNMP not configured for this device' })

    const vaultKey = getVaultKey()

    // Resolve credentials: device-specific overrides profile, profile is fallback
    let version = server.snmp_version ?? 'v2c'
    let port    = server.snmp_port ?? 161
    let community = server.snmp_community_enc ? decryptSecret(server.snmp_community_enc, vaultKey) : ''
    let v3User    = server.snmp_v3_user ?? ''
    let v3AuthProto = server.snmp_v3_auth_proto ?? null
    let v3AuthKey   = server.snmp_v3_auth_key_enc ? decryptSecret(server.snmp_v3_auth_key_enc, vaultKey) : ''
    let v3PrivProto = server.snmp_v3_priv_proto ?? null
    let v3PrivKey   = server.snmp_v3_priv_key_enc ? decryptSecret(server.snmp_v3_priv_key_enc, vaultKey) : ''

    if (server.snmp_profile_id && !community) {
      const profile = await db.selectFrom('snmp_profiles').selectAll().where('id', '=', server.snmp_profile_id).executeTakeFirst()
      if (profile) {
        version     = profile.version ?? version
        port        = profile.port ?? port
        community   = profile.community_enc ? decryptSecret(profile.community_enc, vaultKey) : community
        v3User      = profile.v3_user ?? v3User
        v3AuthProto = profile.v3_auth_proto ?? v3AuthProto
        v3AuthKey   = profile.v3_auth_key_enc ? decryptSecret(profile.v3_auth_key_enc, vaultKey) : v3AuthKey
        v3PrivProto = profile.v3_priv_proto ?? v3PrivProto
        v3PrivKey   = profile.v3_priv_key_enc ? decryptSecret(profile.v3_priv_key_enc, vaultKey) : v3PrivKey
      }
    }

    if (!community && version !== 'v3') community = 'public'

    try {
      const snmp = await import('net-snmp')

      const sessionOpts: any = {
        port,
        retries: 1,
        timeout: 5000,
        transport: 'udp4',
        version: version === 'v1' ? snmp.Version1 : version === 'v3' ? snmp.Version3 : snmp.Version2c,
      }

      const createSession = (community_: string) => {
        if (version === 'v3') {
          return snmp.createV3Session(server.hostname, {
            name: v3User,
            level: v3PrivKey ? snmp.SecurityLevel.authPriv : v3AuthKey ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv,
            authProtocol: v3AuthProto === 'SHA' ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
            authKey: v3AuthKey,
            privProtocol: v3PrivProto === 'AES' ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
            privKey: v3PrivKey,
          }, sessionOpts)
        }
        return snmp.createSession(server.hostname, community_, sessionOpts)
      }

      const snmpGet = (sess: any, oids: string[]): Promise<Record<string, any>> =>
        new Promise((resolve, reject) => {
          sess.get(oids, (err: any, varbinds: any[]) => {
            if (err) return reject(err)
            const out: Record<string, any> = {}
            oids.forEach((oid, i) => {
              if (snmp.isVarbindError(varbinds[i])) {
                out[oid] = null
              } else {
                const val = varbinds[i]?.value
                if (Buffer.isBuffer(val)) out[oid] = val.toString('utf8').replace(/\0/g, '').trim()
                else if (val && typeof val === 'object' && val.identifiers) out[oid] = val.identifiers.join('.')
                else out[oid] = val != null ? String(val) : null
              }
            })
            resolve(out)
          })
        })

      // Fetch sys MIB
      const SYS_OIDS = {
        sysDescr:    '1.3.6.1.2.1.1.1.0',
        sysObjectID: '1.3.6.1.2.1.1.2.0',
        sysUpTime:   '1.3.6.1.2.1.1.3.0',
        sysContact:  '1.3.6.1.2.1.1.4.0',
        sysName:     '1.3.6.1.2.1.1.5.0',
        sysLocation: '1.3.6.1.2.1.1.6.0',
        ifNumber:    '1.3.6.1.2.1.2.1.0',
      }

      // Entity MIB (index .1 = physical chassis in most devices)
      const ENTITY_OIDS = {
        entPhysicalDescr:     '1.3.6.1.2.1.47.1.1.1.1.2.1',
        entPhysicalName:      '1.3.6.1.2.1.47.1.1.1.1.7.1',
        entPhysicalSoftwareRev: '1.3.6.1.2.1.47.1.1.1.1.10.1',
        entPhysicalSerialNum: '1.3.6.1.2.1.47.1.1.1.1.11.1',
        entPhysicalModelName: '1.3.6.1.2.1.47.1.1.1.1.13.1',
        entPhysicalMfgName:   '1.3.6.1.2.1.47.1.1.1.1.12.1',
      }

      // ifPhysAddress for primary MAC (index 1)
      const MAC_OID = '1.3.6.1.2.1.2.2.1.6.1'

      const sess1 = createSession(community)
      const [sysData, entityData] = await Promise.all([
        snmpGet(sess1, Object.values(SYS_OIDS)),
        snmpGet(sess1, Object.values(ENTITY_OIDS)).catch(() => ({} as Record<string, any>)),
      ])

      // Fetch MAC separately (often times out on some devices â€” best effort)
      let macRaw: Buffer | null = null
      try {
        const macData = await snmpGet(sess1, [MAC_OID])
        const rawVal = macData[MAC_OID]
        if (rawVal && typeof rawVal === 'string' && rawVal.length >= 12) macRaw = Buffer.from(rawVal, 'binary')
      } catch { /* best effort */ }
      sess1.close()

      // Map sys OID keys
      const sysKeys = Object.keys(SYS_OIDS) as (keyof typeof SYS_OIDS)[]
      const sysResult: Record<string, string | null> = {}
      sysKeys.forEach((k, i) => { sysResult[k] = sysData[Object.values(SYS_OIDS)[i]] })

      // Convert sysUpTime ticks â†’ human-readable
      if (sysResult.sysUpTime) {
        const ticks = parseInt(sysResult.sysUpTime, 10)
        if (!isNaN(ticks)) {
          const totalSec = Math.floor(ticks / 100)
          const d = Math.floor(totalSec / 86400)
          const h = Math.floor((totalSec % 86400) / 3600)
          const m = Math.floor((totalSec % 3600) / 60)
          sysResult.sysUpTime = `${d}d ${h}h ${m}m`
        }
      }

      // Map entity OIDs
      const entityKeys = Object.keys(ENTITY_OIDS) as (keyof typeof ENTITY_OIDS)[]
      const entityResult: Record<string, string | null> = {}
      entityKeys.forEach((k, i) => { entityResult[k] = entityData[Object.values(ENTITY_OIDS)[i]] ?? null })

      // Format MAC address
      let macAddress: string | null = null
      if (macRaw && macRaw.length >= 6) {
        macAddress = Array.from(macRaw.slice(0, 6)).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
      }

      // Extract enriched fields
      const hostname  = sysResult.sysName ?? null
      const firmware  = entityResult.entPhysicalSoftwareRev ?? null
      const model     = entityResult.entPhysicalModelName ?? entityResult.entPhysicalName ?? null
      const serial    = entityResult.entPhysicalSerialNum ?? null
      const vendor    = entityResult.entPhysicalMfgName ?? null

      const now = new Date()
      await db.updateTable('servers').set({
        snmp_last_fetched_at: now,
        snmp_last_data: JSON.stringify({ ...sysResult, ...entityResult }),
        snmp_hostname:  hostname,
        snmp_firmware:  firmware,
        snmp_model:     model,
        snmp_serial:    serial,
        snmp_mac_address: macAddress,
        snmp_vendor:    vendor,
        updated_at: now,
      } as any).where('id', '=', id).execute()

      return {
        ok: true,
        fetched_at: now.toISOString(),
        data: sysResult,
        enriched: { hostname, firmware, model, serial, vendor, mac_address: macAddress },
      }
    } catch (err: any) {
      return reply.code(400).send({ error: `SNMP fetch failed: ${err.message ?? err}` })
    }
  })

  // POST /servers/:id/firmware-check â€” AI-powered firmware analysis
  fastify.post('/servers/:id/firmware-check', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const server = await db.selectFrom('servers')
      .select(['id', 'name', 'hostname', 'os_type', 'snmp_vendor', 'snmp_model', 'snmp_firmware', 'snmp_serial'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    if (!server.snmp_firmware && !server.snmp_model) {
      return reply.code(400).send({ error: 'No firmware/model data available. Run SNMP Fetch first.' })
    }

    // Load AI provider settings
    const settingsRows = (await (db as any).selectFrom('settings').selectAll()
      .where('key', 'in', ['ai_key_claude', 'ai_key_openai', 'ai_key_gemini', 'ai_key_deepseek', 'ai_default_provider', 'ai_default_model'])
      .execute()) as Array<{ key: string; value: unknown }>
    const sm = Object.fromEntries(settingsRows.map((r) => [r.key, r.value as string]))

    const provider = (sm.ai_default_provider ?? 'claude') as AiProvider
    const DEFAULT_MODELS: Record<string, string> = {
      claude:   'claude-haiku-4-5-20251001',
      openai:   'gpt-4o-mini',
      gemini:   'gemini-1.5-flash',
      deepseek: 'deepseek-v4-flash',
    }
    const model = (sm.ai_default_model && sm.ai_default_model.trim())
      ? sm.ai_default_model.trim()
      : (DEFAULT_MODELS[provider] ?? 'deepseek-v4-flash')
    const keyMap: Record<string, string> = { claude: sm.ai_key_claude, openai: sm.ai_key_openai, gemini: sm.ai_key_gemini, deepseek: sm.ai_key_deepseek }
    const apiKey = keyMap[provider] ?? ''

    if (!apiKey) return reply.code(400).send({ error: `No API key configured for ${provider}. Add it in Settings â†’ AI Providers.` })

    // Build prompt
    const deviceInfo = [
      `Device name: ${server.name}`,
      `Hostname: ${server.hostname}`,
      `OS/Type: ${server.os_type ?? 'network device'}`,
      `Vendor: ${server.snmp_vendor ?? 'Unknown'}`,
      `Model: ${server.snmp_model ?? 'Unknown'}`,
      `Firmware version: ${server.snmp_firmware ?? 'Unknown'}`,
      `Serial: ${server.snmp_serial ?? 'Unknown'}`,
    ].join('\n')

    const systemPrompt = `You are a network device firmware expert. Your job is to determine if a network device firmware is outdated, list known CVEs, and recommend upgrade paths.
Return ONLY valid JSON. No markdown fences or prose outside JSON.`

    const userPrompt = `Analyse this network device and respond with ONLY valid JSON:
{
  "status": "current|outdated|unknown",
  "current_version": "<the version provided>",
  "latest_version": "<latest known stable version or null>",
  "release_date": "<approx release date of current version or null>",
  "eol": true|false|null,
  "cves": [{"id": "CVE-XXXX-XXXX", "severity": "critical|high|medium|low", "summary": "one-line description"}],
  "recommendation": "<concise action recommendation>",
  "notes": "<any extra context>"
}

Device:
${deviceInfo}`

    try {
      // Call AI API directly to use our own schema instead of the log-analysis schema
      let rawText = ''
      if (provider === 'claude') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
        })
        if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
        const data = await res.json() as any
        rawText = data.content?.[0]?.text ?? ''
      } else if (provider === 'openai' || provider === 'deepseek') {
        const base = provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com'
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 1024, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
        })
        if (!res.ok) throw new Error(`${provider} ${res.status}: ${await res.text()}`)
        const data = await res.json() as any
        rawText = data.choices?.[0]?.message?.content ?? ''
      } else if (provider === 'gemini') {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }], generationConfig: { maxOutputTokens: 1024, responseMimeType: 'application/json' } }),
        })
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
        const data = await res.json() as any
        rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      }
      rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

      let parsed: any = null
      try {
        parsed = JSON.parse(rawText)
      } catch {
        parsed = { status: 'unknown', recommendation: rawText.slice(0, 500), cves: [], notes: 'AI returned non-JSON response' }
      }

      const now = new Date()
      await db.updateTable('servers').set({
        firmware_check_at: now,
        firmware_check_result: JSON.stringify(parsed),
        updated_at: now,
      } as any).where('id', '=', id).execute()

      return { ok: true, checked_at: now.toISOString(), result: parsed }
    } catch (err: any) {
      return reply.code(500).send({ error: `Firmware check failed: ${err.message}` })
    }
  })

  // POST /servers/:id/snmp-ports â€” walk IF-MIB + Q-BRIDGE-MIB, store in snmp_interfaces
  fastify.post('/servers/:id/snmp-ports', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.snmp_enabled) return reply.code(400).send({ error: 'SNMP not configured for this device' })

    const vaultKey = getVaultKey()

    let version  = server.snmp_version ?? 'v2c'
    let port     = server.snmp_port ?? 161
    let community = server.snmp_community_enc ? decryptSecret(server.snmp_community_enc, vaultKey) : ''
    let v3User   = server.snmp_v3_user ?? ''
    let v3AuthProto = server.snmp_v3_auth_proto ?? null
    let v3AuthKey   = server.snmp_v3_auth_key_enc ? decryptSecret(server.snmp_v3_auth_key_enc, vaultKey) : ''
    let v3PrivProto = server.snmp_v3_priv_proto ?? null
    let v3PrivKey   = server.snmp_v3_priv_key_enc ? decryptSecret(server.snmp_v3_priv_key_enc, vaultKey) : ''

    if (server.snmp_profile_id && !community) {
      const profile = await db.selectFrom('snmp_profiles').selectAll().where('id', '=', server.snmp_profile_id).executeTakeFirst()
      if (profile) {
        version     = profile.version ?? version
        port        = profile.port ?? port
        community   = profile.community_enc ? decryptSecret(profile.community_enc, vaultKey) : community
        v3User      = profile.v3_user ?? v3User
        v3AuthProto = profile.v3_auth_proto ?? v3AuthProto
        v3AuthKey   = profile.v3_auth_key_enc ? decryptSecret(profile.v3_auth_key_enc, vaultKey) : v3AuthKey
        v3PrivProto = profile.v3_priv_proto ?? v3PrivProto
        v3PrivKey   = profile.v3_priv_key_enc ? decryptSecret(profile.v3_priv_key_enc, vaultKey) : v3PrivKey
      }
    }
    if (!community && version !== 'v3') community = 'public'

    // Detect model family for OID selection
    const snmpModel   = (server.snmp_model ?? '').toLowerCase()
    const snmpVendor  = (server.snmp_vendor ?? '').toLowerCase()
    const lastData    = (server as any).snmp_last_data
    const sysDescr    = ((typeof lastData === 'string' ? JSON.parse(lastData) : lastData)?.sysDescr ?? '').toLowerCase()
    const isCiscoIos  = (snmpVendor.includes('cisco') || sysDescr.includes('cisco')) &&
                        !sysDescr.includes('small business') && !/^sg[23456]|^cbs[23]/.test(snmpModel)
    const isCiscoSmb  = sysDescr.includes('small business') || /^sg[23456]|^cbs[23]/.test(snmpModel)

    try {
      const snmp = await import('net-snmp')

      const sessionOpts: any = {
        port,
        retries: 1,
        timeout: 6000,
        transport: 'udp4',
        version: version === 'v1' ? snmp.Version1 : version === 'v3' ? snmp.Version3 : snmp.Version2c,
      }

      const sess = version === 'v3'
        ? snmp.createV3Session(server.hostname, {
            name: v3User,
            level: v3PrivKey ? snmp.SecurityLevel.authPriv : v3AuthKey ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv,
            authProtocol: v3AuthProto === 'SHA' ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
            authKey: v3AuthKey,
            privProtocol: v3PrivProto === 'AES' ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
            privKey: v3PrivKey,
          }, sessionOpts)
        : snmp.createSession(server.hostname, community, sessionOpts)

      // Walk a subtree â€” last OID component is the key (usually ifIndex or bridge port)
      const walkTable = (baseOid: string, isMac = false): Promise<Map<number, string>> =>
        new Promise((resolve) => {
          const result = new Map<number, string>()
          sess.subtree(baseOid, 20, (varbinds: any[]) => {
            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue
              const parts = vb.oid.split('.')
              const idx = parseInt(parts[parts.length - 1], 10)
              if (isNaN(idx)) continue
              const raw = vb.value
              let val: string
              if (Buffer.isBuffer(raw)) {
                if (isMac && raw.length === 6) {
                  val = Array.from(raw).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
                } else {
                  val = raw.toString('utf8').replace(/\0/g, '').trim()
                }
              } else if (raw && typeof raw === 'object' && raw.identifiers) {
                val = raw.identifiers.join('.')
              } else {
                val = raw != null ? String(raw) : ''
              }
              result.set(idx, val)
            }
          }, () => resolve(result))
        })

      // Walk bitmask table â€” key is VLAN id, value is port bitmask Buffer
      const walkBitmask = (baseOid: string): Promise<Map<number, Buffer>> =>
        new Promise((resolve) => {
          const result = new Map<number, Buffer>()
          sess.subtree(baseOid, 20, (varbinds: any[]) => {
            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue
              const parts = vb.oid.split('.')
              const key = parseInt(parts[parts.length - 1], 10)
              if (!isNaN(key) && Buffer.isBuffer(vb.value)) result.set(key, vb.value)
            }
          }, () => resolve(result))
        })

      // Walk LLDP neighbors â€” OID ends in <localPortNum>.<remoteIndex>
      // Returns map of localPortNum â†’ { chassis, portId, sysName, sysDesc }
      const walkLldp = (): Promise<Map<number, { chassis: string; portId: string; sysName: string; sysDesc: string }>> =>
        new Promise((resolve) => {
          const chassis = new Map<number, string>()
          const portId  = new Map<number, string>()
          const sysName = new Map<number, string>()
          const sysDesc = new Map<number, string>()

          const walk = (baseOid: string, dest: Map<number, string>, isMac = false) =>
            new Promise<void>((res) => {
              sess.subtree(baseOid, 20, (vbs: any[]) => {
                for (const vb of vbs) {
                  if (snmp.isVarbindError(vb)) continue
                  const parts = vb.oid.split('.')
                  // OID: ....<localPort>.<remoteIndex> â€” take second-to-last
                  const localPort = parseInt(parts[parts.length - 2], 10)
                  if (isNaN(localPort)) continue
                  const raw = vb.value
                  let val = ''
                  if (Buffer.isBuffer(raw)) {
                    if (isMac && raw.length === 6) {
                      val = Array.from(raw).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
                    } else {
                      val = raw.toString('utf8').replace(/\0/g, '').trim()
                    }
                  } else if (raw != null) val = String(raw)
                  if (!dest.has(localPort)) dest.set(localPort, val)
                }
              }, () => res())
            })

          Promise.allSettled([
            walk('1.0.8802.1.1.2.1.4.1.1.5', chassis, true), // lldpRemChassisId (MAC)
            walk('1.0.8802.1.1.2.1.4.1.1.7', portId),        // lldpRemPortId
            walk('1.0.8802.1.1.2.1.4.1.1.9', sysName),       // lldpRemSysName
            walk('1.0.8802.1.1.2.1.4.1.1.10', sysDesc),      // lldpRemSysDesc
          ]).then(() => {
            const result = new Map<number, { chassis: string; portId: string; sysName: string; sysDesc: string }>()
            for (const lp of new Set([...chassis.keys(), ...sysName.keys()])) {
              result.set(lp, {
                chassis: chassis.get(lp) ?? '',
                portId:  portId.get(lp) ?? '',
                sysName: sysName.get(lp) ?? '',
                sysDesc: sysDesc.get(lp) ?? '',
              })
            }
            resolve(result)
          })
        })

      // Walk CDP neighbors (Cisco IOS only) â€” key is ifIndex (first sub-index component)
      const walkCdp = (): Promise<Map<number, { deviceId: string; ipAddr: string; portId: string; platform: string }>> =>
        new Promise((resolve) => {
          const deviceId = new Map<number, string>()
          const ipAddr   = new Map<number, string>()
          const portIdC  = new Map<number, string>()
          const platform = new Map<number, string>()

          const walkCdpTable = (baseOid: string, dest: Map<number, string>, isIp = false) =>
            new Promise<void>((res) => {
              sess.subtree(baseOid, 20, (vbs: any[]) => {
                for (const vb of vbs) {
                  if (snmp.isVarbindError(vb)) continue
                  const parts = vb.oid.split('.')
                  // CDP OID ends in <ifIndex>.<neighborIndex>
                  const ifIdx = parseInt(parts[parts.length - 2], 10)
                  if (isNaN(ifIdx)) continue
                  const raw = vb.value
                  let val = ''
                  if (Buffer.isBuffer(raw)) {
                    if (isIp && raw.length === 4) {
                      val = Array.from(raw).join('.')
                    } else {
                      val = raw.toString('utf8').replace(/\0/g, '').trim()
                    }
                  } else if (raw != null) val = String(raw)
                  if (!dest.has(ifIdx)) dest.set(ifIdx, val)
                }
              }, () => res())
            })

          Promise.allSettled([
            walkCdpTable('1.3.6.1.4.1.9.9.23.1.2.1.1.6', deviceId),      // cdpCacheDeviceId
            walkCdpTable('1.3.6.1.4.1.9.9.23.1.2.1.1.4', ipAddr, true),   // cdpCacheAddress (IP bytes)
            walkCdpTable('1.3.6.1.4.1.9.9.23.1.2.1.1.7', portIdC),        // cdpCacheDevicePort
            walkCdpTable('1.3.6.1.4.1.9.9.23.1.2.1.1.8', platform),       // cdpCachePlatform
          ]).then(() => {
            const result = new Map<number, { deviceId: string; ipAddr: string; portId: string; platform: string }>()
            for (const ifIdx of new Set([...deviceId.keys(), ...ipAddr.keys()])) {
              result.set(ifIdx, {
                deviceId: deviceId.get(ifIdx) ?? '',
                ipAddr:   ipAddr.get(ifIdx) ?? '',
                portId:   portIdC.get(ifIdx) ?? '',
                platform: platform.get(ifIdx) ?? '',
              })
            }
            resolve(result)
          })
        })

      // â”€â”€ Phase 1: IF-MIB (standard, all devices) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const [ifDescr, ifSpeed, ifPhysAddr, ifAdminStatus, ifOperStatus, ifName, ifHighSpeed, ifAlias] =
        await Promise.all([
          walkTable('1.3.6.1.2.1.2.2.1.2'),        // ifDescr
          walkTable('1.3.6.1.2.1.2.2.1.5'),        // ifSpeed (bps)
          walkTable('1.3.6.1.2.1.2.2.1.6', true),  // ifPhysAddress â€” 6-byte MAC
          walkTable('1.3.6.1.2.1.2.2.1.7'),        // ifAdminStatus (1=up,2=down)
          walkTable('1.3.6.1.2.1.2.2.1.8'),        // ifOperStatus (1=up,2=down)
          walkTable('1.3.6.1.2.1.31.1.1.1.1'),     // ifName (IF-MIB extension)
          walkTable('1.3.6.1.2.1.31.1.1.1.15'),    // ifHighSpeed (Mbps)
          walkTable('1.3.6.1.2.1.31.1.1.1.18'),    // ifAlias / description
        ])

      // â”€â”€ Phase 2: Bridge MIB â€” bridge port â†’ ifIndex mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // CRITICAL: Q-BRIDGE bitmasks use bridge port numbers, not ifIndex.
      // dot1dBasePortIfIndex maps bridge port n â†’ ifIndex.
      // Without this, VLAN membership is matched to the wrong interface on most switches.
      const bridgePortToIfIndex = await walkTable('1.3.6.1.2.1.17.1.4.1.2')
        .catch(() => new Map<number, string>())
      // Build reverse map: ifIndex â†’ bridge port number
      const ifIndexToBridgePort = new Map<number, number>()
      for (const [bp, ifIdxStr] of bridgePortToIfIndex) {
        const ifIdx = parseInt(ifIdxStr, 10)
        if (!isNaN(ifIdx)) ifIndexToBridgePort.set(ifIdx, bp)
      }

      // â”€â”€ Phase 3: Q-BRIDGE-MIB (VLAN membership + names) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // dot1qPvid: bridge port â†’ native/access VLAN
      const [dot1qPvid, dot1qVlanStaticName] = await Promise.all([
        walkTable('1.3.6.1.2.1.17.7.1.4.5.1.1').catch(() => new Map<number, string>()),
        // dot1qVlanStaticName: vlanId â†’ name configured on the switch
        walkTable('1.3.6.1.2.1.17.7.1.4.3.1.1').catch(() => new Map<number, string>()),
      ])
      // Build ifIndex â†’ PVID using the bridge port mapping
      const ifIndexToPvid = new Map<number, number>()
      for (const [bp, pvid] of dot1qPvid) {
        const ifIdx = parseInt(bridgePortToIfIndex.get(bp) ?? '', 10)
        if (!isNaN(ifIdx)) ifIndexToPvid.set(ifIdx, parseInt(pvid, 10) || 1)
      }

      // dot1qVlanStaticEgressPorts bitmask â€” bridge port is the bit position
      const egressByVlan = await walkBitmask('1.3.6.1.2.1.17.7.1.4.3.1.2')
        .catch(() => new Map<number, Buffer>())
      // Count how many VLANs each bridge port appears in (>1 = trunk)
      const bridgePortVlanCount = new Map<number, number>()
      for (const bitmask of egressByVlan.values()) {
        for (let b = 0; b < bitmask.length; b++) {
          for (let bit = 0; bit < 8; bit++) {
            if (bitmask[b] & (0x80 >> bit)) {
              const bp = b * 8 + bit + 1
              bridgePortVlanCount.set(bp, (bridgePortVlanCount.get(bp) ?? 0) + 1)
            }
          }
        }
      }

      // â”€â”€ Phase 4: Model-aware port mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Cisco IOS: CISCO-VLAN-MEMBERSHIP-MIB vlanTrunkPortDynamicStatus
      // Cisco SMB: proprietary rlPortSwVlanMode
      // Standard fallback: derive from VLAN count
      let ifIndexToMode = new Map<number, 'access' | 'trunk' | 'unknown'>()

      if (isCiscoIos) {
        // vlanTrunkPortDynamicStatus: 1=trunking, 2=notTrunking â€” keyed by ifIndex
        const trunkStatus = await walkTable('1.3.6.1.4.1.9.9.46.1.6.1.1.14')
          .catch(() => new Map<number, string>())
        for (const [idx, val] of trunkStatus) {
          ifIndexToMode.set(idx, val === '1' ? 'trunk' : 'access')
        }
      } else if (isCiscoSmb) {
        // rlPortSwVlanMode: 1=general, 2=access, 3=trunk, 4=customer â€” keyed by ifIndex
        const smbMode = await walkTable('1.3.6.1.4.1.9.6.1.101.48.22.1.1')
          .catch(() => new Map<number, string>())
        for (const [idx, val] of smbMode) {
          const v = parseInt(val, 10)
          ifIndexToMode.set(idx, v === 3 ? 'trunk' : v === 1 ? 'trunk' : 'access')
        }
      }
      // Fallback: use Q-BRIDGE VLAN count via bridge port mapping
      if (ifIndexToMode.size === 0) {
        for (const [ifIdx, bp] of ifIndexToBridgePort) {
          const count = bridgePortVlanCount.get(bp) ?? 0
          ifIndexToMode.set(ifIdx, count === 0 ? 'unknown' : count === 1 ? 'access' : 'trunk')
        }
      }

      // â”€â”€ Phase 5: STP state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // dot1dStpPortState: 1=disabled,2=blocking,3=listening,4=learning,5=forwarding,6=broken
      // Keyed by bridge port â€” map back to ifIndex
      const stpStateByBp = await walkTable('1.3.6.1.2.1.17.2.15.1.3')
        .catch(() => new Map<number, string>())
      const STP_STATES: Record<string, string> = { '1':'disabled','2':'blocking','3':'listening','4':'learning','5':'forwarding','6':'broken' }
      const ifIndexToStp = new Map<number, string>()
      for (const [bp, val] of stpStateByBp) {
        const ifIdx = parseInt(bridgePortToIfIndex.get(bp) ?? '', 10)
        if (!isNaN(ifIdx)) ifIndexToStp.set(ifIdx, STP_STATES[val] ?? 'unknown')
      }

      // â”€â”€ Phase 6: PortFast / Edge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Cisco IOS: stpxFastStartPortEnable (1=enable,2=disable) â€” keyed by ifIndex
      // Standard:  dot1dStpPortFastEnabled  (1=enable,2=disable) â€” keyed by bridge port
      const ifIndexToEdge = new Map<number, boolean>()
      if (isCiscoIos) {
        const pf = await walkTable('1.3.6.1.4.1.9.9.82.1.9.3.1.3').catch(() => new Map<number, string>())
        for (const [idx, val] of pf) ifIndexToEdge.set(idx, val === '1')
      } else {
        const pf = await walkTable('1.3.6.1.2.1.17.2.19.1.2').catch(() => new Map<number, string>())
        for (const [bp, val] of pf) {
          const ifIdx = parseInt(bridgePortToIfIndex.get(bp) ?? '', 10)
          if (!isNaN(ifIdx)) ifIndexToEdge.set(ifIdx, val === '1')
        }
      }

      // â”€â”€ Phase 7: 802.1X port control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // dot1xPaePortAdminControl (1=forceUnauth, 2=auto, 3=forceAuth) â€” keyed by ifIndex
      const dot1xControl = await walkTable('1.0.8802.1.1.1.1.2.1.1.6')
        .catch(() => new Map<number, string>())
      const DOT1X_MODES: Record<string, string> = { '1':'force-unauthorized','2':'auto','3':'force-authorized' }
      const ifIndexTo8021x = new Map<number, string>()
      for (const [idx, val] of dot1xControl) {
        ifIndexTo8021x.set(idx, DOT1X_MODES[val] ?? 'unknown')
      }

      // â”€â”€ Phase 8: LLDP neighbors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // LLDP local port â†’ ifIndex: lldpLocPortIfIndex (1.0.8802.1.1.2.1.3.7.1.3)
      const lldpLocalPortIfIndex = await walkTable('1.0.8802.1.1.2.1.3.7.1.3')
        .catch(() => new Map<number, string>())
      // Map lldpLocalPort â†’ ifIndex
      const lldpPortToIfIndex = new Map<number, number>()
      for (const [lp, ifIdxStr] of lldpLocalPortIfIndex) {
        const ifIdx = parseInt(ifIdxStr, 10)
        if (!isNaN(ifIdx)) lldpPortToIfIndex.set(lp, ifIdx)
      }
      const lldpNeighborsByLocalPort = await walkLldp().catch(() => new Map())
      // Remap: lldpLocalPort â†’ ifIndex â†’ neighbor
      const ifIndexToLldp = new Map<number, { chassis: string; portId: string; sysName: string; sysDesc: string }>()
      for (const [lp, neighbor] of lldpNeighborsByLocalPort) {
        const ifIdx = lldpPortToIfIndex.get(lp)
        if (ifIdx !== undefined) ifIndexToLldp.set(ifIdx, neighbor)
      }

      // â”€â”€ Phase 9: CDP neighbors (Cisco IOS only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const ifIndexToCdp = new Map<number, { deviceId: string; ipAddr: string; portId: string; platform: string }>()
      if (isCiscoIos) {
        const cdpNeighbors = await walkCdp().catch(() => new Map())
        for (const [ifIdx, n] of cdpNeighbors) ifIndexToCdp.set(ifIdx, n)
      }

      // â”€â”€ Phase 10: RADIUS-AUTH-CLIENT-MIB (RFC 2618) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // radiusAuthServerAddress   .2, radiusAuthServerUDPPort .3
      // radiusAuthClientAccessRequests .5, Accepts .11, Rejects .12
      const [radiusAddr, radiusPort, radiusReqs, radiusAccepts, radiusRejects] = await Promise.all([
        walkTable('1.3.6.1.2.1.67.1.1.1.1.2').catch(() => new Map<number, string>()),
        walkTable('1.3.6.1.2.1.67.1.1.1.1.3').catch(() => new Map<number, string>()),
        walkTable('1.3.6.1.2.1.67.1.1.1.1.5').catch(() => new Map<number, string>()),
        walkTable('1.3.6.1.2.1.67.1.1.1.1.11').catch(() => new Map<number, string>()),
        walkTable('1.3.6.1.2.1.67.1.1.1.1.12').catch(() => new Map<number, string>()),
      ])
      const discoveredRadius = Array.from(radiusAddr.keys()).map(idx => ({
        radius_index: idx,
        address:      radiusAddr.get(idx) ?? '',
        auth_port:    parseInt(radiusPort.get(idx) ?? '1812', 10) || 1812,
        access_requests: parseInt(radiusReqs.get(idx) ?? '0', 10) || 0,
        access_accepts:  parseInt(radiusAccepts.get(idx) ?? '0', 10) || 0,
        access_rejects:  parseInt(radiusRejects.get(idx) ?? '0', 10) || 0,
      })).filter(r => r.address && r.address !== '0.0.0.0')

      // â”€â”€ Assemble port records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const allIndexes = new Set<number>([
        ...ifDescr.keys(), ...ifName.keys(), ...ifOperStatus.keys(),
      ])

      const ports = Array.from(allIndexes)
        .map(idx => {
          const adminRaw  = ifAdminStatus.get(idx)
          const operRaw   = ifOperStatus.get(idx)
          const adminUp   = adminRaw === '1' || adminRaw === 'up'
          const operUp    = operRaw  === '1' || operRaw  === 'up'
          const speedBps  = parseInt(ifSpeed.get(idx) ?? '0', 10)
          const speedMbps = parseInt(ifHighSpeed.get(idx) ?? '0', 10) ||
                            (speedBps > 0 ? Math.round(speedBps / 1_000_000) : 0)

          const mode = ifIndexToMode.get(idx) ?? 'unknown'
          const pvid = ifIndexToPvid.get(idx) ?? null

          const lldp = ifIndexToLldp.get(idx) ?? null
          const cdp  = ifIndexToCdp.get(idx) ?? null
          // Prefer LLDP; fall back to CDP if available
          const neighbor = lldp?.sysName ? lldp : cdp ? {
            chassis: cdp.deviceId, portId: cdp.portId, sysName: cdp.deviceId, sysDesc: cdp.platform,
          } : null

          return {
            index:       idx,
            name:        ifName.get(idx) ?? ifDescr.get(idx) ?? `if${idx}`,
            descr:       ifDescr.get(idx) ?? '',
            alias:       ifAlias.get(idx) ?? '',
            mac:         ifPhysAddr.get(idx) ?? '',
            admin_up:    adminUp,
            oper_up:     operUp,
            speed_mbps:  speedMbps,
            pvid,
            mode,
            stp_state:   ifIndexToStp.get(idx) ?? null,
            edge_port:   ifIndexToEdge.has(idx) ? ifIndexToEdge.get(idx)! : null,
            dot1x:       ifIndexTo8021x.get(idx) ?? null,
            neighbor:    neighbor ? {
              chassis:  neighbor.chassis,
              port_id:  neighbor.portId,
              sys_name: neighbor.sysName,
              sys_desc: neighbor.sysDesc,
            } : null,
          }
        })
        .filter(p => p.name !== 'lo' && !p.name.startsWith('Loopback'))
        .sort((a, b) => a.index - b.index)

      sess.close()

      const now = new Date()
      await db.updateTable('servers').set({
        snmp_interfaces: JSON.stringify(ports),
        snmp_last_fetched_at: now,
        updated_at: now,
      } as any).where('id', '=', id).execute()

      // Upsert discovered VLANs
      if (dot1qVlanStaticName.size > 0) {
        for (const [vlanId, name] of dot1qVlanStaticName) {
          await (db as any).insertInto('snmp_vlans')
            .values({ server_id: id, vlan_id: vlanId, name, discovered_at: now })
            .onConflict((oc: any) => oc.columns(['server_id', 'vlan_id']).doUpdateSet({ name, discovered_at: now }))
            .execute()
        }
        // Remove VLANs no longer present on the switch
        const currentVlanIds = Array.from(dot1qVlanStaticName.keys())
        await (db as any).deleteFrom('snmp_vlans')
          .where('server_id', '=', id)
          .where('vlan_id', 'not in', currentVlanIds)
          .execute()
      }

      // Upsert discovered RADIUS servers
      if (discoveredRadius.length > 0) {
        await (db as any).deleteFrom('snmp_discovered_radius').where('server_id', '=', id).execute()
        await (db as any).insertInto('snmp_discovered_radius')
          .values(discoveredRadius.map(r => ({ ...r, server_id: id, discovered_at: now })))
          .execute()
      }

      // Fetch stored VLAN descriptions to merge with names
      const storedVlans = await (db as any).selectFrom('snmp_vlans')
        .selectAll().where('server_id', '=', id).orderBy('vlan_id', 'asc').execute()

      return { ok: true, fetched_at: now.toISOString(), ports, vlans: storedVlans, discovered_radius: discoveredRadius }
    } catch (err: any) {
      return reply.code(400).send({ error: `SNMP port walk failed: ${err.message ?? err}` })
    }
  })

  // GET /servers/:id/snmp-vlans â€” return VLANs discovered for this device
  fastify.get('/servers/:id/snmp-vlans', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const vlans = await (db as any).selectFrom('snmp_vlans').selectAll()
      .where('server_id', '=', id).orderBy('vlan_id', 'asc').execute()
    return vlans
  })

  // POST /servers/:id/snmp-vlans â€” manually add a VLAN
  fastify.post('/servers/:id/snmp-vlans', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { vlan_id, name, description } = z.object({
      vlan_id: z.number().int().min(1).max(4094),
      name: z.string().default(''),
      description: z.string().optional(),
    }).parse(req.body)
    const row = await (db as any).insertInto('snmp_vlans')
      .values({ server_id: id, vlan_id, name, description: description ?? null, discovered_at: new Date() })
      .onConflict((oc: any) => oc.columns(['server_id', 'vlan_id']).doUpdateSet({ name, description: description ?? null }))
      .returningAll()
      .executeTakeFirst()
    return row
  })

  // PATCH /servers/:id/snmp-vlans/:vlanId â€” update name and/or description
  fastify.patch('/servers/:id/snmp-vlans/:vlanId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, vlanId } = z.object({ id: z.string().uuid(), vlanId: z.string() }).parse(req.params)
    const body = z.object({ name: z.string().optional(), description: z.string().optional() }).parse(req.body)
    await (db as any).updateTable('snmp_vlans')
      .set(body)
      .where('server_id', '=', id)
      .where('vlan_id', '=', parseInt(vlanId, 10))
      .execute()
    return { ok: true }
  })

  // DELETE /servers/:id/snmp-vlans/:vlanId â€” remove a manually added VLAN
  fastify.delete('/servers/:id/snmp-vlans/:vlanId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, vlanId } = z.object({ id: z.string().uuid(), vlanId: z.string() }).parse(req.params)
    await (db as any).deleteFrom('snmp_vlans')
      .where('server_id', '=', id)
      .where('vlan_id', '=', parseInt(vlanId, 10))
      .execute()
    return { ok: true }
  })

  // GET /servers/:id/snmp-discovered-radius â€” return RADIUS servers discovered via SNMP
  fastify.get('/servers/:id/snmp-discovered-radius', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const rows = await (db as any).selectFrom('snmp_discovered_radius').selectAll()
      .where('server_id', '=', id).orderBy('radius_index', 'asc').execute()
    return rows
  })

  // POST /servers/:id/snmp-port-admin â€” enable/disable a port via SNMP SET ifAdminStatus
  fastify.post('/servers/:id/snmp-port-admin', {
    preHandler: [requireAdmin, requireTotpElevation('network_port_shutdown')],
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { ifIndex, adminUp } = z.object({ ifIndex: z.number().int().min(1), adminUp: z.boolean() }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.snmp_enabled) return reply.code(400).send({ error: 'SNMP not configured for this device' })

    const vaultKey = getVaultKey()
    let version  = server.snmp_version ?? 'v2c'
    let port     = server.snmp_port ?? 161
    let community = server.snmp_community_enc ? decryptSecret(server.snmp_community_enc, vaultKey) : ''
    let v3User   = server.snmp_v3_user ?? ''
    let v3AuthProto = server.snmp_v3_auth_proto ?? null
    let v3AuthKey   = server.snmp_v3_auth_key_enc ? decryptSecret(server.snmp_v3_auth_key_enc, vaultKey) : ''
    let v3PrivProto = server.snmp_v3_priv_proto ?? null
    let v3PrivKey   = server.snmp_v3_priv_key_enc ? decryptSecret(server.snmp_v3_priv_key_enc, vaultKey) : ''

    if (server.snmp_profile_id && !community) {
      const profile = await db.selectFrom('snmp_profiles').selectAll().where('id', '=', server.snmp_profile_id).executeTakeFirst()
      if (profile) {
        version     = profile.version ?? version
        port        = profile.port ?? port
        community   = profile.community_enc ? decryptSecret(profile.community_enc, vaultKey) : community
        v3User      = profile.v3_user ?? v3User
        v3AuthProto = profile.v3_auth_proto ?? v3AuthProto
        v3AuthKey   = profile.v3_auth_key_enc ? decryptSecret(profile.v3_auth_key_enc, vaultKey) : v3AuthKey
        v3PrivProto = profile.v3_priv_proto ?? v3PrivProto
        v3PrivKey   = profile.v3_priv_key_enc ? decryptSecret(profile.v3_priv_key_enc, vaultKey) : v3PrivKey
      }
    }
    if (!community && version !== 'v3') community = 'public'

    try {
      const snmp = await import('net-snmp')
      const sessionOpts: any = {
        port, retries: 1, timeout: 5000, transport: 'udp4',
        version: version === 'v1' ? snmp.Version1 : version === 'v3' ? snmp.Version3 : snmp.Version2c,
      }
      const sess = version === 'v3'
        ? snmp.createV3Session(server.hostname, {
            name: v3User,
            level: v3PrivKey ? snmp.SecurityLevel.authPriv : v3AuthKey ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv,
            authProtocol: v3AuthProto === 'SHA' ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
            authKey: v3AuthKey,
            privProtocol: v3PrivProto === 'AES' ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
            privKey: v3PrivKey,
          }, sessionOpts)
        : snmp.createSession(server.hostname, community, sessionOpts)

      await new Promise<void>((resolve, reject) => {
        sess.set([{
          oid: `1.3.6.1.2.1.2.2.1.7.${ifIndex}`,
          type: snmp.ObjectType.Integer,
          value: adminUp ? 1 : 2,
        }], (err: any) => {
          sess.close()
          if (err) reject(err)
          else resolve()
        })
      })

      // Update cached snmp_interfaces in DB
      const current: any[] = (server.snmp_interfaces as any[]) ?? []
      const updated = current.map(p => p.index === ifIndex ? { ...p, admin_up: adminUp, oper_up: adminUp ? p.oper_up : false } : p)
      await db.updateTable('servers').set({ snmp_interfaces: JSON.stringify(updated), updated_at: new Date() } as any).where('id', '=', id).execute()

      await writeAuditLog({
        userId: (req.session.user as any)?.id,
        userEmail: (req.session.user as any)?.email,
        action: adminUp ? 'network.port_enabled' : 'network.port_disabled',
        resource: 'server', resourceId: id,
        details: { ifIndex },
        request: req,
      })

      return { ok: true, ifIndex, adminUp }
    } catch (err: any) {
      return reply.code(400).send({ error: `SNMP SET failed: ${err.message ?? err}` })
    }
  })

  // â”€â”€ Shared SSH helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function connectSsh(server: any, id: string, vaultKey: Buffer): Promise<Client> {
    return new Promise(async (resolve, reject) => {
      const client = new Client()
      let cfg: any = { host: server.hostname, port: server.ssh_port ?? 22, readyTimeout: 12000 }
      if (server.access_ssh_auth_type === 'password') {
        const cred = await db.selectFrom('server_credentials').selectAll()
          .where('server_id', '=', id).where('category', '=', 'linux').where('is_archived', '=', false)
          .orderBy('created_at', 'desc').limit(1).executeTakeFirst()
        if (!cred || !cred.password_enc) return reject(new Error('No SSH password credential configured'))
        cfg = { ...cfg, username: cred.linux_user ?? 'admin', password: decryptSecret(cred.password_enc as string, vaultKey) }
      } else {
        if (!server.management_key_id) return reject(new Error('No SSH key configured'))
        const key = await db.selectFrom('ssh_keys').selectAll().where('id', '=', server.management_key_id).executeTakeFirst()
        if (!key) return reject(new Error('SSH key not found'))
        cfg = { ...cfg, username: server.management_linux_user ?? 'admin', privateKey: decryptSecret(key.private_key_enc as string, vaultKey) }
      }
      client.on('ready', () => resolve(client))
      client.on('error', reject)
      client.connect(cfg)
    })
  }

  function runSshShell(client: Client, commands: string, timeoutMs = 6000): Promise<string> {
    return new Promise((resolve) => {
      client.shell({ term: 'vt100', cols: 220, rows: 50 }, (err: any, stream: any) => {
        if (err) { client.end(); resolve(`Shell error: ${err.message}`); return }
        const chunks: Buffer[] = []
        stream.on('data', (d: Buffer) => chunks.push(d))
        stream.stderr?.on('data', (d: Buffer) => chunks.push(d))
        stream.on('close', () => { client.end(); resolve(Buffer.concat(chunks).toString('utf8').slice(0, 3000)) })
        stream.write(commands + '\nexit\n')
        setTimeout(() => { try { stream.close() } catch {} }, timeoutMs)
      })
    })
  }

  // â”€â”€ Vendor detection helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function detectCiscoVariant(vendor: string, model: string, sysDescr: string): 'nxos' | 'xr' | 'sb' | 'ios' {
    const m = model.toLowerCase()
    const d = sysDescr.toLowerCase()
    // NX-OS: Nexus model numbers start with N (N2K, N3K, N5K, N7K, N9K) or C9x (9300/9500 NX-OS)
    if (d.includes('nx-os') || d.includes('nxos') || /^n[2359]k/.test(m) || /^c9[35]\d{2}/.test(m)) return 'nxos'
    // IOS-XR: carrier-grade ASR 9000, NCS, CRS
    if (d.includes('ios xr') || d.includes('iosxr') || /^asr9|^ncs[456]|^crs/.test(m)) return 'xr'
    // Small Business: SG, CBS series
    if (d.includes('small business') || /^sg[23456]|^cbs[23]/.test(m)) return 'sb'
    return 'ios'
  }

  function normalizeCiscoIface(ifName: string, model = ''): string {
    // SNMP walks return short names like "1", "gi1", "Gi1/0/1", "Te1/0/25" etc.
    // We need to produce the exact string the CLI "interface <x>" command expects.
    // Logic derived from Cisco VBA tooling (confirmed against SG/CBS/IOS hardware):
    const m = model.toLowerCase()
    const p = ifName.toLowerCase()

    // Already a full interface name â€” pass through unchanged
    // e.g. "GigabitEthernet1/0/1", "TenGigabitEthernet1/0/25", "Ethernet1/1"
    if (/^(gigabit|tengigabit|fastethernet|ethernet|vlan)/i.test(ifName)) return ifName

    // SG350X-24: 10G uplinks come back as "te*" or "xg*" â€” use as-is;
    // copper ports come back as bare numbers â†’ prefix "gi1/0/"
    if (/^sg350x/.test(m)) {
      if (/^te|^xg/i.test(p)) return ifName
      return `gi1/0/${ifName}`
    }

    // SF350X-24: gigabit ports already prefixed "gi*"/"ge*" â€” use as-is;
    // fast ethernet ports come as bare numbers â†’ prefix "fa"
    if (/^sf350x/.test(m)) {
      if (/^gi|^ge/i.test(p)) return ifName
      return `fa${ifName}`
    }

    // SG500-28, SG500-52, SG300-52: ports exposed as bare numbers â†’ "gi1/<n>"
    if (/^sg5\d\d_?(28|52)|^sg3\d\d_?(52)/.test(m) || /^sg500|^sg300/.test(m)) {
      if (/^\d+$/.test(ifName)) return `gi1/${ifName}`
      return ifName
    }

    // CBS350, CBS250, SG350, SG250, SG220 and all other Cisco SMB:
    // bare number â†’ "gi<n>"; already prefixed â†’ pass through
    if (/^\d+$/.test(ifName)) return `gi${ifName}`

    return ifName
  }

  function buildPortCliScript(
    vendor: string, osType: string,
    ports: Array<{ ifName: string }>,
    action: string, params: Record<string, unknown>,
    sysDescr = '', model = '',
  ): string {
    const v  = vendor.toLowerCase()
    const md = model.toLowerCase()
    const sd = sysDescr.toLowerCase()

    // â”€â”€ Vendor detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const isMikro    = v.includes('mikrotik') || v.includes('routeros') || sd.includes('routeros')
    const isJuniper  = v.includes('juniper') || sd.includes('junos')
    const isFortinet = v.includes('fortinet') || v.includes('fortigate') || sd.includes('fortigate')
    const isHP       = v.includes('hp') || v.includes('aruba') || v.includes('hewlett') || sd.includes('procurve') || sd.includes('aruba')
    const isCisco    = !isMikro && !isJuniper && !isFortinet && !isHP &&
                       (v.includes('cisco') || ['switch','switch-l3','router','firewall'].includes(osType))

    const ciscoVariant = isCisco ? detectCiscoVariant(vendor, model, sysDescr) : null

    // Helper: allowed VLANs string (comma-separated list or 'all')
    const allowedVlans  = (params.allowedVlans as string | undefined)?.trim() || 'all'
    const nativeVlan    = (params.nativeVlan  as string | undefined)?.trim() || '1'
    const accessVlan    = (params.accessVlan  as string | undefined)?.trim() || '1'
    const toTrunk       = action === 'mode' && params.mode === 'trunk'
    const toAccess      = action === 'mode' && params.mode === 'access'
    const portIsTrunk   = params.currentMode === 'trunk'

    // â”€â”€ MikroTik RouterOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (isMikro) {
      return ports.map(p => {
        const iface = p.ifName
        if (action === 'description') return `/interface ethernet set [find name="${iface}"] comment="${params.description}"`
        if (action === 'admin')       return `/interface ethernet ${params.enabled ? 'enable' : 'disable'} [find name="${iface}"]`
        if (action === 'vlan') {
          // Untagged (access) VLAN = pvid on bridge port; tagged = add to bridge vlan table
          if (params.vlanMode === 'tagged') {
            return [
              `/interface bridge vlan add bridge=bridge vlan-ids=${params.vlan} tagged=${iface}`,
            ].join('\n')
          }
          return `/interface bridge port set [find interface="${iface}"] pvid=${params.vlan}`
        }
        if (action === 'mode') {
          if (params.mode === 'trunk') {
            // Trunk: set frame-types to admit-all and frame-types tagged-only on bridge port
            return [
              `/interface bridge port set [find interface="${iface}"] frame-types=admit-all`,
              `/interface bridge vlan add bridge=bridge vlan-ids=${allowedVlans} tagged=${iface}`,
            ].join('\n')
          }
          // Access: admit only untagged, set pvid
          return [
            `/interface bridge port set [find interface="${iface}"] frame-types=admit-only-untagged-and-priority-tagged pvid=${accessVlan}`,
          ].join('\n')
        }
        if (action === 'portfast') return `# STP edge not applicable in RouterOS (uses RSTP by default)`
        return `# unknown action: ${action}`
      }).join('\n')
    }

    // â”€â”€ Juniper JunOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (isJuniper) {
      const lines: string[] = ['configure']
      for (const p of ports) {
        const iface = p.ifName
        if (action === 'description') {
          lines.push(`set interfaces ${iface} description "${params.description}"`)
        }
        if (action === 'admin') {
          lines.push(params.enabled
            ? `delete interfaces ${iface} disable`
            : `set interfaces ${iface} disable`)
        }
        if (action === 'vlan') {
          lines.push(`set interfaces ${iface} unit 0 family ethernet-switching vlan members ${params.vlan}`)
        }
        if (action === 'mode') {
          if (toAccess) {
            // Remove all vlan members first, then set access mode
            lines.push(`delete interfaces ${iface} unit 0 family ethernet-switching vlan members`)
            lines.push(`set interfaces ${iface} unit 0 family ethernet-switching interface-mode access`)
            lines.push(`set interfaces ${iface} unit 0 family ethernet-switching vlan members ${accessVlan}`)
          } else {
            // Trunk: clear existing members, set trunk, add allowed vlans
            lines.push(`delete interfaces ${iface} unit 0 family ethernet-switching vlan members`)
            lines.push(`set interfaces ${iface} unit 0 family ethernet-switching interface-mode trunk`)
            if (allowedVlans !== 'all') {
              for (const vl of allowedVlans.split(',')) {
                lines.push(`set interfaces ${iface} unit 0 family ethernet-switching vlan members ${vl.trim()}`)
              }
            }
          }
        }
        if (action === 'portfast') {
          // Juniper uses RSTP edge port concept
          lines.push(params.enabled
            ? `set protocols rstp interface ${iface} edge`
            : `delete protocols rstp interface ${iface} edge`)
        }
      }
      lines.push('commit and-quit')
      return lines.join('\n')
    }

    // â”€â”€ Fortinet FortiOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (isFortinet) {
      return ports.map(p => {
        const lines: string[] = []
        if (action === 'mode') {
          // FortiGate: hardware-switch member ports use 'config system switch-interface'
          // For standalone physical ports, mode is set via 'set mode'
          lines.push('config system interface', `edit ${p.ifName}`)
          lines.push(`set mode ${params.mode === 'trunk' ? 'trunk' : 'access'}`)
          if (toTrunk && allowedVlans !== 'all') {
            lines.push(`set allowed-vlans ${allowedVlans}`)
          }
          if (toAccess) lines.push(`set native-vlan-id ${accessVlan}`)
          lines.push('next', 'end')
        } else if (action === 'description') {
          lines.push('config system interface', `edit ${p.ifName}`, `set description "${params.description}"`, 'next', 'end')
        } else if (action === 'vlan') {
          lines.push('config system interface', `edit ${p.ifName}`, `set vlanid ${params.vlan}`, 'next', 'end')
        } else if (action === 'admin') {
          lines.push('config system interface', `edit ${p.ifName}`, `set status ${params.enabled ? 'up' : 'down'}`, 'next', 'end')
        } else if (action === 'portfast') {
          lines.push(`# portfast (STP edge) not configurable per-port on FortiGate via CLI`)
        }
        return lines.join('\n')
      }).join('\n')
    }

    // â”€â”€ HP / Aruba ProCurve / ArubaOS-Switch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (isHP) {
      const lines: string[] = []
      for (const p of ports) {
        const iface = p.ifName
        if (action === 'description') {
          lines.push(`interface ${iface}`, ` name "${params.description}"`, 'exit')
        }
        if (action === 'admin') {
          lines.push(`interface ${iface}`, params.enabled ? ' enable' : ' disable', 'exit')
        }
        if (action === 'vlan') {
          if (params.vlanMode === 'tagged') {
            lines.push(`vlan ${params.vlan}`, ` tagged ${iface}`, 'exit')
          } else {
            lines.push(`vlan ${params.vlan}`, ` untagged ${iface}`, 'exit')
          }
        }
        if (action === 'mode') {
          if (toAccess) {
            // Remove tagged memberships, set untagged on access vlan
            lines.push(`no vlan 1-4094 tagged ${iface}`)
            lines.push(`vlan ${accessVlan}`, ` untagged ${iface}`, 'exit')
          } else {
            // Trunk: remove from untagged, add tagged vlans
            lines.push(`no vlan 1-4094 untagged ${iface}`)
            if (allowedVlans !== 'all') {
              for (const vl of allowedVlans.split(',')) {
                lines.push(`vlan ${vl.trim()}`, ` tagged ${iface}`, 'exit')
              }
            }
            lines.push(`vlan ${nativeVlan}`, ` untagged ${iface}`, 'exit')
          }
        }
        if (action === 'portfast') {
          lines.push(`spanning-tree ${iface} ${params.enabled ? 'admin-edge-port' : 'no admin-edge-port'}`)
        }
      }
      lines.push('write memory')
      return lines.join('\n')
    }

    // â”€â”€ Cisco IOS-XR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (ciscoVariant === 'xr') {
      const lines: string[] = []
      for (const p of ports) {
        const iface = p.ifName
        lines.push(`interface ${iface}`)
        if (action === 'description') lines.push(` description ${params.description}`)
        if (action === 'admin')       lines.push(params.enabled ? ' no shutdown' : ' shutdown')
        if (action === 'mode' || action === 'vlan') {
          // IOS-XR uses l2transport + encapsulation for L2 ports
          lines.push(` l2transport`)
          if (action === 'vlan') lines.push(` encapsulation dot1q ${params.vlan}`)
          lines.push(` !`)
        }
        if (action === 'portfast') lines.push(` # portfast/edge not configurable on IOS-XR l2transport interfaces`)
        lines.push('!')
      }
      lines.push('commit', 'end')
      return lines.join('\n')
    }

    // â”€â”€ Cisco NX-OS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (ciscoVariant === 'nxos') {
      const lines: string[] = ['configure terminal']
      for (const p of ports) {
        const iface = normalizeCiscoIface(p.ifName, model)
        lines.push(`interface ${iface}`)
        if (action === 'description') lines.push(` description ${params.description}`)
        if (action === 'admin')       lines.push(params.enabled ? ' no shutdown' : ' shutdown')
        if (action === 'mode') {
          if (toAccess) {
            lines.push(` no switchport trunk allowed vlan`)
            lines.push(` no switchport trunk native vlan`)
            lines.push(` switchport mode access`)
            lines.push(` switchport access vlan ${accessVlan}`)
            // NX-OS portfast equivalent
            lines.push(` spanning-tree port type edge`)
          } else {
            lines.push(` no switchport port-security`)
            lines.push(` switchport mode trunk`)
            lines.push(` switchport trunk native vlan ${nativeVlan}`)
            lines.push(` switchport trunk allowed vlan ${allowedVlans}`)
            if (portIsTrunk) lines.push(` spanning-tree port type normal`)
          }
        }
        if (action === 'vlan') {
          if (params.vlanMode === 'tagged') lines.push(` switchport trunk allowed vlan add ${params.vlan}`)
          else                              lines.push(` switchport access vlan ${params.vlan}`)
        }
        if (action === 'portfast') {
          // NX-OS uses 'spanning-tree port type edge' instead of portfast
          lines.push(params.enabled ? ` spanning-tree port type edge` : ` spanning-tree port type normal`)
        }
      }
      lines.push('end', 'copy running-config startup-config')
      return lines.join('\n')
    }

    // â”€â”€ Cisco Small Business (SG/CBS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (ciscoVariant === 'sb') {
      const lines: string[] = []
      for (const p of ports) {
        const iface = p.ifName
        lines.push(`interface ${iface}`)
        if (action === 'description') lines.push(` description ${params.description}`)
        if (action === 'admin')       lines.push(params.enabled ? ' no shutdown' : ' shutdown')
        if (action === 'mode') {
          if (toAccess) {
            lines.push(` switchport mode access`)
            lines.push(` switchport access vlan ${accessVlan}`)
          } else {
            lines.push(` switchport mode trunk`)
            lines.push(` switchport trunk native vlan ${nativeVlan}`)
            if (allowedVlans !== 'all') lines.push(` switchport trunk allowed vlan add ${allowedVlans}`)
          }
        }
        if (action === 'vlan') {
          if (params.vlanMode === 'tagged') lines.push(` switchport trunk allowed vlan add ${params.vlan}`)
          else                              lines.push(` switchport access vlan ${params.vlan}`)
        }
        if (action === 'portfast') lines.push(params.enabled ? ` spanning-tree portfast` : ` no spanning-tree portfast`)
        lines.push('exit')
      }
      lines.push('end', 'write memory')
      return lines.join('\n')
    }

    // â”€â”€ Cisco IOS / IOS-XE (default) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lines: string[] = ['conf t']
    for (const p of ports) {
      const iface = normalizeCiscoIface(p.ifName, model)
      lines.push(`interface ${iface}`)
      if (action === 'description') lines.push(` description ${params.description}`)
      if (action === 'admin')       lines.push(params.enabled ? ` no shutdown` : ` shutdown`)
      if (action === 'mode') {
        if (toAccess) {
          // Trunk â†’ Access: remove tagged VLANs first (required by some IOS versions)
          lines.push(` switchport trunk allowed vlan none`)
          lines.push(` no switchport trunk native vlan`)
          lines.push(` no switchport port-security`)
          lines.push(` no switchport port-security maximum`)
          lines.push(` no switchport port-security violation`)
          lines.push(` switchport mode access`)
          lines.push(` switchport access vlan ${accessVlan}`)
          lines.push(` spanning-tree portfast`)
        } else {
          // Access â†’ Trunk: remove port-security + portfast, then set trunk
          lines.push(` no switchport port-security`)
          lines.push(` no switchport port-security maximum`)
          lines.push(` no switchport port-security violation`)
          lines.push(` no spanning-tree portfast`)
          lines.push(` switchport mode trunk`)
          lines.push(` switchport trunk native vlan ${nativeVlan}`)
          lines.push(` switchport trunk allowed vlan ${allowedVlans}`)
          lines.push(` switchport nonegotiate`)
        }
      }
      if (action === 'vlan') {
        if (params.vlanMode === 'tagged') lines.push(` switchport trunk allowed vlan add ${params.vlan}`)
        else                              lines.push(` switchport access vlan ${params.vlan}`)
      }
      if (action === 'portfast') {
        // Use 'portfast trunk' when port is trunk to avoid IOS warning
        const pfSuffix = portIsTrunk ? ' trunk' : ''
        lines.push(params.enabled ? ` spanning-tree portfast${pfSuffix}` : ` no spanning-tree portfast`)
      }
    }
    lines.push('end', 'wr')
    return lines.join('\n')
  }

  // POST /servers/:id/port-cli â€” vendor-aware SSH CLI port configuration
  fastify.post('/servers/:id/port-cli', {
    preHandler: [requireAdmin, requireTotpElevation('network_port_config')],
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { ports, action, params } = z.object({
      ports: z.array(z.object({ ifIndex: z.number().int().min(1), ifName: z.string().min(1) })).min(1),
      action: z.enum(['description', 'vlan', 'mode', 'portfast', 'admin']),
      params: z.record(z.unknown()).default({}),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.access_ssh_enabled) return reply.code(400).send({ error: 'SSH not enabled on this device' })

    const vaultKey = getVaultKey()
    const vendor   = server.snmp_vendor ?? ''
    const osType   = server.os_type ?? ''
    const model    = server.snmp_model ?? ''
    const lastData = (server as any).snmp_last_data
    const sysDescr = (typeof lastData === 'string' ? JSON.parse(lastData) : lastData)?.sysDescr ?? ''

    const script = buildPortCliScript(vendor, osType, ports, action, params as Record<string, unknown>, sysDescr, model)

    try {
      const client = await connectSsh(server, id, vaultKey)
      const output = await runSshShell(client, script)

      await writeAuditLog({
        userId: (req.session.user as any)?.id,
        userEmail: (req.session.user as any)?.email,
        action: `network.port_${action}`,
        resource: 'server', resourceId: id,
        details: { ports: ports.map(p => p.ifName), action, params },
        request: req,
      })

      return { ok: true, script, output: output.slice(0, 1000) }
    } catch (err: any) {
      return reply.code(400).send({ error: `CLI failed: ${err.message ?? err}` })
    }
  })

  // POST /servers/:id/reboot â€” send reboot command via SSH
  fastify.post('/servers/:id/reboot', {
    preHandler: [requireAdmin, requireTotpElevation('network_device_reboot')],
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.access_ssh_enabled) return reply.code(400).send({ error: 'SSH not enabled for this device' })

    const vaultKey = getVaultKey()

    const vendor = (server.snmp_vendor ?? '').toLowerCase()
    const osType = (server.os_type ?? '').toLowerCase()
    let rebootCmd: string
    if      (vendor.includes('cisco'))                                    rebootCmd = 'reload\nyes\n'
    else if (vendor.includes('mikrotik') || vendor.includes('routeros')) rebootCmd = '/system reboot\ny\n'
    else if (vendor.includes('fortinet') || vendor.includes('fortigate'))rebootCmd = 'execute reboot\ny\n'
    else if (vendor.includes('juniper'))                                  rebootCmd = 'request system reboot'
    else if (vendor.includes('aruba') || vendor.includes('hpe'))         rebootCmd = 'reload\nyes\n'
    else if (vendor.includes('ubiquiti'))                                 rebootCmd = 'reboot'
    else if (osType === 'router' || osType === 'switch' || osType === 'switch-l3' || osType === 'firewall') rebootCmd = 'reload\nyes\n'
    else                                                                  rebootCmd = 'reboot'

    try {
      const client = await connectSsh(server, id, vaultKey)
      const output = await new Promise<string>((resolve) => {
        client.exec(rebootCmd, (err: any, stream: any) => {
          if (err) { client.end(); resolve('') ; return }
          const chunks: Buffer[] = []
          stream.on('data', (d: Buffer) => chunks.push(d))
          stream.stderr.on('data', (d: Buffer) => chunks.push(d))
          stream.on('close', () => { client.end(); resolve(Buffer.concat(chunks).toString('utf8').trim()) })
        })
      })

      await writeAuditLog({
        userId: (req.session.user as any)?.id,
        userEmail: (req.session.user as any)?.email,
        action: 'network.device_rebooted',
        resource: 'server', resourceId: id,
        details: { command: rebootCmd.replace(/\n/g, '\\n') },
        request: req,
      })

      return { ok: true, command: rebootCmd.split('\n')[0], output: output.slice(0, 500) }
    } catch (err: any) {
      return reply.code(400).send({ error: `Reboot failed: ${err.message ?? err}` })
    }
  })
}


