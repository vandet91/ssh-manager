# SSH Manager

A self-hosted web platform for centralizing SSH key management, server credential vault, browser-based terminal, Remote Desktop (RDP), Active Directory management, remote Windows execution, database connector, network scanning, security auditing, Telegram bot integration, and full audit logging.

---

## Features

- **SSH Key Vault** — AES-256-GCM encrypted keys, Ed25519/RSA-4096 generation, PuTTY PPK import/export, key rotation with automatic scheduler; per-key owner + team sharing toggle
- **Server Inventory** — Linux & Windows support, OS/host-platform auto-detection (VMware, Hyper-V, Proxmox, AWS, Azure, GCP…), per-server filters; servers sorted alphabetically; distro field (Debian, Ubuntu, CentOS, RHEL, Rocky, AlmaLinux, Fedora, openSUSE, Arch, Alpine, Kali, Proxmox, Windows variants)
- **Credential Vault** — per-server password vault for RDP, SSH users, databases, web services; reveal/copy/archive with audit log
- **Global Vault** — standalone credential store (server OS, service accounts, API keys, network devices, domain AD, email, printers, DVRs); OU grouping, tagging, archiving
- **Browser Terminal** — xterm.js multi-tab SSH, drag-and-drop SFTP upload, session recording & playback; full-screen overlay with independent xterm scrollback + Commands panel scrollbar; distro mascot panel (Tux, Ubuntu, Debian, Windows, etc.) when idle
- **Remote Desktop** — browser-based RDP via Guacamole; command panel, file sharing
- **Remote Exec** — run commands on Windows machines via PsExec, WMIExec, or WinRM; Shell is a first-class tab with live xterm.js terminal; stored-credential picker; command history; quick-command library; redesigned two-pane layout
- **DB Connector** — connect to PostgreSQL, MySQL, MariaDB, MSSQL, Oracle databases via direct or SSH-tunnel connections; query editor, schema browser, data export, per-connection SSH tunnel override; data analysis rules (row count, null rate, uniqueness, range, custom SQL, referential integrity) with cross-connection comparison
- **Domain Manager** — Active Directory management over SSH: list/search/filter users, reset passwords (syncs stored credentials), unlock accounts, enable/disable, view OUs; multi-AD cluster support with domain health panel (FSMO roles, DC status, replication failures, service checks, password policy) and force-sync
- **Linux Root SSH Setup** — two-server-type flow (existing vs new Debian/Ubuntu); vault root credential + su/sudo elevation; PermitRootLogin management; root activation; sshd status panel on Overview tab
- **Windows Server** — full OpenSSH support; Info panel shows OS, memory, CPU, hostname, domain, installed roles; RDP credentials and SSH user vault
- **Auth Keys Management** — redesigned card layout; "Set as Management" button when a user has multiple keys; inline Yes/No revoke confirmation (no browser `confirm()` dialog); management key guard blocks accidental revoke
- **Network Scanner** — LAN discovery with ping sweep, port scan (quick/standard/deep), OS/device classification, MAC address detection, OUI vendor lookup (30k+ IEEE entries), hostname resolution (NetBIOS, mDNS, LLMNR, reverse DNS), CSV export; score-based device classification for Windows PCs, routers, Linux servers, NAS, IP cameras, smart appliances, game consoles, mobile phones, and more
- **Network Diagrams** — drag-and-drop topology diagrams with 700+ MDI icons, node colour and label customisation, zoom/pan canvas, PNG export
- **Firmware & Backup** — firmware repository with TFTP server; config backup storage per device
- **Security Scanner** — checks password auth, root login, stale keys, X11 forwarding; configurable alerts
- **Best Practices** — tailored config recommendations calculated from actual RAM/CPU; includes copy-paste config snippets
- **AI Analyst** — multi-provider (Claude, GPT, Gemini, DeepSeek) server health analysis
- **Alerts** — Slack webhook, SMTP email, Telegram channel; per-event toggles
- **Telegram Bot** — query servers, control services (TOTP-gated)
- **Auth** — local email/password + MFA (TOTP), Microsoft 365 SSO, Google Workspace SSO; RBAC (admin/operator/developer/viewer); per-user MFA exemption; TOTP-gated sensitive actions
- **RADIUS** — RADIUS server management with SNMP VLAN discovery per network device
- **Operator Access Control** — admin explicitly grants which servers each operator can see; DB connections are owner-scoped with optional sharing
- **Audit Log** — append-only, CSV export, time-based clearing

---

## Quick Start

### Requirements

- Docker & Docker Compose (v2)
- No other dependencies — everything runs in containers

### 1. Clone

