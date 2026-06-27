import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  mdiRouter, mdiSwitch, mdiServer, mdiServerNetwork,
  mdiHarddisk, mdiMonitor, mdiLaptop, mdiPrinter,
  mdiCloud, mdiCloudOutline, mdiWifi, mdiWeb, mdiShield,
  mdiShieldHalf, mdiVpn, mdiDatabase, mdiDatabaseOutline,
  mdiDocker, mdiKubernetes, mdiMicrosoftAzure, mdiGoogleCloud,
  mdiAws, mdiPhone, mdiCellphone, mdiTablet,
  mdiNetworkOutline, mdiEthernet, mdiLan, mdiLanConnect,
  mdiApplicationBracketsOutline, mdiEmailOutline, mdiFolderNetworkOutline,
  mdiTuneVertical, mdiChip, mdiPower, mdiFlash,
  mdiOfficeBuilding, mdiBriefcase, mdiHomeOutline,
  mdiPackageVariantClosed, mdiCctv, mdiLockOutline, mdiGateAnd,
  mdiSourceBranch, mdiWallFire, mdiSecurity, mdiScaleBalance,
} from '@mdi/js'
import { api, NetworkDiagram, DiagramNode, DiagramEdge, DiagramData, Server } from '../api/client'

// ── Device Library ────────────────────────────────────────────────────────────

export interface DeviceDef {
  type: string
  label: string
  category: string
  mdiPath: string
  color: string
  ciscoStyle?: 'router' | 'switch' | 'firewall' | 'server' | 'cloud' | 'workstation'
}

export const DEVICE_LIBRARY: DeviceDef[] = [
  // Network
  { type: 'router',        label: 'Router',          category: 'Network',    mdiPath: mdiRouter,                   color: '#1f6feb' },
  { type: 'switch_l2',     label: 'Switch (L2)',      category: 'Network',    mdiPath: mdiSwitch,                   color: '#388bfd' },
  { type: 'switch_l3',     label: 'Switch (L3)',      category: 'Network',    mdiPath: mdiLanConnect,               color: '#58a6ff' },
  { type: 'hub',           label: 'Hub',              category: 'Network',    mdiPath: mdiLan,                      color: '#79c0ff' },
  { type: 'load_balancer', label: 'Load Balancer',    category: 'Network',    mdiPath: mdiScaleBalance,             color: '#388bfd' },
  { type: 'wireless_ap',   label: 'Wireless AP',      category: 'Network',    mdiPath: mdiWifi,                     color: '#f0883e' },
  { type: 'ethernet',      label: 'Ethernet',         category: 'Network',    mdiPath: mdiEthernet,                 color: '#388bfd' },
  { type: 'network',       label: 'Network',          category: 'Network',    mdiPath: mdiNetworkOutline,           color: '#58a6ff' },

  // Security
  { type: 'firewall',      label: 'Firewall',         category: 'Security',   mdiPath: mdiWallFire,                 color: '#da3633' },
  { type: 'ids_ips',       label: 'IDS / IPS',        category: 'Security',   mdiPath: mdiShieldHalf,               color: '#f85149' },
  { type: 'waf',           label: 'WAF',              category: 'Security',   mdiPath: mdiShield,                   color: '#ff7b72' },
  { type: 'vpn_gw',        label: 'VPN Gateway',      category: 'Security',   mdiPath: mdiVpn,                      color: '#a371f7' },
  { type: 'lock',          label: 'Access Control',   category: 'Security',   mdiPath: mdiLockOutline,              color: '#da3633' },
  { type: 'gate',          label: 'Gateway',          category: 'Security',   mdiPath: mdiGateAnd,                  color: '#f85149' },

  // Servers
  { type: 'server',        label: 'Server',           category: 'Servers',    mdiPath: mdiServer,                   color: '#2ea043' },
  { type: 'server_web',    label: 'Web Server',       category: 'Servers',    mdiPath: mdiWeb,                      color: '#3fb950' },
  { type: 'server_db',     label: 'DB Server',        category: 'Servers',    mdiPath: mdiDatabase,                 color: '#56d364' },
  { type: 'server_mail',   label: 'Mail Server',      category: 'Servers',    mdiPath: mdiEmailOutline,             color: '#2ea043' },
  { type: 'server_file',   label: 'File Server',      category: 'Servers',    mdiPath: mdiFolderNetworkOutline,     color: '#3fb950' },
  { type: 'server_dns',    label: 'DNS Server',       category: 'Servers',    mdiPath: mdiLanConnect,               color: '#56d364' },
  { type: 'server_proxy',  label: 'Proxy Server',     category: 'Servers',    mdiPath: mdiSourceBranch,             color: '#2ea043' },
  { type: 'server_net',    label: 'Server Cluster',   category: 'Servers',    mdiPath: mdiServerNetwork,            color: '#3fb950' },

  // Compute
  { type: 'vm',            label: 'Virtual Machine',  category: 'Compute',    mdiPath: mdiSecurity,                 color: '#8957e5' },
  { type: 'hypervisor',    label: 'Hypervisor',       category: 'Compute',    mdiPath: mdiChip,                     color: '#a371f7' },
  { type: 'docker',        label: 'Docker',           category: 'Compute',    mdiPath: mdiDocker,                   color: '#1d63ed' },
  { type: 'kubernetes',    label: 'Kubernetes',       category: 'Compute',    mdiPath: mdiKubernetes,               color: '#326ce5' },
  { type: 'app',           label: 'Application',      category: 'Compute',    mdiPath: mdiApplicationBracketsOutline, color: '#8957e5' },

  // Storage
  { type: 'storage',       label: 'Storage',          category: 'Storage',    mdiPath: mdiHarddisk,                 color: '#db6d28' },
  { type: 'nas',           label: 'NAS',              category: 'Storage',    mdiPath: mdiServerNetwork,            color: '#e3b341' },
  { type: 'san',           label: 'SAN',              category: 'Storage',    mdiPath: mdiHarddisk,                 color: '#d29922' },
  { type: 'db',            label: 'Database',         category: 'Storage',    mdiPath: mdiDatabaseOutline,          color: '#db6d28' },
  { type: 'object_store',  label: 'Object Storage',   category: 'Storage',    mdiPath: mdiPackageVariantClosed,     color: '#e3b341' },

  // Cloud
  { type: 'cloud',         label: 'Cloud',            category: 'Cloud',      mdiPath: mdiCloud,                    color: '#58a6ff' },
  { type: 'cloud_aws',     label: 'AWS',              category: 'Cloud',      mdiPath: mdiAws,                      color: '#ff9900' },
  { type: 'cloud_azure',   label: 'Azure',            category: 'Cloud',      mdiPath: mdiMicrosoftAzure,           color: '#0078d4' },
  { type: 'cloud_gcp',     label: 'Google Cloud',     category: 'Cloud',      mdiPath: mdiGoogleCloud,              color: '#4285f4' },
  { type: 'cloud_private', label: 'Private Cloud',    category: 'Cloud',      mdiPath: mdiCloudOutline,             color: '#a371f7' },
  { type: 'internet',      label: 'Internet',         category: 'Cloud',      mdiPath: mdiWeb,                      color: '#388bfd' },

  // End Devices
  { type: 'workstation',   label: 'Workstation',      category: 'End Devices', mdiPath: mdiMonitor,                 color: '#3fb950' },
  { type: 'laptop',        label: 'Laptop',           category: 'End Devices', mdiPath: mdiLaptop,                  color: '#56d364' },
  { type: 'phone',         label: 'Phone',            category: 'End Devices', mdiPath: mdiPhone,                   color: '#3fb950' },
  { type: 'mobile',        label: 'Mobile Device',    category: 'End Devices', mdiPath: mdiCellphone,               color: '#2ea043' },
  { type: 'tablet',        label: 'Tablet',           category: 'End Devices', mdiPath: mdiTablet,                  color: '#56d364' },
  { type: 'printer',       label: 'Printer',          category: 'End Devices', mdiPath: mdiPrinter,                 color: '#8b949e' },
  { type: 'cctv',          label: 'CCTV / Camera',    category: 'End Devices', mdiPath: mdiCctv,                    color: '#8b949e' },
  { type: 'iot',           label: 'IoT Device',       category: 'End Devices', mdiPath: mdiChip,                    color: '#3fb950' },

  // Infrastructure
  { type: 'rack',          label: 'Rack / Cabinet',   category: 'Infrastructure', mdiPath: mdiTuneVertical,         color: '#6e7681' },
  { type: 'ups',           label: 'UPS',              category: 'Infrastructure', mdiPath: mdiPower,                color: '#e3b341' },
  { type: 'pdu',           label: 'PDU',              category: 'Infrastructure', mdiPath: mdiFlash,                color: '#d29922' },
  { type: 'patch_panel',   label: 'Patch Panel',      category: 'Infrastructure', mdiPath: mdiEthernet,             color: '#6e7681' },

  // Zones / Areas
  { type: 'zone',          label: 'Zone',             category: 'Zones',      mdiPath: '',                          color: '#30363d', ciscoStyle: 'firewall' },
  { type: 'zone_dmz',      label: 'DMZ',              category: 'Zones',      mdiPath: '',                          color: '#da3633' },
  { type: 'zone_office',   label: 'Office',           category: 'Zones',      mdiPath: mdiOfficeBuilding,           color: '#388bfd' },
  { type: 'zone_dc',       label: 'Data Center',      category: 'Zones',      mdiPath: mdiServerNetwork,            color: '#2ea043' },
  { type: 'zone_home',     label: 'Home',             category: 'Zones',      mdiPath: mdiHomeOutline,              color: '#f0883e' },
  { type: 'zone_branch',   label: 'Branch Office',    category: 'Zones',      mdiPath: mdiBriefcase,                color: '#a371f7' },
]

