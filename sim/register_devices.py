#!/usr/bin/env python3
"""
Register all SNMP-simulated devices in SSH Manager.

Usage (run from host after 'docker compose -f docker-compose.sim.yml up -d'):
    python sim/register_devices.py

Or via Docker:
    docker run --rm --network ssh-manager_default \
        -e API_URL=http://api:3001 \
        -e SESSION_COOKIE=<your-session-cookie> \
        ssh-manager-sim python register_devices.py

Environment variables:
    API_URL        — default http://localhost:3001
    API_EMAIL      — admin email for login (default: reads from .env)
    API_PASSWORD   — admin password
    SESSION_COOKIE — paste a session cookie if you don't want to log in
    SNMP_HOST      — hostname/IP of the sim container (default: snmp-sim)
    BASE_PORT      — first UDP port (default: 1161)
    SNMP_COMMUNITY — community string (default: public)
    DRY_RUN        — set to '1' to print actions without calling the API
"""

import os
import json
import urllib.request
import urllib.error
import urllib.parse
import sys

API_URL     = os.environ.get("API_URL", "http://localhost:3001")
EMAIL       = os.environ.get("API_EMAIL", "")
PASSWORD    = os.environ.get("API_PASSWORD", "")
SESSION_COOKIE = os.environ.get("SESSION_COOKIE", "")
SNMP_HOST   = os.environ.get("SNMP_HOST", "snmp-sim")
BASE_PORT   = int(os.environ.get("BASE_PORT", "1161"))
COMMUNITY   = os.environ.get("SNMP_COMMUNITY", "public")
DRY_RUN     = os.environ.get("DRY_RUN", "0") == "1"

# ── Devices to register (must match snmp_sim.py profiles) ────────────────────

DEVICES = [
    {
        "name": "Cisco ISR 4321 Router",
        "hostname": SNMP_HOST,
        "ssh_port": 22,
        "environment": "datacenter",
        "os_type": "router",
        "snmp_port": BASE_PORT + 0,
    },
    {
        "name": "Ubiquiti UniFi AP AC Pro",
        "hostname": SNMP_HOST,
        "ssh_port": 22,
        "environment": "office",
        "os_type": "access-point",
        "snmp_port": BASE_PORT + 1,
    },
    {
        "name": "Fortinet FortiGate 60F",
        "hostname": SNMP_HOST,
        "ssh_port": 22,
        "environment": "datacenter",
        "os_type": "firewall",
        "snmp_port": BASE_PORT + 2,
    },
    {
        "name": "MikroTik RB750Gr3",
        "hostname": SNMP_HOST,
        "ssh_port": 22,
        "environment": "branch",
        "os_type": "router",
        "snmp_port": BASE_PORT + 3,
    },
    {
        "name": "HPE Aruba 2930F Switch",
        "hostname": SNMP_HOST,
        "ssh_port": 22,
        "environment": "datacenter",
        "os_type": "switch",
        "snmp_port": BASE_PORT + 4,
    },
    {
        "name": "Dahua NVR5432-16P-I",
        "hostname": SNMP_HOST,
        "ssh_port": 22,
        "environment": "office",
        "os_type": "nvr",
        "snmp_port": BASE_PORT + 5,
    },
]


# ── HTTP helper ───────────────────────────────────────────────────────────────

_cookie = SESSION_COOKIE

def _request(method: str, path: str, body=None) -> dict:
    url  = API_URL + path
    data = json.dumps(body).encode() if body is not None else None
    req  = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    if _cookie:
        req.add_header("Cookie", _cookie)

    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"HTTP {e.code} {method} {path}: {body}") from e


