# SSH Manager

A self-hosted web platform for centralized SSH access, server monitoring, and infrastructure operations. Built with React + Fastify + PostgreSQL, deployed via Docker Compose.

---

## Features

### Dashboard
- Live stats: active servers, SSH keys, vault entries, recent audit events
- Server status overview grouped by environment (production / staging / development)
- Quick-action shortcuts to common pages

### Servers
- Full server inventory with hostname, SSH port, OS type, environment, and tags
- OS detection with distro art display (auto-fetched from `/etc/os-release`)
- SSHD status check and root account vault management
- Host type classification (bare-metal, VM, container, cloud, etc.)
- Windows / Linux / Router / AP / Switch / DVR / NVR support
- Domain controller flag and RDP-ready status

### Terminal
- Browser-based SSH terminal powered by **xterm.js** over WebSocket
- Multi-tab sessions (open multiple servers side by side)
- Server picker grouped by **environment** using `<optgroup>`
- Per-session font size control
- SFTP file upload via drag-and-drop
- Command history sidebar with searchable **Command Library**
- Linux and Windows command sets with category filters

### Keys
- SSH key management (generate, import, archive)
- Assign keys to servers with per-user Linux user mapping
- Key rotation policies with configurable intervals and rotation history

### Credentials
- Stored password credentials per server, encrypted at rest
- Credential categories and labels

### Assignments
- Per-server, per-user terminal access control
- Linux user mapping per assignment, domain credential linking
- Active/inactive toggle

### Network Devices
- Inventory of routers, switches, access points, DVRs, NVRs
- SNMP polling (v1/v2c/v3) with VLAN discovery
- Web UI access links, SSH access (key or password), ping/last-seen tracking

### Network Scanner
- LAN/subnet ping sweep + port probe
- Auto-discovery of new devices with export to server/device inventory

### Security
- Automated per-server security scans (SSH hardening, open ports, firewall, etc.)
- Severity scoring: critical / high / medium / low / info
- **Finding suppression** — acknowledge false positives per-server with a reason, persisted in DB
- Open-port **reference table** — 40+ common ports with risk categories (safe / db / cluster / infra / review), highlights ports found on the scanned server
- Suppressed findings shown at reduced opacity with show/hide toggle
- Admin-only

### Domain
- Active Directory / domain controller management
- Domain auth switching per server
- **PingCastle** report upload and viewer (AD security scoring)

### Remote Exec (PsExec)
- Run commands on Windows hosts remotely
- Interactive shell popup
- Admin-only

### Remote Desktop
- RDP session launcher in the browser
- Per-server RDP configuration

### DB Connector
- Connect to PostgreSQL or MySQL databases directly from the browser
- Run queries, view results in a table
- Multiple saved connections

### Diagrams
- Interactive network diagram builder with large MDI icon library (search + category filter)
- Canvas customization: **background color**, **grid color**, **grid size** (10–120 px), show/hide grid toggle
- Right panel with **independent scrolling** device list and sticky search header
- Save/load multiple diagrams per account

### Documentation
- Rich-text documentation editor powered by **TipTap v2**
- Image upload, resize (drag handles), and delete
- **Greenshot-style annotation tool** — draw directly on images:
  - Tools: Pen (freehand), Arrow, Rectangle, Circle, Text, Highlight
  - Color picker and stroke size control
  - Undo support and Save (re-uploads annotated image)
  - Implemented via React Portal to work inside TipTap's contentEditable area

### File Manager
- SFTP-based file browser per server
- Upload, download, and browse directories

### Firmware & Backup
- Firmware file repository for network devices
- Config backup storage

### Vault
- Encrypted secret storage (passwords, tokens, notes)
- Organizational units (OUs) for grouping
- Archive/restore support
- Optional TOTP re-verification required to reveal secrets

### Share Center
- Secure credential sharing between users
- PIN-protected shares with expiry

### Command Library
- Shared library of reusable shell commands
- Categories, labels, and descriptions
- Usable directly from the terminal sidebar

### Users
- User management with role-based access (admin / standard)
- MFA setup (TOTP authenticator app)
- Per-user MFA exemption configuration
- Session management

### Logs
- Full audit log of all user actions (login, key ops, server changes, vault reveals, etc.)
- Color-coded by action type
- Admin-only

### Migration
- In-app database migration runner
- Before/after snapshot comparison
- Admin-only

### Settings (Admin)
- **Login page background** image upload with full-screen cover
- **Telegram** notifications — bot token + chat ID, per-event toggles
- **TOTP action rules** — require MFA re-verification for sensitive actions (vault reveal, key rotation, etc.)
- **SSO** — Microsoft 365 (OAuth2) and Google OAuth2
- **RADIUS** server configuration
- Alert thresholds and notification preferences
- Theme selection (modern / proxmox × dark / light)

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
| Auth | Session-based + MFA (TOTP) + SSO (Microsoft / Google OAuth2) + RADIUS |
| Deploy | Docker Compose |

---

## Project Structure

```
apps/
  api/
    src/
      modules/          # Feature modules
        auth/           # Login, MFA, SSO, RADIUS
        servers/        # Server CRUD, OS info, SSHD
        terminal/       # WebSocket SSH terminal
        keys/           # SSH key management + rotation
        credentials/    # Stored passwords
        assignments/    # User-server access control
        security/       # Security scans + suppressions
        vault/          # Encrypted secrets
        domain/         # AD / domain controller
        db-connector/   # Browser DB queries
        diagrams/       # Network diagrams
        docs/           # Documentation editor
        commands/       # Command library
        logs/           # Audit logs
        network-scan/   # LAN scanner
        firmware-repo/  # Firmware storage
        share/          # Credential sharing
        pingcastle/     # AD security reports
        radius/         # RADIUS auth
        settings/       # App settings
        telegram/       # Telegram notifications
        users/          # User management
        migration/      # DB migration runner
        rdp/            # Remote desktop
        psexec/         # Remote exec (Windows)
      db/
        migrations/     # 45 schema migrations
        client.ts       # Kysely DB client
      jobs/             # Background workers (security scan, key rotation)
  web/
    src/
      pages/            # React page components
      components/       # Layout, Modal, Badge, TotpModal
      api/              # Typed API client
      context/          # Auth, permissions, TOTP elevation
```

---

## Quick Start

### Development

```bash
npm install
npm run dev
```

### Production

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Dev — rebuild web only

```bash
docker compose up -d --build web
```

### Dev — rebuild api + web

```bash
docker compose up -d --build api web
```

---

## Environment Variables

Create `apps/api/.env`:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/sshmanager
SESSION_SECRET=change-me
ENCRYPTION_KEY=32-byte-hex-key
```

---

## License

Private / internal use.
