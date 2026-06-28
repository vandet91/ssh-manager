# SSH Manager — Technical Reference

Complete technical documentation for every feature: API endpoints, database schema, configuration, and usage guide.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [System Name](#2-system-name)
3. [Dashboard](#3-dashboard)
4. [Servers](#4-servers)
5. [TLS Certificate Monitoring](#5-tls-certificate-monitoring)
6. [Terminal (SSH)](#6-terminal-ssh)
7. [SSH Keys & Rotation](#7-ssh-keys--rotation)
8. [Vault](#8-vault)
9. [Security Scans](#9-security-scans)
10. [Network Devices & SNMP](#10-network-devices--snmp)
11. [Network Scanner](#11-network-scanner)
12. [Domain / Active Directory](#12-domain--active-directory)
13. [Telegram Bot](#13-telegram-bot)
14. [Tasks (Scheduler)](#14-tasks-scheduler)
15. [DB Connector & DB Manager](#15-db-connector--db-manager)
16. [Diagrams](#16-diagrams)
17. [Audit Logs](#17-audit-logs)
18. [Settings](#18-settings)
19. [Background Workers](#19-background-workers)
20. [Database Migrations](#20-database-migrations)

---

## 1. Authentication

### How it works

Session-based authentication using `@fastify/session` with PostgreSQL-backed sessions. Supports:
- **Local** — email + bcrypt password hash
- **MFA** — TOTP (RFC 6238) via authenticator app
- **SSO** — Microsoft 365 OAuth2 and Google OAuth2 via Passport.js
- **RADIUS** — delegate auth to a RADIUS server

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/login` | Email + password login |
| `POST` | `/auth/logout` | Destroy session |
| `GET`  | `/auth/me` | Return current user |
| `POST` | `/auth/mfa/validate` | Validate TOTP code |
| `POST` | `/auth/mfa/setup` | Generate TOTP secret + QR |
| `GET`  | `/auth/microsoft` | Start Microsoft OAuth2 flow |
| `GET`  | `/auth/google` | Start Google OAuth2 flow |

### TOTP Action Rules

Certain sensitive actions require a fresh TOTP challenge even when already logged in (e.g. vault reveal, key rotation). Rules are configured in **Settings → TOTP Actions**.

The middleware `requireTotpElevation` checks for an elevation token in the session. The frontend uses `TotpElevationContext` to trigger the TOTP modal before calling the protected endpoint.

### Schema

```sql
users (id, email, password_hash, role, is_active, mfa_enabled, mfa_secret,
       mfa_exempt, created_at, updated_at)
totp_action_rules (id, action_pattern, enabled, created_at)
```

---

## 2. System Name

Allows renaming the application from "SSH Manager" to any name. The name appears in:
- Sidebar brand
- Login page heading
- Browser tab title (`document.title`)

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/settings/public` | None | Returns `{ system_name }` |
| `PUT`  | `/settings/system-name` | Admin | Update system name (max 80 chars) |

### How it works

- Stored as a row in the `settings` table with `key = 'system_name'`
- Frontend reads it on load via `SystemNameProvider` (React context)
- `localStorage` caching prevents flash of default name on page refresh
- The `Login.tsx` page reads from `localStorage` synchronously before the first render

### Usage

Go to **Settings → System Name**, type the new name, click **Save**. Takes effect immediately across all open tabs on next navigation.

---

## 3. Dashboard

### Stat Cards

| Card | Source | Notes |
|------|--------|-------|
| Active Servers | `servers` table | `is_active = true` |
| SSH Keys | `ssh_keys` table | `is_active = true` |
| Vault Entries | `vault_entries` table | non-archived |
| Active Users | `users` table | admin-only |
| Key Alerts | derived | overdue + this-week keys |
| TLS Certs | `/cert/expiring` | only shown when certs configured |

### Key Rotation Widget

Shows all active SSH keys sorted by urgency:
- 🔴 **Overdue** — `next_rotation_at < now`
- 🟡 **This week** — expires within 7 days
- 🔵 **30 days** — expires within 30 days
- ✅ **OK** — more than 30 days away
- ⚙ **Manual** — no rotation schedule (`rotation_policy = 'manual'`)

### TLS Certificate Widget

Fetches `GET /cert/expiring` — only rendered if at least one server has `cert_host` configured. Sorted by `days_remaining` ascending (most urgent first).

---

## 4. Servers

### Schema (key columns)

```sql
servers (
  id UUID, name TEXT, hostname TEXT, ssh_port INT,
  environment TEXT,   -- production | staging | development | other | office | branch | datacenter | home | warehouse
  os_type TEXT,       -- linux | windows | router | switch | access-point | dvr | nvr | other-network
  device_category TEXT,  -- server | network
  management_key_id UUID REFERENCES ssh_keys,
  management_linux_user TEXT,
  host_key_fingerprint TEXT, host_key_verified BOOL,
  is_active BOOL, is_domain_controller BOOL,
  last_connected_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
  -- cached OS info
  os_name, os_pretty_name, os_version, os_id, kernel_version,
  -- TLS cert columns (see section 5)
)
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/servers` | List all servers |
| `POST`   | `/servers` | Create server |
| `GET`    | `/servers/:id` | Get single server |
| `PATCH`  | `/servers/:id` | Update server |
| `DELETE` | `/servers/:id` | Delete server |
| `GET`    | `/servers/:id/info` | Fetch live system info via SSH |
| `GET`    | `/servers/:id/sshd-status` | Check sshd config |
| `POST`   | `/servers/:id/setup` | Run SSH key setup (inject management key) |

### SSH Setup Flow

1. Add server with hostname + SSH port
2. Click **Setup** — enter Linux username + password
3. System connects via password, injects the management SSH key into `~/.ssh/authorized_keys`
4. All subsequent connections use the management key (password no longer needed)
5. Host key fingerprint is saved and verified on every connection

---

## 5. TLS Certificate Monitoring

### Overview

Monitors the TLS certificate on any server or network device. Supports both direct TLS (HTTPS) and STARTTLS protocols (databases, mail servers).

### Database Schema

```sql
-- Added to servers table (migrations 050, 051, 052)
cert_host            TEXT,           -- hostname/IP to check (defaults to server hostname)
cert_port            INT DEFAULT 443,
cert_protocol        TEXT DEFAULT 'https',  -- https|postgres|mysql|mongodb|redis|smtp|imap|ldap
cert_expires_at      TIMESTAMPTZ,
cert_issuer          TEXT,
cert_subject         TEXT,
cert_sans            TEXT[],
cert_is_self_signed  BOOL,
cert_last_checked_at TIMESTAMPTZ,
cert_error           TEXT,
cert_renewal_cmd     TEXT,           -- e.g. "certbot renew --quiet"
cert_auto_renew      BOOL DEFAULT false,
cert_pending_apply_at     TIMESTAMPTZ,   -- scheduled deploy time
cert_pending_apply_config JSONB           -- deploy job config
```

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`    | `/servers/:id/cert` | User | Get cert info + pending job |
| `POST`   | `/servers/:id/cert/check` | User | Trigger live cert check |
| `PUT`    | `/servers/:id/cert/settings` | Admin | Save monitoring config |
| `POST`   | `/servers/:id/cert/renew` | Admin | Run renewal command via SSH |
| `POST`   | `/servers/:id/cert/validate-files` | User | Validate cert files on server |
| `POST`   | `/servers/:id/cert/apply-files` | Admin | Apply cert files + restart service |
| `POST`   | `/servers/:id/cert/schedule-apply` | Admin | Schedule cert deploy |
| `DELETE` | `/servers/:id/cert/schedule-apply` | Admin | Cancel scheduled deploy |
| `GET`    | `/cert/expiring` | User | All monitored certs sorted by expiry |

### Protocol Support

| Protocol | Check method | Default port | Notes |
|----------|-------------|-------------|-------|
| `https` | Node `tls.connect()` → SSH fallback | 443 | Works for any HTTPS host |
| `postgres` | SSH `openssl s_client -starttls postgres` | 5432 | Requires SSH access |
| `mysql` | SSH `openssl s_client -starttls mysql` | 3306 | Requires SSH access |
| `mariadb` | SSH `openssl s_client -starttls mysql` | 3306 | Same as mysql |
| `mongodb` | SSH `openssl s_client` (direct TLS) | 27017 | Requires SSH access |
| `redis` | SSH `openssl s_client` (direct TLS) | 6380 | Requires SSH access |
| `smtp` | SSH `openssl s_client -starttls smtp` | 587 | Requires SSH access |
| `imap` | SSH `openssl s_client -starttls imap` | 993 | Requires SSH access |
| `ldap` | SSH `openssl s_client -starttls ldap` | 636 | Requires SSH access |

### Validate & Deploy Workflow (for commercial certs)

Designed for certificates from Sectigo, DigiCert, GlobalSign, etc. that cannot be auto-renewed:

**Step 1 — Upload files to server**
Use File Manager to upload your new cert files (`.crt`, `.key`, chain) to a temp location like `/tmp/`.

**Step 2 — Validate**
In the server detail → **🔒 TLS Cert** tab, enter the file paths and click **Validate Certificate**. The system checks:
- Certificate is a valid X.509 file (readable by openssl)
- Expiry date (warns if < 7 days, errors if already expired)
- **Private key matches the certificate** (MD5 modulus comparison) — prevents deploying mismatched key
- Chain verification (if chain file provided)
- Self-signed flag

**Step 3 — Deploy**
Only shown after successful validation. Configure:
- **Target paths** — where to copy the cert on the server
- **Concat chain** — merge chain into cert file (nginx `fullchain.pem` style)
- **Backup** — create timestamped backups of existing files before replacing
- **Service name** — which service to restart
- **Service action** — `reload` (graceful, no downtime) or `restart` or `none`

**Service presets** auto-fill all paths + service + action for common stacks:

| Preset | Cert path | Key path | Service | Action |
|--------|-----------|----------|---------|--------|
| Nginx | `/etc/nginx/ssl/server.crt` | `/etc/nginx/ssl/server.key` | `nginx` | reload |
| Apache2 | `/etc/ssl/certs/server.crt` | `/etc/ssl/private/server.key` | `apache2` | reload |
| PostgreSQL | `/var/lib/postgresql/ssl/server.crt` | `/var/lib/postgresql/ssl/server.key` | `postgresql` | reload |
| MySQL | `/etc/mysql/ssl/server-cert.pem` | `/etc/mysql/ssl/server-key.pem` | `mysql` | restart |
| MongoDB | `/etc/ssl/mongodb/mongodb.pem` (concat) | — | `mongod` | restart |
| Redis | `/etc/redis/ssl/redis.crt` | `/etc/redis/ssl/redis.key` | `redis-server` | restart |

**Config test before restart:**
- `nginx -t` (nginx)
- `apache2ctl -t` / `httpd -t` (apache)
- `caddy validate` (caddy)
- `haproxy -c` (haproxy)
- `lighttpd -t` (lighttpd)
- `openssl x509 -in <cert> -noout` (database servers — verify cert is valid before restart)

**Step 4 — Apply Now or Schedule**
- **Apply Now** — runs immediately, re-checks live cert after success
- **Schedule** — picks a datetime; the cert worker executes it within 5 minutes of the scheduled time and clears the pending job (success or failure)

### Auto-Renewal (Let's Encrypt / certbot)

Configure the **Renewal command** in Monitoring Settings (e.g. `certbot renew --quiet`) and enable **Auto-renew**. The daily cert worker will run the command when the cert has < 30 days remaining.

### Background Worker

`cert.worker.ts` runs two loops:
- **Daily check** (every 24h, also 30s after startup) — checks all servers with `cert_host` configured
- **Pending applies** (every 5 minutes) — executes any `cert_pending_apply_at <= now` jobs

---

## 6. Terminal (SSH)

### Architecture

```
Browser (xterm.js) ←WebSocket→ Fastify WS endpoint → ssh2 library → Server
```

- Each tab opens a new WebSocket connection
- The server maintains an SSH connection per tab
- SFTP sessions are opened on the same SSH connection for file transfer

### How to Use

1. Go to **Terminal**
2. Select a server from the dropdown (grouped by environment)
3. A new tab opens with an interactive terminal
4. Use **Ctrl+Tab** or click tabs to switch between sessions
5. Drag files onto the terminal to upload via SFTP

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `ws://host/terminal/ws` | WebSocket SSH terminal |
| `POST` | `/terminal/sftp/upload` | SFTP file upload |

---

## 7. SSH Keys & Rotation

### Key Types

- **Generated** — RSA 4096 / ED25519 key pair generated on the server; private key stored encrypted
- **Imported** — paste an existing private key

### Rotation Policies

| Policy | Behavior |
|--------|----------|
| `manual` | No automatic rotation; appears with ⚙ Manual badge on dashboard |
| `interval` | Auto-rotate after N days; BullMQ job triggers rotation |
| `expiry` | Rotate before a fixed expiry date |

### Rotation Flow

1. New key pair generated
2. New public key pushed to all assigned servers (`~/.ssh/authorized_keys`)
3. Old key removed from all servers
4. Old key archived in DB
5. Audit log entry written

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/keys` | List all keys |
| `POST`   | `/keys` | Create key |
| `PATCH`  | `/keys/:id` | Update key (name, policy, rotation date) |
| `DELETE` | `/keys/:id` | Archive key |
| `POST`   | `/keys/:id/rotate` | Manual rotate now |
| `GET`    | `/rotation/history` | Rotation history |

### Schema

```sql
ssh_keys (id, name, public_key, private_key_enc, key_type, is_active,
          rotation_policy, rotation_interval_days, next_rotation_at, last_rotated_at)
key_assignments (id, key_id, server_id, linux_user)
rotation_history (id, key_id, rotated_at, trigger, status, error)
```

---

## 8. Vault

### Encryption

Secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY` from `.env`. The key is a 64-character hex string (32 bytes). Each secret has its own random IV stored alongside the ciphertext.

### TOTP Protection

Vault reveal can be protected by a TOTP action rule. When the rule is active, the user must enter a TOTP code before the decrypted secret is returned.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/vault` | List entries (encrypted values hidden) |
| `POST`   | `/vault` | Create entry |
| `PATCH`  | `/vault/:id` | Update entry |
| `POST`   | `/vault/:id/reveal` | Decrypt and return value |
| `DELETE` | `/vault/:id` | Archive entry |

---

## 9. Security Scans

### What gets checked

- SSH config: PermitRootLogin, PasswordAuthentication, Protocol version, allowed ciphers/MACs
- Open ports (compared against known-port reference table)
- Firewall status (ufw / iptables / firewalld)
- Unattended upgrades / automatic updates
- Sudo configuration
- World-writable files in sensitive paths

### Finding Suppression

Each finding can be suppressed per-server with a reason. Suppressed findings are stored in `security_suppressions` and shown at reduced opacity with a show/hide toggle.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/servers/:id/security-scan` | Run scan |
| `GET`  | `/servers/:id/security-findings` | Get findings |
| `POST` | `/servers/:id/security-findings/:findingId/suppress` | Suppress finding |
| `DELETE` | `/servers/:id/security-findings/:findingId/suppress` | Un-suppress |

---

## 10. Network Devices & SNMP

### Device Types

Router, switch (L2/L3), access point, wireless controller, firewall, UTM, IDS/IPS, WAF, load balancer, proxy, VPN gateway, IP-PBX, VoIP gateway, DVR, NVR, IP camera, UPS, PDU, KVM switch, console server.

### SNMP Polling

SNMP profiles store community strings and v3 credentials. Polling fetches:
- System description, uptime, contact, location
- Interface list with status and speed
- VLAN table (if switch supports `BRIDGE-MIB`)

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/network-devices` | List devices |
| `POST` | `/network-devices` | Create device |
| `POST` | `/network-devices/:id/snmp-poll` | Run SNMP poll |
| `POST` | `/network-devices/:id/ping` | Ping device |
| `GET`  | `/snmp-profiles` | List SNMP profiles |

---

## 11. Network Scanner

### How it works

1. Input a CIDR range (e.g. `192.168.1.0/24`) or IP range
2. System pings all hosts in range in parallel
3. For responding hosts, probes common ports (22, 80, 443, 3306, 5432, etc.)
4. Results shown with hostname (reverse DNS), open ports, response time
5. Discovered hosts can be added directly to the server/device inventory

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/network-scan/run` | Start scan |
| `GET`  | `/network-scan/results` | Get scan results |
| `POST` | `/network-scan/add-server` | Add discovered host as server |
| `POST` | `/network-scan/add-device` | Add discovered host as network device |

---

## 12. Domain / Active Directory

### Features

- Associate servers with a domain controller
- Switch authentication between local and domain for terminal sessions
- Upload PingCastle XML reports and view the AD security score

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/domain` | List domain configs |
| `POST` | `/domain` | Create domain |
| `POST` | `/domain/:id/pingcastle` | Upload PingCastle report |

---

## 13. Telegram Bot

### Setup

1. Create a bot via **@BotFather** on Telegram — get the bot token
2. Find your chat ID (send `/start` to the bot, then check the Telegram API)
3. Go to **Settings → Telegram** — enter token + chat ID, save, click **Test**
4. Enable individual commands and notification events as needed

### Available Commands

| Command | Description |
|---------|-------------|
| `/restart <server> <service>` | Restart a system service via SSH |
| `/stop <server> <service>` | Stop a service |
| `/start <server> <service>` | Start a service |
| `/reboot <server>` | Reboot the server |
| `/adunlock <user>` | Unlock AD account |
| `/adenable <user>` | Enable AD account |
| `/addisable <user>` | Disable AD account |
| `/adreset <user> <password>` | Reset AD password |
| `/runtask <task-name>` | Trigger a scheduled task manually |
| `/status` | Show bot status |
| `/help` | List available commands |

### Audit Logging

Every Telegram command is recorded in the audit log as `tg:<telegram_username>`. Write actions (restart, reboot, AD operations, task run) record both the command and the result.

### Notification Events

Configurable per-event in Settings:
- Key rotation completed / failed
- Server connection established
- Vault secret revealed
- User login / failed login
- Security scan finding (critical/high)
- Certificate expiry alerts

---

## 14. Tasks (Scheduler)

### Concept

Tasks are named, multi-step shell command sequences that run on a target server. Each task has a cron schedule (or manual-only). Runs are logged step by step.

### Schema

```sql
tasks (id, name, description, server_id, schedule, enabled, created_at)
task_steps (id, task_id, step_order, command, timeout_seconds)
task_runs (id, task_id, triggered_by, status, started_at, finished_at)
task_run_logs (id, run_id, step_order, output, exit_code, ran_at)
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/tasks` | List tasks |
| `POST`   | `/tasks` | Create task |
| `PATCH`  | `/tasks/:id` | Update task |
| `DELETE` | `/tasks/:id` | Delete task |
| `POST`   | `/tasks/:id/run` | Trigger manually |
| `GET`    | `/tasks/:id/runs` | Run history |
| `GET`    | `/tasks/:id/runs/:runId/logs` | Step-by-step logs |

### Background Worker

`tasks.worker.ts` uses `node-cron` to evaluate all enabled tasks every minute against their cron expression. Tasks triggered by Telegram use the same run path as manual triggers.

---

## 15. DB Connector & DB Manager

### DB Connector

Saved database connections (PostgreSQL or MySQL). Credentials are encrypted. Users can run arbitrary SQL and see results in a paginated table.

### DB Manager

Admin-only. Direct schema browser and table editor for the SSH Manager's own PostgreSQL database. Useful for inspecting audit logs, checking migration status, or editing settings rows directly.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/db-connections` | List saved connections |
| `POST` | `/db-connections` | Create connection |
| `POST` | `/db-connections/:id/query` | Run SQL query |
| `GET`  | `/db-manager/tables` | List tables (admin) |
| `GET`  | `/db-manager/tables/:table/rows` | Browse rows (admin) |

---

## 16. Diagrams

### Features

- Drag-and-drop canvas with 7000+ MDI icons
- Search icons by name or filter by category
- Link devices with lines
- Label nodes and links
- Export canvas as PNG
- Multiple saved diagrams per user

### Schema

```sql
network_diagrams (id, name, owner_id, canvas_data JSONB, created_at, updated_at)
```

---

## 17. Audit Logs

### Log sources

Every write operation calls `writeAuditLog()` from `utils/audit.ts`:

```typescript
writeAuditLog({
  userEmail: string,   // 'user@example.com' or 'tg:telegramUser'
  action: string,      // e.g. 'server.create', 'vault.reveal', 'cert.apply'
  resource?: string,   // resource name or ID
  serverId?: string,   // UUID of related server
  details?: object,    // arbitrary JSON metadata
})
```

### Action naming convention

```
<module>.<verb>
```

Examples: `server.create`, `key.rotate`, `vault.reveal`, `cert.check`, `cert.apply`, `cert.schedule`, `telegram.svc.restart`, `telegram.reboot`

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/logs/audit` | Admin | All audit logs, paginated |
| `GET` | `/logs/my-activity` | User | Own activity log |

---

## 18. Settings

All settings are stored in the `settings` table as key-value pairs (value is JSON-encoded).

### Known keys

| Key | Type | Description |
|-----|------|-------------|
| `system_name` | string | Application display name |
| `telegram_token` | string | Telegram bot token |
| `telegram_chat_id` | string | Telegram chat ID |
| `telegram_events` | object | Per-event notification toggles |
| `telegram_commands` | object | Per-command enable/disable |
| `sso_microsoft_*` | string | Microsoft OAuth2 credentials |
| `sso_google_*` | string | Google OAuth2 credentials |
| `radius_*` | string | RADIUS server config |
| `alert_*` | object | Alert threshold config |

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/settings/public` | None | Returns `{ system_name }` |
| `PUT`  | `/settings/system-name` | Admin | Update system name |
| `GET`  | `/settings` | Admin | Get all settings |
| `PUT`  | `/settings` | Admin | Update settings (bulk) |
| `GET`  | `/settings/login-bg` | None | Serve login background image |
| `PUT`  | `/settings/login-bg` | Admin | Upload login background |

---

## 19. Background Workers

| Worker | File | Schedule | Purpose |
|--------|------|----------|---------|
| Rotation | `jobs/rotation.worker.ts` | Hourly via BullMQ | Check key rotation due dates, trigger rotation |
| Tasks | `jobs/tasks.worker.ts` | Every minute (node-cron) | Evaluate task cron schedules |
| Cert | `jobs/cert.worker.ts` | Daily + every 5 min | Check all cert expiries; execute pending apply jobs |

All workers start in `index.ts` after migrations run. All workers are stopped cleanly on SIGTERM/SIGINT.

---

## 20. Database Migrations

Migrations live in `apps/api/src/db/migrations/` and are run automatically on API startup using Kysely's `FileMigrationProvider`. Migrations run in filename order.

### Migration list summary

| # | Name | What it adds |
|---|------|-------------|
| 001–010 | Core tables | users, servers, ssh_keys, assignments, audit_logs, vault, credentials |
| 011–020 | Extensions | network devices, SNMP, security findings, domain, RDP |
| 021–030 | Advanced features | diagrams, docs, command library, firmware, config backup |
| 031–040 | Auth & access | TOTP rules, SSO, RADIUS, share center, tasks |
| 041–049 | Infrastructure | DB manager, network scan, distro art, DB backups |
| 050 | `cert_monitoring` | Cert columns on servers table (host, port, expiry, issuer, SANs, etc.) |
| 051 | `cert_deploy` | `cert_pending_apply_at`, `cert_pending_apply_config` columns |
| 052 | `cert_protocol` | `cert_protocol` column (https / postgres / mysql / mongodb / redis / smtp / imap / ldap) |

### Adding a migration

```typescript
// apps/api/src/db/migrations/053_my_feature.ts
import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers ADD COLUMN IF NOT EXISTS my_col TEXT`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE servers DROP COLUMN IF EXISTS my_col`.execute(db)
}
```

Restart the API — the migration runs automatically.

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Min 32 chars; signs session cookies |
| `ENCRYPTION_KEY` | Yes | 64-char hex (32 bytes); encrypts vault + credentials |
| `BOOTSTRAP_ADMIN_EMAIL` | Yes | Admin email created on first start |
| `BOOTSTRAP_ADMIN_PASSWORD` | Yes | Admin password (change after first login) |
| `PORT` | No | API port (default: 3001) |
| `REDIS_URL` | No | Redis URL (default: `redis://redis:6379`) |
| `MICROSOFT_CLIENT_ID` | No | Microsoft OAuth2 app ID |
| `MICROSOFT_CLIENT_SECRET` | No | Microsoft OAuth2 secret |
| `MICROSOFT_TENANT_ID` | No | Azure AD tenant ID |
| `GOOGLE_CLIENT_ID` | No | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth2 secret |
| `TELEGRAM_BOT_TOKEN` | No | Can also be set via Settings UI |

---

*Last updated: 2026-06-28*
