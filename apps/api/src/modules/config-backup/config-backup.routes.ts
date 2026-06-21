import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createReadStream, existsSync } from 'fs'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'
import { withServerSsh } from '../../utils/server-ssh'
import { Client } from 'ssh2'
import { decryptSecret, getVaultKey } from '../../utils/vault'

const BACKUP_ROOT = process.env.TFTP_ROOT
  ? path.join(process.env.TFTP_ROOT, 'configs')
  : '/var/lib/ssh-manager/tftp-root/configs'

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

// SSH exec helper
function sshExec(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      const chunks: Buffer[] = []
      stream.on('data', (d: Buffer) => chunks.push(d))
      stream.stderr.on('data', () => {}) // ignore stderr
      stream.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
  })
}

// Device-specific config pull command based on os_type / vendor
function configCommand(osType: string | null, vendor: string | null): string {
  const os = (osType ?? '').toLowerCase()
  const v  = (vendor ?? '').toLowerCase()

  if (v.includes('mikrotik') || v.includes('routeros'))  return '/export'
  if (v.includes('fortinet') || v.includes('fortigate')) return 'show'
  if (v.includes('ubiquiti') || v.includes('unifi'))     return 'cat /tmp/system.cfg 2>/dev/null || mca-ctrl -t dump-cfg'
  if (v.includes('cisco') || v.includes('isr') || v.includes('catalyst')) return 'show running-config'
  if (v.includes('juniper'))   return 'show configuration'
  if (v.includes('aruba') || v.includes('hpe')) return 'show running-config'
  if (v.includes('dahua') || v.includes('hikvision')) return 'cat /etc/camera.conf 2>/dev/null || echo "no config file"'

  // Fallback by os_type
  if (os === 'router' || os === 'switch' || os === 'switch-l3' || os === 'firewall' || os === 'utm') return 'show running-config'
  if (os === 'access-point' || os === 'wireless-controller') return 'show running-config'

  // Windows — requires OpenSSH (available on Server 2019+ by default)
  if (os === 'windows') return [
    'echo "=== OS Version ===" && (Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsHardwareAbstractionLayer | Format-List | Out-String) 2>$null || cmd /c ver',
    'echo "=== Installed Roles ===" && (Get-WindowsFeature | Where-Object {$_.InstallState -eq "Installed"} | Select-Object Name,DisplayName | Format-Table -Auto | Out-String) 2>$null || echo "n/a"',
    'echo "=== Network Config ===" && (Get-NetIPAddress | Select-Object InterfaceAlias,IPAddress,PrefixLength | Format-Table -Auto | Out-String) 2>$null || ipconfig /all',
    'echo "=== Firewall Rules (enabled) ===" && (Get-NetFirewallRule | Where-Object {$_.Enabled -eq "True"} | Select-Object DisplayName,Direction,Action | Format-Table -Auto | Out-String) 2>$null || echo "n/a"',
    'echo "=== Scheduled Tasks ===" && (Get-ScheduledTask | Where-Object {$_.State -ne "Disabled"} | Select-Object TaskName,TaskPath,State | Format-Table -Auto | Out-String) 2>$null || echo "n/a"',
    'echo "=== Installed Software ===" && (Get-Package | Select-Object Name,Version | Format-Table -Auto | Out-String) 2>$null || (wmic product get name,version /format:csv 2>nul)',
    'echo "=== Services (Running) ===" && (Get-Service | Where-Object {$_.Status -eq "Running"} | Select-Object Name,DisplayName | Format-Table -Auto | Out-String) 2>$null || echo "n/a"',
    'echo "=== Hosts File ===" && (Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts) 2>$null || echo "n/a"',
  ].join('; ')

  // Linux — comprehensive /etc/ and system state backup
  return [
    'echo "=== OS Release ==="',
    'cat /etc/os-release 2>/dev/null || cat /etc/issue',
    'uname -r',
    'echo "=== Hostname & DNS ==="',
    'hostname -f 2>/dev/null; cat /etc/hosts; cat /etc/resolv.conf 2>/dev/null',
    'echo "=== Network Interfaces ==="',
    'ip addr show; ip route show',
    'echo "=== Firewall ==="',
    'iptables-save 2>/dev/null || echo "n/a"; ip6tables-save 2>/dev/null || echo "n/a"',
    'echo "=== /etc/fstab ==="',
    'cat /etc/fstab 2>/dev/null || echo "n/a"',
    'echo "=== SSH Config ==="',
    'cat /etc/ssh/sshd_config 2>/dev/null || echo "n/a"',
    'echo "=== Crontabs ==="',
    'crontab -l 2>/dev/null || echo "(empty)"; ls /etc/cron.d/ 2>/dev/null && cat /etc/cron.d/* 2>/dev/null || echo "(none)"',
    'echo "=== Systemd Services (enabled) ==="',
    'systemctl list-unit-files --type=service --state=enabled 2>/dev/null || service --status-all 2>/dev/null | head -40',
    'echo "=== Installed Packages ==="',
    'dpkg -l 2>/dev/null | grep "^ii" || rpm -qa 2>/dev/null || apk info 2>/dev/null',
    'echo "=== Open Ports ==="',
    'ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null || echo "n/a"',
    'echo "=== Web Server Config ==="',
    'cat /etc/nginx/nginx.conf 2>/dev/null || cat /etc/apache2/apache2.conf 2>/dev/null || echo "(none)"',
  ].join('; ')
}

