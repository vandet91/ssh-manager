/**
 * Transfer utility — pipes data between two SSH connections.
 * Source stdout → API memory buffer → Target stdin.
 */
import { Client } from 'ssh2'
import { randomUUID } from 'crypto'

// ── Types ─────────────────────────────────────────────────────────────────────

export type TransferType = 'mysql' | 'postgresql' | 'mongodb' | 'redis' | 'files' | 'configs' | 'cron'

export interface TransferOptions {
  // Database transfers
  database?: string
  // File transfers
  source_path?: string
  target_path?: string
  // Cron
  users?: string   // comma-separated
}

export interface TransferJob {
  id: string
  source_server_id: string
  target_server_id: string
  type: TransferType
  options: TransferOptions
  status: 'pending' | 'running' | 'done' | 'error'
  log: string[]
  started_at: string
  ended_at?: string
  bytes_transferred: number
  created_by: string
}

export const transferJobs = new Map<string, TransferJob>()

export function createJob(
  sourceId: string,
  targetId: string,
  type: TransferType,
  options: TransferOptions,
  userId: string,
): TransferJob {
  const job: TransferJob = {
    id: randomUUID(),
    source_server_id: sourceId,
    target_server_id: targetId,
    type,
    options,
    status: 'pending',
    log: [],
    started_at: new Date().toISOString(),
    bytes_transferred: 0,
    created_by: userId,
  }
  transferJobs.set(job.id, job)
  return job
}

// ── Core pipe function ────────────────────────────────────────────────────────

/**
 * Executes sourceCmd on source SSH, pipes its stdout to stdin of targetCmd on target SSH.
 * Returns when both streams close. Rejects if either exec() call fails.
 */
const PIPE_TIMEOUT_MS = 60 * 60 * 1000  // 60 minutes — large projects need time

export function pipeExec(
  sourceClient: Client,
  sourceCmd: string,
  targetClient: Client,
  targetCmd: string,
  onProgress?: (bytes: number) => void,
): Promise<{ sourceCode: number; targetCode: number; sourceStderr: string; targetStderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let sourceCode = 0
    let targetCode = 0
    let sourceStderr = ''
    let targetStderr = ''
    let targetClosed = false
    let totalBytes = 0

    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Transfer timed out after 10 minutes')) }
    }, PIPE_TIMEOUT_MS)

    const finish = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ sourceCode, targetCode, sourceStderr, targetStderr })
      }
    }

    sourceClient.exec(sourceCmd, (srcErr, srcStream) => {
      if (srcErr) { clearTimeout(timer); return reject(new Error(`Source exec failed: ${srcErr.message}`)) }

      srcStream.stderr.on('data', (d: Buffer) => { sourceStderr += d.toString() })
      srcStream.on('exit', (code: number | null) => { sourceCode = code ?? 0 })
      srcStream.on('error', (err: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })

      targetClient.exec(targetCmd, (tgtErr, tgtStream) => {
        if (tgtErr) { srcStream.destroy(); clearTimeout(timer); return reject(new Error(`Target exec failed: ${tgtErr.message}`)) }

        tgtStream.stderr.on('data', (d: Buffer) => { targetStderr += d.toString() })
        tgtStream.on('exit', (code: number | null) => { targetCode = code ?? 0 })
        tgtStream.on('error', (err: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })

        // Track bytes while piping — use Node pipe() so backpressure + EOF are handled correctly.
        // Manually reading then writing caused a race where 'close' could fire on srcStream while
        // it was paused, calling tgtStream.end() before all data had been flushed.
        srcStream.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (onProgress) onProgress(totalBytes)
        })

        // pipe() handles backpressure and calls tgtStream.end() when srcStream ends
        srcStream.pipe(tgtStream)

        // Target closes after it processes all piped data and its process exits
        tgtStream.on('close', () => {
          targetClosed = true
          finish()
        })
        // Fallback: if target never emits 'close', resolve when source closes + brief wait
        srcStream.on('close', () => {
          if (!targetClosed) {
            setTimeout(() => finish(), 3000)
          }
        })
      })
    })
  })
}

/** Exec on a single client, return { stdout, code, stderr } */
function singleExec(client: Client, cmd: string): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (d: Buffer) => { stdout += d.toString() })
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      stream.on('close', (code: number) => resolve({ stdout: stdout.trim(), code: code ?? 0, stderr: stderr.trim() }))
    })
  })
}

// ── Target readiness check ────────────────────────────────────────────────────

export type ReadinessStatus = 'ok' | 'warn' | 'fail'

export interface ReadinessItem {
  label: string
  status: ReadinessStatus
  value: string
  note?: string
}

export interface ReadinessReport {
  items: ReadinessItem[]
  ready: boolean   // true if no 'fail' items
}

