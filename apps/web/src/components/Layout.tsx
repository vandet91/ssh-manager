import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { api, User } from '../api/client'
import { setPermissionRole } from '../context/PermissionContext'
import type { Theme } from '../App'
import Terminal from '../pages/Terminal'
import RemoteDesktopPage from '../pages/RemoteDesktopPage'


const PERSISTENT_ROUTES = ['/terminal', '/remote-desktop']

// adminOnly: visible to admin only; operatorOk: visible to both admin and operator
const nav: { to: string; label: string; icon: string; adminOnly?: boolean }[] = [
  { to: '/dashboard',       label: 'Dashboard',         icon: '▣' },
  { to: '/servers',         label: 'Servers',           icon: '◫' },
  { to: '/keys',            label: 'Keys',              icon: '⚷' },
  { to: '/assignments',     label: 'Assignments',       icon: '⊞',  adminOnly: true },
  { to: '/network-devices', label: 'Network Devices',   icon: '🌐' },
  { to: '/share',           label: 'Share',             icon: '🔗',  adminOnly: true },
  { to: '/commands',        label: 'Commands',          icon: '📚', adminOnly: true },
  { to: '/vault',           label: 'Vault',             icon: '🔐' },
  { to: '/domain',          label: 'Domain',            icon: '🏢' },
  { to: '/psexec',          label: 'Remote Exec',       icon: '⚡', adminOnly: true },
  { to: '/db-connector',    label: 'DB Connector',      icon: '🗄' },
  { to: '/diagrams',        label: 'Diagrams',          icon: '📐' },
  { to: '/firmware-repo',   label: 'Firmware & Backup', icon: '💾' },
  { to: '/network-scan',    label: 'Network Scanner',   icon: '🔍' },
  { to: '/terminal',        label: 'Terminal',          icon: '⌨' },
  { to: '/remote-desktop',  label: 'Remote Desktop',    icon: '🖥' },
  { to: '/logs',            label: 'Logs',              icon: '≡',  adminOnly: true },
  { to: '/migration',       label: 'Migration',         icon: '⇄',  adminOnly: true },
  { to: '/filemanager',     label: 'File Manager',      icon: '⊟' },
  { to: '/users',           label: 'Users',             icon: '◉',  adminOnly: true },
  { to: '/settings',        label: 'Settings',          icon: '⚙',  adminOnly: true },
]

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
  const isAdmin = true

  const visibleNav = nav.filter(({ adminOnly }) => adminOnly ? isAdmin : true)

  const logout = async () => {
    await api.post('/auth/logout')
    setPermissionRole(null)
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
        position: 'sticky',
        top: 0,
        height: '100vh',
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
          {visibleNav.map(({ to, label, icon }) => (
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
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-body)', minWidth: 0, display: 'flex', flexDirection: 'column', scrollbarGutter: 'stable' }}>
        {!isPersistent && <Outlet />}
      </main>

      {/* Persistent pages — fixed overlay, outside layout flow, no impact on global scroll */}
      <div style={{ position: 'fixed', top: 0, left: 220, right: 0, bottom: 0, display: location.pathname === '/terminal' ? 'flex' : 'none', flexDirection: 'column', zIndex: 10 }}>
        <Terminal />
      </div>
      <div style={{ position: 'fixed', top: 0, left: 220, right: 0, bottom: 0, display: location.pathname === '/remote-desktop' ? 'flex' : 'none', flexDirection: 'column', zIndex: 10 }}>
        <RemoteDesktopPage />
      </div>
    </div>
  )
}
