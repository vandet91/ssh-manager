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
import { writeAuditLog } from '../../utils/audit'
import { Client } from 'ssh2'

// 5-second connect timeout for bot commands — fail fast if server is unreachable
const sshBot = <T>(serverId: string, fn: (client: Client) => Promise<T>) =>
  withServerSsh(serverId, fn, undefined, 5000)

function tgAudit(who: string, action: string, resource?: string, serverId?: string, details?: Record<string, unknown>) {
  writeAuditLog({ userEmail: `tg:${who}`, action, resource: resource ?? null, serverId: serverId ?? null, details: { via: 'telegram', ...details } }).catch(() => {})
}

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

interface TgGroupConfig { enabled: boolean; totp: boolean; cmds?: Record<string, boolean> }
interface TgCommands { servers: TgGroupConfig; status: TgGroupConfig; software: TgGroupConfig; linux_info: TgGroupConfig; linux_svc: TgGroupConfig; ad_read: TgGroupConfig; ad_write: TgGroupConfig; network: TgGroupConfig; tasks: TgGroupConfig }
interface TgSettings { enabled: boolean; token: string; allowedChats: number[]; totpSecret: string; commands: TgCommands }

const DEFAULT_COMMANDS: TgCommands = {
  servers:    { enabled: true,  totp: false },
  status:     { enabled: true,  totp: false },
  software:   { enabled: true,  totp: false },
  linux_info: { enabled: true,  totp: false },
  linux_svc:  { enabled: true,  totp: true  },
  ad_read:    { enabled: true,  totp: false },
  ad_write:   { enabled: true,  totp: true  },
  network:    { enabled: true,  totp: false },
  tasks:      { enabled: true,  totp: true  },
}

function normalizeGroup(val: unknown, def: TgGroupConfig): TgGroupConfig {
  if (val === null || val === undefined) return def
  if (typeof val === 'boolean') return { enabled: val, totp: def.totp }
  const v = val as Partial<TgGroupConfig>
  return { enabled: v.enabled ?? def.enabled, totp: v.totp ?? def.totp, cmds: v.cmds }
}

