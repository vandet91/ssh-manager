import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as net from 'net'
import * as dgram from 'dgram'
import * as dns from 'dns/promises'
import * as fs from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as crypto from 'crypto'
import { requireAuth } from '../../middleware/auth'

const execAsync = promisify(exec)

// ── Port lists ────────────────────────────────────────────────────────────────

const QUICK_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 161,
  389, 443, 445, 515, 554, 587, 631, 993, 995,
  1433, 1521, 1883, 2375, 3074, 3306, 3389, 3478,
  5000, 5060, 5432, 5555, 5900, 5985, 6379,
  7681, 8000, 8008, 8080, 8200, 8443, 8554,
  9100, 9200, 10554, 27017, 37777, 62078,
]

const STANDARD_PORTS = Array.from(new Set([
  ...QUICK_PORTS,
  20, 69, 111, 119, 123, 137, 138, 179, 194, 500, 514, 636,
  1080, 1194, 1723, 1925, 2049, 2181, 2222, 2376, 3000, 3690, 4444, 4455,
  4840, 5001, 5037, 5061, 5986, 6443, 6666, 6668, 7000, 7001, 7474,
  8001, 8009, 8443, 8883, 8888, 9000, 9090, 9300,
  9999, 10250, 11211, 18301, 20560, 27018, 34567,
  50000, 55443, 61616, 62079,
])).sort((a, b) => a - b)

export const SERVICE_MAP: Record<number, string> = {
  20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
  53: 'DNS', 67: 'DHCP', 69: 'TFTP', 80: 'HTTP', 110: 'POP3',
  111: 'RPC', 119: 'NNTP', 123: 'NTP', 135: 'MS-RPC', 137: 'NetBIOS-NS',
  138: 'NetBIOS-DGM', 139: 'NetBIOS-SSN', 143: 'IMAP', 161: 'SNMP',
  179: 'BGP', 194: 'IRC', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB',
  465: 'SMTPS', 500: 'IKE/VPN', 514: 'Syslog', 515: 'LPD',
  554: 'RTSP', 587: 'SMTP-Submit', 631: 'IPP/CUPS', 636: 'LDAPS',
  993: 'IMAPS', 995: 'POP3S', 1080: 'SOCKS', 1194: 'OpenVPN',
  1433: 'MSSQL', 1521: 'Oracle', 1723: 'PPTP', 1883: 'MQTT',
  1925: 'Roku', 2049: 'NFS', 2181: 'Zookeeper',
  2222: 'SSH-Alt', 2375: 'Docker', 2376: 'Docker-TLS',
  3000: 'HTTP-Dev', 3074: 'Xbox/PSN', 3306: 'MySQL', 3389: 'RDP', 3478: 'STUN/Game',
  3690: 'SVN', 4444: 'Shell/Meterpreter', 4455: 'Tuya-Local', 4840: 'OPC-UA',
  5000: 'UPnP/Flask', 5001: 'HTTPS-Alt', 5037: 'ADB-Android',
  5060: 'SIP/VoIP', 5061: 'SIP-TLS', 5432: 'PostgreSQL',
  5555: 'ADB-WiFi', 5900: 'VNC', 5985: 'WinRM-HTTP', 5986: 'WinRM-HTTPS',
  6379: 'Redis', 6443: 'K8s-API', 6666: 'Tuya-Local', 6668: 'Tuya-UDP',
  7000: 'AirPlay', 7001: 'WebLogic', 7474: 'Neo4j', 7681: 'Shelly-WS',
  8000: 'HTTP-Alt / Hikvision-SDK', 8001: 'HTTP-Alt', 8008: 'Google-Cast',
  8009: 'Chromecast', 8080: 'HTTP-Proxy', 8200: 'Dahua-API', 8201: 'Dahua-API',
  8443: 'HTTPS-Alt', 8554: 'RTSP-Alt', 8883: 'MQTT-TLS', 8888: 'Jupyter',
  9000: 'Portainer/PHP-FPM', 9090: 'Prometheus', 9100: 'Printer-JetDirect',
  9200: 'Elasticsearch', 9300: 'ES-Cluster', 9999: 'Kasa/TP-Link-Smart',
  10250: 'K8s-Kubelet', 10554: 'RTSP-DVR', 11211: 'Memcached',
  18301: 'Meross', 20560: 'Dyson', 27017: 'MongoDB', 27018: 'MongoDB-Alt',
  34567: 'DVR-Generic', 37777: 'Dahua-SDK', 50000: 'Jenkins',
  55443: 'Tuya-Encrypted', 61616: 'ActiveMQ', 62078: 'iPhone-Sync',
  62079: 'iPhone-Sync-Alt',
}

// Risk level per port (for UI coloring)
export const PORT_RISK: Record<number, 'critical' | 'high' | 'medium' | 'low'> = {
  23: 'critical', 4444: 'critical', 2375: 'critical',
  5555: 'critical',   // ADB WiFi — full device control
  5037: 'critical',   // ADB over local
  34567: 'critical',  // Generic DVR — often no auth
  37777: 'critical',  // Dahua SDK — often no auth
  21: 'high', 3389: 'high', 5900: 'high', 5985: 'high',
  445: 'high', 135: 'high', 139: 'high',
  1433: 'high', 1521: 'high', 27017: 'high', 6379: 'high',
  11211: 'high', 9200: 'high', 1883: 'high', // MQTT often no auth
  554: 'high', 8554: 'high', 8000: 'high',   // RTSP camera streams
  10554: 'high', 8200: 'high', 8201: 'high',
  2376: 'medium', 3306: 'medium', 5432: 'medium', 8080: 'medium',
  5060: 'medium', 9999: 'medium', 6668: 'medium',
  8443: 'low', 80: 'low', 443: 'low', 22: 'low', 53: 'low',
}

// ── Port → device type signatures ─────────────────────────────────────────────

// Port combinations that strongly suggest a device type
const PORT_SIGNATURES: Record<string, number[]> = {
  'Windows PC':       [135, 139, 445, 3389],
  'Router/Gateway':   [80, 443, 8080, 8443, 23, 22],
  'Linux / Unix':     [22, 111],
  'Printer':          [9100, 515, 631],
  'Smart TV/Media':   [8008, 8009, 7000, 1925],
  'IP Camera':        [554, 8554, 37777, 34567, 8000, 8200, 8201, 10554],
  'NAS / Storage':    [5000, 5001, 445, 2049],
  'Game Console':     [3074, 3478, 3479],
  'VoIP / Phone':     [5060, 5061],
  'IoT / MQTT':       [1883, 8883, 4840],
  'iPhone / iPad':    [62078, 62079],
  'Android Phone':    [5555, 5037],
  'Smart Appliance':  [9999, 6668, 6666, 4455, 55443, 7681, 18301, 20560],
}

