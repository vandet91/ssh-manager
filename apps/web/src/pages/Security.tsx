import { useEffect, useState } from 'react'
import { api, Server, SecurityScan } from '../api/client'
import Badge from '../components/Badge'

export default function Security() {
  const [servers, setServers] = useState<Server[]>([])
  const [scans, setScans] = useState<Record<string, SecurityScan>>({})
  const [scanning, setScanning] = useState<string | null>(null)
  const [scanningAll, setScanningAll] = useState(false)
  const [selectedServer, setSelectedServer] = useState<string | null>(null)

  const load = async () => {
    const svrs = await api.get<Server[]>('/servers').catch(() => [] as Server[])
    setServers(svrs)
    const scanMap: Record<string, SecurityScan> = {}
    await Promise.all(
      svrs.map(async (s) => {
        const results = await api.get<SecurityScan[]>(`/security/findings/${s.id}`).catch(() => [] as SecurityScan[])
        if (results[0]) scanMap[s.id] = results[0]
      }),
    )
    setScans(scanMap)
  }

  useEffect(() => { load() }, [])

  const scanServer = async (id: string) => {
    setScanning(id)
    try { await api.post(`/security/scan/${id}`) }
    catch { /* ignore */ }
    finally { setScanning(null); load() }
  }

  const scanAll = async () => {
    setScanningAll(true)
    try { await api.post('/security/scan/all') }
    catch { /* ignore */ }
    finally { setScanningAll(false); setTimeout(load, 3000) }
  }

  const selectedScan = selectedServer ? scans[selectedServer] : null

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Security</h1>
        <button onClick={scanAll} disabled={scanningAll}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
          {scanningAll ? 'Scanning…' : 'Scan All'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Server list */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl" style={{ overflowX: 'auto' }}>
          <table className="w-full text-xs" style={{ tableLayout: 'fixed', borderCollapse: 'collapse', minWidth: 340 }}>
            <colgroup>
              <col style={{ width: '34%' }} />
              <col style={{ width: '32%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '16%' }} />
            </colgroup>
            <thead className="bg-gray-800/50">
              <tr className="text-left text-gray-500 text-xs uppercase tracking-wide font-medium">
                <th className="px-3 py-2">Server</th>
                <th className="px-3 py-2">Last Scan</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {servers.map((s) => {
                const scan = scans[s.id]
                return (
                  <tr key={s.id}
                    className={`hover:bg-gray-800/30 cursor-pointer transition-colors ${selectedServer === s.id ? 'bg-gray-800/50' : ''}`}
                    onClick={() => setSelectedServer(s.id)}>
                    <td className="px-3 py-2 text-white font-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</td>
                    <td className="px-3 py-2 text-gray-400 text-xs" style={{ whiteSpace: 'nowrap' }}>{scan ? new Date(scan.scanned_at).toLocaleString() : '—'}</td>
                    <td className="px-3 py-2">
                      {scan?.severity ? <Badge label={scan.severity.toUpperCase()} variant={scan.severity as 'ok'} /> : <Badge label="N/A" />}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); scanServer(s.id) }}
                        disabled={scanning === s.id}
                        className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white disabled:opacity-50 transition-colors"
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        {scanning === s.id ? '…' : 'Scan'}
                      </button>
                    </td>
                  </tr>
                )
              })}
              {servers.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-5 text-center text-gray-500">No servers.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Findings detail */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          {selectedScan ? (
            <>
              <h2 className="text-sm font-semibold text-gray-300 mb-3">
                Findings — {servers.find((s) => s.id === selectedServer)?.name}
                <span className="ml-2 text-xs text-gray-500">{new Date(selectedScan.scanned_at).toLocaleString()}</span>
              </h2>
              <ul className="space-y-2">
                {((selectedScan.findings ?? []) as Array<{ check_id: string; description: string; severity: string; passed: boolean; output: string }>).map((f) => (
                  <li key={f.check_id} className="flex items-start gap-3 text-xs p-2 rounded-lg bg-gray-800/50">
                    <span className={`mt-0.5 w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs ${f.passed ? 'bg-green-600' : 'bg-red-600'}`}>
                      {f.passed ? '✓' : '✗'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-200">{f.description}</p>
                      <p className="text-gray-500 font-mono truncate">{f.output}</p>
                    </div>
                    <Badge label={f.severity} variant={f.severity as 'high'} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-gray-500 text-sm">Select a server to see findings.</p>
          )}
        </div>
      </div>
    </div>
  )
}