export default async function configBackupRoutes(fastify: FastifyInstance) {
  // ── List backups (all or per server) ────────────────────────────────────────
  fastify.get('/config-backups', { preHandler: requireAuth }, async (req) => {
    const { server_id } = (req.query as any)

    let query = db
      .selectFrom('config_backups')
      .innerJoin('servers', 'servers.id', 'config_backups.server_id')
      .select([
        'config_backups.id',
        'config_backups.server_id',
        'servers.name as server_name',
        'servers.os_type',
        'servers.environment',
        'config_backups.filename',
        'config_backups.file_size',
        'config_backups.backup_method',
        'config_backups.status',
        'config_backups.error_message',
        'config_backups.content_preview',
        'config_backups.created_at',
      ])
      .orderBy('config_backups.created_at desc')

    if (server_id) {
      query = query.where('config_backups.server_id', '=', server_id) as typeof query
    }

    return query.execute()
  })

  // ── Pull config via SSH ──────────────────────────────────────────────────────
  fastify.post('/servers/:id/config-backup', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const server = await db
      .selectFrom('servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    if (!server) return reply.status(404).send({ error: 'Server not found' })

    const dir = path.join(BACKUP_ROOT, id)
    await ensureDir(dir)

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `${ts}.cfg`
    const filePath = path.join(dir, filename)

    let content = ''
    let backupMethod = 'ssh-pull'
    let errorMessage: string | null = null

    try {
      // Try management key first (works for Linux servers + network devices with key auth)
      if (server.management_key_id) {
        content = await withServerSsh(id, async (client) => {
          const vendor = (server as any).snmp_vendor as string | null
          const cmd = configCommand(server.os_type, vendor)
          return sshExec(client, cmd)
        })
      } else if ((server as any).access_ssh_auth_type === 'password') {
        // Password-based SSH for network devices
        const vaultKey = getVaultKey()

        // Find SSH credential linked to this server
        const cred = await db
          .selectFrom('server_credentials')
          .selectAll()
          .where('server_id', '=', id)
          .where('category', '=', 'linux')
          .orderBy('created_at desc')
          .executeTakeFirst()

        if (!cred) throw new Error('No SSH credentials found. Configure SSH access in the device profile.')

        const password = decryptSecret(cred.password_enc, vaultKey)
        const username = cred.linux_user ?? server.management_linux_user ?? 'admin'

        content = await new Promise<string>((resolve, reject) => {
          const client = new Client()
          client.once('ready', () => {
            const vendor = (server as any).snmp_vendor as string | null
            const cmd = configCommand(server.os_type, vendor)
            client.exec(cmd, (err, stream) => {
              if (err) { client.end(); return reject(err) }
              const chunks: Buffer[] = []
              stream.on('data', (d: Buffer) => chunks.push(d))
              stream.stderr.on('data', () => {})
              stream.on('close', () => { client.end(); resolve(Buffer.concat(chunks).toString('utf8')) })
            })
          })
          client.once('error', reject)
          client.connect({
            host: server.hostname,
            port: server.ssh_port ?? 22,
            username,
            password,
            readyTimeout: 10000,
          })
        })
      } else {
        throw new Error('No SSH access configured. Add a management key or SSH credential to this device.')
      }
    } catch (e: any) {
      errorMessage = e?.message ?? String(e)
    }

    // Save file even if empty (so we record the attempt)
    await fs.writeFile(filePath, content)
    const stat = await fs.stat(filePath)

    const preview = content.slice(0, 800).replace(/\r\n/g, '\n')

    const row = await db
      .insertInto('config_backups')
      .values({
        server_id: id,
        filename,
        file_path: filePath,
        file_size: stat.size,
        backup_method: backupMethod,
        status: errorMessage ? 'error' : 'ok',
        error_message: errorMessage,
        content_preview: errorMessage ? null : preview,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    if (errorMessage) {
      return reply.status(500).send({ error: errorMessage, backup: row })
    }

    return { ok: true, backup: row }
  })

  // ── Manual upload ────────────────────────────────────────────────────────────
  fastify.post('/config-backups/upload', { preHandler: requireAuth }, async (req, reply) => {
    const parts = req.parts()
    let server_id = ''
    let fileBuffer: Buffer | null = null
    let originalFilename = ''

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'server_id') server_id = String(part.value)
      else if (part.type === 'file') {
        originalFilename = part.filename
        const chunks: Buffer[] = []
        for await (const chunk of part.file) chunks.push(chunk)
        fileBuffer = Buffer.concat(chunks)
      }
    }

    if (!server_id || !fileBuffer) return reply.status(400).send({ error: 'server_id and file required' })

    const dir = path.join(BACKUP_ROOT, server_id)
    await ensureDir(dir)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `${ts}_${originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}`
    const filePath = path.join(dir, filename)
    await fs.writeFile(filePath, fileBuffer)

    const content = fileBuffer.toString('utf8', 0, Math.min(fileBuffer.length, 800))
    const row = await db
      .insertInto('config_backups')
      .values({
        server_id,
        filename,
        file_path: filePath,
        file_size: fileBuffer.length,
        backup_method: 'manual',
        status: 'ok',
        content_preview: content,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return row
  })

  // ── Download backup ──────────────────────────────────────────────────────────
  fastify.get('/config-backups/:id/download', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bk = await db.selectFrom('config_backups').selectAll().where('id', '=', id).executeTakeFirst()
    if (!bk) return reply.status(404).send({ error: 'Not found' })
    if (!existsSync(bk.file_path)) return reply.status(404).send({ error: 'File not on disk' })

    reply.header('Content-Disposition', `attachment; filename="${bk.filename}"`)
    reply.header('Content-Type', 'text/plain')
    return reply.send(createReadStream(bk.file_path))
  })

  // ── Diff with previous backup ─────────────────────────────────────────────────
  fastify.get('/config-backups/:id/diff', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bk = await db.selectFrom('config_backups').selectAll().where('id', '=', id).executeTakeFirst()
    if (!bk) return reply.status(404).send({ error: 'Not found' })

    // Find previous backup for same server
    const prev = await db
      .selectFrom('config_backups')
      .selectAll()
      .where('server_id', '=', bk.server_id)
      .where('status', '=', 'ok')
      .where('created_at', '<', bk.created_at as any)
      .orderBy('created_at desc')
      .executeTakeFirst()

    const readFileSafe = async (p: string) => {
      try { return (await fs.readFile(p, 'utf8')).split('\n') } catch { return [] }
    }

    const aLines = prev ? await readFileSafe(prev.file_path) : []
    const bLines = await readFileSafe(bk.file_path)

    // Compute unified diff (simple implementation)
    const diff = computeDiff(aLines, bLines, prev?.filename ?? '(none)', bk.filename)

    return {
      current: { id: bk.id, filename: bk.filename, created_at: bk.created_at },
      previous: prev ? { id: prev.id, filename: prev.filename, created_at: prev.created_at } : null,
      diff,
      unchanged: diff.every(l => l.type === 'context'),
    }
  })

  // ── Delete backup ────────────────────────────────────────────────────────────
  fastify.delete('/config-backups/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bk = await db.selectFrom('config_backups').selectAll().where('id', '=', id).executeTakeFirst()
    if (!bk) return reply.status(404).send({ error: 'Not found' })
    await db.deleteFrom('config_backups').where('id', '=', id).execute()
    try { await fs.unlink(bk.file_path) } catch {}
    return { ok: true }
  })
}

