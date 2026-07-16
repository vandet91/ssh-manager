import { FastifyInstance } from 'fastify'

import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import { Client } from 'ssh2'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'
import { decryptSecret, getVaultKey } from '../../utils/vault'
import { connectWithFallback } from '../../utils/ssh'
import { withServerSsh } from '../../utils/server-ssh'
import { config } from '../../config'
import { writeAuditLog } from '../../utils/audit'
import { isSessionRecordingEnabled } from '../settings/settings.routes'

type WsMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }

// Strip sequences that break asciinema playback (Windows ConPTY resize requests)
// CSI 8 ; rows ; cols t — tells terminal to resize window; breaks absolute positioning in playback
const CAST_STRIP_RE = /\x1b\[8;\d+;\d+t/g
function stripForCast(text: string): string {
  return text.replace(CAST_STRIP_RE, '')
}

type Recorder = {
  writeHeader: (cols: number, rows: number) => void
  writeData: (text: string) => void
  finish: () => void
}

// Builds a session recorder, or a no-op recorder when recording is disabled.
// When disabled nothing is written to disk and no session_recordings row is
// created, so the SSH stream is untouched.
async function createRecorder(opts: {
  enabled: boolean
  userId: string
  serverId: string
  linuxUser: string
  title: string
  startTime: number
}): Promise<Recorder> {
  if (!opts.enabled) {
    return { writeHeader: () => {}, writeData: () => {}, finish: () => {} }
  }
  const recordingId = crypto.randomUUID()
  const castPath = path.join(config.RECORDINGS_STORAGE_PATH, `${recordingId}.cast`)
  fs.mkdirSync(config.RECORDINGS_STORAGE_PATH, { recursive: true })
  const castStream = fs.createWriteStream(castPath, { flags: 'a' })

  const [recordRow] = await db.insertInto('session_recordings').values({
    user_id: opts.userId, server_id: opts.serverId, linux_user: opts.linuxUser, cast_file_path: castPath,
  }).returningAll().execute()

  return {
    writeHeader: (cols, rows) => {
      castStream.write(JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(opts.startTime / 1000), title: opts.title }) + '\n')
    },
    writeData: (text) => {
      const elapsed = ((Date.now() - opts.startTime) / 1000).toFixed(6)
      castStream.write(JSON.stringify([Number(elapsed), 'o', stripForCast(text)]) + '\n')
    },
    finish: () => {
      const duration = Math.floor((Date.now() - opts.startTime) / 1000)
      castStream.end(async () => {
        try {
          const size = fs.statSync(castPath).size
          await db.updateTable('session_recordings').set({ ended_at: new Date(), duration_s: duration, cast_size_bytes: size }).where('id', '=', recordRow.id).execute()
        } catch { /* ignore */ }
      })
    },
  }
}

