import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth, requirePermission } from '../../middleware/auth'
import { decryptSecret, getVaultKey } from '../../utils/vault'
import { pgQuery, mysqlQuery, mongoQuery, mssqlQuery, sqliteQuery } from './db-tunnel'
import { DbConnection, DbType, applyTunnelOverride } from './db-connector.routes'

// ── helpers ───────────────────────────────────────────────────────────────────

async function getConn(id: string): Promise<DbConnection | undefined> {
  return (db as any).selectFrom('db_connections').selectAll().where('id', '=', id).executeTakeFirst()
}

async function runSql(
  conn: DbConnection,
  sql: string,
  params: unknown[] = [],
): Promise<{ columns: string[]; rows: unknown[][]; duration_ms: number; row_count: number }> {
  switch (conn.db_type as DbType) {
    case 'postgresql': return pgQuery(conn, sql, params)
    case 'mysql':      return mysqlQuery(conn, sql, params)
    case 'mongodb':    return mongoQuery(conn, sql)
    case 'mssql':      return mssqlQuery(conn, sql)
    case 'sqlite':     return sqliteQuery(conn, sql)
    default: throw new Error(`Unsupported db_type: ${conn.db_type}`)
  }
}

// Build the SQL for a rule check
function buildCheckSql(dbType: DbType, ruleType: string, table: string, column?: string, params?: any) {
  const qt = (t: string) => {
    if (dbType === 'mysql') return `\`${t}\``
    if (dbType === 'mssql') return `[${t}]`
    return `"${t}"`
  }
  const qc = (c: string) => qt(c)

  switch (ruleType) {
    case 'row_count':
      return `SELECT COUNT(*) AS value FROM ${qt(table)}`

    case 'null_rate':
      if (!column) throw new Error('column required for null_rate')
      if (dbType === 'mssql')
        return `SELECT CAST(SUM(CASE WHEN ${qc(column)} IS NULL THEN 1 ELSE 0 END) AS FLOAT) / NULLIF(COUNT(*),0) * 100 AS value FROM ${qt(table)}`
      return `SELECT ROUND(SUM(CASE WHEN ${qc(column)} IS NULL THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0) * 100, 2) AS value FROM ${qt(table)}`

    case 'uniqueness':
      if (!column) throw new Error('column required for uniqueness')
      return `SELECT COUNT(*) - COUNT(DISTINCT ${qc(column)}) AS value FROM ${qt(table)}`

    case 'range':
      if (!column) throw new Error('column required for range')
      return `SELECT MIN(${qc(column)}) AS min_val, MAX(${qc(column)}) AS max_val FROM ${qt(table)}`

    case 'custom_sql':
      if (!params?.sql) throw new Error('sql required for custom_sql rule')
      return params.sql

    case 'referential':
      if (!params?.ref_table || !params?.ref_column || !column) throw new Error('column, ref_table, ref_column required')
      return `SELECT COUNT(*) AS value FROM ${qt(table)} WHERE ${qc(column)} IS NOT NULL AND ${qc(column)} NOT IN (SELECT ${qc(params.ref_column)} FROM ${qt(params.ref_table)})`

    default:
      throw new Error(`Unknown rule_type: ${ruleType}`)
  }
}

interface RuleRow {
  id: string
  connection_id: string
  name: string
  rule_type: string
  table_name: string
  column_name: string | null
  params: any
  is_active: boolean
  created_at: Date
}

