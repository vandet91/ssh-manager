#!/usr/bin/env python3
"""
Pure-Python SNMP v2c simulator — no external dependencies.
Runs multiple fake network device agents, each on a different UDP port.
Community string: 'public' (or set via env SNMP_COMMUNITY).

Supports GET and GETNEXT (walk) so the full port-fetch endpoint works.

Test Switch (port 1160) is a full Cisco IOS-style 26-port switch with:
  - IF-MIB (ifDescr, ifSpeed, ifPhysAddress, ifAdminStatus, ifOperStatus,
            ifName, ifHighSpeed, ifAlias)
  - Bridge MIB: dot1dBasePortIfIndex (bridge port → ifIndex mapping)
  - Q-BRIDGE: dot1qPvid (native VLAN per port), dot1qVlanStaticEgressPorts bitmask
  - Cisco IOS trunk status (vlanTrunkPortDynamicStatus)
  - STP port state (dot1dStpPortState)
  - PortFast / edge (stpxFastStartPortEnable)
  - 802.1X port control (dot1xPaePortAdminControl)
  - LLDP local port mapping + neighbor tables
  - CDP neighbor table
"""

import socket
import threading
import os
import time
import logging
import signal
import sys
import struct
from typing import Dict, Any, Optional, Tuple, List

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("snmp-sim")

COMMUNITY = os.environ.get("SNMP_COMMUNITY", "public")
BASE_PORT = int(os.environ.get("BASE_PORT", "1161"))

# ── BER encode/decode helpers ─────────────────────────────────────────────────

TAG_INT   = 0x02
TAG_OCT   = 0x04
TAG_NULL  = 0x05
TAG_OID   = 0x06
TAG_SEQ   = 0x30
TAG_TICKS = 0x43   # TimeTicks
TAG_GAUGE = 0x42   # Gauge32
TAG_COUNTER = 0x41 # Counter32
PDU_GET   = 0xA0
PDU_NEXT  = 0xA1
PDU_RESP  = 0xA2
PDU_BULK  = 0xA5
NO_SUCH_O = 0x80   # noSuchObject
END_OF_MIB = 0x82  # endOfMibView


def _dec_len(data: bytes, pos: int) -> Tuple[int, int]:
    if data[pos] & 0x80 == 0:
        return data[pos], pos + 1
    n = data[pos] & 0x7f
    return int.from_bytes(data[pos+1:pos+1+n], "big"), pos + 1 + n


def _dec_tlv(data: bytes, pos: int) -> Tuple[int, bytes, int]:
    tag = data[pos]
    length, pos = _dec_len(data, pos + 1)
    return tag, data[pos:pos+length], pos + length


def _enc_len(n: int) -> bytes:
    if n < 128:
        return bytes([n])
    if n < 256:
        return bytes([0x81, n])
    return bytes([0x82, (n >> 8) & 0xFF, n & 0xFF])


def _enc_tlv(tag: int, val: bytes) -> bytes:
    return bytes([tag]) + _enc_len(len(val)) + val


def _enc_int(n: int) -> bytes:
    if n == 0:
        return _enc_tlv(TAG_INT, b"\x00")
    buf = []
    while n > 0:
        buf.append(n & 0xFF)
        n >>= 8
    if buf[-1] & 0x80:
        buf.append(0)
    return _enc_tlv(TAG_INT, bytes(reversed(buf)))


def _enc_str(s) -> bytes:
    if isinstance(s, str):
        s = s.encode()
    return _enc_tlv(TAG_OCT, s)


def _enc_ticks(n: int) -> bytes:
    return _enc_tlv(TAG_TICKS, n.to_bytes(4, "big"))


def _enc_gauge(n: int) -> bytes:
    return _enc_tlv(TAG_GAUGE, n.to_bytes(4, "big"))


def _enc_counter(n: int) -> bytes:
    return _enc_tlv(TAG_COUNTER, n.to_bytes(4, "big"))