export async function checkRestoreReadiness(
  client: Client,
  type: 'mysql' | 'postgresql' | 'mongodb',
  database: string,
  dumpFile: string,
): Promise<ReadinessReport> {
  const items: ReadinessItem[] = []

  const check = (label: string, status: ReadinessStatus, value: string, note?: string): ReadinessItem =>
    ({ label, status, value, note })

  // 1. DB service running
  if (type === 'mysql') {
    const { stdout: svc } = await singleExec(client, 'systemctl is-active mysql 2>/dev/null || systemctl is-active mariadb 2>/dev/null || service mysql status 2>/dev/null | grep -c running || echo inactive')
    const running = svc.trim() === 'active' || svc.trim() === '1'
    items.push(check('MySQL service', running ? 'ok' : 'fail', running ? 'running' : svc.trim(), running ? undefined : 'Start with: systemctl start mysql'))

    // client tool
    const { code: cliCode } = await singleExec(client, 'which mysql 2>/dev/null')
    items.push(check('mysql client', cliCode === 0 ? 'ok' : 'fail', cliCode === 0 ? 'found' : 'not found', cliCode !== 0 ? 'Install: apt install mysql-client' : undefined))

    // can connect
    const { stdout: conn } = await singleExec(client, 'mysql -e "SELECT 1;" 2>/dev/null && echo OK || mysql -u root -e "SELECT 1;" 2>/dev/null && echo OK || echo FAIL')
    items.push(check('MySQL connection', conn.includes('OK') ? 'ok' : 'fail', conn.includes('OK') ? 'authenticated' : 'cannot connect', conn.includes('OK') ? undefined : 'Check MySQL root credentials'))

    // target DB exists?
    const { stdout: dbExists } = await singleExec(client, `mysql -e "SHOW DATABASES LIKE '${database}';" 2>/dev/null | grep -c "${database}" || mysql -u root -e "SHOW DATABASES LIKE '${database}';" 2>/dev/null | grep -c "${database}" || echo 0`)
    const exists = parseInt(dbExists.trim()) > 0
    items.push(check(`Database "${database}"`, exists ? 'warn' : 'ok', exists ? 'exists (will be overwritten)' : 'does not exist (will be created)', exists ? 'Existing data will be replaced by the dump' : undefined))

  } else if (type === 'postgresql') {
    const { stdout: svc } = await singleExec(client, 'systemctl is-active postgresql 2>/dev/null || echo inactive')
    const running = svc.trim() === 'active'
    items.push(check('PostgreSQL service', running ? 'ok' : 'fail', running ? 'running' : svc.trim(), running ? undefined : 'Start with: systemctl start postgresql'))

    const { code: cliCode } = await singleExec(client, 'which pg_restore 2>/dev/null')
    items.push(check('pg_restore client', cliCode === 0 ? 'ok' : 'fail', cliCode === 0 ? 'found' : 'not found', cliCode !== 0 ? 'Install: apt install postgresql-client' : undefined))

    const { stdout: conn } = await singleExec(client, 'sudo -u postgres psql -c "SELECT 1;" 2>/dev/null && echo OK || echo FAIL')
    items.push(check('PostgreSQL connection', conn.includes('OK') ? 'ok' : 'fail', conn.includes('OK') ? 'authenticated' : 'cannot connect'))

    const { stdout: dbExists } = await singleExec(client, `sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${database}';" 2>/dev/null`)
    const exists = dbExists.trim() === '1'
    items.push(check(`Database "${database}"`, exists ? 'warn' : 'ok', exists ? 'exists (will be overwritten)' : 'does not exist (will be created)', exists ? 'Existing data will be replaced' : undefined))

  } else if (type === 'mongodb') {
    const { stdout: svc } = await singleExec(client, 'systemctl is-active mongod 2>/dev/null || echo inactive')
    const running = svc.trim() === 'active'
    items.push(check('MongoDB service', running ? 'ok' : 'fail', running ? 'running' : svc.trim(), running ? undefined : 'Start with: systemctl start mongod'))

    const { code: cliCode } = await singleExec(client, 'which mongorestore 2>/dev/null')
    items.push(check('mongorestore client', cliCode === 0 ? 'ok' : 'fail', cliCode === 0 ? 'found' : 'not found', cliCode !== 0 ? 'Install: apt install mongodb-database-tools' : undefined))

    const { stdout: conn } = await singleExec(client, 'mongosh --quiet --eval "db.adminCommand({ping:1})" 2>/dev/null && echo OK || mongo --eval "db.adminCommand({ping:1})" 2>/dev/null && echo OK || echo FAIL')
    items.push(check('MongoDB connection', conn.includes('OK') ? 'ok' : 'fail', conn.includes('OK') ? 'authenticated' : 'cannot connect'))

    const { stdout: dbExists } = await singleExec(client, `mongosh --quiet --eval "db.adminCommand({listDatabases:1}).databases.map(d=>d.name)" 2>/dev/null | grep -c '"${database}"' || echo 0`)
    const exists = parseInt(dbExists.trim()) > 0
    items.push(check(`Database "${database}"`, exists ? 'warn' : 'ok', exists ? 'exists (will be dropped and replaced)' : 'does not exist (will be created)'))
  }

  // 2. Dump file exists on target
  const { stdout: fileExists } = await singleExec(client, `[ -f "${dumpFile}" ] && echo yes || echo no`)
  items.push(check('Dump file on target', fileExists.trim() === 'yes' ? 'ok' : 'fail', fileExists.trim() === 'yes' ? dumpFile : 'not found', fileExists.trim() !== 'yes' ? 'Transfer the dump file first' : undefined))

  // 3. Dump file size on target
  if (fileExists.trim() === 'yes') {
    const { stdout: sz } = await singleExec(client, `du -sh "${dumpFile}" | cut -f1`)
    items.push(check('Dump file size', 'ok', sz.trim()))
  }

  // 4. Available disk space
  const { stdout: diskOut } = await singleExec(client, `df -h "${dumpFile}" 2>/dev/null | tail -1 | awk '{print $4}'`)
  items.push(check('Disk space available', 'ok', diskOut.trim() || 'unknown'))

  const ready = items.every((i) => i.status !== 'fail')
  return { items, ready }
}

// ── Restore from dump file ────────────────────────────────────────────────────

export async function restoreDatabase(
  client: Client,
  type: 'mysql' | 'postgresql' | 'mongodb',
  database: string,
  dumpFile: string,
  log: (msg: string) => void,
): Promise<void> {
  if (type === 'mysql') {
    log(`Creating database "${database}" if not exists…`)
    await singleExec(client, `mysql -e "CREATE DATABASE IF NOT EXISTS \`${database}\`;" 2>/dev/null || mysql -u root -e "CREATE DATABASE IF NOT EXISTS \`${database}\`;" 2>/dev/null`)
    log(`Restoring from ${dumpFile}…`)
    const r = await singleExec(client, `zcat "${dumpFile}" | mysql \`${database}\` 2>&1 && echo OK`)
    if (!r.stdout.includes('OK')) throw new Error(`mysql restore failed: ${r.stdout}`)
    log('MySQL restore complete ✓')

  } else if (type === 'postgresql') {
    log(`Creating database "${database}" if not exists…`)
    await singleExec(client, `sudo -u postgres createdb "${database}" 2>/dev/null || true`)
    log(`Restoring from ${dumpFile}…`)
    const r = await singleExec(client, `sudo -u postgres pg_restore --clean --if-exists --no-owner --no-privileges -d "${database}" "${dumpFile}" 2>&1 && echo OK`)
    if (!r.stdout.includes('OK')) throw new Error(`pg_restore failed: ${r.stdout}`)
    log('PostgreSQL restore complete ✓')

  } else if (type === 'mongodb') {
    log(`Restoring MongoDB "${database}" from ${dumpFile}…`)
    const r = await singleExec(client, `mongorestore --archive="${dumpFile}" --gzip --drop --db="${database}" 2>&1 && echo OK`)
    if (!r.stdout.includes('OK')) throw new Error(`mongorestore failed: ${r.stdout}`)
    log('MongoDB restore complete ✓')
  }
}

