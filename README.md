# SSH Manager

A self-hosted infrastructure management platform for SSH servers, network devices, Windows Domain Controllers, and remote desktops. Built with **Fastify + TypeScript** on the backend and **React + Vite** on the frontend, deployed via **Docker Compose**.

---

## Features

| Area | Capabilities |
|------|-------------|
| **Server Management** | Add/edit/remove servers, SSH key assignment, live health checks, OS info auto-detection, distro art |
| **SSH Keys** | Generate/import keys, key rotation policies, predecessor/successor chain, vault encryption |
| **Terminal** | Browser-based SSH terminal with session recording, multi-tab, distro logos, idle timeout |
| **Remote Desktop** | RDP/VNC via Apache Guacamole, session recording, PsExec shell popup |
| **Domain Manager** | Active Directory users, groups, computers, sessions — auth-switching (management key / SSH key / credential) |
| **Firmware & Backup** | Firmware repository with TFTP distribution (read-only), config backup via SSH pull, diff viewer |
| **Network Scanner** | SNMP polling, ping sweep, port scan, VLAN discovery, network diagrams |
| **Credentials Vault** | AES-256-GCM encrypted credential store, per-server credentials, TOTP-gated access |
| **Security** | Audit logs, TOTP/MFA, TOTP action rules, session management, rate limiting, Helmet CSP |
| **SSO** | Google Workspace OAuth2, Microsoft 365 OIDC, local password login |
| **Notifications** | Telegram bot, webhook alerts |
| **Logs** | Full audit trail, SSH session recordings, log viewer with filters |
| **Migration** | Schema snapshot export/import across environments |
| **File Manager** | Browser-based SFTP file manager per server |
| **DB Connector** | Connect to PostgreSQL/MySQL/SQLite on remote servers via SSH tunnel |
| **RADIUS** | RADIUS server management and discovery |
| **Command Library** | Saved SSH command snippets, per-device execution |
| **Diagrams** | Drag-and-drop network topology diagrams with icon library |
| **Settings** | AI provider config, Telegram, TOTP rules, distro art editor, theme |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (React SPA)                  │
│  Vite + React + TypeScript + Tailwind CSS               │
│  Port 4004 (dev) / 3000 (prod) — served by nginx       │
└───────────────────┬─────────────────────────────────────┘
                    │ HTTP + WebSocket  (/api/, /auth/, /ws/)
                    │ proxied by nginx
┌───────────────────▼─────────────────────────────────────┐
│                  API (Fastify + TypeScript)              │
│  Port 3001 — REST + WebSocket                           │
│  Sessions → Redis   │   Data → PostgreSQL               │
│  Secrets → AES-256-GCM vault (VAULT_ENCRYPTION_KEY)    │
└──────┬───────────────────────────┬──────────────────────┘
       │ SSH2                      │ SSH2 / SFTP
┌──────▼──────┐            ┌───────▼──────┐
│  Linux/Unix │            │  Windows DC  │
│   Servers   │            │  (AD/RDP)    │
└─────────────┘            └──────────────┘
       │