```bash
git clone <repo-url> ssh-manager
cd ssh-manager
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set **at minimum** these three values:

```env
SESSION_SECRET=        # any long random string (64+ chars)
VAULT_ENCRYPTION_KEY=  # 64 hex chars (32 bytes) — see generator below
BOOTSTRAP_ADMIN_EMAIL= # your email address
```

Generate both secrets in one command:

```bash
node -e "const c=require('crypto'); console.log('SESSION_SECRET=' + c.randomBytes(64).toString('hex')); console.log('VAULT_ENCRYPTION_KEY=' + c.randomBytes(32).toString('hex'))"
```

> **SSO is optional.** Leave `MS_*` and `GOOGLE_*` empty to use local email/password login only.
> The first login with `BOOTSTRAP_ADMIN_EMAIL` via local auth is automatically granted `admin` role.

### 3. Start

```bash
docker compose up -d --build
```

Open **http://localhost:3000** — sign in with your bootstrap email.

> First startup takes ~1 minute. Database migrations run automatically.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | ✅ | Long random string for session signing |
| `VAULT_ENCRYPTION_KEY` | ✅ | 64 hex chars (32 bytes) for AES-256-GCM credential encryption |
| `BOOTSTRAP_ADMIN_EMAIL` | ✅ | Email granted `admin` role on first run |
| `DATABASE_URL` | auto | Set automatically in Docker Compose |
| `REDIS_URL` | auto | Set automatically in Docker Compose |
| `GUAC_CRYPT_KEY` | ⚠️ | 32-char key for RDP token encryption — change from default |
| `MS_CLIENT_ID` | optional | Azure AD app client ID (Microsoft SSO) |
| `MS_CLIENT_SECRET` | optional | Azure AD client secret |
| `MS_TENANT_ID` | optional | Azure AD tenant ID |
| `MS_CALLBACK_URL` | optional | e.g. `https://your-domain/auth/microsoft/callback` |
| `GOOGLE_CLIENT_ID` | optional | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | optional | Google OAuth2 client secret |
| `GOOGLE_CALLBACK_URL` | optional | e.g. `https://your-domain/auth/google/callback` |
| `GOOGLE_HOSTED_DOMAIN` | optional | Restrict Google login to this domain |
| `TERMINAL_IDLE_TIMEOUT_MIN` | optional | Disconnect idle terminals after N minutes (default `30`) |
| `RECORDINGS_STORAGE_PATH` | optional | Disk path for session recordings (default `/var/lib/ssh-manager/recordings`) |
| `RATE_LIMIT_AUTH` | optional | Requests/min on auth routes (default `10`) |
| `CORS_ORIGIN` | optional | Allowed CORS origin (default `http://localhost:3000`) |

---

## Docker Services

| Service | Port | Description |
|---------|------|-------------|
| `web` | 3000 | React frontend (nginx) |
| `api` | 3001 | Fastify REST API + WebSocket |
| `guac-proxy` | internal | WebSocket ↔ guacd bridge for RDP |
| `guacd` | internal | Guacamole protocol daemon |
| `postgres` | 5433 (host) | PostgreSQL 15 |
| `redis` | 6379 (host) | Redis 7 (BullMQ job queues) |
| `ubuntu-test` | 2222 | Ubuntu 22.04 test SSH server |
| `debian-test` | 2223 | Debian 12 test SSH server |
| `tftp-server` | 69/udp | TFTP server for firmware delivery |

---

## Production Deployment

Use `docker-compose.prod.yml` which sets `restart: always` and removes exposed DB/Redis ports:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Put a reverse proxy (nginx, Caddy, Traefik) in front to terminate TLS. Update all callback URLs and `CORS_ORIGIN` to your HTTPS domain.

**Minimal nginx example:**

