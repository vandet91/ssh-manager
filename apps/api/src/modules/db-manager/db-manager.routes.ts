import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { Pool } from 'pg'

const execAsync = promisify(exec)
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/lib/ssh-manager/backups'

// Raw pg pool for queries that bypass Kysely
function getRawPool() {
  return new Pool({ connectionString: process.env.DATABASE_URL })
}

export default async function dbManagerRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth)

  // ── Overview ────────────────────────────────────────────────────────────────

  fastify.get('/db-manager/overview', async (_req, reply) => {
    const pool = getRawPool()
    try {
      const [ver, size, conns, cache, txn, uptime] = await Promise.all([
        pool.query(`SELECT version()`),
        pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size, pg_database_size(current_database()) AS size_bytes`),
        pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE state='active') AS active, count(*) FILTER (WHERE state='idle') AS idle, count(*) FILTER (WHERE wait_event_type='Lock') AS waiting FROM pg_stat_activity WHERE datname = current_database()`),
        pool.query(`SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit)+sum(blks_read),0), 2) AS cache_hit_ratio FROM pg_stat_database WHERE datname = current_database()`),
        pool.query(`SELECT xact_commit + xact_rollback AS total_txn, xact_commit AS commits, xact_rollback AS rollbacks FROM pg_stat_database WHERE datname = current_database()`),
        pool.query(`SELECT date_trunc('second', now() - pg_postmaster_start_time())::text AS uptime, pg_postmaster_start_time() AS started_at`),
      ])
      return {
        version: ver.rows[0].version,
        size: size.rows[0].size,
        size_bytes: parseInt(size.rows[0].size_bytes),
        connections: conns.rows[0],
        cache_hit_ratio: cache.rows[0].cache_hit_ratio,
        transactions: txn.rows[0],
        uptime: uptime.rows[0].uptime,
        started_at: uptime.rows[0].started_at,
      }
    } finally {
      await pool.end()
    }
  })

  // ── Tables ──────────────────────────────────────────────────────────────────

  fastify.get('/db-manager/tables', async (_req, reply) => {
    const pool = getRawPool()
    try {
      const { rows } = await pool.query(`
        SELECT
          t.schemaname,
          t.tablename,
          t.tableowner,
          pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
          pg_total_relation_size(c.oid) AS total_size_bytes,
          pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
          pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
          s.n_live_tup AS row_count,
          s.n_dead_tup AS dead_rows,
          s.last_vacuum,
          s.last_autovacuum,
          s.last_analyze,
          s.last_autoanalyze
        FROM pg_tables t
        JOIN pg_class c ON c.relname = t.tablename
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
        LEFT JOIN pg_stat_user_tables s ON s.relname = t.tablename AND s.schemaname = t.schemaname
        WHERE t.schemaname NOT IN ('pg_catalog','information_schema')
        ORDER BY pg_total_relation_size(c.oid) DESC
      `)
      return rows
    } finally {
      await pool.end()
    }
  })

  // ── Indexes ─────────────────────────────────────────────────────────────────

  fastify.get('/db-manager/indexes', async (_req, reply) => {
    const pool = getRawPool()
    try {
      const { rows } = await pool.query(`
        SELECT
          schemaname,
          tablename,
          indexname,
          pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
          pg_relation_size(indexrelid) AS size_bytes,
          idx_scan AS scans,
          idx_tup_read AS tuples_read,
          idx_tup_fetch AS tuples_fetched,
          indexdef
        FROM pg_stat_user_indexes
        JOIN pg_indexes USING (schemaname, tablename, indexname)
        ORDER BY pg_relation_size(indexrelid) DESC
      `)
      return rows
    } finally {
      await pool.end()
    }
  })

  // ── Connections ──────────────────────────────────────────────────────────────

  fastify.get('/db-manager/connections', async (_req, reply) => {
    const pool = getRawPool()
    try {
      const { rows } = await pool.query(`
        SELECT
          pid,
          usename,
          application_name,
          client_addr,
          state,
          wait_event_type,
          wait_event,
          query_start,
          state_change,
          date_trunc('second', now() - query_start)::text AS query_duration,
          left(query, 200) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY query_start DESC NULLS LAST
      `)
      return rows
    } finally {
      await pool.end()
    }
  })

  fastify.delete('/db-manager/connections/:pid', async (req, reply) => {
    const { pid } = z.object({ pid: z.coerce.number().int() }).parse(req.params)
    const pool = getRawPool()
    try {
      const { rows } = await pool.query(`SELECT pg_terminate_backend($1) AS terminated`, [pid])
      return { terminated: rows[0].terminated }
    } finally {
      await pool.end()
    }
  })

  // ── Slow queries ─────────────────────────────────────────────────────────────

  fastify.get('/db-manager/slow-queries', async (_req, reply) => {
    const pool = getRawPool()
    try {
      // Check if pg_stat_statements is available
      const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'`)
      if (!ext.rows.length) {
        return reply.code(404).send({ error: 'pg_stat_statements extension not enabled' })
      }
      const { rows } = await pool.query(`
        SELECT
          queryid,
          left(query, 300) AS query,
          calls,
          round((total_exec_time / calls)::numeric, 2) AS avg_ms,
          round(total_exec_time::numeric, 2) AS total_ms,
          round(min_exec_time::numeric, 2) AS min_ms,
          round(max_exec_time::numeric, 2) AS max_ms,
          rows
        FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY avg_ms DESC
        LIMIT 50
      `)
      return rows
    } finally {
      await pool.end()
    }
  })

  fastify.post('/db-manager/slow-queries/reset', async (_req, reply) => {
    const pool = getRawPool()
    try {
      await pool.query(`SELECT pg_stat_statements_reset()`)
      return { ok: true }
    } finally {
      await pool.end()
    }
  })

  // Enable pg_stat_statements
  fastify.post('/db-manager/slow-queries/enable', async (_req, reply) => {
    const pool = getRawPool()
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`)
      return { ok: true }
    } finally {
      await pool.end()
    }
  })

  // ── Maintenance ──────────────────────────────────────────────────────────────

  fastify.post('/db-manager/maintenance', async (req, reply) => {
    const body = z.object({
      operation: z.enum(['vacuum', 'vacuum_analyze', 'vacuum_full', 'analyze', 'reindex']),
      table: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).optional(),
    }).parse(req.body)

    const pool = getRawPool()
    try {
      const tbl = body.table ? ` "${body.table}"` : ''
      const sql: Record<string, string> = {
        vacuum:         `VACUUM${tbl}`,
        vacuum_analyze: `VACUUM ANALYZE${tbl}`,
        vacuum_full:    `VACUUM FULL${tbl}`,
        analyze:        `ANALYZE${tbl}`,
        reindex:        body.table ? `REINDEX TABLE "${body.table}"` : `REINDEX DATABASE CONCURRENTLY "${(await pool.query('SELECT current_database() AS db')).rows[0].db}"`,
      }
      const start = Date.now()
      await pool.query(sql[body.operation])
      return { ok: true, duration_ms: Date.now() - start }
    } finally {
      await pool.end()
    }
  })

  // ── Query runner ─────────────────────────────────────────────────────────────

  fastify.post('/db-manager/query', async (req, reply) => {
    const body = z.object({ sql: z.string().min(1).max(50000) }).parse(req.body)
    const pool = getRawPool()
    try {
      const start = Date.now()
      const result = await pool.query(body.sql)
      return {
        rows: result.rows,
        fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })) ?? [],
        row_count: result.rowCount,
        duration_ms: Date.now() - start,
        command: result.command,
      }
    } catch (err: any) {
      return reply.code(400).send({ error: err.message })
    } finally {
      await pool.end()
    }
  })

  // ── Backups ──────────────────────────────────────────────────────────────────

  fastify.get('/db-manager/backups', async (_req, reply) => {
    const rows = await (db as any).selectFrom('db_backups').selectAll().orderBy('created_at', 'desc').limit(50).execute()
    return rows
  })

  fastify.post('/db-manager/backups', async (req, reply) => {
    const userId = (req.session.user as any)!.id
    const now = new Date()
    const filename = `backup_${now.toISOString().replace(/[:.]/g, '-')}.sql.gz`
    const filepath = path.join(BACKUP_DIR, filename)

    const row = await (db as any).insertInto('db_backups').values({
      filename,
      status: 'running',
      started_at: now,
      created_by: userId,
    }).returningAll().executeTakeFirst()

    // Run pg_dump in background
    ;(async () => {
      try {
        await fs.promises.mkdir(BACKUP_DIR, { recursive: true })
        const dbUrl = new URL(process.env.DATABASE_URL!)
        const env = {
          ...process.env,
          PGPASSWORD: dbUrl.password,
        }
        await execAsync(
          `pg_dump -h ${dbUrl.hostname} -p ${dbUrl.port || 5432} -U ${dbUrl.username} -d ${dbUrl.pathname.slice(1)} -F p | gzip > "${filepath}"`,
          { env }
        )
        const stat = await fs.promises.stat(filepath)
        await (db as any).updateTable('db_backups').set({
          status: 'completed',
          size_bytes: stat.size,
          completed_at: new Date(),
        }).where('id', '=', row.id).execute()
      } catch (err: any) {
        await (db as any).updateTable('db_backups').set({
          status: 'failed',
          error: err.message?.slice(0, 500) ?? 'Unknown error',
          completed_at: new Date(),
        }).where('id', '=', row.id).execute()
      }
    })()

    return reply.code(202).send(row)
  })

  fastify.get('/db-manager/backups/:id/download', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const backup = await (db as any).selectFrom('db_backups').selectAll().where('id', '=', id).executeTakeFirst()
    if (!backup || backup.status !== 'completed') return reply.code(404).send({ error: 'Backup not found or not ready' })

    const filepath = path.join(BACKUP_DIR, backup.filename)
    try {
      const stream = fs.createReadStream(filepath)
      reply.header('Content-Disposition', `attachment; filename="${backup.filename}"`)
      reply.header('Content-Type', 'application/gzip')
      return reply.send(stream)
    } catch {
      return reply.code(404).send({ error: 'Backup file not found on disk' })
    }
  })

  fastify.delete('/db-manager/backups/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const backup = await (db as any).selectFrom('db_backups').selectAll().where('id', '=', id).executeTakeFirst()
    if (!backup) return reply.code(404).send({ error: 'Not found' })

    const filepath = path.join(BACKUP_DIR, backup.filename)
    await fs.promises.unlink(filepath).catch(() => {})
    await (db as any).deleteFrom('db_backups').where('id', '=', id).execute()
    return reply.code(204).send()
  })
}
