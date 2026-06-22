'use strict'
/**
 * Minimal SNMP v2c agent — simulates a 24-port managed Cisco Catalyst switch.
 * Supports GET, GETNEXT, GETBULK (community "public" only).
 * Pure Node.js, no npm dependencies.
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

// ── OID database ──────────────────────────────────────────────────────────────
const oidMap = new Map()   // oid_string -> { type, value }

function set(oid, type, value) {
  oidMap.set(oid, { type, value })
}

function compareOid(a, b) {
  const as = a.split('.').map(Number)
  const bs = b.split('.').map(Number)
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? -1) - (bs[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

let sortedCache = null
function sorted() {
  if (!sortedCache) sortedCache = [...oidMap.keys()].sort(compareOid)
  return sortedCache
}

function nextOid(oid) {
  const s = sorted()
  for (const o of s) if (compareOid(o, oid) > 0) return o
  return null
}

function oidsAfter(oid, count) {
  const result = []
  for (const o of sorted()) {
    if (compareOid(o, oid) > 0) {
      result.push(o)
      if (result.length >= count) break
    }
  }
  return result
}

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
  const b = []
  let v = n
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
  let i = 1  // skip outer SEQUENCE tag
  const { len: ml, skip: ms } = decLen(buf, i); i += ms
  // version
  i++; const { len: vl, skip: vs } = decLen(buf, i); i += vs
  const version = buf[i]; i += vl
  // community
  i++; const { len: cl, skip: cs } = decLen(buf, i); i += cs
  const community = buf.subarray(i, i + cl).toString(); i += cl
  // PDU
  const pduType = buf[i++]
  const { len: pl, skip: ps } = decLen(buf, i); i += ps
  // request-id
  i++; const { len: rl, skip: rs } = decLen(buf, i); i += rs
  let reqId = 0
  for (let j = 0; j < rl; j++) reqId = (reqId * 256) + buf[i + j]
  // make it signed 32-bit
  if (reqId > 0x7fffffff) reqId -= 0x100000000
  i += rl
  // non-repeaters / error-status
  i++; const { len: el, skip: es } = decLen(buf, i); i += es
  let nonRepeaters = 0
  for (let j = 0; j < el; j++) nonRepeaters = (nonRepeaters << 8) | buf[i + j]
  i += el
  // max-repetitions / error-index
  i++; const { len: xl, skip: xs } = decLen(buf, i); i += xs
  let maxRepetitions = 10
  for (let j = 0; j < xl; j++) maxRepetitions = (maxRepetitions << 8) | buf[i + j]
  i += xl
  // varbind list
  i++; const { len: vll, skip: vls } = decLen(buf, i); i += vls
  const varbinds = []
  while (i < buf.length && varbinds.length < 64) {
    if (buf[i] !== 0x30) break
    i++
    const { len: vblen, skip: vbs } = decLen(buf, i); i += vbs
    const vbEnd = i + vblen
    // OID
    i++  // 0x06 tag
    const { len: ol, skip: os } = decLen(buf, i); i += os
    const oid = decOid(buf, i, ol); i += ol
    // value (only needed for SET)
    let val = null
    if (i < vbEnd) {
      const vtype = buf[i++]
      const { len: vl, skip: vs } = decLen(buf, i); i += vs
      if (vtype === T.INTEGER || vtype === T.COUNTER32 || vtype === T.GAUGE32 || vtype === T.TIMETICKS) {
        let n = 0
        for (let j = 0; j < vl; j++) n = (n << 8) | buf[i + j]
        val = { type: vtype, value: n }
      } else if (vtype === T.OCTET_STRING) {
        val = { type: vtype, value: buf.subarray(i, i + vl) }
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
  if (req.community !== 'public') return null

  const out = []

  if (req.pduType === PDU_GET) {
    for (const { oid } of req.varbinds) {
      const e = oidMap.get(oid)
      out.push(e ? [oid, e.type, e.value] : [oid, T.NO_SUCH_OBJ, null])
    }

  } else if (req.pduType === PDU_GETNEXT) {
    for (const { oid } of req.varbinds) {
      const n = nextOid(oid)
      if (n) { const e = oidMap.get(n); out.push([n, e.type, e.value]) }
      else out.push([oid, T.END_OF_MIB, null])
    }

  } else if (req.pduType === PDU_SET) {
    // Apply each varbind value to oidMap, respond with echo of set values
    for (const { oid, val } of req.varbinds) {
      if (val !== null && oidMap.has(oid)) {
        oidMap.set(oid, { type: val.type, value: val.value })
        sortedCache = null  // invalidate sort cache
      }
      const e = oidMap.get(oid)
      out.push(e ? [oid, e.type, e.value] : [oid, T.NO_SUCH_OBJ, null])
    }

  } else if (req.pduType === PDU_GETBULK) {
    // non-repeaters treated as GETNEXT
    for (let i = 0; i < Math.min(req.nonRepeaters, req.varbinds.length); i++) {
      const n = nextOid(req.varbinds[i].oid)
      if (n) { const e = oidMap.get(n); out.push([n, e.type, e.value]) }
      else out.push([req.varbinds[i].oid, T.END_OF_MIB, null])
    }
    // repeaters
    const rep = Math.max(1, req.maxRepetitions || 10)
    for (let i = req.nonRepeaters; i < req.varbinds.length; i++) {
      const nexts = oidsAfter(req.varbinds[i].oid, rep)
      if (nexts.length === 0) { out.push([req.varbinds[i].oid, T.END_OF_MIB, null]); continue }
      for (const n of nexts) { const e = oidMap.get(n); out.push([n, e.type, e.value]) }
    }
  } else {
    return null
  }

  return buildResponse(req.reqId, req.community, out)
}

// ── OID data — simulated 24-port Cisco Catalyst 2960X switch ─────────────────

// System MIB
set('1.3.6.1.2.1.1.1.0', T.OCTET_STRING, 'Cisco IOS Software, Version 15.2(7)E5, RELEASE SOFTWARE\nCisco Catalyst 2960X-24TS-L')
set('1.3.6.1.2.1.1.2.0', T.OID,          '1.3.6.1.4.1.9.1.1045')
set('1.3.6.1.2.1.1.3.0', T.TIMETICKS,    123456789)   // ~14 days 6 h
set('1.3.6.1.2.1.1.4.0', T.OCTET_STRING, 'admin@company.local')
set('1.3.6.1.2.1.1.5.0', T.OCTET_STRING, 'CORE-SW-01')
set('1.3.6.1.2.1.1.6.0', T.OCTET_STRING, 'Server Room Rack-A1')
set('1.3.6.1.2.1.2.1.0', T.INTEGER,      26)  // 24 ports + 2 uplinks

// Entity MIB – chassis index 1
set('1.3.6.1.2.1.47.1.1.1.1.2.1',  T.OCTET_STRING, 'Cisco Catalyst 2960X-24TS-L Ethernet Switch')
set('1.3.6.1.2.1.47.1.1.1.1.7.1',  T.OCTET_STRING, 'WS-C2960X-24TS-L')
set('1.3.6.1.2.1.47.1.1.1.1.10.1', T.OCTET_STRING, '15.2(7)E5')
set('1.3.6.1.2.1.47.1.1.1.1.11.1', T.OCTET_STRING, 'FCW2345A001')
set('1.3.6.1.2.1.47.1.1.1.1.12.1', T.OCTET_STRING, 'Cisco Systems, Inc.')
set('1.3.6.1.2.1.47.1.1.1.1.13.1', T.OCTET_STRING, 'WS-C2960X-24TS-L')

// ifPhysAddress for chassis mgmt interface (index 1)
set('1.3.6.1.2.1.2.2.1.6.1', T.OCTET_STRING, Buffer.from([0xAA, 0xBB, 0xCC, 0x00, 0x01, 0x00]))

// ── Interface table ───────────────────────────────────────────────────────────
// Fields: n=ifIndex, name, descr, alias, macLow (byte), adminUp, operUp, speedMbps, pvid
const PORTS = [
  // Servers – VLAN 10 (web), 20 (db), 30 (monitor), 40 (backup)
  { n:  1, name:'Gi0/1',  descr:'GigabitEthernet0/1',  alias:'SRV-WEB-01',    m:0x01, a:true,  o:true,  s:1000, v:10 },
  { n:  2, name:'Gi0/2',  descr:'GigabitEthernet0/2',  alias:'SRV-WEB-02',    m:0x02, a:true,  o:true,  s:1000, v:10 },
  { n:  3, name:'Gi0/3',  descr:'GigabitEthernet0/3',  alias:'SRV-DB-01',     m:0x03, a:true,  o:true,  s:1000, v:20 },
  { n:  4, name:'Gi0/4',  descr:'GigabitEthernet0/4',  alias:'SRV-DB-02',     m:0x04, a:true,  o:true,  s:1000, v:20 },
  { n:  5, name:'Gi0/5',  descr:'GigabitEthernet0/5',  alias:'SRV-APP-01',    m:0x05, a:true,  o:true,  s:1000, v:10 },
  { n:  6, name:'Gi0/6',  descr:'GigabitEthernet0/6',  alias:'SRV-APP-02',    m:0x06, a:true,  o:false, s:1000, v:10 },
  { n:  7, name:'Gi0/7',  descr:'GigabitEthernet0/7',  alias:'SRV-MON-01',    m:0x07, a:true,  o:true,  s:1000, v:30 },
  { n:  8, name:'Gi0/8',  descr:'GigabitEthernet0/8',  alias:'SRV-BKP-01',    m:0x08, a:true,  o:true,  s:1000, v:40 },
  // Workstations – VLAN 1
  { n:  9, name:'Gi0/9',  descr:'GigabitEthernet0/9',  alias:'PC-ADMIN-01',   m:0x09, a:true,  o:true,  s:100,  v:1  },
  { n: 10, name:'Gi0/10', descr:'GigabitEthernet0/10', alias:'PC-ADMIN-02',   m:0x0a, a:true,  o:true,  s:100,  v:1  },
  { n: 11, name:'Gi0/11', descr:'GigabitEthernet0/11', alias:'PC-DEV-01',     m:0x0b, a:true,  o:true,  s:1000, v:1  },
  { n: 12, name:'Gi0/12', descr:'GigabitEthernet0/12', alias:'PC-DEV-02',     m:0x0c, a:true,  o:false, s:1000, v:1  },
  { n: 13, name:'Gi0/13', descr:'GigabitEthernet0/13', alias:'PRINTER-01',    m:0x0d, a:true,  o:true,  s:100,  v:1  },
  // VoIP – VLAN 50
  { n: 14, name:'Gi0/14', descr:'GigabitEthernet0/14', alias:'IP-PHONE-01',   m:0x0e, a:true,  o:true,  s:100,  v:50 },
  { n: 15, name:'Gi0/15', descr:'GigabitEthernet0/15', alias:'IP-PHONE-02',   m:0x0f, a:true,  o:true,  s:100,  v:50 },
  // Empty / disconnected
  { n: 16, name:'Gi0/16', descr:'GigabitEthernet0/16', alias:'',              m:0x10, a:true,  o:false, s:0,    v:1  },
  { n: 17, name:'Gi0/17', descr:'GigabitEthernet0/17', alias:'',              m:0x11, a:false, o:false, s:0,    v:1  },
  { n: 18, name:'Gi0/18', descr:'GigabitEthernet0/18', alias:'',              m:0x12, a:false, o:false, s:0,    v:1  },
  // CCTV – VLAN 60
  { n: 19, name:'Gi0/19', descr:'GigabitEthernet0/19', alias:'CCTV-CAM-01',   m:0x13, a:true,  o:true,  s:100,  v:60 },
  { n: 20, name:'Gi0/20', descr:'GigabitEthernet0/20', alias:'CCTV-CAM-02',   m:0x14, a:true,  o:true,  s:100,  v:60 },
  // Trunk to APs
  { n: 21, name:'Gi0/21', descr:'GigabitEthernet0/21', alias:'TRUNK-AP-01',   m:0x15, a:true,  o:true,  s:1000, v:1  },
  { n: 22, name:'Gi0/22', descr:'GigabitEthernet0/22', alias:'TRUNK-AP-02',   m:0x16, a:true,  o:false, s:1000, v:1  },
  // Spare
  { n: 23, name:'Gi0/23', descr:'GigabitEthernet0/23', alias:'',              m:0x17, a:false, o:false, s:0,    v:1  },
  { n: 24, name:'Gi0/24', descr:'GigabitEthernet0/24', alias:'',              m:0x18, a:false, o:false, s:0,    v:1  },
  // Uplinks (SFP)
  { n: 25, name:'Gi0/25', descr:'GigabitEthernet0/25', alias:'UPLINK-ROUTER', m:0x19, a:true,  o:true,  s:1000, v:1  },
  { n: 26, name:'Gi0/26', descr:'GigabitEthernet0/26', alias:'UPLINK-BACKUP', m:0x1a, a:true,  o:false, s:1000, v:1  },
]

for (const p of PORTS) {
  const i = p.n
  const mac = Buffer.from([0xAA, 0xBB, 0xCC, 0x00, 0x01, p.m])
  set(`1.3.6.1.2.1.2.2.1.2.${i}`,    T.OCTET_STRING, p.descr)              // ifDescr
  set(`1.3.6.1.2.1.2.2.1.5.${i}`,    T.GAUGE32,      p.s * 1_000_000)      // ifSpeed (bps)
  set(`1.3.6.1.2.1.2.2.1.6.${i}`,    T.OCTET_STRING, mac)                  // ifPhysAddress
  set(`1.3.6.1.2.1.2.2.1.7.${i}`,    T.INTEGER,      p.a ? 1 : 2)          // ifAdminStatus
  set(`1.3.6.1.2.1.2.2.1.8.${i}`,    T.INTEGER,      p.o ? 1 : 2)          // ifOperStatus
  set(`1.3.6.1.2.1.31.1.1.1.1.${i}`, T.OCTET_STRING, p.name)               // ifName
  set(`1.3.6.1.2.1.31.1.1.1.15.${i}`,T.GAUGE32,      p.s)                  // ifHighSpeed (Mbps)
  set(`1.3.6.1.2.1.31.1.1.1.18.${i}`,T.OCTET_STRING, p.alias)              // ifAlias
  set(`1.3.6.1.2.1.17.7.1.4.5.1.1.${i}`, T.GAUGE32,  p.v)                  // dot1qPvid
}

// ── UDP server ─────────────────────────────────────────────────────────────────
const server = dgram.createSocket('udp4')

server.on('message', (msg, rinfo) => {
  try {
    const resp = handle(msg)
    if (resp) server.send(resp, rinfo.port, rinfo.address)
  } catch (err) {
    // swallow — don't crash on malformed packets
  }
})

server.on('error', (err) => {
  console.error('SNMP-sim error:', err.message)
})

server.bind(161, '0.0.0.0', () => {
  console.log(`SNMP simulator ready on UDP :161`)
  console.log(`  Device: CORE-SW-01 (Cisco Catalyst 2960X-24TS-L, 15.2(7)E5)`)
  console.log(`  Ports:  ${PORTS.length} interfaces (${PORTS.filter(p => p.o).length} up, ${PORTS.filter(p => !p.o).length} down)`)
  console.log(`  OIDs:   ${oidMap.size} total`)
  console.log(`  Community: public`)
})
