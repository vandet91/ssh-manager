import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { api, User } from './api/client'
import { TotpElevationProvider } from './context/TotpElevationContext'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Keys from './pages/Keys'
import Assignments from './pages/Assignments'
import Terminal from './pages/Terminal'
import Logs from './pages/Logs'
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

export type Theme = 'github' | 'proxmox'

const THEME_KEY = 'ssh-mgr-theme'

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'github' || saved === 'proxmox') return saved
    return 'github'   // default: GitHub dark
  })

  useEffect(() => {
    const root = document.documentElement
    // github = :root (no attribute), proxmox = data-theme="proxmox"
    if (theme === 'github') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', theme)
    }
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    api.get<User>('/auth/me').then(setUser).catch(() => setUser(null))
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
    <BrowserRouter>
      <Routes>
        <Route path="/share-center" element={<ShareCenter />} />
        <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login onLogin={setUser} />} />
        {user ? (
          <>
          <Route path="/psexec-shell" element={<PsExecShellPopup />} />
          <Route element={<Layout user={user} onLogout={() => setUser(null)} theme={theme} setTheme={setTheme} />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/servers"   element={<Servers />} />
            <Route path="/keys"      element={<Keys />} />
            <Route path="/assignments" element={<Assignments />} />
            <Route path="/terminal"  element={<Terminal />} />
            <Route path="/remote-desktop" element={<RemoteDesktopPage />} />
            <Route path="/network-devices" element={<NetworkDevices />} />
            <Route path="/share" element={<Share />} />
            <Route path="/commands" element={<CommandLibrary />} />
            <Route path="/vault"    element={<Vault />} />
            <Route path="/domain"   element={<Domain />} />
            <Route path="/psexec"   element={<PsExec />} />
            <Route path="/db-connector" element={<DbConnector />} />
            <Route path="/diagrams" element={<Diagrams />} />
            <Route path="/firmware-repo" element={<FirmwareRepo />} />
            <Route path="/network-scan" element={<NetworkScan />} />
            <Route path="/logs"      element={<Logs />} />
            <Route path="/migration" element={<Migration />} />
            <Route path="/filemanager" element={<FileManager />} />
            <Route path="/users"     element={<Users />} />
            <Route path="/settings"  element={<Settings />} />
            <Route path="*"          element={<Navigate to="/dashboard" replace />} />
          </Route>
          </>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </BrowserRouter>
    </TotpElevationProvider>
  )
}

export default App
