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
      // Linux
      const hd = homeDir(linuxUser)
      const escapedKey = publicKeyLine.replace(/'/g, "'\\''")
      await sshExec(client, `grep -qxF '${escapedKey}' ${hd}/.ssh/authorized_keys || echo '${escapedKey}' | sudo tee -a ${hd}/.ssh/authorized_keys`)
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
      await sshExec(client, `sudo mkdir -p ${hd}/.ssh && sudo chmod 700 ${hd}/.ssh && sudo chown ${linuxUser}:${linuxUser} ${hd}/.ssh`)
      await sshExec(client, `sudo touch ${hd}/.ssh/authorized_keys && sudo chmod 600 ${hd}/.ssh/authorized_keys && sudo chown ${linuxUser}:${linuxUser} ${hd}/.ssh/authorized_keys`)
      const escapedKey = publicKey.replace(/'/g, "'\\''")
      await sshExec(client, `grep -qxF '${escapedKey}' ${hd}/.ssh/authorized_keys || echo '${escapedKey}' | sudo tee -a ${hd}/.ssh/authorized_keys`)
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