const CATEGORIES = [...new Set(DEVICE_LIBRARY.map(d => d.category))]

const CONN_TYPES = [
  { type: 'lan',    label: 'LAN / Ethernet', color: '#58a6ff', dash: [] as number[] },
  { type: 'uplink', label: 'Uplink / WAN',   color: '#3fb950', dash: [] as number[] },
  { type: 'fiber',  label: 'Fiber',          color: '#a371f7', dash: [] as number[] },
  { type: 'mgmt',   label: 'Management',     color: '#f0883e', dash: [6, 3] },
  { type: 'vpn',    label: 'VPN Tunnel',     color: '#f85149', dash: [4, 4] },
  { type: 'wireless', label: 'Wireless',     color: '#e3b341', dash: [2, 4] },
]

const ZONE_TYPES = new Set(DEVICE_LIBRARY.filter(d => d.category === 'Zones').map(d => d.type))

let _id = 1
function uid() { return `n_${_id++}_${Date.now()}` }

// ── Canvas helpers ────────────────────────────────────────────────────────────

function drawMdiIcon(ctx: CanvasRenderingContext2D, pathData: string, cx: number, cy: number, size: number, color: string) {
  if (!pathData) return
  ctx.save()
  ctx.fillStyle = color
  ctx.translate(cx - size / 2, cy - size / 2)
  ctx.scale(size / 24, size / 24)
  ctx.fill(new Path2D(pathData))
  ctx.restore()
}

