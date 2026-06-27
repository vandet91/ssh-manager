import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requireAdmin } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'
import { getRemoteHostFingerprint, withSsh, connectSsh, connectWithFallback } from '../../utils/ssh'
import { withServerSsh } from '../../utils/server-ssh'
import { decryptSecret, encryptSecret, getVaultKey } from '../../utils/vault'
import { generateKeyPair } from '../../utils/keygen'
import { callAiProvider, type AiProvider, type AnalysisType } from '../../utils/ai-analyst'

const ServerBody = z.object({
  name: z.string().min(1).max(100),
  hostname: z.string().min(1),
  ssh_port: z.number().int().min(1).max(65535).default(22),
  environment: z.enum(['production', 'staging', 'development', 'other', 'office', 'branch', 'datacenter', 'home', 'warehouse']),
  tags: z.record(z.string()).optional().default({}),
  management_key_id: z.string().uuid().optional(),
  management_linux_user: z.string().min(1).optional(),
  os_type: z.enum([
    'linux', 'windows',
    'router', 'switch', 'switch-l3', 'access-point', 'wireless-controller',
    'firewall', 'utm', 'ids-ips', 'waf',
    'load-balancer', 'proxy', 'wan-optimizer',
    'vpn-gateway', 'vpn-concentrator',
    'patch-panel', 'media-converter', 'sfp-module',
    'ip-pbx', 'voip-gateway',
    'dvr', 'nvr', 'ip-camera',
    'ups', 'pdu', 'kvm-switch', 'console-server',
    'other-network',
  ]).optional(),
  device_category: z.enum(['server', 'network']).optional(),
  is_domain_controller: z.boolean().optional(),
  distro: z.string().optional(),
})

