import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { api, Server, Assignment, ServerCredential, distroArtApi, DistroArt } from '../api/client'
import '@xterm/xterm/css/xterm.css'

const MIN_FONT = 10
const MAX_FONT = 24

const monoFont = '"JetBrains Mono","Fira Code","Cascadia Code",monospace'

// ─────────────────────────────────────────────────────────────────────────────
// DISTRO_ART — Edit this section to customise logos.
//
//   key   : matches the server's distro / os_id value (lowercase).
//           Use 'default' as the fallback when no key is found.
//   art   : array of strings, one per line. All lines should be the same width.
//   color : hex color for the art.
//
// Multi-color logos (windows, centos) are handled as special cases below
// because they need per-character coloring via JSX spans.
// ─────────────────────────────────────────────────────────────────────────────
type ArtDef = { art: string[]; color: string }

const DISTRO_ART: Record<string, ArtDef> = {

  // ── Default / Unknown Linux (Tux-inspired) ────────────────────────────────
  default: { color: '#94a3b8', art: [
    '     .---.     ',
    '    / . . \\    ',
    '   |       |   ',
    '   |  ___  |   ',
    '   | /   \\ |   ',
    '    \\_____/    ',
    '  /|       |\\  ',
    ' /_|_______|_\\ ',
    '   |       |   ',
    '   |_______|   ',
  ]},

  // ── Debian ────────────────────────────────────────────────────────────────
  debian: { color: '#d40000', art: [
    '    ████████    ',
    '  ██        ██  ',
    ' █   ███████  █ ',
    ' █  ██         ',
    ' █   ███████   ',
    '  ██        ██  ',
    '    ████████    ',
  ]},

  // ── Ubuntu ────────────────────────────────────────────────────────────────
  ubuntu: { color: '#E95420', art: [
    '    ████████    ',
    '  ██▄      ▄██  ',
    ' ██  ██████  ██ ',
    ' ██ ████████ ██ ',
    ' ██  ██████  ██ ',
    '  ██▀      ▀██  ',
    '    ████████    ',
  ]},

  // ── RHEL ──────────────────────────────────────────────────────────────────
  rhel: { color: '#CC0000', art: [
    '   ██████████   ',
    '  ██  ███████   ',
    '  ██  █▀▀▀██   ',
    '  ██████        ',
    '  ██  █         ',
    '  ██  ██        ',
    '  ██  ████████  ',
  ]},

  // ── Rocky Linux ───────────────────────────────────────────────────────────
  rocky: { color: '#10B981', art: [
    '    ████████    ',
    '  ██        ██  ',
    ' ██  ██████  ██ ',
    ' ██  █▀▀▀▀  ██ ',
    ' ██  █      ██ ',
    '  ██        ██  ',
    '    ████████    ',
  ]},

  // ── AlmaLinux ─────────────────────────────────────────────────────────────
  almalinux: { color: '#F4A522', art: [
    '         ▄      ',
    '        ███     ',
    '       █████    ',
    '      ███████   ',
    '     ███   ███  ',
    '    ███     ███ ',
    '   ███       ███',
    '  █████████████ ',
  ]},

  // ── Fedora ────────────────────────────────────────────────────────────────
  fedora: { color: '#60a5fa', art: [
    '    ████████    ',
    '   ███    ███   ',
    '   ███    ███   ',
    '  ████████████  ',
    '   ███          ',
    '   ███          ',
    '   ███          ',
  ]},

  // ── openSUSE ──────────────────────────────────────────────────────────────
  opensuse: { color: '#73BA25', art: [
    '    ████████    ',
    '  ██        ██  ',
    ' ██  ██████  ██ ',
    ' ██  ██  ██  ██ ',
    ' ██  ██████  ██ ',
    '  ██        ██  ',
    '    ████████    ',
  ]},

  // ── Arch Linux ────────────────────────────────────────────────────────────
  arch: { color: '#1793D1', art: [
    '        ▲        ',
    '       ███       ',
    '      █████      ',
    '     ███ ███     ',
    '    ███   ███    ',
    '   ███     ███   ',
    '  ███████████████',
  ]},

  // ── Alpine Linux ──────────────────────────────────────────────────────────
  alpine: { color: '#0D597F', art: [
    '       ▄▄        ',
    '      ████       ',
    '     ██████      ',
    '    ████████     ',
    '   ████  ████    ',
    '  ████    ████   ',
    ' ████      ████  ',
    '████████████████ ',
  ]},

  // ── Kali Linux ────────────────────────────────────────────────────────────
  kali: { color: '#267BF0', art: [
    '   ████████████  ',
    '  ██          ██ ',
    '  ██  ███████ ██ ',
    '  ██  ██      ██ ',
    '  ██  ███████ ██ ',
    '  ██          ██ ',
    '   ████████████  ',
  ]},

  // ── Proxmox ───────────────────────────────────────────────────────────────
  proxmox: { color: '#E57000', art: [
    '  ██████████████ ',
    '  ██  ██████████ ',
    '  ██  ██▀▀▀▀██  ',
    '  ████████▀▀    ',
    '  ██  ██        ',
    '  ██  ██        ',
    '  ████████████  ',
  ]},

}
// ─────────────────────────────────────────────────────────────────────────────

