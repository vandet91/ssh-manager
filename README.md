# SSH Manager

A self-hosted web platform for centralized SSH access, server monitoring, certificate management, and infrastructure operations. Built with React + Fastify + PostgreSQL, deployed via Docker Compose.

---

## Features

### Dashboard
- Live stat cards: active servers, SSH keys, vault entries, user count, key rotation alerts, TLS cert alerts
- Server overview grouped by environment and OS type with bar charts
- **Key Rotation** widget — all active keys sorted by urgency (overdue → this week → 30 days → manual)
- **TLS Certificate Expiry** widget — servers with monitored certs sorted by days remaining
- Recently connected servers with pulse indicator
- Full activity feed (admin: all users; operator: own actions)

### Servers
- Full server inventory: hostname, SSH port, OS type, environment tags
- OS detection with distro art (auto-fetched from `/etc/os-release`)
- SSHD status check and root account vault management
- Host type classification (bare-metal, VM, container, cloud, etc.)
- Windows / Linux / Router / AP / Switch / DVR / NVR support
- RDP setup and domain controller flag

### TLS Certificate Monitoring *(new)*
- Per-server TLS cert monitoring — checks expiry, issuer, subject, SANs
- **Protocol support**: HTTPS (direct TLS), PostgreSQL, MySQL, MariaDB, MongoDB, Redis, SMTP, IMAP, LDAPS — STARTTLS protocols checked via SSH + openssl
- **Cert column** in servers table with color-coded badge (green → yellow → orange → red → expired)
- **TLS Cert tab** in server detail modal:
  - Live cert info: subject, issuer, SANs, fingerprint, expiry countdown
  - **Validate & Deploy** workflow for commercial certs (Sectigo, DigiCert, etc.)
  - Config test before service restart (nginx, apache2, caddy, haproxy, lighttpd, db servers)
  - **Schedule deployment** — pick a datetime, applied automatically within 5 minutes
  - Service presets: Nginx, Apache2, Caddy, HAProxy, PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Postfix, Dovecot
