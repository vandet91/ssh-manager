import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { api, User } from './api/client'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Keys from './pages/Keys'
import Assignments from './pages/Assignments'
import Terminal from './pages/Terminal'
import Logs from './pages/Logs'
import Security from './pages/Security'
import Users from './pages/Users'
import Layout from './components/Layout'
import Settings from './pages/Settings'

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
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login onLogin={setUser} />} />
        {user ? (
          <Route element={<Layout user={user} onLogout={() => setUser(null)} theme={theme} setTheme={setTheme} />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/servers"   element={<Servers />} />
            <Route path="/keys"      element={<Keys />} />
            <Route path="/assignments" element={<Assignments />} />
            <Route path="/terminal"  element={<Terminal />} />
            <Route path="/logs"      element={<Logs />} />
            <Route path="/security"  element={<Security />} />
            <Route path="/users"     element={<Users />} />
            <Route path="/settings"  element={<Settings />} />
            <Route path="*"          element={<Navigate to="/dashboard" replace />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </BrowserRouter>
  )
}

export default App
