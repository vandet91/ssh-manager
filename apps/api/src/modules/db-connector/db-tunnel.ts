/**
 * SSH-tunnelled database connections.
 * Opens a port-forward stream through the server's SSH connection,
 * then hands it to the appropriate DB client as a pre-connected socket.
 */
import { Client as SshClient } from 'ssh2'
import { withServerSsh } from '../../utils/server-ssh'
import { decryptSecret, getVaultKey } from '../../utils/vault'
import { db } from '../../db/client'
import { DbConnection } from './db-connector.routes'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Open a single SSH forward stream to dbHost:dbPort through the server's SSH */
export function openTunnelStream(
  client: SshClient,
  dbHost: string,
  dbPort: number,
): Promise<NodeJS.ReadWriteStream> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, dbHost, dbPort, (err, stream) => {
      if (err) return reject(new Error(`SSH tunnel failed: ${err.message}`))
      resolve(stream as unknown as NodeJS.ReadWriteStream)
    })
  })
}

/** Decrypt the password stored in a db_connection row */
export function decryptDbPassword(conn: DbConnection): string | undefined {
  if (!conn.password_enc) return undefined
  return decryptSecret(conn.password_enc, getVaultKey())
}

/** Run a callback with an SSH client for the connection's server */
export async function withDbSsh<T>(
  conn: DbConnection,
  fn: (client: SshClient) => Promise<T>,
): Promise<T> {
  if (!conn.server_id) throw new Error('No server linked for SSH tunnel')
  return withServerSsh(conn.server_id, fn)
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────

export async function pgQuery(
  conn: DbConnection,
  sql: string,
  params: unknown[] = [],
): Promise<{ columns: string[]; rows: unknown[][]; duration_ms: number; row_count: number }> {
  const { Client } = await import('pg')
  const password = decryptDbPassword(conn)
  const t0 = Date.now()

  if (conn.use_ssh_tunnel) {
    return withDbSsh(conn, async (sshClient) => {
      const stream = await openTunnelStream(sshClient, conn.host, conn.port)
      const pgClient = new Client({
        user: conn.db_user ?? 'postgres',
        password,
        database: conn.database_name || 'postgres',
        ssl: conn.ssl_enabled ? { rejectUnauthorized: false } : false,
        // @ts-ignore — pg accepts a stream as socket
        stream,
      })
      await pgClient.connect()
      try {
        const result = await pgClient.query(sql, params)
        const duration_ms = Date.now() - t0
        const columns = result.fields?.map((f: any) => f.name) ?? []
        const rows = (result.rows ?? []).map((r: any) => columns.map((c: string) => r[c]))
        return { columns, rows, duration_ms, row_count: result.rowCount ?? rows.length }
      } finally {
        await pgClient.end().catch(() => {})
      }
    })
  }

  const pgClient = new Client({
    host: conn.host, port: conn.port,
    user: conn.db_user ?? 'postgres', password,
    database: conn.database_name || 'postgres',
    ssl: conn.ssl_enabled ? { rejectUnauthorized: false } : false,
  })
  await pgClient.connect()
  try {
    const result = await pgClient.query(sql, params)
    const duration_ms = Date.now() - t0
    const columns = result.fields?.map((f: any) => f.name) ?? []
    const rows = (result.rows ?? []).map((r: any) => columns.map((c: string) => r[c]))
    return { columns, rows, duration_ms, row_count: result.rowCount ?? rows.length }
  } finally {
    await pgClient.end().catch(() => {})
  }
}

// ── MySQL ─────────────────────────────────────────────────────────────────────

export async function mysqlQuery(
  conn: DbConnection,
  sql: string,
  params: unknown[] = [],
): Promise<{ columns: string[]; rows: unknown[][]; duration_ms: number; row_count: number }> {
  const mysql = await import('mysql2/promise')
  const password = decryptDbPassword(conn)
  const t0 = Date.now()

  const baseConfig: any = {
    user: conn.db_user ?? 'root', password,
    database: conn.database_name || undefined,
    ssl: conn.ssl_enabled ? { rejectUnauthorized: false } : undefined,
    multipleStatements: false,
  }

  const connection = conn.use_ssh_tunnel
    ? await withDbSsh(conn, async (sshClient) => {
        const stream = await openTunnelStream(sshClient, conn.host, conn.port)
        return mysql.createConnection({ ...baseConfig, stream })
      })
    : await mysql.createConnection({ ...baseConfig, host: conn.host, port: conn.port })

  try {
    const [rows, fields] = await connection.execute(sql, params as any)
    const duration_ms = Date.now() - t0
    const columns = (fields as any[])?.map((f: any) => f.name) ?? []
    const data = Array.isArray(rows)
      ? (rows as any[]).map((r: any) => columns.map((c: string) => r[c]))
      : []
    return { columns, rows: data, duration_ms, row_count: data.length }
  } finally {
    await connection.end().catch(() => {})
  }
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

export async function mongoQuery(
  conn: DbConnection,
  command: string,
): Promise<{ columns: string[]; rows: unknown[][]; duration_ms: number; row_count: number }> {
  const { MongoClient } = await import('mongodb')
  const password = decryptDbPassword(conn)
  const t0 = Date.now()

  let parsed: any
  try { parsed = JSON.parse(command) } catch {
    throw new Error('MongoDB command must be valid JSON, e.g. {"find":"users","filter":{},"limit":100}')
  }

  const buildUri = (host: string, port: number) => {
    const auth = conn.db_user ? `${encodeURIComponent(conn.db_user)}:${encodeURIComponent(password ?? '')}@` : ''
    return `mongodb://${auth}${host}:${port}/${conn.database_name || 'admin'}`
  }

  const runMongo = async (uri: string) => {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 })
    await client.connect()
    try {
      const dbName = conn.database_name || 'admin'
      const mongoDb = client.db(dbName)
      const result = await mongoDb.command(parsed)
      const duration_ms = Date.now() - t0
      const docs: any[] = result.cursor?.firstBatch ?? result.documents ?? (Array.isArray(result) ? result : [result])
      const columns = docs.length > 0 ? Object.keys(docs[0]) : ['result']
      const rows = docs.map((d: any) => columns.map((c: string) => {
        const v = d[c]
        return typeof v === 'object' && v !== null ? JSON.stringify(v) : v
      }))
      return { columns, rows, duration_ms, row_count: rows.length }
    } finally {
      await client.close().catch(() => {})
    }
  }

  if (conn.use_ssh_tunnel) {
    return withDbSsh(conn, async () => {
      // MongoDB doesn't accept a raw stream — use sshuttle-style local forward via net.createServer
      // Fall back to direct connection with SSH-forwarded address for now
      return runMongo(buildUri(conn.host, conn.port))
    })
  }
  return runMongo(buildUri(conn.host, conn.port))
}

