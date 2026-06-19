import { useEffect, useState, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api/client'

type Cred = {
  id: string
  label: string
  server_name: string
  service_username: string | null
  linux_user: string | null
  notes: string | null
  category: string
}

type ExecResult = {
  stdout: string
  stderr: string
  ok: boolean
  error?: string
}

type HistoryEntry = {
  id: number
  target: string
  command: string
  result: ExecResult
  ts: Date
}

// ── Shell panel ──
function PsExecShell({ target, credId, method, onClose }: { target: string; credId: string; method: string; onClose: () => void }) {
  const termDivRef = useRef<HTMLDivElement>(null)
  const inputRef   = useRef<HTMLInputElement>(null)
  const xtermRef   = useRef<XTerm | null>(null)
  const wsRef      = useRef<WebSocket | null>(null)
  const [status, setStatus]       = useState<'connecting'|'connected'|'disconnected'|'error'>('connecting')
  const [statusMsg, setStatusMsg] = useState('')
  const [cmd, setCmd]             = useState('')
  const [history, setHistory]     = useState<string[]>([])
  const [histIdx, setHistIdx]     = useState(-1)

  useEffect(() => {
    const el = termDivRef.current
    if (!el) return
    el.innerHTML = ''
    const xterm = new XTerm({
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13, cursorBlink: true, scrollback: 5000, convertEol: true, disableStdin: true,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(new WebLinksAddon())
    xterm.open(el)
    requestAnimationFrame(() => fit.fit())
    xtermRef.current = xterm

    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${wsProto}://${window.location.host}/api/psexec/session?target=${encodeURIComponent(target)}&cred_id=${encodeURIComponent(credId)}&method=${encodeURIComponent(method)}`
    )
    wsRef.current = ws
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if      (msg.type==='output')       xterm.write(msg.data)
        else if (msg.type==='connected')    { setStatus('connected'); setStatusMsg(`${msg.username}@${msg.target}`); setTimeout(()=>inputRef.current?.focus(), 100) }
        else if (msg.type==='disconnected') { setStatus('disconnected'); xterm.writeln('\r\n\x1b[33m[Session closed]\x1b[0m') }
        else if (msg.type==='error')        { setStatus('error'); setStatusMsg(msg.message); xterm.writeln(`\r\n\x1b[31m[${msg.message}]\x1b[0m`) }
      } catch {}
    }
    ws.onclose = () => setStatus(s => s==='connected' ? 'disconnected' : s)
    ws.onerror = () => { setStatus('error'); setStatusMsg('Connection error') }

    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); ws.close(); xterm.dispose() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const send = (data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
  }

  const sendSignal = (signal: 'SIGKILL') => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', signal }))
  }

  const disconnect = () => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'disconnect' }))
    onClose()
  }

  const submit = () => {
    if (!cmd.trim() && status !== 'connected') return
    send(cmd + '\n')
    setHistory(h => [cmd, ...h].slice(0, 50))
    setHistIdx(-1)
    setCmd('')
    inputRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { submit() }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(histIdx + 1, history.length - 1)
      setHistIdx(next); setCmd(history[next] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.max(histIdx - 1, -1)
      setHistIdx(next); setCmd(next === -1 ? '' : history[next])
    }
  }

  const statusConfig = {
    connected:    { dot: 'bg-green-500',  text: 'text-green-400',  label: 'Connected' },
    connecting:   { dot: 'bg-blue-400 animate-pulse', text: 'text-blue-400', label: 'Connecting…' },
    disconnected: { dot: 'bg-gray-500',   text: 'text-gray-400',  label: 'Disconnected' },
    error:        { dot: 'bg-red-500',    text: 'text-red-400',   label: 'Error' },
  }[status]

  return (
    <div className="flex flex-col rounded-xl border border-gray-700 overflow-hidden bg-[#0d1117]">
      {/* Shell header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-700 bg-gray-900">
        <span className="text-sm font-semibold text-gray-200">🖥 Shell — <span className="font-mono text-indigo-300">{target}</span></span>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusConfig.dot}`} />
          <span className={`text-xs font-medium ${statusConfig.text}`}>{statusConfig.label}</span>
        </div>
        {statusMsg && <span className="text-xs text-gray-500 truncate">{statusMsg}</span>}
        <div className="ml-auto flex gap-2">
          <button onClick={() => sendSignal('SIGKILL')} disabled={status !== 'connected'}
            className="px-2.5 py-1 text-xs rounded border border-red-900 bg-red-950/40 text-red-400 hover:bg-red-900/60 transition-colors disabled:opacity-30 font-mono cursor-pointer">
            Force Kill
          </button>
          <button onClick={disconnect}
            className="px-2.5 py-1 text-xs rounded border border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors cursor-pointer">
            ✕ Disconnect
          </button>
        </div>
      </div>

      {/* Terminal output */}
      <div ref={termDivRef} style={{ height: 420 }} />

      {/* Command input */}
      <div className="flex items-center border-t border-gray-700 bg-[#0d1117] px-3">
        <span className="font-mono text-sm text-blue-400 mr-2 select-none shrink-0">❯</span>
        <input
          ref={inputRef}
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={status !== 'connected'}
          placeholder={status === 'connecting' ? 'Connecting…' : status !== 'connected' ? 'Session closed' : 'Type a command…'}
          className="flex-1 bg-transparent border-none outline-none font-mono text-sm text-gray-200 py-3 caret-blue-400 placeholder-gray-600 disabled:opacity-40"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  )
}

