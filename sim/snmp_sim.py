#!/usr/bin/env python3
"""
Pure-Python SNMP v2c simulator — no external dependencies.
Runs multiple fake network device agents, each on a different UDP port.
Community string: 'public' (or set via env SNMP_COMMUNITY).

Supported OIDs:
  System MIB  — sysDescr, sysObjectID, sysUpTime, sysContact, sysName, sysLocation, ifNumber
  Entity MIB  — entPhysicalDescr, entPhysicalName, entPhysicalSoftwareRev,
                entPhysicalSerialNum, entPhysicalModelName, entPhysicalMfgName
  Interface   — ifPhysAddress.1  (primary MAC)
"""

import socket
import threading
import os
import time
import logging
import signal
import sys
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
TAG_TICKS = 0x43  # TimeTicks
TAG_GAUGE = 0x42  # Gauge32
PDU_GET   = 0xA0
PDU_NEXT  = 0xA1
PDU_RESP  = 0xA2
NO_SUCH_O = 0x80  # noSuchObject context


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
    b = n.to_bytes(4, "big")
    return _enc_tlv(TAG_TICKS, b)


def _enc_gauge(n: int) -> bytes:
    b = n.to_bytes(4, "big")
    return _enc_tlv(TAG_GAUGE, b)


def _enc_oid(oid_str: str) -> bytes:
    parts = [int(x) for x in oid_str.split(".")]
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
    elif isinstance(value, tuple):
        kind, v = value
        if kind == "ticks":
            val_enc = _enc_ticks(v)
        elif kind == "gauge":
            val_enc = _enc_gauge(v)
        elif kind == "mac":
            val_enc = _enc_tlv(TAG_OCT, v)
        else:
            val_enc = _enc_str(str(v))
    elif isinstance(value, int):
        val_enc = _enc_int(value)
    elif isinstance(value, str):
        val_enc = _enc_str(value)
    elif isinstance(value, bytes):
        val_enc = _enc_tlv(TAG_OCT, value)
    else:
        val_enc = _enc_str(str(value))
    return _enc_tlv(TAG_SEQ, oid_enc + val_enc)


def parse_request(data: bytes) -> Tuple[str, int, int, int, List[str]]:
    """Returns (community, request_id, pdu_tag, version, [oids])"""
    _, msg, _ = _dec_tlv(data, 0)
    pos = 0
    _, ver_b, pos  = _dec_tlv(msg, pos)
    version = int.from_bytes(ver_b, "big")
    _, comm_b, pos = _dec_tlv(msg, pos)
    pdu_tag = msg[pos]
    _, pdu, pos    = _dec_tlv(msg, pos)

    pp = 0
    _, rid_b, pp = _dec_tlv(pdu, pp)
    _, _, pp     = _dec_tlv(pdu, pp)   # error-status
    _, _, pp     = _dec_tlv(pdu, pp)   # error-index
    _, vbl, pp   = _dec_tlv(pdu, pp)

    oids = []
    vp = 0
    while vp < len(vbl):
        _, vb, vp = _dec_tlv(vbl, vp)
        _, oid_b, _ = _dec_tlv(vb, 0)
        oids.append(_dec_oid(oid_b))

    request_id = int.from_bytes(rid_b, "big")
    community  = comm_b.decode("utf-8", errors="replace")
    return community, request_id, pdu_tag, version, oids


def build_response(community: str, request_id: int, bindings: List[Tuple[str, Any]], version: int = 1) -> bytes:
    varbinds = b"".join(_enc_varbind(oid, val) for oid, val in bindings)
    pdu = (
        _enc_int(request_id) +
        _enc_int(0) +   # error-status
        _enc_int(0) +   # error-index
        _enc_tlv(TAG_SEQ, varbinds)
    )
    msg = (
        _enc_int(version) +               # echo back same version as request
        _enc_str(community) +
        _enc_tlv(PDU_RESP, pdu)
    )
    return _enc_tlv(TAG_SEQ, msg)


# ── Device profiles ───────────────────────────────────────────────────────────

def _uptime():
    """Simulated uptime in centiseconds (increases from a fixed base)."""
    return ("ticks", int(time.time() * 100) % 0xFFFFFFFF)

def _mac(h: str) -> Tuple:
    b = bytes.fromhex(h.replace(":", "").replace("-", ""))
    return ("mac", b)


