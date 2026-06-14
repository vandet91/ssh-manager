# SSH Manager Server — Full Build Prompt for Claude Code

## Project overview

Build a production-ready **SSH Manager Server** — a self-hosted web platform that centralizes SSH key management, credential rotation, direct browser-based terminal access, security auditing, and audit logging across all managed servers. Authentication is via SSO (Microsoft 365 / Azure AD and Google Workspace), with MFA enforcement and full RBAC.

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js (TypeScript) with Fastify |
| SSH library | `ssh2` (node) |
| SSH key format conversion | `sshpk` (PEM → OpenSSH authorized_keys format) |
| Web terminal | `xterm.js` + WebSocket (`fastify-websocket`) |
| Frontend | React 18 + TypeScript + Tailwind CSS v3 |
| Database | PostgreSQL 15 (via `pg` + `kysely` query builder) |
| Migrations | Kysely built-in migration system (`FileMigrationProvider`) |
| Queue | BullMQ + Redis 7 |
| Secrets/vault | Encrypted PostgreSQL column (AES-256-GCM via Node `crypto`) — optionally swap to HashiCorp Vault |
| Auth | Passport.js with `passport-openidconnect` for both MS365 and Google |
| Session | `@fastify/session` + `connect-redis` (Redis store) |
| MFA | `speakeasy` (TOTP) + `qrcode` |
| Logging | `pino` structured logger |
| API validation | `zod` |
| Testing | `vitest` + `supertest` |
| Containerization | Docker + Docker Compose |

---

## Project structure

```
ssh-manager/
├── apps/
│   ├── api/                        # Fastify backend
│   │   ├── src/
│   │   │   ├── index.ts            # Entry point
│   │   │   ├── config.ts           # Env config (zod-validated)
│   │   │   ├── db/
│   │   │   │   ├── client.ts       # Kysely + pg pool
│   │   │   │   └── migrations/     # Kysely migration files
│   │   │   ├── modules/
│   │   │   │   ├── auth/           # SSO, MFA, session
│   │   │   │   ├── users/          # User CRUD, profile sync
│   │   │   │   ├── servers/        # Server registry
│   │   │   │   ├── keys/           # SSH key CRUD + vault
│   │   │   │   ├── assignments/    # Key-to-server-to-user mapping
│   │   │   │   ├── rotation/       # Key rotation orchestrator
│   │   │   │   ├── terminal/       # WebSocket SSH proxy
│   │   │   │   ├── security/       # Scanner + audit checks
│   │   │   │   └── logs/           # Audit log queries
│   │   │   ├── jobs/               # BullMQ workers
│   │   │   ├── middleware/         # Auth guard, RBAC, rate limit
│   │   │   └── utils/
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/                        # React frontend
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── Login.tsx
│       │   │   ├── Dashboard.tsx
│       │   │   ├── Servers.tsx
│       │   │   ├── Keys.tsx
│       │   │   ├── Assignments.tsx
│       │   │   ├── Terminal.tsx
│       │   │   ├── Logs.tsx
│       │   │   └── Security.tsx
│       │   ├── components/
│       │   └── api/                # API client (fetch wrappers)
│       ├── Dockerfile
│       └── package.json
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env.example
└── README.md
```

---

## Environment variables (`.env.example`)

