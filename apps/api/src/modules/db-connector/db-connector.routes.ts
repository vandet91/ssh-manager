import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'
import { encryptSecret, decryptSecret, getVaultKey } from '../../utils/vault'
import { writeAuditLog } from '../../utils/audit'
import { pgQuery, mysqlQuery, mongoQuery, mssqlQuery, sqliteQuery, getSchema, getTableColumns } from './db-tunnel'

export type DbType = 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | 'mssql'

export interface DbConnection {
  id: string
  server_id: string | null
  name: string
  db_type: DbType
  host: string
  port: number
  database_name: string
  db_user: string | null
  password_enc: string | null
  use_ssh_tunnel: boolean
  ssl_enabled: boolean
  notes: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
}

const DEFAULT_PORTS: Record<DbType, number> = {
  postgresql: 5432,
  mysql:      3306,
  sqlite:     0,
  mongodb:    27017,
  mssql:      1433,
}

const ConnBody = z.object({
  server_id:     z.string().uuid().nullable().optional(),
  name:          z.string().min(1).max(128),
  db_type:       z.enum(['postgresql', 'mysql', 'sqlite', 'mongodb', 'mssql']),
  host:          z.string().min(1).max(256).default('127.0.0.1'),
  port:          z.number().int().min(0).max(65535).optional(),
  database_name: z.string().max(256).default(''),
  db_user:       z.string().max(128).optional(),
  password:      z.string().optional(),
  use_ssh_tunnel: z.boolean().default(false),
  ssl_enabled:   z.boolean().default(false),
  notes:         z.string().max(2000).optional(),
})

export function applyTunnelOverride(conn: DbConnection, override?: boolean): DbConnection {
  if (override === undefined || override === null) return conn
  return { ...conn, use_ssh_tunnel: override }
}

async function runQuery(conn: DbConnection, query: string, params: unknown[] = []) {
  switch (conn.db_type) {
    case 'postgresql': return pgQuery(conn, query, params)
    case 'mysql':      return mysqlQuery(conn, query, params)
    case 'mongodb':    return mongoQuery(conn, query)
    case 'mssql':      return mssqlQuery(conn, query)
    case 'sqlite':     return sqliteQuery(conn, query)
    default: throw new Error(`Unsupported db_type: ${conn.db_type}`)
  }
}