DEVICE_PROFILES = [
    {
        "name": "Cisco ISR 4321 Router",
        "port_offset": 0,       # BASE_PORT + 0 = 1161
        "os_type": "router",
        "environment": "datacenter",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Cisco IOS Software [Fuji], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 16.9.8, RELEASE SOFTWARE (fc3)",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.9.1.1861",
            "1.3.6.1.2.1.1.3.0":  _uptime,
            "1.3.6.1.2.1.1.4.0":  "noc@company.com",
            "1.3.6.1.2.1.1.5.0":  "CISCO-ISR4321-01",
            "1.3.6.1.2.1.1.6.0":  "Server Room A, Rack 3",
            "1.3.6.1.2.1.2.1.0":  4,
            # Entity MIB
            "1.3.6.1.2.1.47.1.1.1.1.2.1":  "Cisco ISR 4321 chassis",
            "1.3.6.1.2.1.47.1.1.1.1.7.1":  "ISR4321",
            "1.3.6.1.2.1.47.1.1.1.1.10.1": "16.9.8",
            "1.3.6.1.2.1.47.1.1.1.1.11.1": "FDO2122P04N",
            "1.3.6.1.2.1.47.1.1.1.1.13.1": "ISR4321/K9",
            "1.3.6.1.2.1.47.1.1.1.1.12.1": "Cisco Systems",
            # MAC
            "1.3.6.1.2.1.2.2.1.6.1": _mac("00:1A:A0:11:22:33"),
        },
    },
    {
        "name": "Ubiquiti UniFi AP AC Pro",
        "port_offset": 1,       # 1162
        "os_type": "access-point",
        "environment": "office",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Linux UBNT 4.19.152 #1 Mon Nov 8 11:06:00 UTC 2021 mips",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.41112.1.4.8.1",
            "1.3.6.1.2.1.1.3.0":  _uptime,
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
        "port_offset": 2,       # 1163
        "os_type": "firewall",
        "environment": "datacenter",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Fortinet FortiGate-60F v7.0.14 build0601 (GA)",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.12356.101.1.621",
            "1.3.6.1.2.1.1.3.0":  _uptime,
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
        "port_offset": 3,       # 1164
        "os_type": "router",
        "environment": "branch",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "RouterOS RB750Gr3",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.14988.1",
            "1.3.6.1.2.1.1.3.0":  _uptime,
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
        "port_offset": 4,       # 1165
        "os_type": "switch",
        "environment": "datacenter",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "HP J9772A 2930F-24G-PoE+-4SFP Switch, revision WC.16.10.0020, ROM WC.15.05.0007 (/ws/swbuildm/rel_stockholm_qaoff/code/build/bom(swbuildm_rel_stockholm_qaoff_rel))",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.11.2.3.7.11.176",
            "1.3.6.1.2.1.1.3.0":  _uptime,
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
        "port_offset": 5,       # 1166
        "os_type": "nvr",
        "environment": "office",
        "oids": {
            "1.3.6.1.2.1.1.1.0":  "Dahua NVR5432-16P-I Network Video Recorder",
            "1.3.6.1.2.1.1.2.0":  "1.3.6.1.4.1.1.3.4.1",
            "1.3.6.1.2.1.1.3.0":  _uptime,
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
    """Call value if it's a callable (dynamic values like uptime)."""
    return v() if callable(v) else v


def run_agent(device: dict, port: int, community: str):
    name = device["name"]
    oids: Dict[str, Any] = device["oids"]

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
            req_community, request_id, pdu_tag, req_version, req_oids = parse_request(data)
        except Exception as e:
            log.warning(f"[{name}] parse error from {addr}: {e}")
            continue

        if req_community != community:
            log.warning(f"[{name}] wrong community {req_community!r} from {addr}")
            continue

        bindings = []
        for oid in req_oids:
            if oid in oids:
                val = resolve_value(oids[oid])
                bindings.append((oid, val))
                log.debug(f"[{name}] GET {oid} = {val!r}")
            else:
                log.debug(f"[{name}] GET {oid} = noSuchObject")
                bindings.append((oid, None))

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

    log.info(
        f"SNMP Simulator running — {len(DEVICE_PROFILES)} devices on ports "
        f"{BASE_PORT}–{BASE_PORT + len(DEVICE_PROFILES) - 1}"
    )

    def _shutdown(sig, frame):
        log.info("Shutting down…")
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
