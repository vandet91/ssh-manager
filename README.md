# SSH Manager

A self-hosted web platform for centralized SSH access management, server monitoring, and infrastructure operations.

## Features

- **Terminal** — Browser-based SSH terminal with multi-tab support, grouped server picker by environment, and command library
- **Servers** — Inventory with OS detection, SSHD status, root vault, distro art, and environment tagging
- **Security** — Automated security scans per server with severity scoring, finding suppression, and open-port reference table
- **Keys** — SSH key management with rotation and assignment to servers/users
- **Credentials** — Stored password credentials per server with encrypted vault
- **Users & Assignments** — User management with per-server terminal access assignments
- **Diagrams** — Interactive network diagram builder with icon library, canvas customization (background color, grid size, grid color), and independent panel scrolling
- **DB Connector** — Query PostgreSQL/MySQL databases directly from the browser
- **File Manager** — SFTP-based file browser per server
- **Documentation** — Rich-text editor (TipTap) with image upload, resize, delete, and Greenshot-style annotation/drawing tool (arrows, rectangles, circles, text, highlights, freehand pen)
- **Network Scan** — LAN/subnet scanning and device discovery
- **Remote Desktop** — RDP session launcher
- **PsExec** — Remote command execution on Windows hosts
- **Domain** — Active Directory / domain controller management
- **Logs** — Audit log viewer for all user actions
- **Vault** — Encrypted secret storage
- **Share Center** — Secure credential sharing between users
- **Firmware Repo** — Firmware file repository for network devices
- **Settings** — Login page background, Telegram notifications, TOTP action rules, SSO (Microsoft / Google), and more

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, TipTap |
| Backend | Fastify, TypeScript, Kysely ORM |
| Database | PostgreSQL |
| Terminal | xterm.js over WebSocket |
| Auth | Session-based + MFA (TOTP) + SSO (OAuth2) |
| Deploy | Docker Compose |

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

### Dev rebuild (web only)

```bash
docker compose up -d --build web
```

### Dev rebuild (api + web)

```bash
docker compose up -d --build api web
```

## Project Structure

```
apps/
  api/          # Fastify backend
    src/
      modules/  # Feature modules (auth, servers, terminal, security, …)
      db/       # Kysely client + migrations
      jobs/     # Background workers (security scans, key rotation)
  web/          # React frontend
    src/
      pages/    # Page components
      api/      # API client
      components/
```

## Environment Variables

Copy `.env.example` to `.env` in `apps/api/` and fill in:

```
DATABASE_URL=postgresql://user:pass@localhost:5432/sshmanager
SESSION_SECRET=...
```

## License

Private / internal use.