async function terminalRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/terminal/:serverId', { websocket: true }, async (connection, req) => {
    const ws = connection.socket as unknown as {
      send: (data: string) => void
      on: (event: string, handler: (...args: unknown[]) => void) => void
      close: (code?: number, reason?: string) => void
    }

    const send = (msg: Record<string, unknown>) => {
      try { ws.send(JSON.stringify(msg)) } catch { /* closed */ }
    }

    try {
      if (!req.session.user) {
        send({ type: 'error', message: 'Unauthorized' })
        ws.close(4001)
        return
      }

      const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
      const query = z.object({ linux_user: z.string().optional(), credential_id: z.string().uuid().optional() }).parse(req.query)
      const sessionUser = req.session.user
      const recordingEnabled = await isSessionRecordingEnabled()

      // ── Password-based auth via server_credential ──────────────────────────
      if (query.credential_id) {
        const cred = await (db as any)
          .selectFrom('server_credentials')
          .selectAll()
          .where('id', '=', query.credential_id)
          .where('server_id', '=', serverId)
          .where('is_archived', '=', false)
          .executeTakeFirst() as any
        if (!cred || !cred.linux_user) {
          send({ type: 'error', message: 'Credential not found' })
          ws.close(4003)
          return
        }

        const server = await db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst()
        if (!server) { send({ type: 'error', message: 'Server not found' }); ws.close(4004); return }

        const vaultKey = getVaultKey()
        const password = decryptSecret(cred.password_enc, vaultKey)
        const linuxUser = cred.linux_user as string

        const sshClient = new Client()
        await new Promise<void>((resolve, reject) => {
          sshClient.once('ready', resolve).once('error', reject).connect({
            host: server.hostname,
            port: server.ssh_port,
            username: linuxUser,
            password,
            readyTimeout: 15000,
            keepaliveInterval: 20000,
            keepaliveCountMax: 5,
          })
        })

        const startTime = Date.now()
        let cols = 80; let rows = 24
        const recorder = await createRecorder({
          enabled: recordingEnabled, userId: sessionUser!.id, serverId, linuxUser,
          title: `${server.name} - ${linuxUser}`, startTime,
        })

        await writeAuditLog({ userId: sessionUser!.id, userEmail: sessionUser!.email, action: 'terminal.session.started', serverId, request: req })

        sshClient.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          if (err) { send({ type: 'error', message: err.message }); sshClient.end(); return }
          recorder.writeHeader(cols, rows)
          send({ type: 'connected', serverName: server.name, linuxUser, key_name: 'password' })

          let idleTimer: NodeJS.Timeout | null = null
          const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(() => { send({ type: 'disconnected' }); stream.end(); sshClient.end() }, config.TERMINAL_IDLE_TIMEOUT_MIN * 60 * 1000)
          }
          resetIdle()

          stream.on('data', (data: Buffer) => {
            const text = data.toString('utf8')
            send({ type: 'output', data: text })
            recorder.writeData(text)
          })

          stream.on('close', () => {
            if (idleTimer) clearTimeout(idleTimer)
            ws.close(); sshClient.end()
            recorder.finish()
            writeAuditLog({ userId: sessionUser!.id, userEmail: sessionUser!.email, action: 'terminal.session.ended', serverId })
          })

          ws.on('message', (rawMsg: unknown) => {
            try {
              const msg: WsMessage = JSON.parse(String(rawMsg))
              if (msg.type === 'input') { resetIdle(); stream.write(msg.data) }
              else if (msg.type === 'resize') { cols = msg.cols; rows = msg.rows; stream.setWindow(rows, cols, 0, 0) }
              else if (msg.type === 'ping') { resetIdle() }
            } catch { /* ignore */ }
          })

          ws.on('close', () => { if (idleTimer) clearTimeout(idleTimer); stream.end(); sshClient.end() })
        })
        return
      }

      // ── Key-based auth ─────────────────────────────────────────────────────
      let linuxUser = query.linux_user
      let assignmentQuery = db.selectFrom('key_assignments')
        .selectAll()
        .where('user_id', '=', sessionUser.id)
        .where('server_id', '=', serverId)
        .where('is_active', '=', true)
        .where('can_terminal', '=', true)

      if (linuxUser) assignmentQuery = assignmentQuery.where('linux_user', '=', linuxUser)

      const assignments = await assignmentQuery.execute()

      // Fallback: if no assignment, connect via management key
      if (assignments.length === 0) {
        // Uses management key
        const server = await db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst()
        if (!server || !server.management_key_id) {
          send({ type: 'error', message: 'Server not configured' })
          ws.close(4004)
          return
        }

        const mgmtKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', server.management_key_id).executeTakeFirst()
        if (!mgmtKey) { send({ type: 'error', message: 'Management key not found' }); ws.close(4004); return }

        const vaultKey = getVaultKey()

        // Build fallback list: management key first, then any other assigned keys for the management user
        const fallbackRows = await db.selectFrom('key_assignments')
          .innerJoin('ssh_keys', 'ssh_keys.id', 'key_assignments.key_id')
          .select(['ssh_keys.id', 'ssh_keys.name', 'ssh_keys.private_key_enc'])
          .where('key_assignments.server_id', '=', serverId)
          .where('key_assignments.linux_user', '=', server.management_linux_user)
          .where('key_assignments.is_active', '=', true)
          .where('key_assignments.key_id', '!=', server.management_key_id)
          .execute()

        const adminKeys = [
          { id: mgmtKey.id, name: mgmtKey.name, privatePem: decryptSecret(mgmtKey.private_key_enc, vaultKey) },
          ...fallbackRows.map((r) => ({ id: r.id, name: r.name, privatePem: decryptSecret(r.private_key_enc, vaultKey) })),
        ]

        const { client: sshClient, keyId: usedKeyId } = await connectWithFallback(
          server.hostname, server.ssh_port, server.management_linux_user,
          adminKeys, server.host_key_fingerprint ?? undefined,
        )

        const usedKeyName = adminKeys.find((k) => k.id === usedKeyId)?.name ?? usedKeyId.slice(0, 8)
        if (usedKeyId !== mgmtKey.id) {
          send({ type: 'warning', message: `Management key failed — connected using fallback key "${usedKeyName}". Update the server's management key.`, key_name: usedKeyName })
        }

        const startTime = Date.now()
        let cols = 80; let rows = 24
        const recorder = await createRecorder({
          enabled: recordingEnabled, userId: sessionUser.id, serverId, linuxUser: server.management_linux_user,
          title: `${server.name} - ${server.management_linux_user} (admin)`, startTime,
        })

        await writeAuditLog({ userId: sessionUser.id, userEmail: sessionUser.email, action: 'terminal.session.started', serverId, request: req })

        sshClient.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          if (err) { send({ type: 'error', message: err.message }); sshClient.end(); return }
          recorder.writeHeader(cols, rows)
          send({ type: 'connected', serverName: server.name, linuxUser: server.management_linux_user, key_name: usedKeyName })

          let idleTimer: NodeJS.Timeout | null = null
          const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(() => { send({ type: 'disconnected' }); stream.end(); sshClient.end() }, config.TERMINAL_IDLE_TIMEOUT_MIN * 60 * 1000)
          }
          resetIdle()

          stream.on('data', (data: Buffer) => {
            const text = data.toString('utf8')
            send({ type: 'output', data: text })
            recorder.writeData(text)
          })

          stream.on('close', () => {
            if (idleTimer) clearTimeout(idleTimer)
            ws.close(); sshClient.end()
            recorder.finish()
            writeAuditLog({ userId: sessionUser.id, userEmail: sessionUser.email, action: 'terminal.session.ended', serverId })
          })

          ws.on('message', (rawMsg: unknown) => {
            try {
              const msg: WsMessage = JSON.parse(String(rawMsg))
              if (msg.type === 'input') { resetIdle(); stream.write(msg.data) }
              else if (msg.type === 'resize') { cols = msg.cols; rows = msg.rows; stream.setWindow(rows, cols, 0, 0) }
              else if (msg.type === 'ping') { resetIdle() }
            } catch { /* ignore */ }
          })

          ws.on('close', () => { if (idleTimer) clearTimeout(idleTimer); stream.end(); sshClient.end() })
        })
        return
      }

      if (!linuxUser && assignments.length > 1) {
        send({ type: 'error', message: 'Multiple assignments found — specify linux_user query param' })
        ws.close(4004)
        return
      }

      const assignment = assignments[0]
      linuxUser = assignment.linux_user

      // Check expiry
      if (assignment.expires_at && new Date(assignment.expires_at) < new Date()) {
        send({ type: 'error', message: 'Assignment has expired' })
        ws.close(4005)
        return
      }

      const server = await db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst()
      if (!server) { send({ type: 'error', message: 'Server not found' }); ws.close(4004); return }

      const vaultKey = getVaultKey()

      // Collect all active keys for this linux_user on this server (primary assignment first,
      // then other active assignments for the same user) so we can fall back on rotation failures.
      const allAssignmentsForUser = await db.selectFrom('key_assignments')
        .innerJoin('ssh_keys', 'ssh_keys.id', 'key_assignments.key_id')
        .select(['key_assignments.key_id', 'ssh_keys.name as key_name', 'ssh_keys.private_key_enc', 'key_assignments.expires_at'])
        .where('key_assignments.user_id', '=', sessionUser.id)
        .where('key_assignments.server_id', '=', serverId)
        .where('key_assignments.linux_user', '=', linuxUser)
        .where('key_assignments.is_active', '=', true)
        .where('key_assignments.can_terminal', '=', true)
        .orderBy('key_assignments.created_at', 'asc')
        .execute()

      // Primary key (from the matched assignment) goes first
      const primaryKeyId = assignment.key_id
      const ordered = [
        ...allAssignmentsForUser.filter((a) => a.key_id === primaryKeyId),
        ...allAssignmentsForUser.filter((a) => a.key_id !== primaryKeyId),
      ]

      const keysToTry = ordered.map((a) => ({
        id: a.key_id,
        name: a.key_name,
        privatePem: decryptSecret(a.private_key_enc, vaultKey),
      }))

      const { client: sshClient, keyId: usedKeyId } = await connectWithFallback(
        server.hostname, server.ssh_port, linuxUser,
        keysToTry, server.host_key_fingerprint ?? undefined,
      )

      const usedKeyName = keysToTry.find((k) => k.id === usedKeyId)?.name ?? usedKeyId.slice(0, 8)

      // Warn in-band if we fell back to a different key
      if (usedKeyId !== primaryKeyId) {
        send({ type: 'warning', message: `Primary key failed — connected using fallback key "${usedKeyName}". Consider rotating or revoking the failed key.`, key_name: usedKeyName })
      }

      // Create recording (no-op when session recording is disabled)
      const startTime = Date.now()
      let cols = 80; let rows = 24
      const recorder = await createRecorder({
        enabled: recordingEnabled, userId: sessionUser.id, serverId, linuxUser,
        title: `${server.name} - ${linuxUser}`, startTime,
      })

      await writeAuditLog({ userId: sessionUser.id, userEmail: sessionUser.email, action: 'terminal.session.started', serverId, request: req })

      sshClient.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          send({ type: 'error', message: err.message })
          sshClient.end()
          return
        }

        recorder.writeHeader(cols, rows)
        send({ type: 'connected', serverName: server.name, linuxUser, key_name: usedKeyName })

        // Idle timeout
        let idleTimer: NodeJS.Timeout | null = null
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            send({ type: 'disconnected' })
            stream.end()
            sshClient.end()
          }, config.TERMINAL_IDLE_TIMEOUT_MIN * 60 * 1000)
        }
        resetIdle()

        // SSH → WS
        stream.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          send({ type: 'output', data: text })
          recorder.writeData(text)
        })

        stream.on('close', () => {
          if (idleTimer) clearTimeout(idleTimer)
          ws.close()
          sshClient.end()
          recorder.finish()
          writeAuditLog({ userId: sessionUser.id, userEmail: sessionUser.email, action: 'terminal.session.ended', serverId })
        })

        // WS → SSH
        ws.on('message', (rawMsg: unknown) => {
          try {
            const msg: WsMessage = JSON.parse(String(rawMsg))
            if (msg.type === 'input') {
              resetIdle()
              stream.write(msg.data)
            } else if (msg.type === 'resize') {
              cols = msg.cols; rows = msg.rows
              stream.setWindow(rows, cols, 0, 0)
            } else if (msg.type === 'ping') {
              resetIdle()
            }
          } catch { /* ignore malformed */ }
        })

        ws.on('close', () => {
          if (idleTimer) clearTimeout(idleTimer)
          stream.end()
          sshClient.end()
        })
      })
    } catch (err: unknown) {
      send({ type: 'error', message: (err as Error).message })
      ws.close(4000)
    }
  })

  // ── POST /servers/:serverId/sftp/upload ─────────────────────────────────────
  // Upload a file to a server via SFTP using the management key.
  // Query param: ?path=/remote/dir/  (optional, defaults to /tmp/)
  fastify.post('/servers/:serverId/sftp/upload', { preHandler: [requireAuth] }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { path: remotePath = '/tmp/' } = z.object({ path: z.string().optional() }).parse(req.query)


    const data = await req.file()
    if (!data) return reply.code(400).send({ error: 'No file provided' })

    const fileBuffer = await data.toBuffer()
    const filename = data.filename || 'upload'
    const fullRemotePath = remotePath.endsWith('/') ? `${remotePath}${filename}` : remotePath

    await withServerSsh(serverId, async (client: Client) => {
      await new Promise<void>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(err)
          const writeStream = sftp.createWriteStream(fullRemotePath)
          writeStream.on('close', resolve)
          writeStream.on('error', reject)
          writeStream.end(fileBuffer)
        })
      })
    })

    await writeAuditLog({
      userId: req.session.user!.id,
      userEmail: req.session.user!.email,
      action: 'sftp.upload',
      resource: 'server',
      resourceId: serverId,
      details: { filename, remote_path: fullRemotePath, size_bytes: fileBuffer.length },
      request: req,
    })

    return { ok: true, path: fullRemotePath, filename, size: fileBuffer.length }
  })
}

export default terminalRoutes