function AsciiLogo({ distro, osType, customMap = {} }: {
  distro: string | null | undefined
  osType: string | null | undefined
  customMap?: Record<string, DistroArt>
}) {
  const d = (distro ?? '').toLowerCase()
  const isWin = osType === 'windows' || d === 'windows' || d.startsWith('windows')
  const isCentos = d === 'centos'

  const preStyle = (color: string): React.CSSProperties => ({
    fontFamily: monoFont,
    fontSize: 11,
    lineHeight: 1.6,
    color,
    margin: 0,
    userSelect: 'none',
    textAlign: 'center',
    whiteSpace: 'pre',
    textShadow: `0 0 16px ${color}44`,
  })

  // ── Windows: perspective flag (real Windows logo feel) ───────────────────
  if (isWin) {
    return (
      <svg width="90" height="88" viewBox="0 0 90 88" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block', margin: '0 auto' }}>
        {/* Red — top-left */}
        <path d="M0 12 L40 6 L40 42 L0 42 Z" fill="#f25022"/>
        {/* Green — top-right */}
        <path d="M43 5 L90 0 L90 42 L43 42 Z" fill="#7fba00"/>
        {/* Blue — bottom-left */}
        <path d="M0 46 L40 46 L40 82 L0 76 Z" fill="#00a4ef"/>
        {/* Yellow — bottom-right */}
        <path d="M43 46 L90 46 L90 88 L43 83 Z" fill="#ffb900"/>
      </svg>
    )
  }

  // ── CentOS: 4-color pinwheel ──────────────────────────────────────────────
  if (isCentos) {
    const H = '█████'
    return (
      <pre style={preStyle('#fff')}>
        <span style={{ color: '#932279' }}>{H}</span>{'   '}<span style={{ color: '#EF9234' }}>{H}</span>{'\n'}
        <span style={{ color: '#932279' }}>{H}</span>{'   '}<span style={{ color: '#EF9234' }}>{H}</span>{'\n'}
        <span style={{ color: '#932279' }}>{H}</span>{'   '}<span style={{ color: '#EF9234' }}>{H}</span>{'\n'}
        {'     █████     '}{'\n'}
        <span style={{ color: '#89D44B' }}>{H}</span>{'   '}<span style={{ color: '#CC0000' }}>{H}</span>{'\n'}
        <span style={{ color: '#89D44B' }}>{H}</span>{'   '}<span style={{ color: '#CC0000' }}>{H}</span>{'\n'}
        <span style={{ color: '#89D44B' }}>{H}</span>{'   '}<span style={{ color: '#CC0000' }}>{H}</span>
      </pre>
    )
  }

  // ── Lookup: custom DB entry → hardcoded DISTRO_ART → 'default' ───────────
  const custom = customMap[d] ?? customMap['default']
  const base = DISTRO_ART[d] ?? DISTRO_ART.default
  const art = custom ? custom.art_lines : base.art
  const color = custom ? custom.color : base.color
  return (
    <pre style={preStyle(color)}>
      {art.join('\n')}
    </pre>
  )
}
const DEFAULT_FONT = 14

