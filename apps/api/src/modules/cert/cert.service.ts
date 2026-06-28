import * as tls from 'tls'
import { db } from '../../db/client'
import { withServerSsh } from '../../utils/server-ssh'

export interface CertInfo {
  host: string
  port: number
  subject: string
  issuer: string
  sans: string[]
  expiresAt: Date
  isSelfSigned: boolean
  error?: string
}

export interface CertFileValidation {
  valid: boolean
  subject: string
  issuer: string
  sans: string[]
  notBefore: string
  notAfter: string
  daysRemaining: number
  isSelfSigned: boolean
  keyMatches: boolean | null   // null when no key path provided
  chainValid: boolean | null   // null when no chain path provided
  fingerprint: string
  errors: string[]
  warnings: string[]
}

export interface CertApplyConfig {
  cert_path: string          // source cert file on server
  key_path?: string          // source key file
  chain_path?: string        // source chain/intermediate file
  target_cert: string        // destination cert path
  target_key?: string        // destination key path
  target_chain?: string      // destination chain path (or concat into cert)
  concat_chain: boolean      // concat chain into cert file (nginx fullchain style)
  service_name: string       // nginx / apache2 / httpd / custom
  service_action: 'restart' | 'reload' | 'none'
  backup: boolean            // backup existing files before replacing
}

// ── TLS live check ────────────────────────────────────────────────────────────

export function checkCertViaTls(host: string, port: number): Promise<CertInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: 10000 },
      () => {
        try {
          const cert = socket.getPeerCertificate(true)
          socket.destroy()

          if (!cert || !cert.subject) return reject(new Error('No certificate returned'))

          const subject = cert.subject.CN ?? Object.values(cert.subject).join(', ')
          const issuer  = cert.issuer?.CN ?? Object.values(cert.issuer ?? {}).join(', ')
          const sans: string[] = cert.subjectaltname
            ? cert.subjectaltname.split(', ').map((s: string) => s.replace(/^DNS:|^IP Address:/i, ''))
            : [subject]
          const expiresAt    = new Date(cert.valid_to)
          const isSelfSigned = JSON.stringify(cert.subject) === JSON.stringify(cert.issuer)

          resolve({ host, port, subject, issuer, sans, expiresAt, isSelfSigned })
        } catch (err) {
          socket.destroy()
          reject(err)
        }
      }
    )
    socket.on('error', reject)
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('TLS connect timeout')) })
  })
}

// ── SSH helpers ───────────────────────────────────────────────────────────────

async function sshExec(serverId: string, cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = '', stderr = '', code = 0
  await withServerSsh(serverId, async (conn) => {
    await new Promise<void>((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err)
        stream.on('data', (d: Buffer) => { stdout += d.toString() })
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        stream.on('close', (c: number) => { code = c; resolve() })
      })
    })
  })
  return { stdout, stderr, code }
}

// ── Validate cert files on server ─────────────────────────────────────────────

