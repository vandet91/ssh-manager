import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { withServerSsh } from '../../utils/server-ssh'
import { sshExec } from '../../utils/ssh'
import { writeAuditLog } from '../../utils/audit'
import { encryptSecret, getVaultKey } from '../../utils/vault'

// ── PS helpers ────────────────────────────────────────────────────────────────

/** Simple one-liner wrapper — for short commands without complex quoting */
function ps(cmd: string): string {
  const escaped = cmd.replace(/"/g, '\\"')
  return `powershell -NonInteractive -Command "${escaped}"`
}

/** Encode a multi-line PS script as Base64 UTF-16LE for -EncodedCommand.
 *  This sidesteps all shell quoting/escaping issues completely. */
function psEncoded(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell -NonInteractive -EncodedCommand ${encoded}`
}

/** Strip CLIXML envelope and return just the first meaningful error sentence. */
function cleanPsError(raw: string): string {
  // Not CLIXML — return as-is but trim noise lines
  if (!raw.includes('#< CLIXML')) {
    const lines = raw.split('\n').map(l => l.trim()).filter(l =>
      l && !l.startsWith('+') && !l.startsWith('At line:') &&
      !l.startsWith('CategoryInfo') && !l.startsWith('FullyQualified')
    )
    return lines[0] ?? raw.trim()
  }
  const matches = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
  if (!matches.length) return raw.trim()
  const lines = matches
    .map(m => m[1]
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .trim()
    )
    .join('\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('+') && !l.startsWith('At line:') &&
                 !l.startsWith('CategoryInfo') && !l.startsWith('FullyQualified'))
  return lines[0] ?? raw.trim()
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DomainUser {
  samAccountName: string
  displayName: string
  email: string | null
  enabled: boolean
  lockedOut: boolean
  passwordExpired: boolean
  passwordNeverExpires: boolean
  mustChangePassword: boolean
  passwordLastSet: string | null
  lastLogonDate: string | null
  ou: string | null
  distinguishedName: string
}

// ── PS script that returns all domain users as TSV ───────────────────────────

const GET_USERS_SCRIPT = `
$users = Get-ADUser -Filter * -Properties DisplayName,EmailAddress,Enabled,LockedOut,PasswordExpired,PasswordNeverExpires,PasswordLastSet,LastLogonDate,DistinguishedName,pwdLastSet
foreach ($u in $users) {
  $ou = ($u.DistinguishedName -split ',',2)[1]
  $pwdExpired = if ($u.PasswordExpired) { '1' } else { '0' }
  $mustChange = if ($u.pwdLastSet -eq 0 -and $u.PasswordNeverExpires -eq $false) { '1' } else { '0' }
  $fields = @(
    $u.SamAccountName,
    ($u.DisplayName -replace "\t",' ' -replace "\n",' '),
    ($u.EmailAddress -replace "\t",' '),
    $(if ($u.Enabled) { '1' } else { '0' }),
    $(if ($u.LockedOut) { '1' } else { '0' }),
    $pwdExpired,
    $(if ($u.PasswordNeverExpires) { '1' } else { '0' }),
    $mustChange,
    $(if ($u.PasswordLastSet) { $u.PasswordLastSet.ToString('yyyy-MM-dd HH:mm') } else { '' }),
    $(if ($u.LastLogonDate) { $u.LastLogonDate.ToString('yyyy-MM-dd HH:mm') } else { '' }),
    ($ou -replace "\t",' '),
    ($u.DistinguishedName -replace "\t",' ')
  )
  Write-Output ($fields -join "\t")
}
`.trim()

function parseUsers(stdout: string): DomainUser[] {
  const users: DomainUser[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split('\t')
    if (parts.length < 12) continue
    const [sam, display, email, enabled, locked, pwdExp, pwdNever, mustChange, pwdLastSet, lastLogon, ou, dn] = parts
    users.push({
      samAccountName: sam,
      displayName: display || sam,
      email: email || null,
      enabled: enabled === '1',
      lockedOut: locked === '1',
      passwordExpired: pwdExp === '1',
      passwordNeverExpires: pwdNever === '1',
      mustChangePassword: mustChange === '1',
      passwordLastSet: pwdLastSet || null,
      lastLogonDate: lastLogon || null,
      ou: ou || null,
      distinguishedName: dn,
    })
  }
  return users
}

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function domainRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /domain/servers — list Windows servers suitable as DCs
  fastify.get('/domain/servers', { preHandler: requirePermission('servers:read') }, async () => {
    const anyDb = db as any
    const servers = await anyDb.selectFrom('servers')
      .select(['id', 'name', 'hostname', 'environment', 'os_type', 'is_active', 'tags'])
      .where('is_domain_controller', '=', true)
      .where('is_active', '=', true)
      .orderBy('name')
      .execute()
    return servers
  })

  // GET /domain/:serverId/health — domain health check
  fastify.get('/domain/:serverId/health', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)

    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$domain = Get-ADDomain
$forest = Get-ADForest
$dcs = Get-ADDomainController -Filter *
$policy = Get-ADDefaultDomainPasswordPolicy
$rb = Get-ADOptionalFeature -Filter {Name -like "Recycle Bin Feature"}
$replFails = @()
try { $replFails = @(Get-ADReplicationFailure -Scope Domain) } catch {}
$svcResults = @('NTDS','NETLOGON','W32Time','DNS','KDC') | ForEach-Object {
  $n = $_
  $s = Get-Service $n -ErrorAction SilentlyContinue
  if ($s) { "$n|$($s.Status)" } else { "$n|NotFound" }
}
$dcLines = $dcs | ForEach-Object {
  "$($_.Name)|$($_.HostName)|$(if($_.IsGlobalCatalog){'1'}else{'0'})|$(if($_.IsReadOnly){'1'}else{'0'})|$($_.OperatingSystem)|$($_.Site)|$($_.IPv4Address)"
}
$rfLines = $replFails | ForEach-Object {
  $partner = ($_.Partner -replace '[;|]','/')
  "$partner|$($_.LastError)|$($_.FailureCount)|$(if($_.FirstFailureTime){$_.FirstFailureTime.ToString('yyyy-MM-dd HH:mm')}else{''})"
}
Write-Output "DOMAIN:$($domain.DNSRoot)"
Write-Output "FOREST:$($forest.Name)"
Write-Output "DOMAIN_MODE:$($domain.DomainMode)"
Write-Output "FOREST_MODE:$($forest.ForestMode)"
Write-Output "PDC:$($domain.PDCEmulator)"
Write-Output "RID:$($domain.RIDMaster)"
Write-Output "INFRA:$($domain.InfrastructureMaster)"
Write-Output "SCHEMA:$($forest.SchemaMaster)"
Write-Output "NAMING:$($forest.DomainNamingMaster)"
Write-Output "RECYCLE_BIN:$(if($rb -and $rb.EnabledScopes.Count -gt 0){'1'}else{'0'})"
Write-Output "DCS:$($dcLines -join ';')"
Write-Output "REPL_FAIL_COUNT:$($replFails.Count)"
Write-Output "REPL_FAIL_DETAIL:$($rfLines -join ';')"
Write-Output "PWD_MIN_LEN:$($policy.MinPasswordLength)"
Write-Output "PWD_HISTORY:$($policy.PasswordHistoryCount)"
Write-Output "PWD_MAX_AGE:$($policy.MaxPasswordAge.Days)"
Write-Output "PWD_MIN_AGE:$($policy.MinPasswordAge.Days)"
Write-Output "PWD_COMPLEXITY:$(if($policy.ComplexityEnabled){'1'}else{'0'})"
Write-Output "LOCKOUT_THRESHOLD:$($policy.LockoutThreshold)"
Write-Output "LOCKOUT_DURATION:$($policy.LockoutDuration.Minutes)"
Write-Output "SERVICES:$($svcResults -join ',')"
`.trim()

    try {
      const health = await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(script))
        if (r.stderr && !r.stdout.trim()) throw new Error(cleanPsError(r.stderr).slice(0, 400))

        const kv: Record<string, string> = {}
        for (const line of r.stdout.split('\n')) {
          const idx = line.indexOf(':')
          if (idx === -1) continue
          kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }

        const dcs = (kv['DCS'] ?? '').split(';').filter(Boolean).map(l => {
          const [name, hostname, isGC, isRO, os, site, ip] = l.split('|')
          return { name, hostname, isGlobalCatalog: isGC === '1', isReadOnly: isRO === '1', os, site, ip }
        })

        const replFailDetail = (kv['REPL_FAIL_DETAIL'] ?? '').split(';').filter(Boolean).map(l => {
          const [partner, lastError, failureCount, firstFailure] = l.split('|')
          return { partner, lastError, failureCount: parseInt(failureCount) || 0, firstFailure }
        })

        const services = (kv['SERVICES'] ?? '').split(',').filter(Boolean).map(l => {
          const [name, status] = l.split('|')
          return { name, status }
        })

        return {
          domain: kv['DOMAIN'] ?? '',
          forest: kv['FOREST'] ?? '',
          domainMode: kv['DOMAIN_MODE'] ?? '',
          forestMode: kv['FOREST_MODE'] ?? '',
          fsmo: {
            pdcEmulator: kv['PDC'] ?? '',
            ridMaster: kv['RID'] ?? '',
            infraMaster: kv['INFRA'] ?? '',
            schemaMaster: kv['SCHEMA'] ?? '',
            namingMaster: kv['NAMING'] ?? '',
          },
          recycleBinEnabled: kv['RECYCLE_BIN'] === '1',
          dcs,
          replFailureCount: parseInt(kv['REPL_FAIL_COUNT'] ?? '0') || 0,
          replFailDetail,
          passwordPolicy: {
            minLength: parseInt(kv['PWD_MIN_LEN'] ?? '0') || 0,
            history: parseInt(kv['PWD_HISTORY'] ?? '0') || 0,
            maxAgeDays: parseInt(kv['PWD_MAX_AGE'] ?? '0') || 0,
            minAgeDays: parseInt(kv['PWD_MIN_AGE'] ?? '0') || 0,
            complexityEnabled: kv['PWD_COMPLEXITY'] === '1',
            lockoutThreshold: parseInt(kv['LOCKOUT_THRESHOLD'] ?? '0') || 0,
            lockoutDurationMinutes: parseInt(kv['LOCKOUT_DURATION'] ?? '0') || 0,
          },
          services,
        }
      })
      return health
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Health check failed' })
    }
  })

  // POST /domain/:serverId/replication-sync — force AD replication
  fastify.post('/domain/:serverId/replication-sync', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)

    try {
      const result = await withServerSsh(serverId, async (client) => {
        // Step 1: get the domain DN so we can target exactly that NC
        // Step 2: syncall on just the domain partition — skips ForestDnsZones/DomainDnsZones
        //         application partitions which cause "invalid NC" errors when the account
        //         lacks Replicating Directory Changes on the forest root.
        // repadmin /syncall fails over SSH due to Kerberos double-hop:
        // the SSH session can't forward its ticket for the RPC calls to remote DCs.
        // repadmin /replicate <local> <src> <NC> /force is a LOCAL RPC call — it tells
        // the NTDS service on this DC to pull from each partner using its own service account.
        const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
$dc = $env:COMPUTERNAME
$dn = (Get-ADDomain).DistinguishedName
$sources = Get-ADDomainController -Filter * | Where-Object { $_.Name -ne $dc }
if ($sources.Count -eq 0) {
  Write-Output "No other domain controllers found to replicate from."
} else {
  foreach ($src in $sources) {
    $r = repadmin /replicate $dc $src.HostName $dn /force 2>&1
    $clean = ($r | Where-Object { $_ -and $_ -notmatch '^#<' }) -join ' '
    Write-Output "[$($src.Name)] $clean"
  }
}
`.trim()
        const r = await sshExec(client, psEncoded(script))
        const output = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(0, 3000)
        return { output, code: r.code }
      })

      await writeAuditLog({
        userId: req.session.user!.id,
        userEmail: req.session.user!.email,
        action: 'domain.replication_sync',
        resource: 'domain',
        resourceId: undefined,
        details: { serverId },
        request: req,
      })

      return { ok: true, output: result.output, code: result.code }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Replication sync failed' })
    }
  })

  // GET /domain/:serverId/users — fetch all domain users
  fastify.get('/domain/:serverId/users', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { filter } = z.object({
      filter: z.enum(['all', 'locked', 'password_issues', 'disabled']).default('all'),
      search: z.string().optional(),
    }).parse(req.query)

    try {
      const users = await withServerSsh(serverId, async (client) => {
        const result = await sshExec(client, psEncoded(GET_USERS_SCRIPT))
        if (result.stderr && result.stdout.trim() === '') {
          throw new Error(result.stderr.slice(0, 300))
        }
        return parseUsers(result.stdout)
      })

      let filtered = users
      const { search } = req.query as { search?: string }
      if (search) {
        const q = search.toLowerCase()
        filtered = filtered.filter(u =>
          u.samAccountName.toLowerCase().includes(q) ||
          u.displayName.toLowerCase().includes(q) ||
          (u.email ?? '').toLowerCase().includes(q)
        )
      }
      if (filter === 'locked') filtered = filtered.filter(u => u.lockedOut)
      if (filter === 'disabled') filtered = filtered.filter(u => !u.enabled)
      if (filter === 'password_issues') filtered = filtered.filter(u =>
        u.passwordExpired || u.mustChangePassword || u.passwordNeverExpires
      )

      return { users: filtered, total: users.length }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to connect to DC' })
    }
  })

  // POST /domain/:serverId/unlock — unlock an account
  fastify.post('/domain/:serverId/unlock', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { samAccountName } = z.object({ samAccountName: z.string().min(1).max(64) }).parse(req.body)

    try {
      await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(`Unlock-ADAccount -Identity '${samAccountName}'`))
        if (r.code !== 0 && r.stderr) throw new Error(cleanPsError(r.stderr).slice(0, 400))
      })

      await writeAuditLog({
        userId: req.session.user!.id,
        userEmail: req.session.user!.email,
        action: 'domain.unlock_account',
        resource: 'domain_user',
        resourceId: undefined,
        details: { serverId, samAccountName },
        request: req,
      })

      return { ok: true }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to unlock account' })
    }
  })

  // POST /domain/:serverId/reset-password — reset account password
  fastify.post('/domain/:serverId/reset-password', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { samAccountName, password, forceChange } = z.object({
      samAccountName: z.string().min(1).max(64),
      password: z.string().min(8),
      forceChange: z.boolean().default(true),
    }).parse(req.body)

    const psCmd = [
      `$ProgressPreference = 'SilentlyContinue'`,
      `$ErrorActionPreference = 'Stop'`,
      `$pwd = ConvertTo-SecureString ${JSON.stringify(password)} -AsPlainText -Force`,
      `Set-ADAccountPassword -Identity '${samAccountName}' -NewPassword $pwd -Reset`,
      ...(forceChange ? [`Set-ADUser -Identity '${samAccountName}' -ChangePasswordAtLogon $true`] : []),
    ].join('\n')

    try {
      await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(psCmd))
        if (r.code !== 0 && r.stderr) throw new Error(cleanPsError(r.stderr).slice(0, 400))
      })

      // ── Sync stored credentials that belong to this AD account ───────────────
      // Get this DC's domain_name from its tags so we only touch credentials
      // that explicitly belong to this domain (avoids cross-domain collisions).
      const dcServer = await (db as any)
        .selectFrom('servers')
        .select(['tags'])
        .where('id', '=', serverId)
        .executeTakeFirst()

      const domainName: string | null = dcServer?.tags?.domain_name ?? null

      const vaultKey = getVaultKey()
      const passwordEnc = encryptSecret(password, vaultKey)

      // Only match credentials with an explicit domain prefix (e.g. pvd.local\administrator).
      // Plain usernames (no domain prefix) are ambiguous across multiple ADs — skip them.
      const domainPrefixes: string[] = domainName
        ? [`${domainName}\\${samAccountName}`, `${domainName}/${samAccountName}`]
        : []

      // Also match short-form NETBIOS prefix if domain has dots: e.g. "pvd" for "pvd.local"
      if (domainName && domainName.includes('.')) {
        const netbios = domainName.split('.')[0]
        domainPrefixes.push(`${netbios}\\${samAccountName}`, `${netbios}/${samAccountName}`)
      }

      if (domainPrefixes.length === 0) {
        // No domain_name tag on the DC — fall back to matching the plain username only
        domainPrefixes.push(samAccountName)
      }

      const storedCreds = await (db as any)
        .selectFrom('server_credentials')
        .select(['id', 'server_id', 'linux_user', 'label', 'category'])
        .where('is_archived', '=', false)
        .where((eb: any) => eb.or(
          domainPrefixes.map((p: string) => eb('linux_user', 'ilike', p))
        ))
        .execute()

      let updatedCreds = 0
      for (const cred of storedCreds) {
        // Archive old entry and create a new one with the updated password
        await (db as any).updateTable('server_credentials')
          .set({ is_archived: true, archived_at: new Date(), archived_reason: 'updated', updated_at: new Date() })
          .where('id', '=', cred.id)
          .execute()

        await (db as any).insertInto('server_credentials').values({
          server_id: cred.server_id,
          category: cred.category ?? 'linux',
          linux_user: cred.linux_user,
          label: cred.label,
          password_enc: passwordEnc,
          notes: null,
          created_by: req.session.user!.id,
          predecessor_id: cred.id,
        }).execute()

        updatedCreds++
      }

      await writeAuditLog({
        userId: req.session.user!.id,
        userEmail: req.session.user!.email,
        action: 'domain.reset_password',
        resource: 'domain_user',
        resourceId: undefined,
        details: { serverId, samAccountName, forceChange, updatedStoredCredentials: updatedCreds },
        request: req,
      })

      return { ok: true, updatedCreds }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to reset password' })
    }
  })

  // POST /domain/:serverId/set-enabled — enable or disable account
  fastify.post('/domain/:serverId/set-enabled', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { samAccountName, enabled } = z.object({
      samAccountName: z.string().min(1).max(64),
      enabled: z.boolean(),
    }).parse(req.body)

    const psCmd = enabled
      ? `Enable-ADAccount -Identity '${samAccountName}'`
      : `Disable-ADAccount -Identity '${samAccountName}'`

    try {
      await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(psCmd))
        if (r.code !== 0 && r.stderr) throw new Error(cleanPsError(r.stderr).slice(0, 400))
      })

      await writeAuditLog({
        userId: req.session.user!.id,
        userEmail: req.session.user!.email,
        action: enabled ? 'domain.enable_account' : 'domain.disable_account',
        resource: 'domain_user',
        resourceId: undefined,
        details: { serverId, samAccountName },
        request: req,
      })

      return { ok: true }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to update account' })
    }
  })

  // POST /domain/:serverId/set-password-never-expires
  fastify.post('/domain/:serverId/set-password-never-expires', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { samAccountName, value } = z.object({
      samAccountName: z.string().min(1).max(64),
      value: z.boolean(),
    }).parse(req.body)

    const psCmd = `Set-ADUser -Identity '${samAccountName}' -PasswordNeverExpires $${value ? 'true' : 'false'}`

    try {
      await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(psCmd))
        if (r.code !== 0 && r.stderr) throw new Error(cleanPsError(r.stderr).slice(0, 400))
      })

      await writeAuditLog({
        userId: req.session.user!.id,
        userEmail: req.session.user!.email,
        action: 'domain.set_password_never_expires',
        resource: 'domain_user',
        resourceId: undefined,
        details: { serverId, samAccountName, value },
        request: req,
      })

      return { ok: true }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to update account' })
    }
  })

  // GET /domain/:serverId/user-detail/:sam — groups + account detail (on-demand)
  fastify.get('/domain/:serverId/user-detail/:sam', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { serverId, sam } = z.object({ serverId: z.string().uuid(), sam: z.string().min(1).max(64) }).parse(req.params)

    const script = `
$u = Get-ADUser -Identity '${sam}' -Properties MemberOf,Description,Title,Department,Manager,AdminCount,LastBadPasswordAttempt,BadLogonCount
$groups = @()
foreach ($g in $u.MemberOf) {
  $grp = Get-ADGroup -Identity $g -Properties Description
  $groups += "$($grp.Name)|$($grp.GroupScope)|$($grp.GroupCategory)"
}
Write-Output "GROUPS:$($groups -join ',')"
Write-Output "DESC:$($u.Description)"
Write-Output "TITLE:$($u.Title)"
Write-Output "DEPT:$($u.Department)"
Write-Output "ADMINCOUNT:$($u.AdminCount)"
Write-Output "BADPWD:$($u.BadLogonCount)"
`.trim()

    try {
      const detail = await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(script))
        if (r.stderr && !r.stdout) throw new Error(cleanPsError(r.stderr).slice(0, 400))
        const lines: Record<string, string> = {}
        for (const line of r.stdout.split('\n')) {
          const idx = line.indexOf(':')
          if (idx === -1) continue
          lines[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }
        const groups = (lines['GROUPS'] ?? '').split(',').filter(Boolean).map(g => {
          const [name, scope, category] = g.split('|')
          return { name: name ?? g, scope: scope ?? '', category: category ?? '' }
        })
        return {
          groups,
          description: lines['DESC'] ?? null,
          title: lines['TITLE'] ?? null,
          department: lines['DEPT'] ?? null,
          adminCount: lines['ADMINCOUNT'] === '1',
          badLogonCount: parseInt(lines['BADPWD'] ?? '0') || 0,
        }
      })
      return detail
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to get user detail' })
    }
  })

  // GET /domain/:serverId/groups — list all AD groups
  fastify.get('/domain/:serverId/groups', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)

    const script = `
Get-ADGroup -Filter * -Properties Description | ForEach-Object {
  Write-Output "$($_.Name)|$($_.GroupScope)|$($_.GroupCategory)|$($_.Description)"
}
`.trim()

    try {
      const groups = await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(script))
        if (r.stderr && !r.stdout) throw new Error(cleanPsError(r.stderr).slice(0, 400))
        return r.stdout.split('\n').filter(Boolean).map(line => {
          const [name, scope, category, ...descParts] = line.split('|')
          return { name: name ?? '', scope: scope ?? '', category: category ?? '', description: descParts.join('|') ?? '' }
        }).filter(g => g.name).sort((a, b) => a.name.localeCompare(b.name))
      })
      return groups
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to list groups' })
    }
  })

  // POST /domain/:serverId/add-to-group
  fastify.post('/domain/:serverId/add-to-group', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { samAccountName, groupName } = z.object({
      samAccountName: z.string().min(1).max(64),
      groupName: z.string().min(1).max(256),
    }).parse(req.body)

    try {
      await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(`Add-ADGroupMember -Identity '${groupName}' -Members '${samAccountName}'`))
        if (r.code !== 0 && r.stderr) throw new Error(cleanPsError(r.stderr).slice(0, 400))
      })
      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'domain.add_to_group', resource: 'domain_user', resourceId: undefined,
        details: { serverId, samAccountName, groupName }, request: req,
      })
      return { ok: true }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to add to group' })
    }
  })

  // POST /domain/:serverId/remove-from-group
  fastify.post('/domain/:serverId/remove-from-group', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const { samAccountName, groupName } = z.object({
      samAccountName: z.string().min(1).max(64),
      groupName: z.string().min(1).max(256),
    }).parse(req.body)

    try {
      await withServerSsh(serverId, async (client) => {
        const r = await sshExec(client, psEncoded(`Remove-ADGroupMember -Identity '${groupName}' -Members '${samAccountName}' -Confirm:$false`))
        if (r.code !== 0 && r.stderr) throw new Error(cleanPsError(r.stderr).slice(0, 400))
      })
      await writeAuditLog({
        userId: req.session.user!.id, userEmail: req.session.user!.email,
        action: 'domain.remove_from_group', resource: 'domain_user', resourceId: undefined,
        details: { serverId, samAccountName, groupName }, request: req,
      })
      return { ok: true }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message ?? 'Failed to remove from group' })
    }
  })
}