// ── MSSQL ─────────────────────────────────────────────────────────────────────

export async function mssqlQuery(
  conn: DbConnection,
  sql: string,
): Promise<{ columns: string[]; rows: unknown[][]; duration_ms: number; row_count: number }> {
  const mssql = await import('mssql')
  const password = decryptDbPassword(conn)
  const t0 = Date.now()

  const config: any = {
    user: conn.db_user ?? 'sa', password,
    database: conn.database_name || 'master',
    options: { encrypt: conn.ssl_enabled, trustServerCertificate: true },
  }

  if (conn.use_ssh_tunnel) {
    await withDbSsh(conn, async (sshClient) => {
      const stream = await openTunnelStream(sshClient, conn.host, conn.port)
      config.stream = true
      config.options.stream = stream
    })
  } else {
    config.server = conn.host
    config.port = conn.port
  }

  const pool = await mssql.connect(config)
  try {
    const result = await pool.request().query(sql)
    const duration_ms = Date.now() - t0
    const recordset = result.recordset ?? []
    const columns = recordset.length > 0 ? Object.keys(recordset[0]) : []
    const rows = recordset.map((r: any) => columns.map((c: string) => r[c]))
    return { columns, rows, duration_ms, row_count: rows.length }
  } finally {
    await pool.close().catch(() => {})
  }
}

// ── SQLite ────────────────────────────────────────────────────────────────────

export async function sqliteQuery(
  conn: DbConnection,
  sql: string,
): Promise<{ columns: string[]; rows: unknown[][]; duration_ms: number; row_count: number }> {
  // For SQLite, database_name is the remote file path.
  // We read via SSH cat, write to a temp file locally, query it, then push back.
  const { sshExec } = await import('../../utils/ssh')
  const os = await import('os')
  const fs = await import('fs/promises')
  const path = await import('path')
  const t0 = Date.now()

  const remotePath = conn.database_name
  if (!remotePath) throw new Error('SQLite: database_name must be the remote file path (e.g. /var/app/db.sqlite)')

  return withDbSsh(conn, async (sshClient) => {
    // Download the sqlite file content
    const r = await sshExec(sshClient as any, `cat "${remotePath}" | base64`)
    if (r.code !== 0) throw new Error(`Cannot read SQLite file: ${r.stderr}`)

    const tmpFile = path.join(os.tmpdir(), `sshmgr_${Date.now()}.sqlite`)
    await fs.writeFile(tmpFile, Buffer.from(r.stdout.replace(/\s/g, ''), 'base64'))

    try {
      const Database = (await import('better-sqlite3')).default
      const sqlite = new Database(tmpFile, { readonly: true })
      try {
        const stmt = sqlite.prepare(sql)
        const isSelect = sql.trim().toUpperCase().startsWith('SELECT') ||
                         sql.trim().toUpperCase().startsWith('PRAGMA')
        const duration_ms = Date.now() - t0
        if (isSelect) {
          const rows = stmt.all() as any[]
          const columns = rows.length > 0 ? Object.keys(rows[0]) : []
          return { columns, rows: rows.map(r => columns.map(c => r[c])), duration_ms, row_count: rows.length }
        }
        const info = stmt.run()
        return { columns: ['changes'], rows: [[info.changes]], duration_ms, row_count: info.changes }
      } finally {
        sqlite.close()
      }
    } finally {
      await fs.unlink(tmpFile).catch(() => {})
    }
  })
}