┌──────▼──────┐    ┌──────────────┐    ┌─────────────────┐
│ guacd daemon│    │  TFTP Server │    │  SNMP devices   │
│ (Guacamole) │    │  UDP :69     │    │  (routers/APs)  │
└─────────────┘    └──────────────┘    └─────────────────┘
```

---

## Project Structure

```
ssh-manager/
├── apps/
│   ├── api/                          # Fastify API (Node.js + TypeScript)
│   │   └── src/
│   │       ├── index.ts              # App bootstrap, plugin registration
│   │       ├── config.ts             # Zod-validated env config
│   │       ├── db/
│   │       │   ├── client.ts         # Kysely DB client + table types
│   │       │   └── migrations/       # 043 sequential SQL migrations (auto-run on startup)
│   │       ├── middleware/
│   │       │   └── auth.ts           # requireAuth / requireAdmin guards
│   │       ├── utils/
│   │       │   ├── ssh.ts            # SSH2 connect + exec helpers
│   │       │   ├── server-ssh.ts     # withServerSsh (management key lookup)
│   │       │   ├── vault.ts          # AES-256-GCM encrypt/decrypt
│   │       │   ├── audit.ts          # writeAuditLog helper
│   │       │   └── ai-analyst.ts     # Multi-provider AI client (Claude/GPT/Gemini)
│   │       └── modules/              # Feature modules — one folder per domain
│   │           ├── auth/             # Login, SSO (Google/Microsoft), MFA, TOTP
│   │           ├── users/            # User management
│   │           ├── servers/          # Server CRUD, health, OS info, SNMP, network profiles
│   │           ├── keys/             # SSH key lifecycle + rotation policies
│   │           ├── assignments/      # Key-to-server assignments
│   │           ├── terminal/         # WebSocket SSH terminal + session recordings
│   │           ├── credentials/      # Encrypted per-server credential store
│   │           ├── vault/            # Vault root credential management
│   │           ├── domain/           # Active Directory management (users/groups/computers)
│   │           ├── firmware-repo/    # Firmware file store (source for TFTP server)
│   │           ├── config-backup/    # Device config pull via SSH + diff engine
│   │           ├── distro-art/       # Custom distro ASCII art (DB-backed, admin editable)
│   │           ├── diagrams/         # Network topology diagrams
│   │           ├── network-scan/     # SNMP polling, ping sweep, port scan, VLAN discovery
│   │           ├── db-connector/     # Remote DB connections via SSH tunnel
│   │           ├── commands/         # Saved SSH command library
│   │           ├── rdp/              # Guacamole RDP/VNC token generation
│   │           ├── psexec/           # PsExec remote shell for Windows
│   │           ├── radius/           # RADIUS server management
│   │           ├── logs/             # Audit log viewer
│   │           ├── security/         # Security scan + hardening checks
│   │           ├── migration/        # Schema snapshot export/import
│   │           ├── rotation/         # SSH key rotation worker (BullMQ)
│   │           ├── settings/         # App settings (AI keys, Telegram, TOTP rules)
│   │           ├── share/            # Shared server access tokens
│   │           └── telegram/         # Telegram bot service
│   │
│   ├── web/                          # React SPA (Vite + TypeScript)
│   │   ├── nginx.conf                # nginx reverse proxy — /api/ and /auth/ → API
│   │   └── src/
│   │       ├── api/client.ts         # Typed API client (all endpoints + types)
│   │       ├── components/
│   │       │   └── Layout.tsx        # Sidebar nav + auth context + role checks
│   │       └── pages/                # One file per route/feature
│   │           ├── Dashboard.tsx
│   │           ├── Servers.tsx
│   │           ├── Terminal.tsx
│   │           ├── Domain.tsx
│   │           ├── FirmwareRepo.tsx
│   │           ├── NetworkScan.tsx
│   │           ├── Diagrams.tsx
│   │           ├── Logs.tsx
│   │           ├── Settings.tsx
│   │           └── ...
│   │
│   └── guac-proxy/                   # WebSocket ↔ guacd bridge for Remote Desktop
│
├── services/
│   └── tftp/                         # Python TFTP server (tftpy)
│       ├── Dockerfile
│       └── tftp_server.py            # Read-only, firmware/ only, path traversal safe
│
├── docker-compose.yml                # Development stack (includes test SSH servers)
├── docker-compose.prod.yml           # Production stack (resource limits, restart:always)
├── .env                              # Environment variables (not committed)
└── .env.example                      # Template with all required variables
```

---

## Data Flow

### SSH Connection
```
Browser → API (/api/terminal/:id WebSocket)
  → Fetch server record from DB
  → Fetch management SSH key → decrypt with VAULT_ENCRYPTION_KEY
  → SSH2 connect to server
  → Stream stdin/stdout over WebSocket to browser (xterm.js)
```

### Domain Manager Auth Switching
```
Browser selects auth: [Management Key | SSH Key Assignment | Stored Credential]
  → Appends ?auth=management|key:uuid|cred:uuid to every domain API call
  → withDomainSsh() reads the param, fetches + decrypts the right secret
  → Connects via SSH2 → executes PowerShell AD cmdlets on Windows DC
```

### TFTP Firmware Distribution
```
Admin uploads firmware via web UI
  → API writes to shared Docker volume: firmware/<vendor>/<model>/<file>
  → TFTP server (Python/tftpy) reads same volume — read-only, firmware/ only
  → Network device runs: tftp <server-ip> -g firmware/<vendor>/<model>/<file>
  → configs/ directory is intentionally blocked from TFTP
```

### Config Backup
```
Admin triggers backup via web UI (or scheduled)
  → API connects via SSH to device
  → Runs vendor-specific command (show running-config, /export, cat /etc/..., etc.)
  → Stores output at configs/<server-id>/<timestamp>.cfg
  → Diff viewer compares against previous backup using LCS algorithm