const CAMERA_DEFINITIVE_PORTS = new Set([554, 8554, 37777, 34567, 8200, 8201, 10554])
const SMART_APPLIANCE_DEFINITIVE_PORTS = new Set([9999, 6668, 6666, 4455, 55443, 7681, 18301, 20560])

// ── CIDR/range parser ─────────────────────────────────────────────────────────

function parseSingleTarget(input: string): string[] {
  input = input.trim()

  if (input.includes('/')) {
    const [base, prefix] = input.split('/')
    const prefixLen = parseInt(prefix)
    if (prefixLen < 8 || prefixLen > 32) throw new Error('CIDR prefix must be /8–/32')
    const parts = base.split('.').map(Number)
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255))
      throw new Error('Invalid IP address')
    const baseNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
    const mask = prefixLen === 32 ? 0xFFFFFFFF : (~((1 << (32 - prefixLen)) - 1)) >>> 0
    const net = (baseNum & mask) >>> 0
    const count = Math.pow(2, 32 - prefixLen)
    if (count > 65536) throw new Error('Range too large — max /16 (65534 hosts)')
    if (prefixLen === 32) return [base]
    const ips: string[] = []
    for (let i = 1; i < count - 1; i++) {
      const n = (net + i) >>> 0
      ips.push(`${(n >> 24) & 255}.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`)
    }
    return ips
  }

  if (input.includes('-')) {
    const [start, end] = input.split('-')
    if (!end.includes('.')) {
      const prefix = start.substring(0, start.lastIndexOf('.') + 1)
      const s = parseInt(start.split('.').pop()!)
      const e = parseInt(end)
      if (isNaN(s) || isNaN(e) || s > e) throw new Error('Invalid range')
      return Array.from({ length: e - s + 1 }, (_, i) => prefix + (s + i))
    }
    const toNum = (ip: string) => {
      const p = ip.split('.').map(Number)
      return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
    }
    const sn = toNum(start.trim()), en = toNum(end.trim())
    const ips: string[] = []
    for (let n = sn; n <= en; n++) {
      ips.push(`${(n >> 24) & 255}.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`)
    }
    return ips
  }

  return [input]
}

function parseTargets(input: string): string[] {
  // Split on whitespace or commas, parse each token individually, flatten
  const tokens = input.trim().split(/[\s,]+/).filter(Boolean)
  if (tokens.length > 1) {
    const all: string[] = []
    for (const token of tokens) all.push(...parseSingleTarget(token))
    return all
  }
  return parseSingleTarget(input)
}

// ── Concurrency semaphore ─────────────────────────────────────────────────────

class Semaphore {
  private count: number
  private queue: (() => void)[] = []
  constructor(max: number) { this.count = max }
  acquire() {
    return new Promise<void>(resolve => {
      if (this.count > 0) { this.count--; resolve() }
      else this.queue.push(resolve)
    })
  }
  release() {
    if (this.queue.length > 0) this.queue.shift()!()
    else this.count++
  }
}

// ── TCP port scan ─────────────────────────────────────────────────────────────

function scanPort(ip: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const sock = new net.Socket()
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => resolve(false))
    sock.connect(port, ip)
  })
}

// ── Banner grabbing ───────────────────────────────────────────────────────────

function grabBanner(ip: string, port: number, timeoutMs = 2000): Promise<string | null> {
  return new Promise(resolve => {
    const sock = new net.Socket()
    let data = ''
    const finish = (result: string | null) => {
      try { sock.destroy() } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => finish(data.slice(0, 120) || null), timeoutMs)

    sock.connect(port, ip, () => {
      // Probe HTTP ports
      if ([80, 8080, 8000, 8001, 8008, 8009, 3000, 9090, 9000].includes(port)) {
        sock.write(`HEAD / HTTP/1.0\r\nHost: ${ip}\r\n\r\n`)
      }
    })
    sock.on('data', d => {
      data += d.toString('utf8').slice(0, 400)
      clearTimeout(timer)
      const lines = data.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      finish(lines[0]?.slice(0, 120) || null)
    })
    sock.on('error', () => { clearTimeout(timer); finish(null) })
    sock.on('close', () => { clearTimeout(timer); finish(data.slice(0, 120) || null) })
  })
}

// ── Ping ─────────────────────────────────────────────────────────────────────

async function pingHost(ip: string): Promise<{ alive: boolean; latency_ms: number | null; ttl: number | null }> {
  // 1. ICMP ping — fast, gives TTL and latency
  try {
    const { stdout } = await execAsync(`ping -c 1 -W 1 ${ip}`, { timeout: 3000 })
    const ttlMatch  = stdout.match(/ttl=(\d+)/i)
    const timeMatch = stdout.match(/time[=<]([\d.]+)/i)
    return {
      alive: true,
      latency_ms: timeMatch ? parseFloat(timeMatch[1]) : null,
      ttl: ttlMatch ? parseInt(ttlMatch[1]) : null,
    }
  } catch {}

  // 2. TCP connect fallback — catches hosts with open ports but blocking ICMP
  const tcpAlive = await scanPort(ip, 80, 500) || await scanPort(ip, 443, 500) || await scanPort(ip, 22, 500)
    || await scanPort(ip, 8080, 500) || await scanPort(ip, 5555, 300) || await scanPort(ip, 62078, 300)
  if (tcpAlive) return { alive: true, latency_ms: null, ttl: null }

  // 3. ARP ping — works on Android, iOS, and any device that blocks ICMP.
  //    Layer 2 probe: the device MUST reply to ARP to communicate on the LAN.
  //    Only works when the API has host networking (docker-compose.linux.yml).
  try {
    const t0 = Date.now()
    const { stdout } = await execAsync(`arping -c 1 -w 1 ${ip} 2>/dev/null`, { timeout: 2500 })
    if (/bytes from/i.test(stdout) || /Unicast reply/i.test(stdout)) {
      return { alive: true, latency_ms: Date.now() - t0, ttl: 64 }
    }
  } catch {}

  return { alive: false, latency_ms: null, ttl: null }
}

function osFromTtl(ttl: number | null): string | null {
  if (!ttl) return null
  if (ttl <= 64)  return 'Linux / Unix'
  if (ttl <= 128) return 'Windows'
  if (ttl <= 255) return 'Network Device'
  return null
}