function isCmdEnabled(settings: TgSettings, group: keyof TgCommands, cmd: string): boolean {
  if (!isEnabled(settings, group)) return false
  const cmds = settings.commands[group].cmds
  if (!cmds) return true
  return cmds[cmd] !== false
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
    network:    normalizeGroup(raw['network'],    DEFAULT_COMMANDS.network),
    tasks:      normalizeGroup(raw['tasks'],      DEFAULT_COMMANDS.tasks),
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

type ChallengeAction = 'start' | 'stop' | 'restart' | 'adunlock' | 'adenable' | 'addisable' | 'adreset' | 'runtask' | 'reboot' | 'rebootdevice' | 'pending'

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
  // runtask
  taskId?: string
  taskName?: string
  // reboot (linux server)
  rebootServerId?: string
  rebootServerName?: string
  // rebootdevice (network device)
  rebootDeviceId?: string
  rebootDeviceName?: string
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
      // Only servers and VMs
      const servers = await (db as any).selectFrom('servers')
        .select(['name','hostname','environment','device_category','os_type','ping_last_status','last_connected_at'])
        .where('is_active','=',true)
        .where('device_category','in',['server','vm'])
        .orderBy('device_category').orderBy('name').execute()
      if (!servers.length) { await send(token, chatId, 'No servers.'); break }

      const groups = new Map<string, typeof servers>()
      for (const s of servers) {
        const cat = s.device_category ?? 'server'
        if (!groups.has(cat)) groups.set(cat, [])
        groups.get(cat)!.push(s)
      }
      const catLabel: Record<string, string> = { server: '🖥 Servers', vm: '☁️ VMs' }
      const sections: string[] = []
      for (const [cat, list] of groups) {
        const header = catLabel[cat] ?? `📁 ${cat}`
        const lines = list.map((s: any) => {
          const ping = s.ping_last_status === 'up' ? '🟢' : s.ping_last_status === 'down' ? '🔴' : '⚪'
          const env = s.environment ? ` [${s.environment}]` : ''
          const os = s.os_type ? ` — ${s.os_type}` : ''
          return `${ping} <b>${s.name}</b> <code>${s.hostname}</code>${env}${os}`
        })
        sections.push(`<b>${header} (${list.length})</b>\n${lines.join('\n')}`)
      }
      await send(token, chatId, `📋 <b>Servers (${servers.length})</b>\n\n${sections.join('\n\n')}`, true)
      break
    }

    case 'devices': {
      // Network devices and other — optional filter arg e.g. /devices network
      const filterCat = args[0]?.toLowerCase() ?? null
      let query = (db as any).selectFrom('servers')
        .select(['name','hostname','environment','device_category','ping_last_status','snmp_vendor','snmp_model','last_connected_at'])
        .where('is_active','=',true)
        .where('device_category','in',['network','other'])
      if (filterCat) query = query.where('device_category','ilike',`%${filterCat}%`)
      const servers = await query.orderBy('device_category').orderBy('name').execute()
      if (!servers.length) { await send(token, chatId, filterCat ? `No devices in category: ${filterCat}` : 'No network devices.'); break }

      const groups = new Map<string, typeof servers>()
      for (const s of servers) {
        const cat = s.device_category ?? 'other'
        if (!groups.has(cat)) groups.set(cat, [])
        groups.get(cat)!.push(s)
      }
      const catLabel: Record<string, string> = { network: '🌐 Network', other: '📦 Other' }
      const sections: string[] = []
      for (const [cat, list] of groups) {
        const header = catLabel[cat] ?? `📁 ${cat}`
        const lines = list.map((s: any) => {
          const ping = s.ping_last_status === 'up' ? '🟢' : s.ping_last_status === 'down' ? '🔴' : '⚪'
          const env = s.environment ? ` [${s.environment}]` : ''
          const extra = s.snmp_vendor ? ` — ${s.snmp_vendor} ${s.snmp_model ?? ''}`.trim() : ''
          return `${ping} <b>${s.name}</b> <code>${s.hostname}</code>${env}${extra}`
        })
        sections.push(`<b>${header} (${list.length})</b>\n${lines.join('\n')}`)
      }
      await send(token, chatId, `📋 <b>Network Devices (${servers.length})</b>\n\n${sections.join('\n\n')}`, true)
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

    // ── New: Ping (from DB) ──────────────────────────────────────────────────
    case 'ping': {
      const name = args.join(' ')
      const server = await (db as any).selectFrom('servers').selectAll()
        .where('name', 'ilike', name).where('is_active', '=', true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${name}`); break }
      const status = server.ping_last_status ?? 'unknown'
      const latency = server.ping_last_latency_ms != null ? `${server.ping_last_latency_ms} ms` : '—'
      const checkedAt = server.ping_last_at ? new Date(server.ping_last_at).toLocaleString() : 'Never'
      const icon = status === 'up' ? '🟢' : status === 'down' ? '🔴' : '⚪'
      await send(token, chatId,
        `${icon} <b>Ping: ${server.name}</b>\n\nStatus: <b>${status}</b>\nLatency: <b>${latency}</b>\nChecked: <code>${checkedAt}</code>`, true)
      break
    }

    // ── New: Ping all ────────────────────────────────────────────────────────
    case 'pingall': {
      const servers = await (db as any).selectFrom('servers')
        .select(['name', 'hostname', 'ping_last_status', 'ping_last_latency_ms', 'ping_last_at'])
        .where('is_active', '=', true).orderBy('name').execute()
      if (!servers.length) { await send(token, chatId, 'No servers.'); break }
      const lines = servers.map((s: any) => {
        const icon = s.ping_last_status === 'up' ? '🟢' : s.ping_last_status === 'down' ? '🔴' : '⚪'
        const lat = s.ping_last_latency_ms != null ? ` ${s.ping_last_latency_ms}ms` : ''
        return `${icon} <b>${s.name}</b>${lat}`
      })
      const up = servers.filter((s: any) => s.ping_last_status === 'up').length
      const down = servers.filter((s: any) => s.ping_last_status === 'down').length
      await send(token, chatId,
        `📡 <b>Ping Status (${up}↑ ${down}↓)</b>\n\n${lines.join('\n')}`, true)
      break
    }

    // ── New: Down servers ────────────────────────────────────────────────────
    case 'down': {
      const servers = await (db as any).selectFrom('servers')
        .select(['name', 'hostname', 'ping_last_at'])
        .where('is_active', '=', true)
        .where('ping_last_status', '=', 'down')
        .orderBy('name').execute()
      if (!servers.length) { await send(token, chatId, '✅ All servers are up.'); break }
      const lines = servers.map((s: any) => {
        const since = s.ping_last_at ? new Date(s.ping_last_at).toLocaleString() : '?'
        return `🔴 <b>${s.name}</b> (<code>${s.hostname}</code>) — down since <code>${since}</code>`
      })
      await send(token, chatId, `🔴 <b>Down servers (${servers.length})</b>\n\n${lines.join('\n')}`, true)
      break
    }

    // ── New: Uptime ──────────────────────────────────────────────────────────
    case 'uptime': {
      const server = await (db as any).selectFrom('servers').selectAll()
        .where('name', 'ilike', args.join(' ')).where('is_active', '=', true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${args.join(' ')}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      try {
        const out = await sshBot(server.id, async (client) =>
          (await sshExec(client, `uptime -p 2>/dev/null || uptime; echo '---'; last reboot | head -3`)).stdout
        ) as string
        const [uptimePart, rebootPart] = out.split('---')
        await send(token, chatId,
          `⏱ <b>Uptime: ${server.name}</b>\n\n${uptimePart.trim()}\n\n<b>Last reboots:</b>\n<code>${(rebootPart ?? '').trim()}</code>`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }

    // ── New: Logs ────────────────────────────────────────────────────────────
    case 'logs': {
      if (args.length < 2) { await send(token, chatId, 'Usage: /logs &lt;service&gt; &lt;server&gt;', true); break }
      const service = args[0]
      const serverName = args.slice(1).join(' ')
      const server = await (db as any).selectFrom('servers').selectAll()
        .where('name', 'ilike', serverName).where('is_active', '=', true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${serverName}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      try {
        const out = await sshBot(server.id, async (client) =>
          (await sshExec(client, `journalctl -u ${service} -n 20 --no-pager --output=short 2>&1`)).stdout
        ) as string
        const trimmed = out.trim().slice(0, 3500)
        await send(token, chatId,
          `📋 <b>Logs: ${service} @ ${server.name}</b>\n\n<code>${escapeHtml(trimmed)}</code>`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }

    // ── New: Netstat ─────────────────────────────────────────────────────────
    case 'netstat': {
      const server = await (db as any).selectFrom('servers').selectAll()
        .where('name', 'ilike', args.join(' ')).where('is_active', '=', true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${args.join(' ')}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      try {
        const out = await sshBot(server.id, async (client) =>
          (await sshExec(client, `ss -tlnp 2>/dev/null | awk 'NR>1{print $4, $6}' | head -30`)).stdout
        ) as string
        const rows = out.split('\n').filter(Boolean).map(l => {
          const [addr, proc] = l.trim().split(/\s+/, 2)
          const name = (proc ?? '').replace(/.*"([^"]+)".*/, '$1') || '—'
          return `• <code>${(addr ?? '').padEnd(22)}</code>  ${escapeHtml(name)}`
        })
        await send(token, chatId,
          `🌐 <b>Listening ports: ${server.name}</b>\n\n${rows.join('\n')}`, true)
      } catch (err) { await send(token, chatId, `❌ ${(err as Error).message}`) }
      break
    }

    // ── New: SNMP device summary ─────────────────────────────────────────────
    case 'snmp': {
      const name = args.join(' ')
      const device = await (db as any).selectFrom('servers').selectAll()
        .where('name', 'ilike', name).where('is_active', '=', true).executeTakeFirst()
      if (!device) { await send(token, chatId, `❌ Device not found: ${name}`); break }
      if (!device.snmp_enabled) { await send(token, chatId, `❌ SNMP not enabled on ${name}`); break }
      const data = device.snmp_last_data as Record<string, any> | null
      const ifaces = device.snmp_interfaces ? JSON.parse(typeof device.snmp_interfaces === 'string' ? device.snmp_interfaces : JSON.stringify(device.snmp_interfaces)) as any[] : []
      const upCount = ifaces.filter(i => i.operStatus === 'up').length
      const checkedAt = device.snmp_last_fetched_at ? new Date(device.snmp_last_fetched_at).toLocaleString() : 'Never'
      await send(token, chatId,
        `📡 <b>SNMP: ${device.name}</b>\n\n` +
        `Vendor: <b>${device.snmp_vendor ?? '—'}</b>\n` +
        `Model: <b>${device.snmp_model ?? '—'}</b>\n` +
        `Firmware: <b>${device.snmp_firmware ?? '—'}</b>\n` +
        `Serial: <b>${device.snmp_serial ?? '—'}</b>\n` +
        `Hostname: <b>${device.snmp_hostname ?? '—'}</b>\n` +
        `MAC: <code>${device.snmp_mac_address ?? '—'}</code>\n` +
        `Interfaces: <b>${ifaces.length}</b> total, <b>${upCount}</b> up\n` +
        (data?.sysDescr ? `sysDescr: <code>${escapeHtml(String(data.sysDescr).slice(0, 120))}</code>\n` : '') +
        `\nLast polled: <code>${checkedAt}</code>`, true)
      break
    }

    // ── New: Interface list ──────────────────────────────────────────────────
    case 'interfaces': {
      // Usage: /interfaces <device> [up|down|trunk|access]
      const filterArg = ['up','down','trunk','access'].includes(args[args.length - 1]?.toLowerCase() ?? '')
        ? args[args.length - 1].toLowerCase() : null
      const nameParts = filterArg ? args.slice(0, -1) : args
      const name = nameParts.join(' ')
      const device = await (db as any).selectFrom('servers').selectAll()
        .where('name', 'ilike', name).where('is_active', '=', true).executeTakeFirst()
      if (!device) { await send(token, chatId, `❌ Device not found: ${name}`); break }
      if (!device.snmp_interfaces) { await send(token, chatId, `❌ No SNMP interface data for ${name}. Run SNMP fetch first.`); break }
      const raw = device.snmp_interfaces
      const allIfaces = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as any[]
      if (!allIfaces.length) { await send(token, chatId, 'No interfaces found.'); break }

      // Apply filter
      let ifaces = allIfaces
      if (filterArg === 'up')     ifaces = allIfaces.filter(i => i.oper_up)
      if (filterArg === 'down')   ifaces = allIfaces.filter(i => i.admin_up && !i.oper_up)
      if (filterArg === 'trunk')  ifaces = allIfaces.filter(i => i.mode === 'trunk')
      if (filterArg === 'access') ifaces = allIfaces.filter(i => i.mode === 'access')

      if (!ifaces.length) { await send(token, chatId, `No interfaces matching filter: ${filterArg}`); break }

      const formatSpeed = (mbps: number) => {
        if (!mbps) return ''
        if (mbps >= 1000) return ` ${mbps / 1000}G`
        return ` ${mbps}M`
      }
      const stpIcon: Record<string, string> = {
        forwarding: '✅', blocking: '🚫', listening: '👂', learning: '📖',
        disabled: '⛔', broken: '💥',
      }

      const lines = ifaces.slice(0, 35).map((i: any) => {
        const operIcon = i.oper_up ? '🟢' : (i.admin_up ? '🔴' : '⬛')
        const portName = (i.name ?? `if${i.index}`).toString()
        const speed = formatSpeed(i.speed_mbps)
        const mode = i.mode && i.mode !== 'unknown' ? ` [${i.mode}]` : ''
        const vlan = i.pvid ? ` V${i.pvid}` : ''
        const stp = i.stp_state ? ` ${stpIcon[i.stp_state] ?? ''}${i.stp_state !== 'forwarding' ? i.stp_state : ''}` : ''
        const edge = i.edge_port === true ? ' ⚡' : ''
        const dot1x = i.dot1x ? ` 🔐${i.dot1x}` : ''
        const neighbor = i.neighbor?.sys_name ? ` →${i.neighbor.sys_name}` : ''
        const alias = i.alias ? ` <i>${escapeHtml(i.alias.slice(0, 20))}</i>` : ''
        return `${operIcon} <code>${portName.padEnd(12)}</code>${speed}${mode}${vlan}${stp}${edge}${dot1x}${neighbor}${alias}`
      })

      const upCount   = allIfaces.filter((i: any) => i.oper_up).length
      const downCount = allIfaces.filter((i: any) => i.admin_up && !i.oper_up).length
      const disCount  = allIfaces.filter((i: any) => !i.admin_up).length
      const trunkCount = allIfaces.filter((i: any) => i.mode === 'trunk').length
      const filterNote = filterArg ? ` [filter: ${filterArg}]` : ''

      const legend = `\n\n<i>🟢up 🔴down ⬛disabled | ⚡PortFast | 🔐802.1X | →neighbor</i>`
      await send(token, chatId,
        `🔌 <b>Interfaces: ${device.name}</b>${filterNote}\n` +
        `🟢 ${upCount} up  🔴 ${downCount} down  ⬛ ${disCount} disabled  🔀 ${trunkCount} trunk\n\n` +
        lines.join('\n') +
        (ifaces.length > 35 ? `\n…and ${ifaces.length - 35} more (use /interfaces ${name} up|down|trunk|access to filter)` : '') +
        legend, true)
      break
    }

    // ── New: Tasks list ──────────────────────────────────────────────────────
    case 'tasks': {
      const tasks = await (db as any).selectFrom('task_definitions')
        .select(['id', 'title', 'trigger_type', 'cron_expr', 'is_active', 'priority'])
        .where('is_active', '=', true).orderBy('title').execute()
      if (!tasks.length) { await send(token, chatId, 'No active tasks.'); break }
      // Get last run for each task
      const taskIds = tasks.map((t: any) => t.id)
      const runs = await (db as any).selectFrom('task_runs')
        .select(['task_id', 'status', 'completed_at'])
        .where('task_id', 'in', taskIds)
        .orderBy('created_at', 'desc')
        .execute()
      const lastRun = new Map<string, any>()
      for (const r of runs) { if (!lastRun.has(r.task_id)) lastRun.set(r.task_id, r) }
      const lines = tasks.map((t: any) => {
        const run = lastRun.get(t.id)
        const runIcon = !run ? '⚪' : run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : run.status === 'running' ? '🔄' : '⏳'
        const schedule = t.trigger_type === 'schedule' ? ` <code>${t.cron_expr}</code>` : ` (${t.trigger_type})`
        return `${runIcon} <b>${escapeHtml(t.title)}</b>${schedule}`
      })
      await send(token, chatId, `📋 <b>Tasks (${tasks.length})</b>\n\n${lines.join('\n')}\n\n/runtask &lt;name&gt; to trigger`, true)
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
        tgAudit(ch.who, 'telegram.adunlock', ch.adUser)
        await send(token, chatId, `✅ Account <b>${escapeHtml(ch.adUser!)}</b> unlocked.`, true)
      } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
      return
    }

    if (ch.action === 'adenable') {
      await send(token, chatId, `✅ Enabling <b>${escapeHtml(ch.adUser!)}</b>…`, true)
      try {
        await runAdScript(`Enable-ADAccount -Identity '${ch.adUser}'; Write-Output 'OK'`)
        tgAudit(ch.who, 'telegram.adenable', ch.adUser)
        await send(token, chatId, `✅ Account <b>${escapeHtml(ch.adUser!)}</b> enabled.`, true)
      } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
      return
    }

    if (ch.action === 'addisable') {
      await send(token, chatId, `🚫 Disabling <b>${escapeHtml(ch.adUser!)}</b>…`, true)
      try {
        await runAdScript(`Disable-ADAccount -Identity '${ch.adUser}'; Write-Output 'OK'`)
        tgAudit(ch.who, 'telegram.addisable', ch.adUser)
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
        tgAudit(ch.who, 'telegram.adreset', ch.adUser)
        await send(token, chatId, `✅ Password reset for <b>${escapeHtml(ch.adUser!)}</b>. Vault synced.`, true)
      } catch (err) { await send(token, chatId, `❌ Failed: ${(err as Error).message}`) }
      return
    }

    // ── Reboot (Linux server) ──
    if (ch.action === 'reboot') {
      await send(token, chatId, `🔄 Rebooting <b>${escapeHtml(ch.rebootServerName!)}</b>…`, true)
      try {
        await sshBot(ch.rebootServerId!, async (client) => {
          const { sshExec } = await import('../../utils/ssh')
          await sshExec(client, `sudo reboot 2>&1 || true`)
        })
        tgAudit(ch.who, 'telegram.reboot', ch.rebootServerName, ch.rebootServerId)
        await send(token, chatId, `✅ Reboot command sent to <b>${escapeHtml(ch.rebootServerName!)}</b>.`, true)
      } catch (err) {
        // SSH will drop during reboot — treat connection reset as success
        const msg = (err as Error).message ?? ''
        if (/connect|reset|closed|timeout/i.test(msg)) {
          tgAudit(ch.who, 'telegram.reboot', ch.rebootServerName, ch.rebootServerId)
          await send(token, chatId, `✅ Reboot command sent to <b>${escapeHtml(ch.rebootServerName!)}</b> (connection dropped — expected).`, true)
        } else {
          await send(token, chatId, `❌ Failed: ${msg}`)
        }
      }
      return
    }

    // ── Reboot network device ──
    if (ch.action === 'rebootdevice') {
      const anyDb = db as any
      await send(token, chatId, `🔄 Rebooting device <b>${escapeHtml(ch.rebootDeviceName!)}</b>…`, true)
      const device = await anyDb.selectFrom('servers').selectAll().where('id', '=', ch.rebootDeviceId).executeTakeFirst()
      if (!device) { await send(token, chatId, `❌ Device not found.`); return }

      // Try HTTP action named "reboot" first
      const httpAction = await anyDb.selectFrom('device_http_actions').selectAll()
        .where('device_id', '=', device.id)
        .where('name', 'ilike', '%reboot%')
        .orderBy('sort_order', 'asc')
        .executeTakeFirst()

      if (httpAction && device.web_url) {
        try {
          const { decryptSecret, getVaultKey } = await import('../../utils/vault')
          const vaultKey = getVaultKey()
          const baseUrl = (device.web_url as string).replace(/\/$/, '')
          const path = httpAction.url_path.startsWith('/') ? httpAction.url_path : `/${httpAction.url_path}`
          const fullUrl = `${baseUrl}${path}`
          const headers: Record<string, string> = {
            'Content-Type': httpAction.content_type ?? 'application/json',
            ...(typeof httpAction.headers === 'string' ? JSON.parse(httpAction.headers) : httpAction.headers ?? {}),
          }
          if (httpAction.auth_type === 'basic') {
            let password = ''
            if (httpAction.vault_id) {
              const ve = await anyDb.selectFrom('vault_entries').select(['password_enc', 'username']).where('id', '=', httpAction.vault_id).executeTakeFirst()
              if (ve?.password_enc) password = decryptSecret(ve.password_enc, vaultKey)
              const user = httpAction.auth_username ?? ve?.username ?? ''
              headers['Authorization'] = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
            } else if (httpAction.auth_password_enc) {
              password = decryptSecret(httpAction.auth_password_enc, vaultKey)
              headers['Authorization'] = `Basic ${Buffer.from(`${httpAction.auth_username ?? ''}:${password}`).toString('base64')}`
            }
          } else if (httpAction.auth_type === 'bearer') {
            let token2 = ''
            if (httpAction.vault_id) {
              const ve = await anyDb.selectFrom('vault_entries').select(['password_enc']).where('id', '=', httpAction.vault_id).executeTakeFirst()
              if (ve?.password_enc) token2 = decryptSecret(ve.password_enc, vaultKey)
            } else if (httpAction.auth_password_enc) {
              token2 = decryptSecret(httpAction.auth_password_enc, vaultKey)
            }
            if (token2) headers['Authorization'] = `Bearer ${token2}`
          } else if (httpAction.auth_type === 'vault' && httpAction.vault_id) {
            const ve = await anyDb.selectFrom('vault_entries').select(['password_enc', 'username']).where('id', '=', httpAction.vault_id).executeTakeFirst()
            if (ve) {
              const password = ve.password_enc ? decryptSecret(ve.password_enc, vaultKey) : ''
              headers['Authorization'] = `Basic ${Buffer.from(`${ve.username ?? ''}:${password}`).toString('base64')}`
            }
          }
          const fetchRes = await fetch(fullUrl, {
            method: httpAction.method,
            headers,
            body: ['GET', 'DELETE'].includes(httpAction.method) ? undefined : (httpAction.body ?? undefined),
            signal: AbortSignal.timeout(httpAction.timeout_ms ?? 10000),
            redirect: httpAction.follow_redirects ? 'follow' : 'manual',
          } as RequestInit)
          if (fetchRes.ok || fetchRes.status < 500) {
            await send(token, chatId, `✅ Reboot command sent to <b>${escapeHtml(ch.rebootDeviceName!)}</b> via HTTP (${fetchRes.status}).`, true)
          } else {
            await send(token, chatId, `⚠️ HTTP reboot returned status ${fetchRes.status} for <b>${escapeHtml(ch.rebootDeviceName!)}</b>.`, true)
          }
        } catch (err) {
          const msg = (err as Error).message ?? ''
          if (/connect|reset|closed|timeout/i.test(msg)) {
            await send(token, chatId, `✅ Reboot command sent to <b>${escapeHtml(ch.rebootDeviceName!)}</b> (connection dropped — expected).`, true)
          } else {
            await send(token, chatId, `❌ HTTP reboot failed: ${msg}`)
          }
        }
        return
      }

      // SSH fallback
      if (device.management_key_id) {
        try {
          await sshBot(device.id, async (client) => {
            const { sshExec } = await import('../../utils/ssh')
            await sshExec(client, `reboot 2>&1 || reload 2>&1 || true`)
          })
          await send(token, chatId, `✅ Reboot command sent to <b>${escapeHtml(ch.rebootDeviceName!)}</b> via SSH.`, true)
        } catch (err) {
          const msg = (err as Error).message ?? ''
          if (/connect|reset|closed|timeout/i.test(msg)) {
            await send(token, chatId, `✅ Reboot command sent to <b>${escapeHtml(ch.rebootDeviceName!)}</b> via SSH (connection dropped — expected).`, true)
          } else {
            await send(token, chatId, `❌ SSH reboot failed: ${msg}`)
          }
        }
        return
      }

      await send(token, chatId, `❌ No HTTP action or SSH key configured for <b>${escapeHtml(ch.rebootDeviceName!)}</b>.`, true)
      return
    }

    // ── Run task ──
    if (ch.action === 'runtask') {
      await send(token, chatId, `▶️ Triggering task <b>${escapeHtml(ch.taskName!)}</b>…`, true)
      try {
        const anyDb = db as any
        const run = await anyDb.insertInto('task_runs').values({
          task_id: ch.taskId,
          triggered_by: 'telegram',
          status: 'pending',
          created_at: new Date(),
        }).returningAll().executeTakeFirst()
        tgAudit(ch.who, 'telegram.runtask', ch.taskName, undefined, { task_id: ch.taskId, run_id: run.id })
        await send(token, chatId, `✅ Task <b>${escapeHtml(ch.taskName!)}</b> queued (run ID: <code>${run.id.slice(0, 8)}</code>).`, true)
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
      tgAudit(ch.who, `telegram.svc.${ch.action}`, ch.service, ch.serverId, { server: ch.serverName, result: status })
      await send(token, chatId, `✅ Done! <b>${ch.service}</b> on <b>${ch.serverName}</b> → <code>${status}</code>`, true)
    } catch (err) {
      tgAudit(ch.who, `telegram.svc.${ch.action}.failed`, ch.service, ch.serverId, { server: ch.serverName, error: (err as Error).message })
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

  tgAudit(who, `telegram.${cmd}`, args.join(' ') || undefined)

  switch (cmd) {
    case 'help':
    case 'start': {
      // Build dynamic help — only show enabled commands
      const c = (group: keyof TgCommands, name: string) => isCmdEnabled(settings, group, name)
      const t = (group: keyof TgCommands) => needsTotp(settings, group) ? ' ⚠️' : ''

      type Section = [string, string[]]
      const sections: Section[] = [
        ['── Servers ──', [
          c('servers','servers')  ? `/servers — list all devices grouped by category` : '',
          c('servers','devices')  ? `/devices [category] — detailed device list` : '',
          c('status','status')    ? `/status &lt;server&gt; — connection info` : '',
          c('software','software')? `/software &lt;server&gt; — installed software` : '',
        ]],
        ['── Linux Info ──', [
          c('linux_info','disk')    ? `/disk &lt;server&gt; — disk usage` : '',
          c('linux_info','memory')  ? `/memory &lt;server&gt; — RAM &amp; load average` : '',
          c('linux_info','top')     ? `/top &lt;server&gt; — top CPU processes` : '',
          c('linux_info','users')   ? `/users &lt;server&gt; — logged-in users` : '',
          c('linux_info','uptime')  ? `/uptime &lt;server&gt; — uptime &amp; last reboots` : '',
          c('linux_info','logs')    ? `/logs &lt;service&gt; &lt;server&gt; — last 20 log lines` : '',
          c('linux_info','netstat') ? `/netstat &lt;server&gt; — listening ports` : '',
        ]],
        ['── Linux Services ──', [
          c('linux_svc','restart') ? `/restart &lt;service&gt; &lt;server&gt;${t('linux_svc')}` : '',
          c('linux_svc','stop')    ? `/stop &lt;service&gt; &lt;server&gt;${t('linux_svc')}` : '',
          c('linux_svc','start')   ? `/start &lt;service&gt; &lt;server&gt;${t('linux_svc')}` : '',
          c('linux_svc','reboot')  ? `/reboot &lt;server&gt;${t('linux_svc')} — reboot server` : '',
        ]],
        ['── Network / SNMP ──', [
          c('network','ping')       ? `/ping &lt;server&gt; — ping status` : '',
          c('network','pingall')    ? `/pingall — all servers ping status` : '',
          c('network','down')       ? `/down — servers currently down` : '',
          c('network','snmp')       ? `/snmp &lt;device&gt; — SNMP summary` : '',
          c('network','interfaces')    ? `/interfaces &lt;device&gt; [up|down|trunk|access]` : '',
          c('network','rebootdevice') ? `/rebootdevice &lt;device&gt; ⚠️ — reboot network device` : '',
        ]],
        ['── Tasks ──', [
          c('tasks','tasks')   ? `/tasks — list active tasks` : '',
          c('tasks','runtask') ? `/runtask &lt;name&gt;${t('tasks')} — trigger a task` : '',
        ]],
        ['── Active Directory ──', [
          c('ad_read','aduser')     ? `/aduser &lt;username&gt; — user details` : '',
          c('ad_read','adgroups')   ? `/adgroups &lt;username&gt; — user groups` : '',
          c('ad_read','adgroup')    ? `/adgroup &lt;groupname&gt; — group members` : '',
          c('ad_read','adlocked')   ? `/adlocked — locked-out accounts` : '',
          c('ad_read','adexpired')  ? `/adexpired — expired passwords` : '',
          c('ad_read','addisabled') ? `/addisabled — disabled accounts` : '',
          c('ad_read','adhealth')   ? `/adhealth — domain health` : '',
          c('ad_read','adpolicy')   ? `/adpolicy — password policy` : '',
          c('ad_write','adunlock')  ? `/adunlock &lt;username&gt;${t('ad_write')} — unlock` : '',
          c('ad_write','adenable')  ? `/adenable &lt;username&gt;${t('ad_write')} — enable` : '',
          c('ad_write','addisable') ? `/addisable &lt;username&gt;${t('ad_write')} — disable` : '',
          c('ad_write','adreset')   ? `/adreset &lt;username&gt; &lt;password&gt;${t('ad_write')} — reset pwd` : '',
        ]],
        ['── Utilities ──', [
          `/totptest &lt;code&gt; — verify your TOTP code`,
        ]],
      ]

      const body = sections
        .map(([header, lines]) => {
          const visible = lines.filter(Boolean)
          return visible.length ? `<b>${header}</b>\n${visible.join('\n')}` : ''
        })
        .filter(Boolean)
        .join('\n\n')

      const hasTotp = (['linux_svc','ad_write','tasks'] as (keyof TgCommands)[]).some(g => needsTotp(settings, g))
      await send(token, chatId,
        `🔐 <b>SSH Manager Bot</b>\n\n${body}` +
        (hasTotp ? `\n\n⚠️ = requires TOTP confirmation` : ''), true)
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
      if (!isCmdEnabled(settings, 'servers', 'servers')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'servers')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'devices': {
      if (!isCmdEnabled(settings, 'servers', 'devices')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'servers')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'status': {
      if (!isCmdEnabled(settings, 'status', 'status')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /status &lt;server&gt;', true); break }
      if (needsTotp(settings, 'status')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'software': {
      if (!isCmdEnabled(settings, 'software', 'software')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /software &lt;server&gt;', true); break }
      if (needsTotp(settings, 'software')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'disk': {
      if (!isCmdEnabled(settings, 'linux_info', 'disk')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /disk &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'memory':
    case 'mem': {
      if (!isCmdEnabled(settings, 'linux_info', 'memory')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /memory &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'top': {
      if (!isCmdEnabled(settings, 'linux_info', 'top')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /top &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'users': {
      if (!isCmdEnabled(settings, 'linux_info', 'users')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /users &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'restart':
    case 'stop':
    case 'start': {
      if (!isCmdEnabled(settings, 'linux_svc', cmd)) { await send(token, chatId, '🚫 This command is disabled.'); break }
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
          tgAudit(who, `telegram.svc.${cmd}`, service, server.id, { server: server.name, result: status })
          await send(token, chatId, `✅ Done! <b>${service}</b> on <b>${server.name}</b> → <code>${status}</code>`, true)
        } catch (err) {
          tgAudit(who, `telegram.svc.${cmd}.failed`, service, server.id, { server: server.name, error: (err as Error).message })
          await send(token, chatId, `❌ Failed: ${(err as Error).message}`)
        }
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

    // ── New: Ping / network ───────────────────────────────────────────────────

    case 'ping': {
      if (!isCmdEnabled(settings, 'network', 'ping')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /ping &lt;server&gt;', true); break }
      if (needsTotp(settings, 'network')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'pingall': {
      if (!isCmdEnabled(settings, 'network', 'pingall')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'network')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'down': {
      if (!isCmdEnabled(settings, 'network', 'down')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'network')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'snmp': {
      if (!isCmdEnabled(settings, 'network', 'snmp')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /snmp &lt;device&gt;', true); break }
      if (needsTotp(settings, 'network')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'interfaces': {
      if (!isCmdEnabled(settings, 'network', 'interfaces')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /interfaces &lt;device&gt;', true); break }
      if (needsTotp(settings, 'network')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    // ── New: Linux extras ─────────────────────────────────────────────────────

    case 'uptime': {
      if (!isCmdEnabled(settings, 'linux_info', 'uptime')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /uptime &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'logs': {
      if (!isCmdEnabled(settings, 'linux_info', 'logs')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (args.length < 2) { await send(token, chatId, 'Usage: /logs &lt;service&gt; &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'netstat': {
      if (!isCmdEnabled(settings, 'linux_info', 'netstat')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /netstat &lt;server&gt;', true); break }
      if (needsTotp(settings, 'linux_info')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'reboot': {
      if (!isCmdEnabled(settings, 'linux_svc', 'reboot')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /reboot &lt;server&gt;', true); break }
      const rebootName = args.join(' ')
      const rebootServer = await db.selectFrom('servers').selectAll()
        .where('name', 'ilike', rebootName).where('is_active', '=', true).executeTakeFirst()
      if (!rebootServer) { await send(token, chatId, `❌ Server not found: ${rebootName}`); break }
      if (!rebootServer.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      if (!needsTotp(settings, 'linux_svc')) {
        await send(token, chatId, `🔄 Rebooting <b>${rebootServer.name}</b>…`, true)
        try {
          await sshBot(rebootServer.id, async (client) => {
            const { sshExec } = await import('../../utils/ssh')
            await sshExec(client, `sudo reboot 2>&1 || true`)
          })
          tgAudit(who, 'telegram.reboot', rebootServer.name, rebootServer.id)
          await send(token, chatId, `✅ Reboot command sent to <b>${rebootServer.name}</b>.`, true)
        } catch (err) {
          const msg = (err as Error).message ?? ''
          if (/connect|reset|closed|timeout/i.test(msg)) {
            tgAudit(who, 'telegram.reboot', rebootServer.name, rebootServer.id)
            await send(token, chatId, `✅ Reboot command sent to <b>${rebootServer.name}</b> (connection dropped — expected).`, true)
          } else { await send(token, chatId, `❌ Failed: ${msg}`) }
        }
        break
      }
      if (!settings.totpSecret) { await send(token, chatId, '❌ Bot TOTP not configured.'); break }
      challenges.set(chatId, { action: 'reboot', rebootServerId: rebootServer.id, rebootServerName: rebootServer.name, who, expiresAt: Date.now() + 60_000 })
      await send(token, chatId,
        `🔄 <b>Reboot requires TOTP confirmation</b>\n\nServer: <b>${rebootServer.name}</b>\nRequested by: ${who}\n\nReply with your <b>TOTP code</b> within 60 seconds.\nAny other reply cancels.`, true)
      break
    }

    case 'rebootdevice': {
      if (!isCmdEnabled(settings, 'network', 'rebootdevice')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /rebootdevice &lt;device name&gt;', true); break }
      const rdName = args.join(' ')
      const rdDevice = await (db as any).selectFrom('servers').selectAll()
        .where('name', 'ilike', rdName).where('is_active', '=', true).where('device_category', '=', 'network').executeTakeFirst()
      if (!rdDevice) { await send(token, chatId, `❌ Network device not found: ${escapeHtml(rdName)}`); break }
      if (!rdDevice.management_key_id && !rdDevice.web_url) { await send(token, chatId, '❌ Device has no SSH key or web URL configured.'); break }
      if (!settings.totpSecret) { await send(token, chatId, '❌ Bot TOTP not configured. Set it up in SSH Manager → Settings → Telegram.'); break }
      challenges.set(chatId, { action: 'rebootdevice', rebootDeviceId: rdDevice.id, rebootDeviceName: rdDevice.name, who, expiresAt: Date.now() + 60_000 })
      await send(token, chatId,
        `🔄 <b>Network device reboot requires TOTP confirmation</b>\n\nDevice: <b>${escapeHtml(rdDevice.name)}</b>\nRequested by: ${who}\n\nReply with your <b>TOTP code</b> within 60 seconds.\nAny other reply cancels.`, true)
      break
    }

    // ── New: Tasks ────────────────────────────────────────────────────────────

    case 'tasks': {
      if (!isCmdEnabled(settings, 'tasks', 'tasks')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'tasks')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'runtask': {
      if (!isCmdEnabled(settings, 'tasks', 'runtask')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /runtask &lt;task name&gt;', true); break }
      const taskName = args.join(' ')
      const task = await (db as any).selectFrom('task_definitions').selectAll()
        .where('title', 'ilike', taskName).where('is_active', '=', true).executeTakeFirst()
      if (!task) { await send(token, chatId, `❌ Task not found: ${escapeHtml(taskName)}`); break }
      if (!settings.totpSecret) { await send(token, chatId, '❌ Bot TOTP not configured. Set it up in SSH Manager → Settings → Telegram.'); break }
      challenges.set(chatId, { action: 'runtask', taskId: task.id, taskName: task.title, who, expiresAt: Date.now() + 60_000 })
      await send(token, chatId,
        `▶️ <b>Run task requires TOTP confirmation</b>\n\nTask: <b>${escapeHtml(task.title)}</b>\nPriority: <b>${task.priority}</b>\nRequested by: ${who}\n\nReply with your <b>TOTP code</b> within 60 seconds.\nAny other reply cancels.`, true)
      break
    }

    // ── AD read-only commands ──────────────────────────────────────────────────

    case 'aduser': {
      if (!isCmdEnabled(settings, 'ad_read', 'aduser')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /aduser &lt;username&gt;', true); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adgroups': {
      if (!isCmdEnabled(settings, 'ad_read', 'adgroups')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /adgroups &lt;username&gt;', true); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adgroup': {
      if (!isCmdEnabled(settings, 'ad_read', 'adgroup')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (!args.length) { await send(token, chatId, 'Usage: /adgroup &lt;groupname&gt;', true); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adlocked': {
      if (!isCmdEnabled(settings, 'ad_read', 'adlocked')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adexpired': {
      if (!isCmdEnabled(settings, 'ad_read', 'adexpired')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'addisabled': {
      if (!isCmdEnabled(settings, 'ad_read', 'addisabled')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adhealth': {
      if (!isCmdEnabled(settings, 'ad_read', 'adhealth')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    case 'adpolicy': {
      if (!isCmdEnabled(settings, 'ad_read', 'adpolicy')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (needsTotp(settings, 'ad_read')) { await promptTotp(token, chatId, settings, cmd, args, who, challenges); break }
      await executeCommand(token, chatId, settings, cmd, args)
      break
    }

    // ── AD write commands ──────────────────────────────────────────────────────

    case 'adunlock':
    case 'adenable':
    case 'addisable': {
      if (!isCmdEnabled(settings, 'ad_write', cmd)) { await send(token, chatId, '🚫 This command is disabled.'); break }
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
          tgAudit(who, `telegram.${cmd}`, adUser)
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
      if (!isCmdEnabled(settings, 'ad_write', 'adreset')) { await send(token, chatId, '🚫 This command is disabled.'); break }
      if (args.length < 2) { await send(token, chatId, 'Usage: /adreset &lt;username&gt; &lt;newpassword&gt;', true); break }
      const [adUser, ...rest] = args
      const adPassword = rest.join(' ')
      if (!needsTotp(settings, 'ad_write')) {
        await send(token, chatId, `🔑 Resetting password for <b>${escapeHtml(adUser)}</b>…`, true)
        try {
          await runAdScript(`Set-ADAccountPassword -Identity '${adUser}' -NewPassword (ConvertTo-SecureString '${adPassword}' -AsPlainText -Force) -Reset`)
          tgAudit(who, 'telegram.adreset', adUser)
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