```nginx
server {
    listen 443 ssl;
    server_name ssh-manager.example.com;

    location / {
        proxy_pass http://localhost:3000;
    }

    location /api/ {
        proxy_pass http://localhost:3001/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## Onboarding a Server

### Linux Server

#### 1. Add in SSH Manager

Go to **Servers → Add Server**. Fill in hostname, port, environment. Use **Auto-generate management key** or select an existing key.

#### 2. Create the management user

```bash
sudo adduser sshmanager --disabled-password
sudo mkdir -p /home/sshmanager/.ssh
sudo chmod 700 /home/sshmanager/.ssh
echo "ssh-ed25519 AAAA..." | sudo tee /home/sshmanager/.ssh/authorized_keys
sudo chmod 600 /home/sshmanager/.ssh/authorized_keys
sudo chown -R sshmanager:sshmanager /home/sshmanager/.ssh
```

#### 3. Grant passwordless sudo for key management

Create `/etc/sudoers.d/sshmanager`:

```
sshmanager ALL=(ALL) NOPASSWD: /bin/mkdir, /bin/chmod, /bin/chown, /bin/touch, /usr/bin/tee, /bin/sed, /bin/cat, /bin/mv, /bin/grep
```

#### 4. Verify

Click **Verify Key** in the server row to capture the host fingerprint, then **Test Connection** to confirm.

---

### Linux Root SSH Setup

SSH Manager supports a two-phase root SSH setup that works for both existing servers (already have a management user) and new Debian/Ubuntu servers.

**Phase 1 — Management user setup (required first)**

Onboard the server with a non-root management user (e.g. `vandet` or `sshmanager`) and management key as described above. This gives SSH Manager initial access.

**Phase 2 — Root SSH setup (from Server Info → Users tab)**

Once connected via the management user:

1. **Add root password to Vault** — go to **Server Info → Vault tab**, add a credential for linux user `root` with the root password.
2. **Activate Root** (Ubuntu/Debian if root has no password) — click **Activate Root** to run `sudo passwd root` and set a password via the management user.
3. **Setup Root SSH** — click **Setup Root SSH** to:
   - Generate or use an existing SSH key for root
   - Push the key to `/root/.ssh/authorized_keys` using su/sudo elevation (no direct root SSH required)
   - Set `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config`
   - Restart the SSH service
4. **Switch management key to root** — go to **Auth Keys tab**, click **🔒 Set as Management** on the root key to make SSH Manager connect directly as root going forward.

**PermitRootLogin values:**

| Value | Meaning |
|-------|---------|
| `yes` | Root can log in with password or key |
| `prohibit-password` | Root can log in with key only (recommended) |
| `no` | Root SSH disabled |

The **Overview tab** of Server Info shows the current `PermitRootLogin` status and root account lock state with color-coded alerts.

---

### Windows Server

SSH Manager supports **Windows Server 2016, 2019, and 2022** via OpenSSH.

#### 1. Install OpenSSH Server

```powershell
# Windows Server 2019 / 2022:
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