async function serversRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /servers
  fastify.get('/servers', async (req) => {
    const query = z.object({
      environment: z.string().optional(),
      device_category: z.enum(['server', 'network']).optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(200),
    }).parse(req.query)

    let qb = (db as any).selectFrom('servers').selectAll('servers').where('servers.is_active', '=', true).orderBy('servers.name', 'asc')

    if (query.environment) qb = qb.where('servers.environment', '=', query.environment)
    if (query.device_category === 'server') {
      qb = qb.where('servers.os_type', 'in', ['linux', 'windows'])
    } else if (query.device_category === 'network') {
      qb = qb.where('servers.os_type', 'in', [
        'router', 'switch', 'switch-l3', 'access-point', 'wireless-controller',
        'firewall', 'utm', 'ids-ips', 'waf',
        'load-balancer', 'proxy', 'wan-optimizer',
        'vpn-gateway', 'vpn-concentrator',
        'patch-panel', 'media-converter', 'sfp-module',
        'ip-pbx', 'voip-gateway',
        'dvr', 'nvr', 'ip-camera',
        'ups', 'pdu', 'kvm-switch', 'console-server',
        'other-network',
      ])
    }
    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // POST /servers
  fastify.post('/servers', { preHandler: requireAdmin }, async (req, reply) => {
    const body = ServerBody.parse(req.body)

    let server
    try {
      server = await db.insertInto('servers').values({
        ...body,
        tags: JSON.stringify(body.tags),
        added_by: req.session.user!.id,
      }).returningAll().executeTakeFirst()
    } catch (err: unknown) {
      const e = err as { code?: string; constraint?: string }
      if (e.code === '23505') return reply.code(409).send({ error: 'A server with that name already exists' })
      throw err
    }

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.created', resource: 'server', resourceId: server!.id, request: req,
    })
    return reply.code(201).send(server)
  })

  // GET /servers/:id
  fastify.get('/servers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const lastScan = await db.selectFrom('security_scans')
      .selectAll().where('server_id', '=', id)
      .orderBy('scanned_at', 'desc').limit(1).executeTakeFirst()

    return { ...server, last_scan: lastScan ?? null }
  })

  // PATCH /servers/:id
  fastify.patch('/servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = ServerBody.partial().parse(req.body)

    const server = await db.updateTable('servers')
      .set({ ...body, tags: body.tags ? JSON.stringify(body.tags) : undefined, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll().executeTakeFirst()

    if (!server) return reply.code(404).send({ error: 'Server not found' })
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'server.updated', resource: 'server', resourceId: id, request: req })
    return server
  })

  // DELETE /servers/:id
  fastify.delete('/servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await db.updateTable('servers').set({ is_active: false, updated_at: new Date() }).where('id', '=', id).execute()
    // Deactivate all key assignments for this server so keys are not blocked from deletion
    await db.updateTable('key_assignments').set({ is_active: false }).where('server_id', '=', id).execute()
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'server.deleted', resource: 'server', resourceId: id, request: req })
    reply.code(204).send()
  })

  // POST /servers/:id/verify-host-key
  fastify.post('/servers/:id/verify-host-key', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const incoming = await getRemoteHostFingerprint(server.hostname, server.ssh_port)

    if (server.host_key_fingerprint && server.host_key_verified) {
      if (incoming !== server.host_key_fingerprint) {
        await writeAuditLog({
          userId: req.session.user!.id, userEmail: req.session.user!.email,
          action: 'server.host_key_mismatch', resource: 'server', resourceId: id,
          details: { expected: server.host_key_fingerprint, incoming },
          request: req,
        })
        return reply.code(409).send({ error: 'Host key fingerprint mismatch — possible MITM attack', expected: server.host_key_fingerprint, incoming })
      }
    }

    await db.updateTable('servers').set({
      host_key_fingerprint: incoming,
      host_key_verified: true,
      host_key_last_seen: new Date(),
      updated_at: new Date(),
    }).where('id', '=', id).execute()

    return { fingerprint: incoming }
  })

  // POST /servers/:id/reset-host-key — force re-learn host key (use when key changed legitimately)
  fastify.post('/servers/:id/reset-host-key', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const incoming = await getRemoteHostFingerprint(server.hostname, server.ssh_port)

    await db.updateTable('servers').set({
      host_key_fingerprint: incoming,
      host_key_verified: true,
      host_key_last_seen: new Date(),
      updated_at: new Date(),
    }).where('id', '=', id).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.host_key_reset', resource: 'server', resourceId: id,
      details: { old_fingerprint: server.host_key_fingerprint, new_fingerprint: incoming },
      request: req,
    })

    return { fingerprint: incoming }
  })

  // POST /servers/:id/test-connection
  fastify.post('/servers/:id/test-connection', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'No management key set' })

    try {
      let usedKey = { keyId: '', keyName: '', isFallback: false }
      await withServerSsh(id, async () => { /* just test the connection */ }, (info) => { usedKey = info })
      await db.updateTable('servers').set({ last_connected_at: new Date(), updated_at: new Date() }).where('id', '=', id).execute()
      return { ok: true, key_id: usedKey.keyId, key_name: usedKey.keyName, is_fallback: usedKey.isFallback }
    } catch (err: unknown) {
      return reply.code(400).send({ error: 'Connection failed', details: (err as Error).message })
    }
  })

  // POST /servers/:id/setup — connect via password, auto-generate & deploy management key
  fastify.post('/servers/:id/setup', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      linux_user: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    // Step 1: generate management key pair
    const { pemPrivate, authorizedKeysLine, fingerprint: keyFingerprint } = generateKeyPair('ed25519')
    const vaultKey = getVaultKey()

    // Step 2: connect with password auth and deploy the public key
    const { Client } = await import('ssh2')
    const { sshExec } = await import('../../utils/ssh')

    let hostFingerprint = ''

    try {
      await new Promise<void>((resolve, reject) => {
        const client = new Client()
        client
          .on('ready', async () => {
            try {
              // Detect Windows by checking for PowerShell/cmd
              const osCheck = await sshExec(client, 'echo %OS%')
              const isWindows = osCheck.stdout.trim().toLowerCase().includes('windows')

              if (isWindows) {
                // Windows OpenSSH: write key to a temp file via echo, then append with type, avoiding shell quoting issues
                // Write to both locations: ~/.ssh/authorized_keys (for non-admin users / custom sshd_config)
                // and C:\ProgramData\ssh\administrators_authorized_keys (default for Administrators group)
                const escapedKey = authorizedKeysLine.replace(/[&<>|^]/g, '^$&')
                // Location 1: user's .ssh directory
                await sshExec(client, `mkdir "%USERPROFILE%\\.ssh" 2>nul & echo ${escapedKey}>> "%USERPROFILE%\\.ssh\\authorized_keys"`)
                // Location 2: administrators_authorized_keys (required for Administrator/Administrators group)
                await sshExec(client, `echo ${escapedKey}>> "C:\\ProgramData\\ssh\\administrators_authorized_keys"`)
                // Fix permissions on administrators_authorized_keys (inherited ACLs break SSH key auth)
                await sshExec(client, `icacls "C:\\ProgramData\\ssh\\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`)
              } else {
                await sshExec(client, 'mkdir -p ~/.ssh && chmod 700 ~/.ssh')
                await sshExec(client, `echo ${JSON.stringify(authorizedKeysLine)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`)
              }
              client.end()
              resolve()
            } catch (e) { client.end(); reject(e) }
          })
          .on('error', reject)
          .connect({
            host: server.hostname,
            port: server.ssh_port,
            username: body.linux_user,
            password: body.password,
            readyTimeout: 15000,
            hostVerifier: (keyHash: Buffer | string) => {
              hostFingerprint = Buffer.isBuffer(keyHash) ? keyHash.toString('hex') : String(keyHash)
              return true
            },
          })
      })
    } catch (err: unknown) {
      return reply.code(400).send({ error: 'SSH connection failed', details: (err as Error).message })
    }

    // Step 3: save the management key in the vault
    const keyName = `mgmt-${server.name}`
    const [savedKey] = await db.insertInto('ssh_keys').values({
      name: keyName,
      description: `Auto-generated management key for ${server.name}`,
      key_type: 'ed25519',
      public_key: authorizedKeysLine,
      private_key_enc: encryptSecret(pemPrivate, vaultKey),
      fingerprint: keyFingerprint,
      rotation_policy: 'manual',
      created_by: req.session.user!.id,
    }).returningAll().execute()

    // Step 4: update server
    await db.updateTable('servers').set({
      management_key_id: savedKey.id,
      management_linux_user: body.linux_user,
      host_key_fingerprint: hostFingerprint,
      host_key_verified: true,
      host_key_last_seen: new Date(),
      last_connected_at: new Date(),
      updated_at: new Date(),
    }).where('id', '=', id).execute()

    // Step 5: create a key_assignment so the management user appears in the terminal
    // Deactivate any old management assignments for this user first, then insert fresh
    await db.updateTable('key_assignments')
      .set({ is_active: false })
      .where('server_id', '=', id)
      .where('linux_user', '=', body.linux_user)
      .execute()
    await db.insertInto('key_assignments').values({
      user_id: req.session.user!.id,
      key_id: savedKey.id,
      server_id: id,
      linux_user: body.linux_user,
      can_terminal: true,
      is_active: true,
    }).execute()

    // Step 6: save the password to the vault as a linux credential
    const vaultKey2 = getVaultKey()
    await db.insertInto('server_credentials').values({
      server_id: id,
      category: 'linux',
      linux_user: body.linux_user,
      service_name: null,
      service_username: null,
      label: `${body.linux_user} login password (initial setup)`,
      password_enc: encryptSecret(body.password, vaultKey2),
      notes: 'Saved automatically during initial SSH setup.',
      created_by: req.session.user!.id,
    }).execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.setup', resource: 'server', resourceId: id,
      details: { linux_user: body.linux_user, key_id: savedKey.id },
      request: req,
    })

    return { ok: true, management_key_id: savedKey.id, key_name: keyName }
  })

  // GET /servers/:id/assignments
  fastify.get('/servers/:id/assignments', { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return db.selectFrom('key_assignments').selectAll().where('server_id', '=', id).where('is_active', '=', true).execute()
  })

  // GET /servers/:id/info — SSH in and collect live system info
  fastify.get('/servers/:id/info', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server not configured' })

    try {
      let usedKeyInfo = { keyId: '', keyName: '', isFallback: false }
      const result = await withServerSsh(id, async (client) => {
          const { sshExec } = await import('../../utils/ssh')
          const { detectOsType, gatherWindowsInfo, getWindowsAuthorizedKeys } = await import('../../utils/windows-ssh')

          // ── Detect OS type first ───────────────────────────────────────────
          const { detectVirtLinux, detectVirtWindows } = await import('../../utils/virt-detect')
          const osType = await detectOsType(client, sshExec)

          if (osType === 'windows') {
            const [winInfo, winKeys, virtInfo] = await Promise.all([
              gatherWindowsInfo(client, sshExec, id),
              getWindowsAuthorizedKeys(client, sshExec),
              detectVirtWindows(client, sshExec),
            ])
            const sshpk = await import('sshpk')
            const dbKeys = await db.selectFrom('ssh_keys')
              .select(['id', 'name', 'fingerprint', 'public_key', 'is_active'])
              .execute()
            const authorizedKeys = winKeys.map(({ linux_user, line }) => {
              const parts = line.split(' ')
              const keyType = parts[0] || ''; const keyBody = parts[1] || ''; const comment = parts.slice(2).join(' ') || ''
              let fingerprint = ''
              try { fingerprint = sshpk.parseKey(line, 'ssh').fingerprint('sha256').toString() } catch { /* skip */ }
              const matched = dbKeys.find((k) => fingerprint ? k.fingerprint === fingerprint : k.public_key.includes(keyBody))
              return { linux_user, key_type: keyType, comment, fingerprint, key_body: keyBody, key_body_short: keyBody.slice(0, 32) + '…',
                db_key_id: matched?.id ?? null, db_key_name: matched?.name ?? null, is_known: !!matched, is_archived: matched ? !matched.is_active : false }
            })
            // Save OS type + host type + OS details to DB
            db.updateTable('servers').set({
              os_type: osType,
              host_type: virtInfo.host_type,
              host_type_detail: virtInfo.detail ?? undefined,
              os_name: winInfo.os?.name || 'Windows',
              os_pretty_name: winInfo.os?.pretty_name || winInfo.os?.name || 'Windows',
              os_version: winInfo.os?.version || '',
              os_id: 'windows',
              kernel_version: winInfo.os?.kernel || '',
              ...(server.distro ? {} : { distro: 'windows' }),
              last_seen_at: new Date(),
              updated_at: new Date(),
            }).where('id', '=', id).execute().catch(() => {})
            return { ...winInfo, management_key_id: server.management_key_id, authorized_keys: authorizedKeys, virt: virtInfo }
          }

          // ── Linux path ─────────────────────────────────────────────────────
          const [virtInfo, osRelease, unameR, passwdOut, whoOut, uptimeOut, memOut, authorizedKeysRoot] = await Promise.all([
            detectVirtLinux(client, sshExec),
            sshExec(client, 'cat /etc/os-release 2>/dev/null || echo ""'),
            sshExec(client, 'uname -r 2>/dev/null || echo ""'),
            sshExec(client, 'getent passwd 2>/dev/null | awk -F: \'$3==0||$3>=1000{print $1":"$3":"$5":"$6":"$7}\''),
            sshExec(client, 'who 2>/dev/null || echo ""'),
            sshExec(client, 'uptime -p 2>/dev/null || uptime 2>/dev/null || echo ""'),
            sshExec(client, 'free -h 2>/dev/null | grep Mem || echo ""'),
            sshExec(client, 'cat /root/.ssh/authorized_keys 2>/dev/null || sudo cat /root/.ssh/authorized_keys 2>/dev/null || echo ""'),
          ])

          // Parse /etc/os-release
          const osInfo: Record<string, string> = {}
          for (const line of osRelease.stdout.split('\n')) {
            const [k, v] = line.split('=')
            if (k && v) osInfo[k.trim()] = v.trim().replace(/^"|"$/g, '')
          }

          // Parse passwd
          const users = passwdOut.stdout.split('\n').filter(Boolean).map((line) => {
            const [username, uid, gecos, home, shell] = line.split(':')
            return { username, uid: Number(uid), gecos: gecos || '', home: home || '', shell: shell || '' }
          })

          // Collect raw authorized key lines per user
          const rawLines: Array<{ linux_user: string; line: string }> = []

          for (const line of authorizedKeysRoot.stdout.split('\n').filter(Boolean)) {
            if (line.startsWith('#')) continue
            rawLines.push({ linux_user: 'root', line: line.trim() })
          }

          // Try to read authorized_keys for non-root users
          for (const u of users.filter((u) => u.uid > 0 && u.home && u.home !== '/root')) {
            try {
              const akOut = await sshExec(client, `cat ${u.home}/.ssh/authorized_keys 2>/dev/null || sudo cat ${u.home}/.ssh/authorized_keys 2>/dev/null || echo ""`)
              for (const line of akOut.stdout.split('\n').filter(Boolean)) {
                if (line.startsWith('#')) continue
                rawLines.push({ linux_user: u.username, line: line.trim() })
              }
            } catch { /* skip */ }
          }

          // Compute fingerprint for each authorized key and cross-reference DB
          const sshpk = await import('sshpk')
          const dbKeys = await db.selectFrom('ssh_keys')
            .select(['id', 'name', 'fingerprint', 'public_key', 'is_active', 'archive_reason'])
            .execute()

          const authorizedKeys = rawLines.map(({ linux_user, line }) => {
            const parts = line.split(' ')
            const keyType = parts[0] || ''
            const keyBody = parts[1] || ''
            const comment = parts.slice(2).join(' ') || ''

            // Compute SHA-256 fingerprint of this key
            let fingerprint = ''
            try {
              const parsed = sshpk.parseKey(line, 'ssh')
              fingerprint = parsed.fingerprint('sha256').toString()
            } catch { /* malformed key */ }

            // Match against known DB keys
            const matched = dbKeys.find((k) =>
              fingerprint ? k.fingerprint === fingerprint : k.public_key.includes(keyBody),
            )

            return {
              linux_user,
              key_type: keyType,
              comment,
              fingerprint,
              key_body: keyBody,           // full base64 body — needed for revoke
              key_body_short: keyBody.slice(0, 32) + '…',
              // DB cross-reference
              db_key_id: matched?.id ?? null,
              db_key_name: matched?.name ?? null,
              is_known: !!matched,
              is_archived: matched ? !matched.is_active : false,
            }
          })

          const osName       = osInfo['NAME'] || osInfo['PRETTY_NAME'] || 'Unknown'
          const osPrettyName = osInfo['PRETTY_NAME'] || osName
          const osVersion    = osInfo['VERSION'] || osInfo['VERSION_ID'] || ''
          const osId         = (osInfo['ID'] || '').toLowerCase()
          const kernelVer    = unameR.stdout.trim()

          // Save OS type + host type + OS details to DB
          db.updateTable('servers').set({
            os_type: 'linux',
            host_type: virtInfo.host_type,
            host_type_detail: virtInfo.detail ?? undefined,
            os_name: osName,
            os_pretty_name: osPrettyName,
            os_version: osVersion,
            os_id: osId,
            kernel_version: kernelVer,
            // Auto-fill distro from os-release ID if not already set
            ...(server.distro ? {} : { distro: osId || undefined }),
            last_seen_at: new Date(),
            updated_at: new Date(),
          }).where('id', '=', id).execute().catch(() => {})

          return {
            os_type: 'linux' as const,
            management_key_id: server.management_key_id,
            os: {
              name: osName,
              pretty_name: osPrettyName,
              version: osVersion,
              id: osId,
              kernel: kernelVer,
            },
            uptime: uptimeOut.stdout,
            memory: memOut.stdout,
            users,
            logged_in: whoOut.stdout.split('\n').filter(Boolean),
            authorized_keys: authorizedKeys,
            virt: virtInfo,
          }
      }, (info) => { usedKeyInfo = info }, 5000)
      return { ...result, active_key_id: usedKeyInfo.keyId, active_key_name: usedKeyInfo.keyName, active_key_is_fallback: usedKeyInfo.isFallback }
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to gather server info', details: (err as Error).message })
    }
  })

  // DELETE /servers/:id/authorized-keys — remove a specific key from the server's authorized_keys
  fastify.delete('/servers/:id/authorized-keys', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      linux_user: z.string().min(1),
      key_body: z.string().min(1),   // full base64 key body
    }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server not configured' })

    // Refuse to remove the active management key — it would lock us out
    const mgmtKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', server.management_key_id).executeTakeFirst()
    if (mgmtKey) {
      // The management key's public_key is stored as an authorized_keys line: "<type> <body> <comment>"
      const mgmtKeyBody = mgmtKey.public_key.trim().split(' ')[1] ?? ''
      if (mgmtKeyBody && body.key_body === mgmtKeyBody) {
        return reply.code(403).send({ error: 'Cannot remove the active management key — it would lock out the system' })
      }
    }

    const homeDir = body.linux_user === 'root' ? '/root' : `/home/${body.linux_user}`

    try {
      await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')
        // Remove the line containing this exact key body from authorized_keys
        // Use grep -v to filter it out, then write back atomically
        await sshExec(
          client,
          `sudo grep -v '${body.key_body}' ${homeDir}/.ssh/authorized_keys | sudo tee ${homeDir}/.ssh/authorized_keys.new > /dev/null && sudo mv ${homeDir}/.ssh/authorized_keys.new ${homeDir}/.ssh/authorized_keys && sudo chmod 600 ${homeDir}/.ssh/authorized_keys && sudo chown ${body.linux_user}:${body.linux_user} ${homeDir}/.ssh/authorized_keys`,
        )
      })

      // Deactivate any matching assignments in the DB
      // Find ssh_keys whose public_key contains this key body
      const matchedKeys = await db.selectFrom('ssh_keys')
        .select(['id'])
        .where('public_key', 'like', `%${body.key_body}%`)
        .execute()

      if (matchedKeys.length > 0) {
        const matchedKeyIds = matchedKeys.map((k) => k.id)
        await db.updateTable('key_assignments')
          .set({ is_active: false })
          .where('server_id', '=', id)
          .where('linux_user', '=', body.linux_user)
          .where('key_id', 'in', matchedKeyIds)
          .execute()
      }

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.authorized_key_removed', resource: 'server', resourceId: id,
        details: { linux_user: body.linux_user, key_body_prefix: body.key_body.slice(0, 20) },
        request: req,
      })

      return { ok: true }
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to remove key from server', details: (err as Error).message })
    }
  })

  // ── Server User Management ────────────────────────────────────────────────

  // POST /servers/:id/users — create a linux user
  fastify.post('/servers/:id/users', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      username: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/, 'Invalid linux username'),
      comment: z.string().max(100).optional(),
      shell: z.string().optional().default('/bin/bash'),
      create_home: z.boolean().default(true),
      system_user: z.boolean().default(false),
      password: z.string().min(1).optional(),
      save_to_vault: z.boolean().default(true),
    }).parse(req.body)

    try {
      const result = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        const check = await sshExec(client, `id ${body.username} 2>/dev/null && echo EXISTS || echo MISSING`)
        if (check.stdout.includes('EXISTS')) throw Object.assign(new Error(`User "${body.username}" already exists`), { statusCode: 409 })

        const flags = [
          body.create_home && !body.system_user ? '-m' : '',
          body.system_user ? '--system' : '',
          body.comment ? `-c ${JSON.stringify(body.comment)}` : '',
          `-s ${body.shell}`,
        ].filter(Boolean).join(' ')

        const { code, stderr } = await sshExec(client, `sudo useradd ${flags} ${body.username}`)
        if (code !== 0) throw new Error(`useradd failed: ${stderr}`)

        if (body.password) {
          const escaped = body.password.replace(/'/g, "'\\''")
          const { code: pc, stderr: ps } = await sshExec(client, `echo '${body.username}:${escaped}' | sudo chpasswd`)
          if (pc !== 0) throw new Error(`chpasswd failed: ${ps}`)
        }

        return { username: body.username, created: true }
      })

      if (body.password && body.save_to_vault) {
        const vk = getVaultKey()
        await db.insertInto('server_credentials').values({
          server_id: id,
          category: 'linux',
          linux_user: body.username,
          service_name: null,
          service_username: null,
          label: `${body.username} login password`,
          password_enc: encryptSecret(body.password, vk),
          notes: null,
          created_by: req.session.user!.id,
        }).execute()
      }

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.user_created', resource: 'server', resourceId: id,
        details: { username: body.username, system_user: body.system_user, has_password: !!body.password }, request: req,
      })

      return reply.code(201).send(result)
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  // DELETE /servers/:id/users/:username — delete a linux user
  fastify.delete('/servers/:id/users/:username', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, username } = z.object({ id: z.string().uuid(), username: z.string().min(1) }).parse(req.params)
    const body = z.object({ remove_home: z.boolean().default(false) }).optional().parse(req.body)

    // Safety: never delete root or system users with uid < 1000
    const PROTECTED = ['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-resolve', 'sshd']
    if (PROTECTED.includes(username)) {
      return reply.code(403).send({ error: `Refusing to delete protected system user "${username}"` })
    }

    try {
      const result = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        // Get UID first — refuse to delete if uid < 1000 (system user)
        const uidOut = await sshExec(client, `id -u ${username} 2>/dev/null || echo MISSING`)
        if (uidOut.stdout === 'MISSING') throw Object.assign(new Error(`User "${username}" does not exist`), { statusCode: 404 })
        const uid = Number(uidOut.stdout.trim())
        if (uid > 0 && uid < 1000) {
          throw Object.assign(new Error(`Refusing to delete system user "${username}" (uid ${uid})`), { statusCode: 403 })
        }

        const flags = body?.remove_home ? '-r' : ''
        const { code, stderr } = await sshExec(client, `sudo userdel ${flags} ${username}`)
        if (code !== 0) throw new Error(`userdel failed: ${stderr}`)

        return { username, deleted: true, home_removed: !!body?.remove_home }
      })

      // Deactivate any assignments for this user on this server
      await db.updateTable('key_assignments').set({ is_active: false })
        .where('server_id', '=', id).where('linux_user', '=', username).execute()

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.user_deleted', resource: 'server', resourceId: id,
        details: { username, remove_home: body?.remove_home }, request: req,
      })

      return result
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  // PATCH /servers/:id/users/:username — edit shell, comment, or password
  fastify.patch('/servers/:id/users/:username', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, username } = z.object({ id: z.string().uuid(), username: z.string().min(1) }).parse(req.params)
    const body = z.object({
      shell: z.string().optional(),
      comment: z.string().max(100).optional(),
      password: z.string().min(1).optional(),
      save_to_vault: z.boolean().default(true),
    }).parse(req.body)

    try {
      await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        if (body.shell) {
          const { code, stderr } = await sshExec(client, `sudo chsh -s ${body.shell} ${username}`)
          if (code !== 0) throw new Error(`chsh failed: ${stderr}`)
        }
        if (body.comment !== undefined) {
          const { code, stderr } = await sshExec(client, `sudo chfn -f ${JSON.stringify(body.comment)} ${username}`)
          if (code !== 0) throw new Error(`chfn failed: ${stderr}`)
        }
        if (body.password) {
          const escaped = body.password.replace(/'/g, "'\\''")
          const { code, stderr } = await sshExec(client, `echo '${username}:${escaped}' | sudo chpasswd`)
          if (code !== 0) throw new Error(`chpasswd failed: ${stderr}`)
        }
      })

      if (body.password && body.save_to_vault) {
        const vk = getVaultKey()
        // Archive existing active linux credentials for this user, then create new one
        const existing = await db.selectFrom('server_credentials')
          .selectAll()
          .where('server_id', '=', id)
          .where('linux_user', '=', username)
          .where('category', '=', 'linux')
          .where('is_archived', '=', false)
          .execute()
        if (existing.length > 0) {
          await db.updateTable('server_credentials')
            .set({ is_archived: true, archived_at: new Date(), archived_reason: 'rotated' })
            .where('server_id', '=', id)
            .where('linux_user', '=', username)
            .where('category', '=', 'linux')
            .where('is_archived', '=', false)
            .execute()
        }
        await db.insertInto('server_credentials').values({
          server_id: id,
          category: 'linux',
          linux_user: username,
          service_name: null,
          service_username: null,
          label: existing.length > 0 ? existing[0].label : `${username} login password`,
          password_enc: encryptSecret(body.password, vk),
          notes: null,
          created_by: req.session.user!.id,
          predecessor_id: existing.length > 0 ? existing[0].id : null,
        }).execute()
      }

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.user_edited', resource: 'server', resourceId: id,
        details: { username, changed_shell: !!body.shell, changed_password: !!body.password }, request: req,
      })

      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  // POST /servers/:id/users/:username/keys — push an SSH key to a linux user
  fastify.post('/servers/:id/users/:username/keys', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, username } = z.object({ id: z.string().uuid(), username: z.string().min(1) }).parse(req.params)
    const body = z.object({ key_id: z.string().uuid() }).parse(req.body)

    const sshKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', body.key_id).where('is_active', '=', true).executeTakeFirst()
    if (!sshKey) return reply.code(404).send({ error: 'SSH key not found or inactive' })

    const { pushKeyToServer } = await import('../../utils/key-ops')

    try {
      // For root on Linux: use su/sudo elevation via the root vault credential
      // since the management user likely can't write to /root/.ssh directly
      const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
      if (server && username === 'root' && server.os_type !== 'windows') {
        const rootCred = await db.selectFrom('server_credentials').selectAll()
          .where('server_id', '=', id).where('linux_user', '=', 'root')
          .where('category', '=', 'linux').where('is_archived', '=', false)
          .orderBy('created_at', 'desc').executeTakeFirst()

        if (rootCred) {
          const rootPassword = decryptSecret(rootCred.password_enc, getVaultKey())
          const pubKey = sshKey.public_key.trim()
          const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

          await withServerSsh(id, async (client) => {
            const runAsRoot = (cmd: string) => new Promise<void>((resolve, reject) => {
              const trySudo = () => new Promise<boolean>((res) => {
                client.exec(`sudo -S sh -c ${sq(cmd)}`, { pty: false }, (err: Error | undefined, stream: any) => {
                  if (err) return res(false)
                  stream.stderr?.on('data', () => {})
                  stream.on('data', () => {})
                  stream.write(rootPassword + '\n')
                  stream.end()
                  stream.on('close', (code: number) => res(code === 0))
                })
              })
              const trySu = () => new Promise<boolean>((res) => {
                client.exec(`su -c ${sq(cmd)} root`, { pty: true }, (err: Error | undefined, stream: any) => {
                  if (err) return res(false)
                  let sent = false
                  stream.on('data', (d: Buffer) => {
                    if (!sent && /[Pp]assword/i.test(d.toString())) { sent = true; stream.write(rootPassword + '\n') }
                  })
                  stream.on('close', (code: number) => res(code === 0))
                })
              })
              trySudo().then(ok => ok ? resolve() : trySu().then(ok2 => ok2 ? resolve() : reject(new Error('Could not elevate to root'))))
            })

            await runAsRoot('mkdir -p /root/.ssh && chmod 700 /root/.ssh')
            await runAsRoot(`touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`)
            // Append only if not already present
            await runAsRoot(`grep -qxF ${sq(pubKey)} /root/.ssh/authorized_keys || echo ${sq(pubKey)} >> /root/.ssh/authorized_keys`)
          })
        } else {
          // No root vault credential — fall back to standard push (works if management user is root)
          await pushKeyToServer(id, username, sshKey.public_key)
        }
      } else {
        await pushKeyToServer(id, username, sshKey.public_key)
      }

      // Create or reactivate a key_assignment so the user can access this linux_user via terminal.
      // Use the key owner (created_by) as the assignment's user_id; fall back to the requesting admin.
      const assigneeId = sshKey.created_by ?? req.session.user!.id

      const existing = await db.selectFrom('key_assignments')
        .selectAll()
        .where('server_id', '=', id)
        .where('linux_user', '=', username)
        .where('key_id', '=', body.key_id)
        .where('user_id', '=', assigneeId)
        .executeTakeFirst()

      if (existing) {
        // Reactivate if it was previously deactivated
        if (!existing.is_active) {
          await db.updateTable('key_assignments')
            .set({ is_active: true })
            .where('id', '=', existing.id)
            .execute()
        }
      } else {
        await db.insertInto('key_assignments').values({
          user_id: assigneeId,
          key_id: body.key_id,
          server_id: id,
          linux_user: username,
          can_terminal: true,
          is_active: true,
          granted_by: req.session.user!.id,
        }).execute()
      }

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.key_pushed', resource: 'server', resourceId: id,
        details: { username, key_id: body.key_id, key_name: sshKey.name, assignee_id: assigneeId }, request: req,
      })

      return { ok: true, username, key_name: sshKey.name }
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to push key', details: (err as Error).message })
    }
  })

  // PATCH /servers/:id/management-key — promote an active SSH key to be the management key
  fastify.patch('/servers/:id/management-key', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({ key_id: z.string().uuid(), linux_user: z.string().optional() }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const key = await db.selectFrom('ssh_keys').selectAll().where('id', '=', body.key_id).where('is_active', '=', true).executeTakeFirst()
    if (!key) return reply.code(400).send({ error: 'Key not found or not active' })

    await db.updateTable('servers')
      .set({
        management_key_id: body.key_id,
        ...(body.linux_user ? { management_linux_user: body.linux_user } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute()

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.management_key_updated', resource: 'server', resourceId: id,
      details: { old_key_id: server.management_key_id, new_key_id: body.key_id, key_name: key.name }, request: req,
    })

    return { ok: true, key_name: key.name }
  })
  // GET /servers/:id/recommendations — best-practice config recommendations based on installed software + hardware
  fastify.get('/servers/:id/recommendations', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    try {
      const { generateRecommendations } = await import('../../utils/recommendations')
      const { detectOsType, gatherWindowsInfo, detectWindowsSoftware } = await import('../../utils/windows-ssh')

      const result = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        const osType = await detectOsType(client, sshExec)

        if (osType === 'windows') {
          // Windows path — gather info + software in parallel
          const [winInfo, winSoftware] = await Promise.all([
            gatherWindowsInfo(client, sshExec, id),
            detectWindowsSoftware(client, sshExec),
          ])
          const installedSoftware = winSoftware.map((s) => s.name)
          const versions = Object.fromEntries(winSoftware.map((s) => [s.name, s.version]))
          return generateRecommendations({
            memoryRaw: '', ramMbDirect: winInfo.memory_total_mb,
            cpuCount: winInfo.cpu_count, installedSoftware, versions,
            osType: 'windows', windowsRoles: winInfo.roles,
          })
        }

        // Linux path
        const [memOut, cpuOut, swOut] = await Promise.all([
          sshExec(client, 'cat /proc/meminfo | grep MemTotal'),
          sshExec(client, 'nproc --all 2>/dev/null || grep -c processor /proc/cpuinfo'),
          sshExec(client, [
            'command -v php >/dev/null 2>&1 && echo "PHP:$(php -r "echo PHP_VERSION;" 2>/dev/null)" || true',
            'command -v nginx >/dev/null 2>&1 && echo "Nginx:$(nginx -v 2>&1 | grep -oP "[\\d.]+")" || true',
            'command -v apache2 >/dev/null 2>&1 && echo "Apache:$(apache2 -v 2>&1 | grep -oP "[\\d.]+" | head -1)" || true',
            'command -v httpd >/dev/null 2>&1 && echo "Apache:$(httpd -v 2>&1 | grep -oP "[\\d.]+" | head -1)" || true',
            'command -v mysql >/dev/null 2>&1 && echo "MySQL:$(mysql --version 2>&1 | grep -oP "[\\d.]+" | head -1)" || true',
            'command -v psql >/dev/null 2>&1 && echo "PostgreSQL:$(psql --version 2>&1 | grep -oP "[\\d.]+" | head -1)" || true',
            'command -v redis-server >/dev/null 2>&1 && echo "Redis:$(redis-server --version 2>&1 | grep -oP "[\\d.]+" | head -1)" || true',
            'command -v docker >/dev/null 2>&1 && echo "Docker:$(docker --version 2>&1 | grep -oP "[\\d.]+" | head -1)" || true',
          ].join('; ')),
        ])
        const cpuCount = Math.max(1, parseInt(cpuOut.stdout.trim()) || 1)
        const installedSoftware: string[] = []
        const versions: Record<string, string | null> = {}
        for (const line of swOut.stdout.split('\n')) {
          const m = line.match(/^(\w+):(.*)$/)
          if (m) { installedSoftware.push(m[1]); versions[m[1]] = m[2].trim() || null }
        }
        return generateRecommendations({ memoryRaw: memOut.stdout, cpuCount, installedSoftware, versions, osType: 'linux' })
      })

      return result
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to generate recommendations', details: (err as Error).message })
    }
  })

  // GET /servers/:id/benchmark — run OS security benchmark checks via SSH
  fastify.get('/servers/:id/benchmark', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server not configured' })

    try {
      const result = await withServerSsh(id, async (client) => {
        const { runBenchmark } = await import('../../utils/benchmark')
        return runBenchmark(client)
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.benchmark_run', resource: 'server', resourceId: id, request: req,
      })

      return result
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to run security benchmark', details: (err as Error).message })
    }
  })

  // GET /servers/:id/browse?path=/var/www — list directory contents via SSH
  fastify.get('/servers/:id/browse', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: browsePath = '/' } = z.object({ path: z.string().optional() }).parse(req.query)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (!server.management_key_id) return reply.code(400).send({ error: 'Server not configured' })

    try {
      const result = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        // Use stat-parseable long listing: type+perms, links, owner, group, size, name
        const [lsRaw, pwdRaw, statRaw] = await Promise.all([
          sshExec(client, `ls -la "${browsePath}" 2>/dev/null`),
          sshExec(client, `realpath "${browsePath}" 2>/dev/null || echo "${browsePath}"`),
          sshExec(client, `stat -c "%F|%s|%U|%G|%y" "${browsePath}" 2>/dev/null`),
        ])

        const realPath = pwdRaw.stdout.trim() || browsePath
        const entries: Array<{
          name: string; type: 'dir' | 'file' | 'link' | 'other'
          permissions: string; owner: string; group: string
          size: number; modified: string
        }> = []

        for (const line of lsRaw.stdout.split('\n').slice(1)) { // skip 'total N' line
          const m = line.match(/^([dlrwxst-]{10})\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/)
          if (!m) continue
          const [, perms, owner, group, size, modified, rawName] = m
          const name = rawName.trim()
          if (name === '.' || name === '..') continue
          const typeChar = perms[0]
          const type = typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'link' : typeChar === '-' ? 'file' : 'other'
          entries.push({ name, type, permissions: perms, owner, group, size: parseInt(size) || 0, modified })
        }

        // Sort: dirs first, then files alphabetically
        entries.sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1
          if (a.type !== 'dir' && b.type === 'dir') return 1
          return a.name.localeCompare(b.name)
        })

        const parentPath = realPath === '/' ? '/' : realPath.split('/').slice(0, -1).join('/') || '/'

        return { path: realPath, parent: parentPath, entries }
      })

      return result
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Browse failed', details: (err as Error).message })
    }
  })
  // ── AI Log Analyst ───────────────────────────────────────────────────────────

  // POST /servers/:id/ai-analyse
  fastify.post('/servers/:id/ai-analyse', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      log_source:      z.string().min(1),   // shell command to fetch logs
      lines:           z.number().int().min(50).max(2000).default(300),
      analysis_type:   z.enum(['health', 'security', 'performance', 'errors', 'custom']),
      custom_question: z.string().max(500).optional(),
      provider:        z.enum(['claude', 'openai', 'gemini', 'deepseek']),
      model:           z.string().min(1),
    }).parse(req.body)

    // Load the API key for the chosen provider
    const keyMap: Record<string, string> = {
      claude: 'ai_key_claude', openai: 'ai_key_openai',
      gemini: 'ai_key_gemini', deepseek: 'ai_key_deepseek',
    }
    const rows = (await (db as any).selectFrom('settings').selectAll()
      .where('key', '=', keyMap[body.provider]).execute()) as Array<{ key: string; value: unknown }>
    const apiKey = (rows[0]?.value as string) ?? ''
    if (!apiKey) return reply.code(400).send({ error: `No API key configured for ${body.provider}. Add it in Settings → AI Providers.` })

    // Fetch logs from server via SSH
    let logs = ''
    try {
      logs = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')
        // Wrap user command in a tail if it's a file path, otherwise run as-is
        const cmd = body.log_source.startsWith('/') || body.log_source.startsWith('~')
          ? `sudo tail -n ${body.lines} ${body.log_source} 2>/dev/null || echo "[File not found or not readable]"`
          : `${body.log_source} 2>&1 | tail -n ${body.lines}`
        const { stdout, stderr } = await sshExec(client, cmd)
        return (stdout || stderr || '').trim()
      })
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to fetch logs via SSH', details: (err as Error).message })
    }

    if (!logs || logs === '[File not found or not readable]') {
      return reply.code(404).send({ error: 'No logs found. The file or command returned no output.' })
    }

    // Trim to ~12 000 chars to stay within token budgets across all providers
    const trimmed = logs.length > 12000 ? '...[trimmed]\n' + logs.slice(-12000) : logs

    try {
      const result = await callAiProvider(
        body.provider as AiProvider,
        body.model,
        apiKey,
        body.analysis_type as AnalysisType,
        body.custom_question,
        trimmed,
      )

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.ai_analyse', resource: 'server', resourceId: id,
        details: { provider: body.provider, model: body.model, analysis_type: body.analysis_type, log_source: body.log_source },
        request: req,
      })

      return result
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'AI analysis failed', details: (err as Error).message })
    }
  })

  // POST /servers/:id/enable-root-ssh
  // Connects via management SSH key as normal user, elevates to root using the stored vault
  // credential (linux_user='root'), pushes the management key to /root/.ssh/authorized_keys,
  // and ensures PermitRootLogin allows key-based login.
  fastify.post('/servers/:id/enable-root-ssh', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    try {
      const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
      if (!server) return reply.code(404).send({ error: 'Server not found' })

      // Look up stored root vault credential
      const rootCred = await db.selectFrom('server_credentials')
        .selectAll()
        .where('server_id', '=', id)
        .where('linux_user', '=', 'root')
        .where('category', '=', 'linux')
        .where('is_archived', '=', false)
        .orderBy('created_at', 'desc')
        .executeTakeFirst()

      if (!rootCred) {
        return reply.code(400).send({
          error: 'No root vault credential found. Add a Linux credential with username "root" and the root password in the Vault tab first.',
        })
      }

      const vaultKey = getVaultKey()
      const rootPassword = decryptSecret(rootCred.password_enc, vaultKey)

      const mgmtKey = await db.selectFrom('ssh_keys').selectAll()
        .where('id', '=', server.management_key_id!).executeTakeFirst()
      if (!mgmtKey) return reply.code(400).send({ error: 'Management key not found' })

      const pubKey = mgmtKey.public_key.trim()
      const steps: string[] = []

      // Shell-escape a string for single-quoted shell argument
      const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

      await withServerSsh(id, async (client) => {
        steps.push(`Connected as ${server.management_linux_user} via management SSH key`)

        // Run a command as root. Tries sudo -S first (Ubuntu/sudoers), falls back to su with PTY (Debian).
        const runAsRoot = (cmd: string): Promise<{ out: string; code: number }> => {
          const trySudo = () => new Promise<{ out: string; code: number }>((resolve, reject) => {
            client.exec(`sudo -S sh -c ${sq(cmd)}`, { pty: false }, (err: Error | undefined, stream: any) => {
              if (err) return reject(err)
              let out = ''
              stream.stderr?.on('data', () => {}) // discard sudo password prompt on stderr
              stream.on('data', (d: Buffer) => { out += d.toString() })
              // Write password to sudo's stdin
              stream.write(rootPassword + '\n')
              stream.end()
              stream.on('close', (code: number) => {
                if (code !== 0) return reject(new Error(`sudo exit ${code}`))
                resolve({ out: out.trim(), code })
              })
            })
          })

          const trySu = () => new Promise<{ out: string; code: number }>((resolve, reject) => {
            // Use PTY so su can read the password from the terminal
            client.exec(`su -c ${sq(cmd)} root`, { pty: true }, (err: Error | undefined, stream: any) => {
              if (err) return reject(err)
              let out = '', passwordSent = false
              stream.on('data', (d: Buffer) => {
                const text = d.toString()
                if (!passwordSent && /[Pp]assword/.test(text)) {
                  passwordSent = true
                  stream.write(rootPassword + '\n')
                  return
                }
                // Filter out terminal echo / control sequences
                if (passwordSent) out += text.replace(/\r/g, '')
              })
              stream.on('close', (code: number) => {
                if (code !== 0) return reject(new Error(`su exit ${code}: ${out.trim()}`))
                resolve({ out: out.trim(), code })
              })
            })
          })

          return trySudo().catch(() => trySu())
        }

        // Test elevation works
        const { code: testCode } = await runAsRoot('true').catch(() => ({ code: 1 }))
        if (testCode !== 0) throw new Error('Could not elevate to root — check the root password in the Vault')
        steps.push('Elevated to root (via sudo or su)')

        // Ensure /root/.ssh with correct permissions
        await runAsRoot('mkdir -p /root/.ssh && chmod 700 /root/.ssh')
        steps.push('Ensured /root/.ssh exists (mode 700)')

        // Append key if not already present
        const { out: existing } = await runAsRoot('cat /root/.ssh/authorized_keys 2>/dev/null || true')
        const keyBody = pubKey.trim().split(' ').slice(0, 2).join(' ')
        if (existing.includes(keyBody)) {
          steps.push('Management SSH key already in authorized_keys — skipped')
        } else {
          await runAsRoot(`echo ${sq(pubKey)} >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`)
          steps.push('Management SSH key added to /root/.ssh/authorized_keys')
        }

        // Ensure PermitRootLogin allows key-based login
        const { out: permitLine } = await runAsRoot(`grep -i PermitRootLogin /etc/ssh/sshd_config | grep -v '^#' || true`)
        const permitVal = permitLine.trim().toLowerCase()
        if (permitVal === '' || permitVal.includes('no')) {
          // Replace or append
          const { out: grepOut } = await runAsRoot(`grep -ic PermitRootLogin /etc/ssh/sshd_config || true`)
          if (parseInt(grepOut.trim()) > 0) {
            await runAsRoot(`sed -i 's/^[[:space:]#]*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config`)
          } else {
            await runAsRoot(`echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config`)
          }
          await runAsRoot('systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || true')
          steps.push('Set PermitRootLogin prohibit-password and reloaded sshd')
        } else {
          steps.push(`PermitRootLogin already allows key login: ${permitLine.trim()}`)
        }
      })

      // Create key_assignment for root so the terminal can connect as root
      const mgmtKeyForAssign = await db.selectFrom('ssh_keys').selectAll()
        .where('id', '=', server.management_key_id!).executeTakeFirst()
      if (mgmtKeyForAssign) {
        const assigneeId = mgmtKeyForAssign.created_by ?? req.session.user!.id
        const existing = await db.selectFrom('key_assignments').selectAll()
          .where('server_id', '=', id).where('linux_user', '=', 'root')
          .where('key_id', '=', server.management_key_id!).where('user_id', '=', assigneeId)
          .executeTakeFirst()
        if (existing) {
          if (!existing.is_active) {
            await db.updateTable('key_assignments').set({ is_active: true }).where('id', '=', existing.id).execute()
          }
        } else {
          await db.insertInto('key_assignments').values({
            user_id: assigneeId,
            key_id: server.management_key_id!,
            server_id: id,
            linux_user: 'root',
            can_terminal: true,
            is_active: true,
            granted_by: req.session.user!.id,
          }).execute()
        }
        steps.push('key_assignment created for root (terminal access enabled)')
      }

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.enable_root_ssh', resource: 'server', resourceId: id,
        details: { steps }, request: req,
      })
      return { ok: true, steps }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // GET /servers/:id/sshd-status — read PermitRootLogin + root lock status via management SSH
  fastify.get('/servers/:id/sshd-status', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    try {
      const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
      if (!server) return reply.code(404).send({ error: 'Server not found' })

      const { sshExec } = await import('../../utils/ssh')
      let permitRootLogin = 'unknown'
      let rootLocked = false

      await withServerSsh(id, async (client) => {
        // Read PermitRootLogin from sshd_config (active value, not commented)
        const { stdout: permitOut } = await sshExec(client,
          `grep -iE '^[[:space:]]*PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null | tail -1 || echo ''`)
        const match = permitOut.trim().match(/PermitRootLogin\s+(\S+)/i)
        permitRootLogin = match ? match[1].toLowerCase() : 'prohibit-password' // default when not set

        // Check if root has NO password at all (Ubuntu default: field is just '!' or '*')
        // A field like '!$6$...' means locked-for-SSH but password exists — root can still be su'd to
        const { stdout: shadowOut } = await sshExec(client,
          `sudo getent shadow root 2>/dev/null || getent shadow root 2>/dev/null || true`)
        if (shadowOut.trim()) {
          const fields = shadowOut.trim().split(':')
          const pwField = fields[1] ?? ''
          // Only truly no-password: bare '!', '!!', or '*' — NOT '!$6$...' (has password, just locked)
          rootLocked = pwField === '!' || pwField === '!!' || pwField === '*' || pwField === ''
        }
      })

      return { permitRootLogin, rootLocked }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // GET /servers/:id/ndb-status — query MySQL NDB Cluster topology via ndb_mgm
  fastify.get('/servers/:id/ndb-status', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    try {
      const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
      if (!server) return reply.code(404).send({ error: 'Server not found' })

      const { sshExec } = await import('../../utils/ssh')

      type NdbNode = {
        id: number
        type: 'mgmd' | 'ndbd' | 'mysqld'
        host: string
        status: 'connected' | 'not_connected' | 'unknown'
        nodegroup?: number
        master?: boolean
      }

      const nodes: NdbNode[] = []

      await withServerSsh(id, async (client) => {
        const { stdout } = await sshExec(client,
          'ndb_mgm -e "show" 2>/dev/null || ndb_mgm --ndb-connectstring=localhost -e "show" 2>/dev/null || echo "ERROR: ndb_mgm not found"')

        // ndb_mgm output uses section headers to identify node type:
        //   [ndbd(NDB)]    → ndbd data nodes
        //   [ndb_mgmd(MGM)] → management nodes
        //   [mysqld(API)]  → SQL/API nodes
        // Individual node lines just have the version string, not the type.
        let currentType: NdbNode['type'] = 'mysqld'
        for (const line of stdout.split('\n')) {
          const sectionMatch = line.match(/\[(\w+)\(/)
          if (sectionMatch) {
            const s = sectionMatch[1].toLowerCase()
            if (s === 'ndbd' || s === 'ndbmtd') currentType = 'ndbd'
            else if (s === 'ndb_mgmd') currentType = 'mgmd'
            else currentType = 'mysqld'
            continue
          }
          // Connected node: "id=2  @192.168.88.224  (mysql-8.0.47 ndbcluster, Nodegroup: 0, *)"
          const connMatch = line.match(/id=(\d+)\s+@([\d.a-zA-Z.-]+)\s+\(/)
          if (connMatch) {
            const [, rawId, host] = connMatch
            const ngMatch = line.match(/Nodegroup:\s*(\d+)/)
            const master = line.includes('*')
            nodes.push({ id: parseInt(rawId), type: currentType, host, status: 'connected', nodegroup: ngMatch ? parseInt(ngMatch[1]) : undefined, master })
            continue
          }
          // Not connected: "id=3 (not connected, accepting connect from ...)"
          const discMatch = line.match(/id=(\d+)\s+\(not connected/)
          if (discMatch) {
            nodes.push({ id: parseInt(discMatch[1]), type: currentType, host: '?', status: 'not_connected' })
          }
        }
      })

      return { detected: nodes.length > 0, nodes }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/root/activate — Ubuntu: unlock root by setting a password via sudo passwd root
  fastify.post('/servers/:id/root/activate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { root_password } = z.object({ root_password: z.string().min(6) }).parse(req.body)
    try {
      const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
      if (!server) return reply.code(404).send({ error: 'Server not found' })

      const steps: string[] = []

      await withServerSsh(id, async (client) => {
        steps.push(`Connected as ${server.management_linux_user} via management SSH key`)

        // Run sudo passwd root via PTY — sends the new password twice when prompted
        await new Promise<void>((resolve, reject) => {
          client.exec('sudo passwd root', { pty: true }, (err: Error | undefined, stream: any) => {
            if (err) return reject(err)
            let out = '', promptCount = 0
            stream.on('data', (d: Buffer) => {
              const text = d.toString()
              out += text
              // passwd prompts "New password:" then "Retype new password:"
              if (/[Pp]assword:/i.test(text) && promptCount < 2) {
                promptCount++
                stream.write(root_password + '\n')
              }
            })
            stream.on('close', (code: number) => {
              if (code !== 0) return reject(new Error(`passwd failed (exit ${code}): ${out.trim()}`))
              resolve()
            })
          })
        })
        steps.push('Root password set via sudo passwd root')

        // Ensure PermitRootLogin is not 'no' so password login is possible
        const { sshExec } = await import('../../utils/ssh')
        const { stdout: permitOut } = await sshExec(client,
          `grep -iE '^[[:space:]]*PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null | tail -1 || echo ''`)
        const match = permitOut.trim().match(/PermitRootLogin\s+(\S+)/i)
        const currentVal = match ? match[1].toLowerCase() : 'prohibit-password'
        if (currentVal === 'no') {
          steps.push(`PermitRootLogin is currently 'no' — you will need to set it to 'yes' or 'prohibit-password' to use root`)
        } else {
          steps.push(`PermitRootLogin is: ${currentVal}`)
        }
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.root_activated', resource: 'server', resourceId: id,
        details: { steps }, request: req,
      })
      return { ok: true, steps }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/root/permit-login — set PermitRootLogin value via root elevation
  fastify.post('/servers/:id/root/permit-login', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { value } = z.object({ value: z.enum(['yes', 'prohibit-password', 'no']) }).parse(req.body)
    try {
      const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
      if (!server) return reply.code(404).send({ error: 'Server not found' })

      // Get root vault credential for elevation
      const rootCred = await db.selectFrom('server_credentials').selectAll()
        .where('server_id', '=', id).where('linux_user', '=', 'root')
        .where('category', '=', 'linux').where('is_archived', '=', false)
        .orderBy('created_at', 'desc').executeTakeFirst()

      if (!rootCred) {
        return reply.code(400).send({
          error: 'No root vault credential found. Add a Linux credential with username "root" first.',
        })
      }

      const vaultKey = getVaultKey()
      const rootPassword = decryptSecret(rootCred.password_enc, vaultKey)
      const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
      const steps: string[] = []

      await withServerSsh(id, async (client) => {
        steps.push(`Connected as ${server.management_linux_user} via management SSH key`)

        const runAsRoot = (cmd: string): Promise<{ out: string; code: number }> => {
          const trySudo = () => new Promise<{ out: string; code: number }>((resolve, reject) => {
            client.exec(`sudo -S sh -c ${sq(cmd)}`, { pty: false }, (err: Error | undefined, stream: any) => {
              if (err) return reject(err)
              let out = ''
              stream.stderr?.on('data', () => {})
              stream.on('data', (d: Buffer) => { out += d.toString() })
              stream.write(rootPassword + '\n')
              stream.end()
              stream.on('close', (code: number) => {
                if (code !== 0) return reject(new Error(`sudo exit ${code}`))
                resolve({ out: out.trim(), code })
              })
            })
          })

          const trySu = () => new Promise<{ out: string; code: number }>((resolve, reject) => {
            client.exec(`su -c ${sq(cmd)} root`, { pty: true }, (err: Error | undefined, stream: any) => {
              if (err) return reject(err)
              let out = '', passwordSent = false
              stream.on('data', (d: Buffer) => {
                const text = d.toString()
                if (!passwordSent && /[Pp]assword/.test(text)) {
                  passwordSent = true
                  stream.write(rootPassword + '\n')
                  return
                }
                if (passwordSent) out += text.replace(/\r/g, '')
              })
              stream.on('close', (code: number) => {
                if (code !== 0) return reject(new Error(`su exit ${code}: ${out.trim()}`))
                resolve({ out: out.trim(), code })
              })
            })
          })

          return trySudo().catch(() => trySu())
        }

        // Test elevation
        const { code: testCode } = await runAsRoot('true').catch(() => ({ code: 1 }))
        if (testCode !== 0) throw new Error('Could not elevate to root — check the root password in the Vault')
        steps.push('Elevated to root')

        // Check if PermitRootLogin line exists
        const { out: grepCount } = await runAsRoot(`grep -ic PermitRootLogin /etc/ssh/sshd_config || true`)
        if (parseInt(grepCount.trim()) > 0) {
          await runAsRoot(`sed -i 's/^[[:space:]#]*PermitRootLogin.*/PermitRootLogin ${value}/' /etc/ssh/sshd_config`)
        } else {
          await runAsRoot(`echo 'PermitRootLogin ${value}' >> /etc/ssh/sshd_config`)
        }
        steps.push(`Set PermitRootLogin ${value} in /etc/ssh/sshd_config`)

        await runAsRoot('systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service sshd reload 2>/dev/null || true')
        steps.push('Reloaded sshd')
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.permit_root_login_changed', resource: 'server', resourceId: id,
        details: { value, steps }, request: req,
      })
      return { ok: true, steps, value }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })
}

export default serversRoutes