def _enc_oid(oid_str: str) -> bytes:
    parts = [int(x) for x in oid_str.strip(".").split(".")]
    buf = [parts[0] * 40 + parts[1]]
    for p in parts[2:]:
        if p < 128:
            buf.append(p)
        else:
            chunks = []
            while p:
                chunks.append(p & 0x7F)
                p >>= 7
            chunks.reverse()
            for i, c in enumerate(chunks):
                buf.append(c | (0x80 if i < len(chunks) - 1 else 0))
    return _enc_tlv(TAG_OID, bytes(buf))


def _dec_oid(data: bytes) -> str:
    result = [data[0] // 40, data[0] % 40]
    i, cur = 1, 0
    while i < len(data):
        cur = (cur << 7) | (data[i] & 0x7F)
        if not (data[i] & 0x80):
            result.append(cur)
            cur = 0
        i += 1
    return ".".join(str(x) for x in result)


def _enc_varbind(oid: str, value) -> bytes:
    oid_enc = _enc_oid(oid)
    if value is None:
        val_enc = bytes([NO_SUCH_O, 0])
    elif value == "__endofmib__":
        val_enc = bytes([END_OF_MIB, 0])
    elif isinstance(value, tuple):
        kind, v = value
        if kind == "ticks":   val_enc = _enc_ticks(v)
        elif kind == "gauge": val_enc = _enc_gauge(v)
        elif kind == "counter": val_enc = _enc_counter(v)
        elif kind == "mac":   val_enc = _enc_tlv(TAG_OCT, v)
        elif kind == "oid":   val_enc = _enc_oid(v)
        else:                 val_enc = _enc_str(str(v))
    elif isinstance(value, int):
        val_enc = _enc_int(value)
    elif isinstance(value, str):
        val_enc = _enc_str(value)
    elif isinstance(value, bytes):
        val_enc = _enc_tlv(TAG_OCT, value)
    else:
        val_enc = _enc_str(str(value))
    return _enc_tlv(TAG_SEQ, oid_enc + val_enc)


def parse_request(data: bytes) -> Tuple[str, int, int, int, List[str], int, int]:
    """Returns (community, request_id, pdu_tag, version, oids, non_repeaters, max_repetitions)."""
    _, msg, _ = _dec_tlv(data, 0)
    pos = 0
    _, ver_b, pos  = _dec_tlv(msg, pos)
    version = int.from_bytes(ver_b, "big")
    _, comm_b, pos = _dec_tlv(msg, pos)
    pdu_tag = msg[pos]
    _, pdu, pos    = _dec_tlv(msg, pos)

    pp = 0
    _, rid_b, pp   = _dec_tlv(pdu, pp)
    _, f2_b, pp    = _dec_tlv(pdu, pp)   # errorStatus  OR non_repeaters
    _, f3_b, pp    = _dec_tlv(pdu, pp)   # errorIndex   OR max_repetitions
    _, vbl, pp     = _dec_tlv(pdu, pp)

    non_repeaters    = int.from_bytes(f2_b, "big") if pdu_tag == PDU_BULK else 0
    max_repetitions  = int.from_bytes(f3_b, "big") if pdu_tag == PDU_BULK else 0

    oids = []
    vp = 0
    while vp < len(vbl):
        _, vb, vp = _dec_tlv(vbl, vp)
        _, oid_b, _ = _dec_tlv(vb, 0)
        oids.append(_dec_oid(oid_b))

    return comm_b.decode("utf-8", errors="replace"), int.from_bytes(rid_b, "big"), pdu_tag, version, oids, non_repeaters, max_repetitions


def build_response(community: str, request_id: int, bindings: List[Tuple[str, Any]], version: int = 1) -> bytes:
    varbinds = b"".join(_enc_varbind(oid, val) for oid, val in bindings)
    pdu = _enc_int(request_id) + _enc_int(0) + _enc_int(0) + _enc_tlv(TAG_SEQ, varbinds)
    msg = _enc_int(version) + _enc_str(community) + _enc_tlv(PDU_RESP, pdu)
    return _enc_tlv(TAG_SEQ, msg)


# ── OID comparison for sorted walk ───────────────────────────────────────────

def oid_tuple(oid_str: str) -> tuple:
    return tuple(int(x) for x in oid_str.strip(".").split("."))


def next_oid(oids_sorted: List[str], current: str) -> Optional[str]:
    """Return the lexicographically next OID after current, or None."""
    ct = oid_tuple(current)
    for o in oids_sorted:
        if oid_tuple(o) > ct:
            return o
    return None


# ── Helper to build bitmask buffers for Q-BRIDGE egress ports ────────────────

def _vlan_bitmask(port_list: List[int], total_ports: int = 26) -> bytes:
    """
    Returns a byte string where bit (port-1) from MSB of byte floor((port-1)/8)
    is set for each port in port_list.
    """
    nbytes = (total_ports + 7) // 8
    buf = bytearray(nbytes)
    for p in port_list:
        idx = p - 1
        buf[idx // 8] |= (0x80 >> (idx % 8))
    return bytes(buf)


# ── Dynamic values ────────────────────────────────────────────────────────────

def _uptime():
    return ("ticks", int(time.time() * 100) % 0xFFFFFFFF)

def _mac(h: str) -> Tuple:
    b = bytes.fromhex(h.replace(":", "").replace("-", ""))
    return ("mac", b)


# ── Test Switch — full Cisco IOS 26-port simulation ──────────────────────────
# 26 ports: Gi0/1–Gi0/24 (copper) + Gi0/25–Gi0/26 (uplinks)
# ifIndex = port number (1-indexed)

def _build_test_switch_oids() -> Dict[str, Any]:
    oids: Dict[str, Any] = {}

    # ── System MIB ───────────────────────────────────────────────────────────
    oids["1.3.6.1.2.1.1.1.0"] = "Cisco IOS Software, Catalyst L3 Switch Software (CAT3K_CAA-UNIVERSALK9-M), Version 16.12.5a, RELEASE SOFTWARE (fc2)"
    oids["1.3.6.1.2.1.1.2.0"] = ("oid", "1.3.6.1.4.1.9.1.516")
    oids["1.3.6.1.2.1.1.3.0"] = _uptime
    oids["1.3.6.1.2.1.1.4.0"] = "noc@company.local"
    oids["1.3.6.1.2.1.1.5.0"] = "TEST-SW-01"
    oids["1.3.6.1.2.1.1.6.0"] = "Server Room B, Rack 1, U24"
    oids["1.3.6.1.2.1.2.1.0"] = 26

    # ── Entity MIB ───────────────────────────────────────────────────────────
    oids["1.3.6.1.2.1.47.1.1.1.1.2.1"]  = "Cisco Catalyst 3650 Series chassis"
    oids["1.3.6.1.2.1.47.1.1.1.1.7.1"]  = "WS-C3650-24TS"
    oids["1.3.6.1.2.1.47.1.1.1.1.10.1"] = "16.12.5a"
    oids["1.3.6.1.2.1.47.1.1.1.1.11.1"] = "FOC2048L03Q"
    oids["1.3.6.1.2.1.47.1.1.1.1.13.1"] = "WS-C3650-24TS-E"
    oids["1.3.6.1.2.1.47.1.1.1.1.12.1"] = "Cisco Systems"

    # ── IF-MIB (26 ports) ────────────────────────────────────────────────────
    port_names = [f"GigabitEthernet0/{i}" for i in range(1, 27)]
    short_names = [f"Gi0/{i}" for i in range(1, 27)]
    aliases = [
        "SRV-WEB-01", "SRV-WEB-02", "SRV-DB-01", "SRV-DB-02",
        "SRV-APP-01", "SRV-APP-02", "SRV-MON-01", "SRV-BKP-01",
        "PC-ADMIN-01", "PC-ADMIN-02", "PC-DEV-01", "PC-DEV-02",
        "PC-DEV-03", "PRINTER-01", "IP-PHONE-01", "IP-PHONE-02",
        "IP-CAMERA-01", "IP-CAMERA-02", "SPARE", "SPARE",
        "SPARE", "SPARE", "SPARE", "SPARE",
        "UPLINK-CORE-01", "UPLINK-CORE-02",
    ]
    # Speeds: most 1G, ports 9-10 are 100M, uplinks (25-26) are 10G
    speeds_bps   = [1_000_000_000] * 24 + [10_000_000_000, 10_000_000_000]
    speeds_bps[8]  = 100_000_000   # port 9
    speeds_bps[9]  = 100_000_000   # port 10
    speeds_mbps  = [s // 1_000_000 for s in speeds_bps]
    # oper status: ports 6, 19-24 are down
    down_ports = {6, 19, 20, 21, 22, 23, 24}
    # primary MAC base
    base_mac = 0xAABBCC000101

    for i in range(1, 27):
        mac_bytes = ((base_mac + i - 1) & 0xFFFFFFFFFFFF).to_bytes(6, "big")
        oper = 2 if i in down_ports else 1
        admin = 2 if i in {20, 21, 22} else 1  # a few admin-disabled ports

        oids[f"1.3.6.1.2.1.2.2.1.2.{i}"]  = port_names[i-1]                      # ifDescr
        oids[f"1.3.6.1.2.1.2.2.1.5.{i}"]  = ("gauge", min(speeds_bps[i-1], 0xFFFFFFFF))  # ifSpeed (cap at 32-bit)
        oids[f"1.3.6.1.2.1.2.2.1.6.{i}"]  = ("mac", mac_bytes)                   # ifPhysAddress
        oids[f"1.3.6.1.2.1.2.2.1.7.{i}"]  = admin                                # ifAdminStatus
        oids[f"1.3.6.1.2.1.2.2.1.8.{i}"]  = oper                                 # ifOperStatus
        oids[f"1.3.6.1.2.1.31.1.1.1.1.{i}"]  = short_names[i-1]                  # ifName
        oids[f"1.3.6.1.2.1.31.1.1.1.15.{i}"] = ("gauge", speeds_mbps[i-1])       # ifHighSpeed (Mbps)
        oids[f"1.3.6.1.2.1.31.1.1.1.18.{i}"] = aliases[i-1]                      # ifAlias

    # primary MAC for legacy OID
    oids["1.3.6.1.2.1.2.2.1.6.1"] = ("mac", base_mac.to_bytes(6, "big"))

    # ── Bridge MIB: dot1dBasePortIfIndex ─────────────────────────────────────
    # bridge port n → ifIndex n (1:1 on this simulated switch)
    for i in range(1, 27):
        oids[f"1.3.6.1.2.1.17.1.4.1.2.{i}"] = i

    # ── Q-BRIDGE: dot1qPvid (native/access VLAN per bridge port) ─────────────
    # Access ports: various VLANs; uplinks: native VLAN 1
    pvids = [
        10, 10, 20, 20, 30, 30, 40, 40,   # ports 1-8: servers
        50, 50, 50, 50, 50, 50, 60, 60,   # ports 9-16: PCs + phones
        70, 70, 1, 1, 1, 1, 1, 1,         # ports 17-24: cameras + spares
        1, 1,                              # ports 25-26: uplinks
    ]
    for i in range(1, 27):
        oids[f"1.3.6.1.2.1.17.7.1.4.5.1.1.{i}"] = pvids[i-1]

    # ── Q-BRIDGE: dot1qVlanStaticEgressPorts bitmask ─────────────────────────
    # Each VLAN key → bitmask of ports that carry it (egress)
    # Uplinks (25,26) are trunk — they appear in all VLANs
    trunk_ports = [25, 26]
    vlan_access_ports = {
        1:  [19, 20, 21, 22, 23, 24] + trunk_ports,  # spares + trunks
        10: [1, 2] + trunk_ports,
        20: [3, 4] + trunk_ports,
        30: [5, 6] + trunk_ports,
        40: [7, 8] + trunk_ports,
        50: [9, 10, 11, 12, 13, 14] + trunk_ports,
        60: [15, 16] + trunk_ports,
        70: [17, 18] + trunk_ports,
    }
    for vlan_id, port_list in vlan_access_ports.items():
        oids[f"1.3.6.1.2.1.17.7.1.4.3.1.2.{vlan_id}"] = _vlan_bitmask(port_list)

    # ── Cisco IOS: vlanTrunkPortDynamicStatus ─────────────────────────────────
    # 1=trunking, 2=notTrunking — keyed by ifIndex
    for i in range(1, 27):
        oids[f"1.3.6.1.4.1.9.9.46.1.6.1.1.14.{i}"] = 1 if i in (25, 26) else 2

    # ── STP port state (dot1dStpPortState) ───────────────────────────────────
    # 1=disabled,2=blocking,3=listening,4=learning,5=forwarding
    for i in range(1, 27):
        if i in down_ports:
            oids[f"1.3.6.1.2.1.17.2.15.1.3.{i}"] = 1   # disabled
        elif i in (25, 26):
            oids[f"1.3.6.1.2.1.17.2.15.1.3.{i}"] = 5   # forwarding (uplinks)
        else:
            oids[f"1.3.6.1.2.1.17.2.15.1.3.{i}"] = 5   # forwarding

    # ── PortFast / Edge (stpxFastStartPortEnable) ────────────────────────────
    # 1=enable on Cisco IOS — access ports get portfast, uplinks don't
    for i in range(1, 27):
        oids[f"1.3.6.1.4.1.9.9.82.1.9.3.1.3.{i}"] = 1 if i not in (25, 26) else 2

    # ── 802.1X port control (dot1xPaePortAdminControl) ───────────────────────
    # 1=forceUnauth, 2=auto, 3=forceAuth
    dot1x_ports = {9, 10, 11, 12, 13, 14, 15, 16}  # PC + phone ports = auto
    for i in range(1, 27):
        if i in dot1x_ports:
            oids[f"1.0.8802.1.1.1.1.2.1.1.6.{i}"] = 2    # auto
        elif i in (25, 26):
            oids[f"1.0.8802.1.1.1.1.2.1.1.6.{i}"] = 3    # force-authorized (uplinks)
        else:
            oids[f"1.0.8802.1.1.1.1.2.1.1.6.{i}"] = 3    # force-authorized

    # ── LLDP local port → ifIndex mapping ────────────────────────────────────
    # lldpLocPortIfIndex: local port n → ifIndex n
    for i in range(1, 27):
        oids[f"1.0.8802.1.1.2.1.3.7.1.3.{i}"] = i

    # ── LLDP neighbors (only uplinks have neighbors) ──────────────────────────
    # OID structure: <base>.<localPort>.<remoteIndex>
    # Port 25 → Core Switch
    oids["1.0.8802.1.1.2.1.4.1.1.5.25.1"]  = ("mac", bytes.fromhex("AABBCC001025"))   # chassis MAC
    oids["1.0.8802.1.1.2.1.4.1.1.7.25.1"]  = "Gi1/0/1"                               # remote port
    oids["1.0.8802.1.1.2.1.4.1.1.9.25.1"]  = "CORE-SW-01"                            # sys name
    oids["1.0.8802.1.1.2.1.4.1.1.10.25.1"] = "Cisco IOS Software, C9300, Version 17.6.5"  # sys desc

    # Port 26 → Distribution Switch
    oids["1.0.8802.1.1.2.1.4.1.1.5.26.1"]  = ("mac", bytes.fromhex("AABBCC001026"))
    oids["1.0.8802.1.1.2.1.4.1.1.7.26.1"]  = "Gi2/0/1"
    oids["1.0.8802.1.1.2.1.4.1.1.9.26.1"]  = "DIST-SW-01"
    oids["1.0.8802.1.1.2.1.4.1.1.10.26.1"] = "Cisco IOS Software, C9300, Version 17.6.5"

    # Port 1 → server exposes LLDP too
    oids["1.0.8802.1.1.2.1.4.1.1.5.1.1"]  = ("mac", bytes.fromhex("AABBCC010101"))
    oids["1.0.8802.1.1.2.1.4.1.1.7.1.1"]  = "eth0"
    oids["1.0.8802.1.1.2.1.4.1.1.9.1.1"]  = "SRV-WEB-01"
    oids["1.0.8802.1.1.2.1.4.1.1.10.1.1"] = "Linux srv-web-01 5.15.0-91-generic"

    # ── CDP neighbors (Cisco IOS only) ────────────────────────────────────────
    # OID ends in <ifIndex>.<neighborIndex>
    # Port 25
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.6.25.1"] = "CORE-SW-01.company.local"   # deviceId
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.4.25.1"] = bytes([10, 0, 0, 254])        # IP as 4 bytes
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.7.25.1"] = "GigabitEthernet1/0/1"        # remote port
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.8.25.1"] = "cisco WS-C9300-24T"          # platform

    # Port 26
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.6.26.1"] = "DIST-SW-01.company.local"
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.4.26.1"] = bytes([10, 0, 0, 253])
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.7.26.1"] = "GigabitEthernet2/0/1"
    oids["1.3.6.1.4.1.9.9.23.1.2.1.1.8.26.1"] = "cisco WS-C9300-48T"

    return oids


# ── Device profiles ───────────────────────────────────────────────────────────

def _uptime_fn():
    return ("ticks", int(time.time() * 100) % 0xFFFFFFFF)


DEVICE_PROFILES = [
    {
        "name": "Test Switch (snmp-sim)",
        "port_offset": 6,
        "os_type": "switch",
        "environment": "lab",
        "oids": _build_test_switch_oids(),
    },
    {
        "name": "Cisco ISR 4321 Router",
        "port_offset": 0,
        "os_type": "router",
        "environment": "datacenter",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Cisco IOS Software [Fuji], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 16.9.8, RELEASE SOFTWARE (fc3)",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.9.1.1861",
            "1.3.6.1.2.1.1.3.0":  _uptime_fn,
            "1.3.6.1.2.1.1.4.0":  "noc@company.com",
            "1.3.6.1.2.1.1.5.0":  "CISCO-ISR4321-01",
            "1.3.6.1.2.1.1.6.0":  "Server Room A, Rack 3",
            "1.3.6.1.2.1.2.1.0":  4,
            "1.3.6.1.2.1.47.1.1.1.1.2.1":  "Cisco ISR 4321 chassis",
            "1.3.6.1.2.1.47.1.1.1.1.7.1":  "ISR4321",
            "1.3.6.1.2.1.47.1.1.1.1.10.1": "16.9.8",
            "1.3.6.1.2.1.47.1.1.1.1.11.1": "FDO2122P04N",
            "1.3.6.1.2.1.47.1.1.1.1.13.1": "ISR4321/K9",
            "1.3.6.1.2.1.47.1.1.1.1.12.1": "Cisco Systems",
            "1.3.6.1.2.1.2.2.1.6.1": _mac("00:1A:A0:11:22:33"),
        },
    },
    {
        "name": "Ubiquiti UniFi AP AC Pro",
        "port_offset": 1,
        "os_type": "access-point",
        "environment": "office",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Linux UBNT 4.19.152 #1 Mon Nov 8 11:06:00 UTC 2021 mips",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.41112.1.4.8.1",
            "1.3.6.1.2.1.1.3.0":  _uptime_fn,
            "1.3.6.1.2.1.1.4.0":  "support@ubnt.com",
            "1.3.6.1.2.1.1.5.0":  "UAP-AC-PRO-OFFICE-01",
            "1.3.6.1.2.1.1.6.0":  "2nd Floor, East Wing",
            "1.3.6.1.2.1.2.1.0":  3,
            "1.3.6.1.2.1.47.1.1.1.1.2.1":  "UAP-AC-PRO",
            "1.3.6.1.2.1.47.1.1.1.1.7.1":  "UAP-AC-PRO",
            "1.3.6.1.2.1.47.1.1.1.1.10.1": "6.0.21.13138",
            "1.3.6.1.2.1.47.1.1.1.1.11.1": "FCCE04B7A834",
            "1.3.6.1.2.1.47.1.1.1.1.13.1": "UAP-AC-PRO",
            "1.3.6.1.2.1.47.1.1.1.1.12.1": "Ubiquiti Networks",
            "1.3.6.1.2.1.2.2.1.6.1": _mac("FC:CE:04:B7:A8:34"),
        },
    },
    {
        "name": "Fortinet FortiGate 60F",
        "port_offset": 2,
        "os_type": "firewall",
        "environment": "datacenter",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Fortinet FortiGate-60F v7.0.14 build0601 (GA)",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.12356.101.1.621",
            "1.3.6.1.2.1.1.3.0":  _uptime_fn,
            "1.3.6.1.2.1.1.4.0":  "admin@company.com",
            "1.3.6.1.2.1.1.5.0":  "FG60F-PERIMETER-01",
            "1.3.6.1.2.1.1.6.0":  "DMZ Rack",
            "1.3.6.1.2.1.2.1.0":  10,
            "1.3.6.1.2.1.47.1.1.1.1.2.1":  "FortiGate-60F",
            "1.3.6.1.2.1.47.1.1.1.1.7.1":  "FG60F",
            "1.3.6.1.2.1.47.1.1.1.1.10.1": "v7.0.14",
            "1.3.6.1.2.1.47.1.1.1.1.11.1": "FG60FETK21005678",
            "1.3.6.1.2.1.47.1.1.1.1.13.1": "FortiGate-60F",
            "1.3.6.1.2.1.47.1.1.1.1.12.1": "Fortinet",
            "1.3.6.1.2.1.2.2.1.6.1": _mac("08:5B:0E:11:AA:BB"),
        },
    },
    {
        "name": "MikroTik RB750Gr3",
        "port_offset": 3,
        "os_type": "router",
        "environment": "branch",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "RouterOS RB750Gr3",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.14988.1",
            "1.3.6.1.2.1.1.3.0":  _uptime_fn,
            "1.3.6.1.2.1.1.4.0":  "helpdesk@company.com",
            "1.3.6.1.2.1.1.5.0":  "BRANCH-ROUTER-01",
            "1.3.6.1.2.1.1.6.0":  "Branch Office Lobby",
            "1.3.6.1.2.1.2.1.0":  5,
            "1.3.6.1.2.1.47.1.1.1.1.2.1":  "MikroTik RB750Gr3",
            "1.3.6.1.2.1.47.1.1.1.1.7.1":  "RB750Gr3",
            "1.3.6.1.2.1.47.1.1.1.1.10.1": "7.10.2",
            "1.3.6.1.2.1.47.1.1.1.1.11.1": "HBT09A12345",
            "1.3.6.1.2.1.47.1.1.1.1.13.1": "RB750Gr3",
            "1.3.6.1.2.1.47.1.1.1.1.12.1": "MikroTik",
            "1.3.6.1.2.1.2.2.1.6.1": _mac("DC:2C:6E:12:34:56"),
        },
    },
    {
        "name": "HPE Aruba 2930F Switch",
        "port_offset": 4,
        "os_type": "switch",
        "environment": "datacenter",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "HP J9772A 2930F-24G-PoE+-4SFP Switch, revision WC.16.10.0020",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.11.2.3.7.11.176",
            "1.3.6.1.2.1.1.3.0":  _uptime_fn,
            "1.3.6.1.2.1.1.4.0":  "network-team@company.com",
            "1.3.6.1.2.1.1.5.0":  "ARUBA-2930F-CORE-01",
            "1.3.6.1.2.1.1.6.0":  "Server Room A, Rack 2, U12",
            "1.3.6.1.2.1.2.1.0":  28,
            "1.3.6.1.2.1.47.1.1.1.1.2.1":  "HPE Aruba 2930F-24G-PoE+-4SFP Switch",
            "1.3.6.1.2.1.47.1.1.1.1.7.1":  "J9772A",
            "1.3.6.1.2.1.47.1.1.1.1.10.1": "WC.16.10.0020",
            "1.3.6.1.2.1.47.1.1.1.1.11.1": "CN9BKGL0GJ",
            "1.3.6.1.2.1.47.1.1.1.1.13.1": "J9772A",
            "1.3.6.1.2.1.47.1.1.1.1.12.1": "Hewlett Packard Enterprise",
            "1.3.6.1.2.1.2.2.1.6.1": _mac("B8:D4:E7:AA:BB:CC"),
        },
    },
    {
        "name": "Dahua NVR5432-16P-I",
        "port_offset": 5,
        "os_type": "nvr",
        "environment": "office",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Dahua NVR5432-16P-I Network Video Recorder",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.1.3.4.1",
            "1.3.6.1.2.1.1.3.0":  _uptime_fn,
            "1.3.6.1.2.1.1.4.0":  "security@company.com",
            "1.3.6.1.2.1.1.5.0":  "DAHUA-NVR-MAIN",
            "1.3.6.1.2.1.1.6.0":  "Reception Lobby, Rack",
            "1.3.6.1.2.1.2.1.0":  2,
            "1.3.6.1.2.1.47.1.1.1.1.2.1":  "NVR5432-16P-I",
            "1.3.6.1.2.1.47.1.1.1.1.7.1":  "NVR5432-16P-I",
            "1.3.6.1.2.1.47.1.1.1.1.10.1": "V4.002.0000001.0.R",
            "1.3.6.1.2.1.47.1.1.1.1.11.1": "6J07BAJ0AG00157",
            "1.3.6.1.2.1.47.1.1.1.1.13.1": "NVR5432-16P-I",
            "1.3.6.1.2.1.47.1.1.1.1.12.1": "Dahua Technology",
            "1.3.6.1.2.1.2.2.1.6.1": _mac("E8:FF:1E:33:44:55"),
        },
    },
]