async function evaluateRule(rule: RuleRow, conn: DbConnection): Promise<{
  status: 'pass' | 'fail' | 'error'
  actual: string
  expected: string
  details: any
}> {
  try {
    const sql = buildCheckSql(conn.db_type as DbType, rule.rule_type, rule.table_name, rule.column_name ?? undefined, rule.params)
    const result = await runSql(conn, sql)
    const row = result.rows[0] ?? []
    const params = rule.params ?? {}

    switch (rule.rule_type) {
      case 'row_count': {
        const count = Number(row[0])
        const min = params.min ?? 0
        const max = params.max ?? Infinity
        const pass = count >= min && (params.max === undefined || count <= max)
        return {
          status: pass ? 'pass' : 'fail',
          actual: String(count),
          expected: params.max !== undefined ? `${min}–${params.max}` : `>= ${min}`,
          details: { count },
        }
      }
      case 'null_rate': {
        const pct = Number(row[0] ?? 0)
        const threshold = params.max_pct ?? 0
        const pass = pct <= threshold
        return {
          status: pass ? 'pass' : 'fail',
          actual: `${pct.toFixed(2)}%`,
          expected: `<= ${threshold}%`,
          details: { null_pct: pct },
        }
      }
      case 'uniqueness': {
        const dupes = Number(row[0])
        const pass = dupes === 0
        return {
          status: pass ? 'pass' : 'fail',
          actual: `${dupes} duplicate(s)`,
          expected: '0 duplicates',
          details: { duplicate_count: dupes },
        }
      }
      case 'range': {
        const min = Number(row[0])
        const max = Number(row[1])
        const expMin = params.min
        const expMax = params.max
        const passMin = expMin === undefined || min >= expMin
        const passMax = expMax === undefined || max <= expMax
        const pass = passMin && passMax
        return {
          status: pass ? 'pass' : 'fail',
          actual: `min=${min}, max=${max}`,
          expected: `min>=${expMin ?? '—'}, max<=${expMax ?? '—'}`,
          details: { min, max },
        }
      }
      case 'custom_sql': {
        const val = row[0]
        const pass = val !== null && val !== undefined && val !== false && val !== 0 && val !== '0'
        return {
          status: pass ? 'pass' : 'fail',
          actual: String(val),
          expected: 'truthy result',
          details: { value: val, columns: result.columns },
        }
      }
      case 'referential': {
        const orphans = Number(row[0])
        const pass = orphans === 0
        return {
          status: pass ? 'pass' : 'fail',
          actual: `${orphans} orphan(s)`,
          expected: '0 orphans',
          details: { orphan_count: orphans },
        }
      }
      default:
        return { status: 'error', actual: '', expected: '', details: { message: 'Unknown rule_type' } }
    }
  } catch (err: any) {
    return { status: 'error', actual: '', expected: '', details: { message: err.message } }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

const RuleBody = z.object({
  name:        z.string().min(1).max(128),
  rule_type:   z.enum(['row_count', 'null_rate', 'uniqueness', 'range', 'custom_sql', 'referential']),
  table_name:  z.string().max(256).default(''),
  column_name: z.string().max(256).nullable().optional(),
  params:      z.record(z.unknown()).default({}),
  is_active:   z.boolean().default(true),
})

export default async function dbAnalysisRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth)

  // GET /db/analysis/rules?connection_id=X
  fastify.get('/db/analysis/rules', { preHandler: requirePermission('servers:read') }, async (req) => {
    const { connection_id } = z.object({ connection_id: z.string().uuid() }).parse(req.query)
    const rules = await (db as any)
      .selectFrom('db_analysis_rules')
      .selectAll()
      .where('connection_id', '=', connection_id)
      .orderBy('created_at', 'asc')
      .execute()
    // Attach last result to each rule
    const enriched = await Promise.all(rules.map(async (r: RuleRow) => {
      const last = await (db as any)
        .selectFrom('db_analysis_results')
        .selectAll()
        .where('rule_id', '=', r.id)
        .orderBy('ran_at', 'desc')
        .limit(1)
        .executeTakeFirst()
      return { ...r, last_result: last ?? null }
    }))
    return { rules: enriched }
  })

  // POST /db/analysis/rules?connection_id=X
  fastify.post('/db/analysis/rules', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { connection_id } = z.object({ connection_id: z.string().uuid() }).parse(req.query)
    const body = RuleBody.parse(req.body)
    const conn = await getConn(connection_id)
    if (!conn) return reply.code(404).send({ error: 'Connection not found' })

    const row = await (db as any).insertInto('db_analysis_rules').values({
      connection_id, ...body,
      column_name: body.column_name ?? null,
      params: JSON.stringify(body.params),
      created_by: (req.session.user as any)!.id,
    }).returningAll().executeTakeFirst()
    return reply.code(201).send(row)
  })

  // PATCH /db/analysis/rules/:id
  fastify.patch('/db/analysis/rules/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = RuleBody.partial().parse(req.body)
    const updates: any = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.rule_type !== undefined) updates.rule_type = body.rule_type
    if (body.table_name !== undefined) updates.table_name = body.table_name
    if (body.column_name !== undefined) updates.column_name = body.column_name
    if (body.params !== undefined) updates.params = JSON.stringify(body.params)
    if (body.is_active !== undefined) updates.is_active = body.is_active
    await (db as any).updateTable('db_analysis_rules').set(updates).where('id', '=', id).execute()
    return { ok: true }
  })

  // DELETE /db/analysis/rules/:id
  fastify.delete('/db/analysis/rules/:id', { preHandler: requirePermission('servers:write') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await (db as any).deleteFrom('db_analysis_rules').where('id', '=', id).execute()
    return reply.code(204).send()
  })

  // POST /db/analysis/rules/:id/run — run a single rule
  fastify.post('/db/analysis/rules/:id/run', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { use_ssh_tunnel } = z.object({ use_ssh_tunnel: z.boolean().optional() }).parse(req.body ?? {})

    const rule = await (db as any).selectFrom('db_analysis_rules').selectAll().where('id', '=', id).executeTakeFirst() as RuleRow
    if (!rule) return reply.code(404).send({ error: 'Rule not found' })

    const connRaw = await getConn(rule.connection_id)
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = applyTunnelOverride(connRaw, use_ssh_tunnel)

    const evalResult = await evaluateRule(rule, conn)

    const saved = await (db as any).insertInto('db_analysis_results').values({
      rule_id: id,
      status: evalResult.status,
      actual: evalResult.actual,
      expected: evalResult.expected,
      details: JSON.stringify(evalResult.details),
    }).returningAll().executeTakeFirst()

    return { ...evalResult, id: saved.id, ran_at: saved.ran_at }
  })

  // POST /db/analysis/connections/:id/run-all
  fastify.post('/db/analysis/connections/:id/run-all', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { use_ssh_tunnel } = z.object({ use_ssh_tunnel: z.boolean().optional() }).parse(req.body ?? {})

    const connRaw = await getConn(id)
    if (!connRaw) return reply.code(404).send({ error: 'Connection not found' })
    const conn = applyTunnelOverride(connRaw, use_ssh_tunnel)

    const rules = await (db as any)
      .selectFrom('db_analysis_rules')
      .selectAll()
      .where('connection_id', '=', id)
      .where('is_active', '=', true)
      .execute() as RuleRow[]

    const results = await Promise.all(rules.map(async (rule) => {
      const evalResult = await evaluateRule(rule, conn)
      const saved = await (db as any).insertInto('db_analysis_results').values({
        rule_id: rule.id,
        status: evalResult.status,
        actual: evalResult.actual,
        expected: evalResult.expected,
        details: JSON.stringify(evalResult.details),
      }).returningAll().executeTakeFirst()
      return { rule_id: rule.id, rule_name: rule.name, ...evalResult, ran_at: saved.ran_at }
    }))

    const summary = {
      total: results.length,
      pass: results.filter(r => r.status === 'pass').length,
      fail: results.filter(r => r.status === 'fail').length,
      error: results.filter(r => r.status === 'error').length,
    }
    return { summary, results }
  })

  // GET /db/analysis/rules/:id/history
  fastify.get('/db/analysis/rules/:id/history', { preHandler: requirePermission('servers:read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const rows = await (db as any)
      .selectFrom('db_analysis_results')
      .selectAll()
      .where('rule_id', '=', id)
      .orderBy('ran_at', 'desc')
      .limit(50)
      .execute()
    return { history: rows }
  })

  // POST /db/analysis/compare — compare table between two connections
  fastify.post('/db/analysis/compare', { preHandler: requirePermission('servers:read') }, async (req, reply) => {
    const body = z.object({
      conn_a:          z.string().uuid(),
      conn_b:          z.string().uuid(),
      table_name:      z.string().min(1).max(256),
      use_tunnel_a:    z.boolean().optional(),
      use_tunnel_b:    z.boolean().optional(),
    }).parse(req.body)

    const [rawA, rawB] = await Promise.all([getConn(body.conn_a), getConn(body.conn_b)])
    if (!rawA) return reply.code(404).send({ error: 'Connection A not found' })
    if (!rawB) return reply.code(404).send({ error: 'Connection B not found' })

    const connA = applyTunnelOverride(rawA, body.use_tunnel_a)
    const connB = applyTunnelOverride(rawB, body.use_tunnel_b)

    const qtA = (t: string) => rawA.db_type === 'mysql' ? `\`${t}\`` : rawA.db_type === 'mssql' ? `[${t}]` : `"${t}"`
    const qtB = (t: string) => rawB.db_type === 'mysql' ? `\`${t}\`` : rawB.db_type === 'mssql' ? `[${t}]` : `"${t}"`

    const [resA, resB] = await Promise.all([
      runSql(connA, `SELECT COUNT(*) AS cnt FROM ${qtA(body.table_name)}`).catch(e => ({ error: e.message })),
      runSql(connB, `SELECT COUNT(*) AS cnt FROM ${qtB(body.table_name)}`).catch(e => ({ error: e.message })),
    ])

    const countA = 'error' in resA ? null : Number((resA as any).rows[0]?.[0])
    const countB = 'error' in resB ? null : Number((resB as any).rows[0]?.[0])
    const match = countA !== null && countB !== null && countA === countB

    return {
      table: body.table_name,
      conn_a: { id: rawA.id, name: rawA.name, db_type: rawA.db_type, count: countA, error: 'error' in resA ? (resA as any).error : null },
      conn_b: { id: rawB.id, name: rawB.name, db_type: rawB.db_type, count: countB, error: 'error' in resB ? (resB as any).error : null },
      match,
      diff: countA !== null && countB !== null ? countA - countB : null,
    }
  })
}
