/**
 * Telegram bot service — long-polling, no extra dependencies.
 * Settings are re-read every poll cycle so UI changes take effect live.
 *
 * Critical service actions require a TOTP reply before executing.
 * The TOTP secret is stored in the settings table and scanned into
 * any authenticator app via the Settings page.
 */

import speakeasy from 'speakeasy'
import { db } from '../../db/client'
import { withServerSsh } from '../../utils/server-ssh'
import { Client } from 'ssh2'

// 5-second connect timeout for bot commands — fail fast if server is unreachable
const sshBot = <T>(serverId: string, fn: (client: Client) => Promise<T>) =>
  withServerSsh(serverId, fn, undefined, 5000)

// ── Telegram HTTP helpers ──────────────────────────────────────────────────────

const TG_BASE = 'https://api.telegram.org/bot'

interface TgMessage {
  message_id: number
  chat: { id: number }
  from?: { username?: string; first_name?: string }
  text?: string
}
interface TgUpdate { update_id: number; message?: TgMessage }

async function tgPost<T = unknown>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${TG_BASE}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as { ok: boolean; result: T; description?: string }
  if (!json.ok) throw new Error(`Telegram: ${json.description}`)
  return json.result
}

async function send(token: string, chatId: number, text: string, html = false): Promise<void> {
  await tgPost(token, 'sendMessage', {
    chat_id: chatId, text,
    parse_mode: html ? 'HTML' : undefined,
    disable_web_page_preview: true,
  })
}

async function fetchUpdates(token: string, offset: number): Promise<TgUpdate[]> {
  return tgPost<TgUpdate[]>(token, 'getUpdates', { offset, timeout: 25, limit: 100 })
}

// ── Settings ───────────────────────────────────────────────────────────────────

interface TgGroupConfig { enabled: boolean; totp: boolean }
interface TgCommands { servers: TgGroupConfig; status: TgGroupConfig; software: TgGroupConfig; linux_info: TgGroupConfig; linux_svc: TgGroupConfig; ad_read: TgGroupConfig; ad_write: TgGroupConfig }
interface TgSettings { enabled: boolean; token: string; allowedChats: number[]; totpSecret: string; commands: TgCommands }

const DEFAULT_COMMANDS: TgCommands = {
  servers:    { enabled: true,  totp: false },
  status:     { enabled: true,  totp: false },
  software:   { enabled: true,  totp: false },
  linux_info: { enabled: true,  totp: false },
  linux_svc:  { enabled: true,  totp: true  },
  ad_read:    { enabled: true,  totp: false },
  ad_write:   { enabled: true,  totp: true  },
}

function normalizeGroup(val: unknown, def: TgGroupConfig): TgGroupConfig {
  if (val === null || val === undefined) return def
  if (typeof val === 'boolean') return { enabled: val, totp: def.totp }
  const v = val as Partial<TgGroupConfig>
  return { enabled: v.enabled ?? def.enabled, totp: v.totp ?? def.totp }
}

async function getSettings(): Promise<TgSettings> {
  const rows = (await db.selectFrom('settings' as any).selectAll()
    .where('key' as any, 'in', ['telegram_enabled','telegram_bot_token','telegram_allowed_chats','telegram_totp_secret','telegram_commands'])
    .execute()) as Array<{ key: string; value: unknown }>
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const raw = (m['telegram_commands'] ?? {}) as Record<string, unknown>
  const commands: TgCommands = {
    servers:    normalizeGroup(raw['servers'],    DEFAULT_COMMANDS.servers),
    status:     normalizeGroup(raw['status'],     DEFAULT_COMMANDS.status),
    software:   normalizeGroup(raw['software'],   DEFAULT_COMMANDS.software),
    linux_info: normalizeGroup(raw['linux_info'], DEFAULT_COMMANDS.linux_info),
    linux_svc:  normalizeGroup(raw['linux_svc'],  DEFAULT_COMMANDS.linux_svc),
    ad_read:    normalizeGroup(raw['ad_read'],    DEFAULT_COMMANDS.ad_read),
    ad_write:   normalizeGroup(raw['ad_write'],   DEFAULT_COMMANDS.ad_write),
  }
  return {
    enabled: !!(m['telegram_enabled'] ?? false),
    token: (m['telegram_bot_token'] as string) ?? '',
    allowedChats: (m['telegram_allowed_chats'] as number[]) ?? [],
    totpSecret: (m['telegram_totp_secret'] as string) ?? '',
    commands,
  }
}

function isEnabled(settings: TgSettings, group: keyof TgCommands): boolean {
  return settings.commands[group].enabled !== false
}

function needsTotp(settings: TgSettings, group: keyof TgCommands): boolean {
  return settings.commands[group].totp === true
}

// ── AD helpers ─────────────────────────────────────────────────────────────────

