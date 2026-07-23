import { FastifyInstance } from 'fastify'
import { Client, SFTPWrapper } from 'ssh2'
import { z } from 'zod'
import * as path from 'path'
import { requireAuth } from '../../middleware/auth'
import { withServerSsh } from '../../utils/server-ssh'
import { writeAuditLog } from '../../utils/audit'
import { requireTotpElevation } from '../../utils/totp-guard'

function normalizeSshPath(input: string): string {
  return path.posix.normalize('/' + input).replace(/\/+$/, '') || '/'
}

function shellEscape(p: string): string {
  return normalizeSshPath(p).replace(/'/g, "'\\''")
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, sftp) => err ? reject(err) : resolve(sftp)))
}

function sftpMkdirP(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.mkdir(dirPath, (err) => {
      if (!err || (err as NodeJS.ErrnoException).code === 'EEXIST') return resolve()
      // Try creating parent first
      const parent = path.posix.dirname(dirPath)
      if (parent === dirPath) return resolve()
      sftpMkdirP(sftp, parent).then(() =>
        sftp.mkdir(dirPath, () => resolve())
      )
    })
  })
}

function sftpWrite(sftp: SFTPWrapper, destPath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.open(destPath, 'w', (err, fd) => {
      if (err) return reject(err)
      sftp.write(fd, data, 0, data.length, 0, (werr) => {
        sftp.close(fd, () => werr ? reject(werr) : resolve())
      })
    })
  })
}

function sftpReadFile(sftp: SFTPWrapper, srcPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.stat(srcPath, (serr, stat) => {
      if (serr) return reject(serr)
      const buf = Buffer.allocUnsafe(stat.size)
      sftp.open(srcPath, 'r', (oerr, fd) => {
        if (oerr) return reject(oerr)
        sftp.read(fd, buf, 0, stat.size, 0, (rerr) => {
          sftp.close(fd, () => rerr ? reject(rerr) : resolve(buf))
        })
      })
    })
  })
}

// Pipe stdout of srcCmd on srcClient into stdin of dstCmd on dstClient
function pipeSsh(srcClient: Client, srcCmd: string, dstClient: Client, dstCmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    dstClient.exec(dstCmd, { pty: false }, (derr, dstStream) => {
      if (derr) return reject(derr)
      srcClient.exec(srcCmd, { pty: false }, (serr, srcStream) => {
        if (serr) { dstStream.close(); return reject(serr) }
        srcStream.pipe(dstStream.stdin)
        srcStream.on('close', () => dstStream.stdin.end())
        srcStream.stderr.on('data', () => {})
        dstStream.on('close', (code: number) => {
          if (code !== 0) return reject(new Error(`Copy command exited with code ${code}`))
          resolve()
        })
        dstStream.stderr.on('data', () => {})
        dstStream.on('error', reject)
        srcStream.on('error', reject)
      })
    })
  })
}

function exec(client: Client, cmd: string): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return reject(err)
      let out = '', errOut = ''
      stream.on('data', (d: Buffer) => { out += d.toString() })
      stream.stderr?.on('data', (d: Buffer) => { errOut += d.toString() })
      stream.on('close', (code: number) => resolve({ stdout: out, code: code ?? 0, stderr: errOut }))
      stream.on('error', reject)
    })
  })
}

// ── POSIX ACL helpers ──────────────────────────────────────────────────────

type AclEntry = {
  default: boolean
  qualifier: 'user' | 'group' | 'mask' | 'other'
  name: string | null   // null for the owning-user/owning-group/mask/other entries
  perms: string          // e.g. "rwx", "r-x"
  effective?: string     // getfacl appends "#effective:r-x" when the mask trims perms
}

// getfacl output looks like:
//   # file: home/bob
//   # owner: bob
//   # group: bob
//   user::rwx
//   user:alice:r-x
//   group::r-x
//   group:devs:rwx                 #effective:r-x
//   mask::r-x
//   other::---
//   default:user::rwx
function parseAclOutput(stdout: string): { owner: string; group: string; entries: AclEntry[] } {
  let owner = '', group = ''
  const entries: AclEntry[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('# owner:')) { owner = line.slice(8).trim(); continue }
    if (line.startsWith('# group:')) { group = line.slice(8).trim(); continue }
    if (line.startsWith('#')) continue

    const isDefault = line.startsWith('default:')
    const rest = isDefault ? line.slice('default:'.length) : line
    const [effPart, effectiveNote] = rest.split('#effective:')
    const parts = effPart.split(':')
    if (parts.length < 3) continue
    const [qualifier, name, perms] = parts
    if (!['user', 'group', 'mask', 'other'].includes(qualifier)) continue
    entries.push({
      default: isDefault,
      qualifier: qualifier as AclEntry['qualifier'],
      name: name ? name.trim() : null,
      perms: perms.trim(),
      effective: effectiveNote?.trim(),
    })
  }
  return { owner, group, entries }
}

