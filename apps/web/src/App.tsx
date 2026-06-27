import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { api, User, setForbiddenHandler, setMfaRequiredHandler } from './api/client'
import { TotpElevationProvider } from './context/TotpElevationContext'
import { PermissionProvider, setPermissionRole } from './context/PermissionContext'
import Login from './pages/Login'
import MfaSetup from './pages/MfaSetup'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Keys from './pages/Keys'
import Assignments from './pages/Assignments'
import Terminal from './pages/Terminal'
import Logs from './pages/Logs'
import MyActivity from './pages/MyActivity'
import Users from './pages/Users'
import Layout from './components/Layout'
import Settings from './pages/Settings'
import Migration from './pages/Migration'
import FileManager from './pages/FileManager'
import RemoteDesktopPage from './pages/RemoteDesktopPage'
import NetworkDevices from './pages/NetworkDevices'
import Share from './pages/Share'
import ShareCenter from './pages/ShareCenter'
import CommandLibrary from './pages/CommandLibrary'
import Vault from './pages/Vault'
import Domain from './pages/Domain'
import PsExec from './pages/PsExec'
import PsExecShellPopup from './pages/PsExecShellPopup'
import DbConnector from './pages/DbConnector'
import Diagrams from './pages/Diagrams'
import FirmwareRepo from './pages/FirmwareRepo'
import NetworkScan from './pages/NetworkScan'
import Security from './pages/Security'
import Documentation from './pages/Documentation'
import Tasks from './pages/Tasks'

export type ThemeName = 'modern' | 'proxmox'
export type ThemeMode = 'dark' | 'light'
export type Theme = `${ThemeName}-${ThemeMode}`

const THEME_KEY = 'ssh-mgr-theme'
const MODE_KEY  = 'ssh-mgr-mode'

function ForbiddenToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 5000)
    return () => clearTimeout(t)
  }, [onDismiss])
  return (
    <div onClick={onDismiss} style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: '#7f1d1d', border: '1px solid #991b1b', borderRadius: 10,
      padding: '12px 20px', color: '#fca5a5', fontSize: 13, fontWeight: 500,
      zIndex: 9999, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)', maxWidth: 480, textAlign: 'center',
    }}>
      <span style={{ fontSize: 16 }}>ðŸš«</span>
      <span>{message}</span>
    </div>
  )
}

// Inner component so useNavigate works inside BrowserRouter
function AppRoutes({ user, setUser, themeName, setThemeName, themeMode, setThemeMode, forbiddenMsg, setForbiddenMsg }: {
  user: User | null; setUser: (u: User | null) => void
  themeName: ThemeName; setThemeName: (t: ThemeName) => void
  themeMode: ThemeMode; setThemeMode: (m: ThemeMode) => void
  forbiddenMsg: string; setForbiddenMsg: (m: string) => void
}) {
  const nav = useNavigate()
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    setForbiddenHandler((msg) => setForbiddenMsg(msg))
    setMfaRequiredHandler(() => navRef.current('/mfa-setup', { replace: true }))
  }, [])

  const reloadUser = () => {
    return api.get<User>('/auth/me')
      .then(u => { setPermissionRole('admin'); setUser(u) })
      .catch(() => {})
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/share-center" element={<ShareCenter />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<Login onLogin={(u) => { setPermissionRole('admin'); setUser(u) }} />} />
      </Routes>
    )
  }

  return (
    <>
      {forbiddenMsg && <ForbiddenToast message={forbiddenMsg} onDismiss={() => setForbiddenMsg('')} />}
      <Routes>
        <Route path="/share-center" element={<ShareCenter />} />
        <Route path="/login" element={<Navigate to="/dashboard" replace />} />
        <Route path="/mfa-setup" element={<MfaSetup onDone={reloadUser} />} />
        <Route path="/psexec-shell" element={<PsExecShellPopup />} />
        <Route element={<Layout user={user} onLogout={() => setUser(null)} themeName={themeName} setThemeName={setThemeName} themeMode={themeMode} setThemeMode={setThemeMode} />}>
          <Route path="/dashboard"      element={<Dashboard />} />
          <Route path="/servers"        element={<Servers />} />
          <Route path="/keys"           element={<Keys />} />
          <Route path="/assignments"    element={<Assignments />} />
          <Route path="/terminal"       element={<Terminal />} />
          <Route path="/remote-desktop" element={<RemoteDesktopPage />} />
          <Route path="/network-devices" element={<NetworkDevices />} />
          <Route path="/share"          element={<Share />} />
          <Route path="/commands"       element={<CommandLibrary />} />
          <Route path="/vault"          element={<Vault />} />
          <Route path="/domain"         element={<Domain />} />
          <Route path="/psexec"         element={<PsExec />} />
          <Route path="/db-connector"   element={<DbConnector />} />
          <Route path="/diagrams"       element={<Diagrams />} />
          <Route path="/firmware-repo"  element={<FirmwareRepo />} />
          <Route path="/network-scan"   element={<NetworkScan />} />
          <Route path="/security"       element={<Security />} />
          <Route path="/docs"           element={<Documentation />} />
          <Route path="/tasks"          element={<Tasks />} />
          <Route path="/logs"           element={<Logs />} />
          <Route path="/activity"       element={<MyActivity />} />
          <Route path="/migration"      element={<Migration />} />
          <Route path="/filemanager"    element={<FileManager />} />
          <Route path="/users"          element={<Users />} />
          <Route path="/settings"       element={<Settings />} />
          <Route path="*"               element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </>
  )
}

function App() {
  const [user, setUser]           = useState<User | null | undefined>(undefined)
  const [forbiddenMsg, setForbiddenMsg] = useState('')
  const [themeName, setThemeName] = useState<ThemeName>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'proxmox') return 'proxmox'
    return 'modern'
  })
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved === 'light') return 'light'
    return 'dark'
  })

  useEffect(() => {
    const root = document.documentElement
    const combined: Theme = `${themeName}-${themeMode}`
    if (combined === 'modern-dark') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', combined)
    localStorage.setItem(THEME_KEY, themeName)
    localStorage.setItem(MODE_KEY, themeMode)
  }, [themeName, themeMode])

  useEffect(() => {
    api.get<User>('/auth/me')
      .then(u => { setPermissionRole('admin'); setUser(u) })
      .catch(() => setUser(null))
  }, [])

  if (user === undefined) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-body)' }}>
        <div style={{ width: 28, height: 28, border: '3px solid var(--border-med)', borderTopColor: 'var(--accent-hex)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    )
  }

  return (
    <TotpElevationProvider>
    <PermissionProvider>
    <BrowserRouter>
      <AppRoutes
        user={user ?? null} setUser={setUser}
        themeName={themeName} setThemeName={setThemeName}
        themeMode={themeMode} setThemeMode={setThemeMode}
        forbiddenMsg={forbiddenMsg} setForbiddenMsg={setForbiddenMsg}
      />
    </BrowserRouter>
    </PermissionProvider>
    </TotpElevationProvider>
  )
}

export default App