function psEncoded(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell -NonInteractive -EncodedCommand ${encoded}`
}

async function getDcServer() {
  const anyDb = db as any
  const dc = await anyDb.selectFrom('servers').selectAll()
    .where('is_active', '=', true)
    .where('is_domain_controller', '=', true)
    .orderBy('name').executeTakeFirst()
  return dc ?? null
}

async function runAdScript(script: string): Promise<string> {
  const dc = await getDcServer()
  if (!dc) throw new Error('No domain controller configured. Enable Is Domain Controller on a Windows server in SSH Manager.')
  return sshBot(dc.id, async (client) => {
    const { sshExec } = await import('../../utils/ssh')
    const out = await sshExec(client, psEncoded(script))
    if (out.stderr?.includes('not recognized') || out.stderr?.includes('not loaded'))
      throw new Error('Active Directory PowerShell module not installed on the DC.')
    return out.stdout
  }) as Promise<string>
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── TOTP challenges ────────────────────────────────────────────────────────────

type ChallengeAction = 'start' | 'stop' | 'restart' | 'adunlock' | 'adenable' | 'addisable' | 'adreset' | 'pending'

interface Challenge {
  action: ChallengeAction
  // linux_svc
  service?: string
  serverName?: string
  serverId?: string
  // ad_write
  adUser?: string
  adPassword?: string
  // generic pending (any command gated by TOTP)
  pendingCmd?: string
  pendingArgs?: string[]
  who: string
  expiresAt: number
}
const challenges = new Map<number, Challenge>()
// Prevent replay: track used TOTP codes (cleared every 90 seconds)
const usedTotpCodes = new Set<string>()
setInterval(() => usedTotpCodes.clear(), 90_000)

// ── Software detection (inline minimal version for bot) ────────────────────────

const DETECT_SCRIPT = `#!/bin/sh
p() { command -v "$1" >/dev/null 2>&1 && printf 'PKG\\t%s\\t%s\\n' "$2" "$($1 $3 2>&1|head -1)"; }
sv() { systemctl cat "$1.service" >/dev/null 2>&1 && printf 'SVC\\t%s\\t%s\\n' "$1" "$(systemctl is-active "$1" 2>/dev/null)"; }
p php PHP '--version'; p node Node '--version'; p python3 Python3 '--version'
p ruby Ruby '--version'; p go Go 'version'; p java Java '-version'
p nginx Nginx '-v'; p apache2 Apache '-v'; p httpd Apache '-v'; p caddy Caddy 'version'
p mysql MySQL '--version'; p psql PostgreSQL '--version'; p mongod MongoDB '--version'
p redis-server Redis '--version'; p docker Docker '--version'; p podman Podman '--version'
p pm2 PM2 '--version'; p supervisord Supervisord '--version'
p telegraf Telegraf '--version'; p netdata Netdata '--version'
p fail2ban-client Fail2ban '--version'; p ufw UFW '--version'; p certbot Certbot '--version'
for sv_name in nginx apache2 httpd mysql mariadb postgresql mongod redis docker pm2 supervisor fail2ban; do sv "$sv_name"; done
`

function formatSoftwareForTelegram(raw: string): string {
  const installed: Array<{ name: string; version: string }> = []
  const svcStatus: Record<string, string> = {}

  for (const line of raw.split('\n')) {
    const parts = line.split('\t')
    if (parts[0] === 'PKG' && parts[1]) installed.push({ name: parts[1], version: parts[2]?.trim() ?? '' })
    if (parts[0] === 'SVC' && parts[1]) svcStatus[parts[1]] = parts[2]?.trim() ?? 'unknown'
  }

  if (installed.length === 0) return 'No recognized software detected.'

  return installed.map(({ name, version }) => {
    const emoji = svcStatus[name.toLowerCase()] === 'active' ? '🟢' :
                  svcStatus[name.toLowerCase()] === 'inactive' ? '🔴' : '⚪'
    const ver = version.replace(/\r/g,'').split('\n')[0].slice(0, 50)
    return `${emoji} <b>${name}</b>\n    <code>${ver}</code>`
  }).join('\n')
}

// ── TOTP prompt helper ─────────────────────────────────────────────────────────

async function promptTotp(
  token: string, chatId: number, settings: TgSettings,
  cmd: string, args: string[], who: string,
  challenges: Map<number, Challenge>,
): Promise<void> {
  if (!settings.totpSecret) {
    await send(token, chatId, '❌ Bot TOTP not configured. Set it up in SSH Manager → Settings → Telegram.')
    return
  }
  challenges.set(chatId, { action: 'pending', pendingCmd: cmd, pendingArgs: args, who, expiresAt: Date.now() + 60_000 })
  await send(token, chatId,
    `🔐 <b>/${cmd} requires TOTP confirmation</b>\n\n` +
    `Command: <code>/${cmd}${args.length ? ' ' + args.join(' ') : ''}</code>\n` +
    `Requested by: ${who}\n\n` +
    `Reply with your <b>TOTP code</b> within 60 seconds.\nAny other reply cancels.`, true)
}

// ── Execution helper (shared between direct calls and post-TOTP replay) ────────

async function executeCommand(token: string, chatId: number, settings: TgSettings, cmd: string, args: string[]): Promise<void> {
  const { sshExec } = await import('../../utils/ssh')

  switch (cmd) {
    case 'servers': {
      const servers = await db.selectFrom('servers')
        .select(['name','hostname','environment','last_connected_at'])
        .where('is_active','=',true).orderBy('name').execute()
      if (!servers.length) { await send(token, chatId, 'No servers.'); break }
      const lines = servers.map((s) => `• <b>${s.name}</b> (${s.hostname}, ${s.environment})`).join('\n')
      await send(token, chatId, `📋 <b>Servers</b>\n\n${lines}`, true)
      break
    }
    case 'status': {
      const name = args.join(' ')
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',name).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${name}`); break }
      const conn = server.last_connected_at ? new Date(server.last_connected_at).toLocaleString() : 'Never'
      await send(token, chatId,
        `📡 <b>${server.name}</b>\n` +
        `Host: <code>${server.hostname}:${server.ssh_port}</code>\n` +
        `Env: ${server.environment}\n` +
        `Last connected: ${conn}`, true)
      break
    }
    case 'software': {
      const name = args.join(' ')
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',name).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${name}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      await send(token, chatId, `🔍 Scanning ${server.name}…`)
      try {
        const raw = await sshBot(server.id, async (client) => {
          const encoded = Buffer.from(DETECT_SCRIPT).toString('base64')
          return (await sshExec(client, `echo '${encoded}' | base64 -d | sh 2>/dev/null`)).stdout
        }) as string
        await send(token, chatId, `📦 <b>Software: ${server.name}</b>\n\n${formatSoftwareForTelegram(raw)}`, true)
      } catch (err) { await send(token, chatId, `❌ Scan failed: ${(err as Error).message}`) }
      break
    }
    case 'disk': {
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',args.join(' ')).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${args.join(' ')}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      try {
        const out = await sshBot(server.id, async (client) =>
          (await sshExec(client, `df -h --output=target,size,used,avail,pcent 2>/dev/null | grep -v tmpfs | grep -v udev | head -20`)).stdout
        ) as string
        const rows = out.split('\n').filter(Boolean).slice(1).map(l => {
          const p = l.trim().split(/\s+/)
          const pct = parseInt(p[4] ?? '0')
          const icon = pct >= 90 ? '🔴' : pct >= 75 ? '🟡' : '🟢'
          return `${icon} <code>${p[0]}</code>  ${p[4]} used  (${p[1]} total, ${p[3]} free)`
        })
        await send(token, chatId, `💾 <b>Disk: ${server.name}</b>\n\n` + rows.join('\n'), true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'memory':
    case 'mem': {
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',args.join(' ')).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${args.join(' ')}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      try {
        const out = await sshBot(server.id, async (client) =>
          (await sshExec(client, `free -h && echo '---' && cat /proc/loadavg`)).stdout
        ) as string
        const [freePart, loadPart] = out.split('---')
        const memLines = freePart.trim().split('\n')
        const memRow = memLines[1]?.trim().split(/\s+/) ?? []
        const swapRow = memLines[2]?.trim().split(/\s+/) ?? []
        await send(token, chatId,
          `🧠 <b>Memory: ${server.name}</b>\n\n` +
          `RAM:  total <b>${memRow[1]}</b>  used <b>${memRow[2]}</b>  free <b>${memRow[3]}</b>\n` +
          `Swap: total <b>${swapRow[1]}</b>  used <b>${swapRow[2]}</b>  free <b>${swapRow[3]}</b>\n\n` +
          `Load avg: <code>${(loadPart?.trim() ?? '').split(' ').slice(0,3).join(' ')}</code>`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'top': {
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',args.join(' ')).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${args.join(' ')}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      try {
        const out = await sshBot(server.id, async (client) =>
          (await sshExec(client, `ps aux --sort=-%cpu | head -11 | awk 'NR>1{printf "%s%%\\t%s%%\\t%s\\n",$3,$4,$11}'`)).stdout
        ) as string
        const rows = out.split('\n').filter(Boolean).map(l => {
          const [cpu, mem, name] = l.split('\t')
          return `• <code>${(name ?? '').slice(0,30).padEnd(30)}</code>  CPU <b>${cpu}</b>  MEM <b>${mem}</b>`
        })
        await send(token, chatId, `📊 <b>Top processes: ${server.name}</b>\n\n` + rows.join('\n'), true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'users': {
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',args.join(' ')).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${args.join(' ')}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      try {
        const out = await sshBot(server.id, async (client) =>
          (await sshExec(client, `who && echo '---' && last -n 5 | head -6`)).stdout
        ) as string
        const [whoPart, lastPart] = out.split('---')
        const logged = whoPart.trim().split('\n').filter(Boolean)
        const recent = lastPart?.trim().split('\n').filter(Boolean) ?? []
        const whoLines = logged.length ? logged.map(l => `👤 <code>${l}</code>`) : ['(no users logged in)']
        await send(token, chatId,
          `👥 <b>Users: ${server.name}</b>\n\n` +
          `<b>Currently logged in:</b>\n${whoLines.join('\n')}\n\n` +
          `<b>Recent logins:</b>\n${recent.map(l => `• <code>${l}</code>`).join('\n')}`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'aduser': {
      const username = args[0]
      await send(token, chatId, `🔍 Looking up <b>${escapeHtml(username)}</b>…`, true)
      try {
        const out = await runAdScript(
          `$u = Get-ADUser -Identity '${username}' -Properties DisplayName,EmailAddress,Enabled,LockedOut,PasswordExpired,PasswordNeverExpires,PasswordLastSet,LastLogonDate,DistinguishedName\n` +
          `if (!$u) { Write-Output 'NOT_FOUND'; exit }\n` +
          `$ou = ($u.DistinguishedName -split ',',2)[1]\n` +
          `Write-Output "SAM=$($u.SamAccountName)"\nWrite-Output "NAME=$($u.DisplayName)"\nWrite-Output "EMAIL=$($u.EmailAddress)"\n` +
          `Write-Output "ENABLED=$($u.Enabled)"\nWrite-Output "LOCKED=$($u.LockedOut)"\nWrite-Output "PWDEXP=$($u.PasswordExpired)"\n` +
          `Write-Output "PWDSET=$(if ($u.PasswordLastSet) { $u.PasswordLastSet.ToString('yyyy-MM-dd') } else { 'Never' })"\n` +
          `Write-Output "LOGON=$(if ($u.LastLogonDate) { $u.LastLogonDate.ToString('yyyy-MM-dd') } else { 'Never' })"\nWrite-Output "OU=$ou"`
        )
        if (out.includes('NOT_FOUND')) { await send(token, chatId, `❌ User not found: ${escapeHtml(username)}`); break }
        const get = (key: string) => out.match(new RegExp(`${key}=(.*)`))?.[1]?.trim() ?? '—'
        await send(token, chatId,
          `👤 <b>${escapeHtml(get('NAME'))}</b> (<code>${escapeHtml(get('SAM'))}</code>)\n\n` +
          `📧 ${escapeHtml(get('EMAIL'))}\n` +
          `${get('ENABLED')==='True' ? '🟢 Enabled' : '🔴 Disabled'}${get('LOCKED')==='True' ? '  🔒 Locked' : ''}\n` +
          `${get('PWDEXP')==='True' ? '⚠️ Password expired\n' : ''}` +
          `🕐 Last logon: <code>${get('LOGON')}</code>\n` +
          `🔑 Password set: <code>${get('PWDSET')}</code>\n` +
          `🗂 OU: <code>${escapeHtml(get('OU'))}</code>`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'adgroups': {
      const username = args[0]
      await send(token, chatId, `🔍 Groups for <b>${escapeHtml(username)}</b>…`, true)
      try {
        const out = await runAdScript(`Get-ADPrincipalGroupMembership '${username}' | Sort-Object Name | ForEach-Object { Write-Output $_.Name }`)
        const groups = out.split('\n').map(l => l.trim()).filter(Boolean)
        if (!groups.length) { await send(token, chatId, `No groups found for ${escapeHtml(username)}.`); break }
        await send(token, chatId,
          `👥 <b>Groups for ${escapeHtml(username)}</b> (${groups.length})\n\n` +
          groups.map(g => `• <code>${escapeHtml(g)}</code>`).join('\n'), true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'adgroup': {
      const groupName = args.join(' ')
      await send(token, chatId, `🔍 Members of <b>${escapeHtml(groupName)}</b>…`, true)
      try {
        const out = await runAdScript(`Get-ADGroupMember -Identity '${groupName}' -Recursive | Sort-Object Name | ForEach-Object { Write-Output "$($_.objectClass): $($_.Name) ($($_.SamAccountName))" }`)
        const members = out.split('\n').map(l => l.trim()).filter(Boolean)
        if (!members.length) { await send(token, chatId, `Group is empty or not found: ${escapeHtml(groupName)}`); break }
        const lines = members.slice(0,50).map(m => `${m.startsWith('user:') ? '👤' : '👥'} ${escapeHtml(m.replace(/^(user|group): /,''))}`)
        await send(token, chatId,
          `👥 <b>${escapeHtml(groupName)}</b> — ${members.length} member(s)\n\n` +
          lines.join('\n') + (members.length > 50 ? `\n…and ${members.length - 50} more` : ''), true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'adlocked': {
      await send(token, chatId, '🔍 Searching for locked accounts…')
      try {
        const out = await runAdScript(`Search-ADAccount -LockedOut | Sort-Object Name | ForEach-Object { Write-Output "$($_.SamAccountName)\t$($_.Name)" }`)
        const rows = out.split('\n').map(l => l.trim()).filter(Boolean)
        if (!rows.length) { await send(token, chatId, '✅ No locked accounts.'); break }
        await send(token, chatId, `🔒 <b>Locked accounts</b> (${rows.length})\n\n` +
          rows.map(r => { const [s,n]=r.split('\t'); return `🔒 <b>${escapeHtml(n||s)}</b> (<code>${escapeHtml(s)}</code>)` }).join('\n'), true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'adexpired': {
      await send(token, chatId, '🔍 Searching for expired passwords…')
      try {
        const out = await runAdScript(`Search-ADAccount -PasswordExpired -UsersOnly | Sort-Object Name | ForEach-Object { Write-Output "$($_.SamAccountName)\t$($_.Name)" }`)
        const rows = out.split('\n').map(l => l.trim()).filter(Boolean)
        if (!rows.length) { await send(token, chatId, '✅ No expired passwords.'); break }
        await send(token, chatId, `⚠️ <b>Expired passwords</b> (${rows.length})\n\n` +
          rows.map(r => { const [s,n]=r.split('\t'); return `⚠️ <b>${escapeHtml(n||s)}</b> (<code>${escapeHtml(s)}</code>)` }).join('\n'), true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'addisabled': {
      await send(token, chatId, '🔍 Searching for disabled accounts…')
      try {
        const out = await runAdScript(`Search-ADAccount -AccountDisabled -UsersOnly | Sort-Object Name | ForEach-Object { Write-Output "$($_.SamAccountName)\t$($_.Name)" }`)
        const rows = out.split('\n').map(l => l.trim()).filter(Boolean)
        if (!rows.length) { await send(token, chatId, '✅ No disabled accounts.'); break }
        const lines = rows.slice(0,50).map(r => { const [s,n]=r.split('\t'); return `🚫 <b>${escapeHtml(n||s)}</b> (<code>${escapeHtml(s)}</code>)` })
        await send(token, chatId, `🚫 <b>Disabled accounts</b> (${rows.length})\n\n` +
          lines.join('\n') + (rows.length > 50 ? `\n…and ${rows.length - 50} more` : ''), true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'adhealth': {
      await send(token, chatId, '🏥 Running domain health check…')
      try {
        const out = await runAdScript(
          `$dom=$( Get-ADDomain); $dcs=(Get-ADDomainController -Filter *); $repl=(Get-ADReplicationFailure -Scope Forest -ErrorAction SilentlyContinue)\n` +
          `$svcs=@('NTDS','NETLOGON','W32Time','DNS','KDC')|ForEach-Object{$s=Get-Service $_ -ErrorAction SilentlyContinue;"$_=$($s.Status)"}\n` +
          `Write-Output "DOMAIN=$($dom.DNSRoot)"\nWrite-Output "DOMAINMODE=$($dom.DomainMode)"\nWrite-Output "PDC=$($dom.PDCEmulator)"\n` +
          `Write-Output "DCCOUNT=$($dcs.Count)"\nWrite-Output "REPLF=$(($repl|Measure-Object).Count)"\nWrite-Output "SVCS=$($svcs -join ',')"`)
        const get = (key: string) => out.match(new RegExp(`${key}=(.*)`))?.[1]?.trim() ?? '—'
        const replFail = parseInt(get('REPLF') || '0')
        const svcs = get('SVCS').split(',').map(s => { const [n,st]=s.split('='); return `${st==='Running'?'🟢':'🔴'} ${n}` })
        await send(token, chatId,
          `🏥 <b>Domain Health</b>\n\n🌐 Domain: <code>${escapeHtml(get('DOMAIN'))}</code>\n📋 Mode: <code>${escapeHtml(get('DOMAINMODE'))}</code>\n` +
          `👑 PDC: <code>${escapeHtml(get('PDC'))}</code>\n🖥 DCs: <b>${get('DCCOUNT')}</b>\n` +
          `${replFail>0?`⚠️ Replication failures: <b>${replFail}</b>\n`:'✅ Replication: OK\n'}\n<b>Services:</b>\n${svcs.join('\n')}`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
    case 'adpolicy': {
      await send(token, chatId, '🔍 Reading password policy…')
      try {
        const out = await runAdScript(
          `$p=Get-ADDefaultDomainPasswordPolicy\n` +
          `Write-Output "MINLEN=$($p.MinPasswordLength)"\nWrite-Output "HISTORY=$($p.PasswordHistoryCount)"\n` +
          `Write-Output "COMPLEX=$($p.ComplexityEnabled)"\nWrite-Output "MAXAGE=$($p.MaxPasswordAge.Days)"\n` +
          `Write-Output "MINAGE=$($p.MinPasswordAge.Days)"\nWrite-Output "LOCKOUT=$($p.LockoutThreshold)"\n` +
          `Write-Output "LOCKDUR=$($p.LockoutDuration.Minutes)"\nWrite-Output "LOCKOBS=$($p.LockoutObservationWindow.Minutes)"`)
        const get = (key: string) => out.match(new RegExp(`${key}=(.*)`))?.[1]?.trim() ?? '—'
        await send(token, chatId,
          `🔑 <b>Password Policy</b>\n\nMin length: <b>${get('MINLEN')}</b>\nHistory: <b>${get('HISTORY')}</b> passwords\n` +
          `Complexity: <b>${get('COMPLEX')}</b>\nMax age: <b>${get('MAXAGE')}</b> days\nMin age: <b>${get('MINAGE')}</b> days\n\n` +
          `🔒 <b>Lockout Policy</b>\nThreshold: <b>${get('LOCKOUT')}</b> attempts\nDuration: <b>${get('LOCKDUR')}</b> min\nObservation: <b>${get('LOCKOBS')}</b> min`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }
  }
}

// ── Command handler ────────────────────────────────────────────────────────────

async function handle(token: string, msg: TgMessage, settings: TgSettings): Promise<void> {
  const chatId = msg.chat.id
  const text = (msg.text ?? '').trim()
  const who = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name ?? 'Unknown')

  // ── Check for pending TOTP reply ──
  if (challenges.has(chatId) && /^\d{6,8}$/.test(text)) {
    const ch = challenges.get(chatId)!
    if (Date.now() > ch.expiresAt) {
      challenges.delete(chatId)
      await send(token, chatId, '⏰ Code expired. Please reissue the command.')
      return
    }

    const normalizedSecret = settings.totpSecret.trim().toUpperCase().replace(/[^A-Z2-7=]/g, '')
    const replayKey = `${normalizedSecret}:${text}`
    const valid = normalizedSecret &&
      !usedTotpCodes.has(replayKey) &&
      speakeasy.totp.verify({ secret: normalizedSecret, encoding: 'base32', token: text, window: 1 })

    if (!valid) {
      challenges.delete(chatId)
      const reason = !normalizedSecret ? 'TOTP not configured.'
        : usedTotpCodes.has(replayKey) ? 'Code already used. Wait for the next 30-second code.'
        : 'Wrong code.'
      await send(token, chatId, `❌ Action cancelled — ${reason}`)
      return
    }

    usedTotpCodes.add(replayKey)

    challenges.delete(chatId)

    // ── AD actions ──
    if (ch.action === 'adunlock') {
      await send(token, chatId, `🔓 Unlocking <b>${escapeHtml(ch.adUser!)}</b>…`, true)
      try {
        await runAdScript(`Unlock-ADAccount -Identity '${ch.adUser}'; Write-Output 'OK'`)
        await send(token, chatId, `✅ Account <b>${escapeHtml(ch.adUser!)}</b> unlocked.`, true)
      } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
      return
    }

    if (ch.action === 'adenable') {
      await send(token, chatId, `✅ Enabling <b>${escapeHtml(ch.adUser!)}</b>…`, true)
      try {
        await runAdScript(`Enable-ADAccount -Identity '${ch.adUser}'; Write-Output 'OK'`)
        await send(token, chatId, `✅ Account <b>${escapeHtml(ch.adUser!)}</b> enabled.`, true)
      } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
      return
    }

    if (ch.action === 'addisable') {
      await send(token, chatId, `🚫 Disabling <b>${escapeHtml(ch.adUser!)}</b>…`, true)
      try {
        await runAdScript(`Disable-ADAccount -Identity '${ch.adUser}'; Write-Output 'OK'`)
        await send(token, chatId, `✅ Account <b>${escapeHtml(ch.adUser!)}</b> disabled.`, true)
      } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
      return
    }

    if (ch.action === 'adreset') {
      await send(token, chatId, `🔑 Resetting password for <b>${escapeHtml(ch.adUser!)}</b>…`, true)
      try {
        const pwd = ch.adPassword!
        await runAdScript(
          `$s = ConvertTo-SecureString '${pwd.replace(/'/g,"''")}' -AsPlainText -Force\n` +
          `Set-ADAccountPassword -Identity '${ch.adUser}' -NewPassword $s -Reset\n` +
          `Set-ADUser -Identity '${ch.adUser}' -ChangePasswordAtLogon $false\n` +
          `Write-Output 'OK'`
        )
        // sync vault credential
        const anyDb = db as any
        const domainVariants = [ch.adUser!, ch.adUser!.toLowerCase()]
        for (const variant of domainVariants) {
          const creds = await anyDb.selectFrom('server_credentials').selectAll()
            .where('linux_user', 'ilike', `%\\${variant}`).where('is_archived', '=', false).execute()
          for (const c of creds) {
            const { encryptSecret, getVaultKey } = await import('../../utils/vault')
            const key = await getVaultKey()
            const enc = encryptSecret(pwd, key)
            await anyDb.updateTable('server_credentials').set({ password_enc: enc, updated_at: new Date() }).where('id', '=', c.id).execute()
          }
        }
        await send(token, chatId, `✅ Password reset for <b>${escapeHtml(ch.adUser!)}</b>. Vault synced.`, true)
      } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
      return
    }

    // ── Generic pending command ──
    if (ch.action === 'pending' && ch.pendingCmd) {
      await executeCommand(token, chatId, settings, ch.pendingCmd, ch.pendingArgs ?? [])
      return
    }

    // ── Service actions ──
    await send(token, chatId, `⚙️ Executing <b>${ch.action} ${ch.service}</b> on <b>${ch.serverName}</b>…`, true)

    try {
      const status = await sshBot(ch.serverId!, async (client) => {
        const { sshExec } = await import('../../utils/ssh')
        const out = await sshExec(client, `sudo systemctl ${ch.action} ${ch.service} 2>&1; echo EXIT:$?`)
        const code = parseInt(out.stdout.match(/EXIT:(\d+)/)?.[1] ?? '0')
        if (code !== 0) {
          const err = out.stdout.replace(/EXIT:\d+\n?$/, '').trim()
          throw new Error(err || out.stderr)
        }
        const st = await sshExec(client, `systemctl is-active ${ch.service} 2>/dev/null`)
        return st.stdout.trim()
      }) as string
      await send(token, chatId, `✅ Done! <b>${ch.service}</b> on <b>${ch.serverName}</b> → <code>${status}</code>`, true)
    } catch (err) {
      await send(token, chatId, `❌ Failed: ${(err as Error).message}`)
    }
    return
  }

  // ── Cancel pending challenge on any non-TOTP text ──
  if (challenges.has(chatId) && !/^\d{6,8}$/.test(text)) {
    challenges.delete(chatId)
    await send(token, chatId, '❎ Action cancelled.')
    return
  }

  // ── Parse command ──
  if (!text.startsWith('/')) return
  const [cmdRaw, ...args] = text.split(/\s+/)
  const cmd = cmdRaw.replace(/^\//, '').split('@')[0].toLowerCase()

  switch (cmd) {
    case 'help':
    case 'start': {
      await send(token, chatId,
        `🔐 <b>SSH Manager Bot</b>\n\n` +
        `<b>── Servers ──</b>\n` +
        `/servers — list all servers\n` +
        `/status &lt;server&gt; — connection info\n` +
        `/software &lt;server&gt; — installed software\n\n` +
        `<b>── Linux Info ──</b>\n` +
        `/disk &lt;server&gt; — disk usage\n` +
        `/memory &lt;server&gt; — RAM &amp; load average\n` +
        `/top &lt;server&gt; — top CPU processes\n` +
        `/users &lt;server&gt; — logged-in users\n\n` +
        `<b>── Linux Services ──</b>\n` +
        `/restart &lt;service&gt; &lt;server&gt; ⚠️\n` +
        `/stop &lt;service&gt; &lt;server&gt; ⚠️\n` +
        `/start &lt;service&gt; &lt;server&gt; ⚠️\n\n` +
        `<b>── Active Directory ──</b>\n` +
        `/aduser &lt;username&gt; — user details\n` +
        `/adgroups &lt;username&gt; — groups a user belongs to\n` +
        `/adgroup &lt;groupname&gt; — members of a group\n` +
        `/adlocked — all locked-out accounts\n` +
        `/adexpired — expired password accounts\n` +
        `/addisabled — disabled accounts\n` +
        `/adhealth — domain health summary\n` +
        `/adpolicy — password policy\n` +
        `/adunlock &lt;username&gt; ⚠️ — unlock account\n` +
        `/adenable &lt;username&gt; ⚠️ — enable account\n` +
        `/addisable &lt;username&gt; ⚠️ — disable account\n` +
        `/adreset &lt;username&gt; &lt;password&gt; ⚠️ — reset password\n\n` +
        `⚠️ = requires TOTP confirmation\n\n` +
        `<b>── Utilities ──</b>\n` +
        `/totptest &lt;code&gt; — verify your TOTP code is working`, true)
      break
    }

    case 'totptest': {
      if (!settings.totpSecret) {
        await send(token, chatId, '❌ Bot TOTP is not configured. Set it up in SSH Manager → Settings → Telegram.')
        break
      }
      const code = args[0]
      if (!code || !/^\d{6,8}$/.test(code)) {
        await send(token, chatId, 'Usage: /totptest &lt;6-digit code&gt;\n\nSend your current TOTP code to verify it works.', true)
        break
      }
      const speakeasy = await import('speakeasy')
      const serverTime = new Date()
      const secret = settings.totpSecret.trim().toUpperCase().replace(/[^A-Z2-7=]/g, '')
      const expected = speakeasy.totp({ secret, encoding: 'base32' })
      const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 2 })
      // Show last 4 chars of secret so user can verify they scanned the right QR
      const secretHint = secret.length >= 4 ? `****${secret.slice(-4)}` : '(empty)'
      if (valid) {
        await send(token, chatId,
          `✅ <b>TOTP code is valid!</b>\n\n` +
          `Secret (last 4): <code>${secretHint}</code>\n` +
          `TOTP-gated commands will work.`, true)
      } else {
        await send(token, chatId,
          `❌ <b>TOTP code is invalid.</b>\n\n` +
          `You entered: <code>${code}</code>\n` +
          `Server expects: <code>${expected}</code>\n` +
          `Server time: <code>${serverTime.toLocaleString('en-GB', { timeZone: process.env.TZ ?? 'UTC', hour12: false })}</code>\n` +
          `Secret (last 4): <code>${secretHint}</code>\n\n` +
          `Check your authenticator — make sure the account ending in <code>${secretHint}</code> is selected.\n\n` +
          `If still failing: SSH Manager → Settings → Telegram → Generate New → scan fresh QR → Save.`, true)
      }
      break
    }

    case 'servers': {
      if (!isEnabled(settings, 'servers')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'servers')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'status': {
      if (!isEnabled(settings, 'status')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /status &lt;server&gt;', true); break }
      if (needsTotp(settings, 'status')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'software': {
      if (!isEnabled(settings, 'software')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /software &lt;server&gt;', true); break }
      if (needsTotp(settings, 'software')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'disk': {
      if (!isEnabled(settings, 'linux_info')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /disk &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'memory':
    case 'mem': {
      if (!isEnabled(settings, 'linux_info')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /memory &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'top': {
      if (!isEnabled(settings, 'linux_info')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /top &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'users': {
      if (!isEnabled(settings, 'linux_info')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /users &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'restart':
    case 'stop':
    case 'start': {
      if (!isEnabled(settings, 'linux_svc')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (args.length < 2) { await send(token, chatId, `Usage: /${cmd} &lt;service&gt; &lt;server&gt;`, true); break }
      const service = args[0]
      const serverName = args.slice(1).join(' ')
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',serverName).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${serverName}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      const icon = cmd === 'stop' ? '🛑' : cmd === 'restart' ? '🔄' : '▶️'
      if (!needsTotp(settings, 'linux_svc')) {
        await send(token, chatId, `${icon} Executing <b>${cmd} ${service}</b> on <b>${server.name}</b>…`, true)
        try {
          const { sshExec } = await import('../../utils/ssh')
          const status = await sshBot(server.id, async (client) => {
            const out = await sshExec(client, `sudo systemctl ${cmd} ${service} 2>&1; echo EXIT:$?`)
            const code = parseInt(out.stdout.match(/EXIT:(\d+)/)?.[1] ?? '0')
            if (code !== 0) throw new Error(out.stdout.replace(/EXIT:\d+\n?$/, '').trim() || out.stderr)
            return (await sshExec(client, `systemctl is-active ${service} 2>/dev/null`)).stdout.trim()
          }) as string
          await send(token, chatId, `✅ Done! <b>${service}</b> on <b>${server.name}</b> → <code>${status}</code>`, true)
        } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
        break
      }
      if (!settings.totpSecret) {
        await send(token, chatId, '❌ Bot TOTP not configured. Set it up in SSH Manager → Settings → Telegram.')
        break
      }
      challenges.set(chatId, {
        action: cmd as 'start'|'stop'|'restart', service,
        serverName: server.name, serverId: server.id, who,
        expiresAt: Date.now() + 60_000,
      })
      await send(token, chatId,
        `${icon} <b>Action requires TOTP confirmation</b>\n\n` +
        `Action: <code>${cmd} ${service}</code>\n` +
        `Server: <b>${server.name}</b>\n` +
        `Requested by: ${who}\n\n` +
        `Reply with your <b>TOTP authenticator code</b> within 60 seconds.\n` +
        `Any other reply will cancel.`, true)
      break
    }

    // ── AD read-only commands ──────────────────────────────────────────────────

    case 'aduser': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /aduser &lt;username&gt;', true); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adgroups': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /adgroups &lt;username&gt;', true); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adgroup': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /adgroup &lt;groupname&gt;', true); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adlocked': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adexpired': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'addisabled': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adhealth': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adpolicy': {
      if (!isEnabled(settings, 'ad_read')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    // ── AD write commands ──────────────────────────────────────────────────────

    case 'adunlock':
    case 'adenable':
    case 'addisable': {
      if (!isEnabled(settings, 'ad_write')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, `Usage: /${cmd} &lt;username&gt;`, true); break }
      const adUser = args[0]
      const icons: Record<string, string> = { adunlock: '🔓', adenable: '✅', addisable: '🚫' }
      const labels: Record<string, string> = { adunlock: 'Unlock', adenable: 'Enable', addisable: 'Disable' }
      if (!needsTotp(settings, 'ad_write')) {
        await send(token, chatId, `${icons[cmd]} Executing <b>${labels[cmd]}</b> on <b>${escapeHtml(adUser)}</b>…`, true)
        try {
          await runAdScript(
            cmd === 'adunlock' ? `Unlock-ADAccount -Identity '${adUser}'` :
            cmd === 'adenable' ? `Enable-ADAccount -Identity '${adUser}'` :
                                 `Disable-ADAccount -Identity '${adUser}'`
          )
          await send(token, chatId, `✅ Done! Account <b>${escapeHtml(adUser)}</b> → <b>${labels[cmd]}d</b>.`, true)
        } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
        break
      }
      if (!settings.totpSecret) { await send(token, chatId, '❌ Bot TOTP not configured. Set it up in SSH Manager → Settings → Telegram.'); break }
      challenges.set(chatId, { action: cmd as ChallengeAction, adUser, who, expiresAt: Date.now() + 60_000 })
      await send(token, chatId,
        `${icons[cmd]} <b>Action requires TOTP confirmation</b>\n\n` +
        `Action: <code>${labels[cmd]} account</code>\n` +
        `User: <b>${escapeHtml(adUser)}</b>\n` +
        `Requested by: ${who}\n\n` +
        `Reply with your <b>TOTP code</b> within 60 seconds.\nAny other reply cancels.`, true)
      break
    }

    case 'adreset': {
      if (!isEnabled(settings, 'ad_write')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (args.length < 2) { await send(token, chatId, 'Usage: /adreset &lt;username&gt; &lt;newpassword&gt;', true); break }
      const [adUser, ...rest] = args
      const adPassword = rest.join(' ')
      if (!needsTotp(settings, 'ad_write')) {
        await send(token, chatId, `🔑 Resetting password for <b>${escapeHtml(adUser)}</b>…`, true)
        try {
          await runAdScript(`Set-ADAccountPassword -Identity '${adUser}' -NewPassword (ConvertTo-SecureString '${adPassword}' -AsPlainText -Force) -Reset`)
          await send(token, chatId, `✅ Password for <b>${escapeHtml(adUser)}</b> has been reset.`, true)
        } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
        break
      }
      if (!settings.totpSecret) { await send(token, chatId, '❌ Bot TOTP not configured. Set it up in SSH Manager → Settings → Telegram.'); break }
      challenges.set(chatId, { action: 'adreset', adUser, adPassword, who, expiresAt: Date.now() + 60_000 })
      await send(token, chatId,
        `🔑 <b>Password reset requires TOTP confirmation</b>\n\n` +
        `User: <b>${escapeHtml(adUser)}</b>\n` +
        `Requested by: ${who}\n\n` +
        `Reply with your <b>TOTP code</b> within 60 seconds.\nAny other reply cancels.`, true)
      break
    }

    default:
      await send(token, chatId, `Unknown command. Send /help for the list.`)
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────────

export function startTelegramBot(): () => void {
  let running = true
  let offset = 0

  async function loop(): Promise<void> {
    while (running) {
      try {
        const settings = await getSettings()

        if (!settings.enabled || !settings.token) {
          await new Promise((r) => setTimeout(r, 10_000))
          continue
        }

        const updates = await fetchUpdates(settings.token, offset)

        for (const upd of updates) {
          offset = upd.update_id + 1
          if (!upd.message?.text) continue

          const chatId = upd.message.chat.id

          if (settings.allowedChats.length > 0 && !settings.allowedChats.includes(chatId)) {
            await send(settings.token, chatId, '🚫 This chat is not authorised.')
            continue
          }

          await handle(settings.token, upd.message, settings).catch((err) => {
            console.error('[Telegram] handler error:', err)
          })
        }
      } catch (err) {
        if (running) {
          console.error('[Telegram] poll error:', (err as Error).message)
          await new Promise((r) => setTimeout(r, 5_000))
        }
      }
    }
  }

  loop().catch((err) => console.error('[Telegram] fatal:', err))
  return () => { running = false }
}