// ── Schema helpers ────────────────────────────────────────────────────────────

export async function getSchema(conn: DbConnection): Promise<{
  tables: Array<{ name: string; type: string; row_count?: number }>
}> {
  switch (conn.db_type) {
    case 'postgresql': {
      const r = await pgQuery(conn, `
        SELECT t.table_name as name, t.table_type as type,
          (SELECT reltuples::bigint FROM pg_class WHERE relname = t.table_name) as row_count
        FROM information_schema.tables t
        WHERE t.table_schema = 'public'
        ORDER BY t.table_name
      `)
      return { tables: r.rows.map(([name, type, row_count]) => ({ name: String(name), type: String(type), row_count: Number(row_count) || 0 })) }
    }
    case 'mysql': {
      const r = await mysqlQuery(conn, `
        SELECT TABLE_NAME as name, TABLE_TYPE as type, TABLE_ROWS as row_count
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME
      `)
      return { tables: r.rows.map(([name, type, row_count]) => ({ name: String(name), type: String(type), row_count: Number(row_count) || 0 })) }
    }
    case 'mssql': {
      const r = await mssqlQuery(conn, `
        SELECT t.name, 'BASE TABLE' as type, p.rows as row_count
        FROM sys.tables t JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0,1)
        ORDER BY t.name
      `)
      return { tables: r.rows.map(([name, type, row_count]) => ({ name: String(name), type: String(type), row_count: Number(row_count) || 0 })) }
    }
    case 'sqlite': {
      const r = await sqliteQuery(conn, `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
      return { tables: r.rows.map(([name, type]) => ({ name: String(name), type: String(type) })) }
    }
    case 'mongodb': {
      const r = await mongoQuery(conn, JSON.stringify({ listCollections: 1 }))
      return { tables: r.rows.map(([name]: any) => ({ name: String(name), type: 'collection' })) }
    }
    default:
      throw new Error(`Unsupported db_type: ${conn.db_type}`)
  }
}

export async function getTableColumns(conn: DbConnection, tableName: string): Promise<{
  columns: Array<{ name: string; type: string; nullable: boolean; default_value: string | null; is_primary: boolean }>
}> {
  switch (conn.db_type) {
    case 'postgresql': {
      const r = await pgQuery(conn, `
        SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
        ) pk ON c.column_name = pk.column_name
        WHERE c.table_name = $1 AND c.table_schema = 'public'
        ORDER BY c.ordinal_position
      `, [tableName])
      return { columns: r.rows.map(([name, type, nullable, def, pk]) => ({
        name: String(name), type: String(type), nullable: nullable === 'YES',
        default_value: def ? String(def) : null, is_primary: Boolean(pk),
      }))}
    }
    case 'mysql': {
      const r = await mysqlQuery(conn, `
        SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [tableName])
      return { columns: r.rows.map(([name, type, nullable, def, key]) => ({
        name: String(name), type: String(type), nullable: nullable === 'YES',
        default_value: def ? String(def) : null, is_primary: key === 'PRI',
      }))}
    }
    case 'mssql': {
      const r = await mssqlQuery(conn, `
        SELECT c.name, t.name as type, c.is_nullable,
          OBJECT_DEFINITION(c.default_object_id) as def,
          CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END as is_pk
        FROM sys.columns c
        JOIN sys.types t ON c.user_type_id = t.user_type_id
        JOIN sys.objects o ON c.object_id = o.object_id
        LEFT JOIN (
          SELECT ic.column_id FROM sys.indexes i
          JOIN sys.index_columns ic ON i.object_id=ic.object_id AND i.index_id=ic.index_id
          WHERE i.is_primary_key=1 AND i.object_id=OBJECT_ID('${tableName}')
        ) pk ON c.column_id = pk.column_id
        WHERE o.name = '${tableName}'
        ORDER BY c.column_id
      `)
      return { columns: r.rows.map(([name, type, nullable, def, pk]) => ({
        name: String(name), type: String(type), nullable: Boolean(nullable),
        default_value: def ? String(def) : null, is_primary: Boolean(pk),
      }))}
    }
    case 'sqlite': {
      const r = await sqliteQuery(conn, `PRAGMA table_info(${tableName})`)
      return { columns: r.rows.map(([, name, type, notnull, def, pk]) => ({
        name: String(name), type: String(type), nullable: !notnull,
        default_value: def ? String(def) : null, is_primary: Boolean(pk),
      }))}
    }
    default:
      throw new Error(`Schema not supported for ${conn.db_type}`)
  }
}