const PERMS_RE = /^[r-][w-][x-]$/
// Linux usernames/groups: start with letter/underscore, then letters/digits/underscore/hyphen, optional trailing $
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}\$?$/

async function fsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /servers/:id/fs/ls?path= â€” list directory
  fastify.get('/servers/:id/fs/ls', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: dirPath } = z.object({ path: z.string().default('/') }).parse(req.query)

    try {
      const result = await withServerSsh(id, async (client) => {
        const safe = shellEscape(dirPath)
        const { stdout, code } = await exec(client,
          `ls -la --time-style='+%Y-%m-%d %H:%M:%S' '${safe}' 2>&1`
        )
        if (code !== 0) {
          throw new Error(stdout.trim() || `Cannot list ${dirPath}`)
        }

        // Parse ls -la output
        const lines = stdout.split('\n').filter(Boolean)
        const entries: Array<{
          name: string; type: 'dir' | 'file' | 'link' | 'other'
          permissions: string; owner: string; size: number; modified: string
        }> = []

        for (const line of lines) {
          if (line.startsWith('total') || !line.trim()) continue
          // Format: permissions links owner group size date time name [-> target]
          const m = line.match(/^([dlrwx\-]+)\s+\d+\s+(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.+)$/)
          if (!m) continue
          const [, perms, owner, sizeStr, modified, nameRaw] = m
          let name = nameRaw.trim()
          let type: 'dir' | 'file' | 'link' | 'other' = 'file'

          if (perms[0] === 'd') type = 'dir'
          else if (perms[0] === 'l') {
            type = 'link'
            name = name.split(' -> ')[0]
          } else if (perms[0] !== '-') type = 'other'

          if (name === '.' || name === '..') continue
          entries.push({ name, type, permissions: perms, owner, size: parseInt(sizeStr) || 0, modified })
        }

        // Get parent path
        const parentPath = dirPath === '/' ? '/' : dirPath.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/'
        return { path: dirPath, parent: parentPath, entries }
      })
      return result
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // GET /servers/:id/fs/read?path= â€” read file content
  fastify.get('/servers/:id/fs/read', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: filePath } = z.object({ path: z.string() }).parse(req.query)

    try {
      const result = await withServerSsh(id, async (client) => {
        const safe = shellEscape(filePath)

        // Check size
        const { stdout: sizeOut } = await exec(client, `stat -c%s '${safe}' 2>/dev/null || stat -f%z '${safe}' 2>/dev/null`)
        const size = parseInt(sizeOut.trim()) || 0
        if (size > 25 * 1024 * 1024) {
          throw new Error(`File too large to open (${Math.round(size / 1024 / 1024)}MB, max 25MB). Use Download instead.`)
        }

        // Check mime type
        const { stdout: mimeOut } = await exec(client, `file -b --mime-type '${safe}' 2>/dev/null || echo 'text/plain'`)
        const mime = mimeOut.trim()
        const isBinary = !['text/', 'application/json', 'application/xml', 'application/javascript',
          'application/x-sh', 'application/x-yaml', 'image/svg'].some((t) => mime.startsWith(t))

        if (isBinary) return { content: null, binary: true, mime, size }

        const { stdout: content, code } = await exec(client, `cat '${safe}'`)
        if (code !== 0) throw new Error(`Cannot read file: ${filePath}`)
        return { content, binary: false, mime, size }
      })
      return result
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/fs/write â€” create or overwrite a file (optionally archive first)
  fastify.post('/servers/:id/fs/write', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      path: z.string(),
      content: z.string(),
      archive: z.boolean().default(false),
    }).parse(req.body)

    try {
      let archivedTo: string | null = null
      await withServerSsh(id, async (client) => {
        const safe = shellEscape(body.path)
        const sftp = await getSftp(client)

        // Archive existing file before overwriting â€” check existence via stdout, not exit code
        if (body.archive) {
          const { stdout: existOut } = await exec(client, `[ -f '${safe}' ] && echo yes || echo no`)
          if (existOut.trim() === 'yes') {
            const basename = path.posix.basename(body.path)
            const dir = path.posix.dirname(body.path)
            const { stdout: tsOut } = await exec(client, "date +'%Y-%m-%dT%H-%M-%S'")
            const ts = tsOut.trim() || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const versionDir = `${dir}/.versions`
            const safeVDir = shellEscape(versionDir)
            const versionFile = `${versionDir}/${basename}.${ts}`
            const safeVFile = shellEscape(versionFile)
            const { code: cpCode, stderr: cpErr } = await exec(client,
              `mkdir -p '${safeVDir}' && cp '${safe}' '${safeVFile}'`
            )
            if (cpCode === 0) archivedTo = versionFile
            else console.warn(`[fs] archive failed: ${cpErr}`)
          }
        }

        // Write via SFTP â€” avoids shell arg-length limits and is reliable for any file size
        await sftpWrite(sftp, body.path, Buffer.from(body.content, 'utf8'))

        // For new files (first save), archive AFTER writing so we capture the initial version
        if (body.archive && !archivedTo) {
          const basename = path.posix.basename(body.path)
          const dir = path.posix.dirname(body.path)
          const { stdout: tsOut2 } = await exec(client, "date +'%Y-%m-%dT%H-%M-%S'")
          const ts = tsOut2.trim() || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const versionDir = `${dir}/.versions`
          const safeVDir = shellEscape(versionDir)
          const safe2 = shellEscape(body.path)
          const versionFile = `${versionDir}/${basename}.${ts}`
          const safeVFile = shellEscape(versionFile)
          const { code: cpCode, stderr: cpErr } = await exec(client,
            `mkdir -p '${safeVDir}' && cp '${safe2}' '${safeVFile}'`
          )
          if (cpCode === 0) archivedTo = versionFile
          else console.warn(`[fs] first-save archive failed: ${cpErr}`)
        }
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.write', resource: 'file', serverId: id,
        details: { path: body.path, archived_to: archivedTo }, request: req,
      })
      return { ok: true, archived_to: archivedTo }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // GET /servers/:id/fs/versions?path= â€” list archived versions of a file
  fastify.get('/servers/:id/fs/versions', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: filePath } = z.object({ path: z.string() }).parse(req.query)

    try {
      const versions = await withServerSsh(id, async (client) => {
        const basename = path.posix.basename(filePath)
        const dir = path.posix.dirname(filePath)
        const versionDir = `${dir}/.versions`
        const safeVDir = shellEscape(versionDir)
        const safeBase = basename.replace(/'/g, "'\\''")

        const { stdout, code } = await exec(client,
          `ls -lt --time-style='+%Y-%m-%d %H:%M:%S' '${safeVDir}' 2>/dev/null | grep '${safeBase}\\.' | head -30`
        )
        if (code !== 0 || !stdout.trim()) return []

        return stdout.trim().split('\n').filter(Boolean).map((line) => {
          const m = line.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.+)$/)
          if (!m) return null
          const [, , sizeStr, modified, name] = m
          return { name: name.trim(), path: `${versionDir}/${name.trim()}`, size: parseInt(sizeStr) || 0, modified }
        }).filter(Boolean)
      })
      return versions
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/fs/restore-version â€” restore an archived version
  fastify.post('/servers/:id/fs/restore-version', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      version_path: z.string(),
      target_path: z.string(),
    }).parse(req.body)

    try {
      let archivedTo: string | null = null
      await withServerSsh(id, async (client) => {
        const safeTarget = shellEscape(body.target_path)
        const safeVersion = shellEscape(body.version_path)

        // Archive the current file first
        const { stdout: existOut } = await exec(client, `[ -f '${safeTarget}' ] && echo yes || echo no`)
        if (existOut.trim() === 'yes') {
          const basename = path.posix.basename(body.target_path)
          const dir = path.posix.dirname(body.target_path)
          const { stdout: tsOut } = await exec(client, "date +'%Y-%m-%dT%H-%M-%S'")
          const ts = tsOut.trim() || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const versionDir = `${dir}/.versions`
          const safeVDir = shellEscape(versionDir)
          const versionFile = `${versionDir}/${basename}.${ts}`
          const safeVFile = shellEscape(versionFile)
          await exec(client, `mkdir -p '${safeVDir}' && cp '${safeTarget}' '${safeVFile}'`)
          archivedTo = versionFile
        }

        // Restore
        const { code, stderr } = await exec(client, `cp '${safeVersion}' '${safeTarget}' 2>&1`)
        if (code !== 0) throw new Error(stderr.trim() || 'Restore failed')
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.restore_version', resource: 'file', serverId: id,
        details: { from: body.version_path, to: body.target_path, archived_current: archivedTo }, request: req,
      })
      return { ok: true, archived_current_to: archivedTo }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/fs/mkdir â€” create directory
  fastify.post('/servers/:id/fs/mkdir', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: dirPath } = z.object({ path: z.string() }).parse(req.body)

    try {
      await withServerSsh(id, async (client) => {
        const safe = shellEscape(dirPath)
        const { code, stderr } = await exec(client, `mkdir -p '${safe}' 2>&1`)
        if (code !== 0) throw new Error(stderr.trim() || `mkdir failed`)
      })
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/fs/rename â€” rename or move
  fastify.post('/servers/:id/fs/rename', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { from: fromPath, to: toPath } = z.object({ from: z.string(), to: z.string() }).parse(req.body)

    try {
      await withServerSsh(id, async (client) => {
        const safeFrom = shellEscape(fromPath)
        const safeTo = shellEscape(toPath)
        const { code, stderr } = await exec(client, `mv '${safeFrom}' '${safeTo}' 2>&1`)
        if (code !== 0) throw new Error(stderr.trim() || `Rename failed`)
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.rename', resource: 'file', serverId: id,
        details: { from: fromPath, to: toPath }, request: req,
      })
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // DELETE /servers/:id/fs/delete?path= â€” delete file or directory
  fastify.delete('/servers/:id/fs/delete', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: targetPath } = z.object({ path: z.string() }).parse(req.query)

    // Safety: never allow deleting root-level critical paths
    const FORBIDDEN = ['/', '/etc', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run']
    if (FORBIDDEN.includes(targetPath.replace(/\/$/, ''))) {
      return reply.code(400).send({ error: `Refusing to delete protected path: ${targetPath}` })
    }

    try {
      await withServerSsh(id, async (client) => {
        const safe = shellEscape(targetPath)
        const { code, stderr } = await exec(client, `rm -rf '${safe}' 2>&1`)
        if (code !== 0) throw new Error(stderr.trim() || `Delete failed`)
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.delete', resource: 'file', serverId: id,
        details: { path: targetPath }, request: req,
      })
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // ── POSIX ACLs ─────────────────────────────────────────────────────────────

  // GET /servers/:id/fs/acl?path= — read the ACL for a file or directory.
  // Read-only, no TOTP gate — matches fs/ls (browsing is not privileged).
  fastify.get('/servers/:id/fs/acl', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: targetPath } = z.object({ path: z.string() }).parse(req.query)

    try {
      const result = await withServerSsh(id, async (client) => {
        const safe = shellEscape(targetPath)
        // -p: don't strip a leading slash from displayed paths (keeps them absolute)
        // Note: NOT redirecting stderr into stdout here — exec() already captures
        // them separately, and merging them would make error detection below
        // blind (stderr always empty) while corrupting stdout with noise.
        const { stdout, code, stderr } = await exec(client, `getfacl -p '${safe}'`)
        if (code !== 0) {
          if (/command not found/i.test(stderr)) {
            throw new Error('getfacl is not installed on this server (package "acl")')
          }
          throw new Error(stderr.trim() || 'Failed to read ACL')
        }
        const { isDir } = await exec(client, `[ -d '${safe}' ] && echo D || echo F`)
          .then((r) => ({ isDir: r.stdout.trim() === 'D' }))
        return { ...parseAclOutput(stdout), isDir, raw: stdout }
      })
      return result
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/fs/acl — add or modify one ACL entry.
  // Body: { path, qualifier: 'user'|'group', name, perms: 'rwx', default?, recursive? }
  fastify.post('/servers/:id/fs/acl', {
    preHandler: [requireAuth, requireTotpElevation('fs_acl_modify')],
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      path: z.string().min(1),
      qualifier: z.enum(['user', 'group']),
      name: z.string().regex(NAME_RE, 'Invalid username/group name'),
      perms: z.string().regex(PERMS_RE, 'Perms must be 3 chars, each r/w/x or -'),
      isDefault: z.boolean().optional().default(false),
      recursive: z.boolean().optional().default(false),
    }).parse(req.body)

    try {
      await withServerSsh(id, async (client) => {
        const safe = shellEscape(body.path)
        const q = body.qualifier === 'user' ? 'u' : 'g'
        const spec = `${body.isDefault ? 'd:' : ''}${q}:${body.name}:${body.perms}`
        const recFlag = body.recursive ? '-R ' : ''
        const { code, stderr } = await exec(client, `setfacl ${recFlag}-m '${spec}' '${safe}' 2>&1`)
        if (code !== 0) throw new Error(stderr.trim() || 'setfacl failed')
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.acl_set', resource: 'file', serverId: id,
        details: { path: body.path, qualifier: body.qualifier, name: body.name, perms: body.perms, isDefault: body.isDefault, recursive: body.recursive },
        request: req,
      })
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // DELETE /servers/:id/fs/acl — remove one ACL entry.
  // Query: path, qualifier, name, default?, recursive?
  fastify.delete('/servers/:id/fs/acl', {
    preHandler: [requireAuth, requireTotpElevation('fs_acl_modify')],
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const q = z.object({
      path: z.string().min(1),
      qualifier: z.enum(['user', 'group']),
      name: z.string().regex(NAME_RE, 'Invalid username/group name'),
      isDefault: z.coerce.boolean().optional().default(false),
      recursive: z.coerce.boolean().optional().default(false),
    }).parse(req.query)

    try {
      await withServerSsh(id, async (client) => {
        const safe = shellEscape(q.path)
        const qual = q.qualifier === 'user' ? 'u' : 'g'
        const spec = `${q.isDefault ? 'd:' : ''}${qual}:${q.name}`
        const recFlag = q.recursive ? '-R ' : ''
        const { code, stderr } = await exec(client, `setfacl ${recFlag}-x '${spec}' '${safe}' 2>&1`)
        if (code !== 0) throw new Error(stderr.trim() || 'setfacl failed')
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.acl_remove', resource: 'file', serverId: id,
        details: { path: q.path, qualifier: q.qualifier, name: q.name, isDefault: q.isDefault, recursive: q.recursive },
        request: req,
      })
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // GET /servers/:id/fs/search?path=&q=&mode=name|content â€” live search
  fastify.get('/servers/:id/fs/search', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: basePath, q, mode } = z.object({
      path: z.string().default('/'),
      q: z.string().min(1).max(200),
      mode: z.enum(['name', 'content']).default('name'),
    }).parse(req.query)

    try {
      const results = await withServerSsh(id, async (client) => {
        const safeBase = shellEscape(basePath)
        const safeQ = q.replace(/'/g, "'\\''").replace(/"/g, '\\"')

        let cmd: string
        if (mode === 'name') {
          cmd = `find '${safeBase}' -maxdepth 6 -name "*${safeQ}*" 2>/dev/null | head -100`
        } else {
          cmd = `grep -rl --include='*' --max-depth=6 "${safeQ}" '${safeBase}' 2>/dev/null | head -100`
        }

        const { stdout } = await exec(client, cmd)
        const lines = stdout.split('\n').filter(Boolean)

        if (mode === 'content' && lines.length > 0) {
          // Get line matches for content mode
          const safeLines = lines.slice(0, 20).map((f) => f.replace(/'/g, "'\\''")).join("' '")
          const { stdout: grepOut } = await exec(client,
            `grep -n "${safeQ}" '${safeLines}' 2>/dev/null | head -200`
          )
          return { mode, matches: lines, grep_lines: grepOut.split('\n').filter(Boolean) }
        }

        return { mode, matches: lines, grep_lines: [] }
      })
      return results
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/fs/lint?path= â€” syntax check
  fastify.post('/servers/:id/fs/lint', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: filePath } = z.object({ path: z.string() }).parse(req.body)

    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const safe = shellEscape(filePath)
    const lintCmds: Record<string, string> = {
      php: `php -l '${safe}' 2>&1`,
      py: `python3 -m py_compile '${safe}' 2>&1 && echo OK`,
      js: `node --check '${safe}' 2>&1 && echo OK`,
      sh: `bash -n '${safe}' 2>&1 && echo OK`,
      json: `python3 -c "import json,sys; json.load(open(sys.argv[1]))" '${safe}'  2>&1 && echo OK`,
      yaml: `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" '${safe}'  2>&1 && echo OK`,
      yml: `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" '${safe}'  2>&1 && echo OK`,
    }

    if (!lintCmds[ext]) return { supported: false, output: '', ok: true }

    try {
      const result = await withServerSsh(id, async (client) => {
        const { stdout, code } = await exec(client, lintCmds[ext])
        return { supported: true, output: stdout.trim(), ok: code === 0 || stdout.includes('OK') }
      })
      return result
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:id/fs/upload?path= â€” upload files via SFTP (multipart)
  // Each part: field "file", filename = relative path within upload (e.g. "subdir/file.txt")
  fastify.post('/servers/:id/fs/upload', {
    preHandler: requireAuth,
    config: { rateLimit: false },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: destDir } = z.object({ path: z.string().default('/tmp') }).parse(req.query)

    const parts = req.parts({ limits: { fileSize: 500 * 1024 * 1024 } })

    type UploadedFile = { relativePath: string; data: Buffer }
    const files: UploadedFile[] = []

    for await (const part of parts) {
      if (part.type !== 'file') continue
      const chunks: Buffer[] = []
      for await (const chunk of part.file) chunks.push(chunk)
      // filename holds the relative path (sent by frontend)
      const relativePath = decodeURIComponent(part.filename ?? part.fieldname ?? 'upload')
      files.push({ relativePath, data: Buffer.concat(chunks) })
    }

    if (files.length === 0) return reply.code(400).send({ error: 'No files received' })

    try {
      const results = await withServerSsh(id, async (client) => {
        const sftp = await getSftp(client)
        const written: string[] = []
        for (const f of files) {
          // Sanitize relative path: strip leading slashes/dots
          const safePart = f.relativePath.replace(/^[./\\]+/, '').replace(/\.\./g, '')
          const destPath = path.posix.join(destDir, safePart)
          const destParent = path.posix.dirname(destPath)
          await sftpMkdirP(sftp, destParent)
          await sftpWrite(sftp, destPath, f.data)
          written.push(destPath)
        }
        return written
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.upload', resource: 'file', serverId: id,
        details: { dest: destDir, count: results.length }, request: req,
      })
      return { ok: true, written: results }
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // GET /servers/:id/fs/exists?path= â€” check if a path exists and its type
  fastify.get('/servers/:id/fs/exists', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: checkPath } = z.object({ path: z.string() }).parse(req.query)
    try {
      const result = await withServerSsh(id, async (client) => {
        const safe = checkPath.replace(/'/g, "'\\''")
        const { stdout } = await exec(client,
          `if [ -d '${safe}' ]; then echo dir; elif [ -f '${safe}' ] || [ -L '${safe}' ]; then echo file; else echo none; fi`
        )
        const type = stdout.trim() as 'dir' | 'file' | 'none'
        return { exists: type !== 'none', type: type === 'none' ? null : type }
      })
      return result
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // POST /servers/:destId/fs/copy-from â€” copy file or directory from another server (or same)
  fastify.post('/servers/:destId/fs/copy-from', { preHandler: requireAuth }, async (req, reply) => {
    const { destId } = z.object({ destId: z.string().uuid() }).parse(req.params)
    const body = z.object({
      source_server_id: z.string().uuid(),
      source_path: z.string(),
      dest_dir: z.string(),
      dest_name: z.string().optional(), // rename on arrival; defaults to basename(source_path)
    }).parse(req.body)

    const srcPath  = body.source_path
    const destName = body.dest_name ?? path.posix.basename(srcPath)
    const destPath = path.posix.join(body.dest_dir, destName)

    try {
      // Same-server copy
      if (body.source_server_id === destId) {
        await withServerSsh(destId, async (client) => {
          const safeSrc  = srcPath.replace(/'/g, "'\\''")
          const safeDest = destPath.replace(/'/g, "'\\''")
          const safeDir  = body.dest_dir.replace(/'/g, "'\\''")
          const { code, stderr } = await exec(client,
            `mkdir -p '${safeDir}' && cp -r '${safeSrc}' '${safeDest}' 2>&1`
          )
          if (code !== 0) throw new Error(stderr.trim() || 'Copy failed')
        })
      } else {
        // Cross-server copy
        await withServerSsh(body.source_server_id, async (srcClient) => {
          // Determine if source is file or directory
          const { stdout: typeOut } = await exec(srcClient,
            `if [ -d '${srcPath.replace(/'/g,"'\\''")}' ]; then echo dir; else echo file; fi`
          )
          const isDir = typeOut.trim() === 'dir'

          await withServerSsh(destId, async (dstClient) => {
            const safeDestDir  = body.dest_dir.replace(/'/g, "'\\''")
            const safeDestPath = destPath.replace(/'/g, "'\\''")
            const safeSrcPath  = srcPath.replace(/'/g, "'\\''")
            const safeSrcParent = path.posix.dirname(srcPath).replace(/'/g, "'\\''")
            const safeSrcBase  = path.posix.basename(srcPath).replace(/'/g, "'\\''")

            // Ensure destination parent exists
            await exec(dstClient, `mkdir -p '${safeDestDir}'`)

            if (isDir) {
              // Stream tar archive between servers
              const srcCmd = `tar -czf - -C '${safeSrcParent}' '${safeSrcBase}'`
              const dstCmd = `tar -xzf - -C '${safeDestDir}'`
              await pipeSsh(srcClient, srcCmd, dstClient, dstCmd)
              // Rename if dest_name differs from source basename
              if (destName !== path.posix.basename(srcPath)) {
                const defaultDest = path.posix.join(body.dest_dir, path.posix.basename(srcPath))
                await exec(dstClient,
                  `mv '${defaultDest.replace(/'/g,"'\\''")}' '${safeDestPath}'`
                )
              }
            } else {
              // Small-to-medium files: SFTP relay through API process
              const srcSftp = await getSftp(srcClient)
              const data    = await sftpReadFile(srcSftp, srcPath)
              const dstSftp = await getSftp(dstClient)
              await sftpMkdirP(dstSftp, body.dest_dir)
              await sftpWrite(dstSftp, destPath, data)
            }
          })
        })
      }

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.copy', resource: 'file', serverId: destId,
        details: { source_server: body.source_server_id, source_path: srcPath, dest_path: destPath },
        request: req,
      })
      return { ok: true, dest_path: destPath }
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // GET /servers/:id/fs/download?path= â€” stream file or folder to browser
  // Files â†’ raw download; folders â†’ tar.gz archive
  fastify.get('/servers/:id/fs/download', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { path: targetPath } = z.object({ path: z.string().min(1) }).parse(req.query)
    try {
      const name = path.posix.basename(targetPath)
      const { isDir, buf } = await withServerSsh(id, async (client) => {
        const safe = targetPath.replace(/'/g, "'\\''")
        const { stdout } = await exec(client, `[ -d '${safe}' ] && echo dir || echo file`)
        const isDir = stdout.trim() === 'dir'
        if (isDir) {
          // Stream tar.gz from the server
          const parent = path.posix.dirname(targetPath).replace(/'/g, "'\\''")
          const base   = path.posix.basename(targetPath).replace(/'/g, "'\\''")
          const tarBuf = await new Promise<Buffer>((resolve, reject) => {
            client.exec(`tar -czf - -C '${parent}' '${base}'`, { pty: false }, (err, stream) => {
              if (err) return reject(err)
              const chunks: Buffer[] = []
              stream.on('data', (d: Buffer) => chunks.push(d))
              stream.stderr.on('data', () => {})
              stream.on('close', () => resolve(Buffer.concat(chunks)))
              stream.on('error', reject)
            })
          })
          return { isDir, buf: tarBuf }
        } else {
          const sftp = await getSftp(client)
          return { isDir, buf: await sftpReadFile(sftp, targetPath) }
        }
      })

      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'filemanager.download', resource: 'file', serverId: id,
        details: { path: targetPath }, request: req,
      })

      if (isDir) {
        return reply
          .header('Content-Disposition', `attachment; filename="${name}.tar.gz"`)
          .header('Content-Type', 'application/gzip')
          .send(buf)
      }
      return reply
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('Content-Type', 'application/octet-stream')
        .send(buf)
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })
}

export default fsRoutes


