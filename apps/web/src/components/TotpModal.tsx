import { useState, useRef, useEffect } from 'react'
import { api } from '../api/client'

interface Props {
  action: string
  onSuccess: () => void
  onCancel: () => void
}

const ACTION_LABELS: Record<string, string> = {
  server_reboot:          'Reboot server',
  server_shutdown:        'Shutdown server',
  server_root_activate:   'Activate root account',
  server_key_revoke:      'Revoke SSH key',
  server_key_rotation:    'Rotate SSH key',
  server_delete:          'Delete server',
  credential_reveal:      'Reveal credential',
  credential_delete:      'Delete credential',
  network_device_reboot:  'Reboot network device',
  network_device_reset:   'Factory reset network device',
  network_port_shutdown:  'Shut down port',
  network_vlan_change:    'Change port VLAN',
  network_config_push:    'Push config via SSH',
  user_deactivate:        'Deactivate user',
  user_delete:            'Delete user',
  user_role_change:       'Change user role',
}

export default function TotpModal({ action, onSuccess, onCancel }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const submit = async () => {
    if (code.length !== 6) { setError('Enter your 6-digit authenticator code'); return }
    setLoading(true); setError('')
    try {
      await api.post('/auth/totp/elevate', { token: code })
      onSuccess()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Invalid code')
      setCode('')
      inputRef.current?.focus()
    } finally { setLoading(false) }
  }

  const label = ACTION_LABELS[action] || action

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '28px 32px',
        width: 340,
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
      }}>
        <div style={{ fontSize: 22, marginBottom: 6 }}>🔐</div>
        <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)', marginBottom: 6 }}>
          Confirm with authenticator
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
          <strong style={{ color: 'var(--text)' }}>{label}</strong> requires TOTP verification.
          Enter your 6-digit code to continue.
        </div>

        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={e => { setCode(e.target.value.replace(/\D/g, '')); setError('') }}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="000000"
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 14px', fontSize: 22, letterSpacing: 8,
            textAlign: 'center', fontFamily: 'monospace',
            background: 'var(--bg-input, var(--bg-body))',
            border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
            borderRadius: 6, color: 'var(--text)', outline: 'none',
            marginBottom: 8,
          }}
        />

        {error && (
          <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              flex: 1, padding: '8px 0', borderRadius: 6, fontSize: 13,
              background: 'none', border: '1px solid var(--border)',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={loading || code.length !== 6}
            style={{
              flex: 2, padding: '8px 0', borderRadius: 6, fontSize: 13,
              background: code.length === 6 ? 'var(--accent-hex)' : 'var(--border)',
              border: 'none', color: '#fff', cursor: code.length === 6 ? 'pointer' : 'not-allowed',
              fontWeight: 500, opacity: loading ? 0.7 : 1,
              transition: 'background 0.15s',
            }}
          >
            {loading ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </div>
    </div>
  )
}