```env
# App
NODE_ENV=development
PORT=3001
FRONTEND_URL=http://localhost:3000
SESSION_SECRET=change_me_to_random_64_chars
SESSION_MAX_AGE_MS=28800000        # 8 hours

# CORS
CORS_ORIGIN=http://localhost:3000

# Database
DATABASE_URL=postgresql://sshmanager:password@localhost:5432/sshmanager

# Redis
REDIS_URL=redis://localhost:6379

# Encryption (AES-256-GCM for vault) — 32-byte hex key
VAULT_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000

# Microsoft 365 / Azure AD SSO
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=
MS_CALLBACK_URL=http://localhost:3001/auth/microsoft/callback

# Google Workspace SSO
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3001/auth/google/callback
GOOGLE_HOSTED_DOMAIN=yourcorp.com   # restrict to org domain

# MFA
MFA_ISSUER=SSHManager

# Bootstrap admin (created on first run — must log in via SSO)
BOOTSTRAP_ADMIN_EMAIL=admin@yourcorp.com

# Terminal
TERMINAL_IDLE_TIMEOUT_MIN=30

# Session recordings — stored as files, not in the DB
RECORDINGS_STORAGE_PATH=/var/lib/ssh-manager/recordings

# Rate limiting
RATE_LIMIT_AUTH=10
RATE_LIMIT_API=100

# Notifications (optional — for critical/high security findings)
ALERT_WEBHOOK_URL=               # Slack or generic webhook URL
```

---

## Database schema (PostgreSQL)

Create all tables in a single migration file using Kysely's `FileMigrationProvider`. Implement exactly this schema:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users (synced from SSO providers)
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             VARCHAR(255) NOT NULL UNIQUE,
  display_name      VARCHAR(255),
  provider          VARCHAR(20) NOT NULL CHECK (provider IN ('microsoft', 'google')),
  provider_id       VARCHAR(255) NOT NULL,
  provider_groups   JSONB DEFAULT '[]',
  role              VARCHAR(20) NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('admin', 'operator', 'developer', 'viewer')),
  mfa_secret        TEXT,                    -- encrypted TOTP secret (AES-256-GCM)
  mfa_enabled       BOOLEAN DEFAULT false,
  mfa_backup_codes  JSONB DEFAULT '[]',      -- encrypted backup codes
  is_active         BOOLEAN DEFAULT true,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(provider, provider_id)
);

-- Servers (managed SSH targets)
CREATE TABLE servers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  VARCHAR(100) NOT NULL UNIQUE,
  hostname              VARCHAR(255) NOT NULL,
  ssh_port              INTEGER NOT NULL DEFAULT 22,
  environment           VARCHAR(20) NOT NULL CHECK (environment IN ('production', 'staging', 'development', 'other')),
  tags                  JSONB DEFAULT '{}',
  host_key_fingerprint  VARCHAR(200),
  host_key_verified     BOOLEAN DEFAULT false,
  host_key_last_seen    TIMESTAMPTZ,
  -- Management credentials: used by SSH Manager to perform key operations on this server
  management_key_id     UUID REFERENCES ssh_keys(id),
  management_linux_user VARCHAR(100) NOT NULL DEFAULT 'root',
  is_active             BOOLEAN DEFAULT true,
  last_connected_at     TIMESTAMPTZ,
  added_by              UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- SSH Keys (stored encrypted in vault)
CREATE TABLE ssh_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(100) NOT NULL,
  description       TEXT,
  key_type          VARCHAR(10) NOT NULL DEFAULT 'ed25519'
                    CHECK (key_type IN ('ed25519', 'rsa4096')),
  public_key        TEXT NOT NULL,           -- OpenSSH authorized_keys format
  private_key_enc   TEXT NOT NULL,           -- AES-256-GCM encrypted PEM
  fingerprint       VARCHAR(200) NOT NULL,
  rotation_policy   VARCHAR(20) DEFAULT 'manual'
                    CHECK (rotation_policy IN ('manual', '7d', '30d', '90d')),
  last_rotated_at   TIMESTAMPTZ,
  next_rotation_at  TIMESTAMPTZ,
  is_active         BOOLEAN DEFAULT true,    -- false = soft deleted
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Key assignments (many-to-many: user + key + server + linux user)
CREATE TABLE key_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id        UUID NOT NULL REFERENCES ssh_keys(id) ON DELETE CASCADE,
  server_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  linux_user    VARCHAR(100) NOT NULL,        -- OS user on the remote server
  can_terminal  BOOLEAN DEFAULT true,         -- allow web terminal
  is_active     BOOLEAN DEFAULT true,
  expires_at    TIMESTAMPTZ,                  -- optional time-limited access
  granted_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, key_id, server_id, linux_user)
);