def login(email: str, password: str):
    global _cookie
    url  = API_URL + "/auth/login"
    data = json.dumps({"email": email, "password": password}).encode()
    req  = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            cookie_header = r.headers.get("Set-Cookie", "")
            # Extract session cookie
            for part in cookie_header.split(";"):
                part = part.strip()
                if "=" in part and ("session" in part.lower() or "connect" in part.lower()):
                    _cookie = part
                    break
            if not _cookie:
                # fallback: take everything before the first ;
                _cookie = cookie_header.split(";")[0]
            print(f"  ✓ Logged in, cookie: {_cookie[:60]}…")
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Login failed: {e.read().decode()}") from e


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global _cookie

    print("=" * 60)
    print("  SSH Manager — SNMP Simulator Device Registration")
    print("=" * 60)

    # Authenticate
    if not _cookie:
        if not EMAIL or not PASSWORD:
            print("\n[!] Set API_EMAIL + API_PASSWORD env vars, or pass SESSION_COOKIE.")
            print("    You can find your session cookie in the browser DevTools → Application → Cookies.")
            sys.exit(1)
        print(f"\n[1] Logging in as {EMAIL}…")
        if not DRY_RUN:
            login(EMAIL, PASSWORD)
        else:
            print("  DRY RUN — skipping login")
    else:
        print(f"\n[1] Using provided session cookie")

    # Fetch existing devices to avoid duplicates
    print("\n[2] Checking existing network devices…")
    existing_names = set()
    if not DRY_RUN:
        try:
            servers = _request("GET", "/servers?device_category=network")
            if isinstance(servers, list):
                existing_names = {s["name"] for s in servers}
                print(f"  Found {len(existing_names)} existing device(s)")
        except Exception as e:
            print(f"  Warning: could not fetch existing devices: {e}")

    # Create SNMP profile (shared community)
    snmp_profile_id = None
    print(f"\n[3] Creating shared SNMP profile (community={COMMUNITY!r})…")
    if not DRY_RUN:
        try:
            result = _request("POST", "/snmp-profiles", {
                "name": "Sim — Public v2c",
                "description": "Shared profile for all SNMP simulator devices",
                "version": "v2c",
                "community": COMMUNITY,
                "port": 161,
            })
            snmp_profile_id = result.get("id")
            print(f"  ✓ Created SNMP profile: {snmp_profile_id}")
        except Exception as e:
            print(f"  Warning: could not create SNMP profile: {e}")
    else:
        print("  DRY RUN — would POST /snmp-profiles")

    # Register each device
    print(f"\n[4] Registering {len(DEVICES)} simulated devices…\n")
    created = []

    for d in DEVICES:
        name = d["name"]
        if name in existing_names:
            print(f"  ~ SKIP  {name} (already exists)")
            continue

        print(f"  + ADD   {name}  ({d['os_type']}, port={d['snmp_port']})")

        if DRY_RUN:
            print(f"          DRY RUN — would POST /servers + PUT /servers/:id/network-profile")
            continue

        # Create server
        try:
            server = _request("POST", "/servers", {
                "name": name,
                "hostname": d["hostname"],
                "ssh_port": d["ssh_port"],
                "environment": d["environment"],
                "os_type": d["os_type"],
                "device_category": "network",
            })
        except Exception as e:
            print(f"    ✗ Failed to create device: {e}")
            continue

        server_id = server.get("id")
        if not server_id:
            print(f"    ✗ No ID in response: {server}")
            continue

        print(f"    ✓ Created server {server_id}")

        # Configure SNMP access profile
        try:
            _request("PUT", f"/servers/{server_id}/network-profile", {
                "snmp_enabled": True,
                "snmp_version": "v2c",
                "snmp_port": d["snmp_port"],
                "snmp_community": COMMUNITY,
                "snmp_profile_id": snmp_profile_id,
                "ping_enabled": True,
                "in_stock": False,
            })
            print(f"    ✓ SNMP profile configured (port {d['snmp_port']})")
        except Exception as e:
            print(f"    ✗ Failed to set SNMP profile: {e}")

        created.append(name)

    # Summary
    print("\n" + "=" * 60)
    if DRY_RUN:
        print("  DRY RUN complete — no changes made.")
    else:
        print(f"  Done! {len(created)} device(s) registered.")
        print("\n  Next steps in SSH Manager → Network Devices:")
        print("   1. Devices tab   → click 📊 SNMP on each device to fetch data")
        print("   2. Ping Monitor  → Run Ping to test all devices")
        print("   3. Firmware AI   → Run AI Check on devices with SNMP data")
        print("   4. SNMP Profiles → Edit 'Sim — Public v2c' to test bulk community update")
    print("=" * 60)


if __name__ == "__main__":
    main()
