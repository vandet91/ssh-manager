import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, User } from '../api/client'

interface Props { onLogin: (user: User) => void }

type Tab = 'local' | 'sso'

export default function Login({ onLogin }: Props) {
  const [searchParams] = useSearchParams()
  const mfaRequired = searchParams.get('mfa') === 'required'
  const authError = searchParams.get('error')

  const [tab, setTab] = useState<Tab>('local')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [mfaToken, setMfaToken] = useState('')
  const [mfaError, setMfaError] = useState('')
  const [loading, setLoading] = useState(false)
  const [bgUrl, setBgUrl] = useState<string | null>(null)

  useEffect(() => {
    const t = Date.now()
    fetch(`/api/settings/login-bg?t=${t}`).then(r => {
      if (r.ok && r.status !== 204) setBgUrl(`/api/settings/login-bg?t=${t}`)
    }).catch(() => {})
  }, [])

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true); setLoginError('')
    try {
      const res = await api.post<{ ok?: boolean; mfaRequired?: boolean; user?: User }>('/auth/login', { email, password })
      if (res.mfaRequired) {
        window.location.search = '?mfa=required'
      } else if (res.user) {
        onLogin(res.user)
      }
    } catch (err: unknown) {
      setLoginError((err as { message?: string })?.message ?? 'Invalid email or password')
    } finally {
      setLoading(false)
    }
  }

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true); setMfaError('')
    try {
      const res = await api.post<{ user: User }>('/auth/mfa/validate', { token: mfaToken })
      onLogin(res.user)
    } catch {
      setMfaError('Invalid MFA code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: 6,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(0,0,0,0.35)',
    color: '#fff', fontSize: 14, outline: 'none',
    boxSizing: 'border-box', transition: 'border-color 0.15s',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 500,
    color: 'rgba(255,255,255,0.6)', marginBottom: 6,
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 16px',
      position: 'relative',
      overflow: 'hidden',
      background: bgUrl ? 'transparent' : '#0a0a0f',
    }}>
      {/* Background image */}
      {bgUrl && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 0,
          backgroundImage: `url(${bgUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          filter: 'brightness(0.55)',
        }} />
      )}

      {/* Dark gradient overlay */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1,
        background: bgUrl
          ? 'linear-gradient(135deg, rgba(0,0,0,0.65) 0%, rgba(0,0,20,0.5) 100%)'
          : 'radial-gradient(ellipse at 60% 40%, rgba(30,40,80,0.6) 0%, rgba(0,0,0,0) 70%)',
      }} />

      {/* Login card */}
      <div style={{ width: '100%', maxWidth: 400, position: 'relative', zIndex: 2 }}>

        {/* Branding */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 52, height: 52, borderRadius: 14,
            background: 'rgba(99,102,241,0.85)',
            backdropFilter: 'blur(8px)',
            marginBottom: 14, fontSize: 24,
            boxShadow: '0 4px 20px rgba(99,102,241,0.4)',
          }}>⌨</div>
          <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700, color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
            SSH Manager
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>
            Secure Access Control
          </p>
        </div>

        {/* Glass card */}
        <div style={{
          background: 'rgba(15,15,30,0.72)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 14,
          padding: '28px 28px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}>

          {authError && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 6,
              background: 'rgba(242,73,92,0.15)', border: '1px solid rgba(242,73,92,0.4)',
              color: '#f2495c', fontSize: 13,
            }}>
              Authentication failed. Please try again.
            </div>
          )}

          {mfaRequired ? (
            <form onSubmit={submitMfa} style={{ minHeight: 220 }}>
              <p style={{ textAlign: 'center', marginBottom: 20, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
                Enter your 6-digit authenticator code
              </p>
              <input
                type="text" inputMode="numeric" maxLength={6}
                value={mfaToken}
                onChange={e => setMfaToken(e.target.value.replace(/\D/g, ''))}
                placeholder="000000" autoFocus
                style={{
                  ...inputStyle,
                  textAlign: 'center', fontSize: 24, letterSpacing: '0.3em',
                  fontFamily: 'monospace', marginBottom: 12,
                }}
              />
              {mfaError && <p style={{ color: '#f2495c', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>{mfaError}</p>}
              <button type="submit" disabled={loading || mfaToken.length !== 6}
                style={{
                  width: '100%', padding: '10px 16px', borderRadius: 7,
                  background: 'rgba(99,102,241,0.85)', color: '#fff',
                  border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  opacity: loading || mfaToken.length !== 6 ? 0.5 : 1,
                }}>
                {loading ? 'Verifying…' : 'Verify Code'}
              </button>
            </form>
          ) : (
            <>
              {/* Tabs */}
              <div style={{
                display: 'flex',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8, padding: 3, marginBottom: 24, gap: 3,
              }}>
                {(['local', 'sso'] as Tab[]).map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    style={{
                      flex: 1, padding: '7px 0', borderRadius: 6,
                      fontSize: 13, fontWeight: 500, cursor: 'pointer',
                      transition: 'all 0.15s',
                      background: tab === t ? 'rgba(99,102,241,0.8)' : 'transparent',
                      color: tab === t ? '#fff' : 'rgba(255,255,255,0.5)',
                      border: 'none',
                    }}>
                    {t === 'local' ? 'Password' : 'SSO / OAuth'}
                  </button>
                ))}
              </div>

              <div style={{ minHeight: 220 }}>
                {tab === 'local' ? (
                  <form onSubmit={submitLogin}>
                    <div style={{ marginBottom: 16 }}>
                      <label style={labelStyle}>Email</label>
                      <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                        placeholder="you@example.com" required autoFocus style={inputStyle} />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={labelStyle}>Password</label>
                      <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••" required style={inputStyle} />
                    </div>
                    {loginError && <p style={{ color: '#f2495c', fontSize: 13, marginBottom: 12 }}>{loginError}</p>}
                    <button type="submit" disabled={loading}
                      style={{
                        width: '100%', padding: '10px 16px', borderRadius: 7, marginTop: 4,
                        background: loading ? 'rgba(34,197,94,0.5)' : 'rgba(34,197,94,0.85)',
                        color: '#fff', border: 'none', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                        transition: 'background 0.15s',
                      }}>
                      {loading ? 'Signing in…' : 'Sign In'}
                    </button>
                  </form>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <a href="/auth/microsoft"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                        padding: '10px 16px', borderRadius: 7,
                        background: 'rgba(0,120,212,0.15)',
                        border: '1px solid rgba(0,120,212,0.35)',
                        color: '#6ea8d6', fontSize: 13, fontWeight: 500, textDecoration: 'none',
                        transition: 'background 0.15s',
                      }}>
                      <svg width="18" height="18" viewBox="0 0 21 21" fill="none">
                        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                      </svg>
                      Sign in with Microsoft 365
                    </a>
                    <a href="/auth/google"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                        padding: '10px 16px', borderRadius: 7,
                        background: 'rgba(255,255,255,0.08)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        color: '#fff', fontSize: 13, fontWeight: 500, textDecoration: 'none',
                        transition: 'background 0.15s',
                      }}>
                      <svg width="18" height="18" viewBox="0 0 24 24">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                      </svg>
                      Sign in with Google
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, marginTop: 20, color: 'rgba(255,255,255,0.3)' }}>
          Encrypted · Audited · Zero-trust
        </p>
      </div>
    </div>
  )
}
