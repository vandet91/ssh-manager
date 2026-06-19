import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { api, User } from '../api/client'
import type { Theme } from '../App'
import Terminal from '../pages/Terminal'
import RemoteDesktopPage from '../pages/RemoteDesktopPage'

const PERSISTENT_ROUTES = ['/terminal', '/remote-desktop']

const nav = [
  { to: '/dashboard',   label: 'Dashboard',  icon: '▣' },
  { to: '/servers',     label: 'Servers',     icon: '◫' },
  { to: '/keys',        label: 'Keys',        icon: '⚷' },
  { to: '/assignments', label: 'Assignments', icon: '⊞' },
  { to: '/network-devices',  label: 'Network Devices', icon: '🌐' },
  { to: '/share',           label: 'Share',          icon: '🔗' },
  { to: '/commands',        label: 'Commands',       icon: '📚' },
  { to: '/vault',           label: 'Vault',          icon: '🔐' },
  { to: '/domain',          label: 'Domain',         icon: '🏢' },
  { to: '/psexec',          label: 'Remote Exec',    icon: '⚡' },
  { to: '/db-connector',   label: 'DB Connector',   icon: '🗄' },
  { to: '/terminal',        label: 'Terminal',       icon: '⌨' },
  { to: '/remote-desktop',  label: 'Remote Desktop', icon: '🖥' },
  { to: '/logs',        label: 'Logs',        icon: '≡' },
  { to: '/migration',   label: 'Migration',   icon: '⇄' },
  { to: '/filemanager', label: 'File Manager', icon: '⊟' },
  { to: '/users',       label: 'Users',       icon: '◉' },
  { to: '/settings',    label: 'Settings',    icon: '⚙' },
]

const ROLE_STYLE: Record<string, React.CSSProperties> = {
  admin:    { color: '#f85149' },
  operator: { color: '#d29922' },
  developer:{ color: 'var(--accent-hex)' },
  viewer:   { color: 'var(--text-muted)' },
}

interface Props {
  user: User
  onLogout: () => void
  theme: Theme
  setTheme: (t: Theme) => void
}

export default function Layout({ user, onLogout, theme, setTheme }: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const isDark = theme === 'github'
  const isPersistent = PERSISTENT_ROUTES.includes(location.pathname)

  const logout = async () => {
    await api.post('/auth/logout')
    onLogout()
    navigate('/login')
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-body)' }}>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside style={{
        width: 220,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--sidebar-border)',
        position: 'relative',
      }}>

        {/* Brand */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--sidebar-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 6,
              background: 'var(--accent-hex)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, color: '#fff', fontWeight: 700, flexShrink: 0,
              userSelect: 'none',
            }}>
              S
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--sidebar-active-text)', letterSpacing: '0.01em' }}>
                SSH Manager
              </div>
              <div style={{ fontSize: 11, color: 'var(--sidebar-text)', marginTop: 1 }}>v1.0</div>
            </div>
          </div>

          {/* Dark / Light toggle */}
          <button
            onClick={() => setTheme(isDark ? 'proxmox' : 'github')}
            title={isDark ? 'Switch to Proxmox Light' : 'Switch to GitHub Dark'}
            style={{
              width: 28, height: 28, borderRadius: 6, flexShrink: 0,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'var(--sidebar-text)',
              cursor: 'pointer', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          >
            {isDark ? '☀' : '◑'}
          </button>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {nav.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 12px',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: isActive ? 500 : 400,
                textDecoration: 'none',
                transition: 'background 0.1s',
                background: isActive ? 'var(--sidebar-active-bg)' : 'transparent',
                borderLeft: isActive ? `3px solid var(--sidebar-active-border)` : '3px solid transparent',
                paddingLeft: isActive ? 9 : 12,
                color: isActive ? 'var(--sidebar-active-text)' : 'var(--sidebar-text)',
              })}
            >
              <span style={{ width: 16, textAlign: 'center', fontSize: 12, flexShrink: 0 }}>{icon}</span>
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--sidebar-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
            <span style={{
              fontSize: 12, color: 'var(--sidebar-active-text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {user.email}
            </span>
          </div>
          <div style={{
            ...(ROLE_STYLE[user.role] ?? {}),
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.08em', fontFamily: 'monospace', marginBottom: 8,
          }}>
            {user.role}
          </div>
          <button
            onClick={logout}
            style={{
              fontSize: 12, color: 'var(--sidebar-text)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              transition: 'color 0.1s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--sidebar-active-text)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--sidebar-text)')}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-body)', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Persistent pages: always mounted, hidden when not active so sessions survive navigation */}
        <div style={{ display: location.pathname === '/terminal' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
          <Terminal />
        </div>
        <div style={{ display: location.pathname === '/remote-desktop' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
          <RemoteDesktopPage />
        </div>
        {/* All other routed pages */}
        {!isPersistent && <Outlet />}
      </main>
    </div>
  )
}
