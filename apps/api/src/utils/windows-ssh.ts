/**
 * Windows Server SSH utilities.
 *
 * When OpenSSH Server is installed on Windows Server 2019/2022, the default
 * shell is cmd.exe. All commands here are PowerShell one-liners passed via
 * `powershell -NonInteractive -Command "..."` so they work regardless of
 * whether the user's default shell is cmd or powershell.
 */

import type { Client } from 'ssh2'

type SshExecFn = (client: Client, cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>

// ── OS detection ──────────────────────────────────────────────────────────────

/**
 * Detect whether an SSH session is a Windows or Linux server.
 * Returns 'windows' | 'linux'.
 *
 * Strategy: run `ver` (Windows-only). On Linux this silently fails (exit 127).
 */
export async function detectOsType(
  client: Client,
  sshExec: SshExecFn,
): Promise<'windows' | 'linux'> {
  try {
    // `ver` prints "Microsoft Windows [Version x.x.x]" on Windows, fails on Linux
    const r = await sshExec(client, 'ver')
    if (r.stdout.toLowerCase().includes('windows')) return 'windows'
  } catch { /* fall through */ }
  return 'linux'
}

// ── Windows info gathering ─────────────────────────────────────────────────────

export interface WindowsServerInfo {
  os_type: 'windows'
  os: {
    name: string
    pretty_name: string
    version: string
    id: string
    kernel: string
    build: string
    edition: string
  }
  uptime: string
  memory: string
  memory_total_mb: number
  memory_free_mb: number
  cpu_count: number
  users: Array<{ username: string; uid: number; gecos: string; home: string; shell: string }>
  logged_in: string[]
  authorized_keys: Array<{
    linux_user: string; key_type: string; comment: string
    fingerprint: string; key_body: string; key_body_short: string
    db_key_id: string | null; db_key_name: string | null; is_known: boolean; is_archived: boolean
  }>
  hostname: string
  domain: string | null
  roles: string[]
}

/** PS one-liner wrapper — run PowerShell command via cmd's powershell.exe */
function ps(cmd: string) {
  return `powershell -NonInteractive -Command "${cmd.replace(/"/g, '\\"')}"`
}

export async function gatherWindowsInfo(
  client: Client,
  sshExec: SshExecFn,
  serverId: string,
): Promise<Omit<WindowsServerInfo, 'authorized_keys'>> {
  const [osOut, memOut, cpuOut, uptimeOut, usersOut, whoOut, hostnameOut, rolesOut] = await Promise.all([
    // OS info
    sshExec(client, ps(
      'Get-WmiObject Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture | ConvertTo-Csv -NoTypeInformation | Select-Object -Last 1'
    )),
    // Memory
    sshExec(client, ps(
      '$os=Get-WmiObject Win32_OperatingSystem; Write-Output "$([math]::Round($os.TotalVisibleMemorySize/1024)) $([math]::Round($os.FreePhysicalMemory/1024))"'
    )),
    // CPU count
    sshExec(client, ps(
      '(Get-WmiObject Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum'
    )),
    // Uptime
    sshExec(client, ps(
      '$b=(Get-WmiObject Win32_OperatingSystem).LastBootUpTime; $u=[Management.ManagementDateTimeConverter]::ToDateTime($b); Write-Output "up since $($u.ToString(\"yyyy-MM-dd HH:mm\"))"'
    )),
    // Local users
    sshExec(client, ps(
      'Get-LocalUser | Select-Object Name,Enabled | ConvertTo-Csv -NoTypeInformation'
    )),
    // Logged-in sessions
    sshExec(client, 'query session 2>nul || echo (none)'),
    // Hostname + domain
    sshExec(client, ps(
      '$c=Get-WmiObject Win32_ComputerSystem; Write-Output "$($c.Name)|$($c.Domain)"'
    )),
    // Installed Windows roles (Server only, may fail on desktop)
    sshExec(client, ps(
      'try { Get-WindowsFeature | Where-Object {$_.Installed} | Select-Object -ExpandProperty Name | Join-String -Separator "," } catch { Write-Output "" }'
    )),
  ])

  // Parse OS
  const osParts = parseSimpleCsv(osOut.stdout)
  const osCaption = osParts[0] ?? 'Windows Server'
  const osVersion = osParts[1] ?? ''
  const osBuild = osParts[2] ?? ''

  // Parse memory
  const memParts = memOut.stdout.trim().split(/\s+/)
  const memTotalMb = parseInt(memParts[0]) || 0
  const memFreeMb = parseInt(memParts[1]) || 0
  const memUsedMb = memTotalMb - memFreeMb
  const memStr = `${humanMb(memUsedMb)} used / ${humanMb(memTotalMb)} total`

  const cpuCount = Math.max(1, parseInt(cpuOut.stdout.trim()) || 1)

  // Parse local users from CSV
  const userLines = usersOut.stdout.split('\n').filter(Boolean).slice(1) // skip CSV header
  const users = userLines.map((line, i) => {
    const parts = parseSimpleCsv(line)
    return {
      username: parts[0]?.replace(/^"|"$/g, '') ?? `User${i}`,
      uid: i,
      gecos: '',
      home: `C:\\Users\\${parts[0]?.replace(/^"|"$/g, '') ?? ''}`,
      shell: 'PowerShell',
    }
  }).filter((u) => u.username)

  // Parse logged-in sessions
  const loggedIn = whoOut.stdout.split('\n')
    .filter((l) => !l.includes('SESSION') && l.trim().length > 0 && !l.includes('(none)'))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean)

  // Hostname / domain
  const [hostname, domain] = (hostnameOut.stdout.trim() || '|').split('|')

  // Roles
  const roles = rolesOut.stdout.trim()
    ? rolesOut.stdout.trim().split(',').map((r) => r.trim()).filter(Boolean)
    : []

  return {
    os_type: 'windows',
    os: {
      name: osCaption,
      pretty_name: osCaption,
      version: osVersion,
      id: 'windows',
      kernel: `Windows Build ${osBuild}`,
      build: osBuild,
      edition: osCaption.includes('2022') ? '2022'
        : osCaption.includes('2019') ? '2019'
        : osCaption.includes('2016') ? '2016'
        : osCaption.includes('2012') ? '2012 R2'
        : 'Unknown',
    },
    uptime: uptimeOut.stdout.trim(),
    memory: memStr,
    memory_total_mb: memTotalMb,
    memory_free_mb: memFreeMb,
    cpu_count: cpuCount,
    users,
    logged_in: loggedIn,
    hostname: hostname?.trim() ?? '',
    domain: domain?.trim() || null,
    roles,
  }
}