-- Audit log (append-only, tamper-evident — never update or delete rows)
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  user_email  VARCHAR(255),                  -- denormalized for long-term retention
  action      VARCHAR(100) NOT NULL,
  resource    VARCHAR(100),
  resource_id UUID,
  server_id   UUID REFERENCES servers(id),
  details     JSONB DEFAULT '{}',
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Session recordings (metadata only — cast data stored on disk)
CREATE TABLE session_recordings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id),
  server_id       UUID REFERENCES servers(id),
  linux_user      VARCHAR(100),
  started_at      TIMESTAMPTZ DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  duration_s      INTEGER,
  cast_file_path  TEXT,          -- path on disk (RECORDINGS_STORAGE_PATH) or S3 key
  cast_size_bytes INTEGER,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Security scan results
CREATE TABLE security_scans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID REFERENCES servers(id),
  scanned_at  TIMESTAMPTZ DEFAULT now(),
  findings    JSONB DEFAULT '[]',
  severity    VARCHAR(10) CHECK (severity IN ('ok', 'low', 'medium', 'high', 'critical')),
  scan_type   VARCHAR(50)
);

-- Key rotation jobs
CREATE TABLE rotation_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id           UUID REFERENCES ssh_keys(id),
  status           VARCHAR(20) DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'success', 'failed', 'rolled_back')),
  triggered_by     UUID REFERENCES users(id),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  error_message    TEXT,
  -- Shape: [{ server_id, linux_user, status: 'pending'|'success'|'failed', error?: string }]
  affected_servers JSONB DEFAULT '[]',
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_key_assignments_user   ON key_assignments(user_id);
CREATE INDEX idx_key_assignments_server ON key_assignments(server_id);
CREATE INDEX idx_key_assignments_key    ON key_assignments(key_id);
CREATE INDEX idx_audit_logs_user        ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_server      ON audit_logs(server_id);
CREATE INDEX idx_audit_logs_created     ON audit_logs(created_at DESC);
CREATE INDEX idx_servers_env            ON servers(environment);
CREATE INDEX idx_ssh_keys_rotation      ON ssh_keys(next_rotation_at) WHERE is_active = true;
```

> **Note on `management_key_id`:** The foreign key on `servers.management_key_id` references `ssh_keys`, but `ssh_keys` is defined after `servers` in this file. Use `ALTER TABLE` after both tables are created, or reorder the table definitions in the migration.

---

## Backend modules — detailed requirements

### 1. Auth module (`/auth`)

**Routes:**
- `GET /auth/microsoft` — redirect to Azure AD OIDC
- `GET /auth/microsoft/callback` — handle token, sync user, issue session
- `GET /auth/google` — redirect to Google OIDC
- `GET /auth/google/callback` — handle token, sync user, issue session
- `GET /auth/me` — return current session user
- `POST /auth/logout` — destroy session
- `POST /auth/mfa/setup` — generate TOTP secret, return QR code URI
- `POST /auth/mfa/verify` — verify TOTP code, enable MFA on account
- `POST /auth/mfa/validate` — validate TOTP during login (second factor step)
- `GET /auth/mfa/backup-codes` — return encrypted backup codes

**Logic:**
- After OIDC callback: upsert user by `(provider, provider_id)`, update `display_name`, `provider_groups`, `last_login_at`
- If `mfa_enabled = true`, do not issue full session yet — set a `mfa_pending` flag and require `/auth/mfa/validate` before granting access
- MFA secret must be stored AES-256-GCM encrypted in `users.mfa_secret`
- If user's email domain matches neither the MS tenant nor the Google `hosted_domain`, reject login with 403
- Emit `audit_logs` entry on every login attempt (success and failure)
- Bootstrap admin: on first startup, if no users exist, insert a row with `BOOTSTRAP_ADMIN_EMAIL` and role `admin`. The user still logs in via SSO — this just pre-creates the admin record so they get the admin role on first login.

**Microsoft 365 OIDC config:**
```
authority: https://login.microsoftonline.com/{TENANT_ID}/v2.0
clientID: MS_CLIENT_ID
clientSecret: MS_CLIENT_SECRET
callbackURL: MS_CALLBACK_URL
scope: openid profile email
```

**Google OIDC config:**
```
issuer: https://accounts.google.com
authorizationURL: https://accounts.google.com/o/oauth2/v2/auth
tokenURL: https://oauth2.googleapis.com/token
userInfoURL: https://openidconnect.googleapis.com/v1/userinfo
clientID: GOOGLE_CLIENT_ID
clientSecret: GOOGLE_CLIENT_SECRET
callbackURL: GOOGLE_CALLBACK_URL
scope: openid profile email
```

---

### 2. Users module (`/users`)

**Routes (admin only unless noted):**
- `GET /users?page=1&limit=50` — list all users with pagination
- `GET /users/:id` — get user detail
- `PATCH /users/:id` — update role, is_active
- `DELETE /users/:id` — deactivate (set `is_active = false`, revoke all assignments)
- `GET /users/:id/assignments` — list all key assignments for user
- `GET /users/me` — current user profile (any authenticated user)

---

### 3. Servers module (`/servers`)

**Routes:**
- `GET /servers?environment=production&tag=key:value` — list servers (filterable)
- `POST /servers` — register new server (admin/operator)
- `GET /servers/:id` — server detail + last scan result
- `PATCH /servers/:id` — update server details
- `DELETE /servers/:id` — remove server (cascades assignments)
- `POST /servers/:id/verify-host-key` — SSH connect and capture/verify host key fingerprint
- `POST /servers/:id/test-connection` — verify management key can connect successfully
- `GET /servers/:id/assignments` — list all key assignments on this server

**Server registration payload:**
```ts
{
  name: string
  hostname: string
  ssh_port: number                 // default 22
  environment: 'production' | 'staging' | 'development' | 'other'
  tags?: Record<string, string>
  management_key_id: string        // UUID of an existing ssh_key in vault
  management_linux_user: string    // e.g. "root", "sshmanager"
}
```

**Management key concept:**
Every server must have a `management_key_id` and `management_linux_user`. This is the credential SSH Manager uses for ALL administrative operations on that server (pushing/removing authorized_keys entries, running security scans). The management user must have permission to write to other users' `~/.ssh/authorized_keys` (via sudo or by being root). All other SSH operations (key assignments, scans, rotation) must use this management credential to connect, not the assigned user's key.

**Host key verification:**
When `POST /servers/:id/verify-host-key` is called, attempt a connection (collect the host key only — no auth required at this step), store the fingerprint in `host_key_fingerprint`, set `host_key_verified = true` and `host_key_last_seen = now()`. If a fingerprint was previously stored and the new one differs, reject and alert — do not overwrite silently.

---

### 4. SSH Keys module (`/keys`)

**Routes:**
- `GET /keys` — list all keys (public info only — never expose private key)
- `POST /keys/generate` — generate new Ed25519 or RSA-4096 keypair
- `POST /keys/import` — import existing public + private key
- `GET /keys/:id` — key detail + rotation history
- `PATCH /keys/:id` — update name, description, rotation_policy
- `DELETE /keys/:id` — soft delete (`is_active = false`), only if no active assignments
- `GET /keys/:id/public` — download public key file (OpenSSH format)
- `POST /keys/:id/rotate` — trigger immediate rotation

**Key generation:**
```ts
import { generateKeyPairSync } from 'crypto'
import sshpk from 'sshpk'

