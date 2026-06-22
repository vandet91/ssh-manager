import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'
import { type AiProvider } from '../../utils/ai-analyst'
import { requireTotpElevation } from '../../utils/totp-guard'
import { Client } from 'ssh2'

// ── Zod schemas ───────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function maybeEncrypt(value: string | undefined | null, key: Buffer): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return encryptSecret(value, key)
}

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function networkProfileRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /servers/:id/network-profile
  fastify.get('/servers/:id/network-profile', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
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
  fastify.put('/servers/:id/network-profile', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
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
          label: `SSH – ${body.ssh_username}`,
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

  // POST /servers/:id/snmp-fetch  — enhanced: profile fallback + Entity MIB enrichment
  fastify.post('/servers/:id/snmp-fetch', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
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

      // Fetch MAC separately (often times out on some devices — best effort)
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

      // Convert sysUpTime ticks → human-readable
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

  // POST /servers/:id/firmware-check — AI-powered firmware analysis
  fastify.post('/servers/:id/firmware-check', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
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

    if (!apiKey) return reply.code(400).send({ error: `No API key configured for ${provider}. Add it in Settings → AI Providers.` })

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

  // POST /servers/:id/snmp-ports — walk IF-MIB + Q-BRIDGE-MIB, store in snmp_interfaces
  fastify.post('/servers/:id/snmp-ports', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
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

      // Walk a subtree, returning map of index → value
      // isMac=true: treat 6-byte buffers as colon-separated MAC (only for ifPhysAddress)
      const walkTable = (baseOid: string, isMac = false): Promise<Map<number, string>> =>
        new Promise((resolve) => {
          const result = new Map<number, string>()
          sess.subtree(baseOid, 20, (varbinds: any[]) => {
            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue
              const oidParts = vb.oid.split('.')
              const idx = parseInt(oidParts[oidParts.length - 1], 10)
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
          }, (err: any) => {
            if (err) {} // best-effort
            resolve(result)
          })
        })

      // IF-MIB OIDs (standard, all devices)
      const [ifDescr, ifSpeed, ifPhysAddr, ifAdminStatus, ifOperStatus, ifName, ifHighSpeed, ifAlias] =
        await Promise.all([
          walkTable('1.3.6.1.2.1.2.2.1.2'),        // ifDescr
          walkTable('1.3.6.1.2.1.2.2.1.5'),        // ifSpeed (bps)
          walkTable('1.3.6.1.2.1.2.2.1.6', true),  // ifPhysAddress — 6-byte MAC
          walkTable('1.3.6.1.2.1.2.2.1.7'),        // ifAdminStatus (1=up,2=down)
          walkTable('1.3.6.1.2.1.2.2.1.8'),        // ifOperStatus (1=up,2=down)
          walkTable('1.3.6.1.2.1.31.1.1.1.1'),     // ifName (IF-MIB extension)
          walkTable('1.3.6.1.2.1.31.1.1.1.15'),    // ifHighSpeed (Mbps)
          walkTable('1.3.6.1.2.1.31.1.1.1.18'),    // ifAlias
        ])

      // Q-BRIDGE-MIB: port VLAN (PVID) — best effort
      const dot1qPvid = await walkTable('1.3.6.1.2.1.17.7.1.4.5.1.1').catch(() => new Map<number, string>())

      // Collect all interface indexes
      const allIndexes = new Set<number>([
        ...ifDescr.keys(), ...ifName.keys(), ...ifOperStatus.keys(),
      ])

      const ports = Array.from(allIndexes)
        .map(idx => {
          const adminRaw = ifAdminStatus.get(idx)
          const operRaw  = ifOperStatus.get(idx)
          const adminUp  = adminRaw === '1' || adminRaw === 'up'
          const operUp   = operRaw  === '1' || operRaw  === 'up'
          const speedBps = parseInt(ifSpeed.get(idx) ?? '0', 10)
          const speedMbps = parseInt(ifHighSpeed.get(idx) ?? '0', 10) || (speedBps > 0 ? Math.round(speedBps / 1_000_000) : 0)
          return {
            index:       idx,
            name:        ifName.get(idx) ?? ifDescr.get(idx) ?? `if${idx}`,
            descr:       ifDescr.get(idx) ?? '',
            alias:       ifAlias.get(idx) ?? '',
            mac:         ifPhysAddr.get(idx) ?? '',
            admin_up:    adminUp,
            oper_up:     operUp,
            speed_mbps:  speedMbps,
            pvid:        dot1qPvid.has(idx) ? parseInt(dot1qPvid.get(idx)!, 10) || null : null,
          }
        })
        // Filter out loopback and irrelevant types (typically index 1 is lo on Linux routers)
        .filter(p => p.name !== 'lo' && !p.name.startsWith('Loopback'))
        .sort((a, b) => a.index - b.index)

      sess.close()

      const now = new Date()
      await db.updateTable('servers').set({
        snmp_interfaces: JSON.stringify(ports),
        snmp_last_fetched_at: now,
        updated_at: now,
      } as any).where('id', '=', id).execute()

      return { ok: true, fetched_at: now.toISOString(), ports }
    } catch (err: any) {
      return reply.code(400).send({ error: `SNMP port walk failed: ${err.message ?? err}` })
    }
  })

  // POST /servers/:id/snmp-port-admin — enable/disable a port via SNMP SET ifAdminStatus
  fastify.post('/servers/:id/snmp-port-admin', {
    preHandler: [requirePermission('servers:write'), requireTotpElevation('network_port_shutdown')],
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

  // ── Shared SSH helpers ────────────────────────────────────────────────────────

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

  function buildPortCliScript(
    vendor: string, osType: string,
    ports: Array<{ ifName: string }>,
    action: string, params: Record<string, unknown>,
  ): string {
    const v = vendor.toLowerCase()
    const isCisco   = v.includes('cisco') || ['switch','switch-l3','router','firewall'].includes(osType)
    const isMikro   = v.includes('mikrotik') || v.includes('routeros') || osType === 'router' && v.includes('mikro')
    const isJuniper = v.includes('juniper')
    const isFortinet = v.includes('fortinet') || v.includes('fortigate')

    if (isMikro) {
      return ports.map(p => {
        const iface = p.ifName
        if (action === 'description') return `/interface ethernet set [find name="${iface}"] comment="${params.description}"`
        if (action === 'vlan')        return `/interface bridge port set [find interface="${iface}"] pvid=${params.vlan}`
        if (action === 'mode')        return `# mode not directly applicable in RouterOS`
        if (action === 'portfast')    return `# portfast not applicable in RouterOS`
        if (action === 'admin')       return `/interface ethernet ${params.enabled ? 'enable' : 'disable'} [find name="${iface}"]`
        return `# unknown action: ${action}`
      }).join('\n')
    }

    if (isJuniper) {
      const lines: string[] = ['configure']
      for (const p of ports) {
        const iface = p.ifName
        if (action === 'description') lines.push(`set interfaces ${iface} description "${params.description}"`)
        if (action === 'vlan')        lines.push(`set interfaces ${iface} unit 0 family ethernet-switching vlan members ${params.vlan}`)
        if (action === 'mode')        lines.push(`set interfaces ${iface} unit 0 family ethernet-switching interface-mode ${params.mode}`)
        if (action === 'admin')       lines.push(params.enabled ? `delete interfaces ${iface} disable` : `set interfaces ${iface} disable`)
      }
      lines.push('commit and-quit')
      return lines.join('\n')
    }

    if (isFortinet) {
      return ports.map(p => {
        const lines: string[] = ['config system interface', `edit ${p.ifName}`]
        if (action === 'description') lines.push(`set description "${params.description}"`)
        if (action === 'vlan')        lines.push(`set vlanid ${params.vlan}`)
        if (action === 'admin')       lines.push(`set status ${params.enabled ? 'up' : 'down'}`)
        lines.push('next', 'end')
        return lines.join('\n')
      }).join('\n')
    }

    // Default: Cisco IOS / IOS-XE / IOS-XR compatible
    const lines: string[] = ['conf t']
    for (const p of ports) {
      lines.push(`interface ${p.ifName}`)
      if (action === 'description') lines.push(` description ${params.description}`)
      if (action === 'mode')        lines.push(` switchport mode ${params.mode}`)
      if (action === 'vlan') {
        if (params.mode === 'trunk') lines.push(` switchport trunk allowed vlan add ${params.vlan}`)
        else                         lines.push(` switchport access vlan ${params.vlan}`)
      }
      if (action === 'portfast')    lines.push(params.enabled ? ` spanning-tree portfast` : ` no spanning-tree portfast`)
      if (action === 'admin')       lines.push(params.enabled ? ` no shutdown` : ` shutdown`)
    }
    lines.push('end', 'wr')
    return lines.join('\n')
  }

  // POST /servers/:id/port-cli — vendor-aware SSH CLI port configuration
  fastify.post('/servers/:id/port-cli', {
    preHandler: [requirePermission('servers:write'), requireTotpElevation('network_port_config')],
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
    const vendor = server.snmp_vendor ?? ''
    const osType = server.os_type ?? ''

    const script = buildPortCliScript(vendor, osType, ports, action, params as Record<string, unknown>)

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

  // POST /servers/:id/reboot — send reboot command via SSH
  fastify.post('/servers/:id/reboot', {
    preHandler: [requirePermission('servers:write'), requireTotpElevation('network_device_reboot')],
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