// ── MAC address from ARP table ────────────────────────────────────────────────

// MAC regex that matches both colon and hyphen separators
const MAC_RE = /([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}/

function parseMacFromArp(output: string, ip: string): string | null {
  // Parse `arp -n` output: looks for "(ip) at mac" or "ip ... mac"
  for (const line of output.split('\n')) {
    if (!line.includes(ip)) continue
    const m = line.match(MAC_RE)
    if (m) {
      const mac = m[0].toUpperCase().replace(/-/g, ':')
      if (mac !== 'FF:FF:FF:FF:FF:FF' && mac !== '00:00:00:00:00:00') return mac
    }
  }
  return null
}

async function getMacAddress(ip: string): Promise<string | null> {
  // 1. /proc/net/arp — instant, already populated by ping sweep
  try {
    const arp = await fs.readFile('/proc/net/arp', 'utf8')
    for (const line of arp.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols[0] === ip && cols[3] && cols[3] !== '00:00:00:00:00:00') {
        return cols[3].toUpperCase()
      }
    }
  } catch {}

  // 2. arping — sends an actual ARP request, works even if /proc/net/arp missed it
  try {
    const { stdout } = await execAsync(`arping -c 1 -w 1 ${ip} 2>/dev/null`, { timeout: 3000 })
    const m = stdout.match(MAC_RE)
    if (m) return m[0].toUpperCase().replace(/-/g, ':')
  } catch {}

  // 3. arp -n <ip> — read the OS ARP cache entry for this specific IP
  try {
    const { stdout } = await execAsync(`arp -n ${ip}`, { timeout: 2000 })
    const mac = parseMacFromArp(stdout, ip)
    if (mac) return mac
  } catch {}

  // 4. Full arp -a table scan (catches hosts that registered with a different lookup)
  try {
    const { stdout } = await execAsync('arp -a', { timeout: 3000 })
    const mac = parseMacFromArp(stdout, ip)
    if (mac) return mac
  } catch {}

  return null
}

// Pre-sweep ARP table cache — populated at scan start for fast per-host lookup
let arpTableCache: Map<string, string> = new Map()

async function warmArpCache(): Promise<void> {
  try {
    // nmap ARP ping sweep populates the OS ARP table much faster than ICMP ping
    // -sn = no port scan, -PR = ARP ping only, --send-ip = don't use raw ARP (works without root)
    // We just fire it and don't wait — it runs in background while we do ICMP pings
    execAsync('nmap -sn -PR --send-ip 0/0 2>/dev/null', { timeout: 5000 }).catch(() => {})
  } catch {}

  // Read whatever is in the ARP table right now
  try {
    const arp = await fs.readFile('/proc/net/arp', 'utf8')
    for (const line of arp.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols[0] && cols[3] && cols[3] !== '00:00:00:00:00:00') {
        arpTableCache.set(cols[0], cols[3].toUpperCase())
      }
    }
  } catch {}

  // Also read from arp -a
  try {
    const { stdout } = await execAsync('arp -a', { timeout: 3000 })
    const MAC_PAIR_RE = /\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F:]{17})/gi
    let m: RegExpExecArray | null
    while ((m = MAC_PAIR_RE.exec(stdout)) !== null) {
      const [, ip, mac] = m
      if (mac !== 'ff:ff:ff:ff:ff:ff' && mac !== '00:00:00:00:00:00')
        arpTableCache.set(ip, mac.toUpperCase())
    }
  } catch {}
}

// ── OUI vendor lookup — full IEEE database with disk cache ───────────────────

// Minimal fallback so lookups work even without network
const OUI_FALLBACK: Record<string, string> = {
  '00:17:F2': 'Apple', '28:CF:E9': 'Apple', '3C:07:54': 'Apple', 'A4:5E:60': 'Apple',
  'B8:27:EB': 'Raspberry Pi', 'DC:A6:32': 'Raspberry Pi', 'E4:5F:01': 'Raspberry Pi',
  '00:0C:42': 'MikroTik', '08:55:31': 'MikroTik', 'D4:01:C3': 'MikroTik',
  '00:00:0C': 'Cisco', '00:1B:0D': 'Cisco', '58:AC:78': 'Cisco',
  '00:15:6D': 'Ubiquiti', '18:E8:29': 'Ubiquiti', 'F0:9F:C2': 'Ubiquiti',
  '14:CC:20': 'TP-Link', '74:DA:38': 'TP-Link', 'F4:F2:6D': 'TP-Link',
  '00:09:5B': 'Netgear', '28:C6:8E': 'Netgear', '44:94:FC': 'Netgear',
  '00:09:0F': 'Fortinet', '70:4C:A5': 'Fortinet',
  '00:17:A4': 'HPE/Aruba', '40:E3:D6': 'HPE/Aruba',
  '00:05:85': 'Juniper', '28:8A:1C': 'Juniper',
  '00:0C:29': 'VMware', '00:50:56': 'VMware',
  '08:00:27': 'VirtualBox',
  '00:11:32': 'Synology', 'BC:21:0A': 'Synology',
  '00:08:9B': 'QNAP', '24:5E:BE': 'QNAP',
  '00:06:5B': 'Dell', 'F0:1F:AF': 'Dell',
  '00:02:B3': 'Intel', 'A0:36:9F': 'Intel',
}
// Module-level OUI cache: loaded once per process from IEEE or disk cache
let ouiDb: Map<string, string> | null = null
let ouiLoading: Promise<Map<string, string>> | null = null

const OUI_CACHE_FILE = '/tmp/ssh_mgr_oui.json'
const OUI_CACHE_TTL  = 30 * 24 * 3600 * 1000 // 30 days

