/**
 * OS-aware authorized_keys operations.
 * Automatically routes to the Linux bash or Windows PowerShell implementation
 * based on server.os_type stored in the database.
 */
import { db } from '../db/client'
import { withServerSsh } from './server-ssh'
import { sshExec } from './ssh'
import { pushKeyToWindowsServer, removeKeyFromWindowsServer } from './windows-key-ops'

function homeDir(linuxUser: string): string {
  return linuxUser === 'root' ? '/root' : `/home/${linuxUser}`
}

/**
 * Build a shell script that installs a public key into a target user's
 * authorized_keys AND guarantees correct ownership/permissions.
 *
 * Ownership matters: when the management user is root, plain mkdir/touch create
 * root-owned files, and sshd's StrictModes then rejects the target user's key.
 * So we ALWAYS chown the .ssh tree to the target user at the end — using sudo
 * only when we're not already root (a plain `sudo` prefix would fail on hosts
 * without sudo when we're root anyway).
 */
function buildInstallKeyScript(linuxUser: string, hd: string, escapedKey: string): string {
  // Determine privilege prefix first (setup uses `;` so it can't abort the
  // chain), then run the install steps joined with `&&`.
  const setup = `SUDO=''; if [ "$(id -u)" != "0" ]; then SUDO='sudo'; fi`
  const steps = [
    `$SUDO mkdir -p ${hd}/.ssh`,
    `$SUDO touch ${hd}/.ssh/authorized_keys`,
    `( $SUDO grep -qxF '${escapedKey}' ${hd}/.ssh/authorized_keys || echo '${escapedKey}' | $SUDO tee -a ${hd}/.ssh/authorized_keys > /dev/null )`,
    `$SUDO chmod 700 ${hd}/.ssh`,
    `$SUDO chmod 600 ${hd}/.ssh/authorized_keys`,
    `$SUDO chown -R ${linuxUser}:${linuxUser} ${hd}/.ssh`,
  ].join(' && ')
  return `${setup}; ${steps}`
}

/** Append a public key to a server, handling both Linux and Windows. */
export async function appendKeyToServer(
  server: { id: string; os_type?: string | null },
  linuxUser: string,
  publicKeyLine: string,
): Promise<void> {
  await withServerSsh(server.id, async (client) => {
    if (server.os_type === 'windows') {
      await pushKeyToWindowsServer(client, linuxUser, publicKeyLine)
    } else {
      // Linux — install and fix ownership so root-created files don't break
      // the target user's key auth (see buildInstallKeyScript).
      const hd = homeDir(linuxUser)
      const escapedKey = publicKeyLine.replace(/'/g, "'\\''")
      await sshExec(client, buildInstallKeyScript(linuxUser, hd, escapedKey))
    }
  })
}

/** Remove a public key from a server, handling both Linux and Windows. */
export async function removeKeyFromServer(
  server: { id: string; os_type?: string | null },
  linuxUser: string,
  publicKeyBody: string,   // base64 body token only (middle part of authorized_keys line)
): Promise<void> {
  await withServerSsh(server.id, async (client) => {
    if (server.os_type === 'windows') {
      await removeKeyFromWindowsServer(client, linuxUser, publicKeyBody)
    } else {
      // Linux
      const hd = homeDir(linuxUser)
      await sshExec(client, `sudo grep -v '${publicKeyBody}' ${hd}/.ssh/authorized_keys | sudo tee ${hd}/.ssh/authorized_keys.new > /dev/null && sudo mv ${hd}/.ssh/authorized_keys.new ${hd}/.ssh/authorized_keys && sudo chmod 600 ${hd}/.ssh/authorized_keys && sudo chown ${linuxUser}:${linuxUser} ${hd}/.ssh/authorized_keys`)
    }
  })
}

/** Push a key to a server during assignment creation, with user existence check. */
export async function pushKeyToServer(
  serverId: string,
  linuxUser: string,
  publicKey: string,
): Promise<void> {
  const server = await db.selectFrom('servers').select(['id', 'os_type']).where('id', '=', serverId).executeTakeFirst()
  if (!server) throw new Error('Server not found')

  await withServerSsh(serverId, async (client) => {
    if (server.os_type === 'windows') {
      await pushKeyToWindowsServer(client, linuxUser, publicKey)
    } else {
      // Linux — validate user exists first
      const userCheck = await sshExec(client, `id ${linuxUser} 2>/dev/null && echo EXISTS || echo MISSING`)
      if (!userCheck.stdout.includes('EXISTS')) {
        throw new Error(`Linux user "${linuxUser}" does not exist on this server`)
      }

      const hd = homeDir(linuxUser)
      const escapedKey = publicKey.replace(/'/g, "'\\''")
      // Creates .ssh + authorized_keys, appends the key, and — critically —
      // chowns the tree to the target user so sshd accepts it even when we
      // connected as root (see buildInstallKeyScript).
      await sshExec(client, buildInstallKeyScript(linuxUser, hd, escapedKey))
    }
  })
}

/** List users on a server (Linux or Windows). */
export async function listServerUsers(serverId: string): Promise<Array<{ username: string; uid: number; home: string; shell: string }>> {
  const server = await db.selectFrom('servers').select(['id', 'os_type']).where('id', '=', serverId).executeTakeFirst()
  if (!server) throw new Error('Server not found')

  return withServerSsh(serverId, async (client) => {
    if (server.os_type === 'windows') {
      const { listWindowsUsers } = await import('./windows-key-ops')
      return listWindowsUsers(client)
    } else {
      const out = await sshExec(client, "getent passwd | awk -F: '$3==0||$3>=1000{print $1\":\"$3\":\"$6\":\"$7}'")
      return out.stdout.split('\n').filter(Boolean).map((line) => {
        const [username, uid, home, shell] = line.split(':')
        return { username, uid: Number(uid), home: home || '', shell: shell || '' }
      })
    }
  })
}