// ── Main page ──
export default function PsExec() {
  const [searchParams] = useSearchParams()
  const [creds, setCreds] = useState<Cred[]>([])
  const [credsLoading, setCredsLoading] = useState(true)

  const [target, setTarget]       = useState(searchParams.get('target') ?? '')
  const [credId, setCredId]       = useState('')
  const [command, setCommand]     = useState('')
  const [timeoutSec, setTimeoutSec] = useState(30)
  const [running, setRunning]     = useState(false)
  const [result, setResult]       = useState<ExecResult | null>(null)
  const [pingStatus, setPingStatus] = useState<'unknown' | 'online' | 'offline'>('unknown')
  const [pinging, setPinging]     = useState(false)

  const [history, setHistory]     = useState<HistoryEntry[]>([])
  const historyId                 = useRef(0)
  const outputRef                 = useRef<HTMLPreElement>(null)

  const [method, setMethod]       = useState<'psexec' | 'wmiexec' | 'winrm'>('psexec')
  const [mainTab, setMainTab]     = useState<'run' | 'shell'>('run')
  const [sessionOpen, setSessionOpen] = useState(false)
  const [sessionKey, setSessionKey]   = useState(0)

  useEffect(() => {
    api.get<{ credentials: Cred[] }>('/psexec/credentials')
      .then(r => setCreds(r.credentials))
      .catch(() => {
        api.get<any[]>('/vault/credentials').then(rows => {
          setCreds(rows
            .filter((c: any) => c.category === 'windows' || c.category === 'other')
            .map((c: any) => ({ id: c.id, label: c.label, server_name: c.server_name ?? '', service_username: c.service_username, linux_user: c.linux_user, notes: c.notes, category: c.category }))
          )
        }).catch(() => {})
      })
      .finally(() => setCredsLoading(false))
  }, [])

  const ping = async () => {
    if (!target.trim()) return
    setPinging(true); setPingStatus('unknown')
    try {
      const r = await api.post<{ online: boolean }>('/psexec/ping', { host: target.trim() })
      setPingStatus(r.online ? 'online' : 'offline')
    } catch { setPingStatus('offline') }
    finally { setPinging(false) }
  }

  const run = async () => {
    if (!target.trim() || !credId || !command.trim()) return
    setRunning(true); setResult(null)
    try {
      const r = await api.post<ExecResult>('/psexec/exec', { target: target.trim(), cred_id: credId, command: command.trim(), timeout_sec: timeoutSec, method })
      setResult(r)
      const entry: HistoryEntry = { id: ++historyId.current, target: target.trim(), command: command.trim(), result: r, ts: new Date() }
      setHistory(h => [entry, ...h].slice(0, 50))
      setTimeout(() => outputRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err: unknown) {
      setResult({ ok: false, stdout: '', stderr: '', error: (err as Error).message })
    } finally { setRunning(false) }
  }

  const openSession = useCallback(() => {
    if (!target.trim() || !credId) return
    setSessionKey(k => k + 1)
    setSessionOpen(true)
    setMainTab('shell')
  }, [target, credId])

  const selectedCred = creds.find(c => c.id === credId)
  const credDisplay  = selectedCred ? (selectedCred.service_username ?? selectedCred.linux_user ?? selectedCred.label) : null
  const canRun       = !!target.trim() && !!credId
  const canExec      = canRun && !!command.trim()

  const QUICK_COMMANDS = [
    { label: 'Who am I',          cmd: 'whoami' },
    { label: 'Hostname',          cmd: 'hostname' },
    { label: 'IP config',         cmd: 'ipconfig /all' },
    { label: 'Running processes', cmd: 'tasklist' },
    { label: 'System info',       cmd: 'systeminfo' },
    { label: 'Disk space',        cmd: 'wmic logicaldisk get caption,freespace,size' },
    { label: 'Uptime',            cmd: 'net statistics workstation | findstr "since"' },
    { label: 'List users',        cmd: 'net user' },
  ]

  const CLEANUP_COMMANDS = [
    { label: 'List leftover services', cmd: `powershell -Command "Get-WmiObject Win32_Service | Where-Object {$_.Name -like 'WinSvc*'} | Select-Object Name,State,PathName | Format-Table -AutoSize"` },
    { label: 'Clean stopped services', cmd: `powershell -Command "$svcs=Get-WmiObject Win32_Service|Where-Object{$_.Name -like 'WinSvc*'};foreach($s in $svcs){sc.exe stop $s.Name|Out-Null;Start-Sleep -Seconds 2;sc.exe delete $s.Name|Out-Null;Remove-Item $s.PathName -Force -EA SilentlyContinue;Write-Output('Cleaned: '+$s.Name)};Write-Output('Done: '+$svcs.Count+' services')"` },
  ]

  const WINRM_SETUP = [
    { label: '1. Enable WinRM + Firewall', cmd: 'powershell -Command "Enable-PSRemoting -Force -SkipNetworkProfileCheck"' },
    { label: '2. Allow Basic Auth', cmd: 'powershell -Command "Set-Item WSMan:\\localhost\\Service\\Auth\\Basic $true; Set-Item WSMan:\\localhost\\Client\\Auth\\Basic $true"' },
    { label: '3. Allow unencrypted', cmd: 'powershell -Command "Set-Item WSMan:\\localhost\\Service\\AllowUnencrypted $true; Set-Item WSMan:\\localhost\\Client\\AllowUnencrypted $true"' },
    { label: '4. Defender exclusion', cmd: `powershell -Command "Add-MpPreference -ExclusionPath 'C:\\Windows\\WinSvc*.exe'"` },
    { label: '⚡ All in one', cmd: `powershell -Command "Enable-PSRemoting -Force -SkipNetworkProfileCheck; Set-Item WSMan:\\localhost\\Service\\Auth\\Basic $true; Set-Item WSMan:\\localhost\\Client\\Auth\\Basic $true; Set-Item WSMan:\\localhost\\Service\\AllowUnencrypted $true; Set-Item WSMan:\\localhost\\Client\\AllowUnencrypted $true; Add-MpPreference -ExclusionPath 'C:\\Windows\\WinSvc*.exe'"` },
  ]

  const TIPS: Record<string, string[]> = {
    psexec:  ['Port 445 (SMB) must be open', 'May trigger Windows Defender (VirTool detection)', 'Commands run as SYSTEM on the remote machine', 'Use WMIExec or WinRM to avoid AV issues'],
    wmiexec: ['Port 135 + dynamic RPC ports must be open', 'Uses WMI over DCOM — no service binary deployed', 'Much less likely to trigger Windows Defender', 'Slower than PsExec but stealth-friendly'],
    winrm:   ['Run on target: winrm quickconfig -y', 'Port 5985 (HTTP) or 5986 (HTTPS) must be open', 'Built-in Windows — no AV issues', 'Ideal for AD environments with GPO-enabled WinRM'],
  }

  const METHODS = [
    { val: 'psexec'  as const, label: 'PsExec',  desc: 'SMB · may trigger AV' },
    { val: 'wmiexec' as const, label: 'WMIExec', desc: 'SMB · no AV' },
    { val: 'winrm'   as const, label: 'WinRM',   desc: 'Port 5985/5986' },
  ]

  return (
    <div className="p-6 max-w-[1200px]">

      {/* Page header */}
      <div className="mb-5">
        <h1 className="text-xl font-bold text-white mb-1">⚡ Remote Exec</h1>
        <p className="text-sm text-gray-500">Run commands on remote Windows machines using stored credentials</p>
      </div>

      {/* Method tabs */}
      <div className="flex gap-1 mb-5 bg-gray-900 border border-gray-700 rounded-lg p-1 w-fit">
        {METHODS.map(m => (
          <button key={m.val}
            onClick={() => { setMethod(m.val); setSessionOpen(false); setMainTab('run') }}
            className={`px-4 py-2 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
              method === m.val
                ? 'bg-indigo-600 text-white shadow'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
            }`}>
            {m.label}
            <span className={`block text-[10px] font-normal mt-0.5 ${method === m.val ? 'text-indigo-200' : 'text-gray-600'}`}>{m.desc}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_280px] gap-5 items-start">

        {/* ── Left: main panel ── */}
        <div className="flex flex-col gap-4 min-w-0">

          {/* Connection card */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-3">Connection</p>

            {/* Target row */}
            <div className="flex gap-2 items-center mb-3">
              <div className="relative flex-1">
                <input
                  value={target} onChange={e => { setTarget(e.target.value); setPingStatus('unknown') }}
                  placeholder="192.168.1.10 or PC-NAME"
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                  onKeyDown={e => e.key === 'Enter' && ping()}
                />
              </div>
              <button onClick={ping} disabled={pinging || !target.trim()}
                className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg border border-gray-600 bg-gray-900 text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-40 cursor-pointer">
                {pinging ? '⏳' : '🏓 Ping'}
              </button>
              {pingStatus !== 'unknown' && (
                <span className={`shrink-0 text-xs font-bold ${pingStatus === 'online' ? 'text-green-400' : 'text-red-400'}`}>
                  {pingStatus === 'online' ? '● Online' : '● Offline'}
                </span>
              )}
            </div>

            {/* Credential row */}
            <div className="mb-3">
              <label className="text-xs text-gray-400 font-medium block mb-1.5">Credential</label>
              {credsLoading ? (
                <p className="text-xs text-gray-500">Loading…</p>
              ) : (
                <select value={credId} onChange={e => setCredId(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500">
                  <option value="">— Select a credential —</option>
                  {creds.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.label}{c.service_username ? ` (${c.service_username})` : c.linux_user ? ` (${c.linux_user})` : ''}
                      {c.server_name ? ` — ${c.server_name}` : ''}
                    </option>
                  ))}
                </select>
              )}
              {selectedCred && (
                <p className="text-xs text-gray-500 mt-1.5">
                  User: <span className="font-mono text-gray-300">{credDisplay}</span>
                  {selectedCred.notes?.match(/Domain:\s*(.+)/i)?.[1] && (
                    <> · Domain: <span className="font-mono text-gray-300">{selectedCred.notes.match(/Domain:\s*(.+)/i)![1]}</span></>
                  )}
                </p>
              )}
            </div>

            {/* Timeout */}
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-400 font-medium whitespace-nowrap">Timeout (sec)</label>
              <input type="number" min={5} max={120} value={timeoutSec} onChange={e => setTimeoutSec(Number(e.target.value))}
                className="w-16 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-center text-gray-200 focus:outline-none focus:border-indigo-500" />
            </div>
          </div>

          {/* Run / Shell tabs */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl overflow-hidden">
            {/* Tab bar */}
            <div className="flex border-b border-gray-700 bg-gray-900/50">
              <button
                onClick={() => setMainTab('run')}
                className={`px-5 py-2.5 text-xs font-semibold transition-colors cursor-pointer ${
                  mainTab === 'run'
                    ? 'text-white border-b-2 border-indigo-500 bg-gray-800/60'
                    : 'text-gray-400 hover:text-gray-200'
                }`}>
                ▶ Run Command
              </button>
              <button
                onClick={() => {
                  if (method === 'wmiexec') return
                  setMainTab('shell')
                  if (!sessionOpen && canRun) { setSessionKey(k => k + 1); setSessionOpen(true) }
                }}
                disabled={method === 'wmiexec'}
                title={method === 'wmiexec' ? 'Shell not available for WMIExec — switch to PsExec or WinRM' : ''}
                className={`px-5 py-2.5 text-xs font-semibold transition-colors ${
                  method === 'wmiexec'
                    ? 'text-gray-600 cursor-not-allowed'
                    : mainTab === 'shell'
                    ? 'text-white border-b-2 border-green-500 bg-gray-800/60 cursor-pointer'
                    : 'text-gray-400 hover:text-gray-200 cursor-pointer'
                }`}>
                🖥 Shell {method === 'wmiexec' && <span className="text-[10px] text-gray-600">(unavailable)</span>}
              </button>
              {sessionOpen && mainTab === 'shell' && (
                <button
                  onClick={() => { setSessionOpen(false); setMainTab('run') }}
                  className="ml-auto px-4 py-2.5 text-xs text-red-400 hover:text-red-300 transition-colors cursor-pointer">
                  ✕ Close Shell
                </button>
              )}
            </div>

            {/* Run Command panel */}
            {mainTab === 'run' && (
              <div className="p-4">
                <textarea
                  value={command} onChange={e => setCommand(e.target.value)}
                  placeholder="e.g. ipconfig /all"
                  rows={5}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-600 resize-y focus:outline-none focus:border-indigo-500 box-border"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run() }}
                />
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={run} disabled={running || !canExec}
                    className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-40 cursor-pointer">
                    {running ? '⏳ Running…' : '▶ Run  '}
                    <span className="text-xs font-normal opacity-60 ml-1">Ctrl+Enter</span>
                  </button>
                  {running && <span className="text-xs text-gray-500">Executing on <span className="font-mono text-gray-400">{target}</span>…</span>}
                </div>

                {/* Output */}
                {result && (
                  <div className={`mt-4 rounded-lg border overflow-hidden ${result.ok ? 'border-gray-700' : 'border-red-900'}`}>
                    <div className={`flex items-center gap-2 px-3 py-2 border-b ${result.ok ? 'border-gray-700 bg-gray-900/50' : 'border-red-900 bg-red-950/30'}`}>
                      <span className={`text-xs font-semibold ${result.ok ? 'text-green-400' : 'text-red-400'}`}>{result.ok ? '✓ Success' : '✗ Error'}</span>
                      {result.stderr && <span className="text-xs text-gray-500">· stderr present</span>}
                    </div>
                    <pre ref={outputRef} className={`m-0 p-3 font-mono text-xs leading-relaxed bg-[#0d1117] whitespace-pre-wrap break-all max-h-72 overflow-y-auto ${result.ok ? 'text-green-100' : 'text-red-300'}`}>
                      {result.error ?? result.stdout ?? '(no output)'}
                      {result.stderr && <span className="text-yellow-400">{'\n--- stderr ---\n'}{result.stderr}</span>}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Shell panel */}
            {mainTab === 'shell' && (
              <div className="p-4">
                {!canRun ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-2 text-gray-500">
                    <span className="text-3xl">🖥</span>
                    <p className="text-sm">Enter a target and select a credential to open a shell</p>
                  </div>
                ) : sessionOpen ? (
                  <PsExecShell key={sessionKey} target={target.trim()} credId={credId} method={method} onClose={() => { setSessionOpen(false); setMainTab('run') }} />
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-500">
                    <span className="text-3xl">🖥</span>
                    <button onClick={openSession}
                      className="px-5 py-2 rounded-lg text-sm font-semibold bg-green-700 hover:bg-green-600 text-white transition-colors cursor-pointer">
                      Open Shell
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Command history */}
          {history.length > 0 && (
            <div className="bg-gray-800/60 border border-gray-700 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/50">
                <span className="text-xs font-semibold text-gray-400">History</span>
                <button onClick={() => setHistory([])} className="text-xs text-gray-600 hover:text-gray-400 transition-colors cursor-pointer">Clear</button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {history.map(h => (
                  <div key={h.id} onClick={() => { setCommand(h.command); setResult(h.result); setMainTab('run') }}
                    className="flex items-center gap-3 px-4 py-2 border-b border-gray-700/50 hover:bg-gray-700/30 cursor-pointer">
                    <span className={`shrink-0 text-xs font-bold ${h.result.ok ? 'text-green-400' : 'text-red-400'}`}>{h.result.ok ? '✓' : '✗'}</span>
                    <span className="font-mono text-xs text-gray-200 flex-1 truncate">{h.command}</span>
                    <span className="text-xs text-gray-500 shrink-0 font-mono">{h.target}</span>
                    <span className="text-xs text-gray-600 shrink-0">{h.ts.toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right: sidebar ── */}
        <div className="flex flex-col gap-4">

          {/* WinRM setup (only when wmiexec selected) */}
          {method === 'wmiexec' && (
            <div className="bg-blue-950/30 border border-blue-900/60 rounded-xl overflow-hidden">
              <p className="px-4 py-2.5 text-xs font-semibold text-blue-300 border-b border-blue-900/60">⚡ WinRM Setup via WMIExec</p>
              <p className="px-4 py-2 text-[11px] text-gray-500 border-b border-gray-700/50">Run in order to enable WinRM</p>
              {WINRM_SETUP.map(q => (
                <button key={q.label} onClick={() => setCommand(q.cmd)}
                  className="w-full text-left px-4 py-2.5 border-b border-gray-700/30 hover:bg-blue-900/20 transition-colors cursor-pointer">
                  <span className="text-xs font-semibold text-blue-300 block">{q.label}</span>
                  <span className="text-[10px] font-mono text-gray-600 truncate block mt-0.5">{q.cmd.slice(0, 50)}…</span>
                </button>
              ))}
            </div>
          )}

          {/* Quick commands */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl overflow-hidden">
            <p className="px-4 py-2.5 text-xs font-semibold text-gray-400 border-b border-gray-700">Quick Commands</p>
            {QUICK_COMMANDS.map(q => (
              <button key={q.cmd} onClick={() => { setCommand(q.cmd); setMainTab('run') }}
                className="w-full text-left px-4 py-2.5 border-b border-gray-700/40 hover:bg-gray-700/40 transition-colors cursor-pointer group">
                <span className="text-xs font-semibold text-gray-200 group-hover:text-white block">{q.label}</span>
                <span className="text-[10px] font-mono text-gray-500">{q.cmd}</span>
              </button>
            ))}
          </div>

          {/* Impacket cleanup */}
          <div className="bg-red-950/20 border border-red-900/50 rounded-xl overflow-hidden">
            <p className="px-4 py-2.5 text-xs font-semibold text-red-400 border-b border-red-900/50">🧹 Impacket Cleanup</p>
            <p className="px-4 py-2 text-[11px] text-gray-500 border-b border-gray-700/30">Removes leftover services & binaries from unclean sessions</p>
            {CLEANUP_COMMANDS.map(q => (
              <button key={q.label} onClick={() => { setCommand(q.cmd); setMainTab('run') }}
                className="w-full text-left px-4 py-2.5 border-b border-gray-700/30 hover:bg-red-900/20 transition-colors cursor-pointer">
                <span className="text-xs font-semibold text-red-400">{q.label}</span>
              </button>
            ))}
          </div>

          {/* Tips */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-3">
              Tips — {method === 'psexec' ? 'PsExec' : method === 'wmiexec' ? 'WMIExec' : 'WinRM'}
            </p>
            <ul className="space-y-2 pl-3">
              {TIPS[method].map((tip, i) => (
                <li key={i} className="text-[11px] text-gray-400 leading-relaxed list-disc">{tip}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