export async function validateCertFiles(
  serverId: string,
  certPath: string,
  keyPath?: string,
  chainPath?: string,
): Promise<CertFileValidation> {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Parse cert
  const certInfo = await sshExec(
    serverId,
    `openssl x509 -in ${certPath} -noout -subject -issuer -dates -fingerprint -sha256 -ext subjectAltName 2>&1`,
  )
  if (certInfo.code !== 0 || certInfo.stdout.includes('unable to load')) {
    errors.push(`Cannot read cert file: ${certInfo.stderr || certInfo.stdout}`)
    return { valid: false, subject: '', issuer: '', sans: [], notBefore: '', notAfter: '', daysRemaining: 0, isSelfSigned: false, keyMatches: null, chainValid: null, fingerprint: '', errors, warnings }
  }

  const get = (key: string) => {
    const m = certInfo.stdout.match(new RegExp(`${key}=([^\n/,]+)`))
    return m ? m[1].trim() : ''
  }

  const subject    = get('CN') || get('subject') || 'Unknown'
  const issuer     = get('issuer') || get('O') || 'Unknown'
  const notBefore  = certInfo.stdout.match(/notBefore=(.+)/)?.[1]?.trim() ?? ''
  const notAfter   = certInfo.stdout.match(/notAfter=(.+)/)?.[1]?.trim() ?? ''
  const fingerprint = certInfo.stdout.match(/Fingerprint=([^\n]+)/i)?.[1]?.trim() ?? ''
  const sanLine    = certInfo.stdout.match(/DNS:[^\n]+/g) ?? []
  const sans       = sanLine.flatMap(l => l.split(',').map(s => s.replace(/^DNS:|^IP Address:/i, '').trim())).filter(Boolean)

  const expiresAt    = notAfter ? new Date(notAfter) : new Date(0)
  const daysRemaining = Math.floor((expiresAt.getTime() - Date.now()) / 86400000)
  const isSelfSigned  = subject === issuer

  if (daysRemaining < 0)  errors.push(`Certificate is expired (${Math.abs(daysRemaining)} days ago)`)
  if (daysRemaining < 7 && daysRemaining >= 0) warnings.push(`Certificate expires very soon (${daysRemaining} days)`)
  if (isSelfSigned) warnings.push('Certificate is self-signed')

  // 2. Check key matches cert
  let keyMatches: boolean | null = null
  if (keyPath) {
    const certMod = await sshExec(serverId, `openssl x509 -noout -modulus -in ${certPath} 2>/dev/null | openssl md5`)
    const keyMod  = await sshExec(serverId, `openssl rsa -noout -modulus -in ${keyPath} 2>/dev/null | openssl md5`)
    if (certMod.code !== 0) {
      errors.push(`Cannot read key file at ${keyPath}`)
    } else {
      keyMatches = certMod.stdout.trim() === keyMod.stdout.trim()
      if (!keyMatches) errors.push('Private key does NOT match the certificate')
    }
  }

  // 3. Verify chain
  let chainValid: boolean | null = null
  if (chainPath) {
    const verify = await sshExec(serverId, `openssl verify -CAfile ${chainPath} ${certPath} 2>&1`)
    chainValid = verify.stdout.includes(': OK')
    if (!chainValid) warnings.push(`Chain verification: ${verify.stdout.trim() || verify.stderr.trim()}`)
  }

  const valid = errors.length === 0
  return { valid, subject, issuer, sans, notBefore, notAfter, daysRemaining, isSelfSigned, keyMatches, chainValid, fingerprint, errors, warnings }
}

// ── Apply cert files on server ─────────────────────────────────────────────────

