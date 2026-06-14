# SSH Manager

A production-ready, self-hosted web platform for centralizing SSH key management, credential rotation, browser-based terminal access, security auditing, configuration best-practice analysis, Telegram bot integration, and full audit logging.

---

## Features

### Authentication & Access Control
- **SSO authentication** — Microsoft 365 (Azure AD) and Google Workspace via OIDC
- **Local auth** — email/password with configurable password policy
- **MFA enforcement** — TOTP (Google Authenticator, Authy) with backup codes
- **RBAC** — `admin`, `operator`, `developer`, `viewer` roles
- **Self-protection** — admins cannot change their own role or deactivate their own account

### SSH Key Management
- **SSH key vault** — AES-256-GCM encrypted private keys at rest
- **Key generation** — Ed25519 and RSA-4096
- **PuTTY (.ppk) import** — v2 and v3, with or without passphrase, auto-converted to OpenSSH
- **Key download** — public key (`.pub`) or private key in **OpenSSH** or **PuTTY PPK v2** format (admin/operator only, audit-logged)
- **Key archiving & rotation** — safe two-phase commit with rollback; scheduled via BullMQ
- **Automatic rotation** — keys with a rotation policy are rotated automatically when due; scheduler runs on API startup and every hour
- **Rotation policies** — `manual`, `7d`, `30d`, `90d`, `180d` (6 months), `365d` (1 year)
- **Rotation status badges** — 🔴 Overdue, ⚠️ Due soon (within 3 days) in the key list
- **Key assignments** — assign keys to users per-server with optional expiry and terminal access flag
- **Authorized key audit** — view and revoke keys installed on live servers

### Server Management
- **Server inventory** — hostname, environment tags, host key fingerprint verification, creation date, last connected timestamp
- **OS detection** — auto-detected on first Info scan; 🐧 Linux or 🪟 Windows badge in the server list
- **Host platform detection** — auto-detects VMware, Hyper-V, Proxmox, KVM/QEMU, VirtualBox, Xen, LXC, Docker, AWS, Azure, GCP, or physical hardware; shown as a badge in the server list and Info overview
- **Multi-OS support** — Linux (any distro) and **Windows Server 2016/2019/2022** via OpenSSH
- **Server Info panel** — live OS info, uptime, memory, CPU count, logged-in users; Windows also shows edition, build number, hostname, domain, and installed roles/features
- **Server credentials** — per-server password vault (Linux users, databases, web services, etc.) with reveal/copy/archive/verify
- **Software detection** — detect installed PHP, Node, Python, Nginx, Apache, MySQL, PostgreSQL, Redis, Docker, IIS, SQL Server, .NET, and more via SSH; service start/stop/restart from the UI
- **Security scanner** — checks password auth, root login, authorized_keys permissions, stale keys, X11 forwarding, with configurable alert channels
- **Best Practices** — per-server configuration recommendations tailored to detected software and actual RAM/CPU; includes ready-to-paste config snippets

### Windows Server Support
- Full authorized key management via OpenSSH (`administrators_authorized_keys` for admin users, `~\.ssh\authorized_keys` for regular users)
- Correct Windows file permissions set automatically via `icacls`
- Key rotation, revert, and assignment push/revoke all work on Windows
- User enumeration via `Get-LocalUser` for the Assignments UI

### Terminal
- **Browser terminal** — xterm.js + WebSocket SSH proxy with session recording (asciinema v2)
- **Multi-tab sessions** — open multiple independent SSH sessions simultaneously in one browser window
- **Drag & drop file upload** — drop any file onto the terminal to SFTP-upload it to the server
- **Terminal search** — Ctrl+F in-terminal search with regex and case-sensitive options
- **Session recordings** — all sessions recorded and replayable from Logs page with in-browser asciinema player

### Logs & Audit
- **Full audit log** — append-only, all actions logged with user, IP, and resource
- **CSV export** — download filtered audit log
- **Time-based clearing** — clear logs/recordings older than 30 / 60 / 90 days, or all entries (admin-only dropdown)
- **Session recordings** — in-browser asciinema playback; per-session download as `.cast` file; admin delete
- **Private key download audit** — every download of a private key writes an audit log entry with the format used (OpenSSH or PPK)

### Alert Notifications
- **Slack webhook** — post critical/high findings and events to a Slack channel
- **SMTP email** — HTML alert emails with severity colour coding
- **Telegram alert channel** — push alerts to a Telegram chat (separate from bot commands)
- **Per-event toggles** — independently enable/disable: rotation_failed, security_critical, security_high, key_expiring, login_failed, server_unreachable, key_revoked, key_created, assignment_created, user_created
- **Test buttons** — verify webhook and email delivery from the Settings page

