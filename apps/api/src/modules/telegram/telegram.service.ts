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

interface TgSettings { enabled: boolean; token: string; allowedChats: number[]; totpSecret: string }

async function getSettings(): Promise<TgSettings> {
  const rows = (await db.selectFrom('settings' as any).selectAll()
    .where('key' as any, 'in', ['telegram_enabled','telegram_bot_token','telegram_allowed_chats','telegram_totp_secret'])
    .execute()) as Array<{ key: string; value: unknown }>
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return {
    enabled: !!(m['telegram_enabled'] ?? false),
    token: (m['telegram_bot_token'] as string) ?? '',
    allowedChats: (m['telegram_allowed_chats'] as number[]) ?? [],
    totpSecret: (m['telegram_totp_secret'] as string) ?? '',
  }
}

// ── TOTP challenges ────────────────────────────────────────────────────────────

interface Challenge {
  action: 'start' | 'stop' | 'restart'
  service: string
  serverName: string
  serverId: string
  who: string
  expiresAt: number
}
const challenges = new Map<number, Challenge>()

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

    const valid = settings.totpSecret && speakeasy.totp.verify({
      secret: settings.totpSecret, encoding: 'base32', token: text, window: 1,
    })

    if (!valid) {
      challenges.delete(chatId)
      await send(token, chatId, '❌ Invalid TOTP code. Action cancelled.')
      return
    }

    challenges.delete(chatId)
    await send(token, chatId, `⚙️ Executing <b>${ch.action} ${ch.service}</b> on <b>${ch.serverName}</b>…`, true)

    try {
      const status = await withServerSsh(ch.serverId, async (client) => {
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
        `/servers — list servers\n` +
        `/status &lt;server&gt; — connection info\n` +
        `/software &lt;server&gt; — installed software\n` +
        `/restart &lt;service&gt; &lt;server&gt; — restart service ⚠️\n` +
        `/stop &lt;service&gt; &lt;server&gt; — stop service ⚠️\n` +
        `/start &lt;service&gt; &lt;server&gt; — start service ⚠️\n\n` +
        `⚠️ = requires TOTP code from your authenticator app`, true)
      break
    }

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
      if (!args.length) { await send(token, chatId, 'Usage: /status &lt;server&gt;', true); break }
      const name = args.join(' ')
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',name).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${name}`); break }
      const conn = server.last_connected_at
        ? new Date(server.last_connected_at).toLocaleString()
        : 'Never'
      await send(token, chatId,
        `📡 <b>${server.name}</b>\n` +
        `Host: <code>${server.hostname}:${server.ssh_port}</code>\n` +
        `Env: ${server.environment}\n` +
        `Last connected: ${conn}`, true)
      break
    }

    case 'software': {
      if (!args.length) { await send(token, chatId, 'Usage: /software &lt;server&gt;', true); break }
      const name = args.join(' ')
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',name).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${name}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      await send(token, chatId, `🔍 Scanning ${server.name}…`)
      try {
        const raw = await withServerSsh(server.id, async (client) => {
          const { sshExec } = await import('../../utils/ssh')
          const encoded = Buffer.from(DETECT_SCRIPT).toString('base64')
          const out = await sshExec(client, `echo '${encoded}' | base64 -d | sh 2>/dev/null`)
          return out.stdout
        }) as string
        await send(token, chatId, `📦 <b>Software: ${server.name}</b>\n\n${formatSoftwareForTelegram(raw)}`, true)
      } catch (err) {
        await send(token, chatId, `❌ Scan failed: ${(err as Error).message}`)
      }
      break
    }

    case 'restart':
    case 'stop':
    case 'start': {
      if (args.length < 2) { await send(token, chatId, `Usage: /${cmd} &lt;service&gt; &lt;server&gt;`, true); break }
      const service = args[0]
      const serverName = args.slice(1).join(' ')
      const server = await db.selectFrom('servers').selectAll()
        .where('name','ilike',serverName).where('is_active','=',true).executeTakeFirst()
      if (!server) { await send(token, chatId, `❌ Server not found: ${serverName}`); break }
      if (!server.management_key_id) { await send(token, chatId, '❌ Server not configured'); break }
      if (!settings.totpSecret) {
        await send(token, chatId, '❌ Bot TOTP not configured. Set it up in SSH Manager → Settings → Telegram.')
        break
      }
      challenges.set(chatId, {
        action: cmd as 'start'|'stop'|'restart', service,
        serverName: server.name, serverId: server.id, who,
        expiresAt: Date.now() + 60_000,
      })
      const icon = cmd === 'stop' ? '🛑' : cmd === 'restart' ? '🔄' : '▶️'
      await send(token, chatId,
        `${icon} <b>Action requires confirmation</b>\n\n` +
        `Action: <code>${cmd} ${service}</code>\n` +
        `Server: <b>${server.name}</b>\n` +
        `Requested by: ${who}\n\n` +
        `Reply with your <b>TOTP authenticator code</b> within 60 seconds.\n` +
        `Any other reply will cancel.`, true)
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
