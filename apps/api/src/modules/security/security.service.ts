import { db } from '../../db/client'
import { withServerSsh } from '../../utils/server-ssh'
import { writeAuditLog } from '../../utils/audit'
import { sendAlert } from '../../utils/webhook'
import { runBenchmark, BenchmarkCheck } from '../../utils/benchmark'
import pino from 'pino'

const log = pino({ name: 'security-scanner' })

// Map benchmark status + category to a severity for the DB / alert system
function toSeverity(chk: BenchmarkCheck): 'ok' | 'low' | 'medium' | 'high' | 'critical' {
  if (chk.status === 'pass' || chk.status === 'skip') return 'ok'

  // fail / warn — base on category and specific check
  const criticalIds = new Set([
    'ssh-permit-root', 'ssh-password-auth', 'ssh-empty-passwords', 'ssh-protocol',
    'acct-uid0', 'pw-lockout',
    'svc-telnet', 'svc-rsh', 'svc-tftp',
  ])
  const highIds = new Set([
    'ssh-max-auth-tries', 'pw-complexity', 'pw-max-age',
    'acct-empty-passwords', 'perm-shadow', 'perm-gshadow', 'perm-sudoers',
    'perm-world-writable', 'kernel-aslr',
    'fw-active', 'fw-default-deny', 'fw-ssh-ratelimit',
  ])

  if (chk.status === 'fail') {
    if (criticalIds.has(chk.id)) return 'critical'
    if (highIds.has(chk.id)) return 'high'
    return 'medium'
  }
  // warn
  if (criticalIds.has(chk.id)) return 'high'
  return 'low'
}

export async function runSecurityScan(serverId: string): Promise<void> {
  const server = await db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst()
  if (!server || !server.management_key_id) {
    log.warn({ serverId }, 'Server not found or no management key')
    return
  }
  if (server.os_type === 'windows') {
    log.info({ serverId }, 'Skipping security scan for Windows server (use PingCastle)')
    return
  }

  let benchmarkResult
  try {
    benchmarkResult = await withServerSsh(serverId, async (client) => {
      return runBenchmark(client)
    })
  } catch (err: unknown) {
    log.error({ err, serverId }, 'Failed to connect for security scan')
    return
  }

  // Convert benchmark checks to the stored findings format
  const findings = benchmarkResult.checks.map((chk) => ({
    check_id: chk.id,
    category: chk.category,
    description: chk.title,
    severity: toSeverity(chk),
    passed: chk.status === 'pass' || chk.status === 'skip',
    status: chk.status,
    output: chk.actual,
    expected: chk.expected,
    remediation: chk.remediation,
    reference: chk.reference ?? '',
  }))

  // Overall severity = worst failing check
  const severityOrder = ['ok', 'low', 'medium', 'high', 'critical'] as const
  const overallSeverity = findings.reduce<typeof severityOrder[number]>((max, f) => {
    const s = f.severity
    return severityOrder.indexOf(s) > severityOrder.indexOf(max) ? s : max
  }, 'ok')

  await db.insertInto('security_scans').values({
    server_id: serverId,
    findings: JSON.stringify(findings),
    severity: overallSeverity,
    scan_type: 'benchmark',
  }).execute()

  // Alert on critical/high failures
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
        category: finding.category,
        severity: finding.severity,
        found: finding.output,
        expected: finding.expected,
      },
    })
  }
}