> For Windows Server 2016, download from [github.com/PowerShell/Win32-OpenSSH](https://github.com/PowerShell/Win32-OpenSSH/releases) and run `install-sshd.ps1`.

#### 2. Allow SSH through Windows Firewall

Installing OpenSSH Server automatically creates an inbound rule named **OpenSSH SSH Server (sshd)**. Verify it is enabled, or create it manually:

```powershell
# Verify the rule exists and is enabled
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Select-Object Name, Enabled, Action

# If missing, create it manually
New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' `
  -DisplayName 'OpenSSH SSH Server (sshd)' `
  -Enabled True `
  -Direction Inbound `
  -Protocol TCP `
  -Action Allow `
  -LocalPort 22
```

> To restrict SSH access to specific management IP addresses (recommended for Domain Controllers):
> ```powershell
> New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' `
>   -DisplayName 'OpenSSH SSH Server (sshd)' `
>   -Enabled True -Direction Inbound -Protocol TCP `
>   -Action Allow -LocalPort 22 `
>   -RemoteAddress 192.168.1.10,192.168.1.11
> ```

#### 3. Set PowerShell as the default shell (recommended)

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -PropertyType String -Force
```

#### 3. Add the management key for Administrators

```powershell
New-Item -Path "C:\ProgramData\ssh" -ItemType Directory -Force
"ssh-ed25519 AAAA..." | Out-File "C:\ProgramData\ssh\administrators_authorized_keys" -Encoding utf8
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "SYSTEM:(F)" /grant "Administrators:(F)"
```

#### 4. Add in SSH Manager

**Servers → Add Server**, hostname, port `22`, OS type Windows. The Info panel auto-detects OS, hostname, domain, RAM, CPU, and installed roles when you open it.

#### What works on Windows

| Feature | Status |
|---------|--------|
| Server Info (OS, edition, build, hostname, domain, RAM, CPU, uptime) | ✅ |
| Host platform detection (Hyper-V, VMware, physical…) | ✅ |
| Installed roles & features | ✅ |
| RDP Credential Vault | ✅ |
| SSH User Credential Vault | ✅ |
| Browser Terminal (PowerShell/cmd) | ✅ |
| Session Recording | ✅ |
| SFTP file upload | ✅ |
| Key push / revoke | ✅ Admin → `administrators_authorized_keys`; regular → `~\.ssh\authorized_keys` |
| Key rotation & revert | ✅ |
| Software detection (IIS, SQL Server, .NET, Docker…) | ✅ |
| Best Practices (Windows-specific) | ✅ |
| Remote Desktop (RDP) | ✅ |
| Domain Manager | ✅ Requires server flagged as Domain Controller — see below |
| Security Scanner | ⚠️ Linux checks only |
| Service control (start/stop/restart) | ⚠️ Linux systemd only |

---

## Domain Manager

Domain Manager connects to your Active Directory Domain Controllers over SSH and runs PowerShell commands to manage users and monitor domain health.

### Setting up a Domain Controller

1. Onboard the Windows server normally (OpenSSH + management key)
2. Go to **Servers → Edit** on the DC server
3. Enable **🏢 Domain Controller** checkbox
4. Enter the **AD Domain Name** (e.g. `staff.company.local`)
5. Save — the server now appears in **Domain Manager**

Multiple DCs across different AD forests are supported. Each DC shows its domain name in the dropdown so you can switch between them.

### User Management

| Action | Description |
|--------|-------------|
| Reset Password | Generates or enters a new password, resets in AD, and automatically syncs any matching stored credentials in the vault |
| Unlock Account | Clears the lockout flag on a locked-out account |
| Enable / Disable | Toggles the account's enabled state |
| Toggle Password Expiry | Sets or clears PasswordNeverExpires |

**Password sync on reset:** when you reset a domain user's password, SSH Manager searches `server_credentials` for any stored credentials whose `linux_user` matches `domain\username` (e.g. `staff.company.local\administrator` or `staff\administrator`) and automatically updates them with the new password. Plain usernames without a domain prefix are intentionally skipped to avoid cross-domain collisions when you have multiple ADs.

### User Tabs

| Tab | Shows |
|-----|-------|
| Locked | Accounts currently locked out |
| Password Issues | Expired passwords or accounts requiring a change at next logon |
| Disabled | Disabled accounts |
| All | Full user list with OU filter and search |

### Domain Health

Click **🏥 Domain Health** to run a comprehensive check:

- **FSMO Roles** — PDC Emulator, RID Master, Infrastructure Master, Schema Master, Domain Naming Master
- **Domain Controllers** — list with GC/RODC flags, OS, site, IP
- **Replication** — failure count and per-partner failure details
- **Services** — NTDS, NETLOGON, W32Time, DNS, KDC status on the selected DC
- **Password Policy** — minimum length, complexity, history, max/min age, lockout settings
- **Forest info** — domain/forest mode, Recycle Bin feature status

If replication failures are detected, a **Force Sync** button triggers `repadmin /replicate` from the local DC to each partner.

> **Note:** Replication failure records in AD persist until the next full replication cycle confirms everything is clean, so the failure count may remain briefly after a successful sync.

---

## Auth Keys

The **Auth Keys tab** in Server Info shows all keys currently in `authorized_keys` on the server, matched against your SSH key vault.

| Badge | Meaning |
|-------|---------|
| `✓ key-name` (green) | Key is known and active in the vault |
| `🔒 Management` (blue) | This is the active management key — used for all SSH connections |
| `🗄 key-name (archived)` (orange) | Key was rotated/deleted from vault but still on server — revoke it |
| `⚠ Unknown key` (red) | Key is not in the vault — investigate |

**Set as Management** — appears when a user has more than one key on the server. Click to promote that key (and optionally switch the management Linux user) without re-doing setup.

**Revoke** — removes the key from `authorized_keys` on the server. The management key cannot be revoked — set a different management key first. Uses inline Yes/No confirmation (no browser popup).

**Assignments guard** — in the Assignments page, the Revoke button is also blocked for the active management key assignment, with both a UI disable and an API-level 409 error as a safety net.

---

## Remote Exec (Windows)

The **Remote Exec** page runs commands on Windows machines using stored credentials. Three execution methods are available:

| Method | Protocol | Port | AV Risk | Notes |
|--------|----------|------|---------|-------|
| **PsExec** | SMB | 445 | ⚠️ High — deploys a service binary | May trigger Windows Defender (VirTool:Win32/RemoteExec!pz) |
| **WMIExec** | DCOM/RPC | 135 + dynamic | ✅ Low — no binary deployed | Recommended for environments with Defender enabled |
| **WinRM** | HTTP/HTTPS | 5985 / 5986 | ✅ None — built-in Windows | Best for AD environments; requires WinRM pre-configured on targets |

### Credential picker

Remote Exec uses credentials from the **Global Vault** with category `windows`, `rdp`, or `other`. Domain credentials should have a `Domain: pvd.local` line in the Notes field, or the username stored as `domain\username`.

### Enabling WinRM on a target (one-time setup)

Use WMIExec (which requires no setup) to push WinRM configuration to the target via the **⚡ WinRM Setup via WMIExec** quick-action card in the sidebar:

```powershell
# Step 1 — Enable WinRM service + open firewall (runs on target via WMIExec)
powershell -Command "Enable-PSRemoting -Force -SkipNetworkProfileCheck"

# Step 2 — Allow Basic authentication
powershell -Command "Set-Item WSMan:\localhost\Service\Auth\Basic $true; Set-Item WSMan:\localhost\Client\Auth\Basic $true"

# Step 3 — Allow unencrypted HTTP (required for NTLM over HTTP)
powershell -Command "Set-Item WSMan:\localhost\Service\AllowUnencrypted $true; Set-Item WSMan:\localhost\Client\AllowUnencrypted $true"
```

Or run all three in one shot with the **⚡ All in one** button.

---

## GPO Configuration for Remote Exec

Use Group Policy to pre-configure WinRM and firewall rules on all domain machines at once, instead of running commands per-host.

### Option A — Enable WinRM via GPO (recommended for WinRM method)

In **Group Policy Management Console** (GPMC), create or edit a GPO linked to the target OU (e.g. `Computers > Windows Servers`).

#### 1. Start the WinRM service automatically

`Computer Configuration → Windows Settings → Security Settings → System Services`

- Find **Windows Remote Management (WS-Management)**
- Set startup mode: **Automatic**

#### 2. Allow WinRM through Windows Firewall

`Computer Configuration → Windows Settings → Security Settings → Windows Defender Firewall → Inbound Rules → New Rule`

| Setting | Value |
|---------|-------|
| Rule type | Port |
| Protocol | TCP |
| Local port | 5985 (HTTP) and/or 5986 (HTTPS) |
| Action | Allow the connection |
| Profile | Domain (+ Private if needed) |
| Name | `WinRM HTTP (SSH Manager)` |

#### 3. Configure WinRM settings via Registry GPO

`Computer Configuration → Preferences → Windows Settings → Registry`

Add these registry values:

| Hive | Key | Value name | Type | Data |
|------|-----|-----------|------|------|
| HKLM | `SOFTWARE\Policies\Microsoft\Windows\WinRM\Service` | `AllowBasic` | DWORD | `1` |
| HKLM | `SOFTWARE\Policies\Microsoft\Windows\WinRM\Service` | `AllowUnencryptedTraffic` | DWORD | `1` |
| HKLM | `SOFTWARE\Policies\Microsoft\Windows\WinRM\Client` | `AllowBasic` | DWORD | `1` |
| HKLM | `SOFTWARE\Policies\Microsoft\Windows\WinRM\Client` | `AllowUnencryptedTraffic` | DWORD | `1` |
| HKLM | `SOFTWARE\Policies\Microsoft\Windows\WinRM\Client` | `TrustedHosts` | REG_SZ | `*` (or your SSH Manager IP) |

> For production environments, restrict `TrustedHosts` to your SSH Manager server IP instead of `*`.

#### 4. Run gpupdate on targets

```powershell
gpupdate /force
```

Or wait for the next Group Policy refresh cycle (~90 minutes by default).

---

### Option B — Allow WMIExec via GPO (required for WMIExec method)

WMIExec uses DCOM over port 135 plus dynamic high ports (49152–65535). Ensure these firewall rules are applied via GPO:

`Computer Configuration → Windows Settings → Security Settings → Windows Defender Firewall → Inbound Rules → New Rule`

| Rule | Protocol | Port | Description |
|------|----------|------|-------------|
| WMI (DCOM-In) | TCP | 135 | DCOM endpoint mapper |
| WMI-In | TCP | Dynamic (49152–65535) | WMI traffic |

These rules already exist by default but are disabled. Enable them via GPO:

`Computer Configuration → Windows Settings → Security Settings → Windows Defender Firewall → Inbound Rules`

Enable the predefined rules:
- **Windows Management Instrumentation (DCOM-In)**
- **Windows Management Instrumentation (WMI-In)**
- **Windows Management Instrumentation (ASync-In)**

Or create a new port rule:

| Setting | Value |
|---------|-------|
| Rule type | Port |
| Protocol | TCP |
| Local port | 135 |
| Action | Allow the connection |
| Profile | Domain |
| Name | `WMI DCOM (SSH Manager)` |

And a second rule for dynamic ports:

| Setting | Value |
|---------|-------|
| Rule type | Port |
| Protocol | TCP |
| Local port | 49152-65535 |
| Action | Allow the connection |
| Profile | Domain |
| Name | `WMI Dynamic RPC (SSH Manager)` |

---

### Option C — Allow PsExec via GPO (if using PsExec despite AV risk)

PsExec uses SMB (port 445) and deploys a temporary service binary. These rules are typically already open on domain machines.

`Computer Configuration → Windows Settings → Security Settings → Windows Defender Firewall → Inbound Rules`

Enable the predefined rule:
- **File and Printer Sharing (SMB-In)** — TCP 445

To suppress Windows Defender alerts for the impacket service binary (not recommended for production), add an exclusion via GPO:

`Computer Configuration → Administrative Templates → Windows Components → Microsoft Defender Antivirus → Exclusions → Process Exclusions`

Add: `%SystemRoot%\psexec*.exe` (or the specific service name pattern `psexec_*.exe`).

> **Recommendation:** Use WMIExec or WinRM instead of PsExec to avoid AV conflicts.

---

## DB Connector

The **DB Connector** page manages database connections and runs queries across PostgreSQL, MySQL, MariaDB, MSSQL, and Oracle databases.

### Connection types

| Mode | Description |
|------|-------------|
| **Direct** | Connects straight to the database host:port — no server required |
| **SSH Tunnel** | Routes the connection through a linked server's SSH session (for databases behind a firewall) |

Each connection can override the tunnel mode at runtime using the **🔒 SSH Tunnel / 🌐 Direct** toggle in the connection header — without editing the saved connection.

### Server filter

The sidebar has a server filter dropdown to narrow the connection list by linked server. Connections with no linked server appear under **Direct**.

### Data Analysis

Each connection has an **Analysis** tab with configurable data quality rules:

| Rule type | What it checks |
|-----------|---------------|
| `row_count` | Total rows in a table (with min/max thresholds) |
| `null_rate` | Percentage of NULLs in a column |
| `uniqueness` | Percentage of distinct values in a column |
| `range` | Min/max numeric values |
| `custom_sql` | Any SQL that returns a single numeric value |
| `referential` | Orphaned rows across two tables (FK integrity) |

Rules run individually or all at once with **Run All**. Results show ✅ pass / ❌ fail / ⚠️ warning. The **Compare** section runs the same COUNT query on the same table across two connections to verify data consistency between environments (e.g. prod vs. staging).

---

## Network Scanner

The **Network Scanner** page discovers and fingerprints every device on your LAN.

### Scan modes

| Mode | Ports scanned | Use case |
|------|--------------|---------|
| **Quick** | ~40 common ports | Fast overview in seconds |
| **Standard** | ~200 ports | Balanced coverage |
| **Deep** | 1–65535 | Full scan (slow) |
| **Custom** | Port range you specify | Targeted scans |

### What it detects

| Signal | How |
|--------|-----|
| **IP / latency** | ICMP ping sweep |
| **TTL** | Extracted from ping reply (Linux ≈ 64, Windows ≈ 128, Cisco ≈ 255) |
| **Open ports + banners** | TCP connect with optional banner grab |
| **MAC address** | `/proc/net/arp` → `arping` → `arp -n` fallback chain |
| **OUI vendor** | 30k+ entry IEEE database (downloaded once, cached 30 days) |
| **Hostname** | NetBIOS UDP 137 → mDNS unicast/multicast → LLMNR → reverse DNS |
| **OS / device type** | Score-based classification using vendor, ports, banners, hostname, TTL |

### Device types classified

Windows PC, Router/Gateway, Linux/Unix, Printer, Smart TV/Media, IP Camera, NAS/Storage, Game Console, VoIP/Phone, IoT/MQTT, iPhone/iPad, Android Phone, Smart Appliance, Mobile Phone (unknown)

### Privacy MAC detection

Devices using randomized MAC addresses (iOS 14+, Android 10+, Windows 10+) are detected via the locally-administered bit and shown as **"randomized (privacy MAC)"** — the device is classified as **Mobile Phone** unless a port or hostname confirms iPhone vs Android.

### Scan results

- Live streaming via SSE — each host appears as it is scanned
- Expand any row to see open ports with service names and banners
- CSV export includes IP, hostname, MAC, vendor, OS hint, latency, ports
- Results persist until a new scan starts

### Production deployment note

MAC address detection and mDNS/LLMNR hostname resolution require the API container to run on the host network stack so it can read the physical ARP table and send multicast packets. On a real Linux server, set the following in `docker-compose.yml`:

```yaml
api:
  network_mode: host
  cap_add:
    - NET_ADMIN
    - NET_RAW
  environment:
    - DATABASE_URL=postgresql://sshmanager:password@127.0.0.1:5433/sshmanager
    - REDIS_URL=redis://127.0.0.1:6379

web:
  extra_hosts:
    - "host.docker.internal:host-gateway"
```

And in `apps/web/nginx.conf`, change `proxy_pass http://api:3001/` to `http://host.docker.internal:3001/`.

> **Docker Desktop on Windows/Mac:** `network_mode: host` runs inside a VM and does not reach the physical LAN. MAC addresses and multicast hostnames are unavailable in this environment. IP/port scanning and NetBIOS/reverse-DNS resolution still work.

---

## Network Diagrams

The **Diagrams** page lets you draw and save network topology diagrams.

- **700+ MDI icons** — servers, switches, firewalls, routers, phones, cameras, printers, and more
- **Drag-and-drop canvas** — add nodes, connect them with labelled edges, move freely
- **Node customisation** — icon, label, colour
- **Zoom / pan** — mouse wheel zoom, drag to pan
- **PNG export** — download the diagram as an image
- **Auto-save** — diagrams saved to the database, persist across sessions

---

## SSO Configuration (Optional)

### Microsoft 365 (Azure AD)

1. Azure Portal → **Azure Active Directory → App registrations → New registration**
2. Redirect URI (Web): `https://your-domain/auth/microsoft/callback`
3. **Certificates & secrets** → New client secret
4. Copy **Client ID** → `MS_CLIENT_ID`, **Tenant ID** → `MS_TENANT_ID`, secret → `MS_CLIENT_SECRET`
5. API permissions: ensure `openid`, `profile`, `email` are granted

### Google Workspace

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth 2.0 Client ID**
2. Redirect URI: `https://your-domain/auth/google/callback`
3. Copy **Client ID** → `GOOGLE_CLIENT_ID`, **Client secret** → `GOOGLE_CLIENT_SECRET`
4. Set `GOOGLE_HOSTED_DOMAIN` to restrict logins to your org domain

---

## Credential Vault

Each server stores credentials encrypted with AES-256-GCM. For Windows servers:

- **RDP Credentials tab** — username, domain, password for Remote Desktop connections
- **SSH Users tab** — username + password for OpenSSH connections; supports archived credential reveal

For Linux servers, the **Vault tab** stores Linux users, databases, web services, and more.

Archived credentials (both RDP and SSH) remain in the vault with a **Reveal** button — passwords are never lost on archive, only on permanent delete.

### Global Vault

The standalone **Vault** page stores credentials not tied to a specific server — domain admin accounts, service accounts, API keys, network device logins, email accounts, printers, DVRs, and more. Entries can be tagged, grouped by OU, and linked to a server credential for cross-reference.

---

## Key Rotation

| Policy | Rotates every |
|--------|--------------|
| `manual` | Never (manual trigger only) |
| `7d` | 7 days |
| `30d` | 30 days |
| `90d` | 90 days |
| `180d` | 6 months |
| `365d` | 1 year |

Rotation runs automatically on API startup and every hour. On failure, the new key is rolled back from all servers that received it and an alert is sent.

---

## Alerts

SSH Manager can push alerts to three channels simultaneously. Each alert event can be individually enabled or disabled from **Settings → Alerts**.

### Alert events

| Event | When it fires |
|-------|--------------|
| `rotation_failed` | SSH key rotation fails on a server |
| `rotation_success` | Key rotation completes successfully |
| `security_critical` | Security scan finds a critical issue |
| `security_high` | Security scan finds a high-severity issue |
| `key_expiring` | A key is nearing its rotation deadline |
| `login_failed` | Failed login attempt to SSH Manager |
| `new_login` | Successful new login to SSH Manager |
| `server_unreachable` | A server stops responding |
| `key_revoked` | An SSH key is revoked |
| `user_deactivated` | A user account is deactivated |

---

### Slack / Teams Webhook

Sends a color-coded attachment message to any Slack channel or Microsoft Teams connector. Both use the same Slack-compatible payload format.

**Setup (Slack):**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch** → give it a name and pick your workspace
2. In the left sidebar click **Incoming Webhooks** → toggle **On**
3. Click **Add New Webhook to Workspace** → pick a channel (e.g. `#alerts`) → click **Allow**
4. The webhook URL appears at the bottom of the page — copy it (looks like `https://hooks.slack.com/services/T.../B.../...`)
5. In SSH Manager go to **Settings → Alerts** → enable **Webhook Alerts** → paste the URL → **Save**

> Slack's free plan supports Incoming Webhooks with no restrictions.

**Setup (Microsoft Teams):**

1. In Teams, open the channel → **…** → **Connectors** → search **Incoming Webhook** → **Configure**
2. Give it a name, optionally upload an icon → **Create**
3. Copy the generated URL
4. Paste it into SSH Manager **Settings → Alerts → Webhook URL** — same field as Slack

**Setup (Discord — free, no account limits):**

1. In Discord, open a channel → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook** → copy URL
2. Append `/slack` to the URL: `https://discord.com/api/webhooks/.../slack`
3. Paste into SSH Manager **Settings → Alerts → Webhook URL**

Alerts are sent as colored Slack attachments:
- 🔴 Red — critical
- 🟡 Yellow — warning
- 🔵 Blue — info

---

### SMTP Email

Sends a styled HTML email to one or more recipients.

In **Settings → Alerts → Email**:

| Field | Example |
|-------|---------|
| SMTP host | `smtp.gmail.com` |
| SMTP port | `587` |
| Secure (TLS) | off for port 587 (STARTTLS), on for 465 |
| Username | your email address |
| Password | app password (not your login password) |
| From address | `alerts@yourcompany.com` |
| Recipients | comma-separated list of emails |

> For Gmail, generate an **App Password** at myaccount.google.com → Security → 2-Step Verification → App passwords.

---

### Telegram Alert Channel

Sends a Markdown-formatted message to a Telegram chat or channel using the same bot token as the Telegram Bot feature.

In **Settings → Alerts → Telegram**:
1. Enable and enter the **Alert Chat ID** (can be the same or a different chat from the bot)
2. Save — alerts will be sent to that chat alongside any bot commands

---

## Telegram Bot

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Go to **Settings → Telegram** in SSH Manager
3. Enable, paste the token, generate a TOTP secret, add your chat ID
4. Save — bot starts within 30 seconds

| Command | Description |
|---------|-------------|
| `/servers` | List all servers |
| `/status <server>` | OS, uptime, memory, users |
| `/software <server>` | Installed software and service status |
| `/restart <service> <server>` | Restart a service (requires TOTP) |
| `/stop <service> <server>` | Stop a service (requires TOTP) |
| `/start <service> <server>` | Start a service (requires TOTP) |

---

## Architecture

```
ssh-manager/
├── apps/
│   ├── api/                   # Fastify API (Node.js + TypeScript)
│   │   └── src/
│   │       ├── db/
│   │       │   ├── client.ts  # Kysely PostgreSQL client
│   │       │   └── migrations/
│   │       ├── modules/       # auth, users, servers, keys, assignments,
│   │       │                  # rotation, terminal, credentials, security,
│   │       │                  # logs, settings, telegram, rdp, share,
│   │       │                  # commands, vault, domain, psexec,
│   │       │                  # db-connector, db-analysis, network-scan,
│   │       │                  # diagrams, firmware-repo, config-backup
│   │       └── utils/         # vault, ssh, windows-ssh, virt-detect,
│   │                          # key-ops, ppk, recommendations, alerts, audit
│   ├── web/                   # React + Vite + Tailwind CSS
│   │   └── src/
│   │       ├── api/client.ts  # Typed fetch client + all TypeScript types
│   │       └── pages/         # Dashboard, Servers, Keys, Assignments,
│   │                          # Terminal, RemoteDesktop, Logs, Security,
│   │                          # Users, Settings, Migration, FileManager,
│   │                          # NetworkDevices, CommandLibrary, Vault, Domain,
│   │                          # PsExec (Remote Exec), DbConnector,
│   │                          # NetworkScan, Diagrams, FirmwareRepo
│   └── guac-proxy/            # WebSocket ↔ guacd bridge (RDP)
├── services/
│   └── tftp/                  # Alpine TFTP server for firmware delivery
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env
```

---

## Development

```bash
npm install
npm run dev   # starts api (port 3001) + web (port 3000) concurrently
```

Rebuild after changes:

```bash
docker compose build web api && docker compose up -d web api
```

---

## Database Migrations

Migrations run automatically on startup. Current schema version: **041**.

| Migration | What it adds |
|-----------|-------------|
| `001` | Core tables: users, servers, ssh_keys, assignments, recordings, audit_logs, rotation_jobs |
| `002` | Local auth: password hash, MFA, backup codes, login attempts |
| `003` | Key archiving: archived_at, reason, purge_after, successor/predecessor |
| `004` | Server credential vault |
| `005` | Credential archiving |
| `006` | Credential categories (linux, database, web, application, service, other) |
| `007` | Settings table (password policy) |
| `008` | Telegram bot config |
| `009` | Alert notification settings |
| `010` | `os_type` on servers (linux / windows) |
| `011` | `host_type` + `host_type_detail` (VMware, Proxmox, AWS…) |
| `012` | Rotation policy: adds 180d and 365d options |
| `013` | Auth hardening |
| `014` | Migration snapshots |
| `015` | Windows RDP credential columns |
| `016` | Device type column |
| `017` | Command library |
| `018` | PingCastle report storage (table retained; feature removed from UI) |
| `019` | Global vault entries table |
| `020` | Vault OU grouping |
| `021` | Vault entry archiving |
| `022` | `is_domain_controller` flag on servers |
| `023` | DB Connector: `db_connections` table (server_id nullable, ssh tunnel support) |
| `024` | `db_connections.server_id` made nullable (direct connections without a linked server) |
| `025` | DB Analysis: `db_analysis_rules` + `db_analysis_results` tables |
| `026` | Network diagrams: `network_diagrams` table (nodes, edges JSON) |
| `027` | Network device access: per-device credential linkage |
| `028` | Drop environment check constraint |
| `029` | SNMP profiles, ping settings, firmware columns on network devices |
| `030` | Firmware repository: `firmware_files` table |
| `031` | Share pins: PIN-protected file share links |
| `032` | TOTP action rules: per-action TOTP elevation enforcement |
| `033` | RADIUS servers table |
| `034` | SNMP VLANs, RADIUS discovery columns on network devices |
| `035` | Role permissions: per-role granular permission table |
| `036` | SSH key ownership + team sharing (`owner_id`, `is_shared`) |
| `037` | Operator server access: admin-controlled per-server visibility for operators |
| `038` | DB connection ownership + sharing |
| `039` | MFA exemption per user (`mfa_exempt` flag) |
| `040` | Domain credential columns on key assignments |
| `041` | Server distro field (Debian, Ubuntu, CentOS, RHEL, etc.) |
