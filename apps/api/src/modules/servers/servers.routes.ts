import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { writeAuditLog } from '../../utils/audit'
import { getRemoteHostFingerprint, withSsh, connectWithFallback } from '../../utils/ssh'
import { withServerSsh } from '../../utils/server-ssh'
import { decryptSecret, encryptSecret, getVaultKey } from '../../utils/vault'
import { generateKeyPair } from '../../utils/keygen'

const ServerBody = z.object({
  name: z.string().min(1).max(100),
  hostname: z.string().min(1),
  ssh_port: z.number().int().min(1).max(65535).default(22),
  environment: z.enum(['production', 'staging', 'development', 'other']),
  tags: z.record(z.string()).optional().default({}),
  management_key_id: z.string().uuid().optional(),
  management_linux_user: z.string().min(1).optional(),
})

async function serversRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /servers
  fastify.get('/servers', { preHandler: requirePermission('servers:read') }, async (req) => {
    const query = z.object({
      environment: z.string().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    }).parse(req.query)

    let qb = db.selectFrom('servers').selectAll().where('is_active', '=', true)
    if (query.environment) qb = qb.where('environment', '=', query.environment as 'production')
    return qb.limit(query.limit).offset((query.page - 1) * query.limit).execute()
  })

  // POST /servers
  fastify.post('/servers', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
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
  fastify.get('/servers/:id', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const lastScan = await db.selectFrom('security_scans')
      .selectAll().where('server_id', '=', id)
      .orderBy('scanned_at', 'desc').limit(1).executeTakeFirst()

    return { ...server, last_scan: lastScan ?? null }
  })

  // PATCH /servers/:id
  fastify.patch('/servers/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
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
  fastify.delete('/servers/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await db.updateTable('servers').set({ is_active: false, updated_at: new Date() }).where('id', '=', id).execute()
    await writeAuditLog({ userId: req.session.user!.id, userEmail: req.session.user!.email, action: 'server.deleted', resource: 'server', resourceId: id, request: req })
    reply.code(204).send()
  })

  // POST /servers/:id/verify-host-key
  fastify.post('/servers/:id/verify-host-key', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
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

  // POST /servers/:id/test-connection
  fastify.post('/servers/:id/test-connection', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
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
  fastify.post('/servers/:id/setup', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
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
              await sshExec(client, 'mkdir -p ~/.ssh && chmod 700 ~/.ssh')
              await sshExec(client, `echo ${JSON.stringify(authorizedKeysLine)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`)
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

    await writeAuditLog({
      userId: req.session.user!.id, userEmail: req.session.user!.email,
      action: 'server.setup', resource: 'server', resourceId: id,
      details: { linux_user: body.linux_user, key_id: savedKey.id },
      request: req,
    })

    return { ok: true, management_key_id: savedKey.id, key_name: keyName }
  })

  // GET /servers/:id/assignments
  fastify.get('/servers/:id/assignments', { preHandler: requirePermission('servers:read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return db.selectFrom('key_assignments').selectAll().where('server_id', '=', id).where('is_active', '=', true).execute()
  })

  // GET /servers/:id/info — SSH in and collect live system info
  fastify.get('/servers/:id/info', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
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
            // Save OS type + host type to DB
            db.updateTable('servers').set({ os_type: osType, host_type: virtInfo.host_type, host_type_detail: virtInfo.detail ?? undefined, updated_at: new Date() })
              .where('id', '=', id).execute().catch(() => {})
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
            sshExec(client, 'cat /root/.ssh/authorized_keys 2>/dev/null || echo ""'),
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
              const akOut = await sshExec(client, `sudo cat ${u.home}/.ssh/authorized_keys 2>/dev/null || echo ""`)
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

          // Save OS type + host type to DB
          db.updateTable('servers').set({ os_type: 'linux', host_type: virtInfo.host_type, host_type_detail: virtInfo.detail ?? undefined, updated_at: new Date() })
            .where('id', '=', id).execute().catch(() => {})

          return {
            os_type: 'linux' as const,
            management_key_id: server.management_key_id,
            os: {
              name: osInfo['NAME'] || osInfo['PRETTY_NAME'] || 'Unknown',
              pretty_name: osInfo['PRETTY_NAME'] || '',
              version: osInfo['VERSION'] || osInfo['VERSION_ID'] || '',
              id: osInfo['ID'] || '',
              kernel: unameR.stdout,
            },
            uptime: uptimeOut.stdout,
            memory: memOut.stdout,
            users,
            logged_in: whoOut.stdout.split('\n').filter(Boolean),
            authorized_keys: authorizedKeys,
            virt: virtInfo,
          }
      }, (info) => { usedKeyInfo = info })
      return { ...result, active_key_id: usedKeyInfo.keyId, active_key_name: usedKeyInfo.keyName, active_key_is_fallback: usedKeyInfo.isFallback }
    } catch (err: unknown) {
      return reply.code(500).send({ error: 'Failed to gather server info', details: (err as Error).message })
    }
  })

  // DELETE /servers/:id/authorized-keys — remove a specific key from the server's authorized_keys
  fastify.delete('/servers/:id/authorized-keys', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
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
  fastify.post('/servers/:id/users', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      username: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/, 'Invalid linux username'),
      comment: z.string().max(100).optional(),   // GECOS field
      shell: z.string().optional().default('/bin/bash'),
      create_home: z.boolean().default(true),
      system_user: z.boolean().default(false),   // --system flag (no home, no login shell by default)
    }).parse(req.body)

    try {
      const result = await withServerSsh(id, async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        // Check user doesn't already exist
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

        return { username: body.username, created: true }
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'server.user_created', resource: 'server', resourceId: id,
        details: { username: body.username, system_user: body.system_user }, request: req,
      })

      return reply.code(201).send(result)
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  // DELETE /servers/:id/users/:username — delete a linux user
  fastify.delete('/servers/:id/users/:username', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
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

  // POST /servers/:id/users/:username/keys — push an SSH key to a linux user
  fastify.post('/servers/:id/users/:username/keys', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id, username } = z.object({ id: z.string().uuid(), username: z.string().min(1) }).parse(req.params)
    const body = z.object({ key_id: z.string().uuid() }).parse(req.body)

    const sshKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', body.key_id).where('is_active', '=', true).executeTakeFirst()
    if (!sshKey) return reply.code(404).send({ error: 'SSH key not found or inactive' })

    const { pushKeyToServer } = await import('../../utils/key-ops')

    try {
      await pushKeyToServer(id, username, sshKey.public_key)

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
  fastify.patch('/servers/:id/management-key', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({ key_id: z.string().uuid() }).parse(req.body)

    const server = await db.selectFrom('servers').selectAll().where('id', '=', id).executeTakeFirst()
    if (!server) return reply.code(404).send({ error: 'Server not found' })

    const key = await db.selectFrom('ssh_keys').selectAll().where('id', '=', body.key_id).where('is_active', '=', true).executeTakeFirst()
    if (!key) return reply.code(400).send({ error: 'Key not found or not active' })

    await db.updateTable('servers')
      .set({ management_key_id: body.key_id, updated_at: new Date() })
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
  fastify.get('/servers/:id/recommendations', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
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
}

export default serversRoutes
