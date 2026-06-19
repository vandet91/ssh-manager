import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export default function PsExecShellPopup() {
  const [params] = useSearchParams()
  const target  = params.get('target')  ?? ''
  const credId  = params.get('cred_id') ?? ''
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = `Shell — ${target}`
    const el = termRef.current
    if (!el || !target || !credId) return

    const xterm = new XTerm({
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
      fontFamily: '"Cascadia Code", "Fira Mono", Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(new WebLinksAddon())
    xterm.open(el)
    fit.fit()
    xterm.focus()

    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${wsProto}://${window.location.host}/api/psexec/session?target=${encodeURIComponent(target)}&cred_id=${encodeURIComponent(credId)}`
    )

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'output')       xterm.write(msg.data)
        else if (msg.type === 'error')   xterm.writeln(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m`)
        else if (msg.type === 'disconnected') xterm.writeln('\r\n\x1b[33m[Session closed]\x1b[0m')
      } catch {}
    }
    ws.onclose = () => xterm.writeln('\r\n\x1b[33m[Disconnected]\x1b[0m')
    ws.onerror = () => xterm.writeln('\r\n\x1b[31m[WebSocket error]\x1b[0m')

    xterm.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })

    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      ws.close()
      xterm.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!target || !credId) return (
    <div style={{ background: '#0d1117', color: '#ef4444', padding: 20, fontFamily: 'monospace' }}>
      Missing target or cred_id in URL.
    </div>
  )

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0d1117', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 12px', background: '#161b22', borderBottom: '1px solid #30363d', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#c9d1d9' }}>🖥 {target}</span>
        <span style={{ fontSize: 11, color: '#484f58' }}>— PsExec Shell</span>
      </div>
      <div ref={termRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