// Ed25519
const { privateKey: pemPrivate, publicKey: pemPublic } = generateKeyPairSync('ed25519', {
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

// RSA-4096
const { privateKey: pemPrivate, publicKey: pemPublic } = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

// Convert PEM public key → OpenSSH authorized_keys format
const parsedKey = sshpk.parseKey(pemPublic, 'pem')
const authorizedKeysLine = parsedKey.toString('ssh')  // e.g. "ssh-ed25519 AAAA..."
const fingerprint = parsedKey.fingerprint('sha256').toString()

// Store: public_key = authorizedKeysLine, private_key_enc = encrypt(pemPrivate)
```

**Vault encryption:**

All private keys and MFA secrets must be encrypted at rest using AES-256-GCM:

```ts
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGORITHM = 'aes-256-gcm'

export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, masterKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv(hex):tag(hex):ciphertext(base64)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`
}

export function decryptSecret(stored: string, masterKey: Buffer): string {
  const [ivHex, tagHex, ciphertextB64] = stored.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
```

---

### 5. Assignments module (`/assignments`)

**Routes:**
- `GET /assignments?page=1&limit=50` — list assignments (admin/operator see all; developer sees own)
- `POST /assignments` — create assignment (admin/operator only)
- `DELETE /assignments/:id` — revoke assignment
- `GET /assignments/:id` — assignment detail

**Payload:**
```ts
{
  user_id:      string       // UUID
  key_id:       string       // UUID
  server_id:    string       // UUID
  linux_user:   string       // e.g. "ubuntu", "deploy"
  can_terminal?: boolean
  expires_at?:  string       // ISO 8601, optional
}
```

**When an assignment is created:**
1. Look up the server's `hostname`, `ssh_port`, `host_key_fingerprint`, `management_key_id`, `management_linux_user`
2. Retrieve and decrypt the management private key from vault
3. SSH into the server **as the management user** (not as `linux_user`)
4. Append the assigned key's `public_key` (OpenSSH format) to `/home/{linux_user}/.ssh/authorized_keys` (create file + set permissions 600 if not exists; create `.ssh` dir with permissions 700 if not exists)
5. Record success in `audit_logs`
6. If any step fails, rollback (remove key if partially written) and return error

**When an assignment is revoked:**
1. SSH into the server **as the management user**
2. Remove the specific public key line from `/home/{linux_user}/.ssh/authorized_keys`
3. Set `is_active = false` on the assignment record
4. Record in `audit_logs`

---

### 6. Rotation module (`/rotation`)

**Routes:**
- `POST /keys/:id/rotate` — trigger immediate rotation
- `GET /rotation/jobs?page=1&limit=50` — list rotation jobs
- `GET /rotation/jobs/:id` — job detail + per-server status

**Rotation algorithm (atomic, safe):**

```
For key K being rotated:
  1. Generate new keypair (new_key) — same type as K
  2. Find all active assignments using K
  3. Record rotation_job with status = 'running', affected_servers = [{ server_id, linux_user, status: 'pending' }]
  4. For each assignment (server S, linux_user U):
     a. SSH into S using S's management key
     b. Append new_key.public to /home/U/.ssh/authorized_keys  ← both keys valid now
     c. Update affected_servers[i].status = 'success'
  5. If ALL appends succeeded:
     a. For each assignment:
        - SSH into S using management key
        - Remove old_key.public from /home/U/.ssh/authorized_keys
     b. Update ssh_keys record: replace private_key_enc, public_key, fingerprint
     c. Update last_rotated_at, compute next_rotation_at
     d. Update rotation_job.status = 'success'
  6. If ANY append failed:
     a. SSH into each server where new_key was appended, remove it
     b. Update rotation_job.status = 'rolled_back', error_message = <details>
     c. Fire ALERT_WEBHOOK_URL if configured
```

**Scheduled rotation (BullMQ):**

Create a job scheduler that runs every hour, finds all keys where `next_rotation_at <= now()` and `is_active = true`, and enqueues a rotation job for each. Use BullMQ with a `rotation` queue and a dedicated worker.

**Distributed lock:** Use Redis `SETNX` with a TTL to ensure only one worker instance rotates a given key at a time:
```
lock key: rotation:lock:{key_id}
TTL: 10 minutes
```
If the lock cannot be acquired, skip and retry on the next hourly tick.

---

### 7. Terminal module (`/terminal`)

**WebSocket endpoint:** `ws://host/terminal/:serverId?linux_user=ubuntu`

The `linux_user` query parameter is required when the user has multiple assignments on the same server (different linux users). If omitted and the user has exactly one assignment on that server, default to that one. If omitted and multiple exist, return an error.

**Requirements:**
- Authenticate WebSocket upgrade using session cookie
- Verify the requesting user has a valid active `key_assignment` for `server_id` + `linux_user`
- Retrieve the assigned key from vault and connect via SSH to the server
- Pipe WebSocket messages ↔ SSH PTY bidirectionally
- Write session recording to disk at `RECORDINGS_STORAGE_PATH/{recording_id}.cast` in asciinema v2 format
- On disconnect: close SSH session, finalize recording file, update `session_recordings.ended_at`, `duration_s`, `cast_file_path`, `cast_size_bytes`
- Enforce idle timeout: disconnect after `TERMINAL_IDLE_TIMEOUT_MIN` minutes of no input
- Terminal size (cols/rows) must be sent by the client on connect and on resize

**Client message protocol (JSON over WebSocket):**
```ts
// Client → Server
{ type: 'input',  data: string }
{ type: 'resize', cols: number, rows: number }
{ type: 'ping' }

// Server → Client
{ type: 'output',      data: string }
{ type: 'connected',   serverName: string, linuxUser: string }
{ type: 'error',       message: string }
{ type: 'disconnected' }
```

---

### 8. Security scanner module (`/security`)

**Routes:**
- `POST /security/scan/:serverId` — run scan on one server
- `POST /security/scan/all` — enqueue scans for all active servers via BullMQ
- `GET /security/findings?severity=high&page=1&limit=50` — list all findings
- `GET /security/findings/:serverId` — findings for a specific server

**How the scanner connects:** Use the server's `management_key_id` and `management_linux_user` to SSH in, then run each check command.

**What to check per server:**

```ts
const CHECKS = [
  {
    id: 'password_auth',
    description: 'Password authentication should be disabled',
    command: "sshd -T 2>/dev/null | grep '^passwordauthentication'",
    severity: 'high',
    pass: (output: string) => output.includes('no')
  },
  {
    id: 'root_login',
    description: 'Root login should be prohibited',
    command: "sshd -T 2>/dev/null | grep '^permitrootlogin'",
    severity: 'critical',
    pass: (output: string) => output.includes('no') || output.includes('prohibit-password')
  },
  {
    id: 'ssh_protocol',
    description: 'Only SSH protocol 2 should be in use',
    command: "sshd -T 2>/dev/null | grep '^protocol'",
    severity: 'critical',
    pass: (output: string) => !output.includes('1')
  },
  {
    id: 'authorized_keys_permissions',
    description: 'authorized_keys must not be world-readable (must be 600)',
    command: "stat -c '%a' ~/.ssh/authorized_keys 2>/dev/null || echo 'missing'",
    severity: 'high',
    // Only 600 is acceptable — 644 (world-readable) should FAIL
    pass: (output: string) => ['600', 'missing'].includes(output.trim())
  },
  {
    id: 'stale_keys',
    description: 'authorized_keys should not contain unmanaged keys',
    command: "cat ~/.ssh/authorized_keys 2>/dev/null | wc -l",
    severity: 'medium',
    pass: (output: string, context: { managedCount: number }) =>
      parseInt(output.trim()) === context.managedCount
  },
  {
    id: 'x11_forwarding',
    description: 'X11 forwarding should be disabled',
    command: "sshd -T 2>/dev/null | grep '^x11forwarding'",
    severity: 'low',
    pass: (output: string) => output.includes('no')
  }
]
```

Store results in `security_scans`. For any `critical` or `high` finding: write an audit log entry and POST to `ALERT_WEBHOOK_URL` if configured (JSON payload: `{ server, finding, severity, scanned_at }`).

---

### 9. Logs module (`/logs`)

**Routes:**
- `GET /logs/audit?user_id=&server_id=&action=&from=&to=&page=1&limit=50` — paginated audit log
- `GET /logs/sessions?page=1&limit=50` — list session recordings
- `GET /logs/sessions/:id/play` — stream asciinema cast file from disk for playback
- `GET /logs/export` — export audit logs as CSV (admin only)

---

## RBAC middleware

Implement role-based access control with four roles:

```ts
const PERMISSIONS = {
  admin: ['*'],                            // all actions
  operator: [
    'servers:read', 'servers:write',
    'keys:read', 'keys:write', 'keys:rotate',
    'assignments:read', 'assignments:write',
    'terminal:connect',
    'logs:read',
    'security:scan', 'security:read'
  ],
  developer: [
    'servers:read',
    'keys:read',
    'assignments:read',                    // own assignments only
    'terminal:connect',                    // own servers only
    'logs:read'                            // own sessions only
  ],
  viewer: [
    'servers:read',
    'keys:read',
    'logs:read'
  ]
}
```

Create a `requirePermission(permission: string)` Fastify hook that checks the session user's role and rejects with 403 if insufficient.

---

## Frontend pages — requirements

### Login page
- Two buttons: "Sign in with Microsoft 365" and "Sign in with Google"
- Clean centered card layout
- After SSO redirect back, if MFA is required show a TOTP input step

### Dashboard
- Summary cards: total servers, active keys, assignments, recent alerts
- Recent audit log entries (last 10)
- Keys due for rotation (next 7 days)
- Security findings summary (count by severity)

### Servers page
- Table: name, hostname, port, environment, status, last scan severity, actions
- Add server modal — includes management key selector and management linux user field
- Click row → server detail with: connection info, assigned keys/users, scan results, recent sessions
- "Test Connection" button to verify management key works

### Keys page
- Table: name, type, fingerprint (truncated), rotation policy, last rotated, next rotation, assignments count
- Generate key modal (choose Ed25519 or RSA-4096, name, rotation policy)
- Import key modal
- Rotate button with confirmation dialog
- Delete button (disabled if active assignments exist)

### Assignments page
- Table: user, key, server, linux user, granted by, expires, status, actions
- Create assignment modal: select user → select key → select server → enter linux user
- Revoke button

### Terminal page
- Server selector dropdown
- If user has multiple assignments on selected server, show linux_user selector
- xterm.js terminal filling the viewport
- Connected server name and linux user shown in header
- Disconnect / reconnect button
- Session is automatically recorded

### Logs page
- Tabbed: Audit Log | Session Recordings
- Audit log: filterable table with user, action, resource, IP, timestamp
- Session recordings: list with user, server, linux user, duration, play button
- Play button opens an asciinema player (`asciinema-player` npm package or embed via CDN)

### Security page
- Table of servers with latest scan severity badge
- "Scan all" button
- Click server → list of findings with check ID, description, severity, pass/fail

---

## Security requirements

1. All private keys and MFA secrets must be AES-256-GCM encrypted in the database — never stored in plaintext
2. The `VAULT_ENCRYPTION_KEY` must never be logged or exposed via any API endpoint
3. Session cookies: `httpOnly: true`, `secure: true` (in production), `sameSite: 'lax'`, `maxAge: SESSION_MAX_AGE_MS`
4. All API routes (except `/auth/*`) must require a valid session
5. CSRF protection on all state-mutating endpoints
6. Rate limiting: `RATE_LIMIT_AUTH` req/min on `/auth/*`, `RATE_LIMIT_API` req/min on all other routes
7. Host key verification on every SSH connection — reject if fingerprint does not match stored value
8. All SSH connections routed through the bastion (no direct port 22 exposure from outside)
9. Audit log entries must never be updated or deleted — insert only
10. Passwords must never be stored — SSO only (no local password auth)
11. Input validation on all endpoints using `zod` schemas
12. SQL queries must use parameterized queries only — no string interpolation
13. HTTPS enforced in production (terminate at reverse proxy / load balancer)
14. `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security` headers set on all responses
15. Session recordings stored on disk (not in DB) to avoid bloating PostgreSQL with large text blobs
16. Key deletion is always soft (`is_active = false`) — hard deletes are never performed on `ssh_keys`

---

## Docker Compose

```yaml
version: '3.9'
services:
  api:
    build: ./apps/api
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=development
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  web:
    build: ./apps/web
    ports:
      - "3000:3000"
    depends_on:
      - api

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: sshmanager
      POSTGRES_USER: sshmanager
      POSTGRES_PASSWORD: password
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sshmanager"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
  redisdata:
```

> `docker-compose.prod.yml` should extend this with: `restart: always`, no exposed ports for postgres/redis (internal only), `NODE_ENV=production`, volume mount for `RECORDINGS_STORAGE_PATH`, and resource limits.

---

## Additional implementation notes

- Use TypeScript strict mode (`"strict": true`) throughout
- All database queries through Kysely — no raw SQL except in migrations
- Every module should have its own Fastify plugin registered with `fastify-plugin`
- Use `pino` for all logging — structured JSON, never log sensitive fields (private keys, passwords, session tokens, vault key)
- Implement graceful shutdown: drain BullMQ workers, close all active SSH connections, close DB pool
- On first startup: run Kysely migrations automatically, create the bootstrap admin user record if no users exist
- WebSocket connections must authenticate via session cookie in the upgrade request headers — use `fastify-websocket`
- The rotation BullMQ worker must acquire a Redis distributed lock (`SETNX rotation:lock:{key_id}`, TTL 10 min) before starting — skip if lock cannot be acquired
- The security scanner uses the server's management key to connect — it must reuse the same SSH connection pool pattern as the assignments and rotation modules to avoid redundant connections per server within a single job
- Write unit tests for: vault encrypt/decrypt, rotation algorithm, RBAC middleware, assignment push/revoke logic, host key verification
- Write integration tests for: auth flow (mock OIDC), key CRUD, assignment CRUD, rotation job end-to-end
- Include a `README.md` with: setup instructions, environment variable reference, how to onboard a server (including setting up the management user with correct sudo permissions), how to configure Azure AD app registration, how to configure Google OAuth2 app

---

## Deliverable checklist

- [ ] Full monorepo with `apps/api` and `apps/web`
- [ ] All database migrations (Kysely `FileMigrationProvider`)
- [ ] All backend modules with routes, validation, and business logic
- [ ] Vault encryption/decryption utility (`encryptSecret` / `decryptSecret`)
- [ ] `sshpk` integration for PEM → OpenSSH key format conversion
- [ ] Management key concept wired into server registration, assignments, rotation, and security scanner
- [ ] BullMQ rotation worker with scheduler + Redis distributed lock
- [ ] BullMQ security scan worker for `POST /security/scan/all`
- [ ] WebSocket SSH terminal proxy with session recording to disk
- [ ] React frontend with all 8 pages
- [ ] xterm.js terminal integration with linux_user selector
- [ ] RBAC middleware (`requirePermission`)
- [ ] Audit logging on all write operations
- [ ] Docker Compose (dev) with health checks + `docker-compose.prod.yml`
- [ ] `.env.example` with all variables
- [ ] `README.md` with setup guide and server onboarding instructions
- [ ] Unit + integration tests
