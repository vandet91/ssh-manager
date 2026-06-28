'use strict'
/**
 * Multi-device SNMP v2c agent — community string selects the simulated device.
 *
 *   public       → Cisco Catalyst 2960X-24TS-L
 *                  Full Bridge MIB, Cisco trunk OID, STP, PortFast, LLDP, 802.1X
 *
 *   aruba-public → Aruba JL726A 2930F-24G
 *                  Standard Bridge MIB, Q-BRIDGE, STP, standard PortFast, LLDP, 802.1X
 *
 * Supports GET, GETNEXT, GETBULK. Pure Node.js, no npm dependencies.
 */
const dgram = require('dgram')

// ── BER type tags ─────────────────────────────────────────────────────────────
const T = {
  INTEGER:      0x02,
  OCTET_STRING: 0x04,
  NULL:         0x05,
  OID:          0x06,
  COUNTER32:    0x41,
  GAUGE32:      0x42,
  TIMETICKS:    0x43,
  NO_SUCH_OBJ:  0x80,
  END_OF_MIB:   0x82,
}
const PDU_GET      = 0xa0
const PDU_GETNEXT  = 0xa1
const PDU_RESPONSE = 0xa2
const PDU_SET      = 0xa3
const PDU_GETBULK  = 0xa5

// ── OID comparison ────────────────────────────────────────────────────────────
function compareOid(a, b) {
  const as = a.split('.').map(Number)
  const bs = b.split('.').map(Number)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? -1) - (bs[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

// ── Multi-device OID store ────────────────────────────────────────────────────
function makeDevice(label) {
  const oids = new Map()
  let cache = null
  const dev = {
    label,
    set(oid, type, value) { oids.set(oid, { type, value }); cache = null },
    get(oid)  { return oids.get(oid) },
    next(oid) {
      if (!cache) cache = [...oids.keys()].sort(compareOid)
      for (const o of cache) if (compareOid(o, oid) > 0) return o
      return null
    },
    after(oid, n) {
      if (!cache) cache = [...oids.keys()].sort(compareOid)
      const r = []
      for (const o of cache) {
        if (compareOid(o, oid) > 0) { r.push(o); if (r.length >= n) break }
      }
      return r
    },
    get size() { return oids.size },
  }
  return dev
}
const DEVICES = new Map()

// ── BER encoding ──────────────────────────────────────────────────────────────
function encLen(n) {
  if (n < 128) return Buffer.from([n])
  const b = []; let l = n
  while (l > 0) { b.unshift(l & 0xff); l >>= 8 }
  return Buffer.from([0x80 | b.length, ...b])
}
function tlv(tag, val) {
  return Buffer.concat([Buffer.from([tag]), encLen(val.length), val])
}
function encInt(n) {
  if (n === 0) return tlv(T.INTEGER, Buffer.from([0]))
  const b = []; let v = n
  if (v < 0) {
    v = (~(-v) + 1) >>> 0
    do { b.unshift(v & 0xff); v >>>= 8 } while (v)
    if (!(b[0] & 0x80)) b.unshift(0xff)
  } else {
    do { b.unshift(v & 0xff); v >>>= 8 } while (v)
    if (b[0] & 0x80) b.unshift(0x00)
  }
  return tlv(T.INTEGER, Buffer.from(b))
}
function encUint(tag, n) {
  const b = []; let v = n >>> 0
  if (!v) b.push(0)
  while (v) { b.unshift(v & 0xff); v >>>= 8 }
  if (b[0] & 0x80) b.unshift(0x00)
  return tlv(tag, Buffer.from(b))
}
function encStr(s) {
  return tlv(T.OCTET_STRING, Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'))
}
function encOid(oidStr) {
  const p = oidStr.split('.').map(Number)
  const b = [40 * p[0] + p[1]]
  for (let i = 2; i < p.length; i++) {
    let v = p[i]; const sub = [v & 0x7f]; v >>>= 7
    while (v) { sub.unshift((v & 0x7f) | 0x80); v >>>= 7 }
    b.push(...sub)
  }
  return tlv(T.OID, Buffer.from(b))
}
function encVal(type, value) {
  if (type === T.INTEGER)      return encInt(value)
  if (type === T.OCTET_STRING) return encStr(value)
  if (type === T.OID)          return encOid(value)
  if (type === T.TIMETICKS)    return encUint(T.TIMETICKS, value)
  if (type === T.COUNTER32)    return encUint(T.COUNTER32, value)
  if (type === T.GAUGE32)      return encUint(T.GAUGE32, value)
  if (type === T.NO_SUCH_OBJ)  return Buffer.from([T.NO_SUCH_OBJ, 0x00])
  if (type === T.END_OF_MIB)   return Buffer.from([T.END_OF_MIB, 0x00])
  return tlv(type, Buffer.isBuffer(value) ? value : Buffer.from(value))
}
function encVarbind(oid, type, value) {
  return tlv(0x30, Buffer.concat([encOid(oid), encVal(type, value)]))
}

// ── BER decoding ──────────────────────────────────────────────────────────────
function decLen(buf, i) {
  const b = buf[i]
  if (b < 128) return { len: b, skip: 1 }
  const n = b & 0x7f; let len = 0
  for (let j = 0; j < n; j++) len = (len << 8) | buf[i + 1 + j]
  return { len, skip: 1 + n }
}
function decOid(buf, i, len) {
  const p = [Math.floor(buf[i] / 40), buf[i] % 40]; let j = i + 1
  while (j < i + len) {
    let v = 0
    while (j < i + len) { const b = buf[j++]; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) break }
    p.push(v)
  }
  return p.join('.')
}
function parseMsg(buf) {
  let i = 1
  const { len: ml, skip: ms } = decLen(buf, i); i += ms
  i++; const { len: vl, skip: vs } = decLen(buf, i); i += vs
  const version = buf[i]; i += vl
  i++; const { len: cl, skip: cs } = decLen(buf, i); i += cs
  const community = buf.subarray(i, i + cl).toString(); i += cl
  const pduType = buf[i++]
  const { len: pl, skip: ps } = decLen(buf, i); i += ps
  i++; const { len: rl, skip: rs } = decLen(buf, i); i += rs
  let reqId = 0
  for (let j = 0; j < rl; j++) reqId = (reqId * 256) + buf[i + j]
  if (reqId > 0x7fffffff) reqId -= 0x100000000
  i += rl
  i++; const { len: el, skip: es } = decLen(buf, i); i += es
  let nonRepeaters = 0
  for (let j = 0; j < el; j++) nonRepeaters = (nonRepeaters << 8) | buf[i + j]
  i += el
  i++; const { len: xl, skip: xs } = decLen(buf, i); i += xs
  let maxRepetitions = 10
  for (let j = 0; j < xl; j++) maxRepetitions = (maxRepetitions << 8) | buf[i + j]
  i += xl
  i++; const { len: vll, skip: vls } = decLen(buf, i); i += vls
  const varbinds = []
  while (i < buf.length && varbinds.length < 64) {
    if (buf[i] !== 0x30) break
    i++
    const { len: vblen, skip: vbs } = decLen(buf, i); i += vbs
    const vbEnd = i + vblen
    i++
    const { len: ol, skip: os } = decLen(buf, i); i += os
    const oid = decOid(buf, i, ol); i += ol
    let val = null
    if (i < vbEnd) {
      const vtype = buf[i++]
      const { len: vl2, skip: vs2 } = decLen(buf, i); i += vs2
      if (vtype === T.INTEGER || vtype === T.COUNTER32 || vtype === T.GAUGE32 || vtype === T.TIMETICKS) {
        let n = 0; for (let j = 0; j < vl2; j++) n = (n << 8) | buf[i + j]
        val = { type: vtype, value: n }
      } else if (vtype === T.OCTET_STRING) {
        val = { type: vtype, value: buf.subarray(i, i + vl2) }
      }
    }
    varbinds.push({ oid, val })
    i = vbEnd
  }
  return { version, community, pduType, reqId, nonRepeaters, maxRepetitions, varbinds }
}
function buildResponse(reqId, community, varbinds) {
  const vbBuf = Buffer.concat(varbinds.map(([o, t, v]) => encVarbind(o, t, v)))
  const pduBody = Buffer.concat([encInt(reqId), encInt(0), encInt(0), tlv(0x30, vbBuf)])
  return tlv(0x30, Buffer.concat([encInt(1), encStr(community), tlv(PDU_RESPONSE, pduBody)]))
}

// ── Request handler ───────────────────────────────────────────────────────────
function handle(buf) {
  let req
  try { req = parseMsg(buf) } catch { return null }
  const dev = DEVICES.get(req.community)
  if (!dev) return null

  const out = []
  if (req.pduType === PDU_GET) {
    for (const { oid } of req.varbinds) {
      const e = dev.get(oid)
      out.push(e ? [oid, e.type, e.value] : [oid, T.NO_SUCH_OBJ, null])
    }
  } else if (req.pduType === PDU_GETNEXT) {
    for (const { oid } of req.varbinds) {
      const n = dev.next(oid)
      if (n) { const e = dev.get(n); out.push([n, e.type, e.value]) }
      else out.push([oid, T.END_OF_MIB, null])
    }
  } else if (req.pduType === PDU_SET) {
    for (const { oid } of req.varbinds) {
      const e = dev.get(oid)
      out.push(e ? [oid, e.type, e.value] : [oid, T.NO_SUCH_OBJ, null])
    }
  } else if (req.pduType === PDU_GETBULK) {
    const rep = Math.max(1, req.maxRepetitions || 10)
    for (let i = 0; i < Math.min(req.nonRepeaters, req.varbinds.length); i++) {
      const n = dev.next(req.varbinds[i].oid)
      if (n) { const e = dev.get(n); out.push([n, e.type, e.value]) }
      else out.push([req.varbinds[i].oid, T.END_OF_MIB, null])
    }
    for (let i = req.nonRepeaters; i < req.varbinds.length; i++) {
      const nexts = dev.after(req.varbinds[i].oid, rep)
      if (nexts.length === 0) { out.push([req.varbinds[i].oid, T.END_OF_MIB, null]); continue }
      for (const n of nexts) { const e = dev.get(n); out.push([n, e.type, e.value]) }
    }
  } else {
    return null
  }
  return buildResponse(req.reqId, req.community, out)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Build egress bitmask: ports[] (1-based) → Buffer of byteCount bytes
function portMask(ports, byteCount = 4) {
  const buf = Buffer.alloc(byteCount, 0)
  for (const p of ports) {
    const b = Math.floor((p - 1) / 8)
    const bit = (p - 1) % 8
    if (b < byteCount) buf[b] |= (0x80 >> bit)
  }
  return buf
}
// STP state: 1=disabled, 2=blocking, 5=forwarding
function stpSt(adminUp, operUp) { return !adminUp ? 1 : !operUp ? 2 : 5 }
// MAC buffer from low byte
function mac(prefix, low) { return Buffer.from([...prefix, low]) }

// ═════════════════════════════════════════════════════════════════════════════
// DEVICE 1: Cisco Catalyst 2960X-24TS-L  (community: public)
// ═════════════════════════════════════════════════════════════════════════════
const cisco = makeDevice('Cisco Catalyst 2960X-24TS-L')
DEVICES.set('public', cisco)

const S = cisco.set.bind(cisco)

// System MIB
S('1.3.6.1.2.1.1.1.0', T.OCTET_STRING, 'Cisco IOS Software, Version 15.2(7)E5, RELEASE SOFTWARE\nCisco Catalyst 2960X-24TS-L')
S('1.3.6.1.2.1.1.2.0', T.OID,          '1.3.6.1.4.1.9.1.1045')
S('1.3.6.1.2.1.1.3.0', T.TIMETICKS,    123456789)
S('1.3.6.1.2.1.1.4.0', T.OCTET_STRING, 'admin@company.local')
S('1.3.6.1.2.1.1.5.0', T.OCTET_STRING, 'CORE-SW-01')
S('1.3.6.1.2.1.1.6.0', T.OCTET_STRING, 'Server Room Rack-A1')
S('1.3.6.1.2.1.2.1.0', T.INTEGER,      26)

// Entity MIB
S('1.3.6.1.2.1.47.1.1.1.1.2.1',  T.OCTET_STRING, 'Cisco Catalyst 2960X-24TS-L Ethernet Switch')
S('1.3.6.1.2.1.47.1.1.1.1.7.1',  T.OCTET_STRING, 'WS-C2960X-24TS-L')
S('1.3.6.1.2.1.47.1.1.1.1.10.1', T.OCTET_STRING, '15.2(7)E5')
S('1.3.6.1.2.1.47.1.1.1.1.11.1', T.OCTET_STRING, 'FCW2345A001')
S('1.3.6.1.2.1.47.1.1.1.1.12.1', T.OCTET_STRING, 'Cisco Systems, Inc.')

// Ports: {n, name, descr, alias, macLow, adminUp, operUp, speedMbps, pvid, trunk, portFast, dot1x}
// dot1x: 2=auto (802.1X enabled), 3=forceAuth (no auth)
const CISCO_PORTS = [
  { n:1,  name:'Gi0/1',  descr:'GigabitEthernet0/1',  alias:'SRV-WEB-01',    m:0x01, a:1, o:1, s:1000, v:10, t:0, pf:1, x:3 },
  { n:2,  name:'Gi0/2',  descr:'GigabitEthernet0/2',  alias:'SRV-WEB-02',    m:0x02, a:1, o:1, s:1000, v:10, t:0, pf:1, x:3 },
  { n:3,  name:'Gi0/3',  descr:'GigabitEthernet0/3',  alias:'SRV-DB-01',     m:0x03, a:1, o:1, s:1000, v:20, t:0, pf:1, x:3 },
  { n:4,  name:'Gi0/4',  descr:'GigabitEthernet0/4',  alias:'SRV-DB-02',     m:0x04, a:1, o:1, s:1000, v:20, t:0, pf:1, x:3 },
  { n:5,  name:'Gi0/5',  descr:'GigabitEthernet0/5',  alias:'SRV-APP-01',    m:0x05, a:1, o:1, s:1000, v:10, t:0, pf:1, x:3 },
  { n:6,  name:'Gi0/6',  descr:'GigabitEthernet0/6',  alias:'SRV-APP-02',    m:0x06, a:1, o:0, s:1000, v:10, t:0, pf:1, x:3 },
  { n:7,  name:'Gi0/7',  descr:'GigabitEthernet0/7',  alias:'SRV-MON-01',    m:0x07, a:1, o:1, s:1000, v:30, t:0, pf:1, x:3 },
  { n:8,  name:'Gi0/8',  descr:'GigabitEthernet0/8',  alias:'SRV-BKP-01',    m:0x08, a:1, o:1, s:1000, v:40, t:0, pf:1, x:3 },
  { n:9,  name:'Gi0/9',  descr:'GigabitEthernet0/9',  alias:'PC-ADMIN-01',   m:0x09, a:1, o:1, s:100,  v:1,  t:0, pf:1, x:2 },
  { n:10, name:'Gi0/10', descr:'GigabitEthernet0/10', alias:'PC-ADMIN-02',   m:0x0a, a:1, o:1, s:100,  v:1,  t:0, pf:1, x:2 },
  { n:11, name:'Gi0/11', descr:'GigabitEthernet0/11', alias:'PC-DEV-01',     m:0x0b, a:1, o:1, s:1000, v:1,  t:0, pf:1, x:2 },
  { n:12, name:'Gi0/12', descr:'GigabitEthernet0/12', alias:'PC-DEV-02',     m:0x0c, a:1, o:0, s:1000, v:1,  t:0, pf:1, x:2 },
  { n:13, name:'Gi0/13', descr:'GigabitEthernet0/13', alias:'PRINTER-01',    m:0x0d, a:1, o:1, s:100,  v:1,  t:0, pf:1, x:2 },
  { n:14, name:'Gi0/14', descr:'GigabitEthernet0/14', alias:'IP-PHONE-01',   m:0x0e, a:1, o:1, s:100,  v:50, t:0, pf:1, x:3 },
  { n:15, name:'Gi0/15', descr:'GigabitEthernet0/15', alias:'IP-PHONE-02',   m:0x0f, a:1, o:1, s:100,  v:50, t:0, pf:1, x:3 },
  { n:16, name:'Gi0/16', descr:'GigabitEthernet0/16', alias:'',              m:0x10, a:1, o:0, s:0,    v:1,  t:0, pf:1, x:3 },
  { n:17, name:'Gi0/17', descr:'GigabitEthernet0/17', alias:'',              m:0x11, a:0, o:0, s:0,    v:1,  t:0, pf:1, x:3 },
  { n:18, name:'Gi0/18', descr:'GigabitEthernet0/18', alias:'',              m:0x12, a:0, o:0, s:0,    v:1,  t:0, pf:1, x:3 },
  { n:19, name:'Gi0/19', descr:'GigabitEthernet0/19', alias:'CCTV-CAM-01',   m:0x13, a:1, o:1, s:100,  v:60, t:0, pf:1, x:3 },
  { n:20, name:'Gi0/20', descr:'GigabitEthernet0/20', alias:'CCTV-CAM-02',   m:0x14, a:1, o:1, s:100,  v:60, t:0, pf:1, x:3 },
  { n:21, name:'Gi0/21', descr:'GigabitEthernet0/21', alias:'TRUNK-AP-01',   m:0x15, a:1, o:1, s:1000, v:1,  t:1, pf:0, x:3 },
  { n:22, name:'Gi0/22', descr:'GigabitEthernet0/22', alias:'TRUNK-AP-02',   m:0x16, a:1, o:0, s:1000, v:1,  t:1, pf:0, x:3 },
  { n:23, name:'Gi0/23', descr:'GigabitEthernet0/23', alias:'',              m:0x17, a:0, o:0, s:0,    v:1,  t:0, pf:1, x:3 },
  { n:24, name:'Gi0/24', descr:'GigabitEthernet0/24', alias:'',              m:0x18, a:0, o:0, s:0,    v:1,  t:0, pf:1, x:3 },
  { n:25, name:'Gi0/25', descr:'GigabitEthernet0/25', alias:'UPLINK-ROUTER', m:0x19, a:1, o:1, s:1000, v:1,  t:1, pf:0, x:3 },
  { n:26, name:'Gi0/26', descr:'GigabitEthernet0/26', alias:'UPLINK-BACKUP', m:0x1a, a:1, o:0, s:1000, v:1,  t:1, pf:0, x:3 },
]

const CISCO_MAC_PFX = [0xAA, 0xBB, 0xCC, 0x00, 0x01]
for (const p of CISCO_PORTS) {
  const i = p.n
  const macBuf = mac(CISCO_MAC_PFX, p.m)
  // IF-MIB
  S(`1.3.6.1.2.1.2.2.1.2.${i}`,     T.OCTET_STRING, p.descr)
  S(`1.3.6.1.2.1.2.2.1.5.${i}`,     T.GAUGE32,      p.s * 1_000_000)
  S(`1.3.6.1.2.1.2.2.1.6.${i}`,     T.OCTET_STRING, macBuf)
  S(`1.3.6.1.2.1.2.2.1.7.${i}`,     T.INTEGER,      p.a ? 1 : 2)
  S(`1.3.6.1.2.1.2.2.1.8.${i}`,     T.INTEGER,      p.o ? 1 : 2)
  S(`1.3.6.1.2.1.31.1.1.1.1.${i}`,  T.OCTET_STRING, p.name)
  S(`1.3.6.1.2.1.31.1.1.1.15.${i}`, T.GAUGE32,      p.s)
  S(`1.3.6.1.2.1.31.1.1.1.18.${i}`, T.OCTET_STRING, p.alias)
  // Bridge MIB: bridge port i → ifIndex i (1:1 on Catalyst 2960X)
  S(`1.3.6.1.2.1.17.1.4.1.2.${i}`,  T.INTEGER,      i)
  // Q-BRIDGE: native VLAN per bridge port
  S(`1.3.6.1.2.1.17.7.1.4.5.1.1.${i}`, T.GAUGE32,   p.v)
  // STP: dot1dStpPortState per bridge port
  S(`1.3.6.1.2.1.17.2.15.1.3.${i}`, T.INTEGER,      stpSt(p.a, p.o))
  // Cisco PortFast: stpxFastStartPortEnable (1=enable, 2=disable) keyed by ifIndex
  S(`1.3.6.1.4.1.9.9.82.1.9.3.1.3.${i}`, T.INTEGER, p.pf ? 1 : 2)
  // Cisco trunk mode: vlanTrunkPortDynamicStatus (1=trunking, 2=notTrunking) keyed by ifIndex
  S(`1.3.6.1.4.1.9.9.46.1.6.1.1.14.${i}`, T.INTEGER, p.t ? 1 : 2)
  // 802.1X: dot1xPaePortAdminControl (2=auto, 3=forceAuth) keyed by ifIndex
  S(`1.0.8802.1.1.1.1.2.1.1.6.${i}`, T.INTEGER,     p.x)
}

// Q-BRIDGE: VLAN names
const CISCO_VLANS = { 1:'Management', 10:'Servers-Web', 20:'Servers-DB', 30:'Monitoring', 40:'Backup', 50:'VoIP', 60:'CCTV' }
for (const [id, name] of Object.entries(CISCO_VLANS)) {
  S(`1.3.6.1.2.1.17.7.1.4.3.1.1.${id}`, T.OCTET_STRING, name)
}

// Q-BRIDGE: egress bitmask per VLAN (4 bytes covers 32 ports)
// Trunk ports 21, 22, 25, 26 appear in ALL VLANs
const CISCO_EGRESS = {
  1:  portMask([9,10,11,12,13,16,17,18,21,22,23,24,25,26]),
  10: portMask([1,2,5,6,21,22,25,26]),
  20: portMask([3,4,21,22,25,26]),
  30: portMask([7,21,22,25,26]),
  40: portMask([8,21,22,25,26]),
  50: portMask([14,15,21,22,25,26]),
  60: portMask([19,20,21,22,25,26]),
}
for (const [vlan, mask] of Object.entries(CISCO_EGRESS)) {
  S(`1.3.6.1.2.1.17.7.1.4.3.1.2.${vlan}`, T.OCTET_STRING, mask)
}

// LLDP: local port num → ifIndex (lldpLocPortIfIndex)
S('1.0.8802.1.1.2.1.3.7.1.3.21', T.INTEGER, 21)
S('1.0.8802.1.1.2.1.3.7.1.3.25', T.INTEGER, 25)

// LLDP: remote neighbors  (OID suffix: .{localPortNum}.{remoteIdx})
// Port 21 → UniFi AP AC Pro
S('1.0.8802.1.1.2.1.4.1.1.5.21.1',  T.OCTET_STRING, Buffer.from([0x80, 0x2A, 0xA8, 0x12, 0x34, 0x56]))
S('1.0.8802.1.1.2.1.4.1.1.7.21.1',  T.OCTET_STRING, 'eth0')
S('1.0.8802.1.1.2.1.4.1.1.9.21.1',  T.OCTET_STRING, 'UNIFI-AP-LOBBY')
S('1.0.8802.1.1.2.1.4.1.1.10.21.1', T.OCTET_STRING, 'UniFi AP AC Pro')
// Port 25 → Core Router (Cisco ISR 4321)
S('1.0.8802.1.1.2.1.4.1.1.5.25.1',  T.OCTET_STRING, Buffer.from([0xA0, 0xEC, 0xF9, 0x10, 0x20, 0x30]))
S('1.0.8802.1.1.2.1.4.1.1.7.25.1',  T.OCTET_STRING, 'GigabitEthernet0/0/1')
S('1.0.8802.1.1.2.1.4.1.1.9.25.1',  T.OCTET_STRING, 'CORE-ROUTER-01')
S('1.0.8802.1.1.2.1.4.1.1.10.25.1', T.OCTET_STRING, 'Cisco IOS XE Software, Version 16.09.06')

// ═════════════════════════════════════════════════════════════════════════════
// DEVICE 2: Aruba JL726A 2930F-24G  (community: aruba-public)
// ═════════════════════════════════════════════════════════════════════════════
const aruba = makeDevice('Aruba 2930F-24G')
DEVICES.set('aruba-public', aruba)

const A = aruba.set.bind(aruba)

// System MIB
A('1.3.6.1.2.1.1.1.0', T.OCTET_STRING, 'Aruba JL726A 2930F-24G 4SFP+ Switch, revision WC.16.10.0021, ROM WC.17.01.0002')
A('1.3.6.1.2.1.1.2.0', T.OID,          '1.3.6.1.4.1.11.2.3.7.11.185')
A('1.3.6.1.2.1.1.3.0', T.TIMETICKS,    98765432)
A('1.3.6.1.2.1.1.4.0', T.OCTET_STRING, 'netops@company.local')
A('1.3.6.1.2.1.1.5.0', T.OCTET_STRING, 'DIST-SW-01')
A('1.3.6.1.2.1.1.6.0', T.OCTET_STRING, 'Network Closet Floor-2')
A('1.3.6.1.2.1.2.1.0', T.INTEGER,      28)

// Entity MIB
A('1.3.6.1.2.1.47.1.1.1.1.2.1',  T.OCTET_STRING, 'Aruba 2930F-24G 4SFP+')
A('1.3.6.1.2.1.47.1.1.1.1.7.1',  T.OCTET_STRING, 'JL726A')
A('1.3.6.1.2.1.47.1.1.1.1.10.1', T.OCTET_STRING, 'WC.16.10.0021')
A('1.3.6.1.2.1.47.1.1.1.1.11.1', T.OCTET_STRING, 'SG78KP2003')
A('1.3.6.1.2.1.47.1.1.1.1.12.1', T.OCTET_STRING, 'Aruba Networks, Inc.')

// Ports: 24 x 1G access + 4 x SFP uplinks (28 total)
const ARUBA_PORTS = [
  // Users – VLAN 10
  { n:1,  name:'1',  descr:'Port 1',  alias:'PC-01',        m:0x01, a:1, o:1, s:1000, v:10, t:0, pf:1, x:2 },
  { n:2,  name:'2',  descr:'Port 2',  alias:'PC-02',        m:0x02, a:1, o:1, s:1000, v:10, t:0, pf:1, x:2 },
  { n:3,  name:'3',  descr:'Port 3',  alias:'PC-03',        m:0x03, a:1, o:0, s:1000, v:10, t:0, pf:1, x:2 },
  { n:4,  name:'4',  descr:'Port 4',  alias:'',             m:0x04, a:0, o:0, s:0,    v:10, t:0, pf:0, x:2 },
  { n:5,  name:'5',  descr:'Port 5',  alias:'PC-05',        m:0x05, a:1, o:1, s:1000, v:10, t:0, pf:1, x:2 },
  { n:6,  name:'6',  descr:'Port 6',  alias:'PC-06',        m:0x06, a:1, o:1, s:1000, v:10, t:0, pf:1, x:2 },
  // Servers – VLAN 20
  { n:7,  name:'7',  descr:'Port 7',  alias:'SRV-01',       m:0x07, a:1, o:1, s:1000, v:20, t:0, pf:0, x:3 },
  { n:8,  name:'8',  descr:'Port 8',  alias:'SRV-02',       m:0x08, a:1, o:1, s:1000, v:20, t:0, pf:0, x:3 },
  { n:9,  name:'9',  descr:'Port 9',  alias:'SRV-03',       m:0x09, a:1, o:1, s:1000, v:20, t:0, pf:0, x:3 },
  // Voice – VLAN 30
  { n:10, name:'10', descr:'Port 10', alias:'PHONE-01',     m:0x0a, a:1, o:1, s:100,  v:30, t:0, pf:1, x:3 },
  { n:11, name:'11', descr:'Port 11', alias:'PHONE-02',     m:0x0b, a:1, o:1, s:100,  v:30, t:0, pf:1, x:3 },
  { n:12, name:'12', descr:'Port 12', alias:'PHONE-03',     m:0x0c, a:1, o:0, s:100,  v:30, t:0, pf:1, x:3 },
  // Security cameras – VLAN 40
  { n:13, name:'13', descr:'Port 13', alias:'CAM-01',       m:0x0d, a:1, o:1, s:100,  v:40, t:0, pf:1, x:3 },
  { n:14, name:'14', descr:'Port 14', alias:'CAM-02',       m:0x0e, a:1, o:1, s:100,  v:40, t:0, pf:1, x:3 },
  { n:15, name:'15', descr:'Port 15', alias:'CAM-03',       m:0x0f, a:1, o:1, s:100,  v:40, t:0, pf:1, x:3 },
  // Empty / unused
  { n:16, name:'16', descr:'Port 16', alias:'',             m:0x10, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
  { n:17, name:'17', descr:'Port 17', alias:'',             m:0x11, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
  { n:18, name:'18', descr:'Port 18', alias:'',             m:0x12, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
  { n:19, name:'19', descr:'Port 19', alias:'',             m:0x13, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
  { n:20, name:'20', descr:'Port 20', alias:'',             m:0x14, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
  // Trunk to downstream access switch
  { n:21, name:'21', descr:'Port 21', alias:'TRUNK-SW-B1',  m:0x15, a:1, o:1, s:1000, v:1,  t:1, pf:0, x:3 },
  // Trunk to AP controller
  { n:22, name:'22', descr:'Port 22', alias:'TRUNK-AP-01',  m:0x16, a:1, o:1, s:1000, v:1,  t:1, pf:0, x:3 },
  // Mgmt-only access
  { n:23, name:'23', descr:'Port 23', alias:'MGMT-CONSOLE',  m:0x17, a:1, o:0, s:1000, v:1, t:0, pf:0, x:3 },
  { n:24, name:'24', descr:'Port 24', alias:'',             m:0x18, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
  // SFP uplinks – trunk to core
  { n:25, name:'25', descr:'Port 25', alias:'UPLINK-CORE',  m:0x19, a:1, o:1, s:1000, v:1,  t:1, pf:0, x:3 },
  { n:26, name:'26', descr:'Port 26', alias:'UPLINK-BKUP',  m:0x1a, a:1, o:0, s:1000, v:1,  t:1, pf:0, x:3 },
  { n:27, name:'27', descr:'Port 27', alias:'',             m:0x1b, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
  { n:28, name:'28', descr:'Port 28', alias:'',             m:0x1c, a:0, o:0, s:0,    v:1,  t:0, pf:0, x:3 },
]

const ARUBA_MAC_PFX = [0xCC, 0xDD, 0xEE, 0x00, 0x02]
for (const p of ARUBA_PORTS) {
  const i = p.n
  const macBuf = mac(ARUBA_MAC_PFX, p.m)
  // IF-MIB
  A(`1.3.6.1.2.1.2.2.1.2.${i}`,     T.OCTET_STRING, p.descr)
  A(`1.3.6.1.2.1.2.2.1.5.${i}`,     T.GAUGE32,      p.s * 1_000_000)
  A(`1.3.6.1.2.1.2.2.1.6.${i}`,     T.OCTET_STRING, macBuf)
  A(`1.3.6.1.2.1.2.2.1.7.${i}`,     T.INTEGER,      p.a ? 1 : 2)
  A(`1.3.6.1.2.1.2.2.1.8.${i}`,     T.INTEGER,      p.o ? 1 : 2)
  A(`1.3.6.1.2.1.31.1.1.1.1.${i}`,  T.OCTET_STRING, p.name)
  A(`1.3.6.1.2.1.31.1.1.1.15.${i}`, T.GAUGE32,      p.s)
  A(`1.3.6.1.2.1.31.1.1.1.18.${i}`, T.OCTET_STRING, p.alias)
  // Bridge MIB: dot1dBasePortIfIndex — bridge port i → ifIndex i
  A(`1.3.6.1.2.1.17.1.4.1.2.${i}`,  T.INTEGER,      i)
  // Q-BRIDGE: native VLAN per bridge port
  A(`1.3.6.1.2.1.17.7.1.4.5.1.1.${i}`, T.GAUGE32,   p.v)
  // STP: dot1dStpPortState per bridge port
  A(`1.3.6.1.2.1.17.2.15.1.3.${i}`, T.INTEGER,      stpSt(p.a, p.o))
  // Standard PortFast: dot1dStpPortFastEnabled (1=enable, 2=disable) per bridge port
  A(`1.3.6.1.2.1.17.2.19.1.2.${i}`, T.INTEGER,      p.pf ? 1 : 2)
  // 802.1X: dot1xPaePortAdminControl
  A(`1.0.8802.1.1.1.1.2.1.1.6.${i}`, T.INTEGER,     p.x)
}

// Q-BRIDGE: VLAN names
const ARUBA_VLANS = { 1:'Management', 10:'Users', 20:'Servers', 30:'Voice', 40:'Security-Cams' }
for (const [id, name] of Object.entries(ARUBA_VLANS)) {
  A(`1.3.6.1.2.1.17.7.1.4.3.1.1.${id}`, T.OCTET_STRING, name)
}

// Q-BRIDGE: egress bitmask per VLAN (4 bytes)
// Trunk ports 21, 22, 25, 26 appear in ALL VLANs
const ARUBA_EGRESS = {
  1:  portMask([21,22,23,25,26]),
  10: portMask([1,2,3,4,5,6,21,22,25,26]),
  20: portMask([7,8,9,21,22,25,26]),
  30: portMask([10,11,12,21,22,25,26]),
  40: portMask([13,14,15,21,22,25,26]),
}
for (const [vlan, mask] of Object.entries(ARUBA_EGRESS)) {
  A(`1.3.6.1.2.1.17.7.1.4.3.1.2.${vlan}`, T.OCTET_STRING, mask)
}

// LLDP: local port num → ifIndex
A('1.0.8802.1.1.2.1.3.7.1.3.21', T.INTEGER, 21)
A('1.0.8802.1.1.2.1.3.7.1.3.22', T.INTEGER, 22)
A('1.0.8802.1.1.2.1.3.7.1.3.25', T.INTEGER, 25)

// LLDP: remote neighbors
// Port 21 → downstream Aruba 1930 access switch
A('1.0.8802.1.1.2.1.4.1.1.5.21.1',  T.OCTET_STRING, Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x21]))
A('1.0.8802.1.1.2.1.4.1.1.7.21.1',  T.OCTET_STRING, '1')
A('1.0.8802.1.1.2.1.4.1.1.9.21.1',  T.OCTET_STRING, 'BLDG-B-SW01')
A('1.0.8802.1.1.2.1.4.1.1.10.21.1', T.OCTET_STRING, 'Aruba JL683A 1930 24G 4SFP+, revision WC.16.10.0021')
// Port 22 → UniFi AP
A('1.0.8802.1.1.2.1.4.1.1.5.22.1',  T.OCTET_STRING, Buffer.from([0x80, 0x2A, 0xA8, 0x55, 0x66, 0x77]))
A('1.0.8802.1.1.2.1.4.1.1.7.22.1',  T.OCTET_STRING, 'eth0')
A('1.0.8802.1.1.2.1.4.1.1.9.22.1',  T.OCTET_STRING, 'WIFI-AP-FLOOR2')
A('1.0.8802.1.1.2.1.4.1.1.10.22.1', T.OCTET_STRING, 'UniFi AP AC Lite')
// Port 25 → Core Cisco switch
A('1.0.8802.1.1.2.1.4.1.1.5.25.1',  T.OCTET_STRING, Buffer.from([0xA0, 0xEC, 0xF9, 0x10, 0x20, 0x30]))
A('1.0.8802.1.1.2.1.4.1.1.7.25.1',  T.OCTET_STRING, 'GigabitEthernet1/0/10')
A('1.0.8802.1.1.2.1.4.1.1.9.25.1',  T.OCTET_STRING, 'CORE-SW-9300')
A('1.0.8802.1.1.2.1.4.1.1.10.25.1', T.OCTET_STRING, 'Cisco IOS XE Software, Version 17.06.01')

// ═════════════════════════════════════════════════════════════════════════════
// UDP server
// ═════════════════════════════════════════════════════════════════════════════
const server = dgram.createSocket('udp4')

server.on('message', (msg, rinfo) => {
  try {
    const resp = handle(msg)
    if (resp) server.send(resp, rinfo.port, rinfo.address)
  } catch {}
})

server.on('error', (err) => { console.error('SNMP-sim error:', err.message) })

server.bind(161, '0.0.0.0', () => {
  console.log('SNMP simulator ready on UDP :161')
  for (const [community, dev] of DEVICES) {
    const ports = community === 'public' ? CISCO_PORTS : ARUBA_PORTS
    console.log(`  [${community}] ${dev.label}`)
    console.log(`    Ports: ${ports.length} (${ports.filter(p=>p.o).length} up, ${ports.filter(p=>!p.o).length} down)`)
    console.log(`    OIDs:  ${dev.size}`)
  }
})