// ── Standalone dump (phase 1 only — no transfer or restore) ──────────────────

export interface DumpResult {
  dump_file: string
  size_bytes: number
  size_human: string
}

export async function dumpDatabase(
  client: Client,
  type: 'mysql' | 'postgresql' | 'mongodb',
  database: string,
  jobId: string,
): Promise<DumpResult> {
  let dumpFile: string
  let cmd: string

  if (type === 'mysql') {
    dumpFile = `/tmp/ssh-mgr-${jobId.slice(0, 8)}-${database}.sql.gz`
    cmd = `mysqldump --single-transaction --routines --triggers --events --add-drop-table \`${database}\` 2>/tmp/mysqldump-err.txt | gzip > "${dumpFile}" && echo OK`
  } else if (type === 'postgresql') {
    dumpFile = `/tmp/ssh-mgr-${jobId.slice(0, 8)}-${database}.pgdump`
    cmd = `sudo -u postgres pg_dump --format=custom --compress=6 -f "${dumpFile}" "${database}" 2>&1 && echo OK`
  } else {
    dumpFile = `/tmp/ssh-mgr-${jobId.slice(0, 8)}-${database}.archive.gz`
    cmd = `mongodump --archive="${dumpFile}" --gzip --db="${database}" 2>&1 && echo OK`
  }

  const result = await singleExec(client, cmd)
  if (!result.stdout.includes('OK')) {
    if (type === 'mysql') {
      const errMsg = await singleExec(client, 'cat /tmp/mysqldump-err.txt 2>/dev/null')
      throw new Error(`Dump failed: ${errMsg.stdout || result.stderr}`)
    }
    throw new Error(`Dump failed: ${result.stdout || result.stderr}`)
  }

  // Verify not empty
  const { stdout: bytesOut } = await singleExec(client, `stat -c%s "${dumpFile}" 2>/dev/null || stat -f%z "${dumpFile}" 2>/dev/null`)
  const sizeBytes = parseInt(bytesOut.trim()) || 0
  if (sizeBytes === 0) throw new Error('Dump file is empty after completion')

  const { stdout: humanOut } = await singleExec(client, `du -sh "${dumpFile}" | cut -f1`)

  // Integrity check
  if (type === 'mysql' || type === 'mongodb') {
    const { stdout: integrityOut } = await singleExec(client, `gzip -t "${dumpFile}" 2>&1 && echo OK`)
    if (!integrityOut.includes('OK')) throw new Error(`Dump file failed integrity check: ${integrityOut}`)
  } else if (type === 'postgresql') {
    const { stdout: integrityOut } = await singleExec(client, `pg_restore --list "${dumpFile}" > /dev/null 2>&1 && echo OK || echo FAIL`)
    if (!integrityOut.includes('OK')) throw new Error('Dump file failed integrity check (pg_restore --list)')
  }

  return { dump_file: dumpFile, size_bytes: sizeBytes, size_human: humanOut.trim() }
}

// ── Transfer implementations ──────────────────────────────────────────────────

async function transferMySQL(
  src: Client, tgt: Client, options: TransferOptions,
  job: TransferJob, log: (msg: string) => void,
): Promise<void> {
  const db = options.database
  if (!db) throw new Error('database option is required')
  const dumpFile = `/tmp/ssh-mgr-${job.id.slice(0, 8)}-${db}.sql.gz`

  // Step 1: Dump to file on source
  log(`[1/4] Dumping MySQL "${db}" to ${dumpFile} on source…`)
  const dump = await singleExec(src,
    `mysqldump --single-transaction --routines --triggers --events --add-drop-table \`${db}\` 2>/tmp/mysqldump-err.txt | gzip > "${dumpFile}" && echo OK`
  )
  if (!dump.stdout.includes('OK')) {
    const errMsg = await singleExec(src, 'cat /tmp/mysqldump-err.txt 2>/dev/null')
    throw new Error(`mysqldump failed: ${errMsg.stdout || dump.stderr}`)
  }
  const { stdout: dumpSize } = await singleExec(src, `du -sh "${dumpFile}" | cut -f1`)
  const { stdout: dumpBytes } = await singleExec(src, `stat -c%s "${dumpFile}" 2>/dev/null || stat -f%z "${dumpFile}" 2>/dev/null`)
  log(`[1/4] Dump complete. Size: ${dumpSize.trim()} (${dumpBytes.trim()} bytes)`)

  // Verify dump file integrity before transferring
  log(`[1/4] Verifying dump integrity on source…`)
  if (!dumpBytes.trim() || parseInt(dumpBytes.trim()) === 0) throw new Error('Dump file is empty — aborting transfer')
  const { code: integrityCode, stdout: integrityOut } = await singleExec(src, `gzip -t "${dumpFile}" 2>&1 && echo OK`)
  if (!integrityOut.includes('OK')) throw new Error(`Dump file is corrupted (gzip -t failed): ${integrityOut}`)
  log(`[1/4] Dump integrity verified ✓`)

  // Step 2: Transfer dump file to target
  log(`[2/5] Transferring dump file to target…`)
  const xfer = await pipeExec(
    src, `cat "${dumpFile}"`,
    tgt, `cat > "${dumpFile}"`,
    (bytes) => { job.bytes_transferred = bytes; if (bytes % (5 * 1024 * 1024) < 65536) log(`  … ${formatBytes(bytes)} received`) },
  )
  if (xfer.sourceCode !== 0) throw new Error(`File transfer failed (source): ${xfer.sourceStderr}`)
  log(`[2/5] File transferred. ${formatBytes(job.bytes_transferred)} total.`)

  // Verify received file matches source size
  log(`[2/5] Verifying received file on target…`)
  const { stdout: tgtBytes } = await singleExec(tgt, `stat -c%s "${dumpFile}" 2>/dev/null || stat -f%z "${dumpFile}" 2>/dev/null`)
  if (tgtBytes.trim() !== dumpBytes.trim()) throw new Error(`Size mismatch after transfer — source: ${dumpBytes.trim()} bytes, target: ${tgtBytes.trim()} bytes`)
  const { stdout: tgtIntegrity } = await singleExec(tgt, `gzip -t "${dumpFile}" 2>&1 && echo OK`)
  if (!tgtIntegrity.includes('OK')) throw new Error(`Received dump file is corrupted on target: ${tgtIntegrity}`)
  log(`[2/5] Received file verified ✓ (${tgtBytes.trim()} bytes, gzip OK)`)

  // Step 3: Restore on target
  log(`[3/5] Creating database "${db}" on target if not exists…`)
  await singleExec(tgt, `mysql -e "CREATE DATABASE IF NOT EXISTS \`${db}\`;" 2>/dev/null || mysql -u root -e "CREATE DATABASE IF NOT EXISTS \`${db}\`;" 2>/dev/null`)
  log(`[3/5] Restoring from dump file on target…`)
  const restore = await singleExec(tgt, `zcat "${dumpFile}" | mysql \`${db}\` 2>&1 && echo OK`)
  if (!restore.stdout.includes('OK')) throw new Error(`mysql restore failed: ${restore.stdout}`)
  log(`[3/5] Restore complete ✓`)

  // Step 4: Cleanup
  log(`[4/5] Cleaning up dump files…`)
  await Promise.all([singleExec(src, `rm -f "${dumpFile}"`), singleExec(tgt, `rm -f "${dumpFile}"`)])
  log(`[4/5] Cleanup done.`)
  log(`MySQL transfer done ✓ ${formatBytes(job.bytes_transferred)} transferred.`)
}