- Background worker checks all monitored servers every 24 hours
- Auto-renew support via configurable renewal command (Let's Encrypt / certbot)
- Dashboard widget shows servers expiring within 30 days

### Terminal
- Browser-based SSH terminal powered by **xterm.js** over WebSocket
- Multi-tab sessions (open multiple servers side by side)
- Server picker grouped by environment
- Per-session font size control
- SFTP file upload via drag-and-drop
- Command history sidebar with searchable Command Library

### Keys
- SSH key management (generate, import, archive)
- Assign keys to servers with per-user Linux user mapping
- Key rotation policies with configurable intervals and rotation history
- Rotation alerts on Dashboard

### Network Devices
- Inventory of routers, switches, access points, DVRs, NVRs
- SNMP polling (v1/v2c/v3) with VLAN discovery
- Web UI access links, SSH access (key or password), ping/last-seen tracking

### Network Scanner
- LAN/subnet ping sweep and port probe
- Auto-discovery of new devices with export to server/device inventory

### Security
- Automated per-server security scans (SSH hardening, open ports, firewall)
- Severity scoring: critical / high / medium / low / info
- Finding suppression — acknowledge false positives with a reason
- Open-port reference table — 40+ common ports with risk categories
- Admin-only

### Domain
- Active Directory / domain controller management
- Domain auth switching per server
- PingCastle report upload and viewer (AD security scoring)

### Remote Exec (PsExec)
- Run commands on Windows hosts remotely
- Interactive shell popup — admin-only

### Remote Desktop
- RDP session launcher in the browser
- Per-server RDP configuration

### DB Connector
- Connect to PostgreSQL or MySQL databases from the browser
- Run queries, view results, multiple saved connections

### DB Manager
- Direct database administration interface
- Schema browser, table editor — admin-only

### Diagrams
- Interactive network diagram builder with large MDI icon library
- Canvas: background color, grid color, grid size, show/hide toggle
- Save/load multiple diagrams

### Documentation
- Rich-text documentation editor (TipTap v2)
- Image upload, resize, and Greenshot-style annotation tool
- Draw pens, arrows, rectangles, circles, text, highlights on images

### File Manager
- SFTP-based file browser per server
- Upload, download, browse directories

### Firmware & Backup
- Firmware file repository for network devices
- Config backup storage

### Vault
- Encrypted secret storage (passwords, tokens, notes)
- Organizational units (OUs), archive/restore
- Optional TOTP re-verification to reveal secrets

### Share Center
- Secure credential sharing between users
- PIN-protected shares with expiry

### Command Library
- Shared library of reusable shell commands
- Usable directly from the terminal sidebar

### Tasks
- Scheduled task runner — cron-expression schedule or manual trigger
- Multi-step tasks with per-step commands
- Run history and live logs

### Users
- User management with role-based access (admin / standard)
- MFA setup (TOTP authenticator app)
- Per-user MFA exemption, session management

### Logs
- Full audit log of all user actions
- Telegram bot actions appear as `tg:<username>` entries
- Color-coded by action type — admin-only

### Migration
- In-app database migration runner
- Before/after snapshot comparison — admin-only

### Settings
- **System Name** — rename the app; shown in sidebar, login page, browser tab
- **Login background** image upload
- **Telegram** notifications — bot token + chat ID, per-event toggles, command audit logging
- **TOTP action rules** — require MFA re-verification for sensitive actions
- **SSO** — Microsoft 365 and Google OAuth2
- **RADIUS** server configuration
- Alert thresholds and theme selection

### Telegram Bot
- SSH service control: restart / stop / start services
- Server reboot command
- Active Directory unlock, enable, disable, reset password
- Task runner trigger
- All commands produce audit log entries (`tg:<username>`)
- Per-command enable/disable in Settings

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| Editor | TipTap v2 |
| Terminal | xterm.js over WebSocket |
| Backend | Fastify (Node.js), TypeScript |
| ORM | Kysely |
| Database | PostgreSQL |
| Cache / Queue | Redis + BullMQ |
| Auth | Session + MFA (TOTP) + SSO (Microsoft / Google) + RADIUS |
| Deploy | Docker Compose |

---

## Project Structure

```
apps/
  api/
    src/
      modules/
        auth/           # Login, MFA, SSO, RADIUS
        servers/        # Server CRUD, OS info, SSHD, network profile
        cert/           # TLS certificate monitoring + deploy
        terminal/       # WebSocket SSH terminal
        keys/           # SSH key management + rotation
        credentials/    # Stored passwords
        assignments/    # User-server access control
        security/       # Security scans + suppressions
        vault/          # Encrypted secrets
        domain/         # AD / domain controller
        db-connector/   # Browser DB queries
        db-manager/     # DB administration
        diagrams/       # Network diagrams
        docs/           # Documentation editor
        commands/       # Command library
        logs/           # Audit logs
        network-scan/   # LAN scanner
        firmware-repo/  # Firmware storage
        share/          # Credential sharing
        radius/         # RADIUS auth
        settings/       # App settings (system name, telegram, SSO, etc.)
        telegram/       # Telegram bot with audit logging
        users/          # User management
        migration/      # DB migration runner
        rdp/            # Remote desktop
        psexec/         # Remote exec (Windows)
        tasks/          # Task scheduler
      db/
        migrations/     # 52 schema migrations
        client.ts       # Kysely DB client
      jobs/
        rotation.worker.ts   # Key rotation scheduler
        tasks.worker.ts      # Task scheduler
        cert.worker.ts       # TLS cert daily check + pending applies
      utils/
        ssh.ts / server-ssh.ts   # SSH helpers
        vault.ts                 # Encryption
        audit.ts                 # Audit log writer
  web/
    src/
      pages/            # React page components
      components/       # Layout, Modal, Badge, TotpModal
      api/              # Typed API client
      context/          # Auth, permissions, TOTP elevation, SystemName
```

---

## Quick Start

### Development (Windows / Mac — Docker Desktop)

```bash
docker compose up -d --build
```

Rebuild specific containers:

```bash
docker compose up -d --build web        # frontend only
docker compose up -d --build api        # backend only
docker compose up -d --build api web    # both
```

App runs at **http://localhost:4004**

### Linux Server (Production)

On a Linux Docker host, use the Linux override file. It enables **host networking** on the API so the network scanner can read the real ARP table, send arping packets, and do mDNS/LLMNR discovery.

```bash
# First run / full rebuild
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build

# Rebuild specific containers
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build api
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build web
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build api web

# View logs
docker compose -f docker-compose.yml -f docker-compose.linux.yml logs -f api
```

App runs at **http://<your-server-ip>:4004**

> **Note:** The Linux override is NOT compatible with Docker Desktop on Windows or Mac — those run Docker inside a VM and `network_mode: host` will not give access to the physical network interface.

### Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

#### Required values

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Min 32 chars — signs session cookies |
| `VAULT_ENCRYPTION_KEY` | 64-char hex (32 bytes) — encrypts vault + credentials |
| `BOOTSTRAP_ADMIN_EMAIL` | Admin account email created on first start |
| `BOOTSTRAP_ADMIN_PASSWORD` | Admin account password (min 8 chars) |

#### Generate secure random values

**SESSION_SECRET** (64-char random string):

```bash
# Linux / Mac
openssl rand -hex 64

# Node.js (any platform)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

**VAULT_ENCRYPTION_KEY** (exactly 64 hex chars = 32 bytes):

```bash
# Linux / Mac
openssl rand -hex 32

# Node.js (any platform)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Windows PowerShell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

**GUAC_CRYPT_KEY** (exactly 32 chars for RDP session encryption):

```bash
openssl rand -base64 24 | tr -d '=' | cut -c1-32
```

#### Optional variables

```env
# Microsoft 365 SSO
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=
MS_CALLBACK_URL=https://yourdomain.com/auth/microsoft/callback

# Google Workspace SSO
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback
GOOGLE_HOSTED_DOMAIN=           # restrict to one domain, e.g. company.com

# Telegram bot (can also be configured in Settings UI)
TELEGRAM_BOT_TOKEN=

# Remote Desktop
GUAC_CRYPT_KEY=ChangeMe32CharKeyForGuacamole!!!

# MFA issuer name shown in authenticator apps
MFA_ISSUER=SSHManager
```

---

## Default Login

On first start the bootstrap admin account is created automatically using `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from `.env`.

> **Change the password** after first login via **Settings → Account**.

---

## Windows Remote Management

The app can manage Windows servers via three protocols. All require admin credentials stored in the **Vault** or **Credentials** module.

### PsExec

Runs commands on Windows hosts using Impacket's `psexec.py` (pre-installed inside the API container).

**Requirements on the Windows target:**
- SMB port `445` open and reachable from the Docker host
- Admin share `ADMIN$` accessible
- Local or domain administrator credentials

**How it works:**
```
Browser → API container → psexec.py (Impacket) → SMB 445 → Windows target
```

### WMI Exec

Runs commands via Windows Management Instrumentation using Impacket's `wmiexec.py`.

**Requirements on the Windows target:**
- RPC port `135` open (endpoint mapper)
- Dynamic RPC ports `49152–65535` open (or a WMI firewall rule)
- Admin credentials

**Advantage over PsExec:** Does not write a service binary to disk — lower antivirus detection risk.

### WinRM (Windows Remote Management)

Runs PowerShell commands using `pywinrm` over HTTP (port 5985) or HTTPS (port 5986).

**Enable WinRM on the Windows target (run as Administrator):**

```powershell
Enable-PSRemoting -Force
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "*" -Force
```

For HTTPS (recommended):

```powershell
$cert = New-SelfSignedCertificate -DnsName "hostname" -CertStoreLocation Cert:\LocalMachine\My
New-Item -Path WSMan:\localhost\Listener -Transport HTTPS -Address * `
  -CertificateThumbPrint $cert.Thumbprint -Force
netsh advfirewall firewall add rule name="WinRM HTTPS" protocol=TCP dir=in localport=5986 action=allow
```

### Evil-WinRM (Interactive Shell)

For interactive PowerShell sessions, `evil-winrm` (Ruby gem) is pre-installed inside the API container and available from the Terminal tab.

```bash
evil-winrm -i <windows-ip> -u Administrator -p <password>
```

### Port Summary

| Protocol | Port | Notes |
|----------|------|-------|
| PsExec / WMI | 445 (SMB) | Needs `ADMIN$` share |
| WMI | 135 + dynamic RPC | Firewall-unfriendly |
| WinRM HTTP | 5985 | Plain text — LAN only |
| WinRM HTTPS | 5986 | Encrypted — recommended |
| RDP (browser) | 3389 | Via Guacamole inside Docker |

---

## HTTPS (SSL/TLS)

Place your certificate files in `nginx/ssl/`:

```
nginx/ssl/fullchain.pem   ← cert + intermediate chain combined
nginx/ssl/privkey.pem     ← private key
```

If your CA provides separate files, combine them:

```bash
cat yourdomain.crt intermediate.crt > nginx/ssl/fullchain.pem
cp yourdomain.key nginx/ssl/privkey.pem
```

Start with the HTTPS overlay:

```bash
# Linux production + HTTPS
docker compose -f docker-compose.yml -f docker-compose.linux.yml -f docker-compose.https.yml up -d --build
```

Also update `.env`:

```env
FRONTEND_URL=https://yourdomain.com
CORS_ORIGIN=https://yourdomain.com
```

---

## License

Private / internal use.