### Telegram Bot
- **Telegram bot integration** — query servers, software status, and control services from Telegram
- **TOTP-gated critical actions** — `/restart`, `/stop`, `/start` require a one-time authenticator code
- **Commands**: `/help`, `/servers`, `/status <server>`, `/software <server>`, `/restart|stop|start <service> <server>`
- **Allowed chat whitelist** — restrict bot to specific chat IDs

### Dashboard
- Real-time counts: servers, active SSH keys, assignments, security issues
- Recent audit events with full date + time
- Keys due for rotation in the next 7 days
- Security findings summary by severity (counts individual failed findings, not scan records)

---

## Architecture

```
ssh-manager/
├── apps/
│   ├── api/                        # Fastify API (Node.js + TypeScript)
│   │   └── src/
│   │       ├── db/
│   │       │   ├── client.ts       # Kysely PostgreSQL client + table types
│   │       │   └── migrations/     # 001_initial … 012_rotation_policy
│   │       ├── modules/
│   │       │   ├── auth/           # SSO (Microsoft/Google), local auth, MFA
│   │       │   ├── users/          # User CRUD, role management, self-edit protection
│   │       │   ├── servers/        # Server CRUD, server-info, software detection, recommendations
│   │       │   ├── keys/           # Key generation, import, archive, purge, download (public/private/PPK)
│   │       │   ├── assignments/    # Key-to-user-server assignments (Linux + Windows aware)
│   │       │   ├── rotation/       # BullMQ rotation jobs, auto-scheduler
│   │       │   ├── terminal/       # WebSocket SSH proxy + SFTP upload
│   │       │   ├── credentials/    # Server credential vault
│   │       │   ├── security/       # Security scanner
│   │       │   ├── logs/           # Audit log + session recordings (CRUD + download + time-based clear)
│   │       │   ├── settings/       # Password policy, alert settings, Telegram config
│   │       │   └── telegram/       # Telegram bot long-polling
│   │       └── utils/
│   │           ├── vault.ts        # AES-256-GCM encryption/decryption
│   │           ├── ssh.ts          # SSH exec helper
│   │           ├── server-ssh.ts   # Shared SSH helper (management key + fallback)
│   │           ├── key-ops.ts      # OS-aware authorized_keys operations (Linux + Windows)
│   │           ├── windows-ssh.ts  # Windows Server OS detection, info gathering, software detection
│   │           ├── windows-key-ops.ts  # Windows OpenSSH key push/remove/list via PowerShell
│   │           ├── virt-detect.ts  # Hypervisor/cloud platform detection (Linux + Windows)
│   │           ├── ppk-export.ts   # OpenSSH → PuTTY PPK v2 converter
│   │           ├── recommendations.ts  # Best-practice engine (Linux + Windows)
│   │           ├── alerts.ts       # Multi-channel alert dispatcher (Slack/email/Telegram)
│   │           └── audit.ts        # Audit log writer
│   └── web/                        # React + Vite + Tailwind CSS
│       └── src/
│           ├── api/client.ts       # Typed fetch API client + all TypeScript types
│           └── pages/
│               ├── Dashboard.tsx   # Stats, audit events, rotation due, security summary
│               ├── Servers.tsx     # Server list (OS + host platform badges), info panel, credentials, software, best practices
│               ├── Keys.tsx        # SSH key management, rotation status badges, download dropdown (pub/OpenSSH/PPK)
│               ├── Assignments.tsx # Key assignments
│               ├── Users.tsx       # User management (self-edit protection)
│               ├── Terminal.tsx    # Multi-tab xterm.js + drag-and-drop SFTP
│               ├── Security.tsx    # Security scanner
│               ├── Logs.tsx        # Audit log + session recording playback/download/delete + time-based clear
│               └── Settings.tsx    # Password policy, alert notifications, Telegram bot config
├── docker-compose.yml
└── .env
```

---

## Docker Services

| Service | Port | Description |
|---------|------|-------------|
| `web` | 3000 | React SPA (nginx) |
| `api` | 3001 | Fastify REST API + WebSocket |
| `postgres` | 5433 (host) | PostgreSQL 15 |
| `redis` | 6379 | Redis 7 (BullMQ queues) |
| `ubuntu-test` | 2222 | Ubuntu 22.04 test SSH server |
| `debian-test` | 2223 | Debian 12 test SSH server |

