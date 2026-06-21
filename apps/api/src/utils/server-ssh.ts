/**
 * Shared helper: run fn over an SSH connection to a server via its management key,
 * with automatic fallback to other assigned keys if the management key fails
 * (protects against post-rotation key mismatches).
 */
import { Client } from 'ssh2'
import { db } from '../db/client'
import { decryptSecret, getVaultKey } from './vault'
import { connectWithFallback } from './ssh'

export interface UsedKeyInfo {
  keyId: string
  keyName: string
  isFallback: boolean  // true when management key failed and a fallback was used
}

export async function withServerSsh<T>(
  serverId: string,
  fn: (client: Client) => Promise<T>,
  onKeyUsed?: (info: UsedKeyInfo) => void,
  connectTimeout?: number,
): Promise<T> {
  const server = await db.selectFrom('servers').selectAll().where('id', '=', serverId).executeTakeFirst()
  if (!server || !server.management_key_id) throw Object.assign(new Error('Server not configured'), { statusCode: 400 })

  const vaultKey = getVaultKey()

  const mgmtKey = await db.selectFrom('ssh_keys').selectAll().where('id', '=', server.management_key_id).executeTakeFirst()
  if (!mgmtKey) throw Object.assign(new Error('Management key not found'), { statusCode: 400 })

  // Primary: management key. Fallback: other active keys assigned to the management linux_user
  const fallbackRows = await db.selectFrom('key_assignments')
    .innerJoin('ssh_keys', 'ssh_keys.id', 'key_assignments.key_id')
    .select(['ssh_keys.id', 'ssh_keys.name', 'ssh_keys.private_key_enc'])
    .where('key_assignments.server_id', '=', serverId)
    .where('key_assignments.linux_user', '=', server.management_linux_user)
    .where('key_assignments.is_active', '=', true)
    .where('key_assignments.key_id', '!=', server.management_key_id)
    .execute()

  const keysToTry = [
    { id: mgmtKey.id, name: mgmtKey.name, privatePem: decryptSecret(mgmtKey.private_key_enc, vaultKey) },
    ...fallbackRows.map((r) => ({ id: r.id, name: r.name, privatePem: decryptSecret(r.private_key_enc, vaultKey) })),
  ]

  const { client, keyId: usedKeyId } = await connectWithFallback(
    server.hostname, server.ssh_port, server.management_linux_user,
    keysToTry, server.host_key_fingerprint ?? undefined, connectTimeout,
  )

  if (onKeyUsed) {
    const usedKey = keysToTry.find((k) => k.id === usedKeyId)
    onKeyUsed({
      keyId: usedKeyId,
      keyName: usedKey?.name ?? usedKeyId.slice(0, 8),
      isFallback: usedKeyId !== mgmtKey.id,
    })
  }

  try {
    return await fn(client)
  } finally {
    client.end()
  }
}