export async function applyCertFiles(serverId: string, cfg: CertApplyConfig): Promise<{ output: string }> {
  const steps: string[] = []

  // Backup existing files
  if (cfg.backup) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    steps.push(`cp -f ${cfg.target_cert} ${cfg.target_cert}.bak.${ts} 2>/dev/null || true`)
    if (cfg.target_key)   steps.push(`cp -f ${cfg.target_key} ${cfg.target_key}.bak.${ts} 2>/dev/null || true`)
    if (cfg.target_chain) steps.push(`cp -f ${cfg.target_chain} ${cfg.target_chain}.bak.${ts} 2>/dev/null || true`)
  }

  // Copy cert (optionally concat chain)
  if (cfg.concat_chain && cfg.chain_path) {
    steps.push(`cat ${cfg.cert_path} ${cfg.chain_path} > ${cfg.target_cert}`)
  } else {
    steps.push(`cp -f ${cfg.cert_path} ${cfg.target_cert}`)
    if (cfg.chain_path && cfg.target_chain) {
      steps.push(`cp -f ${cfg.chain_path} ${cfg.target_chain}`)
    }
  }

  // Copy key
  if (cfg.key_path && cfg.target_key) {
    steps.push(`cp -f ${cfg.key_path} ${cfg.target_key}`)
    steps.push(`chmod 600 ${cfg.target_key}`)
  }

  // Config test before restarting (where supported)
  if (cfg.service_action !== 'none') {
    switch (cfg.service_name) {
      // Web servers
      case 'nginx':    steps.push('nginx -t'); break
      case 'apache2':  steps.push('apache2ctl -t'); break
      case 'httpd':    steps.push('httpd -t'); break
      case 'caddy':    steps.push('caddy validate --config /etc/caddy/Caddyfile 2>&1 || caddy validate --adapter caddyfile 2>&1'); break
      case 'haproxy':  steps.push('haproxy -c -f /etc/haproxy/haproxy.cfg'); break
      case 'lighttpd': steps.push('lighttpd -t -f /etc/lighttpd/lighttpd.conf'); break
      // Database servers — at minimum verify the cert file is a valid X.509 cert before restarting
      case 'postgresql':
      case 'postgres':
      case 'mysql':
      case 'mariadb':
      case 'mongod':
      case 'mongodb':
      case 'redis':
      case 'redis-server':
        if (cfg.target_cert) steps.push(`openssl x509 -in ${cfg.target_cert} -noout`)
        break
      // traefik, postfix, dovecot, stunnel, varnish — no built-in config test; skip and restart
    }
  }

  // Restart / reload service
  if (cfg.service_action !== 'none') {
    steps.push(`systemctl ${cfg.service_action} ${cfg.service_name}`)
  }

  const script = steps.join(' && ')
  const result = await sshExec(serverId, script)

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Script exited ${result.code}`)
  }

  return { output: (result.stdout + result.stderr).trim() }
}

// ── Schedule pending apply ─────────────────────────────────────────────────────

export async function scheduleCertApply(serverId: string, runAt: Date, cfg: CertApplyConfig): Promise<void> {
  await (db as any)
    .updateTable('servers')
    .set({ cert_pending_apply_at: runAt, cert_pending_apply_config: JSON.stringify(cfg) })
    .where('id', '=', serverId)
    .execute()
}

export async function cancelCertApply(serverId: string): Promise<void> {
  await (db as any)
    .updateTable('servers')
    .set({ cert_pending_apply_at: null, cert_pending_apply_config: null })
    .where('id', '=', serverId)
    .execute()
}

export async function executePendingApplies(): Promise<void> {
  const due = await (db as any)
    .selectFrom('servers')
    .select(['id', 'name', 'cert_pending_apply_at', 'cert_pending_apply_config'])
    .where('cert_pending_apply_at', 'is not', null)
    .where('cert_pending_apply_at', '<=', new Date())
    .execute()

  for (const server of due) {
    try {
      const cfg: CertApplyConfig = typeof server.cert_pending_apply_config === 'string'
        ? JSON.parse(server.cert_pending_apply_config)
        : server.cert_pending_apply_config

      await applyCertFiles(server.id, cfg)
      await checkAndSaveCert(server.id)
      console.log(`[cert] Scheduled apply completed for server ${server.name}`)
    } catch (err) {
      console.error(`[cert] Scheduled apply failed for server ${server.name}:`, err)
    } finally {
      // Always clear the pending job whether success or fail
      await cancelCertApply(server.id)
    }
  }
}

// Protocol → default port mapping
const PROTOCOL_DEFAULT_PORT: Record<string, number> = {
  https:    443,
  postgres: 5432,
  mysql:    3306,
  mongodb:  27017,
  redis:    6380,  // Redis TLS typically on 6380
  smtp:     587,
  imap:     993,
  ldap:     636,
}

// Protocols that use STARTTLS (connection upgrades from plain to TLS)
const STARTTLS_PROTOCOLS = new Set(['postgres', 'mysql', 'smtp', 'imap', 'ldap', 'ftp'])

function buildSClientCmd(host: string, port: number, protocol: string): string {
  const sni = STARTTLS_PROTOCOLS.has(protocol) ? '' : ` -servername ${host}`
  const starttls = STARTTLS_PROTOCOLS.has(protocol) ? ` -starttls ${protocol}` : ''
  return `echo | openssl s_client -connect ${host}:${port}${sni}${starttls} 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null`
}

// ── SSH-based live check ──────────────────────────────────────────────────────

export async function checkCertViaSSH(serverId: string): Promise<CertInfo> {
  const server = await (db as any)
    .selectFrom('servers')
    .select(['id', 'hostname', 'cert_host', 'cert_port', 'cert_protocol'])
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow()

  const protocol = server.cert_protocol ?? 'https'
  const host     = server.cert_host ?? server.hostname
  const port     = server.cert_port ?? (PROTOCOL_DEFAULT_PORT[protocol] ?? 443)

  const { stdout } = await sshExec(serverId, buildSClientCmd(host, port, protocol))
  return parseSslOutput(stdout, host, port)
}

function parseSslOutput(output: string, host: string, port: number): CertInfo {
  const get = (key: string) => {
    const m = output.match(new RegExp(`${key}=([^\n,/]+)`))
    return m ? m[1].trim() : ''
  }
  const subject    = get('CN') || get('subject')
  const issuer     = get('issuer')
  const notAfter   = output.match(/notAfter=(.+)/)?.[1]?.trim()
  const expiresAt  = notAfter ? new Date(notAfter) : new Date(0)
  const sanLine    = output.match(/DNS:[^\n]+/g) ?? []
  const sans       = sanLine.flatMap(l => l.split(',').map(s => s.replace(/^DNS:|^IP Address:/i, '').trim()))
  const isSelfSigned = subject === issuer

  return { host, port, subject, issuer, sans, expiresAt, isSelfSigned }
}

// ── Check & save live cert ────────────────────────────────────────────────────

export async function checkAndSaveCert(serverId: string): Promise<CertInfo> {
  const server = await (db as any)
    .selectFrom('servers')
    .select(['id', 'hostname', 'cert_host', 'cert_port', 'cert_protocol', 'os_type', 'device_category'])
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow()

  const protocol = server.cert_protocol ?? 'https'
  const host     = server.cert_host ?? server.hostname
  const port     = server.cert_port ?? (PROTOCOL_DEFAULT_PORT[protocol] ?? 443)

  let info: CertInfo
  let certError: string | null = null

  // STARTTLS protocols can't use the Node TLS handshake directly — go straight to SSH
  const needsStartTls = STARTTLS_PROTOCOLS.has(protocol)
  const isLinux = server.os_type === 'linux' || server.device_category === 'server'

  if (needsStartTls) {
    if (!isLinux) {
      certError = `Protocol "${protocol}" requires STARTTLS which needs SSH access — only supported for Linux servers`
      info = { host, port, subject: '', issuer: '', sans: [], expiresAt: new Date(0), isSelfSigned: false }
    } else {
      try {
        info = await checkCertViaSSH(serverId)
      } catch (sshErr) {
        certError = (sshErr as Error).message
        info = { host, port, subject: '', issuer: '', sans: [], expiresAt: new Date(0), isSelfSigned: false }
      }
    }
  } else {
    try {
      info = await checkCertViaTls(host, port)
    } catch (tlsErr) {
      if (isLinux) {
        try {
          info = await checkCertViaSSH(serverId)
        } catch (sshErr) {
          certError = `TLS: ${(tlsErr as Error).message} / SSH: ${(sshErr as Error).message}`
          info = { host, port, subject: '', issuer: '', sans: [], expiresAt: new Date(0), isSelfSigned: false }
        }
      } else {
        certError = (tlsErr as Error).message
        info = { host, port, subject: '', issuer: '', sans: [], expiresAt: new Date(0), isSelfSigned: false }
      }
    }
  }

  await (db as any)
    .updateTable('servers')
    .set({
      cert_host: info.host,
      cert_port: info.port,
      cert_expires_at: certError ? null : info.expiresAt,
      cert_issuer: info.issuer || null,
      cert_subject: info.subject || null,
      cert_sans: info.sans.length ? info.sans : null,
      cert_is_self_signed: info.isSelfSigned,
      cert_last_checked_at: new Date(),
      cert_error: certError,
    })
    .where('id', '=', serverId)
    .execute()

  if (certError) throw new Error(certError)
  return info
}

// ── Let's Encrypt / certbot renew ─────────────────────────────────────────────

export async function renewCert(serverId: string): Promise<string> {
  const server = await (db as any)
    .selectFrom('servers')
    .select(['id', 'cert_renewal_cmd'])
    .where('id', '=', serverId)
    .executeTakeFirstOrThrow()

  const cmd = server.cert_renewal_cmd
  if (!cmd) throw new Error('No renewal command configured for this server')

  const { stdout, stderr, code } = await sshExec(serverId, cmd)
  if (code !== 0) throw new Error(`Renewal command exited ${code}:\n${stderr || stdout}`)

  await checkAndSaveCert(serverId)
  return (stdout + stderr).trim()
}

// ── Daily worker: check all + run pending applies ─────────────────────────────

export async function checkAllCerts(): Promise<void> {
  // Run pending scheduled applies first
  await executePendingApplies().catch(console.error)

  const servers = await (db as any)
    .selectFrom('servers')
    .select(['id', 'hostname', 'cert_host', 'cert_port', 'cert_auto_renew', 'cert_expires_at', 'cert_renewal_cmd'])
    .where('cert_host', 'is not', null)
    .execute()

  for (const server of servers) {
    try {
      const info = await checkAndSaveCert(server.id)

      if (server.cert_auto_renew && server.cert_renewal_cmd) {
        const daysLeft = Math.floor((info.expiresAt.getTime() - Date.now()) / 86400000)
        if (daysLeft < 30) {
          await renewCert(server.id).catch(console.error)
        }
      }
    } catch {
      // errors saved to cert_error column
    }
  }
}