async function loadOuiDb(): Promise<Map<string, string>> {
  if (ouiDb) return ouiDb
  if (ouiLoading) return ouiLoading

  ouiLoading = (async () => {
    // Try disk cache first
    try {
      const stat = await fs.stat(OUI_CACHE_FILE)
      if (Date.now() - stat.mtimeMs < OUI_CACHE_TTL) {
        const raw = await fs.readFile(OUI_CACHE_FILE, 'utf8')
        const entries: [string, string][] = JSON.parse(raw)
        if (entries.length > 1000) {
          ouiDb = new Map(entries)
          return ouiDb
        }
      }
    } catch {}

    // Download the IEEE OUI CSV (~4 MB, 30k+ entries)
    try {
      const { stdout } = await execAsync(
        'wget -qO- --timeout=30 https://standards-oui.ieee.org/oui/oui.csv',
        { timeout: 35000, maxBuffer: 20 * 1024 * 1024 }
      )
      const map = new Map<string, string>()
      for (const line of stdout.split('\n').slice(1)) {
        // Format: Registry,Assignment,"Organization Name","Organization Address"
        const m = line.match(/^[^,]+,([0-9A-Fa-f]{6}),"?([^,"]+)"?/)
        if (!m) continue
        const oui = m[1].toUpperCase()
        const key = `${oui[0]}${oui[1]}:${oui[2]}${oui[3]}:${oui[4]}${oui[5]}`
        map.set(key, m[2].trim())
      }
      if (map.size > 5000) {
        ouiDb = map
        // Seed with known network-specific names the IEEE list may not have
        for (const [k, v] of Object.entries(OUI_FALLBACK)) {
          if (!ouiDb.has(k)) ouiDb.set(k, v)
        }
        // Persist cache
        await fs.writeFile(OUI_CACHE_FILE, JSON.stringify([...ouiDb])).catch(() => {})
        return ouiDb
      }
    } catch {}

    // Fallback to built-in minimal table
    ouiDb = new Map(Object.entries(OUI_FALLBACK))
    return ouiDb
  })()

  return ouiLoading
}

function getMacVendor(mac: string, db: Map<string, string>): string | null {
  if (!mac) return null
  const prefix = mac.toUpperCase().slice(0, 8) // XX:XX:XX
  return db.get(prefix) ?? null
}

function isMacRandomized(mac: string): boolean {
  if (!mac) return false
  try {
    const firstByte = parseInt(mac.replace(/[:\-]/g, '').slice(0, 2), 16)
    return (firstByte & 0x02) !== 0 // locally-administered bit = randomized
  } catch { return false }
}

// ── NetBIOS name query (UDP 137) ─────────────────────────────────────────────

function getNetBiosName(ip: string, timeoutMs = 1500): Promise<string | null> {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4')
    const timer = setTimeout(() => { try { sock.close() } catch {}; resolve(null) }, timeoutMs)

    // NetBIOS Node Status Request for wildcard name (*)
    const req = Buffer.from([
      0xA2, 0x48, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x20,
      0x43, 0x4B, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
      0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
      0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
      0x41, 0x41, 0x00,
      0x00, 0x21, 0x00, 0x01,
    ])

    sock.on('message', (msg) => {
      clearTimeout(timer)
      try {
        sock.close()
        // Parse: skip 56 bytes header, then 1 byte = name count
        if (msg.length < 57) return resolve(null)
        const nameCount = msg[56]
        if (nameCount === 0) return resolve(null)
        // Each entry is 18 bytes: 15 chars name + 1 type + 2 flags
        const nameStart = 57
        for (let i = 0; i < nameCount; i++) {
          const offset = nameStart + i * 18
          if (offset + 16 > msg.length) break
          const type = msg[offset + 15]
          if (type === 0x00) { // Workstation name
            const raw = msg.slice(offset, offset + 15).toString('ascii').replace(/\0+$/, '').trim()
            if (raw.length > 0) return resolve(raw)
          }
        }
        resolve(null)
      } catch { resolve(null) }
    })

    sock.on('error', () => { clearTimeout(timer); resolve(null) })
    sock.send(req, 137, ip, (err) => { if (err) { clearTimeout(timer); try { sock.close() } catch {}; resolve(null) } })
  })
}

// ── mDNS name lookup (.local) ────────────────────────────────────────────────

function buildMdnsQuery(ip: string): Buffer {
  const queryName = ip.split('.').reverse().join('.') + '.in-addr.arpa'
  const labels = queryName.split('.')
  const buf: number[] = [
    0x00, 0x00, // Transaction ID (0 for mDNS)
    0x00, 0x00, // Flags: standard query
    0x00, 0x01, // Questions: 1
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]
  for (const label of labels) {
    buf.push(label.length)
    for (const ch of label) buf.push(ch.charCodeAt(0))
  }
  buf.push(0x00, 0x00, 0x0C, 0x00, 0x01) // end, Type PTR, Class IN
  return Buffer.from(buf)
}

function parseMdnsResponse(msg: Buffer): string | null {
  try {
    const str = msg.toString('ascii')
    const m = str.match(/([a-zA-Z0-9_-]+\.local)/)
    if (m) return m[1].replace(/\0/g, '')
  } catch {}
  return null
}

function getMdnsName(ip: string, timeoutMs = 1500): Promise<string | null> {
  // Try unicast to the device's port 5353 first (works through firewalls + Docker NAT),
  // then fall back to multicast 224.0.0.251 for devices that only respond to multicast.
  const req = buildMdnsQuery(ip)
  const destinations: Array<{ host: string; port: number }> = [
    { host: ip,            port: 5353 },  // unicast — most reliable
    { host: '224.0.0.251', port: 5353 },  // multicast fallback
  ]

  return new Promise(resolve => {
    let resolved = false
    const done = (name: string | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { sock.close() } catch {}
      resolve(name)
    }

    const timer = setTimeout(() => done(null), timeoutMs)
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    sock.on('message', (msg) => {
      const name = parseMdnsResponse(msg)
      if (name) done(name)
    })

    sock.on('error', () => done(null))

    sock.bind(() => {
      // Send to each destination sequentially, 200 ms apart
      let idx = 0
      const sendNext = () => {
        if (resolved || idx >= destinations.length) return
        const { host, port } = destinations[idx++]
        if (host === '224.0.0.251') {
          try { sock.addMembership('224.0.0.251') } catch {}
        }
        sock.send(req, port, host, err => {
          if (err && idx >= destinations.length) done(null)
        })
        if (idx < destinations.length) setTimeout(sendNext, 200)
      }
      sendNext()
    })
  })
}

// ── LLMNR hostname resolution (UDP 5355, Windows link-local) ─────────────────