async function transferPostgreSQL(
  src: Client, tgt: Client, options: TransferOptions,
  job: TransferJob, log: (msg: string) => void,
): Promise<void> {
  const db = options.database
  if (!db) throw new Error('database option is required')
  const dumpFile = `/tmp/ssh-mgr-${job.id.slice(0, 8)}-${db}.pgdump`

  // Step 1: Dump to file on source (custom format = compressed + parallel-restore capable)
  log(`[1/4] Dumping PostgreSQL "${db}" to ${dumpFile} on source…`)
  const dump = await singleExec(src,
    `sudo -u postgres pg_dump --format=custom --compress=6 -f "${dumpFile}" "${db}" 2>&1 && echo OK`
  )
  if (!dump.stdout.includes('OK')) throw new Error(`pg_dump failed: ${dump.stdout}`)
  const { stdout: dumpSize } = await singleExec(src, `du -sh "${dumpFile}" | cut -f1`)
  const { stdout: dumpBytes } = await singleExec(src, `stat -c%s "${dumpFile}" 2>/dev/null || stat -f%z "${dumpFile}" 2>/dev/null`)
  log(`[1/4] Dump complete. Size: ${dumpSize.trim()} (${dumpBytes.trim()} bytes)`)

  // Verify dump file integrity before transferring
  log(`[1/4] Verifying dump integrity on source…`)
  if (!dumpBytes.trim() || parseInt(dumpBytes.trim()) === 0) throw new Error('Dump file is empty — aborting transfer')
  const { stdout: integrityOut } = await singleExec(src, `pg_restore --list "${dumpFile}" > /dev/null 2>&1 && echo OK || echo FAIL`)
  if (!integrityOut.includes('OK')) throw new Error(`Dump file is corrupted (pg_restore --list failed)`)
  log(`[1/4] Dump integrity verified ✓`)

  // Step 2: Transfer dump file to target
  log(`[2/5] Transferring dump file to target…`)
  const xfer = await pipeExec(
    src, `cat "${dumpFile}"`,
    tgt, `cat > "${dumpFile}"`,
    (bytes) => { job.bytes_transferred = bytes; if (bytes % (5 * 1024 * 1024) < 65536) log(`  … ${formatBytes(bytes)} received`) },
  )
  if (xfer.sourceCode !== 0) throw new Error(`File transfer failed: ${xfer.sourceStderr}`)
  log(`[2/5] File transferred. ${formatBytes(job.bytes_transferred)} total.`)

  // Verify received file matches source size
  log(`[2/5] Verifying received file on target…`)
  const { stdout: tgtBytes } = await singleExec(tgt, `stat -c%s "${dumpFile}" 2>/dev/null || stat -f%z "${dumpFile}" 2>/dev/null`)
  if (tgtBytes.trim() !== dumpBytes.trim()) throw new Error(`Size mismatch after transfer — source: ${dumpBytes.trim()} bytes, target: ${tgtBytes.trim()} bytes`)
  log(`[2/5] Received file verified ✓ (${tgtBytes.trim()} bytes)`)

  // Step 3: Restore on target
  log(`[3/5] Creating database "${db}" on target if not exists…`)
  await singleExec(tgt, `sudo -u postgres createdb "${db}" 2>/dev/null || true`)
  log(`[3/5] Restoring from dump file on target…`)
  const restore = await singleExec(tgt,
    `sudo -u postgres pg_restore --clean --if-exists --no-owner --no-privileges -d "${db}" "${dumpFile}" 2>&1 && echo OK`
  )
  if (!restore.stdout.includes('OK')) throw new Error(`pg_restore failed: ${restore.stdout}`)
  log(`[3/5] Restore complete ✓`)

  // Step 4: Cleanup
  log(`[4/5] Cleaning up dump files…`)
  await Promise.all([singleExec(src, `rm -f "${dumpFile}"`), singleExec(tgt, `rm -f "${dumpFile}"`)])
  log(`[4/5] Cleanup done.`)
  log(`PostgreSQL transfer done ✓ ${formatBytes(job.bytes_transferred)} transferred.`)
}

