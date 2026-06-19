import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { api, Server, Assignment, ServerCredential } from '../api/client'
import '@xterm/xterm/css/xterm.css'

const MIN_FONT = 10
const MAX_FONT = 24
const DEFAULT_FONT = 14

// ── Per-tab state ────────────────────────────────────────────────────────────
type TabState = {
  id: string
  selectedServer: string
  selectedUser: string
  selectedCredentialId: string
  connected: boolean
  connecting: boolean
  status: string
  usedKey: string
  sessionSeconds: number
  showSearch: boolean
  searchQuery: string
  searchCase: boolean
  searchRegex: boolean
  fontSize: number
  dragOver: boolean
  uploading: boolean
  uploadMsg: string
  uploadPath: string
}

function makeTab(): TabState {
  return {
    id: crypto.randomUUID(),
    selectedServer: '',
    selectedUser: '',
    selectedCredentialId: '',
    connected: false,
    connecting: false,
    status: '',
    usedKey: '',
    sessionSeconds: 0,
    showSearch: false,
    searchQuery: '',
    searchCase: false,
    searchRegex: false,
    fontSize: DEFAULT_FONT,
    dragOver: false,
    uploading: false,
    uploadMsg: '',
    uploadPath: '/tmp/',
  }
}

export default function Terminal() {
  const [servers, setServers] = useState<Server[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [credsByServer, setCredsByServer] = useState<Record<string, ServerCredential[]>>({})
  const [tabs, setTabs] = useState<TabState[]>(() => [makeTab()])
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id)
  const [showCmdPanel, setShowCmdPanel] = useState(false)
  const [linuxCmds, setLinuxCmds] = useState<{id:string,category:string,label:string,command:string,description:string}[]>([])
  const [winCmds, setWinCmds] = useState<{id:string,category:string,label:string,command:string,description:string}[]>([])
  const [cmdCat, setCmdCat] = useState('All')
  const [cmdSearch, setCmdSearch] = useState('')
  const [linuxNotes, setLinuxNotes] = useState<{id:string,type:string,device_type?:string,name:string,content?:string}[]>([])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  const activeServerOs = servers.find(s => s.id === activeTab?.selectedServer)?.os_type

  // Per-tab refs
  const termRefs    = useRef<Record<string, HTMLDivElement | null>>({})
  const xtermRefs   = useRef<Record<string, XTerm>>({})
  const wsRefs      = useRef<Record<string, WebSocket>>({})
  const fitRefs     = useRef<Record<string, FitAddon>>({})
  const searchRefs  = useRef<Record<string, SearchAddon>>({})
  const timerRefs   = useRef<Record<string, ReturnType<typeof setInterval>>>({})
  const searchInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    api.get<Server[]>('/servers').then(setServers).catch(() => {})
    api.get<Assignment[]>('/assignments').then(setAssignments).catch(() => {})
  }, [])

  useEffect(() => {
    const sid = activeTab?.selectedServer
    if (!sid || credsByServer[sid] !== undefined) return
    api.get<ServerCredential[]>(`/servers/${sid}/credentials`)
      .then(creds => setCredsByServer(prev => ({ ...prev, [sid]: creds })))
      .catch(() => setCredsByServer(prev => ({ ...prev, [sid]: [] })))
  }, [activeTab?.selectedServer])

  useEffect(() => {
    if (!showCmdPanel) return
    if (activeServerOs === 'windows') {
      if (winCmds.length === 0) api.get<typeof winCmds>('/commands?os=windows').then(setWinCmds).catch(() => {})
    } else {
      if (linuxCmds.length === 0) api.get<typeof linuxCmds>('/commands?os=linux').then(setLinuxCmds).catch(() => {})
    }
    api.get<typeof linuxNotes>('/share/list').then(all => setLinuxNotes(all.filter((x: any) => x.type === 'text' && x.device_type === (activeServerOs === 'windows' ? 'windows' : 'linux')))).catch(() => {})
  }, [showCmdPanel, activeServerOs])

  // Fit active terminal when switching tabs
  useEffect(() => {
    const id = activeTabId
    setTimeout(() => {
      fitRefs.current[id]?.fit()
      xtermRefs.current[id]?.focus()
    }, 30)
  }, [activeTabId])

  // Global Ctrl+F for active tab search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tab = tabs.find((t) => t.id === activeTabId)
      if (!tab?.connected) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        updateTab(activeTabId, (t) => {
          const next = !t.showSearch
          setTimeout(() => searchInputRefs.current[activeTabId]?.focus(), 50)
          return { showSearch: next }
        })
      }
      if (e.key === 'Escape') updateTab(activeTabId, { showSearch: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId, tabs])

  // ── Tab helpers ─────────────────────────────────────────────────────────────
  function updateTab(id: string, patch: Partial<TabState> | ((t: TabState) => Partial<TabState>)) {
    setTabs((prev) => prev.map((t) => t.id === id
      ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) }
      : t
    ))
  }

  function addTab() {
    const tab = makeTab()
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  function closeTab(id: string) {
    // Disconnect if connected
    wsRefs.current[id]?.close()
    xtermRefs.current[id]?.dispose()
    clearInterval(timerRefs.current[id])
    delete termRefs.current[id]
    delete xtermRefs.current[id]
    delete wsRefs.current[id]
    delete fitRefs.current[id]
    delete searchRefs.current[id]
    delete timerRefs.current[id]

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (next.length === 0) {
        const newTab = makeTab()
        setActiveTabId(newTab.id)
        return [newTab]
      }
      if (activeTabId === id) {
        setActiveTabId(next[next.length - 1].id)
      }
      return next
    })
  }

  // ── Per-tab helpers ─────────────────────────────────────────────────────────
  function serverAssignmentsFor(tab: TabState) {
    const seen = new Set<string>()
    const result = assignments.filter((a) => {
      if (a.server_id !== tab.selectedServer || !a.can_terminal || !a.is_active) return false
      if (seen.has(a.linux_user)) return false
      seen.add(a.linux_user)
      return true
    })

    // Always ensure the management user appears, even when other assignments exist
    // (handles servers set up before the key_assignment was auto-created)
    if (tab.selectedServer) {
      const srv = servers.find((s) => s.id === tab.selectedServer)
      if (srv?.management_linux_user && srv.management_key_id) {
        const mgmtLower = srv.management_linux_user.toLowerCase()
        const alreadyIn = [...seen].some(u => u.toLowerCase() === mgmtLower)
        if (!alreadyIn) {
          // Prefer the casing stored in a credential if one exists for this user
          const credMatch = (credsByServer[tab.selectedServer] ?? [])
            .find(c => c.linux_user && c.linux_user.toLowerCase() === mgmtLower && !c.is_archived)
          const displayUser = credMatch?.linux_user ?? srv.management_linux_user
          result.unshift({
            id: '__mgmt__',
            server_id: srv.id,
            key_id: srv.management_key_id,
            linux_user: displayUser,
            can_terminal: true,
            is_active: true,
            user_id: '',
          } as Assignment)
        }
      }
    }

    return result
  }

  function credUsersFor(tab: TabState): ServerCredential[] {
    if (!tab.selectedServer) return []
    const creds = credsByServer[tab.selectedServer] ?? []
    const saList = serverAssignmentsFor(tab)
    const srv = servers.find(s => s.id === tab.selectedServer)
    // Case-insensitive set of users already covered by key assignments or management key
    const keyUsers = new Set([
      ...saList.map(a => a.linux_user.toLowerCase()),
      ...(srv?.management_linux_user ? [srv.management_linux_user.toLowerCase()] : []),
    ])
    const seen = new Set<string>()
    return creds.filter(c => {
      if (!['linux', 'windows'].includes(c.category)) return false
      if (c.is_archived || !c.linux_user) return false
      const lu = c.linux_user.toLowerCase()
      if (keyUsers.has(lu) || seen.has(lu)) return false
      seen.add(lu)
      return true
    })
  }

  function tabLabel(tab: TabState) {
    if (tab.status && tab.connected) {
      const srv = servers.find((s) => s.id === tab.selectedServer)
      return srv ? `${srv.name}` : tab.status
    }
    const srv = servers.find((s) => s.id === tab.selectedServer)
    return srv ? srv.name : 'New Tab'
  }

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // ── Connect ─────────────────────────────────────────────────────────────────
  const connect = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !tab.selectedServer || tab.connecting) return
    const saList = serverAssignmentsFor(tab)
    const credList = credUsersFor(tab)
    const totalUsers = saList.length + credList.length
    if (totalUsers > 1 && !tab.selectedUser) return

    updateTab(tabId, { connecting: true })

    const term = new XTerm({
      theme: {
        background: '#030712', foreground: '#e5e7eb', cursor: '#818cf8', cursorAccent: '#030712',
        selectionBackground: '#4f46e540',
        black: '#1f2937', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb',
        brightBlack: '#374151', brightRed: '#fca5a5', brightGreen: '#86efac',
        brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9', brightWhite: '#f9fafb',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: tab.fontSize,
      fontWeight: '400',
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
    })

    const fitAddon    = new FitAddon()
    const searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(new ClipboardAddon())

    const el = termRefs.current[tabId]
    if (el) {
      el.innerHTML = ''
      term.open(el)
      fitAddon.fit()
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch { /* canvas fallback */ }
    }

    xtermRefs.current[tabId]  = term
    fitRefs.current[tabId]    = fitAddon
    searchRefs.current[tabId] = searchAddon

    const singleCred = saList.length === 0 && credList.length === 1 ? credList[0] : null
    const linuxUser = tab.selectedUser || (saList.length === 1 ? saList[0].linux_user : '') || (singleCred?.linux_user ?? '')
    const credentialId = tab.selectedCredentialId || (singleCred?.id ?? '')
    const credParam = credentialId ? `&credential_id=${credentialId}` : ''
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal/${tab.selectedServer}${linuxUser ? `?linux_user=${linuxUser}${credParam}` : ''}`
    const ws = new WebSocket(wsUrl)
    wsRefs.current[tabId] = ws

    ws.onopen = () => {
      const { cols, rows } = term
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'output') {
          term.write(msg.data)
        } else if (msg.type === 'connected') {
          updateTab(tabId, { connected: true, connecting: false, status: `${msg.serverName} — ${msg.linuxUser}`, usedKey: msg.key_name ?? '' })
          // Start timer
          clearInterval(timerRefs.current[tabId])
          timerRefs.current[tabId] = setInterval(() => updateTab(tabId, (t) => ({ sessionSeconds: t.sessionSeconds + 1 })), 1000)
        } else if (msg.type === 'warning') {
          term.write(`\r\n\x1b[33m⚠ ${msg.message}\x1b[0m\r\n`)
          if (msg.key_name) updateTab(tabId, { usedKey: `⚠ fallback: ${msg.key_name}` })
        } else if (msg.type === 'error') {
          term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`)
          updateTab(tabId, { status: `Error: ${msg.message}`, connecting: false })
        } else if (msg.type === 'disconnected') {
          clearInterval(timerRefs.current[tabId])
          updateTab(tabId, { connected: false, connecting: false, status: 'Disconnected' })
          term.write('\r\n\x1b[33mSession ended.\x1b[0m\r\n')
        }
      } catch { /* malformed */ }
    }

    ws.onclose = () => {
      clearInterval(timerRefs.current[tabId])
      updateTab(tabId, { connected: false, connecting: false })
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    // Auto-copy selected text to clipboard when selection changes
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    })

    // Right-click to paste — use term.paste() for instant, properly-escaped paste
    el?.addEventListener('contextmenu', async (e) => {
      e.preventDefault()
      try {
        const text = await navigator.clipboard.readText()
        if (text) term.paste(text)
      } catch {
        const text = window.prompt('Paste text here (clipboard access denied):')
        if (text) term.paste(text)
      }
    })

    const onResize = () => fitAddon.fit()
    window.addEventListener('resize', onResize)
    ws.addEventListener('close', () => window.removeEventListener('resize', onResize))

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      else clearInterval(ping)
    }, 30000)

    term.focus()
  }, [tabs, assignments])

  const disconnect = (tabId: string) => {
    wsRefs.current[tabId]?.close()
    xtermRefs.current[tabId]?.dispose()
    clearInterval(timerRefs.current[tabId])
    updateTab(tabId, { connected: false, connecting: false, status: '', usedKey: '', showSearch: false, sessionSeconds: 0 })
  }

  const applyFontSize = (tabId: string, size: number) => {
    const clamped = Math.max(MIN_FONT, Math.min(MAX_FONT, size))
    updateTab(tabId, { fontSize: clamped })
    if (xtermRefs.current[tabId]) {
      xtermRefs.current[tabId].options.fontSize = clamped
      fitRefs.current[tabId]?.fit()
    }
  }

  const doSearch = (tabId: string, dir: 'next' | 'prev') => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !tab.searchQuery || !searchRefs.current[tabId]) return
    const opts = { caseSensitive: tab.searchCase, regex: tab.searchRegex, incremental: false }
    if (dir === 'next') searchRefs.current[tabId].findNext(tab.searchQuery, opts)
    else searchRefs.current[tabId].findPrevious(tab.searchQuery, opts)
  }

  // ── File upload via drag-and-drop ───────────────────────────────────────────
  const handleDrop = async (tabId: string, e: React.DragEvent) => {
    e.preventDefault()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !tab.connected) { updateTab(tabId, { dragOver: false }); return }

    const file = e.dataTransfer.files[0]
    if (!file) { updateTab(tabId, { dragOver: false }); return }

    updateTab(tabId, { dragOver: false, uploading: true, uploadMsg: `Uploading ${file.name}…` })

    try {
      const formData = new FormData()
      formData.append('file', file)
      const destPath = tab.uploadPath.endsWith('/') ? tab.uploadPath : tab.uploadPath + '/'
      const res = await fetch(`/api/servers/${tab.selectedServer}/sftp/upload?path=${encodeURIComponent(destPath)}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? 'Upload failed')
      }
      const result = await res.json()
      updateTab(tabId, { uploading: false, uploadMsg: `✓ Uploaded to ${result.path} (${(result.size / 1024).toFixed(1)} KB)` })
      xtermRefs.current[tabId]?.write(`\r\n\x1b[32m✓ File uploaded → ${result.path}\x1b[0m\r\n`)
      setTimeout(() => updateTab(tabId, { uploadMsg: '' }), 4000)
    } catch (err: unknown) {
      const msg = (err as Error).message
      updateTab(tabId, { uploading: false, uploadMsg: `✗ ${msg}` })
      xtermRefs.current[tabId]?.write(`\r\n\x1b[31m✗ Upload failed: ${msg}\x1b[0m\r\n`)
      setTimeout(() => updateTab(tabId, { uploadMsg: '' }), 5000)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-gray-950">

      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center bg-gray-900 border-b border-gray-800 overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={`group flex items-center gap-1.5 px-3 py-2 text-xs cursor-pointer border-r border-gray-800 shrink-0 select-none transition-colors ${
              tab.id === activeTabId
                ? 'bg-gray-950 text-white border-b-2 border-b-indigo-500'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
            }`}
            style={{ minWidth: 100, maxWidth: 180 }}
          >
            {tab.connected && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />}
            {tab.connecting && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />}
            {!tab.connected && !tab.connecting && <span className="w-1.5 h-1.5 rounded-full bg-gray-700 shrink-0" />}
            <span className="truncate">{tabLabel(tab)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
              className="ml-auto opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity shrink-0 leading-none"
              title="Close tab"
            >✕</button>
          </div>
        ))}
        <button
          onClick={addTab}
          className="px-3 py-2 text-gray-500 hover:text-white hover:bg-gray-800/50 text-sm shrink-0 transition-colors"
          title="New tab"
        >＋</button>
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      {activeTab && (() => {
        const tab = activeTab
        const saList = serverAssignmentsFor(tab)
        const credList = credUsersFor(tab)
        const totalUsers = saList.length + credList.length
        const canConnect = tab.selectedServer && (totalUsers <= 1 || tab.selectedUser)
        // Encode value: key users = "k|linux_user", cred users = "c|credId|linux_user"
        const dropdownValue = tab.selectedCredentialId
          ? `c|${tab.selectedCredentialId}|${tab.selectedUser}`
          : (tab.selectedUser ? `k|${tab.selectedUser}` : '')
        const handleUserChange = (val: string) => {
          if (val.startsWith('c|')) {
            const [, credId, lu] = val.split('|')
            updateTab(tab.id, { selectedUser: lu, selectedCredentialId: credId })
          } else {
            updateTab(tab.id, { selectedUser: val.replace(/^k\|/, ''), selectedCredentialId: '' })
          }
        }
        return (
          <div className="flex items-center gap-2 px-4 py-2 bg-gray-900/80 border-b border-gray-800 flex-wrap shrink-0">
            <select
              value={tab.selectedServer}
              onChange={(e) => updateTab(tab.id, { selectedServer: e.target.value, selectedUser: '', selectedCredentialId: '', usedKey: '', status: '' })}
              disabled={tab.connected || tab.connecting}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
            >
              <option value="">— server —</option>
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>)}
            </select>

            {tab.selectedServer && totalUsers > 0 && (
              <select
                value={dropdownValue}
                onChange={(e) => handleUserChange(e.target.value)}
                disabled={tab.connected || tab.connecting}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
              >
                {totalUsers === 1 && saList.length === 1 && (
                  <option value={`k|${saList[0].linux_user}`}>{saList[0].linux_user}</option>
                )}
                {totalUsers === 1 && credList.length === 1 && (
                  <option value={`c|${credList[0].id}|${credList[0].linux_user}`}>{credList[0].linux_user} (password)</option>
                )}
                {totalUsers > 1 && (
                  <>
                    <option value="">— user —</option>
                    {saList.map((a) => <option key={a.id} value={`k|${a.linux_user}`}>{a.linux_user}</option>)}
                    {credList.map((c) => <option key={c.id} value={`c|${c.id}|${c.linux_user}`}>{c.linux_user} (password)</option>)}
                  </>
                )}
              </select>
            )}

            {!tab.connected && !tab.connecting ? (
              <button onClick={() => connect(tab.id)} disabled={!canConnect}
                className="px-4 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                Connect
              </button>
            ) : tab.connecting ? (
              <button disabled className="px-4 py-1.5 bg-gray-700 text-gray-400 rounded-lg text-sm font-medium opacity-70 flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 border-2 border-gray-500 border-t-indigo-400 rounded-full animate-spin" />
                Connecting…
              </button>
            ) : (
              <button onClick={() => disconnect(tab.id)} className="px-4 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors">
                Disconnect
              </button>
            )}

            <div className="w-px h-5 bg-gray-700 mx-1 hidden sm:block" />

            {/* Font size */}
            <div className="flex items-center gap-1">
              <button onClick={() => applyFontSize(tab.id, tab.fontSize - 1)}
                className="w-6 h-6 flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-white text-xs">−</button>
              <span className="text-xs text-gray-400 w-8 text-center tabular-nums">{tab.fontSize}px</span>
              <button onClick={() => applyFontSize(tab.id, tab.fontSize + 1)}
                className="w-6 h-6 flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-white text-xs">+</button>
            </div>

            {tab.connected && (
              <>
                <button onClick={() => { xtermRefs.current[tab.id]?.clear(); xtermRefs.current[tab.id]?.focus() }}
                  className="px-2.5 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 hover:text-white transition-colors">Clear</button>
                <button
                  onClick={() => { updateTab(tab.id, (t) => ({ showSearch: !t.showSearch })); setTimeout(() => searchInputRefs.current[tab.id]?.focus(), 50) }}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${tab.showSearch ? 'bg-indigo-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200 hover:text-white'}`}
                  title="Search (Ctrl+F)">
                  🔍 Search
                </button>
                <button
                  onClick={() => setShowCmdPanel(p => !p)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${showCmdPanel ? 'bg-indigo-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200 hover:text-white'}`}
                  title="Linux command library">
                  📚 Commands
                </button>
              </>
            )}

            {/* Upload destination path (when connected) */}
            {tab.connected && (
              <div className="flex items-center gap-1 ml-1">
                <span className="text-xs text-gray-500">📁</span>
                <input
                  value={tab.uploadPath}
                  onChange={(e) => updateTab(tab.id, { uploadPath: e.target.value })}
                  title="Drop destination path"
                  placeholder="/tmp/"
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-36"
                />
              </div>
            )}

            {/* Status / key */}
            <div className="ml-auto flex items-center gap-3 text-xs">
              {tab.connected && <span className="text-gray-600 tabular-nums font-mono">{formatDuration(tab.sessionSeconds)}</span>}
              {tab.uploadMsg && (
                <span className={tab.uploadMsg.startsWith('✓') ? 'text-green-400' : tab.uploadMsg.startsWith('✗') ? 'text-red-400' : 'text-yellow-400'}>
                  {tab.uploadMsg}
                </span>
              )}
              {tab.status && !tab.uploadMsg && (
                <span className={tab.status.startsWith('Error') || tab.status === 'Disconnected' ? 'text-red-400' : 'text-gray-400'}>
                  {tab.connected ? '🟢' : '⚫'} {tab.status}
                </span>
              )}
              {tab.usedKey && (
                <span className={`font-mono ${tab.usedKey.startsWith('⚠') ? 'text-yellow-400' : 'text-green-400'}`}>
                  🔑 {tab.usedKey}
                </span>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Search bar (active tab) ──────────────────────────────────────────── */}
      {activeTab?.showSearch && (
        <div className="flex items-center gap-2 px-4 py-2 bg-gray-900/80 border-b border-gray-800 flex-wrap shrink-0">
          <input
            ref={(el) => { searchInputRefs.current[activeTab.id] = el }}
            value={activeTab.searchQuery}
            onChange={(e) => {
              updateTab(activeTab.id, { searchQuery: e.target.value })
              if (searchRefs.current[activeTab.id] && e.target.value)
                searchRefs.current[activeTab.id].findNext(e.target.value, { caseSensitive: activeTab.searchCase, regex: activeTab.searchRegex, incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch(activeTab.id, e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') { updateTab(activeTab.id, { showSearch: false }); xtermRefs.current[activeTab.id]?.focus() }
            }}
            placeholder="Search terminal… (Enter = next, Shift+Enter = prev)"
            className="flex-1 max-w-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button onClick={() => doSearch(activeTab.id, 'prev')} className="px-2.5 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">↑ Prev</button>
          <button onClick={() => doSearch(activeTab.id, 'next')} className="px-2.5 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white transition-colors">↓ Next</button>
          <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={activeTab.searchCase} onChange={(e) => updateTab(activeTab.id, { searchCase: e.target.checked })} className="rounded" />Aa
          </label>
          <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={activeTab.searchRegex} onChange={(e) => updateTab(activeTab.id, { searchRegex: e.target.checked })} className="rounded" />.*
          </label>
          <button onClick={() => { updateTab(activeTab.id, { showSearch: false }); xtermRefs.current[activeTab.id]?.focus() }}
            className="px-2.5 py-1 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 hover:text-white transition-colors">✕</button>
        </div>
      )}

      {/* ── Terminal canvases (all rendered, only active visible) ─────────────── */}
      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 relative overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0 flex flex-col"
            style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
          >
            {/* Drag-and-drop overlay */}
            {tab.dragOver && (
              <div className="absolute inset-0 z-20 bg-indigo-900/80 border-2 border-dashed border-indigo-400 flex flex-col items-center justify-center gap-3 pointer-events-none">
                <div className="text-4xl">📂</div>
                <div className="text-white text-lg font-semibold">Drop file to upload</div>
                <div className="text-indigo-300 text-sm">→ {tab.uploadPath}</div>
              </div>
            )}
            {/* Upload progress overlay */}
            {tab.uploading && (
              <div className="absolute inset-0 z-20 bg-gray-900/60 flex items-center justify-center pointer-events-none">
                <div className="bg-gray-800 border border-gray-700 rounded-xl px-6 py-4 flex items-center gap-3">
                  <span className="inline-block w-5 h-5 border-2 border-gray-500 border-t-indigo-400 rounded-full animate-spin" />
                  <span className="text-white text-sm">{tab.uploadMsg}</span>
                </div>
              </div>
            )}

            {/* Empty state */}
            {!tab.connected && !tab.connecting && !tab.status && (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-600 text-sm gap-2">
                <div className="text-3xl">⌨️</div>
                <div>Select a server and click <span className="text-gray-500">Connect</span> to start a session.</div>
                <div className="text-xs text-gray-700 mt-1">Drag &amp; drop a file onto the terminal to upload it via SFTP</div>
              </div>
            )}

            {/* Terminal div */}
            <div
              ref={(el) => { termRefs.current[tab.id] = el }}
              className="flex-1 overflow-hidden p-2"
              style={{ display: tab.connected || tab.connecting || tab.status ? 'block' : 'none', minHeight: 0 }}
              onDragOver={(e) => { e.preventDefault(); if (tab.connected) updateTab(tab.id, { dragOver: true }) }}
              onDragLeave={() => updateTab(tab.id, { dragOver: false })}
              onDrop={(e) => handleDrop(tab.id, e)}
            />
          </div>
        ))}

        </div>
        {/* ── Commands sidebar ── */}
        {showCmdPanel && activeTab?.connected && (() => {
          const isWin = activeServerOs === 'windows'
          const cmds = isWin ? winCmds : linuxCmds
          const cats = ['All', ...Array.from(new Set(cmds.map(c => c.category))).sort()]
          const filtered = cmds.filter(c =>
            (cmdCat === 'All' || c.category === cmdCat) &&
            (!cmdSearch || c.label.toLowerCase().includes(cmdSearch.toLowerCase()) || c.command.toLowerCase().includes(cmdSearch.toLowerCase()))
          )
          const sendCmd = (cmd: string) => {
            const ws = wsRefs.current[activeTabId]
            if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: cmd + '\n' }))
          }
          return (
            <div style={{ width: 300, background: '#111827', borderLeft: '1px solid #1f2937', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
              <div style={{ padding: '8px 10px', borderBottom: '1px solid #1f2937', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input value={cmdSearch} onChange={e => setCmdSearch(e.target.value)} placeholder="Search…"
                  style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #374151', background: '#1f2937', color: '#e5e7eb', fontSize: 11, boxSizing: 'border-box' as const }} />
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                  {cats.map(cat => (
                    <button key={cat} onClick={() => setCmdCat(cat)} style={{
                      padding: '2px 7px', borderRadius: 999, border: '1px solid', fontSize: 10, cursor: 'pointer',
                      borderColor: cmdCat === cat ? '#6366f1' : '#374151',
                      background: cmdCat === cat ? '#6366f122' : 'transparent',
                      color: cmdCat === cat ? '#a5b4fc' : '#9ca3af',
                    }}>{cat}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {/* Linux sticky notes */}
                {linuxNotes.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: isWin ? '#0078d4' : '#e95420', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      {isWin ? '🪟 Windows Notes' : '🐧 Linux Notes'} ({linuxNotes.length})
                    </div>
                    {linuxNotes.map(note => (
                      <div key={note.id} style={{ background: '#fff9e6', border: `2px solid ${isWin ? '#0078d4' : '#e95420'}`, borderRadius: 6, padding: 8, marginBottom: 5 }}>
                        {note.name && note.name !== 'Note' && (
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#c04400', marginBottom: 3 }}>{note.name}</div>
                        )}
                        <code style={{ display: 'block', fontSize: 10, color: '#333', fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 5 }}>{note.content}</code>
                        <button onClick={() => sendCmd(note.content || '')} style={{
                          width: '100%', padding: '4px', borderRadius: 4, border: 'none',
                          background: activeTab?.connected ? '#4f46e5' : '#374151',
                          color: activeTab?.connected ? '#fff' : '#6b7280',
                          fontSize: 10, fontWeight: 600, cursor: activeTab?.connected ? 'pointer' : 'not-allowed',
                        }}>
                          {activeTab?.connected ? '▶ Run' : 'Connect first'}
                        </button>
                      </div>
                    ))}
                    <div style={{ height: 1, background: '#1f2937', margin: '8px 0' }} />
                  </div>
                )}
                {filtered.map(c => (
                  <div key={c.id} style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 6, padding: '7px 9px' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#e5e7eb', marginBottom: 2 }}>{c.label}</div>
                    <code style={{ display: 'block', fontSize: 10, color: '#93c5fd', fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 5 }}>{c.command}</code>
                    {c.description && <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 5 }}>{c.description}</div>}
                    <button onClick={() => sendCmd(c.command)} style={{
                      width: '100%', padding: '4px', borderRadius: 4, border: 'none',
                      background: activeTab?.connected ? '#4f46e5' : '#374151',
                      color: activeTab?.connected ? '#fff' : '#6b7280',
                      fontSize: 10, fontWeight: 600, cursor: activeTab?.connected ? 'pointer' : 'not-allowed',
                    }}>
                      {activeTab?.connected ? '▶ Run' : 'Connect first'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}
      </div>

      {/* ── Hint bar ─────────────────────────────────────────────────────────── */}
      {activeTab?.connected && (
        <div className="px-4 py-1 bg-gray-900/60 border-t border-gray-800 text-xs text-gray-700 flex gap-4 shrink-0">
          <span>Ctrl+F — search</span>
          <span>Right-click — paste</span>
          <span>Select — copy</span>
          <span>Drag file → terminal — upload via SFTP</span>
        </div>
      )}
    </div>
  )
}
