/**
 * Windows OpenSSH authorized_keys management.
 *
 * Key locations:
 *   - Administrators group users → C:\ProgramData\ssh\administrators_authorized_keys
 *     (file must be owned by SYSTEM/Administrators, no inheritance — Windows OpenSSH requirement)
 *   - Regular users              → C:\Users\<username>\.ssh\authorized_keys
 */
import type { Client } from 'ssh2'
import { sshExec } from './ssh'

/** Run a PowerShell command over an existing SSH client */
async function ps(client: Client, script: string): Promise<string> {
  // Inline PS: collapse newlines to semicolons, escape double-quotes for the shell arg
  const oneLiner = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join('; ')
  const { stdout, stderr, code } = await sshExec(client, `powershell -NonInteractive -Command "${oneLiner.replace(/"/g, '\\"')}"`)
  if (code !== 0 && stderr) throw new Error(stderr.trim() || `PowerShell exited ${code}`)
  return stdout.trim()
}

/** Check whether the given Windows user is in the local Administrators group */
async function isWindowsAdmin(client: Client, username: string): Promise<boolean> {
  try {
    const out = await ps(client, `
      $members = Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Name
      $match = $members | Where-Object { $_ -match '\\\\${username}$' }
      if ($match) { 'yes' } else { 'no' }
    `)
    return out.trim().toLowerCase().startsWith('yes')
  } catch {
    return false
  }
}

function authKeysPath(username: string, isAdmin: boolean): string {
  return isAdmin
    ? 'C:\\ProgramData\\ssh\\administrators_authorized_keys'
    : `C:\\Users\\${username}\\.ssh\\authorized_keys`
}

/** Push a public key to a Windows server for the given user */
export async function pushKeyToWindowsServer(
  client: Client,
  windowsUser: string,
  publicKeyLine: string,
): Promise<void> {
  // 1. Verify user exists
  const exists = await ps(client, `
    $u = Get-LocalUser -Name '${windowsUser}' -ErrorAction SilentlyContinue
    if ($u) { 'yes' } else { 'no' }
  `)
  if (!exists.toLowerCase().startsWith('yes')) {
    throw new Error(`Windows user "${windowsUser}" does not exist on this server`)
  }

  const admin = await isWindowsAdmin(client, windowsUser)
  const keyPath = authKeysPath(windowsUser, admin)
  const dir = keyPath.includes('\\administrators_authorized_keys')
    ? 'C:\\ProgramData\\ssh'
    : `C:\\Users\\${windowsUser}\\.ssh`

  // Escape key for PowerShell string
  const escapedKey = publicKeyLine.replace(/'/g, "''")

  // 2. Ensure directory and file exist, append key if not already present, fix permissions
  await ps(client, `
    if (-not (Test-Path '${dir}')) { New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null }
    if (-not (Test-Path '${keyPath}')) { New-Item -ItemType File -Path '${keyPath}' -Force | Out-Null }
    $existing = Get-Content '${keyPath}' -ErrorAction SilentlyContinue
    if ($existing -notcontains '${escapedKey}') {
      Add-Content -Path '${keyPath}' -Value '${escapedKey}'
    }
    ${admin
      ? `icacls '${keyPath}' /inheritance:r /grant 'SYSTEM:(F)' /grant 'Administrators:(F)' 2>&1 | Out-Null`
      : `icacls '${keyPath}' /inheritance:r /grant "${windowsUser}:(F)" 2>&1 | Out-Null`
    }
  `)
}

/** Remove a public key from a Windows server for the given user */
export async function removeKeyFromWindowsServer(
  client: Client,
  windowsUser: string,
  publicKeyBody: string,   // just the base64 body (middle token), used for matching
): Promise<void> {
  const admin = await isWindowsAdmin(client, windowsUser)
  const keyPath = authKeysPath(windowsUser, admin)

  const escapedBody = publicKeyBody.replace(/'/g, "''")

  await ps(client, `
    if (Test-Path '${keyPath}') {
      $lines = Get-Content '${keyPath}' -ErrorAction SilentlyContinue
      $filtered = $lines | Where-Object { $_ -notmatch '${escapedBody}' }
      Set-Content -Path '${keyPath}' -Value $filtered -Force
    }
  `)
}

/** List Windows local users (for the assignments UI) */
export async function listWindowsUsers(client: Client): Promise<Array<{ username: string; uid: number; home: string; shell: string }>> {
  const out = await ps(client, `
    Get-LocalUser | ForEach-Object {
      $name = $_.Name
      $home = "C:\\Users\\$name"
      Write-Output "$name|0|$home|powershell"
    }
  `)
  return out.split('\n').filter(Boolean).map((line, i) => {
    const [username, , home, shell] = line.trim().split('|')
    return { username: username ?? '', uid: i, home: home ?? '', shell: shell ?? 'powershell' }
  })
}