async function transferMongoDB(
  src: Client, tgt: Client, options: TransferOptions,
  job: TransferJob, log: (msg: string) => void,
): Promise<void> {
  const db = options.database
  if (!db) throw new Error('database option is required')
  const dumpFile = `/tmp/ssh-mgr-${job.id.slice(0, 8)}-${db}.archive.gz`

  // Step 1: Dump to archive file on source
  log(`[1/4] Dumping MongoDB "${db}" to ${dumpFile} on source…`)
  const dump = await singleExec(src,
    `mongodump --archive="${dumpFile}" --gzip --db="${db}" 2>&1 && echo OK`
  )
  if (!dump.stdout.includes('OK')) throw new Error(`mongodump failed: ${dump.stdout}`)
  const { stdout: dumpSize } = await singleExec(src, `du -sh "${dumpFile}" | cut -f1`)
  const { stdout: dumpBytes } = await singleExec(src, `stat -c%s "${dumpFile}" 2>/dev/null || stat -f%z "${dumpFile}" 2>/dev/null`)
  log(`[1/4] Dump complete. Size: ${dumpSize.trim()} (${dumpBytes.trim()} bytes)`)

  // Verify dump file integrity before transferring
  log(`[1/4] Verifying dump integrity on source…`)
  if (!dumpBytes.trim() || parseInt(dumpBytes.trim()) === 0) throw new Error('Dump file is empty — aborting transfer')
  const { stdout: integrityOut } = await singleExec(src, `gzip -t "${dumpFile}" 2>&1 && echo OK`)
  if (!integrityOut.includes('OK')) throw new Error(`Dump file is corrupted (gzip -t failed): ${integrityOut}`)
  log(`[1/4] Dump integrity verified ✓`)

  // Step 2: Transfer archive to target
  log(`[2/5] Transferring dump file to target…`)
  const xfer = await pipeExec(
    src, `cat "${dumpFile}"`,
    tgt, `cat > "${dumpFile}"`,
    (bytes) => { job.bytes_transferred = bytes; if (bytes % (5 * 1024 * 1024) < 65536) log(`  … ${formatBytes(bytes)} received`) },
  )
  if (xfer.sourceCode !== 0) throw new Error(`File transfer failed: ${xfer.sourceStderr}`)
  log(`[2/5] File transferred. ${formatBytes(job.bytes_transferred)} total.`)

  // Verify received file matches source size
  log(`[2/5] Verifying received file on target…`)
  const { stdout: tgtBytes } = await singleExec(tgt, `stat -c%s "${dumpFile}" 2>/dev/null || stat -f%z "${dumpFile}" 2>/dev/null`)
  if (tgtBytes.trim() !== dumpBytes.trim()) throw new Error(`Size mismatch after transfer — source: ${dumpBytes.trim()} bytes, target: ${tgtBytes.trim()} bytes`)
  const { stdout: tgtIntegrity } = await singleExec(tgt, `gzip -t "${dumpFile}" 2>&1 && echo OK`)
  if (!tgtIntegrity.includes('OK')) throw new Error(`Received dump file is corrupted on target: ${tgtIntegrity}`)
  log(`[2/5] Received file verified ✓ (${tgtBytes.trim()} bytes, gzip OK)`)

  // Step 3: Restore on target
  log(`[3/5] Restoring MongoDB "${db}" from archive on target…`)
  const restore = await singleExec(tgt,
    `mongorestore --archive="${dumpFile}" --gzip --drop --db="${db}" 2>&1 && echo OK`
  )
  if (!restore.stdout.includes('OK')) throw new Error(`mongorestore failed: ${restore.stdout}`)
  log(`[3/5] Restore complete ✓`)

  // Step 4: Cleanup
  log(`[4/5] Cleaning up dump files…`)
  await Promise.all([singleExec(src, `rm -f "${dumpFile}"`), singleExec(tgt, `rm -f "${dumpFile}"`)])
  log(`[4/5] Cleanup done.`)
  log(`MongoDB transfer done ✓ ${formatBytes(job.bytes_transferred)} transferred.`)
}

async function transferRedis(
  src: Client, tgt: Client, _options: TransferOptions,
  job: TransferJob, log: (msg: string) => void,
): Promise<void> {
  log('Saving Redis RDB snapshot on source (BGSAVE)…')
  await singleExec(src, 'redis-cli BGSAVE')
  // Wait for BGSAVE to complete
  for (let i = 0; i < 30; i++) {
    const { stdout } = await singleExec(src, 'redis-cli LASTSAVE')
    const { stdout: info } = await singleExec(src, 'redis-cli INFO persistence | grep rdb_bgsave_in_progress')
    if (info.includes('rdb_bgsave_in_progress:0')) break
    await new Promise((r) => setTimeout(r, 1000))
  }

  const { stdout: rdbDir } = await singleExec(src, 'redis-cli CONFIG GET dir | tail -1')
  const { stdout: rdbFilename } = await singleExec(src, 'redis-cli CONFIG GET dbfilename | tail -1')
  const rdbFile = `${rdbDir.trim()}/${(rdbFilename.trim() || 'dump.rdb')}`
  log(`Copying Redis RDB: ${rdbFile}…`)

  const { stdout: tgtDir } = await singleExec(tgt, 'redis-cli CONFIG GET dir | tail -1')
  const tgtFile = `${tgtDir.trim()}/${(rdbFilename.trim() || 'dump.rdb')}`

  await singleExec(tgt, 'redis-cli SHUTDOWN NOSAVE 2>/dev/null; sleep 1; true')
  const result = await pipeExec(
    src, `cat "${rdbFile}"`,
    tgt, `cat > "${tgtFile}"`,
    (bytes) => { job.bytes_transferred = bytes },
  )
  if (result.sourceCode !== 0) throw new Error(`Redis RDB read failed: ${result.sourceStderr}`)
  await singleExec(tgt, 'systemctl start redis 2>/dev/null || service redis start 2>/dev/null || redis-server --daemonize yes 2>/dev/null || true')
  log(`Redis transfer done. ${formatBytes(job.bytes_transferred)} transferred.`)
  log('Redis restarted on target to load new RDB.')
}

