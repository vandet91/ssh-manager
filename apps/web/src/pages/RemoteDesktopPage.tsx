import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, Server } from '../api/client'
import RemoteDesktop from './RemoteDesktop'

type RdpTab = { tabId: string; server: Server }

export default function RemoteDesktopPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [servers, setServers] = useState<Server[]>([])
  const [rdpTabs, setRdpTabs] = useState<RdpTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  // Load Windows servers
  useEffect(() => {
    api.get<Server[]>('/servers?device_category=server')
      .then(list => {
        const winServers = list.filter(s => s.os_type === 'windows' && s.windows_rdp_ready)
        setServers(winServers)

        // Restore from URL ?rdp=<serverId>
        const rdpId = searchParams.get('rdp')
        if (rdpId) {
          const s = list.find(x => x.id === rdpId)
          if (s) openTab(s, true)
        }
      })
      .catch(() => {})
  }, [])

  const openTab = useCallback((s: Server, skipUrlUpdate = false) => {
    setRdpTabs(prev => {
      const existing = prev.find(t => t.server.id === s.id)
      if (existing) {
        setActiveTabId(existing.tabId)
        return prev
      }
      const tabId = `${s.id}-${Date.now()}`
      setActiveTabId(tabId)
      if (!skipUrlUpdate) {
        setSearchParams(p => { p.set('rdp', s.id); return p }, { replace: true })
      }
      return [...prev, { tabId, server: s }]
    })
  }, [setSearchParams])

  const closeTab = useCallback((tabId: string) => {
    setRdpTabs(prev => {
      const next = prev.filter(t => t.tabId !== tabId)
      if (activeTabId === tabId) {
        const newActive = next.length > 0 ? next[next.length - 1].tabId : null
        setActiveTabId(newActive)
        const newServer = next.find(t => t.tabId === newActive)?.server
        setSearchParams(p => { newServer ? p.set('rdp', newServer.id) : p.delete('rdp'); return p }, { replace: true })
      }
      return next
    })
  }, [activeTabId, setSearchParams])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-body)', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        padding: '10px 20px', borderBottom: '1px solid var(--border-med)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        background: 'var(--bg-surface)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>🖥 Remote Desktop</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Browser-based RDP via Apache Guacamole</span>
        <div style={{ flex: 1 }} />
        {/* Quick-connect picker */}
        {servers.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Connect:</span>
            <select
              defaultValue=""
              onChange={e => {
                const s = servers.find(x => x.id === e.target.value)
                if (s) openTab(s)
                e.target.value = ''
              }}
              style={{
                background: 'var(--bg-input)', border: '1px solid var(--border-med)',
                color: 'var(--text-primary)', borderRadius: 6, padding: '4px 8px',
                fontSize: 12, cursor: 'pointer', outline: 'none',
              }}
            >
              <option value="">— select server —</option>
              {servers.map(s => (
                <option key={s.id} value={s.id}>🪟 {s.name} ({s.hostname})</option>
              ))}
            </select>
          </div>
        )}
        {servers.length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            No Windows servers configured. Go to <strong>Servers</strong> and click ⚙ Setup on a Windows server first.
          </span>
        )}
      </div>

      {rdpTabs.length === 0 ? (
        /* Empty state */
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 48, opacity: 0.3 }}>🖥</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', maxWidth: 360 }}>
            {servers.length === 0
              ? 'No Windows servers are set up yet. Go to Servers → ⚙ Setup on a Windows server to save RDP credentials.'
              : 'Select a server above to open a Remote Desktop session.'}
          </p>
          {servers.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              {servers.map(s => (
                <button key={s.id} onClick={() => openTab(s)}
                  style={{
                    padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-med)',
                    background: 'var(--bg-surface)', color: 'var(--text-primary)',
                    cursor: 'pointer', fontSize: 13, fontWeight: 500,
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                  🪟 {s.name}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.hostname}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Tab bar */}
          <div style={{
            display: 'flex', alignItems: 'center',
            background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-med)',
            overflowX: 'auto', flexShrink: 0,
          }}>
            {rdpTabs.map(tab => (
              <div key={tab.tabId}
                onClick={() => {
                  setActiveTabId(tab.tabId)
                  setSearchParams(p => { p.set('rdp', tab.server.id); return p }, { replace: true })
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  borderBottom: activeTabId === tab.tabId ? '2px solid var(--accent-hex)' : '2px solid transparent',
                  background: activeTabId === tab.tabId ? 'var(--sidebar-active-bg)' : 'transparent',
                  fontSize: 12,
                  color: activeTabId === tab.tabId ? 'var(--sidebar-active-text)' : 'var(--text-muted)',
                  transition: 'all 0.1s',
                  userSelect: 'none',
                }}>
                <span>🪟</span>
                <span style={{ fontWeight: activeTabId === tab.tabId ? 600 : 400 }}>{tab.server.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 2 }}>{tab.server.hostname}</span>
                <button
                  onClick={e => { e.stopPropagation(); closeTab(tab.tabId) }}
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-muted)',
                    cursor: 'pointer', padding: '1px 3px', fontSize: 13,
                    lineHeight: 1, borderRadius: 3, marginLeft: 2,
                  }}
                  title="Close tab">✕</button>
              </div>
            ))}
            {/* Add more button */}
            {servers.length > rdpTabs.length && (
              <div style={{ padding: '0 8px', marginLeft: 4 }}>
                <select
                  defaultValue=""
                  onChange={e => {
                    const s = servers.find(x => x.id === e.target.value)
                    if (s) openTab(s)
                    e.target.value = ''
                  }}
                  style={{
                    background: 'transparent', border: '1px solid var(--border-weak)',
                    color: 'var(--text-muted)', borderRadius: 5, padding: '3px 6px',
                    fontSize: 11, cursor: 'pointer', outline: 'none',
                  }}
                >
                  <option value="">+ Add tab</option>
                  {servers
                    .filter(s => !rdpTabs.some(t => t.server.id === s.id))
                    .map(s => <option key={s.id} value={s.id}>🪟 {s.name}</option>)
                  }
                </select>
              </div>
            )}
          </div>

          {/* Tab panels */}
          {rdpTabs.map(tab => (
            <div key={tab.tabId} style={{ display: activeTabId === tab.tabId ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
              <RemoteDesktop
                serverId={tab.server.id}
                serverName={tab.server.name}
                hostname={tab.server.hostname}
                onClose={() => closeTab(tab.tabId)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
