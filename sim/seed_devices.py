#!/usr/bin/env python3
"""
Seed sim devices directly into the database — no login needed.

Usage:
    python sim/seed_devices.py

Reads DATABASE_URL from .env if present, or use env var:
    DATABASE_URL=postgresql://... python sim/seed_devices.py
"""

import os
import sys
import re
import socket
import urllib.request

# ── Load .env ─────────────────────────────────────────────────────────────────
def load_env(path=".env"):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k not in os.environ:
                os.environ[k] = v

load_env()

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://sshmanager:password@localhost:5432/sshmanager")
SNMP_HOST    = os.environ.get("SNMP_HOST", "snmp-sim")
BASE_PORT    = int(os.environ.get("BASE_PORT", "1161"))
COMMUNITY    = os.environ.get("SNMP_COMMUNITY", "public")

DEVICES = [
    {"name": "Cisco ISR 4321 Router",    "os_type": "router",       "environment": "datacenter", "offset": 0},
    {"name": "Ubiquiti UniFi AP AC Pro", "os_type": "access-point", "environment": "office",     "offset": 1},
    {"name": "Fortinet FortiGate 60F",   "os_type": "firewall",     "environment": "datacenter", "offset": 2},
    {"name": "MikroTik RB750Gr3",        "os_type": "router",       "environment": "branch",     "offset": 3},
    {"name": "HPE Aruba 2930F Switch",   "os_type": "switch",       "environment": "datacenter", "offset": 4},
    {"name": "Dahua NVR5432-16P-I",      "os_type": "nvr",          "environment": "office",     "offset": 5},
    {"name": "Test Switch (snmp-sim)",   "os_type": "switch",       "environment": "lab",        "offset": 6},
]

# ── Parse DATABASE_URL ────────────────────────────────────────────────────────
def parse_url(url):
    m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):?(\d+)?/(.+)", url)
    if not m:
        sys.exit(f"Cannot parse DATABASE_URL: {url}")
    user, password, host, port, dbname = m.groups()
    return {"user": user, "password": password, "host": host,
            "port": int(port or 5432), "dbname": dbname}

# ── Minimal PostgreSQL wire-protocol client (no psycopg2 needed) ───────────────
class PgConn:
    def __init__(self, **kw):
        self.sock = socket.create_connection((kw["host"], kw["port"]), timeout=10)
        self._startup(kw["user"], kw["dbname"], kw["password"])

    def _send(self, data): self.sock.sendall(data)

    def _recv(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk: raise ConnectionError("Connection closed")
            buf += chunk
        return buf

    def _read_msg(self):
        hdr = self._recv(5)
        mtype = chr(hdr[0])
        length = int.from_bytes(hdr[1:5], "big") - 4
        body = self._recv(length) if length > 0 else b""
        return mtype, body

    def _startup(self, user, dbname, password):
        import struct
        params = b"user\x00" + user.encode() + b"\x00database\x00" + dbname.encode() + b"\x00\x00"
        msg = struct.pack(">II", len(params) + 8, 196608) + params
        self._send(msg)
        while True:
            t, body = self._read_msg()
            if t == "R":
                auth_type = int.from_bytes(body[:4], "big")
                if auth_type == 0:
                    continue
                elif auth_type == 5:  # MD5
                    import hashlib
                    salt = body[4:8]
                    p1 = hashlib.md5(password.encode() + user.encode()).hexdigest().encode()
                    p2 = hashlib.md5(p1 + salt).hexdigest()
                    pwd = ("md5" + p2).encode() + b"\x00"
                    msg = b"p" + (len(pwd) + 4).to_bytes(4, "big") + pwd
                    self._send(msg)
                elif auth_type == 10:  # SASL (SHA-256) — fallback message
                    sys.exit("SASL auth required. Set DATABASE_URL with md5 user or use psycopg2.")
            elif t == "E":
                raise RuntimeError("Auth error: " + body.decode(errors="replace"))
            elif t == "Z":
                break  # ReadyForQuery

    def query(self, sql, params=()):
        """Run a simple query (no binary params). Returns list of row dicts."""
        # Simple query protocol — substitute params manually (strings only, basic escape)
        for p in params:
            if p is None:
                sql = sql.replace("%s", "NULL", 1)
            elif isinstance(p, int):
                sql = sql.replace("%s", str(p), 1)
            else:
                escaped = str(p).replace("'", "''")
                sql = sql.replace("%s", f"'{escaped}'", 1)

        msg = sql.encode() + b"\x00"
        self._send(b"Q" + (len(msg) + 4).to_bytes(4, "big") + msg)

        rows = []
        columns = []
        while True:
            t, body = self._read_msg()
            if t == "T":  # RowDescription
                count = int.from_bytes(body[:2], "big")
                pos = 2
                for _ in range(count):
                    end = body.index(b"\x00", pos)
                    columns.append(body[pos:end].decode())
                    pos = end + 1 + 18  # skip type info
            elif t == "D":  # DataRow
                count = int.from_bytes(body[:2], "big")
                pos = 2
                row = {}
                for col in columns:
                    length = int.from_bytes(body[pos:pos+4], "big")
                    pos += 4
                    if length == 0xFFFFFFFF:
                        row[col] = None
                    else:
                        row[col] = body[pos:pos+length].decode(errors="replace")
                        pos += length
                rows.append(row)
            elif t in ("C", "I"):  # CommandComplete / EmptyQueryResponse
                pass
            elif t == "Z":  # ReadyForQuery
                break
            elif t == "E":
                raise RuntimeError("Query error: " + body.decode(errors="replace"))
        return rows

    def close(self):
        self._send(b"X\x00\x00\x00\x04")
        self.sock.close()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  SSH Manager — SNMP Simulator Direct DB Seed")
    print("=" * 60)
    print(f"\nConnecting to: {DATABASE_URL}")

    cfg = parse_url(DATABASE_URL)
    try:
        db = PgConn(**cfg)
    except Exception as e:
        sys.exit(f"\n[!] Cannot connect to database: {e}")

    print("  ✓ Connected\n")

    created = 0
    skipped = 0

    for d in DEVICES:
        name = d["name"]
        snmp_port = BASE_PORT + d["offset"]

        # Check if already exists
        rows = db.query("SELECT id FROM servers WHERE name = %s", (name,))
        if rows:
            sid = rows[0]["id"]
            db.query("UPDATE servers SET snmp_port = %s, hostname = %s WHERE id = %s",
                     (snmp_port, SNMP_HOST, sid))
            print(f"  ~ UPDATE  {name}  → SNMP port {snmp_port}")
            skipped += 1
            continue

        # Insert server
        rows = db.query("""
            INSERT INTO servers (name, hostname, ssh_port, os_type, environment, device_category)
            VALUES (%s, %s, 22, %s, %s, 'network')
            RETURNING id
        """, (name, SNMP_HOST, d["os_type"], d["environment"]))

        if not rows:
            print(f"  ✗ FAILED  {name}")
            continue

        sid = rows[0]["id"]

        # Update snmp_port on servers table
        db.query("""
            UPDATE servers SET snmp_port = %s, snmp_community = %s WHERE id = %s
        """, (snmp_port, COMMUNITY, sid))

        print(f"  + CREATED {name}  (port {snmp_port})")
        created += 1

    db.close()

    print(f"\n{'=' * 60}")
    print(f"  Done! {created} created, {skipped} updated.")
    print(f"\n  Go to Network Devices and click SNMP on 'Test Switch (snmp-sim)'")
    print("=" * 60)


if __name__ == "__main__":
    main()