---

## Quick Start

### Prerequisites

- Docker & Docker Compose
- An Azure AD app registration **or** a Google OAuth2 app (or both)

### 1. Clone and configure

```bash
cp .env.example .env
# Edit .env — fill in at minimum:
#   SESSION_SECRET           (64 random chars)
#   VAULT_ENCRYPTION_KEY     (64 hex chars = 32 bytes)
#   BOOTSTRAP_ADMIN_EMAIL
#   MS_* or GOOGLE_* SSO credentials
```

Generate a vault key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Start

```bash
docker compose up --build
```

- Frontend: http://localhost:3000
- API: http://localhost:3001
- Migrations run automatically on first startup.

### 3. First login

Sign in via SSO with the email in `BOOTSTRAP_ADMIN_EMAIL`. You will be granted the `admin` role automatically.

---

## Environment Variables

| Variable | Description |
|---|---|
| `SESSION_SECRET` | 32+ char random string for session signing |
| `VAULT_ENCRYPTION_KEY` | 64 hex chars (32 bytes) for AES-256-GCM key encryption |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `MS_CLIENT_ID` | Azure AD app client ID |
| `MS_CLIENT_SECRET` | Azure AD app client secret |
| `MS_TENANT_ID` | Azure AD tenant ID |
| `MS_CALLBACK_URL` | Must match redirect URI in Azure AD app registration |
| `GOOGLE_CLIENT_ID` | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth2 client secret |
| `GOOGLE_CALLBACK_URL` | Must match redirect URI in Google Cloud Console |
| `GOOGLE_HOSTED_DOMAIN` | Restrict login to this domain (e.g. `yourcompany.com`) |
| `BOOTSTRAP_ADMIN_EMAIL` | Email pre-seeded as admin on first run |
| `TERMINAL_IDLE_TIMEOUT_MIN` | Disconnect terminal after N minutes of inactivity (default 30) |
| `RECORDINGS_STORAGE_PATH` | Disk path for asciinema session recordings |
| `RATE_LIMIT_AUTH` | Requests/minute on `/auth/*` routes (default 10) |
| `CORS_ORIGIN` | Allowed CORS origin for the frontend |

---

## SSO Configuration

### Microsoft 365 (Azure AD)

1. **Azure Portal → Azure Active Directory → App registrations → New registration**
2. Name: `SSH Manager`, account type: **This organizational directory only**
3. Redirect URI (Web): `https://your-domain/auth/microsoft/callback`
4. **Certificates & secrets** → New client secret
5. Copy **Application (client) ID** → `MS_CLIENT_ID`
6. Copy **Directory (tenant) ID** → `MS_TENANT_ID`
7. Copy secret value → `MS_CLIENT_SECRET`
8. **API permissions**: ensure `openid`, `profile`, `email` are granted

### Google Workspace

1. **Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID**
2. Application type: **Web application**
3. Authorised redirect URIs: `https://your-domain/auth/google/callback`
4. Copy **Client ID** → `GOOGLE_CLIENT_ID`
5. Copy **Client secret** → `GOOGLE_CLIENT_SECRET`
6. Set `GOOGLE_HOSTED_DOMAIN` to your org domain to restrict logins

---

## Onboarding a Server

### Linux Server

#### 1. Register in SSH Manager

Go to **Servers → Add Server** and fill in hostname, port, and environment. SSH Manager can **auto-generate a management key** for you during setup.

#### 2. Create the management user on the server

```bash
sudo adduser sshmanager --disabled-password
sudo mkdir -p /home/sshmanager/.ssh && sudo chmod 700 /home/sshmanager/.ssh
echo "ssh-ed25519 AAAA..." | sudo tee /home/sshmanager/.ssh/authorized_keys
sudo chmod 600 /home/sshmanager/.ssh/authorized_keys
sudo chown -R sshmanager:sshmanager /home/sshmanager/.ssh
```

#### 3. Grant sudo access for key management

```bash
# /etc/sudoers.d/sshmanager
sshmanager ALL=(ALL) NOPASSWD: /bin/mkdir, /bin/chmod, /bin/chown, /bin/touch, /usr/bin/tee, /bin/sed, /bin/cat, /bin/mv, /bin/grep
```

#### 4. Verify

Click **Verify Key** in the server row to capture the host fingerprint, then **Test Connection** to confirm SSH access.

> **Docker test servers**: Use hostname `ubuntu-test` (port `22`) or `debian-test` (port `22`) from within the Docker network. From your host machine, use `localhost:2222` / `localhost:2223`.