# ── SNMP agent thread ─────────────────────────────────────────────────────────

def resolve_value(v):
    return v() if callable(v) else v


def run_agent(device: dict, port: int, community: str):
    name = device["name"]
    raw_oids: Dict[str, Any] = device["oids"]

    # Pre-sort OIDs for GETNEXT walk support
    sorted_oids = sorted(raw_oids.keys(), key=oid_tuple)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    log.info(f"[{name}] listening on UDP {port} (community={community!r})")

    while True:
        try:
            data, addr = sock.recvfrom(65535)
        except Exception as e:
            log.error(f"[{name}] recv error: {e}")
            continue

        try:
            req_community, request_id, pdu_tag, req_version, req_oids, non_reps, max_reps = parse_request(data)
        except Exception as e:
            log.warning(f"[{name}] parse error from {addr}: {e}")
            continue

        if req_community != community:
            log.warning(f"[{name}] wrong community {req_community!r} from {addr}")
            continue

        bindings = []

        if pdu_tag == PDU_GET:
            for oid in req_oids:
                if oid in raw_oids:
                    bindings.append((oid, resolve_value(raw_oids[oid])))
                else:
                    bindings.append((oid, None))

        elif pdu_tag == PDU_NEXT:
            for oid in req_oids:
                nxt = next_oid(sorted_oids, oid)
                if nxt is None:
                    bindings.append((oid, "__endofmib__"))
                else:
                    bindings.append((nxt, resolve_value(raw_oids[nxt])))

        elif pdu_tag == PDU_BULK:
            # non_reps OIDs are treated as GETNEXT (scalar, no repetition)
            for oid in req_oids[:non_reps]:
                nxt = next_oid(sorted_oids, oid)
                if nxt is None:
                    bindings.append((oid, "__endofmib__"))
                else:
                    bindings.append((nxt, resolve_value(raw_oids[nxt])))
            # remaining OIDs are repeated up to max_reps times
            reps = max(1, max_reps)
            for oid in req_oids[non_reps:]:
                cur = oid
                for _ in range(reps):
                    nxt = next_oid(sorted_oids, cur)
                    if nxt is None:
                        bindings.append((cur, "__endofmib__"))
                        break
                    bindings.append((nxt, resolve_value(raw_oids[nxt])))
                    cur = nxt

        try:
            response = build_response(community, request_id, bindings, version=req_version)
            sock.sendto(response, addr)
        except Exception as e:
            log.error(f"[{name}] encode error: {e}")


def main():
    threads = []
    for device in DEVICE_PROFILES:
        port = BASE_PORT + device["port_offset"]
        t = threading.Thread(
            target=run_agent,
            args=(device, port, COMMUNITY),
            daemon=True,
            name=f"agent-{port}",
        )
        t.start()
        threads.append(t)

    ports_used = [BASE_PORT + d["port_offset"] for d in DEVICE_PROFILES]
    log.info(f"SNMP Simulator running — {len(DEVICE_PROFILES)} devices on ports {sorted(ports_used)}")

    def _shutdown(sig, frame):
        log.info("Shutting down…")
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