function drawNode(ctx: CanvasRenderingContext2D, n: DiagramNode, isSelected: boolean, isConnSrc: boolean) {
  const def = DEVICE_LIBRARY.find(d => d.type === n.type)
  const col = n.color || def?.color || '#58a6ff'
  const isZone = ZONE_TYPES.has(n.type) || n.isZone

  if (isZone) {
    ctx.save()
    ctx.strokeStyle = isSelected ? col : col + '88'
    ctx.lineWidth = isSelected ? 2 : 1.5
    ctx.setLineDash([8, 4])
    ctx.fillStyle = col + '12'
    ctx.beginPath()
    ;(ctx as any).roundRect(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h, 10)
    ctx.fill(); ctx.stroke()
    ctx.setLineDash([])
    // zone label bar
    ctx.fillStyle = col + '25'
    ctx.beginPath()
    ;(ctx as any).roundRect(n.x - n.w / 2, n.y - n.h / 2, n.w, 26, [10, 10, 0, 0])
    ctx.fill()
    if (def?.mdiPath) drawMdiIcon(ctx, def.mdiPath, n.x - n.w / 2 + 13, n.y - n.h / 2 + 13, 16, col)
    ctx.font = 'bold 12px Segoe UI, sans-serif'
    ctx.fillStyle = col
    ctx.textAlign = 'left'
    ctx.fillText(n.label, n.x - n.w / 2 + (def?.mdiPath ? 28 : 10), n.y - n.h / 2 + 17)
    ctx.restore()
    return
  }

  ctx.save()
  if (isSelected) { ctx.shadowColor = col; ctx.shadowBlur = 16 }

  // card background
  ctx.fillStyle = '#161b22'
  ctx.strokeStyle = isSelected ? col : '#30363d'
  ctx.lineWidth = isSelected ? 2 : 1
  ctx.beginPath()
  ;(ctx as any).roundRect(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h, 8)
  ctx.fill(); ctx.stroke()
  ctx.shadowBlur = 0

  // top colour bar
  ctx.fillStyle = col + '30'
  ctx.beginPath()
  ;(ctx as any).roundRect(n.x - n.w / 2, n.y - n.h / 2, n.w, 32, [8, 8, 0, 0])
  ctx.fill()

  // MDI icon in top bar
  if (def?.mdiPath) {
    drawMdiIcon(ctx, def.mdiPath, n.x, n.y - n.h / 2 + 16, 20, col)
  }

  // SSH badge
  if (n.serverId) {
    ctx.fillStyle = '#2ea04340'
    ctx.beginPath()
    ;(ctx as any).roundRect(n.x + n.w / 2 - 18, n.y - n.h / 2 - 7, 18, 14, 3)
    ctx.fill()
    ctx.font = 'bold 8px monospace'
    ctx.fillStyle = '#3fb950'
    ctx.textAlign = 'center'
    ctx.fillText('SSH', n.x + n.w / 2 - 9, n.y - n.h / 2 + 2)
  }

  // label
  ctx.font = 'bold 11px Segoe UI, sans-serif'
  ctx.fillStyle = '#e6edf3'
  ctx.textAlign = 'center'
  const lbl = n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label
  ctx.fillText(lbl, n.x, n.y + 5)

  // IP
  if (n.ip) {
    ctx.font = '9px monospace'
    ctx.fillStyle = '#8b949e'
    ctx.fillText(n.ip, n.x, n.y + 17)
  }

  // connect ring
  if (isConnSrc) {
    ctx.strokeStyle = '#f0883e'; ctx.lineWidth = 2
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ;(ctx as any).roundRect(n.x - n.w / 2 - 4, n.y - n.h / 2 - 4, n.w + 8, n.h + 8, 10)
    ctx.stroke(); ctx.setLineDash([])
  }

  ctx.restore()
}

// Returns the point on the border of node `from` in the direction of node `to`
function getEdgePt(from: DiagramNode, to: DiagramNode) {
  const dx = to.x - from.x, dy = to.y - from.y
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y }
  const hw = from.w / 2, hh = from.h / 2
  const t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9))
  return { x: from.x + dx * t, y: from.y + dy * t }
}

function drawEdge(ctx: CanvasRenderingContext2D, e: DiagramEdge, nodes: DiagramNode[], isSelected: boolean) {
  const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to)
  if (!a || !b) return
  const ct = CONN_TYPES.find(c => c.type === e.type) || CONN_TYPES[0]
  const p1 = getEdgePt(a, b), p2 = getEdgePt(b, a)

  // Bezier control points: tangents follow each node's exit direction
  const tension = Math.min(Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.45, 120)
  const a1Dx = p1.x - a.x, a1Dy = p1.y - a.y, a1D = Math.hypot(a1Dx, a1Dy) || 1
  const b2Dx = p2.x - b.x, b2Dy = p2.y - b.y, b2D = Math.hypot(b2Dx, b2Dy) || 1
  const cp1x = p1.x + (a1Dx / a1D) * tension, cp1y = p1.y + (a1Dy / a1D) * tension
  const cp2x = p2.x + (b2Dx / b2D) * tension, cp2y = p2.y + (b2Dy / b2D) * tension

  ctx.save()
  ctx.strokeStyle = isSelected ? '#fff' : ct.color
  ctx.lineWidth = isSelected ? 2.5 : 1.8
  ctx.setLineDash(ct.dash)
  ctx.shadowColor = isSelected ? ct.color : 'transparent'
  ctx.shadowBlur = isSelected ? 6 : 0
  ctx.beginPath()
  ctx.moveTo(p1.x, p1.y)
  ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.shadowBlur = 0

  // Arrowheads
  const arrowStyle = e.arrows ?? 'forward'
  const arrowColor = isSelected ? '#fff' : ct.color
  const as = 9

  function drawArrow(tx: number, ty: number, angle: number) {
    ctx.save()
    ctx.fillStyle = arrowColor
    ctx.translate(tx, ty)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(-as, -as * 0.42)
    ctx.lineTo(-as, as * 0.42)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  if (arrowStyle === 'forward' || arrowStyle === 'both') {
    drawArrow(p2.x, p2.y, Math.atan2(p2.y - cp2y, p2.x - cp2x))
  }
  if (arrowStyle === 'both') {
    drawArrow(p1.x, p1.y, Math.atan2(p1.y - cp1y, p1.x - cp1x))
  }

  // Label
  if (e.label) {
    const lx = (p1.x + p2.x) / 2, ly = (p1.y + p2.y) / 2
    ctx.font = '10px Segoe UI, sans-serif'
    ctx.textAlign = 'center'
    const tw = ctx.measureText(e.label).width
    ctx.fillStyle = '#0d1117'
    ctx.fillRect(lx - tw / 2 - 4, ly - 9, tw + 8, 14)
    ctx.fillStyle = ct.color
    ctx.fillText(e.label, lx, ly + 1)
  }
  ctx.restore()
}

interface GridOptions { bg: string; lineColor: string; size: number; show: boolean }

