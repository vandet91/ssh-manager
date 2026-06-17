# SSH Manager

A self-hosted web platform for centralizing SSH key management, server credential vault, browser-based terminal, Remote Desktop (RDP), security auditing, Telegram bot integration, and full audit logging.

---

## Features

- **SSH Key Vault** — AES-256-GCM encrypted keys, Ed25519/RSA-4096 generation, PuTTY PPK import/export, key rotation with automatic scheduler
- **Server Inventory** — Linux & Windows support, OS/host-platform auto-detection (VMware, Hyper-V, Proxmox, AWS, Azure, GCP…), per-server filters
- **Credential Vault** — per-server password vault for RDP, SSH users, databases, web services; reveal/copy/archive with audit log
- **Browser Terminal** — xterm.js multi-tab SSH, drag-and-drop SFTP upload, session recording & playback
- **Remote Desktop** — browser-based RDP via Guacamole; command panel, file sharing
- **Windows Server** — full OpenSSH support; Info panel shows OS, memory, CPU, hostname, domain, installed roles; RDP credentials and SSH user vault
- **Security Scanner** — checks password auth, root login, stale keys, X11 forwarding; configurable alerts
- **Best Practices** — tailored config recommendations calculated from actual RAM/CPU; includes copy-paste config snippets
- **AI Analyst** — multi-provider (Claude, GPT, Gemini, DeepSeek) server health analysis
- **Alerts** — Slack webhook, SMTP email, Telegram channel; per-event toggles
- **Telegram Bot** — query servers, control services (TOTP-gated)
- **Auth** — local email/password + MFA (TOTP), Microsoft 365 SSO, Google Workspace SSO; RBAC (admin/operator/developer/viewer)
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

#### 2. Set PowerShell as the default shell (recommended)

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
| Security Scanner | ⚠️ Linux checks only |
| Service control (start/stop/restart) | ⚠️ Linux systemd only |

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
│   │       │                  # logs, settings, telegram, rdp, share, commands
│   │       └── utils/         # vault, ssh, windows-ssh, virt-detect,
│   │                          # key-ops, ppk, recommendations, alerts, audit
│   ├── web/                   # React + Vite + Tailwind CSS
│   │   └── src/
│   │       ├── api/client.ts  # Typed fetch client + all TypeScript types
│   │       └── pages/         # Dashboard, Servers, Keys, Assignments,
│   │                          # Terminal, RemoteDesktop, Logs, Security,
│   │                          # Users, Settings, Migration, FileManager,
│   │                          # NetworkDevices, CommandLibrary
│   └── guac-proxy/            # WebSocket ↔ guacd bridge (RDP)
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
docker compose build --no-cache && docker compose up -d
```

---

## Database Migrations

Migrations run automatically on startup. Current schema version: **017**.

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
