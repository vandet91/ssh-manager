import { db } from '../../db/client'
import { decryptSecret, getVaultKey } from '../../utils/vault'
import { withSsh } from '../../utils/ssh'
import { writeAuditLog } from '../../utils/audit'
import { sendAlert } from '../../utils/webhook'
import pino from 'pino'

const log = pino({ name: 'security-scanner' })

interface Check {
  id: string
  description: string
  command: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  pass: (output: string, context?: { managedCount: number }) => boolean
}

const CHECKS: Check[] = [
  {
    id: 'password_auth',
    description: 'Password authentication should be disabled',
    command: "sshd -T 2>/dev/null | grep '^passwordauthentication'",
    severity: 'high',
    pass: (output) => output.includes('no'),
  },
  {
    id: 'root_login',
    description: 'Root login should be prohibited',
    command: "sshd -T 2>/dev/null | grep '^permitrootlogin'",
    severity: 'critical',
    pass: (output) => output.includes('no') || output.includes('prohibit-password'),
  },
  {
    id: 'ssh_protocol',
    description: 'Only SSH protocol 2 should be in use',
    command: "sshd -T 2>/dev/null | grep '^protocol'",
    severity: 'critical',
    pass: (output) => !output.includes('1'),
  },
  {
    id: 'authorized_keys_permissions',
    description: 'authorized_keys must not be world-readable (must be 600)',
    command: "stat -c '%a' ~/.ssh/authorized_keys 2>/dev/null || echo 'missing'",
    severity: 'high',
    pass: (output) => ['600', 'missing'].includes(output.trim()),
  },
  {
    id: 'stale_keys',
    description: 'authorized_keys should not contain unmanaged keys',
    command: "cat ~/.ssh/authorized_keys 2>/dev/null | wc -l",
    severity: 'medium',
    pass: (output, ctx) => parseInt(output.trim()) === (ctx?.managedCount ?? 0),
  },
  {
    id: 'x11_forwarding',
    description: 'X11 forwarding should be disabled',
    command: "sshd -T 2>/dev/null | grep '^x11forwarding'",
    severity: 'low',
    pass: (output) => output.includes('no'),
  },
]

export async function runSecurityScan(serverId: string): Promise<void> {
  const server = await db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst()
  if (!server || !server.management_key_id) {
    log.warn({ serverId }, 'Server not found or no management key')
    return
  }

  const mgmtKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', server.management_key_id).executeTakeFirst()
  if (!mgmtKey) return

  const vaultKey = getVaultKey()
  const mgmtPrivatePem = decryptSecret(mgmtKey.private_key_enc, vaultKey)

  // Count managed keys for stale check
  const assignments = await db.selectFrom('key_assignments')
    .select(['key_id', 'linux_user'])
    .where('server_id', '=', serverId)
    .where('is_active', '=', true)
    .execute()

  // Group by linux_user
  const userKeyCounts: Record<string, number> = {}
  for (const a of assignments) {
    userKeyCounts[a.linux_user] = (userKeyCounts[a.linux_user] ?? 0) + 1
  }

  const findings: Array<{
    check_id: string
    description: string
    severity: string
    passed: boolean
    output: string
    linux_user?: string
  }> = []

  try {
    await withSsh(
      server.hostname,
      server.ssh_port,
      server.management_linux_user,
      mgmtPrivatePem,
      async (client) => {
        const { sshExec } = await import('../../utils/ssh')

        for (const check of CHECKS) {
          try {
            const { stdout } = await sshExec(client, check.command)
            const ctx = check.id === 'stale_keys'
              ? { managedCount: userKeyCounts[server.management_linux_user] ?? 0 }
              : undefined
            const passed = check.pass(stdout, ctx)
            findings.push({
              check_id: check.id,
              description: check.description,
              severity: check.severity,
              passed,
              output: stdout,
            })
          } catch (err: unknown) {
            findings.push({
              check_id: check.id,
              description: check.description,
              severity: check.severity,
              passed: false,
              output: `Error: ${(err as Error).message}`,
            })
          }
        }
      },
      server.host_key_fingerprint ?? undefined,
    )
  } catch (err: unknown) {
    log.error({ err, serverId }, 'Failed to connect for security scan')
    return
  }

  // Determine overall severity
  const failedSeverities = findings.filter((f) => !f.passed).map((f) => f.severity)
  const severityOrder = ['ok', 'low', 'medium', 'high', 'critical']
  const overallSeverity = failedSeverities.reduce<string>((max, s) => {
    return severityOrder.indexOf(s) > severityOrder.indexOf(max) ? s : max
  }, 'ok')

  await db.insertInto('security_scans').values({
    server_id: serverId,
    findings: JSON.stringify(findings),
    severity: overallSeverity as 'ok' | 'low' | 'medium' | 'high' | 'critical',
    scan_type: 'standard',
  }).execute()

  // Alert on critical/high
  const serious = findings.filter((f) => !f.passed && ['critical', 'high'].includes(f.severity))
  for (const finding of serious) {
    await writeAuditLog({
      action: 'security.finding',
      serverId,
      details: { finding },
    })
    await sendAlert({
      event: finding.severity === 'critical' ? 'security_critical' : 'security_high',
      title: `Security Finding: ${finding.check_id} on ${server.name}`,
      message: finding.description,
      severity: finding.severity === 'critical' ? 'critical' : 'warning',
      details: {
        server: server.name,
        check: finding.check_id,
        severity: finding.severity,
      },
    })
  }
}
