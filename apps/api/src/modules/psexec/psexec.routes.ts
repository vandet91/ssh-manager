import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'

const execFileAsync = promisify(execFile)

type ExecMethod = 'psexec' | 'wmiexec' | 'winrm'

// ── Impacket binary helpers ───────────────────────────────────────────────────

async function findImpacketBin(tool: 'psexec' | 'wmiexec' = 'psexec'): Promise<string> {
  const bins = tool === 'wmiexec'
    ? ['impacket-wmiexec', 'wmiexec.py']
    : ['impacket-psexec', 'psexec.py']
  for (const bin of bins) {
    try { await execFileAsync('which', [bin]); return bin } catch {}
  }
  try {
    const { stdout } = await execFileAsync('python3', ['-c', 'import impacket; import os; print(os.path.dirname(impacket.__file__))'])
    return `python3 ${stdout.trim()}/../bin/${tool}.py`
  } catch {}
  throw new Error(`impacket-${tool} not found`)
}

async function findEvilWinrm(): Promise<string> {
  try { await execFileAsync('which', ['evil-winrm']); return 'evil-winrm' } catch {}
  throw new Error('evil-winrm not found. Make sure it is installed.')
}

// ── Single-command execution ──────────────────────────────────────────────────

async function runPsexec(
  target: string, username: string, password: string, domain: string | null,
  command: string, timeoutMs = 30000
): Promise<{ stdout: string; stderr: string }> {
  const auth = domain ? `${domain}/${username}` : username
  const bin = await findImpacketBin('psexec')
  const svcName = `WinSvc${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  return new Promise((resolve, reject) => {
    const args = ['-service-name', svcName, '-remote-binary-name', `${svcName}.exe`, `${auth}:${password}@${target}`, command]
    const proc = execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message))
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
    setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  })
}

async function runWmiexec(
  target: string, username: string, password: string, domain: string | null,
  command: string, timeoutMs = 30000
): Promise<{ stdout: string; stderr: string }> {
  const auth = domain ? `${domain}/${username}` : username
  const bin = await findImpacketBin('wmiexec')
  return new Promise((resolve, reject) => {
    const args = [`${auth}:${password}@${target}`, command]
    const proc = execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message))
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
    setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  })
}

async function runWinrm(
  target: string, username: string, password: string, domain: string | null,
  command: string, timeoutMs = 30000, useHttps = false
): Promise<{ stdout: string; stderr: string }> {
  const user = domain ? `${domain}\\${username}` : username
  const port = useHttps ? 5986 : 5985
  const scheme = useHttps ? 'https' : 'http'
  const script = `
import winrm, sys
s = winrm.Session('${scheme}://${target}:${port}/wsman', auth=(${JSON.stringify(user)}, ${JSON.stringify(password)}), transport='ntlm', server_cert_validation='ignore')
r = s.run_ps(${JSON.stringify(command)})
sys.stdout.write(r.std_out.decode('utf-8','replace'))
sys.stderr.write(r.std_err.decode('utf-8','replace'))
sys.exit(r.status_code)
`
  return new Promise((resolve, reject) => {
    const proc = execFile('python3', ['-c', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && err.code !== 0 && !stdout) return reject(new Error(stderr || err.message))
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
    })
    setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  })
}

async function runCommand(
  method: ExecMethod,
  target: string, username: string, password: string, domain: string | null,
  command: string, timeoutMs = 30000
) {
  if (method === 'wmiexec') return runWmiexec(target, username, password, domain, command, timeoutMs)
  if (method === 'winrm')   return runWinrm(target, username, password, domain, command, timeoutMs)
  return runPsexec(target, username, password, domain, command, timeoutMs)
}

async function checkOnline(host: string): Promise<boolean> {
  try {
    await execFileAsync('ping', ['-c', '1', '-W', '1', host], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export default async function psexecRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /psexec/credentials — list all windows/RDP credentials for picker
  fastify.get('/psexec/credentials', { preHandler: [requireAuth, requirePermission('servers:read')] }, async () => {
    const rows = await (db as any)
      .selectFrom('server_credentials as c')
      .leftJoin('servers as s', 's.id', 'c.server_id')
      .select(['c.id', 'c.label', 'c.category', 'c.linux_user', 'c.service_username', 'c.notes', 's.name as server_name'])
      .where('c.is_archived', 'is not', true)
      .where('c.category', 'in', ['windows', 'rdp', 'other'])
      .where('s.is_active', 'is not', false)
      .execute()
    return { credentials: rows }
  })

  // POST /psexec/exec — run a command on a remote Windows machine
  fastify.post('/psexec/exec', { preHandler: [requireAuth, requirePermission('servers:write')] }, async (req, reply) => {
    const body = z.object({
      target:      z.string().min(1),
      cred_id:     z.string().uuid().optional(),
      username:    z.string().min(1).optional(),
      password:    z.string().min(1).optional(),
      domain:      z.string().optional(),
      command:     z.string().min(1).max(2000),
      timeout_sec: z.number().int().min(5).max(120).default(30),
      method:      z.enum(['psexec', 'wmiexec', 'winrm']).default('psexec'),
    }).parse(req.body)

    let username: string
    let password: string
    let domain: string | null = body.domain ?? null

    if (body.cred_id) {
      const vaultKey = getVaultKey()
      const cred = await (db as any)
        .selectFrom('server_credentials').selectAll()
        .where('id', '=', body.cred_id).executeTakeFirst() as any
      if (!cred) return reply.code(404).send({ error: 'Credential not found' })
      password  = decryptSecret(cred.password_enc, vaultKey)
      username  = cred.service_username ?? cred.linux_user ?? ''
      // parse domain from notes "Domain: pvd.local" or from linux_user "pvd.local\admin"
      if (!domain) {
        const noteDomain = cred.notes?.match(/^Domain:\s*(.+)$/im)?.[1]?.trim()
        if (noteDomain) domain = noteDomain
        else {
          const m = (cred.linux_user ?? '').match(/^(.+)[\\\/](.+)$/)
          if (m) { domain = m[1]; username = m[2] }
        }
      }
    } else if (body.username && body.password) {
      username = body.username
      password = body.password
    } else {
      return reply.code(400).send({ error: 'Provide cred_id or username+password' })
    }

    try {
      const result = await runCommand(body.method, body.target, username, password, domain, body.command, body.timeout_sec * 1000)

      await writeAuditLog({
        userId: (req.session.user as any)!.id,
        userEmail: (req.session.user as any)!.email,
        action: 'psexec.exec', resource: 'psexec', resourceId: undefined,
        details: { target: body.target, command: body.command, cred_id: body.cred_id, method: body.method },
        request: req,
      })

      return { ok: true, stdout: result.stdout, stderr: result.stderr }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // POST /psexec/ping — check if a host is reachable
  fastify.post('/psexec/ping', { preHandler: [requireAuth, requirePermission('servers:read')] }, async (req, reply) => {
    const { host } = z.object({ host: z.string().min(1) }).parse(req.body)
    const online = await checkOnline(host)
    return { online }
  })

  // WS /psexec/session — interactive shell (psexec / wmiexec / winrm)
  fastify.get('/psexec/session', { websocket: true }, async (connection, req) => {
    const ws = connection.socket as any
    const send = (msg: object) => { try { ws.send(JSON.stringify(msg)) } catch {} }

    try {
      if (!req.session.user) { send({ type: 'error', message: 'Unauthorized' }); ws.close(4001); return }

      const query = z.object({
        target:  z.string().min(1),
        cred_id: z.string().uuid(),
        method:  z.enum(['psexec', 'wmiexec', 'winrm']).default('psexec'),
      }).parse(req.query)

      const vaultKey = getVaultKey()
      const cred = await (db as any)
        .selectFrom('server_credentials').selectAll()
        .where('id', '=', query.cred_id).executeTakeFirst() as any
      if (!cred) { send({ type: 'error', message: 'Credential not found' }); ws.close(4003); return }

      const password = decryptSecret(cred.password_enc, vaultKey)
      let username: string = cred.service_username ?? cred.linux_user ?? ''
      let domain: string | null = cred.notes?.match(/^Domain:\s*(.+)$/im)?.[1]?.trim() ?? null
      const m = (cred.linux_user ?? '').match(/^(.+)[\\\/](.+)$/)
      if (m) { domain = m[1]; username = m[2] }

      let binExe: string
      let args: string[]

      if (query.method === 'winrm') {
        // evil-winrm for interactive WinRM shell
        const bin = await findEvilWinrm().catch(() => null)
        if (!bin) { send({ type: 'error', message: 'evil-winrm not found in container' }); ws.close(4002); return }
        const user = domain ? `${domain}\\${username}` : username
        binExe = bin
        args = ['-i', query.target, '-u', user, '-p', password]
      } else if (query.method === 'wmiexec') {
        const bin = await findImpacketBin('wmiexec').catch(() => null)
        if (!bin) { send({ type: 'error', message: 'impacket-wmiexec not found in container' }); ws.close(4002); return }
        const auth = domain ? `${domain}/${username}:${password}@${query.target}` : `${username}:${password}@${query.target}`
        binExe = bin.split(' ')[0]
        args = bin.startsWith('python3') ? [...bin.split(' ').slice(1), auth] : [auth]
      } else {
        // psexec (default)
        const bin = await findImpacketBin('psexec').catch(() => null)
        if (!bin) { send({ type: 'error', message: 'impacket-psexec not found in container' }); ws.close(4002); return }
        const auth = domain ? `${domain}/${username}:${password}@${query.target}` : `${username}:${password}@${query.target}`
        const svcName = `WinSvc${Math.random().toString(36).slice(2, 10).toUpperCase()}`
        binExe = bin.split(' ')[0]
        args = bin.startsWith('python3')
          ? [...bin.split(' ').slice(1), '-service-name', svcName, '-remote-binary-name', `${svcName}.exe`, auth]
          : ['-service-name', svcName, '-remote-binary-name', `${svcName}.exe`, auth]
      }

      const proc = spawn(binExe, args, {
        env: { ...process.env, TERM: 'xterm-256color', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      send({ type: 'connected', target: query.target, username, method: query.method })

      await writeAuditLog({
        userId: (req.session.user as any).id, userEmail: (req.session.user as any).email,
        action: 'psexec.session.started', resource: 'psexec', resourceId: undefined,
        details: { target: query.target, cred_id: query.cred_id, method: query.method }, request: req,
      })

      proc.stdout.on('data', (d: Buffer) => send({ type: 'output', data: d.toString('utf8') }))
      proc.stderr.on('data', (d: Buffer) => send({ type: 'output', data: d.toString('utf8') }))

      proc.on('close', (code) => {
        send({ type: 'disconnected', code })
        try { ws.close() } catch {}
        writeAuditLog({
          userId: (req.session.user as any).id, userEmail: (req.session.user as any).email,
          action: 'psexec.session.ended', resource: 'psexec', resourceId: undefined,
          details: { target: query.target, exit_code: code, method: query.method },
        })
      })

      let exiting = false
      const gracefulExit = () => {
        if (exiting) return; exiting = true
        try { proc.stdin.write('exit\n') } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 8000)
      }

      ws.on('message', (rawMsg: unknown) => {
        try {
          const msg = JSON.parse(String(rawMsg))
          if (msg.type === 'input') proc.stdin.write(msg.data)
          else if (msg.type === 'disconnect') gracefulExit()
          else if (msg.type === 'signal' && msg.signal === 'SIGKILL') try { proc.kill('SIGKILL') } catch {}
        } catch {}
      })

      ws.on('close', () => gracefulExit())

    } catch (err: any) {
      send({ type: 'error', message: err.message })
      ws.close(4000)
    }
  })

  // POST /psexec/ping-many — check multiple hosts at once
  fastify.post('/psexec/ping-many', { preHandler: [requireAuth, requirePermission('servers:read')] }, async (req, reply) => {
    const { hosts } = z.object({ hosts: z.array(z.string()).max(200) }).parse(req.body)
    const results = await Promise.all(
      hosts.map(async host => ({ host, online: await checkOnline(host) }))
    )
    return { results }
  })
}
