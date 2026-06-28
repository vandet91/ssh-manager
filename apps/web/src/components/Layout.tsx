import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { api, User } from '../api/client'
import { setPermissionRole } from '../context/PermissionContext'
import type { ThemeName, ThemeMode } from '../App'
import Terminal from '../pages/Terminal'
import RemoteDesktopPage from '../pages/RemoteDesktopPage'


const PERSISTENT_ROUTES = ['/terminal', '/remote-desktop']

// adminOnly: visible to admin only; operatorOk: visible to both admin and operator
const nav: { to: string; label: string; icon: string; adminOnly?: boolean; group?: string }[] = [
  // ── Overview
  { to: '/dashboard',       label: 'Dashboard',         icon: '▣',  group: 'Overview' },

  // ── Access
  { to: '/terminal',        label: 'Terminal',          icon: '⌨',  group: 'Access' },
  { to: '/remote-desktop',  label: 'Remote Desktop',    icon: '🖥',  group: 'Access' },
  { to: '/filemanager',     label: 'File Manager',      icon: '⊟',  group: 'Access' },
  { to: '/psexec',          label: 'Remote Exec',       icon: '⚡',  group: 'Access',  adminOnly: true },

  // ── Infrastructure
  { to: '/servers',         label: 'Servers',           icon: '◫',  group: 'Infrastructure' },
  { to: '/network-devices', label: 'Network Devices',   icon: '🌐',  group: 'Infrastructure' },
  { to: '/domain',          label: 'Domain',            icon: '🏢',  group: 'Infrastructure' },

  // ── Security & Keys
  { to: '/keys',            label: 'Keys',              icon: '⚷',  group: 'Security' },
  { to: '/vault',           label: 'Vault',             icon: '🔐',  group: 'Security' },
  { to: '/security',        label: 'Security',          icon: '🛡',  group: 'Security', adminOnly: true },
  { to: '/assignments',     label: 'Assignments',       icon: '⊞',  group: 'Security', adminOnly: true },

  // ── Tools
  { to: '/db-connector',    label: 'DB Connector',      icon: '🗄',  group: 'Tools' },
  { to: '/network-scan',    label: 'Network Scanner',   icon: '🔍',  group: 'Tools' },
  { to: '/diagrams',        label: 'Diagrams',          icon: '📐',  group: 'Tools' },
  { to: '/docs',            label: 'Documentation',     icon: '📖',  group: 'Tools' },
  { to: '/tasks',           label: 'Tasks',             icon: '📋',  group: 'Tools' },
  { to: '/db-manager',     label: 'DB Manager',        icon: '🗄',  group: 'Tools', adminOnly: true },
  { to: '/commands',        label: 'Commands',          icon: '⌘',   group: 'Tools',   adminOnly: true },
  { to: '/share',           label: 'Share',             icon: '🔗',  group: 'Tools',   adminOnly: true },
  { to: '/firmware-repo',   label: 'Firmware & Backup', icon: '💾',  group: 'Tools' },

  // ── Admin
  { to: '/users',           label: 'Users',             icon: '◉',  group: 'Admin', adminOnly: true },
  { to: '/logs',            label: 'Logs',              icon: '≡',  group: 'Admin', adminOnly: true },
  { to: '/migration',       label: 'Migration',         icon: '⇄',  group: 'Admin', adminOnly: true },
  { to: '/settings',        label: 'Settings',          icon: '⚙',  group: 'Admin', adminOnly: true },
]

interface Props {
  user: User
  onLogout: () => void
  themeName: ThemeName
  setThemeName: (t: ThemeName) => void
  themeMode: ThemeMode
  setThemeMode: (m: ThemeMode) => void
}

export default function Layout({ user, onLogout, themeName, setThemeName, themeMode, setThemeMode }: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const isDark = themeMode === 'dark'
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
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-body)' }}>

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
          padding: '16px 20px 12px',
          borderBottom: '1px solid var(--sidebar-border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
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

          {/* Theme picker */}
          <div style={{ display: 'flex', gap: 6 }}>
            {/* Modern / Proxmox toggle */}
            <div style={{
              display: 'flex', flex: 1,
              background: 'rgba(0,0,0,0.25)',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}>
              {(['modern', 'proxmox'] as ThemeName[]).map(name => (
                <button
                  key={name}
                  onClick={() => setThemeName(name)}
                  style={{
                    flex: 1, padding: '4px 0',
                    fontSize: 11, fontWeight: 500,
                    border: 'none', cursor: 'pointer',
                    borderRadius: 5,
                    background: themeName === name ? 'var(--accent-hex)' : 'transparent',
                    color: themeName === name ? '#fff' : 'var(--sidebar-text)',
                    transition: 'background 0.15s, color 0.15s',
                    textTransform: 'capitalize',
                  }}
                >
                  {name}
                </button>
              ))}
            </div>

            {/* Dark / Light toggle */}
            <button
              onClick={() => setThemeMode(isDark ? 'light' : 'dark')}
              title={isDark ? 'Switch to Light mode' : 'Switch to Dark mode'}
              style={{
                width: 30, height: 30, borderRadius: 6, flexShrink: 0,
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--sidebar-text)',
                cursor: 'pointer', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.25)')}
            >
              {isDark ? '☀' : '🌙'}
            </button>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px', display: 'flex', flexDirection: 'column', gap: 1, overflowY: 'auto' }}>
          {(() => {
            const items: React.ReactNode[] = []
            let lastGroup = ''
            for (const { to, label, icon, group } of visibleNav) {
              if (group && group !== lastGroup) {
                if (lastGroup) items.push(<div key={`sep-${group}`} style={{ height: 1, background: 'var(--sidebar-border)', margin: '5px 4px 4px' }} />)
                items.push(
                  <p key={`grp-${group}`} style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                    textTransform: 'uppercase', color: 'var(--sidebar-text)',
                    opacity: 0.4, padding: '4px 12px 2px', margin: 0,
                  }}>{group}</p>
                )
                lastGroup = group
              }
              items.push(
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
              )
            }
            return items
          })()}
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
