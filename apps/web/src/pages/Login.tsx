import { useState } from 'react'
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

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setLoginError('')
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
    setLoading(true)
    setMfaError('')
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
    width: '100%',
    padding: '9px 12px',
    borderRadius: 6,
    border: '1px solid var(--input-border)',
    background: 'var(--input-bg)',
    color: 'var(--input-text)',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    marginBottom: 6,
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 16px',
      background: 'var(--bg-canvas)',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 48, height: 48, borderRadius: 10,
            background: 'var(--accent-hex)',
            marginBottom: 14,
            fontSize: 22,
          }}>
            ⌨
          </div>
          <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 700, color: 'var(--text-heading)' }}>
            SSH Manager
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            Secure Access Control
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: 'var(--modal-bg)',
          border: '1px solid var(--modal-border)',
          borderRadius: 10,
          padding: '28px 28px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        }}>

          {authError && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 6,
              background: 'rgba(242,73,92,0.12)', border: '1px solid rgba(242,73,92,0.35)',
              color: '#f2495c', fontSize: 13,
            }}>
              Authentication failed. Please try again.
            </div>
          )}

          {mfaRequired ? (
            <form onSubmit={submitMfa} style={{ minHeight: 220 }}>
              <p style={{ textAlign: 'center', marginBottom: 20, fontSize: 13, color: 'var(--text-secondary)' }}>
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
                className="btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px 16px' }}>
                {loading ? 'Verifying…' : 'Verify Code'}
              </button>
            </form>
          ) : (
            <>
              {/* Tabs */}
              <div style={{
                display: 'flex',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-weak)',
                borderRadius: 7, padding: 3, marginBottom: 24, gap: 3,
              }}>
                {(['local', 'sso'] as Tab[]).map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    style={{
                      flex: 1, padding: '7px 0', borderRadius: 5,
                      fontSize: 13, fontWeight: 500, cursor: 'pointer',
                      transition: 'all 0.15s',
                      background: tab === t ? 'var(--accent-hex)' : 'transparent',
                      color: tab === t ? '#fff' : 'var(--text-secondary)',
                      border: 'none',
                    }}>
                    {t === 'local' ? 'Password' : 'SSO / OAuth'}
                  </button>
                ))}
              </div>

              {/* Fixed-height content area — prevents card jump on tab switch */}
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
                    className="btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', marginTop: 4 }}>
                    {loading ? 'Signing in…' : 'Sign In'}
                  </button>
                </form>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <a href="/auth/microsoft"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                      padding: '10px 16px', borderRadius: 6,
                      background: 'rgba(0,120,212,0.1)',
                      border: '1px solid rgba(0,120,212,0.3)',
                      color: '#6ea8d6',
                      fontSize: 13, fontWeight: 500, textDecoration: 'none',
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
                      padding: '10px 16px', borderRadius: 6,
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-med)',
                      color: 'var(--text-primary)',
                      fontSize: 13, fontWeight: 500, textDecoration: 'none',
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
              </div>{/* end fixed-height wrapper */}
            </>
          )}
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, marginTop: 20, color: 'var(--text-muted)' }}>
          Encrypted · Audited · Zero-trust
        </p>
      </div>
    </div>
  )
}