function getLlmnrName(ip: string, timeoutMs = 800): Promise<string | null> {
  return new Promise(resolve => {
    const parts = ip.split('.')
    if (parts.length !== 4) return resolve(null)
    const arpa = parts.slice().reverse().join('.') + '.in-addr.arpa'
    const labels = arpa.split('.')

    const buf: number[] = [0xAB, 0xCD, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    for (const label of labels) {
      buf.push(label.length)
      for (const ch of label) buf.push(ch.charCodeAt(0))
    }
    buf.push(0x00, 0x00, 0x0C, 0x00, 0x01) // PTR IN

    const sock = dgram.createSocket('udp4')
    const timer = setTimeout(() => { try { sock.close() } catch {}; resolve(null) }, timeoutMs)

    sock.on('message', (msg) => {
      clearTimeout(timer)
      try { sock.close() } catch {}
      try {
        // Simple: look for a readable hostname in the response
        let idx = 12
        // Skip question
        while (idx < msg.length && msg[idx] !== 0) idx += msg[idx] + 1
        idx += 5 // null + qtype + qclass
        idx += 10 // answer name+type+class+ttl+rdlen (simplified)
        const nameParts: string[] = []
        while (idx < msg.length) {
          const ln = msg[idx]
          if (!ln || idx + ln + 1 > msg.length) break
          nameParts.push(msg.slice(idx + 1, idx + 1 + ln).toString('ascii'))
          idx += ln + 1
        }
        const name = nameParts.join('.').replace(/\.+$/, '')
        resolve(name || null)
      } catch { resolve(null) }
    })

    sock.on('error', () => { clearTimeout(timer); resolve(null) })
    sock.send(Buffer.from(buf), 5355, '224.0.0.252', err => {
      if (err) { clearTimeout(timer); try { sock.close() } catch {}; resolve(null) }
    })
  })
}

// ── Score-based device classification ────────────────────────────────────────

const VENDOR_SCORES: Array<[string[], string, number]> = [
  // [vendor substrings],              device type,               score
  [['hikvision', 'hangzhou hikvis'],   'IP Camera',                   8],
  [['dahua', 'zhejiang dahua'],        'IP Camera',                   8],
  [['axis comm'],                      'IP Camera',                   8],
  [['hanwha', 'uniview', 'reolink',
    'amcrest', 'foscam', 'vivotek',
    'tiandy', 'tvt digital'],          'IP Camera',                   8],
  [['synology'],                       'NAS / Storage',               7],
  [['qnap'],                           'NAS / Storage',               7],
  [['western digital', 'wd my'],       'NAS / Storage',               6],
  [['raspberry pi'],                   'Linux / Raspberry Pi',        7],
  [['vmware'],                         'VM (VMware)',                  7],
  [['virtualbox', '0a0027', '080027'], 'VM (VirtualBox)',              7],
  [['qemu', 'kvm', '525400'],          'VM (QEMU/KVM)',                7],
  [['hyper-v', '00155d'],              'VM (Hyper-V)',                 7],
  [['cisco'],                          'Network Device (Cisco)',       6],
  [['mikrotik'],                       'Router/Gateway (MikroTik)',    6],
  [['ubiquiti', 'ubnt'],               'Network Device (Ubiquiti)',    6],
  [['aruba', 'hewlett packard enter'], 'Network Device (HPE/Aruba)',   6],
  [['juniper'],                        'Network Device (Juniper)',     6],
  [['fortinet', 'fortigate'],          'Firewall (Fortinet)',          6],
  [['palo alto'],                      'Firewall (Palo Alto)',         6],
  [['check point'],                    'Firewall (Check Point)',       6],
  [['sonicwall'],                      'Firewall (SonicWall)',         6],
  [['tp-link', 'tp link', 'tplink'],   'Router/Gateway (TP-Link)',     5],
  [['netgear'],                        'Router/Gateway (Netgear)',     5],
  [['d-link', 'dlink'],                'Router/Gateway (D-Link)',      5],
  [['zyxel'],                          'Router/Gateway (ZyXEL)',       5],
  [['tenda', 'linksys'],               'Router/Gateway',               5],
  [['espressif'],                      'Smart Appliance (ESP IoT)',    6],
  [['tuya smart', 'allterco', 'shelly',
    'meross', 'gosund', 'itead'],      'Smart Appliance',              6],
  [['xiaomi communications',
    'beijing xiaomi', 'yeelink',
    'yeelight'],                       'Smart Appliance (Xiaomi IoT)', 6],
  [['apple'],                          'iPhone / iPad',                5],
  [['samsung electronics'],            'Android Phone (Samsung)',      5],
  [['huawei', 'honor device'],         'Android Phone (Huawei)',       5],
  [['oneplus', 'guangdong oppo',
    'realme', 'vivo'],                 'Android Phone',                5],
  [['google'],                         'Android Phone (Pixel)',        4],
  [['roku'],                           'Smart TV / Media',             6],
  [['nintendo'],                       'Game Console (Nintendo)',      7],
  [['sony interactive'],               'Game Console (PlayStation)',   7],
  [['hewlett packard', 'canon', 'epson',
    'brother', 'lexmark', 'ricoh',
    'kyocera', 'xerox'],               'Printer',                      6],
]

const HOSTNAME_SCORES: Array<[string[], string, number]> = [
  [['iphone', 'ipad', 'ipod', 'appletv'],          'iPhone / iPad',         5],
  [['android', 'pixel', 'galaxy', 'redmi',
    'oneplus', 'huawei', 'honor', 'poco'],          'Android Phone',         5],
  [['macbook', 'imac', 'mac-', 'macpro'],           'Mac',                   5],
  [['print', 'hp-', 'canon-', 'epson-', 'brother-'],'Printer',              4],
  [['cam', 'ipc', 'nvr', 'dvr', 'cctv',
    'hik', 'dahua', 'reolink', 'foscam'],           'IP Camera',             5],
  [['unifi', 'ubnt', 'uap-', 'usg-', 'udm-',
    'usw-', 'edgerouter', 'edgeswitch'],             'Network Device (Ubiquiti)', 5],
  [['router', 'gateway', 'gw-', 'modem'],           'Router/Gateway',        4],
  [['plug', 'socket', 'outlet', 'tasmota',
    'shelly', 'sonoff', 'kasa', 'tuya',
    'yeelight', 'yee-', 'zhimi', 'dmaker',
    'cuco', 'lumi', 'roborock', 'esphome'],          'Smart Appliance',       5],
  [['nas', 'diskstation', 'synology', 'qnap'],      'NAS / Storage',         5],
  [['desktop', 'laptop', 'pc-', 'workstation'],     'Windows PC',            3],
  [['xbox'],                                         'Game Console (Xbox)',    6],
  [['playstation', 'ps4', 'ps5'],                   'Game Console (PlayStation)', 6],
  [['switch', 'nintendo'],                           'Game Console (Nintendo)', 5],
]

const BANNER_SCORES: Array<[string[], string, number]> = [
  [['dvr', 'nvr', 'ipc', 'ip camera', 'network camera',
    'hikvision', 'dahua', 'reolink', 'channel',
    'live view', 'ptz', 'rtsp'],                'IP Camera',           5],
  [['ubiquiti', 'unifi', 'ubnt', 'edgeos',
    'airmax', 'airfiber'],                       'Network Device (Ubiquiti)', 5],
  [['routeros', 'mikrotik'],                    'Router/Gateway (MikroTik)', 5],
  [['openwrt', 'dd-wrt'],                       'Router/Gateway',       5],
  [['windows server', 'microsoft-iis'],         'Windows Server',       5],
  [['iis'],                                     'Windows PC',           4],
  [['microsoft'],                               'Windows PC',           3],
  [['diskstation', 'synology'],                 'NAS / Storage',        5],
  [['qnap nas'],                                'NAS / Storage',        5],
  [['ubuntu', 'debian', 'centos', 'fedora',
    'alpine linux'],                             'Linux / Unix',         4],
  [['tasmota', 'esphome', 'shelly', 'sonoff',
    'tuya', 'kasa', 'meross', 'gosund',
    'smart plug', 'smart socket', 'yeelight'],  'Smart Appliance',      5],
  [['fortigate', 'fortinet'],                   'Firewall (Fortinet)',   6],
  [['palo alto'],                               'Firewall (Palo Alto)',  6],
  [['checkpoint', 'check point'],               'Firewall (Check Point)', 6],
  [['printer', 'hp laserjet', 'canon',
    'epson', 'brother'],                        'Printer',              5],
  [['roku'],                                    'Smart TV / Media',     6],
  [['chromecast', 'google cast'],               'Smart TV / Media',     5],
]

// Vendors that run Linux internally but should never classify as "Linux / Unix"
const LINUX_NETWORK_VENDORS: Record<string, string> = {
  'ubiquiti': 'Network Device (Ubiquiti)',
  'ubnt':     'Network Device (Ubiquiti)',
  'unifi':    'Network Device (Ubiquiti)',
  'edgeos':   'Network Device (Ubiquiti)',
  'mikrotik': 'Router/Gateway (MikroTik)',
  'routeros': 'Router/Gateway (MikroTik)',
  'openwrt':  'Router/Gateway',
  'raspberry pi': 'Linux / Raspberry Pi',
  'synology': 'NAS / Storage',
  'qnap':     'NAS / Storage',
  'yeelight': 'Smart Appliance (Xiaomi IoT)',
  'yeelink':  'Smart Appliance (Xiaomi IoT)',
  'tasmota':  'Smart Appliance',
  'shelly':   'Smart Appliance',
}

function classifyDevice(
  openPorts: number[],
  banners: Record<number, string | null>,
  macVendor: string | null,
  macRandomized: boolean,
  ttl: number | null,
  hostname: string | null,
): string {
  const scores: Record<string, number> = {}
  const add = (type: string, pts: number) => { scores[type] = (scores[type] ?? 0) + pts }

  const portSet = new Set(openPorts)
  const vl = (macVendor ?? '').toLowerCase()
  const hl = (hostname ?? '').toLowerCase()
  const allBanners = Object.values(banners).join(' ').toLowerCase()

  // ── Vendor scoring ────────────────────────────────────────────────────────
  for (const [keywords, type, pts] of VENDOR_SCORES) {
    if (keywords.some(kw => vl.includes(kw))) add(type, pts)
  }

  // ── SSH banner — most reliable for Linux distro ───────────────────────────
  const sshBanner = (banners[22] ?? banners[2222] ?? '').toLowerCase()
  if (sshBanner) {
    if (sshBanner.includes('ubuntu'))  add('Linux / Ubuntu',  6)
    if (sshBanner.includes('debian'))  add('Linux / Debian',  6)
    if (sshBanner.includes('centos'))  add('Linux / CentOS',  6)
    if (sshBanner.includes('fedora'))  add('Linux / Fedora',  6)
    if (sshBanner.includes('alpine'))  add('Linux / Alpine',  6)
    if (sshBanner.includes('freebsd')) add('FreeBSD',         6)
    if (sshBanner.includes('openbsd')) add('OpenBSD',         6)
    if (sshBanner.includes('openssh') || sshBanner.includes('ssh')) add('Linux / Unix', 3)
  }

  // ── Banner scoring ────────────────────────────────────────────────────────
  for (const [keywords, type, pts] of BANNER_SCORES) {
    if (keywords.some(kw => allBanners.includes(kw))) add(type, pts)
  }

  // ── Hostname scoring ──────────────────────────────────────────────────────
  for (const [keywords, type, pts] of HOSTNAME_SCORES) {
    if (keywords.some(kw => hl.includes(kw))) add(type, pts)
  }

  // ── Port signature scoring ────────────────────────────────────────────────
  for (const [type, sigPorts] of Object.entries(PORT_SIGNATURES)) {
    const hits = sigPorts.filter(p => portSet.has(p)).length
    if (hits > 0) add(type, hits * 2)
  }

  // ── Definitive port overrides ─────────────────────────────────────────────
  for (const p of CAMERA_DEFINITIVE_PORTS) {
    if (portSet.has(p)) { add('IP Camera', 10); delete scores['Router/Gateway']; break }
  }
  for (const p of SMART_APPLIANCE_DEFINITIVE_PORTS) {
    if (portSet.has(p)) { add('Smart Appliance', 10); break }
  }
  if (portSet.has(62078) || portSet.has(62079)) add('iPhone / iPad', 10)
  if (portSet.has(5555))  add('Android Phone', 10) // ADB WiFi is definitive

  // ── Windows detection ─────────────────────────────────────────────────────
  if ((portSet.has(135) && portSet.has(445)) || portSet.has(3389)) add('Windows PC', 6)
  if (portSet.has(445) && portSet.has(5985)) add('Windows Server', 4)

  // ── TTL hint ──────────────────────────────────────────────────────────────
  if (ttl) {
    if (ttl <= 64)  add('Linux / Unix', 1)
    if (ttl > 64 && ttl <= 128) add('Windows PC', 1)
    if (ttl > 128)  add('Router/Gateway', 1)
  }

  // ── Randomized MAC + silent heuristic (modern smartphones) ───────────────
  // Randomized MACs (iOS 14+, Android 10+, Win10+) means we can't use OUI.
  // Use "Mobile Phone" as a neutral fallback — only pick iPhone/Android when
  // there is a positive signal (Apple OUI, port 62078, "iphone" in hostname).
  if (macRandomized) {
    add('Mobile Phone', 4)
    // Without hostname/port evidence, do NOT pre-score iPhone over Android
  }
  if (openPorts.length === 0 && ttl && ttl >= 55 && ttl <= 65) {
    add('Mobile Phone', 3)
  }
  // Promote Mobile Phone → specific type only if signals exist
  if ((scores['Mobile Phone'] ?? 0) > 0) {
    if (portSet.has(62078) || portSet.has(62079) || hl.includes('iphone') || hl.includes('ipad') || hl.includes('ipod')) {
      scores['iPhone / iPad'] = (scores['iPhone / iPad'] ?? 0) + (scores['Mobile Phone'] ?? 0)
      delete scores['Mobile Phone']
    } else if (hl.includes('android') || hl.includes('galaxy') || hl.includes('pixel') ||
               hl.includes('huawei') || hl.includes('samsung') || hl.includes('xiaomi') ||
               hl.includes('redmi') || hl.includes('oneplus') || hl.includes('oppo')) {
      scores['Android Phone'] = (scores['Android Phone'] ?? 0) + (scores['Mobile Phone'] ?? 0)
      delete scores['Mobile Phone']
    }
    // else stays as 'Mobile Phone' — honest unknown
  }

  // ── Veto: Linux-based network vendors should never show as "Linux / Unix" ─
  const allText = `${vl} ${allBanners} ${hl}`
  for (const [kw, correct] of Object.entries(LINUX_NETWORK_VENDORS)) {
    if (allText.includes(kw)) {
      delete scores['Linux / Unix']
      scores[correct] = Math.max(scores[correct] ?? 0, 10)
      break
    }
  }

  // ── Veto: camera beats router if camera score ≥ router score ─────────────
  const camScore = scores['IP Camera'] ?? 0
  if (camScore > 0 && camScore >= (scores['Router/Gateway'] ?? 0)) {
    delete scores['Router/Gateway']
  }

  // ── Veto: Xiaomi router vs phone disambiguation ───────────────────────────
  // Xiaomi phones have Apple-style MAC; if SSH/80/443 open + TTL≈64 it's a router
  if ((scores['Android Phone'] ?? 0) > 0 && portSet.has(22) && portSet.has(80) && ttl && ttl <= 70) {
    delete scores['Android Phone']
    add('Router/Gateway', 5)
  }

  if (Object.keys(scores).length === 0) return 'Unknown Device'
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0]
}

