/**
 * OS Security Benchmark — runs checks via SSH against CIS Benchmark / STIG-inspired controls.
 * Returns a flat list of check results that the frontend can render as pass/warn/fail.
 */
import { Client } from 'ssh2'
import { sshExec } from './ssh'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type CheckCategory =
  | 'ssh'
  | 'password_policy'
  | 'accounts'
  | 'file_permissions'
  | 'kernel'
  | 'audit'
  | 'firewall'
  | 'updates'

export interface BenchmarkCheck {
  id: string
  category: CheckCategory
  title: string
  description: string
  status: CheckStatus
  actual: string      // what we actually found
  expected: string    // what we recommend
  remediation: string // how to fix it
  reference?: string  // CIS control or similar
}

export interface BenchmarkResult {
  ran_at: string
  checks: BenchmarkCheck[]
  summary: {
    total: number
    pass: number
    warn: number
    fail: number
    skip: number
    score: number  // 0-100
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function exec(client: Client, cmd: string): Promise<string> {
  try {
    const r = await sshExec(client, cmd)
    return r.stdout.trim()
  } catch {
    return ''
  }
}

function check(
  id: string,
  category: CheckCategory,
  title: string,
  description: string,
  status: CheckStatus,
  actual: string,
  expected: string,
  remediation: string,
  reference?: string,
): BenchmarkCheck {
  return { id, category, title, description, status, actual, expected, remediation, reference }
}

// ── SSH hardening ─────────────────────────────────────────────────────────────

async function checkSsh(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []
  const sshdConfig = await exec(client, 'sshd -T 2>/dev/null || cat /etc/ssh/sshd_config 2>/dev/null || echo ""')

  function getSshdValue(key: string): string {
    const regex = new RegExp(`^${key}\\s+(.+)`, 'im')
    const m = sshdConfig.match(regex)
    return m ? m[1].trim().toLowerCase() : ''
  }

  // PermitRootLogin
  const permitRoot = getSshdValue('permitrootlogin') || 'unknown'
  const rootOk = ['no', 'prohibit-password', 'without-password'].includes(permitRoot)
  results.push(check(
    'ssh-permit-root', 'ssh',
    'Disable root SSH login',
    'Root should not be able to log in directly via SSH.',
    rootOk ? 'pass' : permitRoot === 'unknown' ? 'skip' : 'fail',
    `PermitRootLogin ${permitRoot}`,
    'PermitRootLogin no',
    'Set "PermitRootLogin no" in /etc/ssh/sshd_config and reload: systemctl reload sshd',
    'CIS 5.2.8',
  ))

  // PasswordAuthentication
  const pwAuth = getSshdValue('passwordauthentication') || 'unknown'
  const pwOk = pwAuth === 'no'
  results.push(check(
    'ssh-password-auth', 'ssh',
    'Disable SSH password authentication',
    'All SSH logins should use public key authentication only.',
    pwOk ? 'pass' : pwAuth === 'unknown' ? 'warn' : 'fail',
    `PasswordAuthentication ${pwAuth}`,
    'PasswordAuthentication no',
    'Set "PasswordAuthentication no" in /etc/ssh/sshd_config. Ensure keys are deployed first.',
    'CIS 5.2.11',
  ))

  // Protocol (only relevant for older systems; sshd -T may not show it on modern)
  const protocol = getSshdValue('protocol') || '2'
  const protoOk = protocol === '2' || protocol === ''
  results.push(check(
    'ssh-protocol', 'ssh',
    'Use SSH Protocol 2 only',
    'SSH Protocol 1 is cryptographically broken and must not be used.',
    protoOk ? 'pass' : 'fail',
    protocol ? `Protocol ${protocol}` : 'Protocol 2 (default)',
    'Protocol 2',
    'Set "Protocol 2" in /etc/ssh/sshd_config (or remove the line on modern systems where 2 is default).',
    'CIS 5.2.1',
  ))

  // X11Forwarding
  const x11 = getSshdValue('x11forwarding') || 'unknown'
  const x11Ok = x11 === 'no' || x11 === 'unknown'
  results.push(check(
    'ssh-x11', 'ssh',
    'Disable X11 forwarding',
    'X11 forwarding allows GUI applications to be tunnelled over SSH, increasing attack surface.',
    x11Ok ? (x11 === 'unknown' ? 'warn' : 'pass') : 'fail',
    `X11Forwarding ${x11}`,
    'X11Forwarding no',
    'Set "X11Forwarding no" in /etc/ssh/sshd_config and reload: systemctl reload sshd',
    'CIS 5.2.6',
  ))

  // MaxAuthTries
  const maxAuth = parseInt(getSshdValue('maxauthtries') || '6', 10)
  const maxAuthOk = !isNaN(maxAuth) && maxAuth <= 4
  results.push(check(
    'ssh-max-auth-tries', 'ssh',
    'Limit SSH authentication attempts',
    'MaxAuthTries should be ≤ 4 to limit brute-force attempts.',
    maxAuthOk ? 'pass' : 'warn',
    `MaxAuthTries ${isNaN(maxAuth) ? 'not set (default 6)' : maxAuth}`,
    'MaxAuthTries 4',
    'Set "MaxAuthTries 4" in /etc/ssh/sshd_config and reload: systemctl reload sshd',
    'CIS 5.2.7',
  ))

  // ClientAliveInterval
  const aliveInterval = parseInt(getSshdValue('clientaliveinterval') || '0', 10)
  const aliveOk = aliveInterval > 0 && aliveInterval <= 300
  results.push(check(
    'ssh-idle-timeout', 'ssh',
    'Set SSH idle timeout',
    'Idle SSH sessions should be terminated after a period of inactivity.',
    aliveOk ? 'pass' : 'warn',
    aliveInterval > 0 ? `ClientAliveInterval ${aliveInterval}` : 'ClientAliveInterval not set',
    'ClientAliveInterval 300, ClientAliveCountMax 3',
    'Add to /etc/ssh/sshd_config:\n  ClientAliveInterval 300\n  ClientAliveCountMax 3',
    'CIS 5.2.16',
  ))

  // PermitEmptyPasswords
  const emptyPw = getSshdValue('permitemptypasswords') || 'no'
  const emptyOk = emptyPw === 'no' || emptyPw === ''
  results.push(check(
    'ssh-empty-passwords', 'ssh',
    'Disallow empty passwords over SSH',
    'SSH must not allow authentication with empty passwords.',
    emptyOk ? 'pass' : 'fail',
    `PermitEmptyPasswords ${emptyPw || 'no (default)'}`,
    'PermitEmptyPasswords no',
    'Set "PermitEmptyPasswords no" in /etc/ssh/sshd_config and reload: systemctl reload sshd',
    'CIS 5.2.9',
  ))

  return results
}

// ── Password policy ───────────────────────────────────────────────────────────

async function checkPasswordPolicy(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []
  const loginDefs = await exec(client, 'cat /etc/login.defs 2>/dev/null || echo ""')

  function getLoginDef(key: string): string {
    const regex = new RegExp(`^${key}\\s+(\\S+)`, 'im')
    const m = loginDefs.match(regex)
    return m ? m[1].trim() : ''
  }

  // PASS_MAX_DAYS
  const maxDays = parseInt(getLoginDef('PASS_MAX_DAYS') || '99999', 10)
  const maxDaysOk = maxDays <= 90
  results.push(check(
    'pw-max-age', 'password_policy',
    'Set maximum password age',
    'Passwords should expire after at most 90 days to limit exposure from compromised credentials.',
    maxDaysOk ? 'pass' : maxDays <= 180 ? 'warn' : 'fail',
    `PASS_MAX_DAYS ${maxDays}`,
    'PASS_MAX_DAYS 90',
    'Set "PASS_MAX_DAYS 90" in /etc/login.defs. Apply to existing users: chage --maxdays 90 <username>',
    'CIS 5.4.1.1',
  ))

  // PASS_MIN_DAYS
  const minDays = parseInt(getLoginDef('PASS_MIN_DAYS') || '0', 10)
  const minDaysOk = minDays >= 1
  results.push(check(
    'pw-min-age', 'password_policy',
    'Set minimum password age',
    'A minimum password age prevents users from immediately cycling back to an old password.',
    minDaysOk ? 'pass' : 'warn',
    `PASS_MIN_DAYS ${minDays}`,
    'PASS_MIN_DAYS 1',
    'Set "PASS_MIN_DAYS 1" in /etc/login.defs. Apply to existing users: chage --mindays 1 <username>',
    'CIS 5.4.1.2',
  ))

  // PASS_WARN_AGE
  const warnAge = parseInt(getLoginDef('PASS_WARN_AGE') || '0', 10)
  const warnAgeOk = warnAge >= 7
  results.push(check(
    'pw-warn-age', 'password_policy',
    'Set password expiry warning',
    'Users should be warned before their password expires.',
    warnAgeOk ? 'pass' : 'warn',
    `PASS_WARN_AGE ${warnAge}`,
    'PASS_WARN_AGE 7',
    'Set "PASS_WARN_AGE 7" in /etc/login.defs.',
    'CIS 5.4.1.3',
  ))

  // pam_pwquality / pam_cracklib
  const pamConfig = await exec(client, 'grep -r "pam_pwquality\\|pam_cracklib" /etc/pam.d/ 2>/dev/null | head -5')
  const hasPwQuality = pamConfig.includes('pam_pwquality') || pamConfig.includes('pam_cracklib')
  results.push(check(
    'pw-complexity', 'password_policy',
    'Enforce password complexity (PAM)',
    'pam_pwquality or pam_cracklib should be configured to enforce password strength.',
    hasPwQuality ? 'pass' : 'fail',
    hasPwQuality ? pamConfig.split('\n')[0] : 'Not configured',
    'pam_pwquality.so minlen=12 minclass=3 retry=3',
    'Install: apt install libpam-pwquality (Debian) or yum install pam_pwquality (RHEL)\nAdd to /etc/pam.d/common-password:\n  password requisite pam_pwquality.so minlen=12 minclass=3 retry=3',
    'CIS 5.3.1',
  ))

  // pam_tally2 / pam_faillock (account lockout)
  const pamLockout = await exec(client, 'grep -r "pam_tally2\\|pam_faillock" /etc/pam.d/ 2>/dev/null | head -5')
  const hasLockout = pamLockout.includes('pam_tally2') || pamLockout.includes('pam_faillock')
  results.push(check(
    'pw-lockout', 'password_policy',
    'Configure account lockout on failed logins',
    'Accounts should be locked after repeated failed login attempts to prevent brute-force.',
    hasLockout ? 'pass' : 'fail',
    hasLockout ? pamLockout.split('\n')[0] : 'Not configured',
    'pam_faillock.so deny=5 unlock_time=900',
    'Add to /etc/pam.d/common-auth (Debian) or /etc/pam.d/system-auth (RHEL):\n  auth required pam_faillock.so preauth silent deny=5 unlock_time=900\n  auth [default=die] pam_faillock.so authfail deny=5 unlock_time=900',
    'CIS 5.3.2',
  ))

  return results
}

// ── Account security ──────────────────────────────────────────────────────────

async function checkAccounts(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []

  // Root account status
  const rootStatus = await exec(client, 'passwd -S root 2>/dev/null || echo ""')
  const rootLocked = rootStatus.includes(' L ') || rootStatus.includes('locked')
  results.push(check(
    'acct-root-locked', 'accounts',
    'Root account should be locked',
    'The root account password should be locked to prevent direct root login. Use sudo instead.',
    rootLocked ? 'pass' : 'warn',
    rootStatus ? rootStatus.split('\n')[0] : 'Status unknown',
    'root L (locked)',
    'Lock root password: passwd -l root\nEnsure your user is in the sudo/wheel group first.',
    'CIS 5.4.2',
  ))

  // Extra UID 0 accounts
  const uid0Accounts = await exec(client, "awk -F: '($3 == 0) { print $1 }' /etc/passwd 2>/dev/null")
  const uid0List = uid0Accounts.split('\n').filter(Boolean)
  const uid0Ok = uid0List.length === 1 && uid0List[0] === 'root'
  results.push(check(
    'acct-uid0', 'accounts',
    'Only root should have UID 0',
    'No account other than root should have UID 0 (superuser privileges).',
    uid0Ok ? 'pass' : 'fail',
    uid0List.join(', ') || 'none',
    'Only: root',
    'Remove or change UID for extra UID 0 accounts:\n  usermod -u <new_uid> <username>',
    'CIS 5.4.3',
  ))

  // Accounts with no password
  const emptyPasswords = await exec(client, "awk -F: '($2 == \"\" || $2 == \"!\") { print $1 }' /etc/shadow 2>/dev/null | head -10")
  const emptyList = emptyPasswords.split('\n').filter(Boolean)
  results.push(check(
    'acct-empty-passwords', 'accounts',
    'No accounts with empty or unset passwords',
    'All accounts should have a locked or set password.',
    emptyList.length === 0 ? 'pass' : 'warn',
    emptyList.length === 0 ? 'None found' : emptyList.join(', '),
    'No accounts with empty passwords',
    'Set or lock passwords:\n  passwd <username>  # set password\n  passwd -l <username>  # lock account',
    'CIS 5.4.1',
  ))

  // Sudo without password
  const nopasswd = await exec(client, 'grep -r "NOPASSWD" /etc/sudoers /etc/sudoers.d/ 2>/dev/null | grep -v "^#" | head -5')
  const hasNopasswd = nopasswd.trim().length > 0
  results.push(check(
    'acct-sudo-nopasswd', 'accounts',
    'No NOPASSWD sudo rules',
    'sudo rules with NOPASSWD bypass password confirmation and should be avoided.',
    hasNopasswd ? 'warn' : 'pass',
    hasNopasswd ? nopasswd.split('\n')[0] : 'No NOPASSWD rules found',
    'No NOPASSWD in sudoers',
    'Review and remove NOPASSWD from /etc/sudoers and /etc/sudoers.d/*:\n  visudo  # safe editor',
    'CIS 5.3.6',
  ))

  return results
}

// ── File permissions ──────────────────────────────────────────────────────────

async function checkFilePermissions(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []

  async function checkPerm(id: string, path: string, expectedMode: string, title: string, remediation: string, ref?: string) {
    const stat = await exec(client, `stat -c '%a %U %G' ${path} 2>/dev/null`)
    if (!stat) {
      return check(id, 'file_permissions', title, `${path} permissions`, 'skip', 'File not found', expectedMode, remediation, ref)
    }
    const [mode] = stat.split(' ')
    const modeNum = parseInt(mode, 8)
    const maxMode = parseInt(expectedMode, 8)
    const ok = modeNum <= maxMode
    return check(id, 'file_permissions', title, `${path} should have permissions at most ${expectedMode}.`, ok ? 'pass' : 'fail',
      `${path}: ${mode}`, expectedMode, remediation, ref)
  }

  results.push(await checkPerm('perm-passwd', '/etc/passwd', '644', '/etc/passwd permissions', 'chmod 644 /etc/passwd', 'CIS 6.1.2'))
  results.push(await checkPerm('perm-shadow', '/etc/shadow', '640', '/etc/shadow permissions', 'chmod 000 /etc/shadow  # or 640 on systems that require group read', 'CIS 6.1.3'))
  results.push(await checkPerm('perm-group', '/etc/group', '644', '/etc/group permissions', 'chmod 644 /etc/group', 'CIS 6.1.4'))
  results.push(await checkPerm('perm-gshadow', '/etc/gshadow', '640', '/etc/gshadow permissions', 'chmod 000 /etc/gshadow', 'CIS 6.1.5'))
  results.push(await checkPerm('perm-sudoers', '/etc/sudoers', '440', '/etc/sudoers permissions', 'chmod 440 /etc/sudoers', 'CIS 5.3.3'))

  // World-writable files (sample scan — limit scope for performance)
  const wwFiles = await exec(client, 'find /etc /usr/bin /usr/sbin -xdev -type f -perm -0002 2>/dev/null | head -5')
  const wwList = wwFiles.split('\n').filter(Boolean)
  results.push(check(
    'perm-world-writable', 'file_permissions',
    'No world-writable system files',
    'Files in /etc, /usr/bin, /usr/sbin must not be world-writable.',
    wwList.length === 0 ? 'pass' : 'fail',
    wwList.length === 0 ? 'None found' : wwList.join(', '),
    'No world-writable files',
    'Remove world-write bit:\n  chmod o-w <file>',
    'CIS 6.1.10',
  ))

  return results
}

// ── Kernel hardening ──────────────────────────────────────────────────────────

async function checkKernel(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []

  async function sysctl(key: string): Promise<string> {
    const v = await exec(client, `sysctl -n ${key} 2>/dev/null`)
    return v.trim()
  }

  // ASLR
  const aslr = await sysctl('kernel.randomize_va_space')
  results.push(check(
    'kernel-aslr', 'kernel',
    'Enable ASLR (Address Space Layout Randomization)',
    'ASLR randomizes memory layout to hinder exploitation.',
    aslr === '2' ? 'pass' : aslr === '1' ? 'warn' : 'fail',
    `kernel.randomize_va_space = ${aslr || 'unknown'}`,
    'kernel.randomize_va_space = 2',
    'Add to /etc/sysctl.d/99-hardening.conf:\n  kernel.randomize_va_space = 2\nApply: sysctl -p /etc/sysctl.d/99-hardening.conf',
    'CIS 1.5.3',
  ))

  // IP forwarding
  const ipForward = await sysctl('net.ipv4.ip_forward')
  const ipForwardOk = ipForward === '0'
  results.push(check(
    'kernel-ip-forward', 'kernel',
    'Disable IP forwarding (unless router)',
    'IP forwarding allows the host to route packets between networks. Disable unless acting as a router.',
    ipForwardOk ? 'pass' : 'warn',
    `net.ipv4.ip_forward = ${ipForward || 'unknown'}`,
    'net.ipv4.ip_forward = 0',
    'Add to /etc/sysctl.d/99-hardening.conf:\n  net.ipv4.ip_forward = 0\nApply: sysctl -p',
    'CIS 3.1.1',
  ))

  // ICMP redirects
  const sendRedirects = await sysctl('net.ipv4.conf.all.send_redirects')
  results.push(check(
    'kernel-send-redirects', 'kernel',
    'Disable sending ICMP redirects',
    'Hosts that are not routers should not send ICMP redirects.',
    sendRedirects === '0' ? 'pass' : 'fail',
    `net.ipv4.conf.all.send_redirects = ${sendRedirects || 'unknown'}`,
    'net.ipv4.conf.all.send_redirects = 0',
    'Add to /etc/sysctl.d/99-hardening.conf:\n  net.ipv4.conf.all.send_redirects = 0\n  net.ipv4.conf.default.send_redirects = 0',
    'CIS 3.1.2',
  ))

  // Accept source routing
  const acceptSourceRoute = await sysctl('net.ipv4.conf.all.accept_source_route')
  results.push(check(
    'kernel-source-route', 'kernel',
    'Disable source-routed packets',
    'Source routing allows senders to specify the route — a classic MITM vector.',
    acceptSourceRoute === '0' ? 'pass' : 'fail',
    `net.ipv4.conf.all.accept_source_route = ${acceptSourceRoute || 'unknown'}`,
    'net.ipv4.conf.all.accept_source_route = 0',
    'Add to /etc/sysctl.d/99-hardening.conf:\n  net.ipv4.conf.all.accept_source_route = 0\n  net.ipv4.conf.default.accept_source_route = 0',
    'CIS 3.2.1',
  ))

  // SYN cookies
  const synCookies = await sysctl('net.ipv4.tcp_syncookies')
  results.push(check(
    'kernel-syn-cookies', 'kernel',
    'Enable TCP SYN cookies',
    'SYN cookies protect against SYN flood (DoS) attacks.',
    synCookies === '1' ? 'pass' : 'fail',
    `net.ipv4.tcp_syncookies = ${synCookies || 'unknown'}`,
    'net.ipv4.tcp_syncookies = 1',
    'Add to /etc/sysctl.d/99-hardening.conf:\n  net.ipv4.tcp_syncookies = 1',
    'CIS 3.2.8',
  ))

  // Dmesg restriction
  const dmesgRestrict = await sysctl('kernel.dmesg_restrict')
  results.push(check(
    'kernel-dmesg-restrict', 'kernel',
    'Restrict dmesg to root',
    'Kernel log (dmesg) may contain sensitive info like memory addresses that aid exploitation.',
    dmesgRestrict === '1' ? 'pass' : 'warn',
    `kernel.dmesg_restrict = ${dmesgRestrict || 'unknown'}`,
    'kernel.dmesg_restrict = 1',
    'Add to /etc/sysctl.d/99-hardening.conf:\n  kernel.dmesg_restrict = 1',
    'CIS 1.5.2',
  ))

  return results
}

// ── Audit & logging ───────────────────────────────────────────────────────────

async function checkAudit(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []

  // auditd
  const auditdStatus = await exec(client, 'systemctl is-active auditd 2>/dev/null || service auditd status 2>/dev/null | grep -i "running\\|active" | head -1')
  const auditdActive = auditdStatus.includes('active') || auditdStatus.includes('running')
  results.push(check(
    'audit-auditd', 'audit',
    'auditd service is running',
    'The audit daemon records security-relevant events for forensic review.',
    auditdActive ? 'pass' : 'fail',
    auditdStatus || 'not running',
    'active (running)',
    'Install and enable: apt install auditd (Debian) or yum install audit (RHEL)\n  systemctl enable --now auditd',
    'CIS 4.1.1',
  ))

  // rsyslog / syslog
  const syslogStatus = await exec(client, 'systemctl is-active rsyslog 2>/dev/null || systemctl is-active syslog 2>/dev/null || echo "inactive"')
  const syslogActive = syslogStatus.trim() === 'active'
  results.push(check(
    'audit-syslog', 'audit',
    'Syslog service is running',
    'A syslog daemon (rsyslog/syslog) must be running to collect system log events.',
    syslogActive ? 'pass' : 'warn',
    syslogStatus || 'inactive',
    'active',
    'Install and enable: apt install rsyslog (Debian)\n  systemctl enable --now rsyslog',
    'CIS 4.2.1',
  ))

  // Audit rules — check if at least some rules exist
  const auditRules = await exec(client, 'auditctl -l 2>/dev/null | grep -v "^-a\\ never" | head -5')
  const hasAuditRules = auditRules.trim() && !auditRules.includes('No rules')
  results.push(check(
    'audit-rules', 'audit',
    'Audit rules are configured',
    'auditd should have rules defined to track security-relevant syscalls and file access.',
    hasAuditRules ? 'pass' : 'warn',
    hasAuditRules ? `${auditRules.split('\n').length} rule(s) defined` : 'No rules configured',
    'Rules for login, sudo, file access etc.',
    'Add audit rules to /etc/audit/rules.d/audit.rules. Example:\n  -w /etc/passwd -p wa -k identity\n  -w /etc/sudoers -p wa -k sudoers\n  -w /var/log/auth.log -p wa -k auth\nReload: augenrules --load',
    'CIS 4.1.4',
  ))

  return results
}

// ── Firewall ──────────────────────────────────────────────────────────────────

async function checkFirewall(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []

  // ufw
  const ufwStatus = await exec(client, 'ufw status 2>/dev/null | head -3')
  if (ufwStatus.includes('Status: active') || ufwStatus.includes('active')) {
    results.push(check(
      'fw-ufw', 'firewall',
      'Firewall is active (ufw)',
      'A host-based firewall limits exposure to unwanted network traffic.',
      'pass',
      'ufw: active',
      'Firewall active',
      '', // already passing
      'CIS 3.5.1',
    ))
    return results
  }

  // firewalld
  const fwdStatus = await exec(client, 'firewall-cmd --state 2>/dev/null')
  if (fwdStatus.includes('running')) {
    results.push(check(
      'fw-firewalld', 'firewall',
      'Firewall is active (firewalld)',
      'A host-based firewall limits exposure to unwanted network traffic.',
      'pass',
      'firewalld: running',
      'Firewall active',
      '',
      'CIS 3.5.1',
    ))
    return results
  }

  // iptables fallback
  const iptablesRules = await exec(client, 'iptables -L INPUT --line-numbers 2>/dev/null | grep -v "^Chain\\|^num\\|^$" | wc -l')
  const ruleCount = parseInt(iptablesRules, 10) || 0
  const hasIptables = ruleCount > 1  // >1 because there's usually an "ACCEPT all" default

  results.push(check(
    'fw-iptables', 'firewall',
    'Host-based firewall is active',
    'ufw, firewalld, or iptables rules must restrict inbound network traffic.',
    hasIptables ? 'warn' : 'fail',
    hasIptables ? `iptables: ${ruleCount} INPUT rule(s)` : 'No firewall detected',
    'ufw or firewalld active',
    'Enable ufw: apt install ufw && ufw default deny incoming && ufw allow ssh && ufw enable\nOr: systemctl enable --now firewalld && firewall-cmd --set-default-zone=drop',
    'CIS 3.5.1',
  ))

  return results
}

// ── Updates ───────────────────────────────────────────────────────────────────

async function checkUpdates(client: Client): Promise<BenchmarkCheck[]> {
  const results: BenchmarkCheck[] = []

  // Debian/Ubuntu: unattended-upgrades
  const unattended = await exec(client, 'dpkg -l unattended-upgrades 2>/dev/null | grep "^ii" | head -1')
  if (unattended) {
    const enaConf = await exec(client, 'cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null | grep "Unattended-Upgrade" | head -1')
    const enabled = enaConf.includes('"1"') || enaConf.includes('"true"')
    results.push(check(
      'upd-unattended', 'updates',
      'Automatic security updates enabled',
      'Security patches should be applied automatically to reduce exposure window.',
      enabled ? 'pass' : 'warn',
      unattended ? `Installed, auto-upgrade: ${enabled ? 'enabled' : 'disabled'}` : 'Not configured',
      'Enabled',
      'Enable: dpkg-reconfigure unattended-upgrades\nOr set in /etc/apt/apt.conf.d/20auto-upgrades:\n  APT::Periodic::Update-Package-Lists "1";\n  APT::Periodic::Unattended-Upgrade "1";',
      'CIS 1.9',
    ))
    return results
  }

  // RHEL: yum-cron / dnf-automatic
  const dnfAuto = await exec(client, 'systemctl is-enabled dnf-automatic 2>/dev/null || systemctl is-enabled yum-cron 2>/dev/null || echo "not-found"')
  const dnfEnabled = dnfAuto === 'enabled'
  if (dnfAuto !== 'not-found') {
    results.push(check(
      'upd-dnf-auto', 'updates',
      'Automatic security updates enabled',
      'Security patches should be applied automatically.',
      dnfEnabled ? 'pass' : 'warn',
      `dnf-automatic/yum-cron: ${dnfAuto}`,
      'enabled',
      'Install and enable: yum install dnf-automatic && systemctl enable --now dnf-automatic-install.timer\nConfigure apply_updates = yes in /etc/dnf/automatic.conf',
      'CIS 1.9',
    ))
    return results
  }

  // Could not determine
  results.push(check(
    'upd-unknown', 'updates',
    'Automatic security updates',
    'Security patches should be applied automatically.',
    'skip',
    'Could not determine package manager',
    'Automatic updates enabled',
    'For Debian/Ubuntu: apt install unattended-upgrades\nFor RHEL: yum install dnf-automatic',
    'CIS 1.9',
  ))

  return results
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runBenchmark(client: Client): Promise<BenchmarkResult> {
  const [sshChecks, pwChecks, acctChecks, permChecks, kernelChecks, auditChecks, fwChecks, updateChecks] = await Promise.all([
    checkSsh(client),
    checkPasswordPolicy(client),
    checkAccounts(client),
    checkFilePermissions(client),
    checkKernel(client),
    checkAudit(client),
    checkFirewall(client),
    checkUpdates(client),
  ])

  const checks: BenchmarkCheck[] = [
    ...sshChecks,
    ...pwChecks,
    ...acctChecks,
    ...permChecks,
    ...kernelChecks,
    ...auditChecks,
    ...fwChecks,
    ...updateChecks,
  ]

  const total = checks.length
  const pass = checks.filter((c) => c.status === 'pass').length
  const warn = checks.filter((c) => c.status === 'warn').length
  const fail = checks.filter((c) => c.status === 'fail').length
  const skip = checks.filter((c) => c.status === 'skip').length
  // Score based on non-skipped checks: pass=1, warn=0.5, fail=0
  const scored = total - skip
  const score = scored > 0 ? Math.round(((pass + warn * 0.5) / scored) * 100) : 0

  return {
    ran_at: new Date().toISOString(),
    checks,
    summary: { total, pass, warn, fail, skip, score },
  }
}