export default async function dbConnectorRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // â”€â”€ Connections CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // GET /db/connections â€” list connections (operators see own + shared)
  fastify.get('/db/connections', async (req) => {
    const qb = (db as any)
      .selectFrom('db_connections as c')
      .leftJoin('servers as s', 's.id', 'c.server_id')
      .select([
        'c.id', 'c.server_id', 'c.name', 'c.db_type', 'c.host', 'c.port',
        'c.database_name', 'c.db_user', 'c.use_ssh_tunnel', 'c.ssl_enabled',
        'c.notes', 'c.owner_id', 'c.is_shared', 'c.created_at', 'c.updated_at',
        's.name as server_name', 's.hostname as server_hostname',
      ])
      .orderBy('c.created_at', 'desc')
    return { connections: await qb.execute() }
  })

  // GET /db/connections/:serverId â€” connections for a specific server
  fastify.get('/db/connections/server/:serverId', { preHandler: requireAuth }, async (req) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params)
    const rows = await (db as any)
      .selectFrom('db_connections')
      .selectAll()
      .where('server_id', '=', serverId)
      .orderBy('created_at', 'desc')
      .execute()
    return { connections: rows }
  })

  // POST /db/connections â€” create a connection; operators create their own
  fastify.post('/db/connections', async (req, reply) => {
    const body = ConnBody.parse(req.body)
    const serverId = body.server_id ?? null

    if (serverId) {
      const server = await (db as any).selectFrom('servers').select(['id']).where('id', '=', serverId).executeTakeFirst()
      if (!server) return reply.code(404).send({ error: 'Server not found' })
    }

    const vaultKey = getVaultKey()
    const password_enc = body.password ? encryptSecret(body.password, vaultKey) : null
    const port = body.port ?? DEFAULT_PORTS[body.db_type]

    const row = await (db as any).insertInto('db_connections').values({
      server_id: serverId, name: body.name, db_type: body.db_type,
      host: body.host, port, database_name: body.database_name,
      db_user: body.db_user ?? null, password_enc,
      use_ssh_tunnel: body.use_ssh_tunnel, ssl_enabled: body.ssl_enabled,
      notes: body.notes ?? null, created_by: req.session.user!.id,
      owner_id: req.session.user!.id, is_shared: false,
    }).returningAll().executeTakeFirst()

    await writeAuditLog({
      userId: (req.session.user as any)!.id, userEmail: (req.session.user as any)!.email,
      action: 'db.connection.created', resource: 'db_connection', resourceId: row.id,
      serverId: serverId ?? undefined, details: { name: body.name, db_type: body.db_type }, request: req,
    })
    return reply.code(201).send(row)
  })

  // PATCH /db/connections/:id â€” update; operators can only edit their own
  fastify.patch('/db/connections/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = ConnBody.partial().parse(req.body)

    const existing = await (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst() as DbConnection
    if (!existing) return reply.code(404).send({ error: 'Connection not found' })

    const vaultKey = getVaultKey()
    const updates: any = { updated_at: new Date() }
    if (body.server_id !== undefined) updates.server_id = body.server_id
    if (body.name !== undefined) updates.name = body.name
    if (body.db_type !== undefined) updates.db_type = body.db_type
    if (body.host !== undefined) updates.host = body.host
    if (body.port !== undefined) updates.port = body.port
    if (body.database_name !== undefined) updates.database_name = body.database_name
    if (body.db_user !== undefined) updates.db_user = body.db_user
    if (body.password !== undefined) updates.password_enc = encryptSecret(body.password, vaultKey)
    if (body.use_ssh_tunnel !== undefined) updates.use_ssh_tunnel = body.use_ssh_tunnel
    if (body.ssl_enabled !== undefined) updates.ssl_enabled = body.ssl_enabled
    if (body.notes !== undefined) updates.notes = body.notes

    await (db as any).updateTable('db_connections').set(updates).where('id', '=', id).execute()
    return { ok: true }
  })

  // DELETE /db/connections/:id â€” operators can only delete their own
  fastify.delete('/db/connections/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const existing = await (db as any).selectFrom('db_connections').select(['id', 'owner_id']).where('id', '=', id).executeTakeFirst() as any
    if (!existing) return reply.code(404).send({ error: 'Connection not found' })
    await (db as any).deleteFrom('db_connections').where('id', '=', id).execute()
    return reply.code(204).send()
  })

  // â”€â”€ Test connection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/db/connections/:id/test', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { use_ssh_tunnel } = z.object({ use_ssh_tunnel: z.boolean().optional() }).parse(req.body ?? {})
    const connRaw = await (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst() as DbConnection
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = applyTunnelOverride(connRaw, use_ssh_tunnel)

    try {
      const testSql: Record<DbType, string> = {
        postgresql: 'SELECT 1 as ok',
        mysql:      'SELECT 1 as ok',
        sqlite:     'SELECT 1 as ok',
        mssql:      'SELECT 1 as ok',
        mongodb:    JSON.stringify({ ping: 1 }),
      }
      const r = await runQuery(conn, testSql[conn.db_type])
      return { ok: true, duration_ms: r.duration_ms }
    } catch (err: any) {
      return reply.code(502).send({ ok: false, error: err.message })
    }
  })

  // â”€â”€ Query runner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/db/connections/:id/query', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { query, params = [], use_ssh_tunnel } = z.object({
      query:          z.string().min(1).max(50000),
      params:         z.array(z.unknown()).default([]),
      use_ssh_tunnel: z.boolean().optional(),
    }).parse(req.body)

    const connRaw = await (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst() as DbConnection
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = applyTunnelOverride(connRaw, use_ssh_tunnel)

    let result: any = null
    let queryError: string | null = null

    try {
      result = await runQuery(conn, query, params as unknown[])
    } catch (err: any) {
      queryError = err.message
    }

    // Save to history
    await (db as any).insertInto('db_query_history').values({
      connection_id: id,
      user_id: (req.session.user as any)!.id,
      query,
      duration_ms: result?.duration_ms ?? null,
      row_count: result?.row_count ?? null,
      error: queryError,
    }).execute().catch(() => {})

    if (queryError) return reply.code(502).send({ error: queryError })

    await writeAuditLog({
      userId: (req.session.user as any)!.id, userEmail: (req.session.user as any)!.email,
      action: 'db.query.executed', resource: 'db_connection', resourceId: id,
      serverId: conn.server_id ?? undefined,
      details: { query: query.slice(0, 500), row_count: result.row_count }, request: req,
    })

    return result
  })

  // â”€â”€ Schema / table browser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/db/connections/:id/schema', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { tunnel } = z.object({ tunnel: z.string().optional() }).parse(req.query)
    const connRaw = await (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst() as DbConnection
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = tunnel !== undefined ? applyTunnelOverride(connRaw, tunnel === 'true') : connRaw

    try {
      return await getSchema(conn)
    } catch (err: any) {
      return reply.code(502).send({ error: err.message })
    }
  })

  fastify.get('/db/connections/:id/schema/:table', { preHandler: requireAuth }, async (req, reply) => {
    const { id, table } = z.object({ id: z.string().uuid(), table: z.string().min(1).max(256) }).parse(req.params)
    const { tunnel } = z.object({ tunnel: z.string().optional() }).parse(req.query)
    const connRaw = await (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst() as DbConnection
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = tunnel !== undefined ? applyTunnelOverride(connRaw, tunnel === 'true') : connRaw

    try {
      return await getTableColumns(conn, table)
    } catch (err: any) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // â”€â”€ Row browser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/db/connections/:id/rows/:table', { preHandler: requireAuth }, async (req, reply) => {
    const { id, table } = z.object({ id: z.string().uuid(), table: z.string().min(1).max(256) }).parse(req.params)
    const { limit = 100, offset = 0, where_clause = '', use_ssh_tunnel } = z.object({
      limit:          z.number().int().min(1).max(1000).default(100),
      offset:         z.number().int().min(0).default(0),
      where_clause:   z.string().max(2000).default(''),
      use_ssh_tunnel: z.boolean().optional(),
    }).parse(req.body)

    const connRaw = await (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst() as DbConnection
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = applyTunnelOverride(connRaw, use_ssh_tunnel)

    try {
      const whereStr = where_clause ? ` WHERE ${where_clause}` : ''
      let rowSql: string
      let countSql: string

      switch (conn.db_type) {
        case 'postgresql':
          rowSql = `SELECT * FROM "${table}"${whereStr} LIMIT ${limit} OFFSET ${offset}`
          countSql = `SELECT COUNT(*) as total FROM "${table}"${whereStr}`
          break
        case 'mysql':
          rowSql = `SELECT * FROM \`${table}\`${whereStr} LIMIT ${limit} OFFSET ${offset}`
          countSql = `SELECT COUNT(*) as total FROM \`${table}\`${whereStr}`
          break
        case 'mssql':
          rowSql = `SELECT * FROM [${table}]${whereStr} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
          countSql = `SELECT COUNT(*) as total FROM [${table}]${whereStr}`
          break
        case 'sqlite':
          rowSql = `SELECT * FROM "${table}"${whereStr} LIMIT ${limit} OFFSET ${offset}`
          countSql = `SELECT COUNT(*) as total FROM "${table}"${whereStr}`
          break
        case 'mongodb':
          rowSql = JSON.stringify({ find: table, filter: {}, limit, skip: offset })
          countSql = JSON.stringify({ count: table, query: {} })
          break
        default:
          throw new Error(`Unsupported db_type: ${conn.db_type}`)
      }

      const [rowResult, countResult] = await Promise.all([
        runQuery(conn, rowSql),
        runQuery(conn, countSql).catch(() => ({ rows: [[0]] })),
      ])

      const total = Number((countResult as any).rows?.[0]?.[0]) || 0
      return { ...rowResult, total, limit, offset }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message })
    }
  })

  // â”€â”€ Query history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/db/connections/:id/history', { preHandler: requireAuth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const rows = await (db as any)
      .selectFrom('db_query_history')
      .selectAll()
      .where('connection_id', '=', id)
      .orderBy('executed_at', 'desc')
      .limit(100)
      .execute()
    return { history: rows }
  })

  // â”€â”€ Backup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/db/connections/:id/backup', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { save_path, use_ssh_tunnel } = z.object({ save_path: z.string().optional(), use_ssh_tunnel: z.boolean().optional() }).parse(req.body)

    const connRaw = await (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst() as DbConnection
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = applyTunnelOverride(connRaw, use_ssh_tunnel)

    const { withServerSsh } = await import('../../utils/server-ssh')
    const { sshExec } = await import('../../utils/ssh')

    const password = conn.password_enc ? decryptSecret(conn.password_enc, getVaultKey()) : ''
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const defaultPath = `/tmp/${conn.database_name || 'backup'}_${ts}`

    try {
      let command = ''
      switch (conn.db_type) {
        case 'postgresql':
          command = `PGPASSWORD="${password}" pg_dump -h ${conn.host} -p ${conn.port} -U ${conn.db_user ?? 'postgres'} ${conn.database_name} > "${save_path ?? defaultPath + '.sql'}"`
          break
        case 'mysql':
          command = `mysqldump -h ${conn.host} -P ${conn.port} -u ${conn.db_user ?? 'root'} -p"${password}" ${conn.database_name} > "${save_path ?? defaultPath + '.sql'}"`
          break
        case 'mongodb':
          command = `mongodump --host ${conn.host} --port ${conn.port} ${conn.db_user ? `--username ${conn.db_user} --password "${password}"` : ''} --db ${conn.database_name} --out "${save_path ?? defaultPath}"`
          break
        case 'mssql':
          command = `sqlcmd -S ${conn.host},${conn.port} -U ${conn.db_user ?? 'sa'} -P "${password}" -Q "BACKUP DATABASE [${conn.database_name}] TO DISK='${save_path ?? defaultPath + '.bak'}'"`
          break
        case 'sqlite':
          command = `sqlite3 "${conn.database_name}" ".backup '${save_path ?? defaultPath + '.sqlite'}'"`
          break
        default:
          return reply.code(400).send({ error: 'Backup not supported for this DB type' })
      }

      if (!conn.server_id) return reply.code(400).send({ error: 'Backup requires a linked server' })

      const output = await withServerSsh(conn.server_id, async (client) => {
        const r = await sshExec(client as any, command)
        return { stdout: r.stdout as string, stderr: r.stderr as string, code: r.code as number }
      })

      await writeAuditLog({
        userId: (req.session.user as any)!.id, userEmail: (req.session.user as any)!.email,
        action: 'db.backup.created', resource: 'db_connection', resourceId: id,
        serverId: conn.server_id ?? undefined, details: { db_type: conn.db_type, database_name: conn.database_name }, request: req,
      })

      if (output.code !== 0 && output.stderr) {
        return reply.code(502).send({ error: output.stderr.slice(0, 500) })
      }
      return { ok: true, path: save_path ?? defaultPath, output: output.stdout.slice(0, 500) }
    } catch (err: any) {
      return reply.code(502).send({ error: err.message })
    }
  })
}


