import { useEffect, useRef, useState } from 'react'
import { api, Server, MigrationSnapshotMeta, MigrationSnapshotFull, CompareResult, DiffItem, DiffStatus, TransferJob, TransferType, BrowseResult, VerifyReport, VerifyItem, DumpResult, ReadinessReport, ReadinessItem } from '../api/client'

const STATUS_COLOR: Record<DiffStatus, string> = {
  match:    '#22c55e',
  missing:  '#ef4444',
  mismatch: '#f59e0b',
  extra:    '#6b7280',
}
const STATUS_BG: Record<DiffStatus, string> = {
  match:    'rgba(34,197,94,0.08)',
  missing:  'rgba(239,68,68,0.10)',
  mismatch: 'rgba(245,158,11,0.10)',
  extra:    'rgba(107,114,128,0.08)',
}
const STATUS_ICON: Record<DiffStatus, string> = {
  match: '✓', missing: '✗', mismatch: '⚠', extra: '+',
}

const SECTIONS = ['System', 'Hardware', 'Storage', 'Packages', 'Services', 'Users', 'Network', 'Databases', 'SSL', 'Docker', 'Web Servers', 'Config Files', 'Cluster', 'Cron']

type Tab = 'snapshots' | 'compare' | 'transfer'

export default function Migration() {
  const [tab, setTab] = useState<Tab>('snapshots')
  const [servers, setServers] = useState<Server[]>([])
  const [snapshots, setSnapshots] = useState<MigrationSnapshotMeta[]>([])
  const [scanning, setScanning] = useState<string | null>(null)   // server_id being scanned
  const [scanForm, setScanForm] = useState({ server_id: '', label: '' })
  const [scanError, setScanError] = useState('')

  const [selectedSnap, setSelectedSnap] = useState<MigrationSnapshotFull | null>(null)
  const [snapLoading, setSnapLoading] = useState(false)
  const [detailSection, setDetailSection] = useState<string>('System')

  const [compareForm, setCompareForm] = useState({ source_id: '', target_id: '' })
  const [comparing, setComparing] = useState(false)
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null)
  const [compareError, setCompareError] = useState('')
  const [diffFilter, setDiffFilter] = useState<DiffStatus | 'all'>('all')
  const [diffSection, setDiffSection] = useState<string>('all')
  const [showChecklist, setShowChecklist] = useState(false)
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set())

  // Transfer tab state
  const [xferForm, setXferForm] = useState({
    source_id: '', target_id: '', type: 'files' as TransferType,
    database: '', source_path: '', target_path: '', users: 'root',
  })
  const [activeJobs, setActiveJobs] = useState<TransferJob[]>([])
  const [xferSubmitting, setXferSubmitting] = useState(false)
  const [xferError, setXferError] = useState('')
  const [xferHistory, setXferHistory] = useState<TransferJob[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeJobIdsRef = useRef<Set<string>>(new Set())
  const [dumpResult, setDumpResult] = useState<DumpResult | null>(null)
  const [dumpLoading, setDumpLoading] = useState(false)
  const [dumpError, setDumpError] = useState('')
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [restoreLog, setRestoreLog] = useState<string[]>([])
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [verifyReport, setVerifyReport] = useState<VerifyReport | null>(null)
  const [verifyJobId, setVerifyJobId] = useState<string | null>(null)
  const [verifyLoading, setVerifyLoading] = useState(false)

  // File browser — source and target panels
  type BrowseSide = 'source' | 'target'
  const [browseInput, setBrowseInput] = useState<Record<BrowseSide, string>>({ source: '/', target: '/' })
  const [browseResult, setBrowseResult] = useState<Record<BrowseSide, BrowseResult | null>>({ source: null, target: null })
  const [browseLoading, setBrowseLoading] = useState<Record<BrowseSide, boolean>>({ source: false, target: false })
  const [browseError, setBrowseError] = useState<Record<BrowseSide, string>>({ source: '', target: '' })

  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [editLabelVal, setEditLabelVal] = useState('')

  // ── Checklist generation ─────────────────────────────────────────────────────

  type ChecklistItem = {
    id: string
    section: string
    priority: 'critical' | 'high' | 'medium' | 'low'
    title: string
    detail: string
    command: string
    status: DiffStatus
  }

  function generateChecklist(diff: DiffItem[]): ChecklistItem[] {
    const actionable = diff.filter((d) => d.status === 'missing' || d.status === 'mismatch')
    const items: ChecklistItem[] = []

    for (const d of actionable) {
      const id = `${d.section}::${d.key}`
      const isMissing = d.status === 'missing'

      switch (d.section) {
        case 'Packages': {
          const pkg = d.key
          items.push({
            id, section: 'Packages',
            priority: 'high',
            title: isMissing ? `Install package: ${pkg}` : `Update package: ${pkg}`,
            detail: isMissing
              ? `Package "${pkg}" exists on source (${d.source_value}) but is missing on target.`
              : `Version mismatch — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `apt-get install -y ${pkg}    # or: yum install -y ${pkg}`
              : `apt-get install -y ${pkg}=${d.source_value}    # pin to source version`,
            status: d.status,
          })
          break
        }
        case 'Services': {
          items.push({
            id, section: 'Services',
            priority: isMissing ? 'critical' : 'high',
            title: isMissing ? `Enable service: ${d.key}` : `Fix service state: ${d.key}`,
            detail: isMissing
              ? `Service "${d.key}" is running on source but missing/inactive on target.`
              : `State mismatch — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `systemctl enable --now ${d.key}`
              : `systemctl restart ${d.key} && systemctl enable ${d.key}`,
            status: d.status,
          })
          break
        }
        case 'Users': {
          items.push({
            id, section: 'Users',
            priority: 'critical',
            title: isMissing ? `Create user: ${d.key}` : `Update user: ${d.key}`,
            detail: isMissing
              ? `User "${d.key}" exists on source but not on target.`
              : `User config differs — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `useradd -m ${d.key}    # then: usermod -aG sudo ${d.key}  (if needed)`
              : `usermod -s ${d.source_value.split('/').pop() ? '/bin/' + d.source_value.split('/').pop() : '/bin/bash'} ${d.key}`,
            status: d.status,
          })
          break
        }
        case 'Network': {
          items.push({
            id, section: 'Network',
            priority: 'high',
            title: isMissing ? `Open port: ${d.key}` : `Network config differs: ${d.key}`,
            detail: isMissing
              ? `Port ${d.key} is open on source but not on target.`
              : `Mismatch — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `ufw allow ${d.key}    # or: firewall-cmd --add-port=${d.key}/tcp --permanent`
              : `# Review /etc/network/interfaces or netplan config`,
            status: d.status,
          })
          break
        }
        case 'SSL': {
          items.push({
            id, section: 'SSL',
            priority: 'critical',
            title: isMissing ? `Copy/reissue certificate: ${d.key}` : `Certificate mismatch: ${d.key}`,
            detail: isMissing
              ? `Certificate for "${d.key}" is on source but missing on target.`
              : `Cert differs — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `# Option 1 — copy: rsync -avz source:${d.key} target:${d.key}\n# Option 2 — reissue: certbot certonly --nginx -d <domain>`
              : `certbot renew --force-renewal    # or re-copy from source`,
            status: d.status,
          })
          break
        }
        case 'Databases': {
          items.push({
            id, section: 'Databases',
            priority: 'critical',
            title: isMissing ? `Migrate database: ${d.key}` : `Database version mismatch: ${d.key}`,
            detail: isMissing
              ? `Database "${d.key}" exists on source but not on target.`
              : `Version mismatch — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `# MySQL: mysqldump ${d.key} | ssh target mysql\n# PG: pg_dump ${d.key} | ssh target psql`
              : `# Upgrade target DB to match source version: ${d.source_value}`,
            status: d.status,
          })
          break
        }
        case 'Docker': {
          items.push({
            id, section: 'Docker',
            priority: 'high',
            title: isMissing ? `Pull Docker image: ${d.key}` : `Docker version mismatch: ${d.key}`,
            detail: isMissing
              ? `Container/image "${d.key}" is on source but missing on target.`
              : `Mismatch — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `docker pull ${d.key}    # then: docker run ... (check compose file)`
              : `# Copy compose file: rsync -avz source:/path/docker-compose.yml target:/path/`,
            status: d.status,
          })
          break
        }
        case 'Web Servers': {
          items.push({
            id, section: 'Web Servers',
            priority: 'high',
            title: isMissing ? `Configure vhost: ${d.key}` : `Vhost differs: ${d.key}`,
            detail: isMissing
              ? `Vhost "${d.key}" is configured on source but missing on target.`
              : `Config differs — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `rsync -avz source:/etc/nginx/sites-available/ target:/etc/nginx/sites-available/\nnginx -t && systemctl reload nginx`
              : `# Edit /etc/nginx/sites-available/${d.key} to match source`,
            status: d.status,
          })
          break
        }
        case 'Config Files': {
          items.push({
            id, section: 'Config Files',
            priority: 'high',
            title: isMissing ? `Copy config/env file: ${d.key}` : `Config file differs: ${d.key}`,
            detail: isMissing
              ? `File "${d.key}" is present on source but missing on target.`
              : `File content differs — check env vars match source.`,
            command: isMissing
              ? `rsync -avz source:${d.key} target:${d.key}`
              : `rsync -avz source:${d.key} target:${d.key}    # overwrite with source version`,
            status: d.status,
          })
          break
        }
        case 'Cron': {
          items.push({
            id, section: 'Cron',
            priority: 'medium',
            title: isMissing ? `Add cron job: ${d.key}` : `Cron schedule differs: ${d.key}`,
            detail: isMissing
              ? `Cron entry "${d.key}" exists on source but not on target.`
              : `Schedule differs — source: ${d.source_value}, target: ${d.target_value}`,
            command: isMissing
              ? `# Add to crontab:\n(crontab -l; echo "${d.source_value}") | crontab -`
              : `crontab -e    # update entry to: ${d.source_value}`,
            status: d.status,
          })
          break
        }
        case 'System': {
          items.push({
            id, section: 'System',
            priority: d.key.includes('kernel') || d.key.includes('os') ? 'high' : 'low',
            title: `System config differs: ${d.key}`,
            detail: `Source: ${d.source_value} | Target: ${d.target_value}`,
            command: d.key === 'timezone'
              ? `timedatectl set-timezone ${d.source_value}`
              : d.key === 'hostname'
              ? `hostnamectl set-hostname ${d.source_value}`
              : `# Review and align system setting: ${d.key}`,
            status: d.status,
          })
          break
        }
        default: {
          if (isMissing || d.status === 'mismatch') {
            items.push({
              id, section: d.section,
              priority: 'medium',
              title: isMissing ? `Missing: ${d.key}` : `Mismatch: ${d.key}`,
              detail: `Source: ${d.source_value}${d.target_value ? ` | Target: ${d.target_value}` : ''}`,
              command: `# Manually review and align: ${d.section} → ${d.key}`,
              status: d.status,
            })
          }
        }
      }
    }

    const order: ChecklistItem['priority'][] = ['critical', 'high', 'medium', 'low']
    return items.sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority))
  }

  function exportChecklist(items: ChecklistItem[]) {
    const src = compareResult?.source.label || compareResult?.source.server_name || 'source'
    const tgt = compareResult?.target.label || compareResult?.target.server_name || 'target'
    const done = checkedItems.size
    const lines = [
      `# Migration Checklist`,
      `**From:** ${src}  **To:** ${tgt}`,
      `**Generated:** ${new Date().toLocaleString()}`,
      `**Progress:** ${done}/${items.length} completed`,
      '',
    ]
    const sections = [...new Set(items.map((i) => i.section))]
    for (const sec of sections) {
      lines.push(`## ${sec}`)
      for (const item of items.filter((i) => i.section === sec)) {
        const check = checkedItems.has(item.id) ? 'x' : ' '
        lines.push(`- [${check}] **[${item.priority.toUpperCase()}]** ${item.title}`)
        lines.push(`  > ${item.detail}`)
        lines.push(`  \`\`\`bash\n  ${item.command}\n  \`\`\``)
        lines.push('')
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `migration-checklist-${Date.now()}.md`; a.click()
    URL.revokeObjectURL(url)
  }

  const PRIORITY_COLOR: Record<ChecklistItem['priority'], string> = {
    critical: '#ef4444', high: '#f59e0b', medium: 'var(--accent-hex)', low: '#6b7280',
  }
  const PRIORITY_BG: Record<ChecklistItem['priority'], string> = {
    critical: 'rgba(239,68,68,0.12)', high: 'rgba(245,158,11,0.12)',
    medium: 'rgba(59,130,246,0.10)', low: 'rgba(107,114,128,0.08)',
  }

  // ── File browser ─────────────────────────────────────────────────────────────

  const browse = async (side: 'source' | 'target', path: string) => {
    const serverId = side === 'source' ? xferForm.source_id : xferForm.target_id
    if (!serverId) { setBrowseError((e) => ({ ...e, [side]: 'Select a server in the form above first.' })); return }
    setBrowseLoading((l) => ({ ...l, [side]: true }))
    setBrowseError((e) => ({ ...e, [side]: '' }))
    try {
      const result = await api.get<BrowseResult>(`/servers/${serverId}/browse?path=${encodeURIComponent(path)}`)
      setBrowseResult((r) => ({ ...r, [side]: result }))
      setBrowseInput((i) => ({ ...i, [side]: result.path }))
    } catch (err: unknown) {
      setBrowseError((e) => ({ ...e, [side]: (err as Error).message || 'Browse failed' }))
    } finally {
      setBrowseLoading((l) => ({ ...l, [side]: false }))
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} K`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} M`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} G`
  }

  // ── Transfer helpers ──────────────────────────────────────────────────────────

  const loadXferHistory = async () => {
    const jobs = await api.get<TransferJob[]>('/migration/transfer').catch(() => [] as TransferJob[])
    setXferHistory(jobs)
  }

  // Single interval polls ALL tracked job IDs and updates the activeJobs array
  const ensurePolling = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const ids = [...activeJobIdsRef.current]
      if (ids.length === 0) { clearInterval(pollRef.current!); pollRef.current = null; return }
      const updated = await Promise.all(ids.map((id) => api.get<TransferJob>(`/migration/transfer/${id}`).catch(() => null)))
      const finished: string[] = []
      setActiveJobs((prev) => {
        const map = new Map(prev.map((j) => [j.id, j]))
        for (const job of updated) {
          if (!job) continue
          map.set(job.id, job)
          if (job.status === 'done' || job.status === 'error') finished.push(job.id)
        }
        return [...map.values()]
      })
      for (const id of finished) activeJobIdsRef.current.delete(id)
      if (finished.length > 0) loadXferHistory()
    }, 1500)
  }

  const addJob = (job: TransferJob) => {
    activeJobIdsRef.current.add(job.id)
    setActiveJobs((prev) => {
      const exists = prev.find((j) => j.id === job.id)
      return exists ? prev.map((j) => j.id === job.id ? job : j) : [job, ...prev]
    })
    ensurePolling()
  }

  const dismissJob = (jobId: string) => {
    activeJobIdsRef.current.delete(jobId)
    setActiveJobs((prev) => prev.filter((j) => j.id !== jobId))
  }

  // Compute field-level validation errors (reactive, shown inline)
  const xferValidation = {
    source_id: !xferForm.source_id ? 'Required — select a source server' : '',
    target_id: !xferForm.target_id ? 'Required — select a target server' : xferForm.source_id && xferForm.source_id === xferForm.target_id ? 'Must be different from source' : '',
    database: ['mysql', 'postgresql', 'mongodb'].includes(xferForm.type) && !xferForm.database ? 'Required — enter the database name' : '',
    source_path: xferForm.type === 'files' && !xferForm.source_path ? 'Required — enter the source path' : '',
    target_path: '',
  }
  const xferReady = Object.values(xferValidation).every((e) => !e)

  const startTransfer = async () => {
    setXferError('')
    if (!xferReady) return

    setXferSubmitting(true)
    try {
      const { job_id } = await api.post<{ job_id: string }>('/migration/transfer', {
        source_id: xferForm.source_id,
        target_id: xferForm.target_id,
        type: xferForm.type,
        options: {
          database: xferForm.database || undefined,
          source_path: xferForm.source_path || undefined,
          target_path: xferForm.target_path || undefined,
          users: xferForm.users || undefined,
        },
      })
      const job = await api.get<TransferJob>(`/migration/transfer/${job_id}`)
      addJob(job)
    } catch (err: unknown) {
      setXferError((err as Error).message || 'Failed to start transfer')
    } finally {
      setXferSubmitting(false)
    }
  }

  const isDbType = ['mysql', 'postgresql', 'mongodb'].includes(xferForm.type)

  const runDump = async () => {
    setDumpError('')
    setDumpResult(null)
    setDumpLoading(true)
    try {
      const result = await api.post<DumpResult>('/migration/dump', {
        server_id: xferForm.source_id,
        type: xferForm.type,
        database: xferForm.database,
      })
      setDumpResult(result)
      // Auto-fill source_path with the dump file, switch to files mode for manual target selection
      setXferForm((f) => ({ ...f, source_path: result.dump_file, type: 'files' }))
      // Auto-browse source server to /tmp so dump file is visible
      await browse('source', '/tmp')
    } catch (err: unknown) {
      setDumpError((err as Error).message || 'Dump failed')
    } finally {
      setDumpLoading(false)
    }
  }

  const runReadinessCheck = async () => {
    setReadiness(null)
    setReadinessLoading(true)
    try {
      const report = await api.post<ReadinessReport>('/migration/restore-check', {
        server_id: xferForm.target_id,
        type: xferForm.type === 'files' && dumpResult ? (['mysql','postgresql','mongodb'].find(t => dumpResult.dump_file.includes(`.${t === 'mysql' ? 'sql' : t === 'postgresql' ? 'pgdump' : 'archive'}`)) ?? 'mysql') : xferForm.type,
        database: xferForm.database,
        dump_file: xferForm.target_path ? `${xferForm.target_path.replace(/\/$/, '')}/${dumpResult?.dump_file.replace(/.*\//, '') ?? ''}` : '',
      })
      setReadiness(report)
    } catch (err: unknown) {
      setReadiness({ items: [{ label: 'Error', status: 'fail', value: (err as Error).message }], ready: false })
    } finally {
      setReadinessLoading(false)
    }
  }

  const runRestore = async () => {
    if (!readiness?.ready) return
    setRestoreError('')
    setRestoreLog([])
    setRestoreLoading(true)
    // Detect type from dump file extension
    const df = dumpResult?.dump_file ?? ''
    const dbType = df.endsWith('.sql.gz') ? 'mysql' : df.endsWith('.pgdump') ? 'postgresql' : 'mongodb'
    const dumpOnTarget = xferForm.target_path
      ? `${xferForm.target_path.replace(/\/$/, '')}/${df.replace(/.*\//, '')}`
      : df
    try {
      const result = await api.post<{ success: boolean; log: string[] }>('/migration/restore', {
        server_id: xferForm.target_id,
        type: dbType,
        database: xferForm.database,
        dump_file: dumpOnTarget,
      })
      setRestoreLog(result.log)
    } catch (err: unknown) {
      setRestoreError((err as Error).message || 'Restore failed')
      const errData = (err as { data?: { log?: string[] } }).data
      if (errData?.log) setRestoreLog(errData.log)
    } finally {
      setRestoreLoading(false)
    }
  }

  const runVerify = async (jobId: string) => {
    setVerifyLoading(true)
    setVerifyJobId(jobId)
    setVerifyReport(null)
    try {
      const report = await api.post<VerifyReport>(`/migration/transfer/${jobId}/verify`)
      setVerifyReport(report)
    } catch (err: unknown) {
      setVerifyReport({ job_id: jobId, ran_at: new Date().toISOString(), type: 'files', items: [{ label: 'Error', source: '', target: '', status: 'error', note: (err as Error).message }], passed: 0, failed: 1, warnings: 0 })
    } finally {
      setVerifyLoading(false)
    }
  }

  useEffect(() => { loadXferHistory() }, [])
  useEffect(() => () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }, [])

  const load = async () => {
    const [svrs, snaps] = await Promise.all([
      api.get<Server[]>('/servers').catch(() => [] as Server[]),
      api.get<MigrationSnapshotMeta[]>('/migration/snapshots').catch(() => [] as MigrationSnapshotMeta[]),
    ])
    setServers(svrs)
    setSnapshots(snaps)
  }

  useEffect(() => { load() }, [])

  const runScan = async () => {
    if (!scanForm.server_id) { setScanError('Select a server'); return }
    setScanError('')
    setScanning(scanForm.server_id)
    try {
      await api.post('/migration/snapshots', { server_id: scanForm.server_id, label: scanForm.label })
      setScanForm((f) => ({ ...f, label: '' }))
      await load()
    } catch (err: unknown) {
      setScanError((err as Error).message)
    } finally {
      setScanning(null)
    }
  }

  const deleteSnap = async (id: string) => {
    await api.delete(`/migration/snapshots/${id}`).catch(() => {})
    setSnapshots((s) => s.filter((x) => x.id !== id))
    if (selectedSnap?.id === id) setSelectedSnap(null)
  }

  const loadDetail = async (id: string) => {
    setSnapLoading(true)
    try {
      const full = await api.get<MigrationSnapshotFull>(`/migration/snapshots/${id}`)
      setSelectedSnap(full)
      setDetailSection('System')
    } catch { /* ignore */ }
    finally { setSnapLoading(false) }
  }

  const saveLabel = async (id: string) => {
    await api.patch(`/migration/snapshots/${id}`, { label: editLabelVal }).catch(() => {})
    setSnapshots((s) => s.map((x) => x.id === id ? { ...x, label: editLabelVal } : x))
    setEditingLabel(null)
  }

  const runCompare = async () => {
    if (!compareForm.source_id || !compareForm.target_id) { setCompareError('Select both snapshots'); return }
    if (compareForm.source_id === compareForm.target_id) { setCompareError('Source and target must be different'); return }
    setCompareError('')
    setComparing(true)
    try {
      const result = await api.post<CompareResult>('/migration/compare', compareForm)
      setCompareResult(result)
      setDiffFilter('all')
      setDiffSection('all')
    } catch (err: unknown) {
      setCompareError((err as Error).message)
    } finally {
      setComparing(false)
    }
  }

  // ── Snapshot detail renderer ─────────────────────────────────────────────────

  const snap = selectedSnap?.snapshot

  function renderDetail() {
    if (!snap) return null
    switch (detailSection) {
      case 'System': return (
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
          <tbody>
            {[
              ['Hostname', snap.system?.hostname],
              ['OS', snap.system?.os_name + ' ' + snap.system?.os_version],
              ['Kernel', snap.system?.kernel],
              ['Architecture', snap.system?.arch],
              ['Timezone', snap.system?.timezone],
              ['Locale', snap.system?.locale],
              ['Uptime', snap.system?.uptime],
              ['CPU', snap.hardware?.cpu_model + ' (' + snap.hardware?.cpu_cores + ' cores)'],
              ['RAM', snap.hardware?.ram_total_mb + ' MB'],
              ['Swap', snap.hardware?.swap_total_mb + ' MB'],
            ].map(([k, v]) => (
              <tr key={k} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--text-muted)', width: '35%', fontWeight: 500 }}>{k}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text-heading)', fontFamily: 'monospace', fontSize: 11 }}>{v || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )

      case 'Network': return (
        <div className="space-y-3">
          <div>
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>INTERFACES</p>
            {(snap.network?.interfaces ?? []).map((iface: { name: string; addresses: string[] }) => (
              <div key={iface.name} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border-weak)', display: 'flex', gap: 12 }}>
                <span style={{ fontWeight: 600, color: 'var(--text-heading)', width: 80 }}>{iface.name}</span>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: 11 }}>{iface.addresses.join(', ')}</span>
              </div>
            ))}
          </div>
          <div>
            <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>OPEN PORTS</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {(snap.network?.open_ports ?? []).map((p: { port: number; service: string }) => (
                <span key={p.port} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 5,
                  background: 'var(--bg-input)', color: 'var(--text-secondary)', fontFamily: 'monospace',
                }}>
                  {p.port}{p.service ? ` (${p.service})` : ''}
                </span>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            <div><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Gateway: </span><code style={{ fontSize: 11 }}>{snap.network?.default_gateway || '—'}</code></div>
            <div><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>DNS: </span><code style={{ fontSize: 11 }}>{(snap.network?.dns_servers ?? []).join(', ') || '—'}</code></div>
          </div>
        </div>
      )

      case 'Storage': return (
        <div className="space-y-3">
          <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>MOUNT POINTS</p>
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 420 }}>
            <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'left', borderBottom: '1px solid var(--border-med)' }}>
              {['Mount', 'Device', 'FS', 'Size', 'Used', 'Avail', '%'].map((h) => <th key={h} style={{ padding: '4px 8px', fontWeight: 500, fontSize: 10 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {(snap.storage?.mounts ?? []).map((m: { mount: string; device: string; fstype: string; size: string; used: string; avail: string; use_pct: string }, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                  {[m.mount, m.device, m.fstype, m.size, m.used, m.avail, m.use_pct].map((v, j) => (
                    <td key={j} style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: 11, color: j === 6 && parseInt(v) > 85 ? '#ef4444' : 'var(--text-secondary)' }}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {(snap.storage?.large_dirs ?? []).length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', margin: '8px 0 4px' }}>LARGE DIRECTORIES</p>
              {(snap.storage.large_dirs ?? []).map((d: { path: string; size: string }, i: number) => (
                <div key={i} style={{ display: 'flex', gap: 12, fontSize: 12, padding: '3px 0', fontFamily: 'monospace' }}>
                  <span style={{ color: '#f59e0b', width: 60 }}>{d.size}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{d.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )

      case 'Packages': return (
        <div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            Manager: <strong>{snap.packages?.manager}</strong> · {snap.packages?.total} packages
          </p>
          <div style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
              <thead><tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-med)' }}>
                <th style={{ padding: '4px 8px', textAlign: 'left', fontSize: 10, fontWeight: 500 }}>Package</th>
                <th style={{ padding: '4px 8px', textAlign: 'left', fontSize: 10, fontWeight: 500 }}>Version</th>
              </tr></thead>
              <tbody>
                {(snap.packages?.list ?? []).map((p: { name: string; version: string }, i: number) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                    <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>{p.name}</td>
                    <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{p.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )

      case 'Services': return (
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-med)' }}>
              <th style={{ padding: '4px 8px', textAlign: 'left', fontSize: 10, fontWeight: 500 }}>Service</th>
              <th style={{ padding: '4px 8px', textAlign: 'left', fontSize: 10, fontWeight: 500 }}>Status</th>
              <th style={{ padding: '4px 8px', textAlign: 'left', fontSize: 10, fontWeight: 500 }}>Enabled</th>
            </tr></thead>
            <tbody>
              {(snap.services?.running ?? []).map((s: { name: string; status: string; enabled: boolean }, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                  <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>{s.name}</td>
                  <td style={{ padding: '3px 8px', fontSize: 11, color: s.status === 'active' ? '#22c55e' : s.status === 'failed' ? '#ef4444' : 'var(--text-muted)' }}>{s.status}</td>
                  <td style={{ padding: '3px 8px', fontSize: 11, color: s.enabled ? '#22c55e' : 'var(--text-muted)' }}>{s.enabled ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

      case 'Users': return (
        <div className="space-y-4">
          <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-med)' }}>
              {['User', 'UID', 'Shell', 'Groups'].map((h) => <th key={h} style={{ padding: '4px 8px', textAlign: 'left', fontSize: 10, fontWeight: 500 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {(snap.users?.local_users ?? []).map((u: { username: string; uid: number; shell: string; groups: string }, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                  <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, fontWeight: 600, color: 'var(--text-heading)' }}>{u.username}</td>
                  <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{u.uid}</td>
                  <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>{u.shell}</td>
                  <td style={{ padding: '4px 8px', fontSize: 11, color: 'var(--text-muted)' }}>{u.groups}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(snap.users?.sudo_rules ?? []).length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>SUDO RULES</p>
              {snap.users.sudo_rules.map((r: string, i: number) => (
                <pre key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', padding: '2px 0', margin: 0 }}>{r}</pre>
              ))}
            </div>
          )}
        </div>
      )

      case 'Databases': return (
        <div className="space-y-3">
          {[
            { label: 'MySQL', data: snap.databases?.mysql },
            { label: 'PostgreSQL', data: snap.databases?.postgresql },
            { label: 'MongoDB', data: snap.databases?.mongodb },
            { label: 'Redis', data: snap.databases?.redis },
          ].map(({ label, data }) => data?.installed && (
            <div key={label} style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)' }}>{label}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{data.version}</span>
              </div>
              {data.databases?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {data.databases.map((db: string) => (
                    <span key={db} style={{ fontSize: 11, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 5, background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>{db}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {!snap.databases?.mysql?.installed && !snap.databases?.postgresql?.installed && !snap.databases?.mongodb?.installed && !snap.databases?.redis?.installed && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No databases detected.</p>
          )}
        </div>
      )

      case 'Docker': return snap.docker?.installed ? (
        <div className="space-y-3">
          <p style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{snap.docker.version}</p>
          {snap.docker.containers?.length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>CONTAINERS</p>
              <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                <thead><tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-med)' }}>
                  {['Name', 'Image', 'Status', 'Ports'].map((h) => <th key={h} style={{ padding: '3px 8px', textAlign: 'left', fontSize: 10, fontWeight: 500 }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {snap.docker.containers.map((c: { name: string; image: string; status: string; ports: string }, i: number) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                      <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-heading)' }}>{c.name}</td>
                      <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{c.image}</td>
                      <td style={{ padding: '3px 8px', fontSize: 11, color: c.status.startsWith('Up') ? '#22c55e' : '#ef4444' }}>{c.status}</td>
                      <td style={{ padding: '3px 8px', fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)' }}>{c.ports}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {snap.docker.compose_files?.length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>COMPOSE FILES</p>
              {snap.docker.compose_files.map((f: string, i: number) => (
                <p key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', margin: '2px 0' }}>{f}</p>
              ))}
            </div>
          )}
        </div>
      ) : <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Docker not installed.</p>

      case 'Web Servers': return (
        <div className="space-y-3">
          {snap.web_servers?.nginx?.installed && (
            <div style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '10px 12px' }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 4 }}>nginx <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{snap.web_servers.nginx.version}</span></p>
              {snap.web_servers.nginx.vhosts.map((v: string, i: number) => <p key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', margin: '2px 0' }}>{v}</p>)}
            </div>
          )}
          {snap.web_servers?.apache?.installed && (
            <div style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '10px 12px' }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 4 }}>Apache <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{snap.web_servers.apache.version}</span></p>
              {snap.web_servers.apache.vhosts.map((v: string, i: number) => <p key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', margin: '2px 0' }}>{v}</p>)}
            </div>
          )}
          {!snap.web_servers?.nginx?.installed && !snap.web_servers?.apache?.installed && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No web servers detected.</p>
          )}
        </div>
      )

      case 'SSL': return (
        <div className="space-y-2">
          {(snap.ssl?.certificates ?? []).length === 0
            ? <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No certificates found.</p>
            : (snap.ssl.certificates ?? []).map((c: { subject: string; expiry: string; days_left: number; path: string }, i: number) => (
              <div key={i} style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '8px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-heading)' }}>{c.subject}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 5,
                    background: c.days_left < 30 ? 'rgba(239,68,68,0.15)' : c.days_left < 90 ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.1)',
                    color: c.days_left < 30 ? '#ef4444' : c.days_left < 90 ? '#f59e0b' : '#22c55e',
                  }}>{c.days_left}d left</span>
                </div>
                <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', margin: '3px 0 0' }}>{c.path}</p>
              </div>
            ))
          }
        </div>
      )

      case 'Cron': return (
        <div className="space-y-3">
          {snap.systemd_timers?.length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>SYSTEMD TIMERS</p>
              {snap.systemd_timers.map((t: { name: string; next: string; last: string }, i: number) => (
                <div key={i} style={{ fontSize: 11, padding: '3px 0', borderBottom: '1px solid var(--border-weak)', display: 'flex', gap: 12 }}>
                  <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)', flex: 1 }}>{t.name}</span>
                  <span style={{ color: 'var(--text-muted)', width: 100 }}>next: {t.next}</span>
                </div>
              ))}
            </div>
          )}
          {snap.cron?.user_crons?.map((uc: { user: string; entries: string[] }) => (
            <div key={uc.user}>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>CRON — {uc.user}</p>
              {uc.entries.map((e: string, i: number) => (
                <pre key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', margin: '2px 0' }}>{e}</pre>
              ))}
            </div>
          ))}
          {snap.cron?.system_crons?.length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>SYSTEM CRON FILES</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {snap.cron.system_crons.map((f: string, i: number) => (
                  <span key={i} style={{ fontSize: 11, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 5, background: 'var(--bg-input)', color: 'var(--text-muted)' }}>{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )

      case 'Hardware': return (
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
          <tbody>
            {[
              ['CPU Model', snap.hardware?.cpu_model],
              ['CPU Cores', snap.hardware?.cpu_cores],
              ['RAM Total', snap.hardware?.ram_total_mb != null ? snap.hardware.ram_total_mb + ' MB' : undefined],
              ['Swap Total', snap.hardware?.swap_total_mb != null ? snap.hardware.swap_total_mb + ' MB' : undefined],
              ['Disk Total', snap.hardware?.disk_total_gb != null ? snap.hardware.disk_total_gb + ' GB' : undefined],
              ['Disk Used', snap.hardware?.disk_used_gb != null ? snap.hardware.disk_used_gb + ' GB' : undefined],
            ].map(([k, v]) => (
              <tr key={k} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                <td style={{ padding: '6px 8px', color: 'var(--text-muted)', width: '35%', fontWeight: 500 }}>{k}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text-heading)', fontFamily: 'monospace', fontSize: 11 }}>{v ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )

      case 'Config Files': return (
        <div className="space-y-2">
          {(snap.env_files ?? []).length === 0
            ? <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No config/env files found.</p>
            : (snap.env_files ?? []).map((f: { path: string; vars: string[] }, i: number) => (
              <div key={i} style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '8px 12px' }}>
                <p style={{ fontSize: 11, fontWeight: 600, fontFamily: 'monospace', color: 'var(--text-heading)', marginBottom: 4 }}>{f.path}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {(f.vars ?? []).map((v: string, j: number) => (
                    <span key={j} style={{ fontSize: 10, fontFamily: 'monospace', padding: '1px 6px', borderRadius: 4, background: 'var(--bg-card)', color: 'var(--text-muted)' }}>{v}</span>
                  ))}
                </div>
              </div>
            ))
          }
        </div>
      )

      case 'Cluster': {
        const cl = snap.cluster
        if (!cl) return <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Cluster data not available.</p>

        type ClusterEntry = { name: string; icon: string; detail: React.ReactNode }
        const entries: ClusterEntry[] = []

        if (cl.kubernetes?.detected) entries.push({ name: 'Kubernetes', icon: '☸', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Role: <strong>{cl.kubernetes.role}</strong> · Nodes: {cl.kubernetes.nodes.length}
            {cl.kubernetes.namespaces?.length > 0 && <> · Namespaces: {cl.kubernetes.namespaces.slice(0, 5).join(', ')}{cl.kubernetes.namespaces.length > 5 ? ` +${cl.kubernetes.namespaces.length - 5}` : ''}</>}
          </div>
        )})

        if (cl.docker_swarm?.detected) entries.push({ name: 'Docker Swarm', icon: '🐳', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Role: <strong>{cl.docker_swarm.role}</strong> · Nodes: {cl.docker_swarm.nodes.length}</div>
        )})

        if (cl.pacemaker?.detected) entries.push({ name: 'Pacemaker / Corosync', icon: '♻', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Nodes: {cl.pacemaker.nodes.length > 0 ? cl.pacemaker.nodes.join(', ') : '—'}<br/>
            Resources: {cl.pacemaker.resources.length}
          </div>
        )})

        if (cl.galera?.detected) entries.push({ name: 'Galera (MySQL/MariaDB)', icon: '🗄', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Cluster size: <strong>{cl.galera.cluster_size}</strong> · {cl.galera.status}</div>
        )})

        if (cl.mysql_replication?.detected) entries.push({ name: 'MySQL Replication', icon: '🗄', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Role: <strong>{cl.mysql_replication.role}</strong> · Mode: {cl.mysql_replication.mode.replace('_', ' ')}
            {cl.mysql_replication.role === 'primary' && <> · Replicas: {cl.mysql_replication.replicas}</>}
            {cl.mysql_replication.group_members?.length > 0 && <> · Members: {cl.mysql_replication.group_members.join(', ')}</>}
          </div>
        )})

        if (cl.pg_replication?.detected) entries.push({ name: 'PostgreSQL Replication', icon: '🐘', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Role: <strong>{cl.pg_replication.role}</strong>
            {cl.pg_replication.standbys?.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {cl.pg_replication.standbys.map((s: { host: string; state: string; sync_state: string }, i: number) => (
                  <div key={i} style={{ fontFamily: 'monospace', fontSize: 10 }}>{s.host} — {s.state} ({s.sync_state})</div>
                ))}
              </div>
            )}
          </div>
        )})

        if (cl.patroni?.detected) entries.push({ name: 'Patroni (PostgreSQL HA)', icon: '🐘', detail: (
          <pre style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-secondary)', margin: 0, whiteSpace: 'pre-wrap' }}>{cl.patroni.status || '—'}</pre>
        )})

        if (cl.mongodb?.detected) entries.push({ name: 'MongoDB', icon: '🍃', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Mode: <strong>{cl.mongodb.mode.replace('_', ' ')}</strong>
            {cl.mongodb.set_name && <> · Set: <code style={{ fontSize: 10 }}>{cl.mongodb.set_name}</code></>}
            {cl.mongodb.members?.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {cl.mongodb.members.map((m: { host: string; state: string }, i: number) => (
                  <div key={i} style={{ fontFamily: 'monospace', fontSize: 10 }}>{m.host} — <span style={{ color: m.state === 'PRIMARY' ? '#22c55e' : 'var(--text-muted)' }}>{m.state}</span></div>
                ))}
              </div>
            )}
          </div>
        )})

        if (cl.redis_cluster?.detected) entries.push({ name: 'Redis Cluster', icon: '⚡', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Mode: <strong>{cl.redis_cluster.mode}</strong>{cl.redis_cluster.nodes?.length > 0 && <> · Nodes: {cl.redis_cluster.nodes.join(', ')}</>}</div>
        )})

        if (cl.cassandra?.detected) entries.push({ name: 'Cassandra', icon: '💎', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {cl.cassandra.version && <span style={{ marginRight: 12 }}>{cl.cassandra.version}</span>}
            {cl.cassandra.datacenter && <span style={{ marginRight: 12 }}>DC: <strong>{cl.cassandra.datacenter}</strong></span>}
            Nodes: {cl.cassandra.nodes.length > 0 ? cl.cassandra.nodes.join(', ') : '—'}
          </div>
        )})

        if (cl.elasticsearch?.detected) entries.push({ name: 'Elasticsearch / OpenSearch', icon: '🔍', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Cluster: <strong>{cl.elasticsearch.cluster_name}</strong> · Nodes: {cl.elasticsearch.nodes}
            <span style={{
              marginLeft: 8, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
              background: cl.elasticsearch.status === 'green' ? 'rgba(34,197,94,0.15)' : cl.elasticsearch.status === 'yellow' ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
              color: cl.elasticsearch.status === 'green' ? '#22c55e' : cl.elasticsearch.status === 'yellow' ? '#f59e0b' : '#ef4444',
            }}>{cl.elasticsearch.status}</span>
          </div>
        )})

        if (cl.haproxy?.detected) entries.push({ name: 'HAProxy', icon: '⚖', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{cl.haproxy.version}</div>
        )})

        if (cl.keepalived?.detected) entries.push({ name: 'keepalived', icon: '🔀', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>VIPs: {cl.keepalived.virtual_ips.join(', ') || '—'}</div>
        )})

        if (cl.glusterfs?.detected) entries.push({ name: 'GlusterFS', icon: '🗂', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Peers: {cl.glusterfs.peers.join(', ')} · Volumes: {cl.glusterfs.volumes.join(', ')}</div>
        )})

        if (cl.ceph?.detected) entries.push({ name: 'Ceph', icon: '🪸', detail: (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Health: <strong>{cl.ceph.health}</strong></div>
        )})

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {entries.length === 0
              ? <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>No cluster technologies detected on this server.</p>
              : entries.map(({ name, icon, detail }) => (
                <div key={name} style={{ background: 'var(--bg-input)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ fontSize: 16, lineHeight: 1.3, flexShrink: 0 }}>{icon}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', margin: 0, marginBottom: 4 }}>{name}</p>
                    {detail}
                  </div>
                </div>
              ))
            }
          </div>
        )
      }

      default: return <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Select a section.</p>
    }
  }

  // ── Diff view ────────────────────────────────────────────────────────────────

  const filteredDiff = (compareResult?.diff ?? []).filter((d) => {
    const statusOk = diffFilter === 'all' || d.status === diffFilter
    const sectionOk = diffSection === 'all' || d.section === diffSection
    return statusOk && sectionOk
  })

  const diffSections = [...new Set((compareResult?.diff ?? []).map((d) => d.section))]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-white">Migration</h1>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['snapshots', 'compare', 'transfer'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} type="button" style={{
              padding: '6px 16px', fontSize: 13, borderRadius: 7, border: 'none', cursor: 'pointer',
              fontWeight: tab === t ? 600 : 400,
              background: tab === t ? 'var(--accent-hex)' : 'var(--bg-card)',
              color: tab === t ? 'white' : 'var(--text-secondary)',
            }}>
              {t === 'snapshots' ? '📸 Snapshots' : t === 'compare' ? '⇄ Compare' : '⇒ Transfer'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Snapshots tab ─────────────────────────────────────────────────── */}
      {tab === 'snapshots' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" style={{ alignItems: 'start' }}>

          {/* Left: scan form + list */}
          <div className="space-y-4">
            {/* New scan form */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 10 }}>Run Discovery</p>
              <div className="space-y-2">
                <select
                  value={scanForm.server_id}
                  onChange={(e) => setScanForm((f) => ({ ...f, server_id: e.target.value }))}
                  style={{
                    width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7,
                    background: 'var(--bg-input)', border: '1px solid var(--border-med)',
                    color: 'var(--text-heading)', outline: 'none',
                  }}>
                  <option value="">— Select server —</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input
                  value={scanForm.label}
                  onChange={(e) => setScanForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Label (optional)"
                  style={{
                    width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7,
                    background: 'var(--bg-input)', border: '1px solid var(--border-med)',
                    color: 'var(--text-heading)', outline: 'none', boxSizing: 'border-box',
                  }} />
                {scanError && <p style={{ fontSize: 11, color: '#ef4444' }}>{scanError}</p>}
                <button
                  onClick={runScan}
                  disabled={!!scanning}
                  style={{
                    width: '100%', padding: '8px', fontSize: 12, fontWeight: 600,
                    borderRadius: 7, border: 'none', cursor: scanning ? 'not-allowed' : 'pointer',
                    background: 'var(--accent-hex)', color: 'white', opacity: scanning ? 0.6 : 1,
                  }}>
                  {scanning ? '⏳ Scanning… (30–60 s)' : '▶ Run Discovery'}
                </button>
              </div>
            </div>

            {/* Snapshot list */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-med)', fontSize: 12, fontWeight: 600, color: 'var(--text-heading)' }}>
                Saved Snapshots ({snapshots.length})
              </div>
              {snapshots.length === 0 && (
                <p style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>No snapshots yet. Run a discovery above.</p>
              )}
              {snapshots.map((s) => (
                <div key={s.id}
                  onClick={() => loadDetail(s.id)}
                  style={{
                    padding: '10px 14px', borderBottom: '1px solid var(--border-weak)', cursor: 'pointer',
                    background: selectedSnap?.id === s.id ? 'var(--sidebar-active-bg)' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { if (selectedSnap?.id !== s.id) e.currentTarget.style.background = 'var(--bg-input)' }}
                  onMouseLeave={(e) => { if (selectedSnap?.id !== s.id) e.currentTarget.style.background = 'transparent' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {editingLabel === s.id ? (
                        <input
                          value={editLabelVal}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setEditLabelVal(e.target.value)}
                          onBlur={() => saveLabel(s.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(s.id); if (e.key === 'Escape') setEditingLabel(null) }}
                          style={{ fontSize: 12, background: 'var(--bg-input)', border: '1px solid var(--accent-hex)', borderRadius: 4, padding: '2px 6px', color: 'var(--text-heading)', width: '100%' }} />
                      ) : (
                        <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>{s.label || s.server_name}</p>
                      )}
                      <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 0' }}>{s.server_name} · {new Date(s.created_at).toLocaleString()}</p>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setEditingLabel(s.id); setEditLabelVal(s.label || '') }}
                        style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background: 'var(--bg-input)', color: 'var(--text-muted)' }}>✏</button>
                      <a href={`/api/migration/snapshots/${s.id}/export`} download
                        style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, textDecoration: 'none', background: 'var(--bg-input)', color: 'var(--text-muted)' }}>↓</a>
                      <button onClick={() => deleteSnap(s.id)}
                        style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: 'none', cursor: 'pointer', background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>✕</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: detail view */}
          <div className="lg:col-span-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
            {!selectedSnap && !snapLoading && (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Select a snapshot to view details.
              </div>
            )}
            {snapLoading && (
              <div style={{ padding: 32, textAlign: 'center' }}>
                <div className="inline-block w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {selectedSnap && !snapLoading && (
              <>
                {/* Header */}
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-med)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>{selectedSnap.label || selectedSnap.server_name}</p>
                    <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
                      {selectedSnap.server_name} · {new Date(selectedSnap.created_at).toLocaleString()}
                      {snap?.discovered_at ? ` · discovered ${new Date(snap.discovered_at).toLocaleString()}` : ''}
                    </p>
                  </div>
                  <a href={`/api/migration/snapshots/${selectedSnap.id}/export`} download
                    style={{ fontSize: 11, padding: '5px 12px', borderRadius: 6, textDecoration: 'none', background: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                    ↓ Export JSON
                  </a>
                </div>

                {/* Section tabs */}
                <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-med)', padding: '0 8px', overflowX: 'auto' }}>
                  {SECTIONS.map((s) => (
                    <button key={s} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setDetailSection(s)}
                      style={{
                        padding: '8px 12px', fontSize: 12, border: 'none', cursor: 'pointer', background: 'none',
                        borderBottom: detailSection === s ? '2px solid var(--accent-hex)' : '2px solid transparent',
                        color: detailSection === s ? 'var(--accent-hex)' : 'var(--text-secondary)',
                        whiteSpace: 'nowrap', transition: 'color 0.1s', marginBottom: -1,
                      }}>
                      {s}
                    </button>
                  ))}
                </div>

                {/* Section content */}
                <div style={{ padding: 16, minHeight: 300, maxHeight: 480, overflowY: 'auto' }}>
                  {renderDetail()}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Compare tab ──────────────────────────────────────────────────── */}
      {tab === 'compare' && (
        <div className="space-y-4">
          {/* Compare form */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 16 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', marginBottom: 12 }}>Compare Snapshots</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>SOURCE (migrate from)</label>
                <select value={compareForm.source_id} onChange={(e) => setCompareForm((f) => ({ ...f, source_id: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: '1px solid var(--border-med)', color: 'var(--text-heading)', outline: 'none' }}>
                  <option value="">— Select snapshot —</option>
                  {snapshots.map((s) => <option key={s.id} value={s.id}>{s.label || s.server_name} · {new Date(s.created_at).toLocaleDateString()}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>TARGET (migrate to)</label>
                <select value={compareForm.target_id} onChange={(e) => setCompareForm((f) => ({ ...f, target_id: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: '1px solid var(--border-med)', color: 'var(--text-heading)', outline: 'none' }}>
                  <option value="">— Select snapshot —</option>
                  {snapshots.map((s) => <option key={s.id} value={s.id}>{s.label || s.server_name} · {new Date(s.created_at).toLocaleDateString()}</option>)}
                </select>
              </div>
            </div>
            {compareError && <p style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{compareError}</p>}
            <button onClick={runCompare} disabled={comparing}
              style={{
                marginTop: 10, padding: '8px 20px', fontSize: 12, fontWeight: 600, borderRadius: 7, border: 'none',
                cursor: comparing ? 'not-allowed' : 'pointer', background: 'var(--accent-hex)', color: 'white', opacity: comparing ? 0.6 : 1,
              }}>
              {comparing ? 'Comparing…' : '⇄ Run Comparison'}
            </button>
          </div>

          {compareResult && (
            <>
              {/* Summary */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(['match', 'missing', 'mismatch', 'extra'] as DiffStatus[]).map((s) => (
                  <div key={s} style={{
                    padding: '10px 18px', borderRadius: 10, flex: 1, minWidth: 80, textAlign: 'center',
                    background: STATUS_BG[s], border: `1px solid ${STATUS_COLOR[s]}30`,
                  }}>
                    <p style={{ fontSize: 22, fontWeight: 700, color: STATUS_COLOR[s], margin: 0 }}>{compareResult.summary[s]}</p>
                    <p style={{ fontSize: 11, color: STATUS_COLOR[s], margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>{s}</p>
                  </div>
                ))}
              </div>

              {/* Filters */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['all', 'missing', 'mismatch', 'extra', 'match'] as const).map((f) => (
                    <button key={f} onClick={() => setDiffFilter(f)} type="button" style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 6, border: 'none', cursor: 'pointer',
                      fontWeight: diffFilter === f ? 700 : 400,
                      background: diffFilter === f ? (f === 'all' ? 'var(--accent-hex)' : STATUS_COLOR[f as DiffStatus]) : 'var(--bg-card)',
                      color: diffFilter === f ? 'white' : 'var(--text-secondary)',
                    }}>
                      {f === 'all' ? `All (${compareResult.diff.length})` : `${STATUS_ICON[f as DiffStatus]} ${f.charAt(0).toUpperCase() + f.slice(1)}`}
                    </button>
                  ))}
                </div>
                <select value={diffSection} onChange={(e) => setDiffSection(e.target.value)}
                  style={{ padding: '4px 8px', fontSize: 11, borderRadius: 6, background: 'var(--bg-card)', border: '1px solid var(--border-med)', color: 'var(--text-secondary)', outline: 'none' }}>
                  <option value="all">All sections</option>
                  {diffSections.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              {/* Diff table */}
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
                <table className="w-full text-xs" style={{ borderCollapse: 'collapse', minWidth: 500 }}>
                  <thead style={{ background: 'var(--bg-input)' }}>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px', fontWeight: 500, fontSize: 10, width: '10%' }}>Status</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500, fontSize: 10, width: '12%' }}>Section</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500, fontSize: 10, width: '20%' }}>Item</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500, fontSize: 10, width: '20%' }}>Source</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500, fontSize: 10, width: '20%' }}>Target</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500, fontSize: 10, width: '18%' }}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDiff.map((d: DiffItem, i: number) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-input)' }}>
                        <td style={{ padding: '6px 12px' }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                            background: STATUS_BG[d.status], color: STATUS_COLOR[d.status],
                            border: `1px solid ${STATUS_COLOR[d.status]}30`,
                          }}>
                            {STATUS_ICON[d.status]} {d.status.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)' }}>{d.section}</td>
                        <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{d.key}</td>
                        <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{d.source_value}</td>
                        <td style={{ padding: '6px 12px', fontFamily: 'monospace', fontSize: 11, color: d.status === 'missing' ? '#ef4444' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{d.target_value || '—'}</td>
                        <td style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)' }}>{d.note}</td>
                      </tr>
                    ))}
                    {filteredDiff.length === 0 && (
                      <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No items match the current filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <p style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
                {compareResult.source.label || compareResult.source.server_name} → {compareResult.target.label || compareResult.target.server_name}
              </p>

              {/* Checklist toggle */}
              {(() => {
                const checklistItems = generateChecklist(compareResult.diff)
                const actionCount = checklistItems.length
                return (
                  <div>
                    <button
                      onClick={() => { setShowChecklist((v) => !v); setCheckedItems(new Set()) }}
                      style={{
                        padding: '9px 18px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none',
                        cursor: 'pointer', background: showChecklist ? 'var(--bg-input)' : 'var(--accent-hex)',
                        color: showChecklist ? 'var(--text-secondary)' : 'white',
                        display: 'flex', alignItems: 'center', gap: 8,
                      }}
                    >
                      📋 {showChecklist ? 'Hide Checklist' : `Generate Migration Checklist (${actionCount} action${actionCount !== 1 ? 's' : ''})`}
                    </button>

                    {showChecklist && (
                      <div style={{ marginTop: 12, background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
                        {/* Checklist header */}
                        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-med)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                          <div>
                            <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', margin: 0 }}>Migration Checklist</p>
                            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                              {compareResult.source.label || compareResult.source.server_name} → {compareResult.target.label || compareResult.target.server_name}
                              &nbsp;·&nbsp;{checkedItems.size}/{actionCount} completed
                            </p>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            {/* Progress bar */}
                            <div style={{ width: 120, height: 6, borderRadius: 3, background: 'var(--bg-input)', overflow: 'hidden' }}>
                              <div style={{
                                height: '100%', borderRadius: 3, background: '#22c55e',
                                width: `${actionCount > 0 ? (checkedItems.size / actionCount) * 100 : 0}%`,
                                transition: 'width 0.3s',
                              }} />
                            </div>
                            <button
                              onClick={() => exportChecklist(checklistItems)}
                              style={{ padding: '5px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                            >
                              ↓ Export .md
                            </button>
                          </div>
                        </div>

                        {/* Priority summary */}
                        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-med)' }}>
                          {(['critical', 'high', 'medium', 'low'] as const).map((p) => {
                            const count = checklistItems.filter((i) => i.priority === p).length
                            return count > 0 ? (
                              <div key={p} style={{ flex: 1, padding: '8px 12px', textAlign: 'center', borderRight: '1px solid var(--border-weak)', background: PRIORITY_BG[p] }}>
                                <p style={{ fontSize: 18, fontWeight: 700, color: PRIORITY_COLOR[p], margin: 0 }}>{count}</p>
                                <p style={{ fontSize: 10, color: PRIORITY_COLOR[p], margin: 0, fontWeight: 600, textTransform: 'uppercase' }}>{p}</p>
                              </div>
                            ) : null
                          })}
                        </div>

                        {/* Checklist items grouped by section */}
                        {actionCount === 0
                          ? <p style={{ padding: 20, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>No actionable items — target matches source.</p>
                          : (() => {
                            const sections = [...new Set(checklistItems.map((i) => i.section))]
                            return (
                              <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                                {sections.map((sec) => (
                                  <div key={sec}>
                                    <div style={{ padding: '8px 18px', background: 'var(--bg-input)', borderBottom: '1px solid var(--border-weak)', borderTop: '1px solid var(--border-weak)' }}>
                                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{sec}</span>
                                    </div>
                                    {checklistItems.filter((i) => i.section === sec).map((item) => {
                                      const done = checkedItems.has(item.id)
                                      return (
                                        <div
                                          key={item.id}
                                          style={{
                                            padding: '12px 18px', borderBottom: '1px solid var(--border-weak)',
                                            opacity: done ? 0.5 : 1, transition: 'opacity 0.2s',
                                            background: done ? 'var(--bg-input)' : 'transparent',
                                          }}
                                        >
                                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                                            {/* Checkbox */}
                                            <input
                                              type="checkbox"
                                              checked={done}
                                              onChange={() => setCheckedItems((prev) => {
                                                const next = new Set(prev)
                                                done ? next.delete(item.id) : next.add(item.id)
                                                return next
                                              })}
                                              style={{ marginTop: 2, width: 15, height: 15, cursor: 'pointer', accentColor: '#22c55e', flexShrink: 0 }}
                                            />
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                              {/* Title row */}
                                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                                                <span style={{
                                                  fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 4,
                                                  background: PRIORITY_BG[item.priority], color: PRIORITY_COLOR[item.priority],
                                                  textTransform: 'uppercase', letterSpacing: '0.05em',
                                                }}>{item.priority}</span>
                                                <span style={{
                                                  fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 4,
                                                  background: STATUS_BG[item.status], color: STATUS_COLOR[item.status],
                                                }}>{STATUS_ICON[item.status]} {item.status}</span>
                                                <span style={{ fontSize: 12, fontWeight: 600, color: done ? 'var(--text-muted)' : 'var(--text-heading)', textDecoration: done ? 'line-through' : 'none' }}>
                                                  {item.title}
                                                </span>
                                              </div>
                                              {/* Detail */}
                                              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px' }}>{item.detail}</p>
                                              {/* Command */}
                                              <pre style={{
                                                fontSize: 11, fontFamily: 'monospace', margin: 0,
                                                padding: '6px 10px', borderRadius: 6,
                                                background: 'var(--bg-body)', color: 'var(--text-secondary)',
                                                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                                                borderLeft: `3px solid ${PRIORITY_COLOR[item.priority]}`,
                                              }}>{item.command}</pre>
                                            </div>
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                ))}
                              </div>
                            )
                          })()
                        }
                      </div>
                    )}
                  </div>
                )
              })()}
            </>
          )}
        </div>
      )}

      {/* ── Transfer tab ──────────────────────────────────────────────────── */}
      {tab === 'transfer' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Transfer form */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, padding: 18 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', marginBottom: 14 }}>Transfer Data Between Servers</p>

            {/* Source / Target */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: xferValidation.source_id ? '#ef4444' : 'var(--text-muted)', display: 'block', marginBottom: 4 }}>SOURCE SERVER *</label>
                <select value={xferForm.source_id} onChange={(e) => setXferForm((f) => ({ ...f, source_id: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: `1px solid ${xferValidation.source_id ? '#ef4444' : 'var(--border-med)'}`, color: 'var(--text-heading)', outline: 'none' }}>
                  <option value="">— Select server —</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: xferValidation.target_id ? '#ef4444' : 'var(--text-muted)', display: 'block', marginBottom: 4 }}>TARGET SERVER *</label>
                <select value={xferForm.target_id} onChange={(e) => setXferForm((f) => ({ ...f, target_id: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: `1px solid ${xferValidation.target_id ? '#ef4444' : 'var(--border-med)'}`, color: 'var(--text-heading)', outline: 'none' }}>
                  <option value="">— Select server —</option>
                  {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>)}
                </select>
              </div>
            </div>

            {/* Transfer type */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>TRANSFER TYPE</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {([
                  { type: 'mysql',      icon: '🗄', label: 'MySQL' },
                  { type: 'postgresql', icon: '🐘', label: 'PostgreSQL' },
                  { type: 'mongodb',    icon: '🍃', label: 'MongoDB' },
                  { type: 'redis',      icon: '⚡', label: 'Redis' },
                  { type: 'files',      icon: '📁', label: 'Files' },
                  { type: 'configs',    icon: '⚙', label: 'Config Files' },
                  { type: 'cron',       icon: '⏱', label: 'Cron Jobs' },
                ] as const).map(({ type, icon, label }) => (
                  <button key={type} type="button"
                    onClick={() => { setXferForm((f) => ({ ...f, type })); setDumpResult(null); setDumpError('') }}
                    style={{
                      padding: '6px 14px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
                      border: `1px solid ${xferForm.type === type ? 'var(--accent-hex)' : 'var(--border-med)'}`,
                      background: xferForm.type === type ? 'rgba(59,130,246,0.15)' : 'var(--bg-input)',
                      color: xferForm.type === type ? 'var(--accent-hex)' : 'var(--text-secondary)',
                      fontWeight: xferForm.type === type ? 600 : 400,
                    }}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Type-specific options */}
            {['mysql', 'postgresql', 'mongodb'].includes(xferForm.type) && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, color: xferValidation.database ? '#ef4444' : 'var(--text-muted)', display: 'block', marginBottom: 4 }}>DATABASE NAME *</label>
                <input value={xferForm.database} onChange={(e) => { setXferForm((f) => ({ ...f, database: e.target.value })); setDumpResult(null); setDumpError('') }}
                  placeholder="e.g. myapp_production"
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: `1px solid ${xferValidation.database ? '#ef4444' : 'var(--border-med)'}`, color: 'var(--text-heading)', outline: 'none' }} />
                {xferValidation.database && <p style={{ margin: '4px 0 0', fontSize: 11, color: '#ef4444' }}>⚠ {xferValidation.database}</p>}
              </div>
            )}
            {xferForm.type === 'files' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: xferValidation.source_path ? '#ef4444' : 'var(--text-muted)', display: 'block', marginBottom: 4 }}>SOURCE PATH *</label>
                  <input value={xferForm.source_path} onChange={(e) => setXferForm((f) => ({ ...f, source_path: e.target.value }))}
                    placeholder="/var/www/myapp"
                    style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: `1px solid ${xferValidation.source_path ? '#ef4444' : 'var(--border-med)'}`, color: 'var(--text-heading)', outline: 'none' }} />
                  {xferValidation.source_path && <p style={{ margin: '4px 0 0', fontSize: 11, color: '#ef4444' }}>⚠ {xferValidation.source_path}</p>}
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>TARGET PATH <span style={{ fontWeight: 400 }}>(optional — defaults to source path)</span></label>
                  <input value={xferForm.target_path} onChange={(e) => setXferForm((f) => ({ ...f, target_path: e.target.value }))}
                    placeholder={xferForm.source_path || '/var/www/myapp'}
                    style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: '1px solid var(--border-med)', color: 'var(--text-heading)', outline: 'none' }} />
                </div>
              </div>
            )}
            {xferForm.type === 'cron' && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>USERS (comma-separated)</label>
                <input value={xferForm.users} onChange={(e) => setXferForm((f) => ({ ...f, users: e.target.value }))}
                  placeholder="root,www-data,ubuntu"
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 7, background: 'var(--bg-input)', border: '1px solid var(--border-med)', color: 'var(--text-heading)', outline: 'none' }} />
              </div>
            )}
            {xferForm.type === 'configs' && (
              <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 7, background: 'var(--bg-input)', fontSize: 11, color: 'var(--text-muted)' }}>
                Will transfer: <code style={{ fontSize: 10 }}>/etc/nginx /etc/apache2 /etc/php /etc/mysql /etc/postgresql /etc/redis /etc/systemd/system /etc/cron.d /etc/environment /etc/hosts</code>
              </div>
            )}
            {xferForm.type === 'redis' && (
              <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 7, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 11, color: '#f59e0b' }}>
                ⚠ Redis transfer copies the RDB dump file. Target Redis service will be reloaded. Ensure target Redis is not in cluster mode.
              </div>
            )}

            {/* Inline server errors */}
            {xferValidation.source_id && <p style={{ margin: '0 0 6px', fontSize: 11, color: '#ef4444' }}>⚠ Source: {xferValidation.source_id}</p>}
            {xferValidation.target_id && <p style={{ margin: '0 0 6px', fontSize: 11, color: '#ef4444' }}>⚠ Target: {xferValidation.target_id}</p>}

            {/* DB types: two-phase (Dump → Transfer). Other types: single Start Transfer. */}
            {isDbType ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Phase 1 — Dump */}
                {!dumpResult ? (
                  <>
                    <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.2)' }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', margin: '0 0 4px' }}>Step 1 of 2 — Dump</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                        Dumps <code style={{ fontSize: 10 }}>{xferForm.database || '…'}</code> on <strong>{servers.find((s) => s.id === xferForm.source_id)?.name || 'source'}</strong> to a compressed file in <code style={{ fontSize: 10 }}>/tmp/</code>.
                        The source file browser will auto-navigate to the dump file when done.
                      </p>
                    </div>
                    {dumpError && <p style={{ fontSize: 11, color: '#ef4444', margin: 0 }}>✗ {dumpError}</p>}
                    <button onClick={runDump}
                      disabled={dumpLoading || !xferForm.source_id || !xferForm.database}
                      style={{ padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none', width: 'fit-content',
                        cursor: dumpLoading || !xferForm.source_id || !xferForm.database ? 'not-allowed' : 'pointer',
                        background: xferForm.source_id && xferForm.database ? 'var(--accent-hex)' : 'var(--border-med)',
                        color: xferForm.source_id && xferForm.database ? 'white' : 'var(--text-muted)',
                        opacity: dumpLoading ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {dumpLoading && <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid white', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />}
                      {dumpLoading ? 'Dumping…' : '📦 Dump Database'}
                    </button>
                  </>
                ) : (
                  <>
                    {/* Dump success banner */}
                    <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>✅</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', margin: '0 0 3px' }}>Dump complete — {dumpResult.size_human}</p>
                        <p style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', margin: '0 0 3px', wordBreak: 'break-all' }}>{dumpResult.dump_file}</p>
                        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                          Step 2 — browse the <strong>target</strong> server below to pick the destination folder, then click Transfer.
                        </p>
                      </div>
                      <button onClick={() => { setDumpResult(null); setDumpError(''); setXferForm((f) => ({ ...f, source_path: '', type: xferForm.type })) }}
                        style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0 }}>
                        ✕ Reset
                      </button>
                    </div>

                    {/* Phase 2 — Transfer file */}
                    <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.2)' }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', margin: '0 0 4px' }}>Step 2 of 2 — Transfer dump file</p>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>SOURCE (dump file — auto-filled)</label>
                          <input value={xferForm.source_path} readOnly
                            style={{ width: '100%', padding: '6px 10px', fontSize: 11, fontFamily: 'monospace', borderRadius: 6, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)', color: 'var(--text-secondary)', outline: 'none' }} />
                        </div>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <label style={{ fontSize: 10, color: xferForm.target_path ? 'var(--text-muted)' : '#ef4444', display: 'block', marginBottom: 3 }}>
                            TARGET PATH {xferForm.target_path ? '✓' : '* — browse below to select'}
                          </label>
                          <input value={xferForm.target_path}
                            onChange={(e) => setXferForm((f) => ({ ...f, target_path: e.target.value }))}
                            placeholder="Browse target below or type path…"
                            style={{ width: '100%', padding: '6px 10px', fontSize: 11, fontFamily: 'monospace', borderRadius: 6, background: 'var(--bg-input)', border: `1px solid ${xferForm.target_path ? 'var(--border-med)' : '#ef4444'}`, color: 'var(--text-heading)', outline: 'none' }} />
                        </div>
                      </div>
                    </div>

                    {xferError && <p style={{ fontSize: 11, color: '#ef4444', margin: 0 }}>✗ {xferError}</p>}
                    <button onClick={startTransfer}
                      disabled={!xferForm.target_path || xferSubmitting}
                      style={{ padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none', width: 'fit-content',
                        cursor: !xferForm.target_path || xferSubmitting ? 'not-allowed' : 'pointer',
                        background: xferForm.target_path ? 'var(--accent-hex)' : 'var(--border-med)',
                        color: xferForm.target_path ? 'white' : 'var(--text-muted)',
                        opacity: xferSubmitting ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {xferSubmitting && <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid white', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />}
                      {xferSubmitting ? 'Transferring…' : xferForm.target_path ? '⇒ Transfer Dump File' : 'Select target path below first'}
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                {/* Non-DB types: single Start Transfer with pre-flight summary */}
                {xferReady && (() => {
                  const srcName = servers.find((s) => s.id === xferForm.source_id)?.name ?? ''
                  const tgtName = servers.find((s) => s.id === xferForm.target_id)?.name ?? ''
                  const steps: string[] = []
                  if (xferForm.type === 'files') {
                    steps.push(`Archive ${xferForm.source_path} on ${srcName} via tar+gzip`)
                    steps.push(`Stream archive to ${tgtName}:${xferForm.target_path || xferForm.source_path}`)
                  } else if (xferForm.type === 'redis') {
                    steps.push(`BGSAVE on ${srcName} → wait for RDB file`)
                    steps.push(`Copy RDB file to ${tgtName}`)
                    steps.push(`Restart Redis on ${tgtName} to load new data`)
                  } else if (xferForm.type === 'configs') {
                    steps.push(`Archive common config paths on ${srcName}`)
                    steps.push(`Extract to ${tgtName} (may overwrite existing configs)`)
                  } else if (xferForm.type === 'cron') {
                    steps.push(`Copy crontabs for: ${xferForm.users || 'root'}`)
                    steps.push(`Copy /etc/cron.d, cron.daily, cron.weekly, cron.monthly`)
                  }
                  return (
                    <div style={{ marginBottom: 10, padding: '10px 14px', borderRadius: 8, background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.25)' }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', margin: '0 0 6px' }}>✓ Ready — what will happen:</p>
                      <ol style={{ margin: 0, paddingLeft: 18 }}>
                        {steps.map((s, i) => <li key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>{s}</li>)}
                      </ol>
                    </div>
                  )
                })()}
                {xferError && <p style={{ fontSize: 11, color: '#ef4444', marginBottom: 8 }}>✗ {xferError}</p>}
                <button onClick={startTransfer} disabled={!xferReady || xferSubmitting}
                  style={{ padding: '9px 22px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none', width: 'fit-content',
                    cursor: !xferReady || xferSubmitting ? 'not-allowed' : 'pointer',
                    background: xferReady ? 'var(--accent-hex)' : 'var(--border-med)', color: xferReady ? 'white' : 'var(--text-muted)',
                    opacity: xferSubmitting ? 0.6 : 1 }}>
                  {xferSubmitting ? 'Starting…' : xferReady ? '⇒ Start Transfer' : 'Fill required fields above'}
                </button>
              </>
            )}
          </div>

          {/* Active jobs — one card per concurrent transfer */}
          {activeJobs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-heading)', margin: 0 }}>Active Transfers</p>
                <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
                  {activeJobs.filter(j => j.status === 'running' || j.status === 'pending').length} running · {activeJobs.length} total
                </span>
              </div>
              {activeJobs.map((job) => {
                const srcServer = servers.find(s => s.id === job.source_server_id)
                const tgtServer = servers.find(s => s.id === job.target_server_id)
                const borderColor = job.status === 'error' ? '#ef444440' : job.status === 'done' ? '#22c55e40' : 'var(--border-med)'
                const statusColor = job.status === 'done' ? '#22c55e' : job.status === 'error' ? '#ef4444' : job.status === 'running' ? 'var(--accent-hex)' : 'var(--text-muted)'
                const statusBg = job.status === 'done' ? 'rgba(34,197,94,0.15)' : job.status === 'error' ? 'rgba(239,68,68,0.15)' : job.status === 'running' ? 'rgba(59,130,246,0.15)' : 'var(--bg-input)'
                return (
                  <div key={job.id} style={{ background: 'var(--bg-card)', border: `1px solid ${borderColor}`, borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-med)', display: 'flex', alignItems: 'center', gap: 10 }}>
                      {job.status === 'running' && (
                        <div style={{ width: 9, height: 9, borderRadius: '50%', border: '2px solid var(--accent-hex)', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
                      )}
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-heading)' }}>{job.type.toUpperCase()}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, textTransform: 'uppercase', background: statusBg, color: statusColor }}>{job.status}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {srcServer?.name ?? '…'} → {tgtServer?.name ?? '…'}
                      </span>
                      {job.options.database && <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{job.options.database}</span>}
                      {job.options.source_path && <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.options.source_path}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {job.bytes_transferred > 0 ? `${(job.bytes_transferred / 1024 / 1024).toFixed(2)} MB` : ''}
                        {job.ended_at ? ` · ${Math.round((new Date(job.ended_at).getTime() - new Date(job.started_at).getTime()) / 1000)}s` : ''}
                      </span>
                      {(job.status === 'done' || job.status === 'error') && (
                        <button onClick={() => dismissJob(job.id)}
                          style={{ padding: '2px 7px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0 }}>
                          ✕
                        </button>
                      )}
                    </div>
                    <div ref={(el) => { if (el) el.scrollTop = el.scrollHeight }} style={{ padding: '8px 12px', maxHeight: 220, overflowY: 'auto', background: 'var(--bg-body)' }}>
                      {job.log.map((line, i) => (
                        <p key={i} style={{
                          margin: '1px 0', fontSize: 11, fontFamily: 'monospace',
                          color: line.includes('rror') || line.includes('failed') || line.includes('✗') ? '#ef4444'
                            : line.includes('✓') || line.includes('done') || line.includes('complete') ? '#22c55e'
                            : line.includes('…') ? 'var(--text-muted)' : 'var(--text-secondary)',
                        }}>{line}</p>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Readiness Check + Restore — shown after file transfer completes for DB dumps */}
          {dumpResult && activeJobs.some(j => j.status === 'done') && xferForm.target_id && xferForm.database && (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-med)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', margin: 0 }}>🩺 Target Readiness Check</p>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Verify <strong>{servers.find(s => s.id === xferForm.target_id)?.name}</strong> is ready to restore <code style={{ fontSize: 10 }}>{xferForm.database}</code>
                </span>
                <button onClick={runReadinessCheck} disabled={readinessLoading}
                  style={{ marginLeft: 'auto', padding: '4px 14px', fontSize: 11, fontWeight: 600, borderRadius: 6, border: '1px solid var(--accent-hex)', background: 'transparent', color: 'var(--accent-hex)', cursor: readinessLoading ? 'wait' : 'pointer', opacity: readinessLoading ? 0.7 : 1 }}>
                  {readinessLoading ? '⏳ Checking…' : readiness ? '↺ Re-check' : '🩺 Check Readiness'}
                </button>
              </div>

              {readiness && (
                <>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg-input)', borderBottom: '1px solid var(--border-med)' }}>
                        {['Check', 'Result', 'Note'].map(h => (
                          <th key={h} style={{ padding: '5px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {readiness.items.map((item: ReadinessItem, i: number) => {
                        const color = item.status === 'ok' ? '#22c55e' : item.status === 'warn' ? '#eab308' : '#ef4444'
                        const icon = item.status === 'ok' ? '✓' : item.status === 'warn' ? '⚠' : '✗'
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)', background: item.status === 'fail' ? 'rgba(239,68,68,0.04)' : item.status === 'warn' ? 'rgba(234,179,8,0.04)' : 'transparent' }}>
                            <td style={{ padding: '6px 14px', fontSize: 12, fontWeight: 500, color: 'var(--text-heading)', whiteSpace: 'nowrap' }}>{item.label}</td>
                            <td style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'monospace' }}>
                              <span style={{ color, fontWeight: 600 }}>{icon}</span>
                              <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>{item.value}</span>
                            </td>
                            <td style={{ padding: '6px 14px', fontSize: 11, color: color, fontStyle: item.note ? 'normal' : 'italic' }}>
                              {item.note ?? ''}
                              {item.status === 'fail' && item.note && (
                                <code style={{ fontSize: 10, marginLeft: 6, background: 'var(--bg-input)', padding: '1px 5px', borderRadius: 3 }}>{item.note}</code>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>

                  <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-med)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    {readiness.ready ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#22c55e' }}>✓ All checks passed — ready to restore</span>
                    ) : (
                      <span style={{ fontSize: 11, fontWeight: 600, color: '#ef4444' }}>✗ Fix the failed checks above before restoring</span>
                    )}

                    {readiness.ready && (
                      <button onClick={runRestore} disabled={restoreLoading}
                        style={{ marginLeft: 'auto', padding: '7px 20px', fontSize: 12, fontWeight: 700, borderRadius: 7, border: 'none', background: '#22c55e', color: 'white', cursor: restoreLoading ? 'wait' : 'pointer', opacity: restoreLoading ? 0.7 : 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                        {restoreLoading && <div style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid white', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />}
                        {restoreLoading ? 'Restoring…' : '🔁 Restore Database'}
                      </button>
                    )}
                  </div>

                  {/* Restore log */}
                  {restoreLog.length > 0 && (
                    <div style={{ borderTop: '1px solid var(--border-med)', padding: 12, background: 'var(--bg-body)' }}>
                      {restoreLog.map((line, i) => (
                        <p key={i} style={{ margin: '2px 0', fontSize: 11, fontFamily: 'monospace', color: line.includes('complete') || line.includes('✓') ? '#22c55e' : line.includes('Error') || line.includes('failed') ? '#ef4444' : 'var(--text-secondary)' }}>{line}</p>
                      ))}
                      {restoreError && <p style={{ margin: '4px 0 0', fontSize: 11, color: '#ef4444', fontWeight: 600 }}>✗ {restoreError}</p>}
                    </div>
                  )}
                </>
              )}

              {!readiness && !readinessLoading && (
                <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                  Click "Check Readiness" to verify the target server before restoring
                </div>
              )}
            </div>
          )}

          {/* File Browser — dual panel */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-med)' }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', margin: 0 }}>📂 File Browser</p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>Select source/target servers above, then browse to pick paths.</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
              {(['source', 'target'] as const).map((side) => {
                const serverId = side === 'source' ? xferForm.source_id : xferForm.target_id
                const serverName = servers.find((s) => s.id === serverId)?.name
                const result = browseResult[side]
                const loading = browseLoading[side]
                const error = browseError[side]
                const input = browseInput[side]
                const accentColor = side === 'source' ? '#3b82f6' : '#22c55e'

                return (
                  <div key={side} style={{ borderRight: side === 'source' ? '1px solid var(--border-med)' : 'none' }}>
                    {/* Panel header */}
                    <div style={{ padding: '8px 12px', background: 'var(--bg-input)', borderBottom: '1px solid var(--border-weak)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: `${accentColor}20`, color: accentColor, textTransform: 'uppercase' }}>
                        {side}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {serverName ?? <span style={{ fontStyle: 'italic' }}>no server selected</span>}
                      </span>
                    </div>

                    {/* Path input */}
                    <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--border-weak)', alignItems: 'center' }}>
                      {result && result.path !== '/' && (
                        <button onClick={() => browse(side, result.parent)} title="Go up"
                          style={{ padding: '4px 8px', fontSize: 12, borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}>
                          ↑
                        </button>
                      )}
                      <input
                        value={input}
                        onChange={(e) => setBrowseInput((i) => ({ ...i, [side]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && browse(side, input)}
                        placeholder="/"
                        style={{ flex: 1, padding: '5px 8px', fontSize: 11, fontFamily: 'monospace', borderRadius: 5, background: 'var(--bg-body)', border: '1px solid var(--border-med)', color: 'var(--text-heading)', outline: 'none', minWidth: 0 }}
                      />
                      <button onClick={() => browse(side, input)} disabled={loading || !serverId}
                        style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 5, border: 'none', cursor: loading || !serverId ? 'not-allowed' : 'pointer', background: accentColor, color: 'white', opacity: loading || !serverId ? 0.5 : 1, flexShrink: 0 }}>
                        {loading ? '…' : 'Go'}
                      </button>
                    </div>

                    {error && <p style={{ margin: 0, padding: '6px 12px', fontSize: 11, color: '#ef4444', background: 'rgba(239,68,68,0.08)' }}>{error}</p>}

                    {/* Breadcrumb */}
                    {result && (
                      <div style={{ padding: '4px 10px', borderBottom: '1px solid var(--border-weak)', display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', minHeight: 26 }}>
                        {[{ label: '/', path: '/' }, ...result.path.split('/').filter(Boolean).map((part, i, arr) => ({
                          label: part, path: '/' + arr.slice(0, i + 1).join('/'),
                        }))].map((crumb, i, arr) => (
                          <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                            {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>/</span>}
                            <button onClick={() => browse(side, crumb.path)} style={{
                              fontSize: 10, fontFamily: 'monospace', background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', borderRadius: 3,
                              color: i === arr.length - 1 ? accentColor : 'var(--text-muted)',
                              fontWeight: i === arr.length - 1 ? 700 : 400,
                            }}>{crumb.label}</button>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* File list */}
                    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                      {!result && !loading && (
                        <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                          {serverId ? 'Enter a path and press Go' : 'Select a server first'}
                        </div>
                      )}
                      {result && (
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-med)', background: 'var(--bg-input)' }}>
                              <th style={{ padding: '4px 10px', textAlign: 'left', fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Name</th>
                              <th style={{ padding: '4px 6px', textAlign: 'right', fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', width: 52 }}>Size</th>
                              <th style={{ padding: '4px 6px', textAlign: 'left', fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', width: 80 }}>Perms</th>
                              <th style={{ padding: '4px 6px', textAlign: 'left', fontSize: 9, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Owner</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.entries.length === 0 && (
                              <tr><td colSpan={4} style={{ padding: '14px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>Empty directory</td></tr>
                            )}
                            {result.entries.map((entry) => {
                              const entryPath = `${result.path === '/' ? '' : result.path}/${entry.name}`
                              return (
                                <tr key={entry.name} style={{ borderBottom: '1px solid var(--border-weak)' }}
                                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-input)')}
                                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                                  <td style={{ padding: '4px 10px' }}>
                                    <button
                                      onClick={() => entry.type === 'dir' ? browse(side, entryPath) : undefined}
                                      style={{
                                        background: 'none', border: 'none', cursor: entry.type === 'dir' ? 'pointer' : 'default',
                                        fontSize: 11, fontFamily: 'monospace', padding: 0, textAlign: 'left', width: '100%',
                                        color: entry.type === 'dir' ? accentColor : entry.type === 'link' ? '#f59e0b' : 'var(--text-secondary)',
                                        display: 'flex', alignItems: 'center', gap: 5,
                                      }}>
                                      <span style={{ fontSize: 11, flexShrink: 0 }}>
                                        {entry.type === 'dir' ? '📁' : entry.type === 'link' ? '🔗' : '📄'}
                                      </span>
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
                                    </button>
                                  </td>
                                  <td style={{ padding: '4px 6px', fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    {entry.type === 'dir' ? '—' : formatSize(entry.size)}
                                  </td>
                                  <td style={{ padding: '4px 6px', fontSize: 9, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{entry.permissions}</td>
                                  <td style={{ padding: '4px 6px', fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.owner}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>

                    {/* Use path footer */}
                    {result && (
                      <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border-weak)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{result.path}</span>
                        <button
                          onClick={() => setXferForm((f) => ({
                            ...f,
                            type: 'files',
                            ...(side === 'source' ? { source_path: result.path } : { target_path: result.path }),
                          }))}
                          style={{ padding: '3px 10px', fontSize: 10, fontWeight: 600, borderRadius: 5, border: `1px solid ${accentColor}`, background: 'transparent', color: accentColor, cursor: 'pointer', flexShrink: 0 }}>
                          Use path
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* History */}
          {xferHistory.length > 0 && (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-med)' }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-heading)', margin: 0 }}>Recent Transfers</p>
              </div>
              {xferHistory.slice(0, 10).map((job) => {
                const src = servers.find((s) => s.id === job.source_server_id)
                const tgt = servers.find((s) => s.id === job.target_server_id)
                const isVerifying = verifyLoading && verifyJobId === job.id
                return (
                  <div key={job.id}
                    style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-weak)', display: 'flex', alignItems: 'center', gap: 10 }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-input)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                    <span style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }} onClick={() => addJob(job)}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, textTransform: 'uppercase', flexShrink: 0,
                        background: job.status === 'done' ? 'rgba(34,197,94,0.12)' : job.status === 'error' ? 'rgba(239,68,68,0.12)' : 'var(--bg-input)',
                        color: job.status === 'done' ? '#22c55e' : job.status === 'error' ? '#ef4444' : 'var(--text-muted)',
                      }}>{job.status}</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-heading)', flexShrink: 0 }}>{job.type}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {src?.name ?? job.source_server_id.slice(0, 8)} → {tgt?.name ?? job.target_server_id.slice(0, 8)}
                      </span>
                      {job.options.database && <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', flexShrink: 0 }}>{job.options.database}</span>}
                      {job.options.source_path && <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{job.options.source_path}</span>}
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto', flexShrink: 0 }}>{new Date(job.started_at).toLocaleString()}</span>
                      {job.bytes_transferred > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 }}>{(job.bytes_transferred / 1024 / 1024).toFixed(1)} MB</span>
                      )}
                    </span>
                    {(job.status === 'done' || job.status === 'error') && (
                      <button
                        onClick={() => runVerify(job.id)}
                        disabled={isVerifying}
                        style={{ padding: '3px 10px', fontSize: 10, fontWeight: 600, borderRadius: 5, border: '1px solid #3b82f6', background: verifyJobId === job.id ? '#3b82f620' : 'transparent', color: '#3b82f6', cursor: isVerifying ? 'wait' : 'pointer', flexShrink: 0, opacity: isVerifying ? 0.7 : 1 }}>
                        {isVerifying ? '…' : '🔍 Verify'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Verify Report */}
          {verifyReport && (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-med)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', margin: 0 }}>🔍 Verification Report</p>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{verifyReport.type} · {new Date(verifyReport.ran_at).toLocaleString()}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(34,197,94,0.12)', color: '#22c55e' }}>✓ {verifyReport.passed} match</span>
                  {verifyReport.warnings > 0 && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(234,179,8,0.12)', color: '#eab308' }}>⚠ {verifyReport.warnings} warn</span>}
                  {verifyReport.failed > 0 && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>✗ {verifyReport.failed} fail</span>}
                </div>
                <button onClick={() => setVerifyReport(null)} style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-med)', background: 'var(--bg-input)' }}>
                      {['Check', 'Source', 'Target', 'Status', 'Note'].map((h) => (
                        <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {verifyReport.items.map((item: VerifyItem, i: number) => {
                      const statusColor = item.status === 'match' ? '#22c55e' : item.status === 'mismatch' || item.status === 'error' ? '#ef4444' : item.status === 'warning' ? '#eab308' : 'var(--text-muted)'
                      const statusIcon = item.status === 'match' ? '✓' : item.status === 'mismatch' ? '✗' : item.status === 'error' ? '✗' : item.status === 'warning' ? '⚠' : '–'
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)', background: item.status === 'mismatch' || item.status === 'error' ? 'rgba(239,68,68,0.04)' : 'transparent' }}>
                          <td style={{ padding: '6px 14px', fontSize: 12, fontWeight: 500, color: 'var(--text-heading)', whiteSpace: 'nowrap', fontFamily: item.label.startsWith('/') ? 'monospace' : undefined }}>{item.label}</td>
                          <td style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.source || '—'}</td>
                          <td style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.target || '—'}</td>
                          <td style={{ padding: '6px 14px', whiteSpace: 'nowrap' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>{statusIcon} {item.status}</span>
                          </td>
                          <td style={{ padding: '6px 14px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>{item.note ?? ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