---

### Windows Server

SSH Manager supports **Windows Server 2016, 2019, and 2022** via the built-in OpenSSH Server.

#### 1. Install OpenSSH Server on Windows

```powershell
# Windows Server 2019 / 2022 — install via Optional Features:
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Start and set to auto-start:
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# Allow through Windows Firewall (done automatically by installer):
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True `
  -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

> For **Windows Server 2016**, download the OpenSSH release from [github.com/PowerShell/Win32-OpenSSH](https://github.com/PowerShell/Win32-OpenSSH/releases) and run `install-sshd.ps1`.

#### 2. Configure admin authorized_keys

OpenSSH on Windows stores keys for Administrators group members in a central file:

```powershell
# Create the admin authorized_keys file:
New-Item -Path "C:\ProgramData\ssh" -ItemType Directory -Force
"ssh-ed25519 AAAA..." | Out-File -FilePath "C:\ProgramData\ssh\administrators_authorized_keys" -Encoding utf8

# Set permissions (must be owned by SYSTEM or Administrators, no other access):
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "SYSTEM:(F)" /grant "Administrators:(F)"
```

> Regular (non-admin) users get their keys in `C:\Users\<username>\.ssh\authorized_keys` — SSH Manager handles this automatically.

#### 3. Set default shell to PowerShell (recommended)

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```

#### 4. Register in SSH Manager

Go to **Servers → Add Server**, fill in hostname, port `22`, and environment. The OS type (🪟 Windows) is auto-detected the first time you open the **Info** panel.

#### What works on Windows

| Feature | Supported |
|---------|-----------|
| Test Connection / Verify Key | ✅ |
| Server Info (OS, RAM, CPU, uptime, users) | ✅ |
| Windows roles & features list | ✅ |
| Software detection (IIS, SQL Server, MySQL, PostgreSQL, Redis, .NET, Node.js, PHP, Docker…) | ✅ |
| Best Practices tab | ✅ Windows-specific recommendations |
| Browser Terminal | ✅ (PowerShell or cmd) |
| Session Recording | ✅ |
| SFTP file upload | ✅ |
| Key push / revoke (assignments) | ✅ Admin users → `administrators_authorized_keys`; regular users → `~\.ssh\authorized_keys` |
| Key rotation & revert | ✅ Full rotation pipeline works on Windows |
| User list (for Assignments UI) | ✅ via `Get-LocalUser` |
| Service control (start/stop/restart) | ⚠️ Linux systemd only; Windows services via `sc` planned |
| Security Scanner | ⚠️ Linux checks only; Windows checks planned |

---

## SSH Key Download

On the **SSH Keys** page, each key has a **↓ Download ▾** dropdown:

| Option | Available to | Format |
|--------|-------------|--------|
| 📄 Public Key (.pub) | All roles | `ssh-ed25519 AAAA… name` (authorized_keys line) |
| 🔑 OpenSSH format | Admin, Operator | `-----BEGIN OPENSSH PRIVATE KEY-----` |
| 🐢 PuTTY PPK format | Admin, Operator | PuTTY-User-Key-File-2 (unencrypted, load directly in PuTTY/WinSCP) |

Every private key download is written to the audit log with the format used.

---

## Key Rotation

### Rotation Policies

| Policy | Auto-rotates every |
|--------|-------------------|
| `manual` | Never (trigger manually via Rotate button) |
| `7d` | 7 days |
| `30d` | 30 days |
| `90d` | 90 days |
| `180d` | 180 days (6 months) |
| `365d` | 365 days (1 year) |

### How it works

1. Key is generated or imported with a rotation policy
2. `next_rotation_at` is set to `now + policy_days`
3. On API **startup** and every **hour**, the scheduler queries all active keys where `next_rotation_at <= NOW()`
4. Due keys are enqueued in BullMQ and processed by the rotation worker:
   - Generates a new key pair
   - Pushes new key to all assigned servers (Linux bash or Windows PowerShell, automatically)
   - On success: removes old key, archives old key (kept 30 days for revert), re-points all assignments
   - On failure: rolls back (removes newly-added key from succeeded servers), sends alert
5. The old key stays in **Archived Keys** for 30 days, with a **↩ Revert** option

### Status badges in the UI

| Badge | Meaning |
|-------|---------|
| 🔴 **Overdue** | `next_rotation_at` is in the past — scheduler will process within 1 hour |
| ⚠️ **Soon** | Due within 3 days |
| Date (white) | Scheduled, not yet due |
| — | Manual policy, no schedule |

---

## Best Practices

Open any server's **Info** panel and click the **💡 Best Practices** tab. SSH Manager SSHes in, reads RAM, CPU count, and detects installed software, then generates tailored recommendations.

### What is analysed

| Software | Topics |
|----------|--------|
| **System (Linux)** | vm.swappiness, file descriptors, TCP tuning, fail2ban, UFW, unattended-upgrades |
| **System (Windows)** | Automatic updates, Firewall, RDP/NLA hardening, SMBv1 disable, PowerShell logging, Defender, password policy, audit logging |
| **Nginx** | worker_processes, gzip, server_tokens, security headers, rate limiting, TLS 1.2/1.3 |
| **Apache** | MaxRequestWorkers, KeepAlive, ServerTokens, mod_evasive, directory listing |
| **IIS (Windows)** | Request Filtering, Server header, App Pool identity, TLS hardening, compression, output caching |
| **PHP** | memory_limit, OPcache, expose_php, display_errors, upload limits, session security, PHP-FPM pm tuning |
| **MySQL / MariaDB** | innodb_buffer_pool_size, max_connections, slow query log, binary logging, bind-address, root security |
| **SQL Server (Windows)** | max server memory, MAXDOP, auto-grow sizing, backup strategy, SA account, least-privilege logins |
| **PostgreSQL** | shared_buffers, effective_cache_size, work_mem, WAL config, PgBouncer, SCRAM auth |
| **Redis** | maxmemory, eviction policy, requirepass, bind, persistence, dangerous command renaming |
| **Docker** | rootless mode, log rotation, resource limits, --privileged containers |

All numeric values (buffer pool size, worker counts, memory caps) are **calculated from your server's actual RAM and CPU count**.

Each recommendation includes:
- Severity badge (CRITICAL / HIGH / MEDIUM / LOW / INFO)
- Category filter (Security / Performance / Stability / Monitoring)
- *Why* it matters
- Ready-to-paste config snippet with a **⎘ Copy** button
- Link to official documentation

---

## Host Platform Detection

SSH Manager auto-detects what the server is running on, shown as a badge in the server list and the Info Overview tab.

| Platform | Detection method |
|----------|-----------------|
| VMware | `systemd-detect-virt`, DMI `sys_vendor` / `product_name` |
| Hyper-V | `systemd-detect-virt`, DMI chassis vendor, WMI on Windows |
| Proxmox | QEMU vendor + `qemu-guest-agent` active |
| KVM / QEMU | `systemd-detect-virt = kvm`, QEMU product string |
| VirtualBox | `innotek` vendor or `VBoxService` on Windows |
| Xen | `systemd-detect-virt = xen`, Xen DMI strings |
| LXC | `/proc/1/cgroup`, `systemd-detect-virt = lxc` |
| Docker | `/.dockerenv` present, `docker` in `/proc/1/cgroup` |
| AWS | IMDS `169.254.169.254/latest/meta-data/instance-type` |
| Azure | IMDS with `Metadata: true` header |
| GCP | IMDS with `Metadata-Flavor: Google` header |
| Physical | No hypervisor flags, real vendor in DMI (Dell, HP, Lenovo, Supermicro…) |

Detection runs in the background when you open a server's Info panel and is saved to the database — subsequent visits show the badge instantly without re-scanning.

---

## Importing PuTTY Keys (.ppk)

SSH Manager natively supports PuTTYgen `.ppk` files:

1. **Keys → Import Key**
2. Drag your `.ppk` file or paste the key content
3. Enter passphrase if the key is protected
4. Supported: **PPK v2** (PuTTY ≤ 0.74) and **PPK v3** (PuTTY ≥ 0.75), Ed25519 and RSA

---

## Logs

### Audit Log
- Filterable by action string
- Export to CSV (**Export CSV** button, admin)
- **🗑 Clear Logs ▾** dropdown (admin) — choose to delete entries older than 30 / 60 / 90 days, or all entries

### Session Recordings
- In-browser asciinema playback (click **▶ Play**)
- **↓ Download** — saves `.cast` file as `session-<date>-<id>.cast` for offline playback
- **Delete** — admin-only, removes recording and its file from disk
- **🗑 Clear Recordings ▾** dropdown (admin) — delete recordings older than 30 / 60 / 90 days, or all

To play a `.cast` file locally:
```bash
pip install asciinema
asciinema play session-2026-06-14T10-30-00-abc12345.cast
```

---

## Telegram Bot Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Go to **Settings → Telegram** in SSH Manager
3. Enable the bot, paste the token
4. Click **Generate TOTP Secret** and scan the QR code with your authenticator app
5. Add your Telegram chat ID to the allowed list (get it from [@userinfobot](https://t.me/userinfobot))
6. Save — the bot starts within 30 seconds

### Bot Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/servers` | List all active servers |
| `/status <server>` | Show OS, uptime, memory, users |
| `/software <server>` | Show installed software and service status |
| `/restart <service> <server>` | Restart a service (requires TOTP) |
| `/stop <service> <server>` | Stop a service (requires TOTP) |
| `/start <service> <server>` | Start a service (requires TOTP) |

Critical actions (`restart`, `stop`, `start`) send a challenge — reply with the current 6-digit TOTP code from your authenticator within 60 seconds to confirm.

---

## Alert Notifications

Configure alert channels in **Settings → Alert Notifications**:

- **Slack Webhook** — paste any Slack-compatible incoming webhook URL
- **SMTP Email** — hostname, port, credentials, and recipient list
- **Telegram Alert Channel** — a chat ID separate from the bot's command chat

Enable or disable individual event types:

| Event | Default |
|-------|---------|
| Rotation failed | ✅ On |
| Security finding: critical | ✅ On |
| Security finding: high | ✅ On |
| Key expiring soon | ✅ On |
| Login failed | ✅ On |
| Server unreachable | ✅ On |
| Key revoked | ✅ On |
| Key created | Off |
| Assignment created | Off |
| User created | Off |

Use **Test Webhook** and **Test Email** buttons to verify delivery before saving.

---

## Terminal

- **Multi-tab** — click **＋** to open additional sessions (each is an independent WebSocket)
- **Font size** — use `−` / `+` in the toolbar per tab
- **Search** — `Ctrl+F` opens in-terminal search (regex + case-sensitive)
- **Paste** — right-click in the terminal
- **SFTP upload** — drag any file onto the terminal area; set the destination path in the 📁 field (default `/tmp/`)
- **Session recordings** — all sessions are recorded and replayable from **Logs → Session Recordings**

---

## User Management

### Roles

| Role | Capabilities |
|------|-------------|
| `admin` | Full access — manage users, keys, servers, settings, logs |
| `operator` | Manage keys and servers; cannot manage users or settings |
| `developer` | View own assignments; open terminals; view own audit logs |
| `viewer` | Read-only access to servers and keys |

### Self-protection

Admins **cannot** change their own role or deactivate their own account — this prevents accidental lockout. Their row in the Users table is highlighted and the Edit Role / Deactivate buttons are disabled. Another admin must make changes to an admin's own account.

---

## Database Migrations

Migrations run automatically on API startup via Kysely's `FileMigrationProvider`.

| Migration | Description |
|-----------|-------------|
| `001_initial` | Core tables: users, servers, ssh_keys, key_assignments, session_recordings, audit_logs, rotation_jobs |
| `002_local_auth` | Password hash, MFA secret, backup codes, login attempts |
| `003_key_archive` | Key archiving: archived_at, archive_reason, purge_after, successor/predecessor links |
| `004_server_credentials` | Per-server credential vault |
| `005_credential_archive` | Credential archiving |
| `006_credential_categories` | Credential category enum (linux, database, web, application, service, other) |
| `007_settings` | Key-value settings table (password policy) |
| `008_telegram` | Telegram bot config (token, allowed chats, TOTP secret) |
| `009_alert_settings` | Alert notification settings (webhook, SMTP, Telegram alert channel, per-event toggles) |
| `010_os_type` | `os_type` column on servers (`linux` \| `windows`, auto-detected via SSH) |
| `011_host_type` | `host_type` and `host_type_detail` columns on servers (VMware, Proxmox, AWS, etc.) |
| `012_rotation_policy` | Extends rotation policy CHECK constraint to include `180d` and `365d` |

---

## Development

```bash
npm install
npm run dev   # starts api (3001) + web (3000) concurrently
```

Rebuild and restart Docker containers after API/web changes:

```bash
docker compose build api web && docker compose up -d api web
```

---

## Production

Use `docker-compose.prod.yml` which enforces `NODE_ENV=production`, adds `restart: always`, and removes exposed DB/Redis ports:

```bash
docker compose -f docker-compose.prod.yml up -d
```

Place a reverse proxy (nginx, Caddy, Traefik) in front to terminate TLS. Set all callback URLs to your HTTPS domain.