```

### Google SSO Flow
```
Browser → GET /auth/google
  → API generates random state, saves to session
  → Redirect to accounts.google.com with client_id + state + scope
Google → GET /auth/google/callback?code=...&state=...
  → API verifies state matches session
  → Exchanges code for access token
  → Fetches userinfo (email, name, sub) from Google
  → Upserts user in DB → sets session → redirects to /dashboard
```

---

## Services (Docker)

| Service | Image / Build | Port | Purpose |
|---------|--------------|------|---------|
| `api` | `./apps/api` | 3001 | Fastify REST + WebSocket API |
| `web` | `./apps/web` | 4004 (dev) / 3000 (prod) | React SPA + nginx reverse proxy |
| `postgres` | `postgres:15-alpine` | 5433 | Primary database |
| `redis` | `redis:7-alpine` | 6379 | Sessions + BullMQ job queue |
| `tftp-server` | `./services/tftp` | 69/udp | TFTP firmware distribution |
| `guacd` | `guacamole/guacd:1.5.5` | — | RDP/VNC protocol daemon |
| `guac-proxy` | `./apps/guac-proxy` | 3002 | WebSocket ↔ guacd bridge |

---

## Quick Start (Development)

```bash
# 1. Clone
git clone https://github.com/vandet91/ssh-manager.git
cd ssh-manager

# 2. Configure environment
cp .env.example .env
# Edit .env — minimum required:
#   SESSION_SECRET (32+ random chars)
#   VAULT_ENCRYPTION_KEY (64 hex chars)
#   BOOTSTRAP_ADMIN_EMAIL (your email)

# 3. Start everything
docker compose up -d --build

# Web:  http://localhost:4004
# API:  http://localhost:3001
# TFTP: udp://localhost:69
```

## Production Deploy

```bash
# Set POSTGRES_PASSWORD in .env, then:
docker compose -f docker-compose.prod.yml up -d --build

# Web runs on port 3000
# Open firewall: TCP 3000 (web), UDP 69 (TFTP — from device subnets only)
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FRONTEND_URL` | ✅ | e.g. `http://localhost:4004` |
| `SESSION_SECRET` | ✅ | Min 32 chars random string |
| `VAULT_ENCRYPTION_KEY` | ✅ | 64-char hex (32-byte AES-256 key) |
| `BOOTSTRAP_ADMIN_EMAIL` | ✅ | First admin account email |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `CORS_ORIGIN` | ✅ | Same as `FRONTEND_URL` |
| `GOOGLE_CLIENT_ID` | — | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth2 client secret |
| `GOOGLE_CALLBACK_URL` | — | e.g. `http://localhost:4004/auth/google/callback` |
| `GOOGLE_HOSTED_DOMAIN` | — | Restrict SSO to one Google Workspace domain |
| `MS_CLIENT_ID` | — | Microsoft Azure AD app client ID |
| `MS_CLIENT_SECRET` | — | Microsoft Azure AD app secret |
| `MS_TENANT_ID` | — | Azure AD tenant ID |
| `MS_CALLBACK_URL` | — | e.g. `http://localhost:4004/auth/microsoft/callback` |
| `GUAC_CRYPT_KEY` | — | Min 32 chars, RDP token encryption |
| `ALERT_WEBHOOK_URL` | — | Webhook for system alert notifications |
| `POSTGRES_PASSWORD` | prod | PostgreSQL password (production only) |

---

## Security Model

- All SSH private keys and device passwords encrypted at rest with **AES-256-GCM**
- Session cookies: `httpOnly`, `sameSite: lax`, `secure` in production
- Rate limiting on `/auth/*` routes (10 req/min default)
- **Helmet CSP** headers on all API responses
- **TOTP/MFA** support with configurable per-action elevation rules
- TFTP server: read-only, serves `firmware/` directory only — `configs/` is never exposed via TFTP
- Path traversal protection on all file upload/download operations

---

## Tech Stack

**Backend:** Node.js · Fastify · TypeScript · Kysely (query builder) · PostgreSQL · Redis · BullMQ · SSH2 · passport-openidconnect

**Frontend:** React 18 · Vite · TypeScript · Tailwind CSS · xterm.js

**Infrastructure:** Docker · nginx · Apache Guacamole · Python tftpy (TFTP)