async function transferFiles(
  src: Client, tgt: Client, options: TransferOptions,
  job: TransferJob, log: (msg: string) => void,
): Promise<void> {
  const srcPath = options.source_path
  const tgtPath = options.target_path || srcPath
  if (!srcPath) throw new Error('source_path option is required')

  // The actual extracted path is tgtPath/basename(srcPath) when they differ
  const srcBase = srcPath.replace(/\/$/, '').replace(/.*\//, '')
  const extractedPath = (tgtPath && tgtPath !== srcPath)
    ? `${tgtPath.replace(/\/$/, '')}/${srcBase}`
    : srcPath

  // If destination already exists, rename it with _archived suffix before extracting
  const { stdout: existsCheck } = await singleExec(tgt, `[ -e "${extractedPath}" ] && echo yes || echo no`)
  if (existsCheck.trim() === 'yes') {
    const archiveName = `${extractedPath}_archived_${Date.now()}`
    log(`Destination ${extractedPath} already exists — renaming to ${archiveName}…`)
    const { code: mvCode, stderr: mvErr } = await singleExec(tgt, `mv "${extractedPath}" "${archiveName}"`)
    if (mvCode !== 0) throw new Error(`Failed to archive existing directory: ${mvErr}`)
    log(`Existing directory archived as ${archiveName}`)
  }

  log(`Preparing target directory: ${tgtPath}…`)
  await singleExec(tgt, `mkdir -p "${tgtPath}"`)

  // Log source size before transfer
  const { stdout: sizeOut } = await singleExec(src, `du -sh "${srcPath}" 2>/dev/null | cut -f1`)
  const { stdout: countOut } = await singleExec(src, `find "${srcPath}" -type f 2>/dev/null | wc -l`)
  if (sizeOut) log(`Source size: ${sizeOut.trim()}, files: ${countOut.trim()}`)

  // Use tar+gzip (works everywhere; rsync needs SSH access between the two servers)
  // For reliability with large trees: use --ignore-failed-read so one bad file doesn't abort
  log(`Transferring ${srcPath} → ${tgtPath} (tar+gzip stream)…`)
  const parentDir = srcPath.replace(/\/[^/]+$/, '') || '/'
  const dirName = srcPath.replace(/.*\//, '')
  const result = await pipeExec(
    src, `tar czf - --ignore-failed-read -C "${parentDir}" "${dirName}" 2>/dev/null`,
    tgt, `tar xzf - -C "${tgtPath === srcPath ? '/' : tgtPath}" --overwrite 2>/dev/null`,
    (bytes) => { job.bytes_transferred = bytes; if (bytes % (5 * 1024 * 1024) < 65536) log(`  … ${formatBytes(bytes)} transferred`) },
  )
  if (result.sourceCode !== 0 && result.sourceCode !== 1) {
    throw new Error(`tar (source) exited ${result.sourceCode}: ${result.sourceStderr}`)
  }
  log(`File transfer done. ${formatBytes(job.bytes_transferred)} transferred.`)
}

async function transferConfigs(
  src: Client, tgt: Client,
  job: TransferJob, log: (msg: string) => void,
): Promise<void> {
  const configPaths = [
    '/etc/nginx', '/etc/apache2', '/etc/php', '/etc/mysql', '/etc/postgresql',
    '/etc/redis', '/etc/systemd/system', '/etc/cron.d', '/etc/environment',
    '/etc/hosts', '/etc/resolv.conf',
  ]
  const existingRaw = await singleExec(src,
    configPaths.map((p) => `[ -e "${p}" ] && echo "${p}"`).join('; ')
  )
  const existing = existingRaw.stdout.split('\n').filter(Boolean)
  if (existing.length === 0) {
    log('No common config paths found on source.')
    return
  }
  log(`Transferring config paths: ${existing.join(', ')}…`)
  const paths = existing.map((p) => `"${p}"`).join(' ')
  const result = await pipeExec(
    src, `tar czf - ${paths} --ignore-failed-read 2>/dev/null`,
    tgt, `tar xzf - -C / --overwrite 2>/dev/null`,
    (bytes) => { job.bytes_transferred = bytes },
  )
  if (result.sourceCode !== 0 && result.sourceCode !== 1) {
    throw new Error(`tar (source) exited ${result.sourceCode}: ${result.sourceStderr}`)
  }
  log(`Config transfer done. ${formatBytes(job.bytes_transferred)} transferred.`)
  log('Note: Services may need reload after config copy (e.g. nginx -t && systemctl reload nginx)')
}

async function transferCron(
  src: Client, tgt: Client, options: TransferOptions,
  job: TransferJob, log: (msg: string) => void,
): Promise<void> {
  const users = options.users ? options.users.split(',').map((u) => u.trim()) : ['root']
  for (const user of users) {
    log(`Transferring crontab for user: ${user}…`)
    const result = await pipeExec(
      src, `crontab -l -u ${user} 2>/dev/null`,
      tgt, `crontab - -u ${user} 2>/dev/null`,
      (bytes) => { job.bytes_transferred += bytes },
    )
    log(`  ${user}: done (exit ${result.targetCode})`)
  }

  // Also transfer /etc/cron.d files
  log('Transferring /etc/cron.d files…')
  const cronResult = await pipeExec(
    src, 'tar czf - /etc/cron.d /etc/cron.daily /etc/cron.weekly /etc/cron.monthly --ignore-failed-read 2>/dev/null',
    tgt, 'tar xzf - -C / --overwrite 2>/dev/null',
    (bytes) => { job.bytes_transferred += bytes },
  )
  log(`Cron transfer done. ${formatBytes(job.bytes_transferred)} transferred.`)
}

// ── Main job runner ───────────────────────────────────────────────────────────

export async function runTransferJob(
  job: TransferJob,
  srcClient: Client,
  tgtClient: Client,
): Promise<void> {
  job.status = 'running'

  const log = (msg: string) => {
    job.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`)
  }

  log(`Starting ${job.type} transfer…`)

  try {
    switch (job.type) {
      case 'mysql':       await transferMySQL(srcClient, tgtClient, job.options, job, log); break
      case 'postgresql':  await transferPostgreSQL(srcClient, tgtClient, job.options, job, log); break
      case 'mongodb':     await transferMongoDB(srcClient, tgtClient, job.options, job, log); break
      case 'redis':       await transferRedis(srcClient, tgtClient, job.options, job, log); break
      case 'files':       await transferFiles(srcClient, tgtClient, job.options, job, log); break
      case 'configs':     await transferConfigs(srcClient, tgtClient, job, log); break
      case 'cron':        await transferCron(srcClient, tgtClient, job.options, job, log); break
      default: throw new Error(`Unknown transfer type: ${job.type}`)
    }
    job.status = 'done'
    log('Transfer completed successfully ✓')
  } catch (err) {
    job.status = 'error'
    log(`Transfer failed: ${(err as Error).message}`)
  } finally {
    job.ended_at = new Date().toISOString()
  }
}

// ── Verification ─────────────────────────────────────────────────────────────

export type VerifyStatus = 'match' | 'mismatch' | 'warning' | 'error' | 'skip'

export interface VerifyItem {
  label: string
  source: string
  target: string
  status: VerifyStatus
  note?: string
}

export interface VerifyReport {
  job_id: string
  ran_at: string
  type: TransferType
  items: VerifyItem[]
  passed: number
  failed: number
  warnings: number
}

function verifyItem(label: string, src: string, tgt: string, note?: string): VerifyItem {
  const s = src.trim()
  const t = tgt.trim()
  if (!s && !t) return { label, source: '—', target: '—', status: 'skip', note: 'not available on either side' }
  if (!t) return { label, source: s, target: '(missing)', status: 'error', note: note ?? 'not found on target' }
  if (!s) return { label, source: '(missing)', target: t, status: 'warning', note: note ?? 'not found on source' }
  const status: VerifyStatus = s === t ? 'match' : 'mismatch'
  return { label, source: s, target: t, status, note }
}

async function verifyMySQL(src: Client, tgt: Client, database: string): Promise<VerifyItem[]> {
  const items: VerifyItem[] = []
  const q = (c: Client, sql: string) => singleExec(c, `mysql -N -e "${sql}" ${database} 2>/dev/null || mysql -u root -N -e "${sql}" ${database} 2>/dev/null`)

  // Table count
  const [srcTables, tgtTables] = await Promise.all([
    q(src, 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\\"BASE TABLE\\";'),
    q(tgt, 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\\"BASE TABLE\\";'),
  ])
  items.push(verifyItem('Table count', srcTables.stdout, tgtTables.stdout))

  // DB size
  const [srcSize, tgtSize] = await Promise.all([
    q(src, `SELECT ROUND(SUM(data_length+index_length)/1024/1024,1) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${database}';`),
    q(tgt, `SELECT ROUND(SUM(data_length+index_length)/1024/1024,1) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${database}';`),
  ])
  items.push(verifyItem('Size (MB)', srcSize.stdout, tgtSize.stdout, 'approximate; may differ slightly due to page fill'))

  // Row counts per table
  const { stdout: tableList } = await q(src, 'SHOW TABLES;')
  const tables = tableList.split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 20)
  for (const table of tables) {
    const [s, t] = await Promise.all([
      q(src, `SELECT COUNT(*) FROM \\\`${table}\\\`;`),
      q(tgt, `SELECT COUNT(*) FROM \\\`${table}\\\`;`),
    ])
    items.push(verifyItem(`Rows: ${table}`, s.stdout, t.stdout))
  }
  if (tables.length === 20) items.push({ label: 'Note', source: '—', target: '—', status: 'warning', note: 'Showing first 20 tables only' })

  return items
}