// Selectable terminal fonts. The first six are loaded as webfonts in index.html;
// the rest fall back to whatever is installed on the OS (Cascadia/Consolas on
// Windows, Menlo on macOS).
const FONT_OPTIONS: { label: string; stack: string }[] = [
  { label: 'JetBrains Mono', stack: '"JetBrains Mono", monospace' },
  { label: 'Fira Code',      stack: '"Fira Code", monospace' },
  { label: 'Source Code Pro', stack: '"Source Code Pro", monospace' },
  { label: 'IBM Plex Mono',  stack: '"IBM Plex Mono", monospace' },
  { label: 'Roboto Mono',    stack: '"Roboto Mono", monospace' },
  { label: 'Ubuntu Mono',    stack: '"Ubuntu Mono", monospace' },
  { label: 'Cascadia Code',  stack: '"Cascadia Code", "Cascadia Mono", monospace' },
  { label: 'Consolas',       stack: 'Consolas, monospace' },
  { label: 'System Mono',    stack: 'monospace' },
]
const DEFAULT_FONT_FAMILY = FONT_OPTIONS[0].stack

// Persist the chosen font/size so new tabs and sessions remember the preference.
const FONT_FAMILY_KEY = 'terminal.fontFamily'
const FONT_SIZE_KEY = 'terminal.fontSize'
const loadFontFamily = () => {
  try { return localStorage.getItem(FONT_FAMILY_KEY) || DEFAULT_FONT_FAMILY } catch { return DEFAULT_FONT_FAMILY }
}
const loadFontSize = () => {
  try { const n = parseInt(localStorage.getItem(FONT_SIZE_KEY) || ''); return Number.isFinite(n) && n > 0 ? n : DEFAULT_FONT } catch { return DEFAULT_FONT }
}

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
  fontFamily: string
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
    fontSize: loadFontSize(),
    fontFamily: loadFontFamily(),
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
  const [showAiPanel, setShowAiPanel] = useState(false)
  const [showInfoPanel, setShowInfoPanel] = useState(true)
  const [assistantEnabled, setAssistantEnabled] = useState(false)
  type AiMsg = { role: 'user' | 'assistant'; text: string; commands?: string[] }
  const [aiMessages, setAiMessages] = useState<AiMsg[]>([])
  const [aiInput, setAiInput] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [linuxCmds, setLinuxCmds] = useState<{id:string,category:string,label:string,command:string,description:string}[]>([])
  const [winCmds, setWinCmds] = useState<{id:string,category:string,label:string,command:string,description:string}[]>([])
  const [cmdCat, setCmdCat] = useState('All')
  const [cmdSearch, setCmdSearch] = useState('')
  const [linuxNotes, setLinuxNotes] = useState<{id:string,type:string,device_type?:string,name:string,content?:string}[]>([])
  const [customDistroArt, setCustomDistroArt] = useState<Record<string, DistroArt>>({})

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
  const roRefs      = useRef<Record<string, ResizeObserver>>({})
  const fitPushRefs = useRef<Record<string, () => void>>({})
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null)



  // ResizeObserver on the wrapper (not the xterm div) — avoids feedback loop
  useEffect(() => {
    const el = canvasWrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => fitRefs.current[activeTabId]?.fit())
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [activeTabId])

  useEffect(() => {
    Promise.all([
      api.get<Server[]>('/servers').catch(() => [] as Server[]),
      api.get<Assignment[]>('/assignments').catch(() => [] as Assignment[]),
      distroArtApi.list().catch(() => [] as DistroArt[]),
    ]).then(([allServers, assigns, artList]) => {
      setAssignments(assigns)
      setServers(allServers.filter(s => s.os_type === 'linux' || s.os_type === 'windows'))
      setCustomDistroArt(Object.fromEntries(artList.map(a => [a.key, a])))
    })
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
      api.get<typeof winCmds>('/commands?os=windows').then(setWinCmds).catch(() => {})
    } else {
      api.get<typeof linuxCmds>('/commands?os=linux').then(setLinuxCmds).catch(() => {})
    }
    api.get<typeof linuxNotes>('/share/list').then(all => setLinuxNotes(all.filter((x: any) => x.type === 'text' && x.device_type === (activeServerOs === 'windows' ? 'windows' : 'linux')))).catch(() => {})
  }, [showCmdPanel, activeServerOs])

  // Is the AI Assistant feature enabled by the admin?
  useEffect(() => {
    api.get<{ assistant_enabled: boolean }>('/settings/ai-features')
      .then(r => setAssistantEnabled(r.assistant_enabled)).catch(() => {})
  }, [])

  // Grab the last ~40 lines of the active terminal as context for the assistant.
  const grabTerminalContext = (): string => {
    const term = xtermRefs.current[activeTabId]
    if (!term) return ''
    const buf = term.buffer.active
    const lines: string[] = []
    const start = Math.max(0, buf.length - 40)
    for (let i = start; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  const askAssistant = async () => {
    const q = aiInput.trim()
    if (!q || aiLoading || !activeTab?.selectedServer) return
    setAiInput('')
    setAiMessages(prev => [...prev, { role: 'user', text: q }])
    setAiLoading(true)
    try {
      const res = await api.post<{ answer: string; commands: string[] }>(
        `/servers/${activeTab.selectedServer}/ai-assist`,
        { question: q, os_type: activeServerOs || 'linux', context: grabTerminalContext() },
      )
      setAiMessages(prev => [...prev, { role: 'assistant', text: res.answer, commands: res.commands }])
    } catch (err: any) {
      setAiMessages(prev => [...prev, { role: 'assistant', text: `⚠ ${err?.message || 'AI request failed'}` }])
    } finally {
      setAiLoading(false)
    }
  }

  const runAiCommand = (cmd: string) => {
    const ws = wsRefs.current[activeTabId]
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const hasPlaceholder = /<[^>]+>/.test(cmd)
    ws.send(JSON.stringify({ type: 'input', data: hasPlaceholder ? cmd : cmd + '\n' }))
    xtermRefs.current[activeTabId]?.focus()
  }

  // Refit synchronously after every render that changes tab or connection state.
  // useLayoutEffect runs after DOM mutation but before paint, so the toolbar
  // has already updated its height and canvasWrapperRef has the correct size.
  useLayoutEffect(() => {
    const fit = fitRefs.current[activeTabId]
    const term = xtermRefs.current[activeTabId]
    fit?.fit()
    term?.focus()
  }, [activeTabId, activeTab?.connected, activeTab?.connecting])

  // Global Ctrl+F for active tab search; Ctrl+W prevention when connected
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tab = tabs.find((t) => t.id === activeTabId)
      // Always block Ctrl+W closing the tab/window when a terminal is connected
      if ((e.ctrlKey || e.metaKey) && e.key === 'w' && tab?.connected) {
        e.preventDefault()
        return
      }
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
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
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
    roRefs.current[id]?.disconnect()
    clearInterval(timerRefs.current[id])
    delete termRefs.current[id]
    delete xtermRefs.current[id]
    delete wsRefs.current[id]
    delete fitRefs.current[id]
    delete searchRefs.current[id]
    delete timerRefs.current[id]
    delete roRefs.current[id]
    delete fitPushRefs.current[id]

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
      fontFamily: tab.fontFamily || DEFAULT_FONT_FAMILY,
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

    xtermRefs.current[tabId]  = term
    fitRefs.current[tabId]    = fitAddon
    searchRefs.current[tabId] = searchAddon

    const el = termRefs.current[tabId]
    if (el) {
      el.innerHTML = ''
      term.open(el)
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch { /* canvas fallback */ }
      // Fit the terminal AND explicitly push the resulting size to the server's
      // PTY. We can't rely on term.onResize alone: it only fires when the size
      // CHANGES, so if the size is already right locally but the server PTY is
      // still 80x24, the server never learns — and full-screen apps like nano
      // draw to the server's PTY size, so they render small. Pressing F12 (window
      // resize) was masking this by forcing a change. Always send explicitly.
      const fitAndPush = () => {
        if (el.clientHeight <= 0 || el.clientWidth <= 0) return
        fitAddon.fit()
        const ws = wsRefs.current[tabId]
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      }

      // Observe THIS terminal's own container so genuine later resizes (info-panel
      // toggle, window resize, font settling) trigger a refit. The div height is
      // fixed by flex, so fit() can't feed back into another resize.
      roRefs.current[tabId]?.disconnect()
      const ro = new ResizeObserver(() => requestAnimationFrame(fitAndPush))
      ro.observe(el)
      roRefs.current[tabId] = ro

      // Initial fit is racy: xterm may not have measured its cell size yet, and
      // the webfont (JetBrains Mono) loads asynchronously — a fit with the fallback
      // font computes the wrong cell height. Re-fit until the result STABILIZES.
      let lastCols = -1, lastRows = -1, stable = 0, attempts = 0, everFitted = false
      const tryFit = () => {
        const ready = el.clientHeight > 0 && el.clientWidth > 0
        if (ready) { fitAndPush(); everFitted = true }
        if (everFitted && term.cols === lastCols && term.rows === lastRows) stable++
        else { stable = 0; lastCols = term.cols; lastRows = term.rows }
        if ((everFitted && stable >= 3) || attempts++ >= 60) return
        setTimeout(tryFit, 50)
      }
      requestAnimationFrame(tryFit)

      // Belt-and-suspenders: fit again once fonts finish loading.
      document.fonts?.ready.then(fitAndPush)
      // …and once the server confirms the session (latest fully-settled moment).
      fitPushRefs.current[tabId] = fitAndPush
    }

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
          // Session is fully up — fit and push the size to the PTY now, plus once
          // more after the connected-state re-render settles the layout.
          fitPushRefs.current[tabId]?.()
          requestAnimationFrame(() => fitPushRefs.current[tabId]?.())
          setTimeout(() => fitPushRefs.current[tabId]?.(), 100)
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
    roRefs.current[tabId]?.disconnect()
    delete roRefs.current[tabId]
    clearInterval(timerRefs.current[tabId])
    updateTab(tabId, { connected: false, connecting: false, status: '', usedKey: '', showSearch: false, sessionSeconds: 0 })
  }

  const applyFontSize = (tabId: string, size: number) => {
    const clamped = Math.max(MIN_FONT, Math.min(MAX_FONT, size))
    updateTab(tabId, { fontSize: clamped })
    try { localStorage.setItem(FONT_SIZE_KEY, String(clamped)) } catch { /* ignore */ }
    if (xtermRefs.current[tabId]) {
      xtermRefs.current[tabId].options.fontSize = clamped
      fitPushRefs.current[tabId]?.()
    }
  }

  const applyFontFamily = (tabId: string, stack: string) => {
    updateTab(tabId, { fontFamily: stack })
    try { localStorage.setItem(FONT_FAMILY_KEY, stack) } catch { /* ignore */ }
    const term = xtermRefs.current[tabId]
    if (term) {
      term.options.fontFamily = stack
      // Wait for the webfont to be ready before re-fitting: the new font changes
      // the cell size, and fitting with stale metrics would mis-size the PTY.
      const refit = () => fitPushRefs.current[tabId]?.()
      document.fonts?.ready.then(refit)
      refit()
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
    <div className="flex flex-col bg-gray-950" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>

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
              {(() => {
                const grouped: Record<string, Server[]> = {}
                for (const s of servers) {
                  const grp = s.environment?.trim() || 'Other'
                  ;(grouped[grp] ??= []).push(s)
                }
                const order = Object.keys(grouped).sort((a, b) =>
                  a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)
                )
                return order.map(grp => (
                  <optgroup key={grp} label={grp}>
                    {grouped[grp].map(s => (
                      <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>
                    ))}
                  </optgroup>
                ))
              })()}
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

            {/* Font family */}
            <select
              value={tab.fontFamily}
              onChange={(e) => applyFontFamily(tab.id, e.target.value)}
              title="Terminal font"
              className="h-6 px-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-200 border border-gray-600 focus:outline-none focus:border-indigo-500 cursor-pointer max-w-[130px]"
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.stack} value={f.stack} style={{ fontFamily: f.stack }}>{f.label}</option>
              ))}
            </select>

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
                  onClick={() => { setShowCmdPanel(p => !p); setShowAiPanel(false) }}
                  className={`px-2.5 py-1 text-xs rounded transition-colors ${showCmdPanel ? 'bg-indigo-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200 hover:text-white'}`}
                  title="Command library">
                  📚 Commands
                </button>
                {assistantEnabled && (
                  <button
                    onClick={() => { const open = !showAiPanel; setShowAiPanel(open); setShowCmdPanel(false); if (open) setShowInfoPanel(true) }}
                    className={`px-2.5 py-1 text-xs rounded transition-colors ${showAiPanel ? 'bg-indigo-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200 hover:text-white'}`}
                    title="AI assistant">
                    🤖 AI
                  </button>
                )}
              </>
            )}
            {tab.connected && (
              <button
                onClick={() => { setShowInfoPanel(p => !p); setTimeout(() => { fitRefs.current[activeTabId]?.fit() }, 50) }}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${showInfoPanel ? 'bg-gray-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white'}`}
                title="Toggle info panel">
                ▶▌
              </button>
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

      {/* ── Terminal canvases + right panel ─────────────────────────────────── */}
      <div className="flex-1 flex" style={{ overflow: 'hidden', minHeight: 0 }}>
        <div ref={canvasWrapperRef} className="flex-1 relative" style={{ overflow: 'hidden', minHeight: 0 }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0 flex flex-col"
            style={{
              visibility: tab.id === activeTabId ? 'visible' : 'hidden',
              pointerEvents: tab.id === activeTabId ? 'auto' : 'none',
              zIndex: tab.id === activeTabId ? 1 : 0,
            }}
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

            {/* Empty state — absolute overlay so terminal div stays in layout */}
            {!tab.connected && !tab.connecting && !tab.status && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 text-sm gap-2 z-10">
                <div className="text-3xl">⌨️</div>
                <div>Select a server and click <span className="text-gray-500">Connect</span> to start a session.</div>
                <div className="text-xs text-gray-700 mt-1">Drag &amp; drop a file onto the terminal to upload it via SFTP</div>
              </div>
            )}

            {/* Terminal div — always display:block so xterm can measure dimensions */}
            <div
              ref={(el) => { termRefs.current[tab.id] = el }}
              className="flex-1 overflow-hidden p-2"
              style={{ minHeight: 0 }}
              onDragOver={(e) => { e.preventDefault(); if (tab.connected) updateTab(tab.id, { dragOver: true }) }}
              onDragLeave={() => updateTab(tab.id, { dragOver: false })}
              onDrop={(e) => handleDrop(tab.id, e)}
            />
          </div>
        ))}

        </div>

        {/* ── Right panel (collapsible) ── */}
        {showInfoPanel && (() => {
          const isWin = activeServerOs === 'windows'
          const isConnected = activeTab?.connected

          // AI Assistant view (replaces the command panel — only one shows)
          if (showAiPanel && isConnected) {
            return (
              <div style={{ width: 320, flexShrink: 0, height: '100%', background: '#111827', borderLeft: '1px solid #1f2937', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '8px 10px', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#a5b4fc' }}>🤖 AI Assistant</span>
                  {aiMessages.length > 0 && (
                    <button onClick={() => setAiMessages([])} style={{ fontSize: 10, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
                  )}
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {aiMessages.length === 0 && (
                    <div style={{ fontSize: 11, color: '#6b7280', padding: 8, lineHeight: 1.6 }}>
                      Ask a question about this server or look up a command.<br/>
                      <span style={{ color: '#4b5563' }}>e.g. “why is nginx failing to start?” or “command to list listening ports”</span>
                    </div>
                  )}
                  {aiMessages.map((msg, i) => (
                    <div key={i} style={{
                      alignSelf: msg.role === 'user' ? 'flex-end' : 'stretch',
                      maxWidth: msg.role === 'user' ? '85%' : '100%',
                      background: msg.role === 'user' ? '#4f46e5' : '#1f2937',
                      border: msg.role === 'user' ? 'none' : '1px solid #374151',
                      borderRadius: 8, padding: '7px 9px',
                    }}>
                      <div style={{ fontSize: 11, color: msg.role === 'user' ? '#fff' : '#e5e7eb', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{msg.text}</div>
                      {msg.commands && msg.commands.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                          {msg.commands.map((cmd, j) => (
                            <div key={j} style={{ background: '#0d1117', border: '1px solid #374151', borderRadius: 5, padding: '5px 7px' }}>
                              <code style={{ display: 'block', fontSize: 10, color: '#93c5fd', fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 4 }}>{cmd}</code>
                              <button onClick={() => runAiCommand(cmd)} style={{ width: '100%', padding: '3px', borderRadius: 4, border: 'none', background: '#4f46e5', color: '#fff', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>▶ Run</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {aiLoading && <div style={{ fontSize: 11, color: '#6b7280', padding: 4 }}>Thinking…</div>}
                </div>
                <div style={{ padding: 8, borderTop: '1px solid #1f2937', display: 'flex', gap: 4, flexShrink: 0 }}>
                  <input
                    value={aiInput}
                    onChange={e => setAiInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAssistant() } }}
                    placeholder="Ask the AI…"
                    disabled={aiLoading}
                    style={{ flex: 1, padding: '6px 8px', borderRadius: 5, border: '1px solid #374151', background: '#1f2937', color: '#e5e7eb', fontSize: 11, boxSizing: 'border-box' as const }} />
                  <button onClick={askAssistant} disabled={aiLoading || !aiInput.trim()}
                    style={{ padding: '0 12px', borderRadius: 5, border: 'none', background: aiLoading || !aiInput.trim() ? '#374151' : '#4f46e5', color: '#fff', fontSize: 12, cursor: aiLoading || !aiInput.trim() ? 'default' : 'pointer' }}>➤</button>
                </div>
              </div>
            )
          }

          // Commands list view
          if (showCmdPanel && isConnected) {
            const cmds = isWin ? winCmds : linuxCmds
            // Normalize categories (trim + case-insensitive) so near-identical
            // strings like "Network" and "Network " collapse into ONE chip and
            // all their commands show together. Without this, added commands
            // whose category differs by case/whitespace get hidden under a
            // separate look-alike chip (they still appear under "All").
            const normCat = (s: string) => s.trim().toLowerCase()
            const cats = ['All', ...Array.from(
              new Map(cmds.map(c => [normCat(c.category), c.category.trim()])).values()
            ).sort((a, b) => a.localeCompare(b))]
            const filtered = cmds.filter(c =>
              (cmdCat === 'All' || normCat(c.category) === normCat(cmdCat)) &&
              (!cmdSearch || c.label.toLowerCase().includes(cmdSearch.toLowerCase()) || c.command.toLowerCase().includes(cmdSearch.toLowerCase()))
            )
            const sendCmd = (cmd: string) => {
              const ws = wsRefs.current[activeTabId]
              if (!ws || ws.readyState !== WebSocket.OPEN) return
              // If command has <placeholder> tokens, paste without Enter so user can fill them in
              const hasPlaceholder = /<[^>]+>/.test(cmd)
              ws.send(JSON.stringify({ type: 'input', data: hasPlaceholder ? cmd : cmd + '\n' }))
              xtermRefs.current[activeTabId]?.focus()
            }
            return (
              <div style={{ width: 300, flexShrink: 0, height: '100%', background: '#111827', borderLeft: '1px solid #1f2937', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '8px 10px', borderBottom: '1px solid #1f2937', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
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
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
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
                            background: '#4f46e5', color: '#fff', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                          }}>▶ Run</button>
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
                        background: '#4f46e5', color: '#fff', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                      }}>▶ Run</button>
                    </div>
                  ))}
                </div>
              </div>
            )
          }

          // Mascot / info panel (always visible when not showing commands)
          const connectedServer = servers.find(s => s.id === activeTab?.selectedServer)
          return (
            <div style={{ width: 300, flexShrink: 0, minHeight: 0, background: '#0d1117', borderLeft: '1px solid #1f2937', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0, overflow: 'hidden', padding: '24px 20px' }}>
              {isConnected && connectedServer ? (
                <>
                  {/* OS Logo */}
                  <div style={{ marginBottom: 20 }}>
                    <AsciiLogo distro={connectedServer.distro} osType={connectedServer.os_type} customMap={customDistroArt} />
                  </div>

                  {/* Server info */}
                  <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ height: 1, background: '#1f2937', margin: '2px 0' }} />

                    {/* OS */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#6b7280' }}>OS</span>
                      <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}>
                        {connectedServer.os_pretty_name || connectedServer.os_name ||
                          (connectedServer.distro
                            ? connectedServer.distro.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                            : isWin ? 'Windows' : 'Linux')}
                      </span>
                    </div>

                    {/* Version */}
                    {connectedServer.os_version && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>Version</span>
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>{connectedServer.os_version}</span>
                      </div>
                    )}

                    {/* Kernel */}
                    {connectedServer.kernel_version && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>Kernel</span>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace', textAlign: 'right', maxWidth: 160, wordBreak: 'break-all' }}>{connectedServer.kernel_version}</span>
                      </div>
                    )}

                    {/* User */}
                    {activeTab?.selectedUser && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>User</span>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{activeTab.selectedUser}</span>
                      </div>
                    )}


                    {/* Session time */}
                    {activeTab && activeTab.sessionSeconds > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>Session</span>
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{formatDuration(activeTab.sessionSeconds)}</span>
                      </div>
                    )}

                    <div style={{ height: 1, background: '#1f2937', margin: '2px 0' }} />

                    {/* Hint */}
                    <div style={{ textAlign: 'center', marginTop: 4 }}>
                      <span style={{ fontSize: 10, color: '#374151' }}>Click </span>
                      <span style={{ fontSize: 10, color: '#6366f1' }}>📚 Commands</span>
                      <span style={{ fontSize: 10, color: '#374151' }}> for the command library</span>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>⌨️</div>
                  <div style={{ fontSize: 12, color: '#374151' }}>Connect to a server</div>
                  <div style={{ fontSize: 12, color: '#374151' }}>to get started</div>
                </div>
              )}
            </div>
          )
        })()}
      </div>

    </div>
  )
}

