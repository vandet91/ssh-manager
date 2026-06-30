import { useEffect, useRef, useState, useCallback } from 'react'
import Guacamole from 'guacamole-common-js'
import { api, RdpCredential } from '../api/client'

type ShareItem = {
  id: string
  type: 'text' | 'file'
  device_type?: string
  name: string
  size?: number
  content?: string
}

interface Props {
  serverId: string
  serverName: string
  hostname: string
  onClose: () => void
}

type ConnState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected'

const STATE_LABELS: Record<number, ConnState> = { 0: 'idle', 1: 'connecting', 2: 'connecting', 3: 'connected', 4: 'disconnected', 5: 'disconnected' }

export default function RemoteDesktop({ serverId, serverName, hostname, onClose }: Props) {
  const rootRef    = useRef<HTMLDivElement>(null)
  const canvasRef    = useRef<HTMLDivElement>(null)
  const clientRef    = useRef<Guacamole.Client | null>(null)
  const keyboardRef  = useRef<Guacamole.Keyboard | null>(null)

  const [state,         setState]        = useState<ConnState>('idle')
  const [error,         setError]        = useState('')
  const [isFullscreen,  setIsFullscreen] = useState(false)
  const [showForm,      setShowForm]     = useState(true)
  const [credentials,   setCredentials]  = useState<RdpCredential[]>([])
  const [shareItems,    setShareItems]   = useState<ShareItem[]>([])
  const [showSharePanel, setShowSharePanel] = useState(false)
  const [shareTab, setShareTab] = useState<'items' | 'commands' | 'clipboard'>('items')
  const [winCmds, setWinCmds] = useState<{id:string,category:string,label:string,command:string,description:string}[]>([])
  const [cmdCategory, setCmdCategory] = useState('All')
  const [cmdSearch, setCmdSearch] = useState('')
  const [clipboardText, setClipboardText] = useState('')
  const [form, setForm] = useState(() => ({
    credential_id: '',
    username: 'Administrator',
    password: '',
    domain: '',
    port: 3389,
    width:  Math.min(Math.round(window.innerWidth), 1920),
    height: Math.min(Math.round(window.innerHeight - 80), 1080),
    dpi:    Math.round(window.devicePixelRatio * 96) || 96,
  }))

  useEffect(() => {
    api.get<RdpCredential[]>(`/servers/${serverId}/rdp-credentials`)
      .then(list => {
        const active = list.filter(c => !c.is_archived)
        setCredentials(active)
        if (active.length > 0) setForm(f => ({ ...f, credential_id: active[0].id }))
      })
      .catch(() => {})
  }, [serverId])

  // Load Windows commands when share panel opens on commands tab
  useEffect(() => {
    if (showSharePanel && shareTab === 'commands' && winCmds.length === 0) {
      api.get<typeof winCmds>('/commands?os=windows').then(setWinCmds).catch(() => {})
    }
  }, [showSharePanel, shareTab])

  // Load shared files/commands periodically
  useEffect(() => {
    const loadShares = async () => {
      try {
        const res = await api.get<ShareItem[]>('/share/list')
        setShareItems(res)
      } catch {}
    }
    loadShares()
    const interval = setInterval(loadShares, 5000)
    return () => clearInterval(interval)
  }, [])



  const connect = useCallback(async () => {
    setError(''); setShowForm(false); setState('connecting')
    await new Promise(r => setTimeout(r, 0))
    try {
      const rdpParent = canvasRef.current?.parentElement
      const actualW = rdpParent?.clientWidth  || form.width
      const actualH = rdpParent?.clientHeight || form.height

      const payload: Record<string, unknown> = { port: form.port, width: actualW, height: actualH, dpi: form.dpi }
      if (form.credential_id) {
        payload.credential_id = form.credential_id
        payload.username = form.username
        payload.password = form.password || 'placeholder'
      } else {
        payload.username = form.username
        payload.password = form.password
        payload.domain   = form.domain
      }

      const { token } = await api.post<{ token: string }>(`/servers/${serverId}/rdp-token`, payload)
      const wsUrl  = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/rdp`
      const tunnel = new Guacamole.WebSocketTunnel(wsUrl)
      const client = new Guacamole.Client(tunnel)
      clientRef.current = client

      const display = client.getDisplay()
      const displayEl = display.getElement()
      displayEl.style.position = 'absolute'
      displayEl.style.top = '0'
      displayEl.style.left = '0'
      displayEl.style.zIndex = '1'
      displayEl.style.pointerEvents = 'none'
      displayEl.style.willChange = 'transform'
      displayEl.style.transform = 'translateZ(0)'
      if (canvasRef.current) {
        canvasRef.current.innerHTML = ''
        canvasRef.current.appendChild(displayEl)
      }


      client.onstatechange = (s: number) => {
        const mapped = STATE_LABELS[s] ?? 'connecting'
        setState(mapped)
        if (mapped === 'connected' && canvasRef.current) {
          // Attach keyboard ONLY to the canvas div (not document).
          // The share panel uses onMouseDown preventDefault to keep canvas focus
          // when buttons/scroll areas are clicked. The search input explicitly
          // calls .focus() on itself so it can still receive keystrokes.
          // This way keyboard input NEVER leaks between the two contexts.
          const kb = new Guacamole.Keyboard(canvasRef.current)
          kb.onkeydown = (k) => { client.sendKeyEvent(1, k) }
          kb.onkeyup  = (k) => { client.sendKeyEvent(0, k) }
          keyboardRef.current = kb
          canvasRef.current.focus()

          // Sync local clipboard → remote on canvas focus/click (requires HTTPS)
          const guacClient = client as any
          const syncClipboardToRemote = () => {
            navigator.clipboard?.readText?.().then(text => {
              if (!text) return
              const stream = guacClient.createClipboardStream('text/plain')
              const writer = new (Guacamole as any).StringWriter(stream)
              writer.sendText(text)
              writer.sendEnd()
            }).catch(() => {})
          }
          canvasRef.current.addEventListener('focus', syncClipboardToRemote)
          canvasRef.current.addEventListener('click', syncClipboardToRemote)

          // Sync remote clipboard → local
          guacClient.onclipboard = (stream: any, mimetype: string) => {
            if (!mimetype.startsWith('text/')) return
            const reader = new (Guacamole as any).StringReader(stream)
            let text = ''
            reader.ontext = (chunk: string) => { text += chunk }
            reader.onend = () => { navigator.clipboard?.writeText?.(text).catch(() => {}) }
          }
          const parent = canvasRef.current.parentElement
          if (parent) {
            const w = parent.clientWidth || form.width
            const h = parent.clientHeight || form.height
            ;(client as unknown as Record<string, Function>)['sendSize'](w, h)
          }
          const el = canvasRef.current
          const onDragOver = (e: DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          }
          const onDrop = (e: DragEvent) => {
            e.preventDefault()
            e.stopPropagation()
            // Let Guacamole's internal handler process the drop
          }
          el.addEventListener('dragover', onDragOver)
          el.addEventListener('drop', onDrop)
        }
        if (mapped === 'disconnected') {
          keyboardRef.current?.reset()
          keyboardRef.current = null
          clientRef.current = null
          setShowForm(true)
        }
      }

      client.onerror = (status: Guacamole.Status) => {
        setError(status.message || `Connection error (code ${status.code})`)
        setState('error'); setShowForm(true)
      }
      tunnel.onerror = (status: Guacamole.Status) => {
        setError(status.message || 'WebSocket tunnel error')
        setState('error'); setShowForm(true)
      }

      const mouse = new Guacamole.Mouse(canvasRef.current!)
      mouse.onmousedown = (s) => client.sendMouseState(s)
      mouse.onmouseup   = (s) => client.sendMouseState(s)
      mouse.onmousemove = (s) => client.sendMouseState(s)

      client.connect(`token=${encodeURIComponent(token)}`)
    } catch (err: unknown) {
      setError((err as Error).message)
      setState('error'); setShowForm(true)
    }
  }, [serverId, form])

  const disconnect = useCallback(() => {
    keyboardRef.current?.reset()
    keyboardRef.current = null
    clientRef.current?.disconnect()
    clientRef.current = null
    setState('disconnected')
    setShowForm(true)
  }, [])

  useEffect(() => () => { disconnect() }, [disconnect])

  // Auto-focus canvas when RDP container becomes visible (after navigation)
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting && state === 'connected' && canvasRef.current) {
          canvasRef.current.focus()
        }
      })
    }, { threshold: 0.1 })

    if (rootRef.current) observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [state])

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      rootRef.current?.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }

  const SC: Record<ConnState, string> = {
    idle: '#6b7280', connecting: '#f59e0b', connected: '#22c55e', error: '#ef4444', disconnected: '#6b7280',
  }

  return (
    <div ref={rootRef} style={{
      width: '100%', height: '100%',
      background: '#0d0d0d', display: 'flex', flexDirection: 'column',
      fontFamily: 'system-ui, sans-serif', position: 'relative',
    }}>
      {/* Toolbar — prevent mousedown from stealing canvas focus, restore it explicitly */}
      <div onMouseDown={e => { e.preventDefault(); canvasRef.current?.focus() }} style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 10px', background: '#161b22', borderBottom: '1px solid #30363d',
        flexShrink: 0, minHeight: 36,
      }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: SC[state], flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: '#8b949e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {serverName} <span style={{ color: '#30363d' }}>·</span> {hostname}
        </span>
        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#21262d', color: SC[state], fontWeight: 700, flexShrink: 0 }}>
          {state.toUpperCase()}
        </span>
        <div style={{ flex: 1 }} />
        {state === 'connected' && (
          <>
            <button onClick={() => setShowSharePanel(!showSharePanel)} style={btn(showSharePanel ? '#8b5cf6' : '#4c1d95')} title="Show/hide shared files & commands">📦 Share</button>
            <button
              title="Paste clipboard text into RDP"
              onClick={() => {
                if (!clientRef.current) return
                navigator.clipboard.readText().then(text => {
                  if (!text) return
                  const stream = (clientRef.current as any).createClipboardStream('text/plain')
                  const writer = new (Guacamole as any).StringWriter(stream)
                  writer.sendText(text)
                  writer.sendEnd()
                  canvasRef.current?.focus()
                }).catch(() => {
                  // Fallback: open clipboard tab in share panel
                  setShowSharePanel(true)
                  setShareTab('clipboard')
                })
              }}
              style={btn('#0f766e')}
            >📋 Paste</button>
            <button onClick={disconnect} style={btn('#b91c1c')}>⏹ Disconnect</button>
            <button onClick={toggleFullscreen} style={btn('#374151')}>{isFullscreen ? '⊡ Exit Full' : '⊞ Full'}</button>
          </>
        )}
        {(state === 'error' || state === 'disconnected') && (
          <button onClick={() => { setShowForm(true); setState('idle') }} style={btn('#1d4ed8')}>↺ Reconnect</button>
        )}
        <button onClick={onClose} style={btn('#374151')}>✕</button>
      </div>

      {/* Connect form */}
      {showForm && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d1117', overflowY: 'auto' }}>
          <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 24, width: 400, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <h2 style={{ margin: '0 0 3px', fontSize: 15, fontWeight: 700, color: '#e6edf3' }}>🖥 Connect to {serverName}</h2>
              <p style={{ margin: 0, fontSize: 11, color: '#8b949e' }}>{hostname} · RDP</p>
            </div>
            {error && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', borderRadius: 6, padding: '7px 10px', fontSize: 12, color: '#ef4444' }}>✗ {error}</div>}

            {credentials.length > 0 && (
              <div>
                <label style={lbl}>Saved credential</label>
                <select value={form.credential_id} onChange={e => setForm(f => ({ ...f, credential_id: e.target.value }))} style={inp}>
                  <option value="">— enter manually —</option>
                  {credentials.map(c => (
                    <option key={c.id} value={c.id}>🔑 {c.label}{c.service_username ? ` (${c.service_username})` : ''}</option>
                  ))}
                </select>
              </div>
            )}

            {!form.credential_id && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={lbl}>Username</label>
                    <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="Administrator" style={inp} />
                  </div>
                  <div>
                    <label style={lbl}>Domain <span style={{ fontWeight: 400, color: '#6b7280' }}>(optional)</span></label>
                    <input value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} placeholder="CONTOSO" style={inp} />
                  </div>
                </div>
                <div>
                  <label style={lbl}>Password</label>
                  <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Windows login password" style={inp} />
                </div>
              </>
            )}

            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#8b949e', userSelect: 'none' }}>Display settings</summary>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
                {([['Port', 'port', 1, 65535], ['Width', 'width', 640, 3840], ['Height', 'height', 480, 2160]] as const).map(([label, field, min, max]) => (
                  <div key={field}>
                    <label style={lbl}>{label}</label>
                    <input type="number" min={min} max={max} value={form[field]} onChange={e => setForm(f => ({ ...f, [field]: Number(e.target.value) }))} style={inp} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {([['1280×720', 1280, 720], ['1920×1080', 1920, 1080], ['1440×900', 1440, 900]] as const).map(([label, w, h]) => (
                  <button key={label} onClick={() => setForm(f => ({ ...f, width: w, height: h }))}
                    style={{ padding: '2px 7px', borderRadius: 4, border: '1px solid #30363d', background: form.width === w ? '#1f6feb' : '#21262d', color: '#e6edf3', fontSize: 11, cursor: 'pointer' }}>
                    {label}
                  </button>
                ))}
              </div>
            </details>

            <button onClick={connect} disabled={!form.credential_id && (!form.username || !form.password)}
              style={{ ...btn('#1f6feb'), padding: '9px', fontSize: 14, fontWeight: 700, borderRadius: 8 }}>
              🖥 Connect
            </button>
          </div>
        </div>
      )}

      {/* RDP canvas */}
      {!showForm && (
        <div style={{ flex: 1, position: 'relative', background: '#000' }}>
          <div ref={canvasRef} tabIndex={0}
            onMouseDown={() => { (document.activeElement as HTMLElement | null)?.blur(); canvasRef.current?.focus() }}
            style={{ position: 'absolute', inset: 0, outline: 'none', overflow: 'hidden', cursor: 'default' }} />
          {state === 'connecting' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d1117' }}>
              <div style={{ textAlign: 'center', color: '#8b949e' }}>
                <div style={{ width: 36, height: 36, border: '3px solid #30363d', borderTopColor: '#1f6feb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 14px' }} />
                <p style={{ margin: 0, fontSize: 13 }}>Connecting to {hostname}…</p>
                <p style={{ margin: '4px 0 0', fontSize: 11, color: '#6b7280' }}>Establishing RDP session</p>
              </div>
            </div>
          )}
        </div>
      )}



      {state === 'connected' && (
        <div style={{ position: 'absolute', bottom: 5, right: 10, fontSize: 10, color: '#6b7280', pointerEvents: 'none' }}>
          Drag files here to upload → File Explorer → This PC → "Upload" drive
        </div>
      )}

      {/* Share Panel - Files & Commands */}
      {showSharePanel && state === 'connected' && (
        <div
          onMouseDown={e => {
            const tag = (e.target as HTMLElement).tagName
            if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
              // Non-input click: prevent focus theft AND restore canvas focus
              // so keyboard immediately works in RDP after clicking buttons/cards
              e.preventDefault()
              canvasRef.current?.focus()
            }
            // Input clicks: do nothing — let the browser give focus to the input normally
          }}
          style={{
          position: 'absolute', right: 0, top: 36, bottom: 0, width: 360,
          background: '#161b22', border: '1px solid #30363d', borderRadius: 0,
          display: 'flex', flexDirection: 'column', zIndex: 100, boxShadow: '-2px 0 8px rgba(0,0,0,0.3)',
        }}>
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #30363d', flexShrink: 0 }}>
            {([['items','📦 Shared',shareItems.length],['commands','🪟 Commands',winCmds.length],['clipboard','📋 Clipboard',0]] as const).map(([key, label, count]) => (
              <button key={key} onClick={() => {
                setShareTab(key)
                if (key === 'commands' && winCmds.length === 0)
                  api.get<typeof winCmds>('/commands?os=windows').then(setWinCmds).catch(() => {})
              }} style={{
                flex: 1, padding: '9px 4px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: shareTab === key ? '#0d1117' : 'transparent',
                color: shareTab === key ? '#e6edf3' : '#8b949e',
                borderBottom: shareTab === key ? '2px solid #1f6feb' : '2px solid transparent',
              }}>
                {label} {count > 0 ? `(${count})` : ''}
              </button>
            ))}
          </div>

          {/* Commands tab — search + category filter */}
          {shareTab === 'commands' && (
            <div style={{ padding: '8px 10px', borderBottom: '1px solid #30363d', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
              <input value={cmdSearch} onChange={e => setCmdSearch(e.target.value)} placeholder="Search commands…"
                onMouseDown={e => e.stopPropagation()}
                onBlur={() => requestAnimationFrame(() => canvasRef.current?.focus())}
                style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid #30363d', background: '#0d1117', color: '#e6edf3', fontSize: 11, boxSizing: 'border-box' as const }} />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                {['All', ...Array.from(new Set(winCmds.map(c => c.category))).sort()].map(cat => (
                  <button key={cat} onClick={() => setCmdCategory(cat)} style={{
                    padding: '2px 8px', borderRadius: 999, border: '1px solid', fontSize: 10, cursor: 'pointer',
                    borderColor: cmdCategory === cat ? '#1f6feb' : '#30363d',
                    background: cmdCategory === cat ? '#1f6feb22' : 'transparent',
                    color: cmdCategory === cat ? '#58a6ff' : '#8b949e',
                  }}>{cat}</button>
                ))}
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>

            {/* ── Clipboard tab ── */}
            {shareTab === 'clipboard' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: 11, color: '#8b949e', margin: 0 }}>
                  Paste text here, then click <strong style={{ color: '#e6edf3' }}>Send to RDP</strong>. Works on HTTP and HTTPS.
                </p>
                <textarea
                  value={clipboardText}
                  onChange={e => setClipboardText(e.target.value)}
                  onMouseDown={e => e.stopPropagation()}
                  placeholder="Paste your text here (Ctrl+V)…"
                  rows={8}
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: 6,
                    border: '1px solid #30363d', background: '#0d1117',
                    color: '#e6edf3', fontSize: 12, fontFamily: 'monospace',
                    resize: 'vertical', boxSizing: 'border-box',
                  }}
                />
                <button
                  onClick={() => {
                    const text = clipboardText
                    if (!text || !clientRef.current) return
                    const stream = (clientRef.current as any).createClipboardStream('text/plain')
                    const writer = new (Guacamole as any).StringWriter(stream)
                    writer.sendText(text)
                    writer.sendEnd()
                    canvasRef.current?.focus()
                  }}
                  style={{
                    padding: '8px', borderRadius: 6, border: 'none',
                    background: '#1f6feb', color: '#fff', fontSize: 12,
                    fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Send to RDP clipboard
                </button>
                <p style={{ fontSize: 10, color: '#6b7280', margin: 0 }}>
                  After sending, press <strong>Ctrl+V</strong> inside the remote desktop to paste.
                </p>
              </div>
            )}

            {/* ── Commands tab ── */}
            {shareTab === 'commands' && (() => {
              const filtered = winCmds.filter(c =>
                (cmdCategory === 'All' || c.category === cmdCategory) &&
                (!cmdSearch || c.label.toLowerCase().includes(cmdSearch.toLowerCase()) || c.command.toLowerCase().includes(cmdSearch.toLowerCase()))
              )
              return filtered.length === 0
                ? <p style={{ fontSize: 11, color: '#8b949e', textAlign: 'center', marginTop: 20 }}>No commands found.</p>
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {filtered.map(c => (
                      <div key={c.id} style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 6, padding: '8px 10px' }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#e6edf3', marginBottom: 3 }}>{c.label}</div>
                        <code style={{ display: 'block', fontSize: 11, color: '#79c0ff', fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 6 }}>{c.command}</code>
                        {c.description && <div style={{ fontSize: 10, color: '#8b949e', marginBottom: 6 }}>{c.description}</div>}
                        <button onClick={() => {
                          const text = c.command
                          let i = 0
                          const typeNext = () => {
                            if (i >= text.length) return
                            const ch = text[i++]
                            const cp = ch.codePointAt(0) ?? 0
                            const keysym = cp > 0xFFFF ? 0x1000000 + cp : cp
                            clientRef.current?.sendKeyEvent(1, keysym)
                            clientRef.current?.sendKeyEvent(0, keysym)
                            setTimeout(typeNext, 20)
                          }
                          typeNext()
                        }} style={{ width: '100%', padding: '5px', borderRadius: 4, border: 'none', background: '#1f6feb', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                          ⌨ Type into RDP
                        </button>
                      </div>
                    ))}
                  </div>
            })()}

            {/* ── Shared Items tab ── */}
            {shareTab === 'items' && (shareItems.filter(i => i.type === 'file' || (i.type === 'text' && (!i.device_type || i.device_type === 'windows'))).length === 0 ? (
              <p style={{ fontSize: 11, color: '#8b949e', margin: 12, textAlign: 'center' }}>
                No Windows notes or files. Add from Share page with type 🪟 Windows.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Sticky Notes Section */}
                {shareItems.filter(i => i.type === 'text' && (!i.device_type || i.device_type === 'windows')).length > 0 && (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#8b949e', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      🪟 Windows Notes ({shareItems.filter(i => i.type === 'text' && (!i.device_type || i.device_type === 'windows')).length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {shareItems.filter(i => i.type === 'text' && (!i.device_type || i.device_type === 'windows')).map(item => (
                        <div key={item.id} style={{ background: '#fff9e6', border: '2px solid #f0e68c', borderRadius: 8, padding: 10 }}>
                          <div style={{ color: '#333', marginBottom: 8, maxHeight: 100, overflow: 'auto', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.4 }}>
                            {item.content}
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(item.content || '').then(() => {
                                  alert('✓ Copied to clipboard - paste in RDP')
                                }).catch(() => {
                                  alert('Copy failed')
                                })
                              }}
                              style={{
                                flex: 1, padding: '6px 10px', borderRadius: 5, border: 'none',
                                background: '#f0e68c', color: '#333', cursor: 'pointer', fontWeight: 600, fontSize: 11,
                              }}
                              title="Copy to clipboard for pasting in RDP"
                            >
                              📋 Copy
                            </button>
                            <button
                              onClick={() => {
                                const client = clientRef.current
                                if (!client) { alert('RDP not connected'); return }
                                const text = item.content || ''
                                if (!text) return
                                // Type each character as direct keystrokes into the RDP session
                                let i = 0
                                const typeNext = () => {
                                  if (i >= text.length) return
                                  const ch = text[i++]
                                  const cp = ch.codePointAt(0) ?? 0
                                  // Unicode keysym: use 0x1000000 + codepoint for extended chars
                                  const keysym = cp > 0xFFFF ? 0x1000000 + cp : cp
                                  client.sendKeyEvent(1, keysym)
                                  client.sendKeyEvent(0, keysym)
                                  // Small delay between chars so RDP doesn't drop events
                                  setTimeout(typeNext, 20)
                                }
                                typeNext()
                              }}
                              style={{
                                flex: 1, padding: '6px 10px', borderRadius: 5, border: 'none',
                                background: '#667eea', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 11,
                              }}
                              title="Type text directly into RDP session"
                            >
                              ⌨ Type
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Files Section */}
                {shareItems.filter(i => i.type === 'file').length > 0 && (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#8b949e', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      📁 Files ({shareItems.filter(i => i.type === 'file').length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {shareItems.filter(i => i.type === 'file').map(item => (
                        <div key={item.id} style={{ background: '#f5f5f5', border: '1px solid #ddd', borderRadius: 8, padding: 10 }}>
                          <div style={{ color: '#333', fontWeight: 600, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                            📄 {item.name}
                          </div>
                          {item.size && (
                            <div style={{ fontSize: 10, color: '#666', marginBottom: 6 }}>
                              {(item.size / 1024).toFixed(1)} KB
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 6 }}>
                            <a
                              href={`/api/share/access/${item.id}`}
                              download={item.name}
                              style={{
                                flex: 1, padding: '6px 10px', borderRadius: 5, border: 'none',
                                background: '#667eea', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 11,
                                textAlign: 'center', textDecoration: 'none', display: 'block',
                              }}
                              title="Download file (Save As in RDP)"
                            >
                              ⬇ Download
                            </a>
                            <button
                              onClick={async () => {
                                try {
                                  const res = await fetch(`/api/share/${item.id}/save-to-drive`, { method: 'POST' })
                                  if (!res.ok) throw new Error(await res.text())
                                  alert(`✓ "${item.name}" saved to Upload drive — open File Explorer → This PC → Upload`)
                                } catch (e) {
                                  alert('Failed: ' + (e as Error).message)
                                }
                              }}
                              style={{
                                flex: 1, padding: '6px 10px', borderRadius: 5, border: 'none',
                                background: '#10b981', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 11,
                              }}
                              title="Save file to RDP Upload drive"
                            >
                              💾 Save to Drive
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const inp: React.CSSProperties = {
  width: '100%', padding: '6px 9px', borderRadius: 6,
  border: '1px solid #30363d', background: '#0d1117',
  color: '#e6edf3', fontSize: 12, outline: 'none', boxSizing: 'border-box',
}
const lbl: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600, color: '#8b949e', marginBottom: 4,
}
function btn(bg: string): React.CSSProperties {
  return { padding: '4px 10px', borderRadius: 5, border: 'none', background: bg, color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }
}