async function verifyPostgreSQL(src: Client, tgt: Client, database: string): Promise<VerifyItem[]> {
  const items: VerifyItem[] = []
  const q = (c: Client, sql: string) => singleExec(c, `sudo -u postgres psql -t -c "${sql}" "${database}" 2>/dev/null`)

  const [srcTables, tgtTables] = await Promise.all([
    q(src, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"),
    q(tgt, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"),
  ])
  items.push(verifyItem('Table count', srcTables.stdout.trim(), tgtTables.stdout.trim()))

  const [srcSize, tgtSize] = await Promise.all([
    q(src, `SELECT pg_size_pretty(pg_database_size('${database}'));`),
    q(tgt, `SELECT pg_size_pretty(pg_database_size('${database}'));`),
  ])
  items.push(verifyItem('DB size', srcSize.stdout.trim(), tgtSize.stdout.trim(), 'may differ slightly due to VACUUM/bloat'))

  const { stdout: tableList } = await q(src, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;")
  const tables = tableList.split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 20)
  for (const table of tables) {
    const [s, t] = await Promise.all([
      q(src, `SELECT COUNT(*) FROM "${table}";`),
      q(tgt, `SELECT COUNT(*) FROM "${table}";`),
    ])
    items.push(verifyItem(`Rows: ${table}`, s.stdout.trim(), t.stdout.trim()))
  }
  if (tables.length === 20) items.push({ label: 'Note', source: '—', target: '—', status: 'warning', note: 'Showing first 20 tables only' })

  return items
}

async function verifyMongoDB(src: Client, tgt: Client, database: string): Promise<VerifyItem[]> {
  const items: VerifyItem[] = []
  const q = (c: Client, js: string) => singleExec(c, `mongosh --quiet --eval "${js}" "${database}" 2>/dev/null || mongo --quiet --eval "${js}" "${database}" 2>/dev/null`)

  const [srcColls, tgtColls] = await Promise.all([
    q(src, 'db.getCollectionNames().length'),
    q(tgt, 'db.getCollectionNames().length'),
  ])
  items.push(verifyItem('Collection count', srcColls.stdout.trim(), tgtColls.stdout.trim()))

  const [srcSize, tgtSize] = await Promise.all([
    q(src, 'JSON.stringify(db.stats().dataSize)'),
    q(tgt, 'JSON.stringify(db.stats().dataSize)'),
  ])
  items.push(verifyItem('Data size (bytes)', srcSize.stdout.trim(), tgtSize.stdout.trim()))

  const { stdout: collList } = await q(src, 'db.getCollectionNames().join("\\n")')
  const colls = collList.split('\n').map((c) => c.trim()).filter(Boolean).slice(0, 20)
  for (const coll of colls) {
    const [s, t] = await Promise.all([
      q(src, `db.${coll}.countDocuments()`),
      q(tgt, `db.${coll}.countDocuments()`),
    ])
    items.push(verifyItem(`Docs: ${coll}`, s.stdout.trim(), t.stdout.trim()))
  }

  return items
}

async function verifyRedis(src: Client, tgt: Client): Promise<VerifyItem[]> {
  const items: VerifyItem[] = []
  const q = (c: Client, cmd: string) => singleExec(c, `redis-cli ${cmd} 2>/dev/null`)

  const [srcKeys, tgtKeys] = await Promise.all([q(src, 'DBSIZE'), q(tgt, 'DBSIZE')])
  items.push(verifyItem('Key count', srcKeys.stdout.trim(), tgtKeys.stdout.trim()))

  const [srcMem, tgtMem] = await Promise.all([
    q(src, 'INFO memory | grep used_memory_human'),
    q(tgt, 'INFO memory | grep used_memory_human'),
  ])
  items.push(verifyItem('Used memory', srcMem.stdout.replace('used_memory_human:', '').trim(), tgtMem.stdout.replace('used_memory_human:', '').trim(), 'approximate'))

  return items
}

async function verifyFiles(src: Client, tgt: Client, srcPath: string, tgtPath: string): Promise<VerifyItem[]> {
  const items: VerifyItem[] = []
  const srcNorm = srcPath.replace(/\/$/, '')
  const baseName = srcNorm.replace(/.*\//, '')

  // tar extracts srcPath's *contents under its dirname* into tgtPath.
  // e.g. src=/var/www/html/pvd-project, tgt=/var/www/html
  //   → tar -C /var/www/html pvd-project  →  extracted at /var/www/html/pvd-project
  // If tgt === src, the path is identical on both sides.
  const effectiveTgt = (!tgtPath || tgtPath === srcNorm)
    ? srcNorm
    : `${tgtPath.replace(/\/$/, '')}/${baseName}`

  items.push({ label: 'Comparing paths', source: srcNorm, target: effectiveTgt, status: 'skip', note: 'paths being verified on each side' })

  // Check target path exists before doing anything else
  const { stdout: tgtExists } = await singleExec(tgt, `[ -e "${effectiveTgt}" ] && echo yes || echo no`)
  if (tgtExists.trim() !== 'yes') {
    items.push({ label: 'Target path exists', source: 'yes', target: 'no', status: 'error', note: `${effectiveTgt} not found on target` })
    return items
  }

  const [srcCount, tgtCount] = await Promise.all([
    singleExec(src, `find "${srcNorm}" -type f 2>/dev/null | wc -l`),
    singleExec(tgt, `find "${effectiveTgt}" -type f 2>/dev/null | wc -l`),
  ])
  items.push(verifyItem('File count', srcCount.stdout.trim(), tgtCount.stdout.trim()))

  const [srcDirs, tgtDirs] = await Promise.all([
    singleExec(src, `find "${srcNorm}" -type d 2>/dev/null | wc -l`),
    singleExec(tgt, `find "${effectiveTgt}" -type d 2>/dev/null | wc -l`),
  ])
  items.push(verifyItem('Dir count', srcDirs.stdout.trim(), tgtDirs.stdout.trim()))

  const [srcSize, tgtSize] = await Promise.all([
    singleExec(src, `du -sb "${srcNorm}" 2>/dev/null | cut -f1`),
    singleExec(tgt, `du -sb "${effectiveTgt}" 2>/dev/null | cut -f1`),
  ])
  items.push(verifyItem('Total bytes', srcSize.stdout.trim(), tgtSize.stdout.trim()))

  // Checksum of first 50 files (paths stripped to relative so they match across locations)
  const [srcCheck, tgtCheck] = await Promise.all([
    singleExec(src, `find "${srcNorm}" -type f | sort | head -50 | xargs md5sum 2>/dev/null | awk '{print $1}' | md5sum | cut -d' ' -f1`),
    singleExec(tgt, `find "${effectiveTgt}" -type f | sort | head -50 | xargs md5sum 2>/dev/null | awk '{print $1}' | md5sum | cut -d' ' -f1`),
  ])
  items.push(verifyItem('Checksum (first 50 files)', srcCheck.stdout.trim(), tgtCheck.stdout.trim(), 'md5 of file checksums — must match for identical content'))

  return items
}

async function verifyConfigs(src: Client, tgt: Client): Promise<VerifyItem[]> {
  const items: VerifyItem[] = []
  const paths = ['/etc/nginx', '/etc/apache2', '/etc/php', '/etc/mysql', '/etc/postgresql', '/etc/redis', '/etc/hosts', '/etc/environment']

  for (const p of paths) {
    const [srcCheck, tgtCheck] = await Promise.all([
      singleExec(src, `[ -e "${p}" ] && find "${p}" -type f | sort | xargs md5sum 2>/dev/null | md5sum | cut -d' ' -f1 || echo "not present"`),
      singleExec(tgt, `[ -e "${p}" ] && find "${p}" -type f | sort | xargs md5sum 2>/dev/null | md5sum | cut -d' ' -f1 || echo "not present"`),
    ])
    if (srcCheck.stdout.trim() !== 'not present') {
      items.push(verifyItem(p, srcCheck.stdout.trim(), tgtCheck.stdout.trim(), 'checksum of all files in path'))
    }
  }

  return items
}

async function verifyCron(src: Client, tgt: Client, users: string[]): Promise<VerifyItem[]> {
  const items: VerifyItem[] = []

  for (const user of users) {
    const [s, t] = await Promise.all([
      singleExec(src, `crontab -l -u ${user} 2>/dev/null | grep -v '^#' | grep -v '^$' | wc -l`),
      singleExec(tgt, `crontab -l -u ${user} 2>/dev/null | grep -v '^#' | grep -v '^$' | wc -l`),
    ])
    items.push(verifyItem(`Crontab entries: ${user}`, s.stdout.trim(), t.stdout.trim()))
  }

  const [srcCrond, tgtCrond] = await Promise.all([
    singleExec(src, 'find /etc/cron.d /etc/cron.daily /etc/cron.weekly /etc/cron.monthly -type f 2>/dev/null | wc -l'),
    singleExec(tgt, 'find /etc/cron.d /etc/cron.daily /etc/cron.weekly /etc/cron.monthly -type f 2>/dev/null | wc -l'),
  ])
  items.push(verifyItem('Cron.d file count', srcCrond.stdout.trim(), tgtCrond.stdout.trim()))

  return items
}

export async function runVerifyJob(
  job: TransferJob,
  srcClient: Client,
  tgtClient: Client,
): Promise<VerifyReport> {
  let items: VerifyItem[] = []

  try {
    switch (job.type) {
      case 'mysql':      items = await verifyMySQL(srcClient, tgtClient, job.options.database ?? ''); break
      case 'postgresql': items = await verifyPostgreSQL(srcClient, tgtClient, job.options.database ?? ''); break
      case 'mongodb':    items = await verifyMongoDB(srcClient, tgtClient, job.options.database ?? ''); break
      case 'redis':      items = await verifyRedis(srcClient, tgtClient); break
      case 'files':      items = await verifyFiles(srcClient, tgtClient, job.options.source_path ?? '/', job.options.target_path ?? job.options.source_path ?? '/'); break
      case 'configs':    items = await verifyConfigs(srcClient, tgtClient); break
      case 'cron': {
        const users = job.options.users ? job.options.users.split(',').map((u) => u.trim()) : ['root']
        items = await verifyCron(srcClient, tgtClient, users)
        break
      }
    }
  } catch (err) {
    items.push({ label: 'Verification error', source: '', target: '', status: 'error', note: (err as Error).message })
  }

  return {
    job_id: job.id,
    ran_at: new Date().toISOString(),
    type: job.type,
    items,
    passed: items.filter((i) => i.status === 'match').length,
    failed: items.filter((i) => i.status === 'mismatch' || i.status === 'error').length,
    warnings: items.filter((i) => i.status === 'warning').length,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