// Simple line-by-line diff (LCS-based)
type DiffLine = { type: 'add' | 'remove' | 'context'; line: string; lineNum?: number }

function computeDiff(a: string[], b: string[], _aFile: string, _bFile: string): DiffLine[] {
  // Myers diff — O(ND) simplified to patience-style for readability
  // Using a simple scan approach sufficient for config files
  const result: DiffLine[] = []
  const CONTEXT = 3

  // Build LCS table
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])

  // Trace back
  const ops: DiffLine[] = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      ops.push({ type: 'context', line: a[i], lineNum: j + 1 })
      i++; j++
    } else if (j < n && (i >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      ops.push({ type: 'add', line: b[j], lineNum: j + 1 })
      j++
    } else {
      ops.push({ type: 'remove', line: a[i] })
      i++
    }
  }

  // Apply context windowing (only show CONTEXT lines around changes)
  const changed = new Set<number>()
  ops.forEach((op, idx) => { if (op.type !== 'context') { for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) changed.add(k) } })

  let lastIncluded = -1
  ops.forEach((op, idx) => {
    if (changed.has(idx)) {
      if (lastIncluded >= 0 && idx > lastIncluded + 1) result.push({ type: 'context', line: '...' })
      result.push(op)
      lastIncluded = idx
    }
  })

  return result
}