// ── Job store ─────────────────────────────────────────────────────────────────

export interface OpenPort  { port: number; service: string; banner: string | null; risk: string }
export interface ScanHost  {
  ip: string; hostname: string | null; latency_ms: number | null
  os_hint: string | null; ttl: number | null
  mac_address: string | null; mac_vendor: string | null
  open_ports: OpenPort[]; status: 'pinging' | 'scanning' | 'done' | 'unreachable'
}

interface ScanJob {
  id: string; target: string
  mode: 'quick' | 'standard' | 'deep' | 'custom'
  port_range?: [number, number]
  status: 'running' | 'complete' | 'cancelled' | 'error'
  started_at: Date; completed_at?: Date
  hosts: Map<string, ScanHost>
  total_ips: number; scanned_ips: number
  error?: string
  subscribers: Set<(msg: string) => void>
}

const jobs = new Map<string, ScanJob>()

function cleanJobs() {
  const cutoff = Date.now() - 7200000 // 2h
  for (const [id, job] of jobs)
    if (job.started_at.getTime() < cutoff) jobs.delete(id)
}

function emit(job: ScanJob, event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const s of job.subscribers) { try { s(msg) } catch {} }
}

// ── Scan runner ───────────────────────────────────────────────────────────────

async function runScan(job: ScanJob) {
  let ips: string[]
  try {
    ips = parseTargets(job.target)
    job.total_ips = ips.length
    emit(job, 'start', { total: ips.length, mode: job.mode })
  } catch (e: any) {
    job.status = 'error'; job.error = e.message
    emit(job, 'error', { message: e.message }); return
  }

  // Port list
  let ports: number[]
  if (job.mode === 'quick')    ports = QUICK_PORTS
  else if (job.mode === 'standard') ports = STANDARD_PORTS
  else if (job.mode === 'custom' && job.port_range) {
    const [f, t] = job.port_range
    ports = Array.from({ length: t - f + 1 }, (_, i) => f + i)
  } else {
    // deep: 1–65535
    ports = Array.from({ length: 65535 }, (_, i) => i + 1)
  }

  // Warm ARP cache and reset per-scan table before ping sweep
  arpTableCache = new Map()
  warmArpCache().catch(() => {}) // fire-and-forget — populates cache while ping sweep runs

  // ── Phase 1: ping sweep ──────────────────────────────────────────────────────
  const pingSem = new Semaphore(50)
  const aliveHosts: string[] = []

  await Promise.all(ips.map(async ip => {
    if (job.status === 'cancelled') return
    await pingSem.acquire()
    try {
      const r = await pingHost(ip)
      job.scanned_ips++
      emit(job, 'ping', { ip, alive: r.alive, scanned: job.scanned_ips, total: job.total_ips })
      if (r.alive) {
        aliveHosts.push(ip)
        const host: ScanHost = {
          ip, hostname: null, latency_ms: r.latency_ms,
          os_hint: osFromTtl(r.ttl), ttl: r.ttl,
          mac_address: null, mac_vendor: null,
          open_ports: [], status: 'scanning',
        }
        job.hosts.set(ip, host)
        emit(job, 'host_alive', { ip, latency_ms: r.latency_ms, os_hint: host.os_hint })
      }
    } finally { pingSem.release() }
  }))

  if (job.status === 'cancelled') { emit(job, 'cancelled', {}); return }

  // Pre-load OUI database (downloads once, then cached in memory + disk)
  const ouiMap = await loadOuiDb()

  // ── Phase 2: port scan + DNS + banners ───────────────────────────────────────
  const portTimeout = job.mode === 'deep' ? 500 : 800
  const portConcur  = job.mode === 'deep' ? 300 : 150
  const grabBanners = job.mode !== 'quick'
  const portSem     = new Semaphore(portConcur)

  await Promise.all(aliveHosts.map(async ip => {
    if (job.status === 'cancelled') return
    const host = job.hosts.get(ip)!

    // MAC + vendor + randomization check — check warm ARP table first, then active probe
    const mac = arpTableCache.get(ip) ?? await getMacAddress(ip)
    const macRandomized = mac ? isMacRandomized(mac) : false
    if (mac && !macRandomized) {
      host.mac_address = mac
      host.mac_vendor = getMacVendor(mac, ouiMap)
    } else if (macRandomized) {
      host.mac_address = mac
      host.mac_vendor = 'randomized (privacy MAC)'
    }

    // Hostname: NetBIOS → mDNS → LLMNR → reverse DNS
    const [nbName, mdnsName, llmnrName] = await Promise.all([
      getNetBiosName(ip),
      getMdnsName(ip),
      getLlmnrName(ip),
    ])
    host.hostname = nbName ?? mdnsName ?? llmnrName ?? null
    if (!host.hostname) {
      try { const n = await dns.reverse(ip); host.hostname = n[0] ?? null } catch {}
    }

    // Port scan — collect all banners keyed by port for classification
    const banners: Record<number, string | null> = {}
    await Promise.all(ports.map(async port => {
      if (job.status === 'cancelled') return
      await portSem.acquire()
      try {
        const open = await scanPort(ip, port, portTimeout)
        if (open) {
          let banner: string | null = null
          if (grabBanners) banner = await grabBanner(ip, port, 2000)
          banners[port] = banner

          const entry: OpenPort = {
            port, service: SERVICE_MAP[port] ?? 'unknown',
            banner, risk: PORT_RISK[port] ?? 'low',
          }
          host.open_ports.push(entry)
          emit(job, 'port_open', { ip, port, service: entry.service, banner, risk: entry.risk })
        }
      } finally { portSem.release() }
    }))

    // Score-based device classification
    host.os_hint = classifyDevice(
      host.open_ports.map(p => p.port),
      banners,
      host.mac_vendor,
      macRandomized,
      host.ttl,
      host.hostname,
    )

    host.open_ports.sort((a, b) => a.port - b.port)
    host.status = 'done'
    emit(job, 'host_done', {
      ip, hostname: host.hostname, os_hint: host.os_hint,
      latency_ms: host.latency_ms, open_ports: host.open_ports,
      mac_address: host.mac_address, mac_vendor: host.mac_vendor,
    })
  }))

  job.status = 'complete'
  job.completed_at = new Date()
  emit(job, 'complete', { alive: aliveHosts.length, total: job.scanned_ips })
  for (const s of job.subscribers) { try { s('event: done\ndata: {}\n\n') } catch {} }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function networkScanRoutes(fastify: FastifyInstance) {

  // POST /network-scan — start a new scan
  fastify.post('/network-scan', { preHandler: requireAuth }, async (req, reply) => {
    cleanJobs()
    const body = z.object({
      target:    z.string().min(1),
      mode:      z.enum(['quick', 'standard', 'deep', 'custom']).default('standard'),
      port_from: z.number().int().min(1).max(65535).optional(),
      port_to:   z.number().int().min(1).max(65535).optional(),
    }).parse(req.body)

    if (body.mode === 'custom' && (!body.port_from || !body.port_to))
      return reply.status(400).send({ error: 'port_from and port_to required for custom mode' })

    const job: ScanJob = {
      id: crypto.randomBytes(8).toString('hex'),
      target: body.target, mode: body.mode,
      port_range: body.port_from && body.port_to ? [body.port_from, body.port_to] : undefined,
      status: 'running', started_at: new Date(),
      hosts: new Map(), total_ips: 0, scanned_ips: 0,
      subscribers: new Set(),
    }
    jobs.set(job.id, job)

    runScan(job).catch(e => {
      job.status = 'error'; job.error = e.message
      emit(job, 'error', { message: e.message })
    })

    return { jobId: job.id, target: job.target, mode: job.mode }
  })

  // GET /network-scan/:jobId/stream — SSE live feed
  fastify.get('/network-scan/:jobId/stream', { preHandler: requireAuth }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string }
    const job = jobs.get(jobId)
    if (!job) return reply.status(404).send({ error: 'Job not found' })

    reply.raw.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.hijack()

    const write = (msg: string) => { try { reply.raw.write(msg) } catch {} }

    // Replay current state for late subscribers
    for (const host of job.hosts.values()) {
      if (host.status === 'done') {
        write(`event: host_done\ndata: ${JSON.stringify({
          ip: host.ip, hostname: host.hostname, os_hint: host.os_hint,
          latency_ms: host.latency_ms, open_ports: host.open_ports,
        })}\n\n`)
      } else {
        write(`event: host_alive\ndata: ${JSON.stringify({ ip: host.ip, latency_ms: host.latency_ms, os_hint: host.os_hint })}\n\n`)
      }
    }
    write(`event: progress\ndata: ${JSON.stringify({ scanned: job.scanned_ips, total: job.total_ips })}\n\n`)

    if (job.status !== 'running') {
      write(`event: complete\ndata: ${JSON.stringify({ status: job.status, alive: job.hosts.size, total: job.scanned_ips })}\n\n`)
      reply.raw.end(); return
    }

    job.subscribers.add(write)
    req.raw.on('close', () => job.subscribers.delete(write))

    const ka = setInterval(() => { try { reply.raw.write(': ping\n\n') } catch { clearInterval(ka) } }, 15000)
    req.raw.on('close', () => clearInterval(ka))
  })

  // GET /network-scan/:jobId — snapshot of results
  fastify.get('/network-scan/:jobId', { preHandler: requireAuth }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string }
    const job = jobs.get(jobId)
    if (!job) return reply.status(404).send({ error: 'Job not found' })
    return {
      id: job.id, target: job.target, mode: job.mode,
      status: job.status, started_at: job.started_at, completed_at: job.completed_at,
      total_ips: job.total_ips, scanned_ips: job.scanned_ips,
      hosts: Array.from(job.hosts.values()),
      error: job.error,
    }
  })

  // DELETE /network-scan/:jobId — cancel
  fastify.delete('/network-scan/:jobId', { preHandler: requireAuth }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string }
    const job = jobs.get(jobId)
    if (!job) return reply.status(404).send({ error: 'Job not found' })
    job.status = 'cancelled'
    emit(job, 'cancelled', {})
    return { ok: true }
  })

  // GET /network-scan — list recent jobs
  fastify.get('/network-scan', { preHandler: requireAuth }, async () => {
    return Array.from(jobs.values())
      .map(j => ({
        id: j.id, target: j.target, mode: j.mode, status: j.status,
        started_at: j.started_at, completed_at: j.completed_at,
        alive_count: j.hosts.size, total_ips: j.total_ips, scanned_ips: j.scanned_ips,
      }))
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
      .slice(0, 20)
  })
}
