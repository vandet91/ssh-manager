import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

export default function MfaSetup({ onDone }: { onDone: () => Promise<void> }) {
  const nav = useNavigate()
  const [step, setStep]       = useState<'setup' | 'verify' | 'done'>('setup')
  const [qr, setQr]           = useState('')
  const [secret, setSecret]   = useState('')
  const [token, setToken]     = useState('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [backups, setBackups] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.post<{ qrDataUrl: string; secret: string }>('/auth/mfa/setup')
      .then(r => { setQr(r.qrDataUrl); setSecret(r.secret) })
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    if (step === 'verify') setTimeout(() => inputRef.current?.focus(), 100)
  }, [step])

  const verify = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const r = await api.post<{ backupCodes?: string[] }>('/auth/mfa/verify', { token })
      setBackups(r.backupCodes ?? [])
      setStep('done')
    } catch (e: any) {
      setError(e.message)
    } finally { setLoading(false) }
  }

  const card: React.CSSProperties = {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-body)', padding: 24,
  }

  const box: React.CSSProperties = {
    width: '100%', maxWidth: 420,
    background: 'var(--card-bg)', border: '1px solid var(--border)',
    borderRadius: 14, padding: '32px 28px', boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
  }

  const inp: React.CSSProperties = {
    width: '100%', background: 'var(--bg-subtle)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '10px 12px', color: 'var(--text-primary)',
    fontSize: 22, letterSpacing: 6, textAlign: 'center', fontFamily: 'monospace', outline: 'none',
    boxSizing: 'border-box',
  }

  if (step === 'setup') return (
    <div style={card}>
      <div style={box}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔐</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Set up Two-Factor Authentication</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            Your account requires MFA. Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.).
          </p>
        </div>

        {error && <p style={{ color: '#f85149', fontSize: 13, textAlign: 'center', marginBottom: 16 }}>{error}</p>}

        {qr ? (
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <img src={qr} alt="MFA QR Code" style={{ width: 200, height: 200, borderRadius: 8, border: '3px solid var(--border)' }} />
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>Generating QR code…</div>
        )}

        {secret && (
          <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 20, textAlign: 'center' }}>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Manual entry key</p>
            <code style={{ fontSize: 13, color: 'var(--text-primary)', letterSpacing: 2, wordBreak: 'break-all' }}>{secret}</code>
          </div>
        )}

        <button onClick={() => setStep('verify')} disabled={!qr}
          style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: 'var(--accent-hex)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: qr ? 1 : 0.5 }}>
          I've scanned it — Continue →
        </button>
      </div>
    </div>
  )

  if (step === 'verify') return (
    <div style={card}>
      <div style={box}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔢</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Enter the 6-digit code</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>Open your authenticator app and enter the code shown.</p>
        </div>

        <form onSubmit={verify}>
          {error && <p style={{ color: '#f85149', fontSize: 13, textAlign: 'center', marginBottom: 12 }}>{error}</p>}
          <input ref={inputRef} style={inp} type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            value={token} onChange={e => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000" autoComplete="one-time-code" />
          <button type="submit" disabled={token.length !== 6 || loading}
            style={{ width: '100%', marginTop: 16, padding: '11px 0', borderRadius: 8, border: 'none', background: 'var(--accent-hex)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: token.length === 6 ? 'pointer' : 'not-allowed', opacity: token.length === 6 ? 1 : 0.5 }}>
            {loading ? 'Verifying…' : 'Verify & Enable MFA'}
          </button>
          <button type="button" onClick={() => setStep('setup')} style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border)', background: 'none', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
            ← Back
          </button>
        </form>
      </div>
    </div>
  )

  // done
  return (
    <div style={card}>
      <div style={box}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>MFA Enabled!</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>Your account is now protected with two-factor authentication.</p>
        </div>

        {backups.length > 0 && (
          <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <p style={{ fontSize: 12, color: '#d29922', fontWeight: 600, marginBottom: 8 }}>⚠ Save these backup codes — they won't be shown again</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {backups.map((c, i) => (
                <code key={i} style={{ fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-body)', borderRadius: 4, padding: '3px 6px' }}>{c}</code>
              ))}
            </div>
          </div>
        )}

        <button onClick={async () => { await onDone(); nav('/dashboard') }}
          style={{ width: '100%', padding: '11px 0', borderRadius: 8, border: 'none', background: 'var(--accent-hex)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Go to Dashboard →
        </button>
      </div>
    </div>
  )
}