// ── Windows software detection ─────────────────────────────────────────────────

export interface WindowsSoftwareItem {
  name: string
  category: 'webserver' | 'database' | 'language' | 'container' | 'process_manager' | 'monitoring' | 'security' | 'service'
  installed: boolean
  version: string | null
  service_name: string | null
  status: 'running' | 'stopped' | 'unknown' | null
  enabled: 'auto' | 'manual' | 'disabled' | null
}

/** Detect Windows services and installed software */
export async function detectWindowsSoftware(
  client: Client,
  sshExec: SshExecFn,
): Promise<WindowsSoftwareItem[]> {
  // One big PS script that checks everything and outputs TSV
  const script = `
$results = @()
function Test-Svc($n,$display,$cat) {
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  if ($s) {
    $start = (Get-WmiObject Win32_Service -Filter "Name='$n'" -ErrorAction SilentlyContinue).StartMode
    $results += [PSCustomObject]@{
      Name=$display; Category=$cat; Installed='true'
      Version=''; ServiceName=$n; Status=$s.Status.ToString()
      StartMode=if($start){'Auto','Manual','Disabled'|Where{$_ -eq $start}|Select -First 1}else{''}
    }
  }
}
function Test-Cmd($cmd,$display,$cat,$verArg) {
  $p = (Get-Command $cmd -ErrorAction SilentlyContinue)
  if ($p) {
    $v = try { & $cmd $verArg 2>&1 | Select-String '[\d]+\.[\d]+' | Select -First 1 } catch { '' }
    $results += [PSCustomObject]@{
      Name=$display; Category=$cat; Installed='true'
      Version=$v; ServiceName=''; Status=''; StartMode=''
    }
  }
}
function Test-Feature($n,$display,$cat) {
  $f = Get-WindowsFeature -Name $n -ErrorAction SilentlyContinue
  if ($f -and $f.Installed) {
    $results += [PSCustomObject]@{
      Name=$display; Category=$cat; Installed='true'
      Version=''; ServiceName=$n; Status='Active'; StartMode='Auto'
    }
  }
}
# Web servers
Test-Svc 'W3SVC'         'IIS'            'webserver'
Test-Svc 'nginx'         'Nginx'          'webserver'
Test-Svc 'Apache2.4'     'Apache'         'webserver'
# Databases
Test-Svc 'MSSQLSERVER'   'SQL Server'     'database'
Test-Svc 'MSSQL$SQLEXPRESS' 'SQL Express' 'database'
Test-Svc 'MySQL'         'MySQL'          'database'
Test-Svc 'MySQL80'       'MySQL'          'database'
Test-Svc 'postgresql-x64-15' 'PostgreSQL' 'database'
Test-Svc 'postgresql-x64-16' 'PostgreSQL' 'database'
Test-Svc 'Redis'         'Redis'          'database'
Test-Svc 'MongoDB'       'MongoDB'        'database'
# Languages / runtimes
Test-Cmd 'php'           'PHP'            'language'     '--version'
Test-Cmd 'node'          'Node.js'        'language'     '--version'
Test-Cmd 'python'        'Python'         'language'     '--version'
Test-Cmd 'java'          'Java'           'language'     '-version'
Test-Cmd 'dotnet'        '.NET'           'language'     '--version'
Test-Cmd 'ruby'          'Ruby'           'language'     '--version'
Test-Cmd 'go'            'Go'             'language'     'version'
# Containers
Test-Svc 'docker'        'Docker'         'container'
# Process managers
Test-Svc 'nssm'          'NSSM'           'process_manager'
# Monitoring
Test-Svc 'zabbix_agentd' 'Zabbix Agent'  'monitoring'
Test-Svc 'DatadogAgent'  'Datadog Agent'  'monitoring'
# Security
Test-Feature 'Windows-Defender' 'Windows Defender' 'security'
$results | ForEach-Object {
  Write-Output "$($_.Name)\t$($_.Category)\t$($_.Installed)\t$($_.Version)\t$($_.ServiceName)\t$($_.Status)\t$($_.StartMode)"
}
`.trim()

  const out = await sshExec(client, `powershell -NonInteractive -Command "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)

  const items: WindowsSoftwareItem[] = []
  for (const line of out.stdout.split('\n').filter(Boolean)) {
    const [name, category, , version, serviceName, status, startMode] = line.split('\t')
    if (!name) continue
    items.push({
      name: name.trim(),
      category: (category?.trim() ?? 'service') as WindowsSoftwareItem['category'],
      installed: true,
      version: version?.trim() || null,
      service_name: serviceName?.trim() || null,
      status: (status?.trim().toLowerCase() === 'running' ? 'running'
        : status?.trim().toLowerCase() === 'stopped' ? 'stopped'
        : status?.trim() ? 'unknown' : null) as WindowsSoftwareItem['status'],
      enabled: (startMode?.trim().toLowerCase() === 'auto' ? 'auto'
        : startMode?.trim().toLowerCase() === 'manual' ? 'manual'
        : startMode?.trim().toLowerCase() === 'disabled' ? 'disabled'
        : null) as WindowsSoftwareItem['enabled'],
    })
  }

  return dedupe(items)
}

// ── Windows authorized keys ────────────────────────────────────────────────────

/**
 * Read authorized_keys for Windows OpenSSH.
 * OpenSSH on Windows stores admin keys in:
 *   C:\ProgramData\ssh\administrators_authorized_keys
 * And per-user in:
 *   C:\Users\<username>\.ssh\authorized_keys
 */
export async function getWindowsAuthorizedKeys(
  client: Client,
  sshExec: SshExecFn,
): Promise<Array<{ linux_user: string; line: string }>> {
  const rawLines: Array<{ linux_user: string; line: string }> = []

  // Admin-level authorized_keys
  const adminKeys = await sshExec(client,
    `powershell -NonInteractive -Command "try { Get-Content 'C:\\ProgramData\\ssh\\administrators_authorized_keys' -ErrorAction Stop } catch { }"`,
  )
  for (const line of adminKeys.stdout.split('\n').filter(Boolean)) {
    if (!line.trim().startsWith('#')) rawLines.push({ linux_user: 'Administrator', line: line.trim() })
  }

  return rawLines
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function humanMb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

/** Parse a single CSV line (handles quoted fields) */
function parseSimpleCsv(line: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of line.trim()) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (ch === ',' && !inQuote) { result.push(cur); cur = ''; continue }
    cur += ch
  }
  result.push(cur)
  return result
}

/** Deduplicate by name (e.g. MySQL detected twice via different service names) */
function dedupe(items: WindowsSoftwareItem[]): WindowsSoftwareItem[] {
  const seen = new Set<string>()
  return items.filter((i) => {
    if (seen.has(i.name)) return false
    seen.add(i.name)
    return true
  })
}
