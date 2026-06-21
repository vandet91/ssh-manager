import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'

const ProfileBody = z.object({
  name:         z.string().min(1).max(255),
  description:  z.string().max(1000).optional().nullable(),
  version:      z.enum(['v1', 'v2c', 'v3']).default('v2c'),
  community:    z.string().optional().nullable(),   // plaintext on write
  port:         z.number().int().min(1).max(65535).default(161),
  v3_user:      z.string().optional().nullable(),
  v3_auth_proto: z.enum(['MD5', 'SHA']).optional().nullable(),
  v3_auth_key:  z.string().optional().nullable(),  // plaintext on write
  v3_priv_proto: z.enum(['DES', 'AES']).optional().nullable(),
  v3_priv_key:  z.string().optional().nullable(),  // plaintext on write
})

function maybeEncrypt(value: string | undefined | null, key: Buffer): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return encryptSecret(value, key)
}

export default async function snmpProfileRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /snmp-profiles
  fastify.get('/snmp-profiles', { preHandler: requirePermission('servers:read') }, async () => {
    const rows = await db.selectFrom('snmp_profiles')
      .selectAll()
      .orderBy('name', 'asc')
      .execute()

    const vaultKey = getVaultKey()
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      version: r.version,
      community: r.community_enc ? decryptSecret(r.community_enc, vaultKey) : '',
      port: r.port,
      v3_user: r.v3_user,
      v3_auth_proto: r.v3_auth_proto,
      v3_auth_key: r.v3_auth_key_enc ? decryptSecret(r.v3_auth_key_enc, vaultKey) : '',
      v3_priv_proto: r.v3_priv_proto,
      v3_priv_key: r.v3_priv_key_enc ? decryptSecret(r.v3_priv_key_enc, vaultKey) : '',
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))
  })

  // POST /snmp-profiles
  fastify.post('/snmp-profiles', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const body = ProfileBody.parse(req.body)
    const vaultKey = getVaultKey()
    const userId = (req.session.user as any)?.id ?? null

    const [row] = await db.insertInto('snmp_profiles').values({
      name:           body.name,
      description:    body.description ?? null,
      version:        body.version,
      community_enc:  maybeEncrypt(body.community, vaultKey) ?? null,
      port:           body.port,
      v3_user:        body.v3_user ?? null,
      v3_auth_proto:  body.v3_auth_proto ?? null,
      v3_auth_key_enc: maybeEncrypt(body.v3_auth_key, vaultKey) ?? null,
      v3_priv_proto:  body.v3_priv_proto ?? null,
      v3_priv_key_enc: maybeEncrypt(body.v3_priv_key, vaultKey) ?? null,
      created_by:     userId,
    }).returningAll().execute()

    await writeAuditLog({ userId, userEmail: (req.session.user as any)?.email, action: 'snmp_profile.created', resource: 'snmp_profile', resourceId: row.id, request: req })

    reply.code(201).send({ id: row.id })
  })

  // PUT /snmp-profiles/:id
  fastify.put('/snmp-profiles/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = ProfileBody.parse(req.body)
    const vaultKey = getVaultKey()

    const existing = await db.selectFrom('snmp_profiles').select(['id']).where('id', '=', id).executeTakeFirst()
    if (!existing) return reply.code(404).send({ error: 'Profile not found' })

    await db.updateTable('snmp_profiles').set({
      name:           body.name,
      description:    body.description ?? null,
      version:        body.version,
      community_enc:  maybeEncrypt(body.community, vaultKey) ?? null,
      port:           body.port,
      v3_user:        body.v3_user ?? null,
      v3_auth_proto:  body.v3_auth_proto ?? null,
      v3_auth_key_enc: maybeEncrypt(body.v3_auth_key, vaultKey) ?? null,
      v3_priv_proto:  body.v3_priv_proto ?? null,
      v3_priv_key_enc: maybeEncrypt(body.v3_priv_key, vaultKey) ?? null,
      updated_at: new Date(),
    }).where('id', '=', id).execute()

    await writeAuditLog({ userId: (req.session.user as any)?.id, userEmail: (req.session.user as any)?.email, action: 'snmp_profile.updated', resource: 'snmp_profile', resourceId: id, request: req })

    reply.code(204).send()
  })

  // DELETE /snmp-profiles/:id
  fastify.delete('/snmp-profiles/:id', { preHandler: requirePermission('servers:admin') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    // Unlink any servers using this profile first
    await db.updateTable('servers').set({ snmp_profile_id: null }).where('snmp_profile_id', '=', id).execute()
    await db.deleteFrom('snmp_profiles').where('id', '=', id).execute()

    await writeAuditLog({ userId: (req.session.user as any)?.id, userEmail: (req.session.user as any)?.email, action: 'snmp_profile.deleted', resource: 'snmp_profile', resourceId: id, request: req })

    reply.code(204).send()
  })
}