function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, opts: GridOptions, panX = 0, panY = 0, scale = 1) {
  ctx.fillStyle = opts.bg
  ctx.fillRect(0, 0, W, H)
  if (!opts.show || opts.size < 4) return
  const step = opts.size * scale
  if (step < 4) return
  const ox = ((panX % step) + step) % step
  const oy = ((panY % step) + step) % step
  ctx.save(); ctx.strokeStyle = opts.lineColor; ctx.lineWidth = 1
  for (let x = ox - step; x < W + step; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
  for (let y = oy - step; y < H + step; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }
  ctx.restore()
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Diagrams() {
  const nav = useNavigate()

  const [diagrams, setDiagrams] = useState<NetworkDiagram[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [activeDiagram, setActiveDiagram] = useState<NetworkDiagram | null>(null)
  const [diagramName, setDiagramName] = useState('')
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Block in-app navigation (NavLink uses history.pushState internally)
  useEffect(() => {
    if (!dirty) return
    const original = window.history.pushState.bind(window.history)
    window.history.pushState = function (state: unknown, title: string, url?: string | URL | null) {
      if (window.confirm('You have unsaved changes in "' + diagramName + '".\n\nLeave without saving?')) {
        window.history.pushState = original
        original(state, title, url)
      }
    }
    return () => { window.history.pushState = original }
  }, [dirty, diagramName])

  // Block browser tab close / refresh
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [nodes, setNodes] = useState<DiagramNode[]>([])
  const [edges, setEdges] = useState<DiagramEdge[]>([])
  const [selected, setSelected] = useState<DiagramNode | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<DiagramEdge | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connectFrom, setConnectFrom] = useState<DiagramNode | null>(null)
  const draggingRef = useRef<DiagramNode | null>(null)
  const dragOffRef = useRef({ x: 0, y: 0 })
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const multiSelectedRef = useRef<Set<string>>(new Set())
  const multiDragOffsetsRef = useRef<Map<string, { ox: number; oy: number }>>(new Map())
  const nodesRef = useRef<DiagramNode[]>([])
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  const [canvasCursor, setCanvasCursor] = useState<string>('default')

  // Pan & zoom
  const panRef = useRef({ x: 0, y: 0 })
  const scaleRef = useRef(1)
  const [displayScale, setDisplayScale] = useState(1)   // for toolbar display only
  const isPanningRef = useRef(false)
  const panStartRef = useRef({ mx: 0, my: 0, px: 0, py: 0 })
  const spaceDownRef = useRef(false)

  const [servers, setServers] = useState<Server[]>([])
  const [serverSearch, setServerSearch] = useState('')
  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [rightTab, setRightTab] = useState<'palette' | 'props' | 'servers' | 'legend'>('palette')
  const [paletteSearch, setPaletteSearch] = useState('')
  const [paletteCategory, setPaletteCategory] = useState('All')

  // Canvas appearance
  const [canvasBg, setCanvasBg]         = useState('#0d1117')
  const [gridColor, setGridColor]       = useState('#21262d')
  const [gridSize, setGridSize]         = useState(40)
  const [showGrid, setShowGrid]         = useState(true)

  // ── Data ──────────────────────────────────────────────────────────────────

  const loadList = useCallback(async () => {
    setLoadingList(true)
    try { const r = await api.get<{ diagrams: NetworkDiagram[] }>('/diagrams'); setDiagrams(r.diagrams) }
    finally { setLoadingList(false) }
  }, [])

  useEffect(() => {
    loadList()
    api.get<Server[]>('/servers').then(setServers).catch(() => {})
  }, [loadList])

  // ── Canvas ────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current
    if (!canvas || !wrap) return
    const W = wrap.clientWidth, H = wrap.clientHeight
    if (canvas.width !== W) canvas.width = W
    if (canvas.height !== H) canvas.height = H
    const ctx = canvas.getContext('2d')!
    const { x: px, y: py } = panRef.current
    const sc = scaleRef.current
    ctx.clearRect(0, 0, W, H)
    drawGrid(ctx, W, H, { bg: canvasBg, lineColor: gridColor, size: gridSize, show: showGrid }, px, py, sc)
    ctx.save()
    ctx.translate(px, py)
    ctx.scale(sc, sc)
    nodes.filter(n => ZONE_TYPES.has(n.type) || n.isZone).forEach(n => drawNode(ctx, n, selected?.id === n.id || multiSelectedRef.current.has(n.id), connectFrom?.id === n.id))
    edges.forEach(e => drawEdge(ctx, e, nodes, selectedEdge?.id === e.id))
    nodes.filter(n => !ZONE_TYPES.has(n.type) && !n.isZone).forEach(n => drawNode(ctx, n, selected?.id === n.id || multiSelectedRef.current.has(n.id), connectFrom?.id === n.id))
    ctx.restore()
  }, [nodes, edges, selected, selectedEdge, connectFrom, multiSelected, canvasBg, gridColor, gridSize, showGrid])

  // Keep a ref so pan/zoom handlers always call the latest draw (avoids stale closures)
  const drawRef = useRef(draw)
  useEffect(() => { drawRef.current = draw }, [draw])

  // Redraw after every render so the canvas is always in sync with React state
  // Use draw directly (not drawRef) — drawRef is updated in useEffect which runs after useLayoutEffect
  useLayoutEffect(() => { draw() })

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return
    const ro = new ResizeObserver(() => requestAnimationFrame(() => drawRef.current()))
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Non-passive wheel listener — React's synthetic onWheel is passive and cannot preventDefault
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const r = canvas.getBoundingClientRect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      const oldSc = scaleRef.current
      const newSc = Math.min(4, Math.max(0.15, oldSc * (e.deltaY > 0 ? 0.92 : 1.085)))
      const ratio = newSc / oldSc
      panRef.current = { x: sx - (sx - panRef.current.x) * ratio, y: sy - (sy - panRef.current.y) * ratio }
      scaleRef.current = newSc
      setDisplayScale(newSc)
      drawRef.current()
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  // ── Diagram CRUD ──────────────────────────────────────────────────────────

  async function openDiagram(d: NetworkDiagram) {
    const full = await api.get<NetworkDiagram>(`/diagrams/${d.id}`)
    setActiveDiagram(full); setDiagramName(full.name)
    const data = (full.data as DiagramData) || { nodes: [], edges: [] }
    setNodes(data.nodes || []); setEdges(data.edges || [])
    setSelected(null); setSelectedEdge(null); setDirty(false)
    setConnecting(false); setConnectFrom(null)
  }

  async function newDiagram() {
    if (!newName.trim()) return
    const d = await api.post<NetworkDiagram>('/diagrams', { name: newName.trim(), data: { nodes: [], edges: [] } })
    setDiagrams(prev => [d, ...prev]); setShowNewForm(false); setNewName('')
    openDiagram(d)
  }

  async function saveDiagram() {
    if (!activeDiagram) return
    setSaving(true)
    try {
      await api.patch(`/diagrams/${activeDiagram.id}`, { name: diagramName, data: { nodes, edges } })
      setDirty(false)
      setDiagrams(prev => prev.map(d => d.id === activeDiagram.id ? { ...d, name: diagramName } : d))
    }
    finally { setSaving(false) }
  }

  async function deleteDiagram(id: string) {
    if (!confirm('Delete this diagram?')) return
    await api.delete(`/diagrams/${id}`)
    setDiagrams(prev => prev.filter(d => d.id !== id))
    if (activeDiagram?.id === id) { setActiveDiagram(null); setNodes([]); setEdges([]) }
  }

  // ── Node management ───────────────────────────────────────────────────────

  function addNode(type: string, x: number, y: number, serverId?: string, serverLabel?: string) {
    const def = DEVICE_LIBRARY.find(d => d.type === type)
    const isZone = ZONE_TYPES.has(type)
    const n: DiagramNode = {
      id: uid(), type, x, y,
      w: isZone ? 220 : 84, h: isZone ? 140 : 76,
      label: serverLabel || def?.label || type,
      ip: '', notes: '',
      serverId: serverId || null,
      isZone,
      color: def?.color,
    }
    setNodes(prev => [...prev, n]); setSelected(n); setDirty(true)
  }

  function hitTest(x: number, y: number): DiagramNode | null {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      if (x >= n.x - n.w / 2 && x <= n.x + n.w / 2 && y >= n.y - n.h / 2 && y <= n.y + n.h / 2) return n
    }
    return null
  }

  function deleteSelected() {
    const ids = new Set([...multiSelectedRef.current, ...(selected ? [selected.id] : [])])
    if (ids.size > 0) {
      setEdges(prev => prev.filter(e => !ids.has(e.from) && !ids.has(e.to)))
      setNodes(prev => prev.filter(n => !ids.has(n.id)))
      setSelected(null); setMultiSelected(new Set()); multiSelectedRef.current = new Set(); setDirty(true)
    } else if (selectedEdge) {
      setEdges(prev => prev.filter(e => e.id !== selectedEdge.id))
      setSelectedEdge(null); setDirty(true)
    }
  }

  // ── Canvas events ─────────────────────────────────────────────────────────

  // ── Canvas coordinate helpers ─────────────────────────────────────────────

  function canvasPt(clientX: number, clientY: number) {
    const r = canvasRef.current!.getBoundingClientRect()
    return {
      x: (clientX - r.left - panRef.current.x) / scaleRef.current,
      y: (clientY - r.top  - panRef.current.y) / scaleRef.current,
    }
  }

  function applyZoom(delta: number, cx: number, cy: number) {
    const canvas = canvasRef.current; if (!canvas) return
    const r = canvas.getBoundingClientRect()
    const sx = cx - r.left, sy = cy - r.top
    const oldSc = scaleRef.current
    const newSc = Math.min(4, Math.max(0.15, oldSc * (delta > 0 ? 0.92 : 1.085)))
    const ratio = newSc / oldSc
    panRef.current = { x: sx - (sx - panRef.current.x) * ratio, y: sy - (sy - panRef.current.y) * ratio }
    scaleRef.current = newSc
    setDisplayScale(newSc)
    drawRef.current()
  }

  function fitToScreen() {
    if (nodes.length === 0) { panRef.current = { x: 0, y: 0 }; scaleRef.current = 1; setDisplayScale(1); drawRef.current(); return }
    const wrap = wrapRef.current!
    const W = wrap.clientWidth, H = wrap.clientHeight
    const xs = nodes.flatMap(n => [n.x - n.w / 2, n.x + n.w / 2])
    const ys = nodes.flatMap(n => [n.y - n.h / 2, n.y + n.h / 2])
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const pad = 60
    const sc = Math.min(4, Math.max(0.15, Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1))))
    panRef.current = { x: W / 2 - ((minX + maxX) / 2) * sc, y: H / 2 - ((minY + maxY) / 2) * sc }
    scaleRef.current = sc; setDisplayScale(sc); drawRef.current()
  }

  function startPan(clientX: number, clientY: number) {
    isPanningRef.current = true
    panStartRef.current = { mx: clientX, my: clientY, px: panRef.current.x, py: panRef.current.y }
    setCanvasCursor('grabbing')
    const onMove = (ev: MouseEvent) => {
      panRef.current = { x: panStartRef.current.px + (ev.clientX - panStartRef.current.mx), y: panStartRef.current.py + (ev.clientY - panStartRef.current.my) }
      drawRef.current()
    }
    const onUp = () => {
      isPanningRef.current = false
      setCanvasCursor('default')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function startDrag() {
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const { x, y } = canvasPt(ev.clientX, ev.clientY)
      const offsets = multiDragOffsetsRef.current
      if (offsets.size > 1) {
        setNodes(prev => prev.map(n => { const off = offsets.get(n.id); return off ? { ...n, x: x - off.ox, y: y - off.oy } : n }))
      } else {
        const id = draggingRef.current!.id
        setNodes(prev => prev.map(n => n.id === id ? { ...n, x: x - dragOffRef.current.x, y: y - dragOffRef.current.y } : n))
      }
      setDirty(true)
    }
    const onUp = () => {
      draggingRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault() // prevent browser scroll-to-focus on canvas click
    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      startPan(e.clientX, e.clientY); return
    }
    if (e.button !== 0) return
    const { x, y } = canvasPt(e.clientX, e.clientY)
    const hit = hitTest(x, y)
    if (connecting) {
      if (hit) {
        if (!connectFrom) { setConnectFrom(hit) }
        else if (connectFrom.id !== hit.id) {
          const exists = edges.find(ed => (ed.from === connectFrom.id && ed.to === hit.id) || (ed.from === hit.id && ed.to === connectFrom.id))
          if (!exists) { setEdges(prev => [...prev, { id: uid(), from: connectFrom.id, to: hit.id, type: 'lan', label: '' }]); setDirty(true) }
          setConnectFrom(null); setConnecting(false); setSelected(hit)
        }
      }
      return
    }
    if (hit) {
      if (e.ctrlKey || e.metaKey) {
        setMultiSelected(prev => {
          const next = new Set(prev)
          if (next.has(hit.id)) next.delete(hit.id); else next.add(hit.id)
          multiSelectedRef.current = next
          return next
        })
        setSelected(hit); setSelectedEdge(null)
      } else {
        const inMulti = multiSelectedRef.current.has(hit.id) && multiSelectedRef.current.size > 1
        if (!inMulti) {
          const s = new Set([hit.id]); setMultiSelected(s); multiSelectedRef.current = s
        }
        setSelected(hit); setSelectedEdge(null)
        draggingRef.current = hit
        dragOffRef.current = { x: x - hit.x, y: y - hit.y }
        const ids = inMulti ? [...multiSelectedRef.current] : [hit.id]
        const offsets = new Map<string, { ox: number; oy: number }>()
        ids.forEach(id => { const n = nodesRef.current.find(nd => nd.id === id); if (n) offsets.set(id, { ox: x - n.x, oy: y - n.y }) })
        multiDragOffsetsRef.current = offsets
        setRightTab('props')
        startDrag()
      }
    } else {
      if (!e.ctrlKey && !e.metaKey) {
        setSelected(null); setSelectedEdge(null)
        setMultiSelected(new Set()); multiSelectedRef.current = new Set()
      }
      startPan(e.clientX, e.clientY)
    }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (isPanningRef.current || draggingRef.current) return
    const { x, y } = canvasPt(e.clientX, e.clientY)
    const hit = hitTest(x, y)
    setCanvasCursor(connecting ? 'crosshair' : hit ? 'pointer' : 'grab')
  }


  function onCanvasDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const type = e.dataTransfer.getData('device-type')
    const serverId = e.dataTransfer.getData('server-id')
    const serverName = e.dataTransfer.getData('server-name')
    if (!type && !serverId) return
    const { x, y } = canvasPt(e.clientX, e.clientY)
    addNode(serverId ? 'server' : type, x, y, serverId || undefined, serverName || undefined)
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!activeDiagram) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
      if (e.key === 'Escape') { setConnecting(false); setConnectFrom(null) }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDiagram() }
    }
    function onKeyUp(e: KeyboardEvent) { if (e.key === ' ') spaceDownRef.current = false }
    function onSpace(e: KeyboardEvent) { if (e.key === ' ') { e.preventDefault(); spaceDownRef.current = true } }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onSpace)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onSpace); window.removeEventListener('keyup', onKeyUp) }
  }, [activeDiagram, selected, selectedEdge, nodes, edges, diagramName])

  // ── Export ────────────────────────────────────────────────────────────────

  function exportPNG() {
    const canvas = canvasRef.current; if (!canvas) return
    // Save current view
    const savedPan = { ...panRef.current }
    const savedScale = scaleRef.current
    // Fit all nodes into view for export
    fitToScreen()
    // Capture after fit (fitToScreen draws synchronously via drawRef)
    canvas.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.download = `${diagramName || 'diagram'}.png`; a.href = url
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
      // Restore previous view
      panRef.current = savedPan; scaleRef.current = savedScale
      setDisplayScale(savedScale); drawRef.current()
    }, 'image/png')
  }
  function exportPDF() {
    const canvas = canvasRef.current; if (!canvas) return
    const savedPan = { ...panRef.current }
    const savedScale = scaleRef.current
    fitToScreen()
    canvas.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const win = window.open('', '_blank')
      if (win) {
        win.document.write(`<!DOCTYPE html><html><head><title>${diagramName || 'Diagram'}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1117;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;height:auto}@media print{body{background:#fff}img{width:100%;height:auto;page-break-inside:avoid}}</style></head><body><img src="${url}"/><script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>`)
        win.document.close()
      }
      panRef.current = savedPan; scaleRef.current = savedScale
      setDisplayScale(savedScale); drawRef.current()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    }, 'image/png')
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify({ nodes, edges }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.download = `${diagramName || 'diagram'}.json`; a.href = url
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Palette filtering ─────────────────────────────────────────────────────

  const filteredDevices = DEVICE_LIBRARY.filter(d => {
    const matchCat = paletteCategory === 'All' || d.category === paletteCategory
    const matchSearch = !paletteSearch || d.label.toLowerCase().includes(paletteSearch.toLowerCase()) || d.category.toLowerCase().includes(paletteSearch.toLowerCase())
    return matchCat && matchSearch
  })

  const myEdges = edges.filter(e => e.from === selected?.id || e.to === selected?.id)

  // ── Styles ────────────────────────────────────────────────────────────────

  const inp: React.CSSProperties = { width: '100%', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', fontSize: 12, padding: '5px 8px' }
  const btn: React.CSSProperties = { padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--bg-panel-alt)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' as const }
  const btnPri: React.CSSProperties = { padding: '6px 16px', borderRadius: 6, background: '#4f46e5', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
  const btnDanger: React.CSSProperties = { padding: '2px 8px', borderRadius: 5, background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', gap: 0 }}>

      {/* ── Diagram list sidebar ── */}
      <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRight: '1px solid var(--border-med)' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>📐 Diagrams</span>
          <button style={btnPri} onClick={() => setShowNewForm(v => !v)}>+ New</button>
        </div>

        {showNewForm && (
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)', display: 'flex', gap: 5 }}>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && newDiagram()} placeholder="Name…" style={{ ...inp, padding: '4px 7px' }} />
            <button style={{ ...btnPri, padding: '4px 10px', fontSize: 12 }} onClick={newDiagram}>✓</button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingList && <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>Loading…</div>}
          {!loadingList && diagrams.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>No diagrams yet.<br />Click + New to start.</div>
          )}
          {diagrams.map(d => (
            <div key={d.id} onClick={() => openDiagram(d)} style={{
              padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
              borderLeft: `3px solid ${activeDiagram?.id === d.id ? 'var(--accent-hex)' : 'transparent'}`,
              background: activeDiagram?.id === d.id ? 'var(--accent-hex)15' : 'transparent',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{new Date(d.updated_at).toLocaleDateString()}</div>
              <div style={{ marginTop: 6 }}>
                <button onClick={e => { e.stopPropagation(); deleteDiagram(d.id) }} style={btnDanger}>Del</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main area ── */}
      {!activeDiagram ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 48 }}>📐</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)' }}>Select a diagram to open</div>
          <div style={{ fontSize: 13 }}>or create a new one with "+ New"</div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* ── Toolbar ── */}
          <div style={{ height: 44, background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', flexShrink: 0 }}>
            <input value={diagramName} onChange={e => { setDiagramName(e.target.value); setDirty(true) }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text)', fontSize: 13, fontWeight: 600, outline: 'none', minWidth: 140, maxWidth: 220 }} />
            {dirty && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>●</span>}
            <div style={{ width: 1, height: 22, background: 'var(--border)' }} />
            <button style={connecting ? { ...btn, borderColor: '#f0883e', color: '#f0883e', background: '#f0883e20' } : btn}
              onClick={() => { setConnecting(v => !v); setConnectFrom(null) }}>🔗 Connect</button>
            <button style={btn} onClick={() => { setSelected(null); setSelectedEdge(null); setConnecting(false); setConnectFrom(null) }}>✕ Deselect</button>
            <div style={{ width: 1, height: 22, background: 'var(--border)' }} />
            {/* Zoom controls */}
            <button style={btn} onClick={() => applyZoom(1, (wrapRef.current?.clientWidth ?? 400) / 2, (wrapRef.current?.clientHeight ?? 300) / 2)}>−</button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 38, textAlign: 'center' }}>{Math.round(displayScale * 100)}%</span>
            <button style={btn} onClick={() => applyZoom(-1, (wrapRef.current?.clientWidth ?? 400) / 2, (wrapRef.current?.clientHeight ?? 300) / 2)}>+</button>
            <button style={btn} onClick={fitToScreen} title="Fit all nodes to screen">⊡ Fit</button>
            <div style={{ flex: 1 }} />
            <button style={btnPri} onClick={saveDiagram} disabled={saving}>{saving ? 'Saving…' : '💾 Save'}</button>
            <button style={btn} onClick={exportPNG}>⬇ PNG</button>
            <button style={btn} onClick={exportJSON}>⬇ JSON</button>
            <button style={btn} onClick={exportPDF}>🖨 PDF</button>
          </div>

          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

            {/* ── Canvas ── */}
            <div ref={wrapRef}
              style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: canvasCursor }}
              onDragOver={e => e.preventDefault()} onDrop={onCanvasDrop}>
              <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove}
                onContextMenu={e => e.preventDefault()}
                style={{ display: 'block', position: 'absolute', top: 0, left: 0 }} />
              {connecting && (
                <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: '#f0883e15', border: '1px solid #f0883e', borderRadius: 6, padding: '4px 14px', fontSize: 12, color: '#f0883e', pointerEvents: 'none' }}>
                  {connectFrom ? `Click target to connect from "${connectFrom.label}"` : 'Click source device'}
                </div>
              )}
              <div style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', fontSize: 10, color: 'rgba(255,255,255,0.2)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                Scroll to zoom · Space+drag or middle-click to pan
              </div>
            </div>

            {/* ── Right panel ── */}
            <div style={{ width: 270, flexShrink: 0, background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                {(['palette', 'props', 'servers', 'legend'] as const).map(tab => (
                  <button key={tab} onClick={() => setRightTab(tab)} style={{ flex: 1, padding: '7px 2px', fontSize: 10, background: 'none', border: 'none', borderBottom: rightTab === tab ? '2px solid var(--accent-hex)' : '2px solid transparent', color: rightTab === tab ? 'var(--accent-hex)' : 'var(--text-muted)', cursor: 'pointer' }}>
                    {tab === 'palette' ? '🎨 Devices' : tab === 'props' ? '⚙ Props' : tab === 'servers' ? '🖥 Servers' : '📖 Legend'}
                  </button>
                ))}
              </div>

              {/* ── Palette sticky header (search + category filter) ── */}
              {rightTab === 'palette' && (
                <div style={{ flexShrink: 0, padding: '8px 10px 6px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
                  <input value={paletteSearch} onChange={e => setPaletteSearch(e.target.value)}
                    placeholder="Search devices…" style={{ ...inp, marginBottom: 6 }} />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {['All', ...CATEGORIES].map(cat => (
                      <button key={cat} onClick={() => setPaletteCategory(cat)} style={{ padding: '2px 8px', borderRadius: 10, border: '1px solid var(--border)', background: paletteCategory === cat ? 'var(--accent-hex)22' : 'transparent', color: paletteCategory === cat ? 'var(--accent-hex)' : 'var(--text-muted)', fontSize: 10, cursor: 'pointer' }}>{cat}</button>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>

                {/* ── Palette tab device grid ── */}
                {rightTab === 'palette' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                    {filteredDevices.map(d => (
                      <div key={d.type}
                        draggable
                        onDragStart={e => { e.dataTransfer.setData('device-type', d.type); e.dataTransfer.setData('server-id', ''); e.dataTransfer.setData('server-name', '') }}
                        onClick={() => { const cx = (wrapRef.current?.clientWidth || 400) / 2 + (Math.random() - .5) * 200; const cy = (wrapRef.current?.clientHeight || 300) / 2 + (Math.random() - .5) * 100; addNode(d.type, cx, cy) }}
                        style={{ padding: '7px 6px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--card-bg)', cursor: 'grab', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, transition: 'border-color .15s' }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = d.color)}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                        title={`${d.category} — drag or click to add`}
                      >
                        {d.mdiPath ? (
                          <svg viewBox="0 0 24 24" width={20} height={20} style={{ flexShrink: 0 }}>
                            <path d={d.mdiPath} fill={d.color} />
                          </svg>
                        ) : (
                          <div style={{ width: 20, height: 20, borderRadius: 3, border: `1.5px dashed ${d.color}` }} />
                        )}
                        <span style={{ fontSize: 10, color: 'var(--text)', textAlign: 'center', lineHeight: 1.2 }}>{d.label}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Props tab ── */}
                {rightTab === 'props' && (
                  <>
                    {/* Canvas settings — always visible at top of props tab */}
                    <div style={{ marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Canvas</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
                          Background
                          <input type="color" value={canvasBg} onChange={e => setCanvasBg(e.target.value)}
                            style={{ width: 32, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            Grid
                            <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} style={{ cursor: 'pointer' }} />
                          </span>
                          <input type="color" value={gridColor} onChange={e => setGridColor(e.target.value)}
                            style={{ width: 32, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                          Grid size
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input type="range" min={10} max={120} step={5} value={gridSize} onChange={e => setGridSize(Number(e.target.value))}
                              style={{ width: 80, cursor: 'pointer' }} />
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28, textAlign: 'right' }}>{gridSize}px</span>
                          </div>
                        </label>
                        <button onClick={() => { setCanvasBg('#0d1117'); setGridColor('#21262d'); setGridSize(40); setShowGrid(true) }}
                          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', alignSelf: 'flex-end' }}>
                          Reset defaults
                        </button>
                      </div>
                    </div>

                    {!selected && !selectedEdge && <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginTop: 8 }}>Click a device to edit its properties</div>}

                    {selected && (() => {
                      const def = DEVICE_LIBRARY.find(d => d.type === selected.type)
                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                            {def?.mdiPath && <svg viewBox="0 0 24 24" width={18} height={18}><path d={def.mdiPath} fill={def.color} /></svg>}
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{def?.label || selected.type}</span>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>{def?.category}</span>
                          </div>

                          {[
                            { label: 'Label', key: 'label', placeholder: 'Device name' },
                            { label: 'IP / Subnet', key: 'ip', placeholder: '192.168.1.1/24' },
                          ].map(f => (
                            <div key={f.key} style={{ marginBottom: 8 }}>
                              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{f.label}</label>
                              <input value={(selected as any)[f.key] || ''} placeholder={f.placeholder}
                                onChange={e => { const v = e.target.value; setNodes(p => p.map(n => n.id === selected.id ? { ...n, [f.key]: v } : n)); setSelected(p => p ? { ...p, [f.key]: v } : null); setDirty(true) }}
                                style={inp} />
                            </div>
                          ))}

                          <div style={{ marginBottom: 8 }}>
                            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Notes</label>
                            <textarea value={selected.notes || ''} onChange={e => { const v = e.target.value; setNodes(p => p.map(n => n.id === selected.id ? { ...n, notes: v } : n)); setSelected(p => p ? { ...p, notes: v } : null); setDirty(true) }}
                              style={{ ...inp, resize: 'vertical', minHeight: 48 }} />
                          </div>

                          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                            {[{ label: 'W', key: 'w' }, { label: 'H', key: 'h' }].map(f => (
                              <div key={f.key} style={{ flex: 1 }}>
                                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{f.label}</label>
                                <input type="number" min={50} max={500} value={(selected as any)[f.key]}
                                  onChange={e => { const v = +e.target.value; setNodes(p => p.map(n => n.id === selected.id ? { ...n, [f.key]: v } : n)); setSelected(p => p ? { ...p, [f.key]: v } : null); setDirty(true) }}
                                  style={inp} />
                              </div>
                            ))}
                          </div>

                          {selected.serverId && (
                            <div style={{ marginBottom: 8, padding: '6px 10px', background: '#2ea04320', borderRadius: 6, border: '1px solid #2ea04340' }}>
                              <div style={{ fontSize: 11, color: '#3fb950' }}>🖥 Linked to SSH Manager server</div>
                              <button onClick={() => nav('/servers')} style={{ marginTop: 3, fontSize: 11, color: '#58a6ff', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>→ Open servers page</button>
                            </div>
                          )}

                          {myEdges.length > 0 && (
                            <div style={{ marginTop: 10 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Connections</div>
                              {myEdges.map(e => {
                                const other = nodes.find(n => n.id === (e.from === selected.id ? e.to : e.from))
                                const ct = CONN_TYPES.find(c => c.type === e.type) || CONN_TYPES[0]
                                return (
                                  <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5, fontSize: 11 }}>
                                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: ct.color, flexShrink: 0 }} />
                                    <span style={{ flex: 1, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{other?.label ?? '?'}</span>
                                    <select value={e.type} onChange={ev => { setEdges(p => p.map(ed => ed.id === e.id ? { ...ed, type: ev.target.value as any } : ed)); setDirty(true) }}
                                      style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 9, padding: '1px 2px', borderRadius: 4 }}>
                                      {CONN_TYPES.map(c => <option key={c.type} value={c.type}>{c.label}</option>)}
                                    </select>
                                    <select value={e.arrows ?? 'forward'} onChange={ev => { setEdges(p => p.map(ed => ed.id === e.id ? { ...ed, arrows: ev.target.value as any } : ed)); setDirty(true) }}
                                      title="Arrow style"
                                      style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 9, padding: '1px 2px', borderRadius: 4 }}>
                                      <option value="none">──</option>
                                      <option value="forward">──▶</option>
                                      <option value="both">◀──▶</option>
                                    </select>
                                    <input value={e.label || ''} placeholder="label" onChange={ev => { setEdges(p => p.map(ed => ed.id === e.id ? { ...ed, label: ev.target.value } : ed)); setDirty(true) }}
                                      style={{ width: 36, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 9, padding: '1px 3px', borderRadius: 4 }} />
                                    <button onClick={() => { setEdges(p => p.filter(ed => ed.id !== e.id)); setDirty(true) }} style={{ background: 'none', border: 'none', color: '#f85149', cursor: 'pointer', fontSize: 12, padding: 0 }}>✕</button>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          <button onClick={deleteSelected} style={{ width: '100%', marginTop: 10, padding: '5px', borderRadius: 6, border: '1px solid #f85149', background: 'transparent', color: '#f85149', fontSize: 12, cursor: 'pointer' }}>🗑 Delete</button>
                        </>
                      )
                    })()}
                  </>
                )}

                {/* ── Servers tab ── */}
                {rightTab === 'servers' && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Drag or click to add a linked server node</div>
                    <input value={serverSearch} onChange={e => setServerSearch(e.target.value)} placeholder="Search servers…" style={{ ...inp, marginBottom: 8 }} />
                    {servers.filter(s => !serverSearch || s.name.toLowerCase().includes(serverSearch.toLowerCase()) || s.hostname.toLowerCase().includes(serverSearch.toLowerCase())).map(s => (
                      <div key={s.id} draggable
                        onDragStart={e => { e.dataTransfer.setData('device-type', 'server'); e.dataTransfer.setData('server-id', s.id); e.dataTransfer.setData('server-name', s.name) }}
                        onClick={() => { const cx = (wrapRef.current?.clientWidth || 400) / 2 + (Math.random() - .5) * 200; const cy = (wrapRef.current?.clientHeight || 300) / 2 + (Math.random() - .5) * 100; addNode('server', cx, cy, s.id, s.name) }}
                        style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card-bg)', marginBottom: 5, cursor: 'grab', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <svg viewBox="0 0 24 24" width={16} height={16}><path d={mdiServer} fill="#2ea043" /></svg>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.hostname}</div>
                        </div>
                        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: s.is_active ? '#2ea04320' : '#f8514920', color: s.is_active ? '#3fb950' : '#f85149' }}>{s.is_active ? 'active' : 'off'}</span>
                      </div>
                    ))}
                  </>
                )}

                {/* ── Legend tab ── */}
                {rightTab === 'legend' && (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Connection Types</div>
                    {CONN_TYPES.map(c => (
                      <div key={c.type} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11, color: 'var(--text)' }}>
                        <svg width={28} height={8}><line x1={0} y1={4} x2={28} y2={4} stroke={c.color} strokeWidth={2} strokeDasharray={c.dash.join(',')} /></svg>
                        {c.label}
                      </div>
                    ))}
                    <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.8 }}>
                      <b style={{ color: 'var(--text)' }}>Keyboard shortcuts</b><br />
                      <b>Drag</b> device from palette onto canvas<br />
                      <b>Click</b> device in palette to add at center<br />
                      <b>🔗 Connect</b> → click two devices<br />
                      <b>Del</b> — delete selected<br />
                      <b>Ctrl+S</b> — save<br />
                      <b>Esc</b> — cancel connect mode
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
