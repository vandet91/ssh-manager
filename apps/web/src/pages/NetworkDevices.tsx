import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Server, NetworkProfile, SshKey, SnmpProfile, PingResult, PingStatus, FirmwareCheckResult } from '../api/client'
import Modal from '../components/Modal'
import { useTotpElevation } from '../context/TotpElevationContext'

// ── Types ─────────────────────────────────────────────────────────────────────

type NetworkOsType =
  | 'router' | 'switch' | 'switch-l3' | 'access-point' | 'wireless-controller'
  | 'firewall' | 'utm' | 'ids-ips' | 'waf'
  | 'load-balancer' | 'proxy' | 'wan-optimizer'
  | 'vpn-gateway' | 'vpn-concentrator'
  | 'patch-panel' | 'media-converter' | 'sfp-module'
  | 'ip-pbx' | 'voip-gateway'
  | 'dvr' | 'nvr' | 'ip-camera'
  | 'ups' | 'pdu' | 'kvm-switch' | 'console-server'
  | 'other-network'

const DEVICE_META: Record<NetworkOsType, { icon: string; label: string; color: string; bg: string; border: string; group: string }> = {
  'router':               { icon: '📡', label: 'Router',               color: '#34d399', bg: 'rgba(6,78,59,0.2)',    border: 'rgba(52,211,153,0.35)',  group: 'Network' },
  'switch':               { icon: '🔀', label: 'Switch (L2)',           color: '#a78bfa', bg: 'rgba(91,33,182,0.2)',  border: 'rgba(167,139,250,0.35)', group: 'Network' },
  'switch-l3':            { icon: '🔁', label: 'Switch (L3)',           color: '#818cf8', bg: 'rgba(67,56,202,0.2)',  border: 'rgba(129,140,248,0.35)', group: 'Network' },
  'access-point':         { icon: '📶', label: 'Access Point',          color: '#60a5fa', bg: 'rgba(29,78,216,0.2)',  border: 'rgba(96,165,250,0.35)',  group: 'Network' },
  'wireless-controller':  { icon: '📡', label: 'Wireless Controller',   color: '#38bdf8', bg: 'rgba(12,74,110,0.2)',  border: 'rgba(56,189,248,0.35)',  group: 'Network' },
  'firewall':             { icon: '🛡', label: 'Firewall',              color: '#f87171', bg: 'rgba(127,29,29,0.2)',  border: 'rgba(248,113,113,0.35)', group: 'Security' },
  'utm':                  { icon: '🔒', label: 'UTM / NGFW',            color: '#fb7185', bg: 'rgba(136,19,55,0.2)',  border: 'rgba(251,113,133,0.35)', group: 'Security' },
  'ids-ips':              { icon: '🔍', label: 'IDS / IPS',             color: '#fca5a5', bg: 'rgba(127,29,29,0.15)', border: 'rgba(252,165,165,0.35)', group: 'Security' },
  'waf':                  { icon: '🧱', label: 'WAF',                   color: '#f97316', bg: 'rgba(124,45,18,0.2)',  border: 'rgba(249,115,22,0.35)',  group: 'Security' },
  'load-balancer':        { icon: '⚖', label: 'Load Balancer',         color: '#fbbf24', bg: 'rgba(120,53,15,0.2)',  border: 'rgba(251,191,36,0.35)',  group: 'Traffic' },
  'proxy':                { icon: '🔄', label: 'Proxy / Reverse Proxy', color: '#facc15', bg: 'rgba(113,63,18,0.2)',  border: 'rgba(250,204,21,0.35)',  group: 'Traffic' },
  'wan-optimizer':        { icon: '⚡', label: 'WAN Optimizer',         color: '#a3e635', bg: 'rgba(54,83,20,0.2)',   border: 'rgba(163,230,53,0.35)',  group: 'Traffic' },
  'vpn-gateway':          { icon: '🔐', label: 'VPN Gateway',           color: '#c084fc', bg: 'rgba(88,28,135,0.2)',  border: 'rgba(192,132,252,0.35)', group: 'VPN' },
  'vpn-concentrator':     { icon: '🔑', label: 'VPN Concentrator',      color: '#a855f7', bg: 'rgba(76,29,149,0.2)',  border: 'rgba(168,85,247,0.35)',  group: 'VPN' },
  'patch-panel':          { icon: '🔌', label: 'Patch Panel',           color: '#94a3b8', bg: 'rgba(30,41,59,0.3)',   border: 'rgba(148,163,184,0.35)', group: 'Physical' },
  'media-converter':      { icon: '🔃', label: 'Media Converter',       color: '#cbd5e1', bg: 'rgba(30,41,59,0.3)',   border: 'rgba(203,213,225,0.35)', group: 'Physical' },
  'sfp-module':           { icon: '💡', label: 'SFP / Transceiver',     color: '#e2e8f0', bg: 'rgba(30,41,59,0.2)',   border: 'rgba(226,232,240,0.3)',  group: 'Physical' },
  'ip-pbx':               { icon: '☎', label: 'IP PBX',                color: '#34d399', bg: 'rgba(6,78,59,0.2)',    border: 'rgba(52,211,153,0.35)',  group: 'VoIP' },
  'voip-gateway':         { icon: '📞', label: 'VoIP Gateway',          color: '#6ee7b7', bg: 'rgba(6,78,59,0.15)',   border: 'rgba(110,231,183,0.35)', group: 'VoIP' },
  'dvr':                  { icon: '📹', label: 'DVR',                   color: '#fb923c', bg: 'rgba(154,52,18,0.2)',  border: 'rgba(249,115,22,0.35)',  group: 'Surveillance' },
  'nvr':                  { icon: '🎥', label: 'NVR',                   color: '#f472b6', bg: 'rgba(131,24,67,0.2)',  border: 'rgba(244,114,182,0.35)', group: 'Surveillance' },
  'ip-camera':            { icon: '📷', label: 'IP Camera',             color: '#e879f9', bg: 'rgba(112,26,117,0.2)', border: 'rgba(232,121,249,0.35)', group: 'Surveillance' },
  'ups':                  { icon: '🔋', label: 'UPS',                   color: '#fde047', bg: 'rgba(113,63,18,0.2)',  border: 'rgba(253,224,71,0.35)',  group: 'Power & Mgmt' },
  'pdu':                  { icon: '🔌', label: 'PDU',                   color: '#fcd34d', bg: 'rgba(120,53,15,0.2)',  border: 'rgba(252,211,77,0.35)',  group: 'Power & Mgmt' },
  'kvm-switch':           { icon: '🖥', label: 'KVM Switch',            color: '#7dd3fc', bg: 'rgba(12,74,110,0.2)',  border: 'rgba(125,211,252,0.35)', group: 'Power & Mgmt' },
  'console-server':       { icon: '🖨', label: 'Console Server',        color: '#93c5fd', bg: 'rgba(29,78,216,0.15)', border: 'rgba(147,197,253,0.35)', group: 'Power & Mgmt' },
  'other-network':        { icon: '🌐', label: 'Other Network Dev',     color: '#9ca3af', bg: 'rgba(55,65,81,0.3)',   border: 'rgba(107,114,128,0.4)',  group: 'Other' },
}

const osTypeGroups: { group: string; options: NetworkOsType[] }[] = [
  { group: 'Network',       options: ['router', 'switch', 'switch-l3', 'access-point', 'wireless-controller'] },
  { group: 'Security',      options: ['firewall', 'utm', 'ids-ips', 'waf'] },
  { group: 'Traffic',       options: ['load-balancer', 'proxy', 'wan-optimizer'] },
  { group: 'VPN',           options: ['vpn-gateway', 'vpn-concentrator'] },
  { group: 'Physical',      options: ['patch-panel', 'media-converter', 'sfp-module'] },
  { group: 'VoIP',          options: ['ip-pbx', 'voip-gateway'] },
  { group: 'Surveillance',  options: ['dvr', 'nvr', 'ip-camera'] },
  { group: 'Power & Mgmt',  options: ['ups', 'pdu', 'kvm-switch', 'console-server'] },
  { group: 'Other',         options: ['other-network'] },
]

// ── Shared helpers ─────────────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 13,
  background: 'var(--bg-input)', border: '1px solid var(--border-med)',
  color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
}
const lbl: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
      <div onClick={() => onChange(!value)} style={{ width: 36, height: 20, borderRadius: 10, background: value ? 'var(--accent-hex)' : 'var(--border-med)', position: 'relative', cursor: 'pointer', flexShrink: 0, transition: 'background .2s' }}>
        <div style={{ position: 'absolute', top: 3, left: value ? 19 : 3, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .2s' }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
    </label>
  )
}

function DeviceBadge({ type }: { type: string | null | undefined }) {
  if (!type) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
  const m = DEVICE_META[type as NetworkOsType] ?? DEVICE_META['other-network']
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', background: m.bg, border: `1px solid ${m.border}`, color: m.color, borderRadius: 5, padding: '1px 7px' }}>
      {m.icon} {m.label}
    </span>
  )
}

function DeviceTypeSelect({ value, onChange, style }: { value: string; onChange: (v: NetworkOsType) => void; style?: React.CSSProperties }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as NetworkOsType)} style={style}>
      {osTypeGroups.map(g => (
        <optgroup key={g.group} label={`── ${g.group}`}>
          {g.options.map(v => <option key={v} value={v}>{DEVICE_META[v].icon} {DEVICE_META[v].label}</option>)}
        </optgroup>
      ))}
    </select>
  )
}


function PingDot({ status }: { status: string | null }) {
  if (!status) return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
  const online = status === 'online'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: online ? '#3fb950' : '#f87171' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#3fb950' : '#f87171', display: 'inline-block' }} />
      {status}
    </span>
  )
}

function FirmwareBadge({ result }: { result: FirmwareCheckResult | null }) {
  if (!result) return <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>—</span>
  const map = {
    current:  { color: '#3fb950', bg: 'rgba(46,160,67,0.15)', border: 'rgba(46,160,67,0.35)', icon: '✓' },
    outdated: { color: '#f87171', bg: 'rgba(248,113,113,0.15)', border: 'rgba(248,113,113,0.35)', icon: '⚠' },
    unknown:  { color: '#e3b341', bg: 'rgba(210,153,34,0.15)', border: 'rgba(210,153,34,0.35)', icon: '?' },
  }
  const s = map[result.status] ?? map.unknown
  return (
    <span style={{ fontSize: 10, fontWeight: 600, borderRadius: 4, padding: '1px 6px', background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
      {s.icon} {result.status}
    </span>
  )
}

// ── SNMP Result Modal ─────────────────────────────────────────────────────────

function SnmpResultModal({ deviceName, profile, onClose }: {
  deviceName: string
  profile: NetworkProfile
  onClose: () => void
}) {
  const data = profile.snmp_last_data as Record<string, string> | null
  const rows1: { label: string; key: string; icon: string }[] = [
    { label: 'System Name',  key: 'sysName',    icon: '🏷' },
    { label: 'Description',  key: 'sysDescr',   icon: '📄' },
    { label: 'Location',     key: 'sysLocation', icon: '📍' },
    { label: 'Contact',      key: 'sysContact',  icon: '👤' },
    { label: 'Uptime',       key: 'sysUpTime',   icon: '⏱' },
    { label: 'Interfaces',   key: 'ifNumber',    icon: '🔌' },
  ]
  return (
    <Modal title={`SNMP Data — ${deviceName}`} onClose={onClose}>
      <div style={{ minWidth: 480 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
          Fetched {profile.snmp_last_fetched_at ? new Date(profile.snmp_last_fetched_at).toLocaleString() : '—'}
        </div>

        {/* Enriched block */}
        {(profile.snmp_model || profile.snmp_firmware || profile.snmp_vendor || profile.snmp_mac_address) && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
            {[
              ['Vendor',   profile.snmp_vendor],
              ['Model',    profile.snmp_model],
              ['Firmware', profile.snmp_firmware],
              ['Serial',   profile.snmp_serial],
              ['Hostname', profile.snmp_hostname],
              ['MAC',      profile.snmp_mac_address],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k as string} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 56 }}>{k}:</span>
                <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{v as string}</span>
              </div>
            ))}
          </div>
        )}

        {data && rows1.map(r => (
          <div key={r.key} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-weak)' }}>
            <span style={{ fontSize: 14, width: 22 }}>{r.icon}</span>
            <span style={{ width: 110, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{r.label}</span>
            <span style={{ fontSize: 12, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
              {data[r.key] ?? <em style={{ color: 'var(--text-muted)' }}>n/a</em>}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ── Firmware Check Modal ──────────────────────────────────────────────────────

function FirmwareModal({ deviceName, result, checkedAt, onClose }: {
  deviceName: string
  result: FirmwareCheckResult
  checkedAt: string
  onClose: () => void
}) {
  const sevColor = (s: string) => ({ critical: '#f87171', high: '#fb923c', medium: '#fbbf24', low: '#a3e635', info: '#60a5fa' }[s] ?? '#9ca3af')
  return (
    <Modal title={`Firmware Check — ${deviceName}`} onClose={onClose}>
      <div style={{ minWidth: 500 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>Checked {new Date(checkedAt).toLocaleString()}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', marginBottom: 16 }}>
          {[
            ['Status',          <FirmwareBadge key="s" result={result} />],
            ['Current version', result.current_version ?? '—'],
            ['Latest version',  result.latest_version ?? '—'],
            ['Release date',    result.release_date ?? '—'],
            ['EOL',             result.eol == null ? '—' : result.eol ? '⚠ End-of-Life' : '✓ Supported'],
          ].map(([k, v]) => (
            <div key={k as string}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{k as string}</div>
              <div style={{ fontSize: 13 }}>{v as React.ReactNode}</div>
            </div>
          ))}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Recommendation</div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 6, padding: '8px 12px' }}>{result.recommendation}</div>
        </div>

        {result.cves?.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>CVEs ({result.cves.length})</div>
            {result.cves.map(c => (
              <div key={c.id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border-weak)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: sevColor(c.severity), minWidth: 90 }}>{c.id}</span>
                <span style={{ fontSize: 11, color: sevColor(c.severity), minWidth: 56 }}>{c.severity}</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{c.summary}</span>
              </div>
            ))}
          </div>
        )}

        {result.notes && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>{result.notes}</div>
        )}
      </div>
    </Modal>
  )
}

// ── Access Profile Modal ──────────────────────────────────────────────────────

function AccessProfileModal({ device, snmpProfiles, onClose, onSaved }: {
  device: Server
  snmpProfiles: SnmpProfile[]
  onClose: () => void
  onSaved: () => void
}) {
  const [tab, setTab] = useState<'ssh' | 'web' | 'snmp' | 'monitor'>('ssh')
  const [profile, setProfile] = useState<NetworkProfile | null>(null)
  const [keys, setKeys] = useState<SshKey[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [sshEnabled, setSshEnabled] = useState(false)
  const [sshAuthType, setSshAuthType] = useState<'key' | 'password'>('key')
  const [sshUser, setSshUser] = useState('')
  const [sshKeyId, setSshKeyId] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [webEnabled, setWebEnabled] = useState(false)
  const [webUrl, setWebUrl] = useState('')
  const [snmpEnabled, setSnmpEnabled] = useState(false)
  const [snmpProfileId, setSnmpProfileId] = useState<string>('')
  const [snmpVersion, setSnmpVersion] = useState('v2c')
  const [snmpCommunity, setSnmpCommunity] = useState('')
  const [snmpPort, setSnmpPort] = useState(161)
  const [snmpV3User, setSnmpV3User] = useState('')
  const [snmpV3AuthProto, setSnmpV3AuthProto] = useState('SHA')
  const [snmpV3AuthKey, setSnmpV3AuthKey] = useState('')
  const [snmpV3PrivProto, setSnmpV3PrivProto] = useState('AES')
  const [snmpV3PrivKey, setSnmpV3PrivKey] = useState('')
  const [pingEnabled, setPingEnabled] = useState(true)
  const [inStock, setInStock] = useState(false)

  useEffect(() => {
    Promise.all([
      api.get<NetworkProfile>(`/servers/${device.id}/network-profile`),
      api.get<SshKey[]>('/keys').catch(() => [] as SshKey[]),
    ]).then(([p, k]) => {
      setProfile(p); setKeys(Array.isArray(k) ? k : [])
      setSshEnabled(p.access_ssh_enabled)
      setSshAuthType(p.access_ssh_auth_type ?? 'key')
      setSshUser(p.management_linux_user ?? p.ssh_credential_username ?? '')
      setSshKeyId(p.management_key_id ?? '')
      setWebEnabled(p.web_enabled)
      setWebUrl(p.web_url ?? '')
      setSnmpEnabled(p.snmp_enabled)
      setSnmpProfileId(p.snmp_profile_id ?? '')
      setSnmpVersion(p.snmp_version ?? 'v2c')
      setSnmpCommunity(p.snmp_community ?? '')
      setSnmpPort(p.snmp_port ?? 161)
      setSnmpV3User(p.snmp_v3_user ?? '')
      setSnmpV3AuthProto(p.snmp_v3_auth_proto ?? 'SHA')
      setSnmpV3AuthKey(p.snmp_v3_auth_key ?? '')
      setSnmpV3PrivProto(p.snmp_v3_priv_proto ?? 'AES')
      setSnmpV3PrivKey(p.snmp_v3_priv_key ?? '')
      setPingEnabled(p.ping_enabled)
      setInStock(p.in_stock)
    }).catch(() => setError('Failed to load profile'))
  }, [device.id])

  const save = async () => {
    setSaving(true); setError('')
    try {
      const body: Record<string, unknown> = {
        access_ssh_enabled: sshEnabled,
        access_ssh_auth_type: sshEnabled ? sshAuthType : null,
        web_enabled: webEnabled,
        web_url: webEnabled ? webUrl : null,
        snmp_enabled: snmpEnabled,
        snmp_profile_id: snmpProfileId || null,
        snmp_version: snmpVersion,
        snmp_community: snmpCommunity,
        snmp_port: snmpPort,
        snmp_v3_user: snmpVersion === 'v3' ? snmpV3User : null,
        snmp_v3_auth_proto: snmpVersion === 'v3' ? snmpV3AuthProto : null,
        snmp_v3_auth_key: snmpVersion === 'v3' ? snmpV3AuthKey : undefined,
        snmp_v3_priv_proto: snmpVersion === 'v3' ? snmpV3PrivProto : null,
        snmp_v3_priv_key: snmpVersion === 'v3' ? snmpV3PrivKey : undefined,
        ping_enabled: pingEnabled,
        in_stock: inStock,
      }
      if (sshEnabled && sshAuthType === 'key') {
        body.management_key_id = sshKeyId || null
        body.management_linux_user = sshUser
      } else if (sshEnabled && sshAuthType === 'password' && sshPassword) {
        body.ssh_password = sshPassword
        body.ssh_username = sshUser
      } else if (sshEnabled && sshAuthType === 'password') {
        body.management_linux_user = sshUser
      }
      await api.put(`/servers/${device.id}/network-profile`, body)
      onSaved(); onClose()
    } catch (e: any) {
      setError(e?.data?.error ?? e?.message ?? 'Save failed')
    } finally { setSaving(false) }
  }

  const tabs = [
    { id: 'ssh', label: '⌨ SSH' }, { id: 'web', label: '🌐 Web' },
    { id: 'snmp', label: '📊 SNMP' }, { id: 'monitor', label: '📡 Monitor' },
  ] as const

  return (
    <Modal title={`Access Profile — ${device.name}`} onClose={onClose}>
      <div style={{ minWidth: 490, maxWidth: 540 }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-med)', marginBottom: 16 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '7px 16px', background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid var(--accent-hex)' : '2px solid transparent', color: tab === t.id ? 'var(--accent-hex)' : 'var(--text-muted)', fontWeight: tab === t.id ? 600 : 400, fontSize: 13, cursor: 'pointer' }}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'ssh' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle value={sshEnabled} onChange={setSshEnabled} label="Enable SSH Access" />
            {sshEnabled && (
              <>
                <div>
                  <label style={lbl}>Authentication Type</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['key', 'password'] as const).map(t => (
                      <button key={t} onClick={() => setSshAuthType(t)} style={{ flex: 1, padding: '7px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: `1px solid ${sshAuthType === t ? 'var(--accent-hex)' : 'var(--border-med)'}`, background: sshAuthType === t ? 'var(--accent-hex)20' : 'transparent', color: sshAuthType === t ? 'var(--accent-hex)' : 'var(--text-muted)', fontWeight: sshAuthType === t ? 600 : 400 }}>
                        {t === 'key' ? '🔑 SSH Key' : '🔒 Password'}
                      </button>
                    ))}
                  </div>
                </div>
                <div><label style={lbl}>Username</label><input value={sshUser} onChange={e => setSshUser(e.target.value)} placeholder="admin" style={inp} /></div>
                {sshAuthType === 'key' ? (
                  <div><label style={lbl}>SSH Key</label>
                    <select value={sshKeyId} onChange={e => setSshKeyId(e.target.value)} style={inp}>
                      <option value="">— Select a key —</option>
                      {keys.map(k => <option key={k.id} value={k.id}>{k.name} ({k.key_type})</option>)}
                    </select>
                  </div>
                ) : (
                  <div><label style={lbl}>Password {profile?.ssh_credential_id ? '(leave blank to keep existing)' : ''}</label>
                    <input type="password" value={sshPassword} onChange={e => setSshPassword(e.target.value)} placeholder="•••••••••" style={inp} autoComplete="new-password" />
                    {profile?.ssh_credential_id && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>✓ Stored for user <code>{profile.ssh_credential_username}</code></div>}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'web' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle value={webEnabled} onChange={setWebEnabled} label="Enable Web UI Access" />
            {webEnabled ? (
              <div>
                <label style={lbl}>Web UI URL</label>
                <input value={webUrl} onChange={e => setWebUrl(e.target.value)} placeholder="https://192.168.1.1:8443" style={inp} />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Opens in a new tab</div>
              </div>
            ) : (
              <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Enable to set a web management URL.</div>
            )}
          </div>
        )}

        {tab === 'snmp' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Toggle value={snmpEnabled} onChange={setSnmpEnabled} label="Enable SNMP" />
            {snmpEnabled && (
              <>
                {snmpProfiles.length > 0 && (
                  <div>
                    <label style={lbl}>Shared SNMP Profile (optional)</label>
                    <select value={snmpProfileId} onChange={e => setSnmpProfileId(e.target.value)} style={inp}>
                      <option value="">— Device-specific settings below —</option>
                      {snmpProfiles.map(p => <option key={p.id} value={p.id}>{p.name} ({p.version})</option>)}
                    </select>
                    {snmpProfileId && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Profile community will be used as fallback if no device community is set.</div>}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>SNMP Version</label>
                    <select value={snmpVersion} onChange={e => setSnmpVersion(e.target.value)} style={inp}>
                      <option value="v1">v1</option><option value="v2c">v2c</option><option value="v3">v3</option>
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={lbl}>Port</label>
                    <input type="number" value={snmpPort} onChange={e => setSnmpPort(Number(e.target.value))} style={inp} min={1} max={65535} />
                  </div>
                </div>
                {snmpVersion !== 'v3' && (
                  <div><label style={lbl}>Community String {snmpProfileId ? '(overrides profile if set)' : ''}</label>
                    <input value={snmpCommunity} onChange={e => setSnmpCommunity(e.target.value)} placeholder={snmpProfileId ? 'leave blank to use profile' : 'public'} style={inp} />
                  </div>
                )}
                {snmpVersion === 'v3' && (
                  <>
                    <div><label style={lbl}>Username</label><input value={snmpV3User} onChange={e => setSnmpV3User(e.target.value)} placeholder="snmpv3user" style={inp} /></div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <div style={{ flex: 1 }}><label style={lbl}>Auth Protocol</label><select value={snmpV3AuthProto} onChange={e => setSnmpV3AuthProto(e.target.value)} style={inp}><option value="SHA">SHA</option><option value="MD5">MD5</option></select></div>
                      <div style={{ flex: 1 }}><label style={lbl}>Auth Key</label><input type="password" value={snmpV3AuthKey} onChange={e => setSnmpV3AuthKey(e.target.value)} style={inp} autoComplete="new-password" /></div>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <div style={{ flex: 1 }}><label style={lbl}>Privacy Protocol</label><select value={snmpV3PrivProto} onChange={e => setSnmpV3PrivProto(e.target.value)} style={inp}><option value="AES">AES</option><option value="DES">DES</option></select></div>
                      <div style={{ flex: 1 }}><label style={lbl}>Privacy Key</label><input type="password" value={snmpV3PrivKey} onChange={e => setSnmpV3PrivKey(e.target.value)} style={inp} autoComplete="new-password" /></div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'monitor' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 8, padding: '12px 14px' }}>
              <Toggle value={pingEnabled} onChange={setPingEnabled} label="Enable Ping Monitoring" />
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -6 }}>
                When disabled, this device will be skipped during bulk ping operations.
              </div>
            </div>
            <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 8, padding: '12px 14px' }}>
              <Toggle value={inStock} onChange={setInStock} label="Device is In Stock (not deployed)" />
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -6 }}>
                Devices in stock are skipped for ping, SNMP, and firmware checks.
              </div>
            </div>
            {profile?.ping_last_at && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>
                Last ping: <strong style={{ color: profile.ping_last_status === 'online' ? '#3fb950' : '#f87171' }}>{profile.ping_last_status}</strong>
                {profile.ping_last_latency_ms != null && ` — ${profile.ping_last_latency_ms}ms`}
                {' · '}{new Date(profile.ping_last_at).toLocaleString()}
              </div>
            )}
          </div>
        )}

        {error && <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 12, marginBottom: 0 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{saving ? 'Saving…' : 'Save Profile'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ── SNMP Profiles Tab ─────────────────────────────────────────────────────────

function SnmpProfilesTab() {
  const [profiles, setProfiles] = useState<SnmpProfile[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<SnmpProfile | null>(null)
  const [form, setForm] = useState({ name: '', description: '', version: 'v2c', community: '', port: 161, v3_user: '', v3_auth_proto: 'SHA', v3_auth_key: '', v3_priv_proto: 'AES', v3_priv_key: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => { api.get<SnmpProfile[]>('/snmp-profiles').then(setProfiles).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  const openNew = () => {
    setEditing(null)
    setForm({ name: '', description: '', version: 'v2c', community: '', port: 161, v3_user: '', v3_auth_proto: 'SHA', v3_auth_key: '', v3_priv_proto: 'AES', v3_priv_key: '' })
    setError('')
    setShowForm(true)
  }

  const openEdit = (p: SnmpProfile) => {
    setEditing(p)
    setForm({ name: p.name, description: p.description ?? '', version: p.version, community: p.community, port: p.port, v3_user: p.v3_user ?? '', v3_auth_proto: p.v3_auth_proto ?? 'SHA', v3_auth_key: p.v3_auth_key ?? '', v3_priv_proto: p.v3_priv_proto ?? 'AES', v3_priv_key: p.v3_priv_key ?? '' })
    setError('')
    setShowForm(true)
  }

  const save = async () => {
    setSaving(true); setError('')
    try {
      const body = { ...form, port: Number(form.port) }
      if (editing) await api.put(`/snmp-profiles/${editing.id}`, body)
      else await api.post('/snmp-profiles', body)
      setShowForm(false); load()
    } catch (e: any) { setError(e?.data?.error ?? e?.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  const del = async (p: SnmpProfile) => {
    if (!confirm(`Delete profile "${p.name}"? Linked devices will lose the profile reference.`)) return
    await api.delete(`/snmp-profiles/${p.id}`).catch(() => {})
    load()
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>SNMP Profiles</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Shared community strings — change once, applies to all linked devices.</p>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={openNew} style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>+ New Profile</button>
      </div>

      {profiles.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>No SNMP profiles yet. Create one to share a community string across multiple devices.</div>
      ) : (
        <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                {['Name', 'Version', 'Port', 'Community', 'Description', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {profiles.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: i < profiles.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>{p.name}</td>
                  <td style={{ padding: '10px 14px' }}><span style={{ fontSize: 11, fontWeight: 600, background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8', borderRadius: 4, padding: '1px 6px' }}>{p.version}</span></td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12 }}>{p.port}</td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12 }}>
                    {p.version !== 'v3' ? (p.community ? '••••••••' : <em style={{ color: 'var(--text-muted)' }}>not set</em>) : <em style={{ color: 'var(--text-muted)' }}>v3 auth</em>}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>{p.description ?? '—'}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button onClick={() => openEdit(p)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border-med)', color: 'var(--text-muted)' }}>✎ Edit</button>
                      <button onClick={() => del(p)} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border-med)', color: 'var(--danger)' }}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <Modal title={editing ? `Edit Profile — ${editing.name}` : 'New SNMP Profile'} onClose={() => setShowForm(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 420 }}>
            <div><label style={lbl}>Profile Name *</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Office SNMPv2" style={inp} /></div>
            <div><label style={lbl}>Description</label><input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Shared community for office switches" style={inp} /></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>SNMP Version</label>
                <select value={form.version} onChange={e => setForm(f => ({ ...f, version: e.target.value }))} style={inp}>
                  <option value="v1">v1</option><option value="v2c">v2c</option><option value="v3">v3</option>
                </select>
              </div>
              <div style={{ flex: 1 }}><label style={lbl}>Port</label><input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: Number(e.target.value) }))} style={inp} /></div>
            </div>
            {form.version !== 'v3' ? (
              <div><label style={lbl}>Community String</label><input value={form.community} onChange={e => setForm(f => ({ ...f, community: e.target.value }))} placeholder="public" style={inp} /></div>
            ) : (
              <>
                <div><label style={lbl}>Username</label><input value={form.v3_user} onChange={e => setForm(f => ({ ...f, v3_user: e.target.value }))} style={inp} /></div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}><label style={lbl}>Auth Protocol</label><select value={form.v3_auth_proto} onChange={e => setForm(f => ({ ...f, v3_auth_proto: e.target.value }))} style={inp}><option value="SHA">SHA</option><option value="MD5">MD5</option></select></div>
                  <div style={{ flex: 1 }}><label style={lbl}>Auth Key</label><input type="password" value={form.v3_auth_key} onChange={e => setForm(f => ({ ...f, v3_auth_key: e.target.value }))} style={inp} autoComplete="new-password" /></div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}><label style={lbl}>Priv Protocol</label><select value={form.v3_priv_proto} onChange={e => setForm(f => ({ ...f, v3_priv_proto: e.target.value }))} style={inp}><option value="AES">AES</option><option value="DES">DES</option></select></div>
                  <div style={{ flex: 1 }}><label style={lbl}>Priv Key</label><input type="password" value={form.v3_priv_key} onChange={e => setForm(f => ({ ...f, v3_priv_key: e.target.value }))} style={inp} autoComplete="new-password" /></div>
                </div>
              </>
            )}
            {error && <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Profile'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Ping Monitor Tab ──────────────────────────────────────────────────────────

function PingMonitorTab({ devices }: { devices: Server[] }) {
  const [filterType, setFilterType] = useState('')
  const [filterEnv, setFilterEnv] = useState('')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<PingResult[] | null>(null)
  const [summary, setSummary] = useState<{ total: number; online: number; offline: number; skipped: number } | null>(null)
  const [pingStatuses, setPingStatuses] = useState<PingStatus[]>([])

  useEffect(() => {
    api.get<PingStatus[]>('/network-devices/ping-status').then(setPingStatuses).catch(() => {})
  }, [])

  const run = async () => {
    setRunning(true); setResults(null)
    try {
      const body: Record<string, unknown> = {}
      if (filterType) body.os_type = filterType
      if (filterEnv) body.environment = filterEnv
      const r = await api.post<{ results: PingResult[]; summary: typeof summary }>('/network-devices/ping', body)
      setResults(r.results)
      setSummary(r.summary)
      api.get<PingStatus[]>('/network-devices/ping-status').then(setPingStatuses).catch(() => {})
    } catch (e: any) {
      alert(`Ping failed: ${e?.data?.error ?? e?.message}`)
    } finally { setRunning(false) }
  }

  const environments = [...new Set(devices.map(d => d.environment))].sort()

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Ping Monitor</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Bulk ICMP ping — skips devices marked "ping disabled" or "in stock".</p>
        </div>
        <div style={{ flex: 1 }} />
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...inp, width: 170 }}>
          <option value="">All device types</option>
          {osTypeGroups.map(g => (
            <optgroup key={g.group} label={g.group}>
              {g.options.map(v => <option key={v} value={v}>{DEVICE_META[v].icon} {DEVICE_META[v].label}</option>)}
            </optgroup>
          ))}
        </select>
        <select value={filterEnv} onChange={e => setFilterEnv(e.target.value)} style={{ ...inp, width: 140 }}>
          <option value="">All environments</option>
          {environments.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <button onClick={run} disabled={running} style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: running ? 'var(--border-med)' : 'var(--accent-hex)', color: '#fff', cursor: running ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {running ? '⟳ Pinging…' : '▶ Run Ping'}
        </button>
      </div>

      {/* Summary bar */}
      {summary && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          {[
            { label: 'Total', value: summary.total, color: '#9ca3af' },
            { label: 'Online', value: summary.online, color: '#3fb950' },
            { label: 'Offline', value: summary.offline, color: '#f87171' },
            { label: 'Skipped', value: summary.skipped, color: '#e3b341' },
          ].map(s => (
            <div key={s.label} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid var(--border-med)', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Results table */}
      {results ? (
        <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                {['Status', 'Device', 'Hostname', 'Latency', 'Note'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: i < results.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                  <td style={{ padding: '9px 14px' }}><PingDot status={r.status === 'skipped' ? null : r.status} /></td>
                  <td style={{ padding: '9px 14px', fontWeight: 600 }}>{r.name}</td>
                  <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)' }}>{r.hostname}</td>
                  <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12 }}>{r.latency_ms != null ? `${r.latency_ms} ms` : '—'}</td>
                  <td style={{ padding: '9px 14px', fontSize: 12, color: 'var(--text-muted)' }}>{r.skipped_reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // Show stored ping statuses
        pingStatuses.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Last saved ping results:</div>
            <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                    {['Status', 'Device', 'Hostname', 'Latency', 'Last Checked'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pingStatuses.map((p, i) => (
                    <tr key={p.id} style={{ borderBottom: i < pingStatuses.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                      <td style={{ padding: '9px 14px' }}><PingDot status={p.in_stock ? null : !p.ping_enabled ? null : p.ping_last_status} /></td>
                      <td style={{ padding: '9px 14px', fontWeight: 600 }}>{p.name}</td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)' }}>{p.hostname}</td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12 }}>{p.ping_last_latency_ms != null ? `${p.ping_last_latency_ms} ms` : '—'}</td>
                      <td style={{ padding: '9px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                        {p.in_stock ? <span style={{ color: '#e3b341' }}>In stock</span>
                          : !p.ping_enabled ? <span style={{ color: 'var(--text-muted)' }}>Ping disabled</span>
                          : p.ping_last_at ? new Date(p.ping_last_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </div>
  )
}

// ── Export helpers ────────────────────────────────────────────────────────────

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function toCSVRow(cols: (string | number | boolean | null | undefined)[]) {
  return cols.map(v => {
    const s = v == null ? '' : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')
}

// ── Firmware Tab ──────────────────────────────────────────────────────────────

function FirmwareTab({ devices, onDevicesChanged }: { devices: Server[]; onDevicesChanged: () => void }) {
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [checkAllRunning, setCheckAllRunning] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | 'eol' | 'near-eol' | 'outdated' | 'current' | 'unknown' | 'has-cves'>('all')
  const [firmwareModal, setFirmwareModal] = useState<{ device: Server; result: FirmwareCheckResult; checkedAt: string } | null>(null)
  const [exportMenu, setExportMenu] = useState(false)

  const networkDevices = devices.filter(d => d.device_category === 'network')
  const snmpReady = networkDevices.filter(d => d.snmp_enabled && d.snmp_last_fetched_at)

  const check = async (d: Server) => {
    setChecking(s => ({ ...s, [d.id]: true }))
    try {
      const r = await api.post<{ ok: boolean; checked_at: string; result: FirmwareCheckResult }>(`/servers/${d.id}/firmware-check`)
      onDevicesChanged()
      setFirmwareModal({ device: d, result: r.result, checkedAt: r.checked_at })
    } catch (e: any) {
      alert(`Firmware check failed: ${e?.data?.error ?? e?.message}`)
    } finally { setChecking(s => ({ ...s, [d.id]: false })) }
  }

  const checkAll = async () => {
    setCheckAllRunning(true)
    for (const d of snmpReady) {
      if (checking[d.id]) continue
      setChecking(s => ({ ...s, [d.id]: true }))
      try {
        await api.post(`/servers/${d.id}/firmware-check`)
      } catch { /* continue */ } finally {
        setChecking(s => ({ ...s, [d.id]: false }))
      }
    }
    setCheckAllRunning(false)
    onDevicesChanged()
  }

  // ── Analytics ──────────────────────────────────────────────────────────────
  const checked = snmpReady.filter(d => (d as any).firmware_check_result)
  const eolDevices    = checked.filter(d => (d as any).firmware_check_result?.eol === true)
  const outdated      = checked.filter(d => (d as any).firmware_check_result?.status === 'outdated')
  const allCves       = checked.flatMap(d => ((d as any).firmware_check_result?.cves ?? []) as Array<{ id: string; severity: string; summary: string }>)
  const criticalCves  = allCves.filter(c => c.severity === 'critical')

  // near-EOL: not confirmed EOL, but release_date older than 3 years or recommendation mentions EOL/sunset
  const nearEol = checked.filter(d => {
    const r = (d as any).firmware_check_result as FirmwareCheckResult
    if (!r || r.eol === true) return false
    const rec = (r.recommendation ?? '').toLowerCase() + (r.notes ?? '').toLowerCase()
    return rec.includes('end-of-life') || rec.includes('eol') || rec.includes('end of life') || rec.includes('sunset')
  })

  // ── Filter ─────────────────────────────────────────────────────────────────
  const filtered = snmpReady.filter(d => {
    const r = (d as any).firmware_check_result as FirmwareCheckResult | null
    if (statusFilter === 'all') return true
    if (!r) return statusFilter === 'unknown'
    if (statusFilter === 'eol') return r.eol === true
    if (statusFilter === 'near-eol') return r.eol !== true && ((r.recommendation ?? '') + (r.notes ?? '')).toLowerCase().match(/end.of.life|eol|sunset/)
    if (statusFilter === 'outdated') return r.status === 'outdated'
    if (statusFilter === 'current') return r.status === 'current'
    if (statusFilter === 'unknown') return r.status === 'unknown'
    if (statusFilter === 'has-cves') return (r.cves?.length ?? 0) > 0
    return true
  })

  // ── Export ─────────────────────────────────────────────────────────────────
  const exportAnalysisCSV = () => {
    const rows = [
      toCSVRow(['Device', 'Vendor', 'Model', 'Firmware (current)', 'Latest Version', 'Status', 'EOL', 'Release Date', 'CVE Count', 'Critical CVEs', 'Recommendation', 'Checked At']),
      ...snmpReady.map(d => {
        const r = (d as any).firmware_check_result as FirmwareCheckResult | null
        const cves = r?.cves ?? []
        return toCSVRow([
          d.name, (d as any).snmp_vendor, (d as any).snmp_model, (d as any).snmp_firmware,
          r?.latest_version, r?.status ?? 'not checked', r?.eol == null ? '' : r.eol ? 'yes' : 'no',
          r?.release_date, cves.length, cves.filter(c => c.severity === 'critical').length,
          r?.recommendation, (d as any).firmware_check_at ? new Date((d as any).firmware_check_at).toISOString() : ''
        ])
      })
    ]
    downloadFile(`firmware-analysis-${new Date().toISOString().slice(0,10)}.csv`, rows.join('\n'), 'text/csv')
  }

  const exportAnalysisJSON = () => {
    const data = snmpReady.map(d => {
      const p = d as any
      return {
        id: d.id, name: d.name, hostname: d.hostname, os_type: d.os_type, environment: d.environment,
        vendor: p.snmp_vendor, model: p.snmp_model, serial: p.snmp_serial,
        firmware_current: p.snmp_firmware,
        firmware_check_at: p.firmware_check_at,
        analysis: p.firmware_check_result ?? null,
      }
    })
    downloadFile(`firmware-analysis-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2), 'application/json')
  }

  const exportDevicesCSV = () => {
    const rows = [
      toCSVRow(['ID', 'Name', 'Hostname', 'Type', 'Environment', 'Vendor', 'Model', 'Serial', 'MAC', 'Firmware', 'SNMP Version', 'SNMP Port', 'Ping Status', 'Ping Latency (ms)', 'Firmware Status', 'EOL', 'CVE Count']),
      ...networkDevices.map(d => {
        const p = d as any
        const r = p.firmware_check_result as FirmwareCheckResult | null
        return toCSVRow([
          d.id, d.name, d.hostname, d.os_type, d.environment,
          p.snmp_vendor, p.snmp_model, p.snmp_serial, p.snmp_mac_address, p.snmp_firmware,
          d.snmp_version, p.snmp_port, p.ping_last_status, p.ping_last_latency_ms,
          r?.status ?? '', r?.eol == null ? '' : r.eol ? 'yes' : 'no', r?.cves?.length ?? 0
        ])
      })
    ]
    downloadFile(`network-devices-${new Date().toISOString().slice(0,10)}.csv`, rows.join('\n'), 'text/csv')
  }

  const exportDevicesJSON = () => {
    downloadFile(
      `network-devices-${new Date().toISOString().slice(0,10)}.json`,
      JSON.stringify(networkDevices.map(d => ({ ...d })), null, 2),
      'application/json'
    )
  }

  const statCard = (label: string, value: number, color: string, filterKey: typeof statusFilter, tooltip?: string) => (
    <button
      title={tooltip}
      onClick={() => setStatusFilter(f => f === filterKey ? 'all' : filterKey)}
      style={{ flex: 1, background: statusFilter === filterKey ? `${color}22` : 'var(--bg-surface)', border: `1px solid ${statusFilter === filterKey ? color : 'var(--border-med)'}`, borderRadius: 10, padding: '12px 16px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
    </button>
  )

  const sevColor = (s: string) => ({ critical: '#f87171', high: '#fb923c', medium: '#fbbf24', low: '#a3e635', info: '#60a5fa' }[s] ?? '#9ca3af')

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>AI Firmware Analysis</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>AI-powered firmware audit — EOL detection, version gaps, and CVE exposure across all network devices.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={checkAll}
            disabled={checkAllRunning || snmpReady.length === 0}
            style={{ fontSize: 12, padding: '6px 14px', borderRadius: 7, cursor: checkAllRunning ? 'default' : 'pointer', background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#a78bfa', fontWeight: 600, opacity: checkAllRunning ? 0.6 : 1 }}
          >
            {checkAllRunning ? '⟳ Checking all…' : '🤖 Check All'}
          </button>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setExportMenu(m => !m)}
              style={{ fontSize: 12, padding: '6px 14px', borderRadius: 7, cursor: 'pointer', background: 'var(--bg-surface)', border: '1px solid var(--border-med)', color: 'var(--text-secondary)', fontWeight: 600 }}
            >
              ↓ Export
            </button>
            {exportMenu && (
              <div onClick={() => setExportMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
            )}
            {exportMenu && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border-med)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', zIndex: 50, minWidth: 200, overflow: 'hidden' }}>
                {[
                  { label: '📊 Analysis — CSV', fn: exportAnalysisCSV },
                  { label: '📊 Analysis — JSON', fn: exportAnalysisJSON },
                  { label: '🖥 All Devices — CSV', fn: exportDevicesCSV },
                  { label: '🖥 All Devices — JSON', fn: exportDevicesJSON },
                ].map(item => (
                  <button key={item.label} onClick={() => { setExportMenu(false); item.fn() }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', fontSize: 12, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >{item.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        {statCard('Devices checked', checked.length, '#60a5fa', 'all', 'Click to show all')}
        {statCard('End-of-Life', eolDevices.length, '#f87171', 'eol', 'Devices confirmed as EOL by vendor')}
        {statCard('Near EOL', nearEol.length, '#fb923c', 'near-eol', 'Devices where AI notes EOL risk')}
        {statCard('Outdated firmware', outdated.length, '#fbbf24', 'outdated')}
        {statCard('CVEs found', allCves.length, '#a78bfa', 'has-cves', `${criticalCves.length} critical`)}
      </div>

      {/* CVE severity breakdown (only when cves exist) */}
      {allCves.length > 0 && (
        <div style={{ marginBottom: 16, padding: '10px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-med)', borderRadius: 10, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>CVE BREAKDOWN</span>
          {(['critical', 'high', 'medium', 'low', 'info'] as const).map(sev => {
            const count = allCves.filter(c => c.severity === sev).length
            if (!count) return null
            return <span key={sev} style={{ fontSize: 12, fontWeight: 600, color: sevColor(sev) }}>{sev.toUpperCase()} <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>×{count}</span></span>
          })}
        </div>
      )}

      {/* Filter bar */}
      {snmpReady.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {([
            ['all', 'All'],
            ['eol', '🔴 EOL'],
            ['near-eol', '🟠 Near EOL'],
            ['outdated', '🟡 Outdated'],
            ['current', '🟢 Current'],
            ['unknown', '⬜ Unknown'],
            ['has-cves', '⚠ Has CVEs'],
          ] as [typeof statusFilter, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setStatusFilter(key)}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', fontWeight: statusFilter === key ? 700 : 400, background: statusFilter === key ? 'var(--accent-blue)' : 'var(--bg-surface)', border: `1px solid ${statusFilter === key ? 'var(--accent-blue)' : 'var(--border-med)'}`, color: statusFilter === key ? '#fff' : 'var(--text-secondary)' }}
            >{label}</button>
          ))}
        </div>
      )}

      {snmpReady.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          No devices with SNMP data yet. Enable SNMP on a device and run an SNMP Fetch first.
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          No devices match this filter.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                {['Device', 'Vendor / Model', 'Firmware', 'Status', 'EOL', 'CVEs', 'Last Checked', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => {
                const p = d as any
                const fResult = p.firmware_check_result as FirmwareCheckResult | null
                const fAt = p.firmware_check_at as string | null
                const cves = fResult?.cves ?? []
                const critCount = cves.filter((c: any) => c.severity === 'critical').length
                const eol = fResult?.eol
                return (
                  <tr key={d.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                      {d.name}
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}><DeviceBadge type={d.os_type} /></div>
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 12 }}>
                      <div style={{ color: 'var(--text-secondary)' }}>{p.snmp_vendor ?? '—'}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>{p.snmp_model ?? '—'}</div>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.snmp_firmware ?? '—'}</div>
                      {fResult?.latest_version && fResult.latest_version !== p.snmp_firmware && (
                        <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 2 }}>→ {fResult.latest_version}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px' }}><FirmwareBadge result={fResult} /></td>
                    <td style={{ padding: '10px 14px', fontSize: 12 }}>
                      {eol == null ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                        : eol ? <span style={{ color: '#f87171', fontWeight: 700 }}>EOL</span>
                        : <span style={{ color: '#34d399' }}>✓</span>}
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 12 }}>
                      {cves.length === 0
                        ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                        : <span style={{ color: critCount > 0 ? '#f87171' : '#fbbf24', fontWeight: 600 }}>
                            {cves.length} {critCount > 0 && <span style={{ fontSize: 10, fontWeight: 400 }}>({critCount} crit)</span>}
                          </span>
                      }
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
                      {fAt ? new Date(fAt).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <button onClick={() => check(d)} disabled={checking[d.id]} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: checking[d.id] ? 'default' : 'pointer', background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.35)', color: '#a78bfa', fontWeight: 600, opacity: checking[d.id] ? 0.6 : 1 }}>
                          {checking[d.id] ? '⟳' : '🤖'}
                        </button>
                        {fResult && fAt && (
                          <button onClick={() => setFirmwareModal({ device: d, result: fResult, checkedAt: fAt })} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border-med)', color: 'var(--text-muted)' }}>📋</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {networkDevices.length > snmpReady.length && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
          {networkDevices.length - snmpReady.length} device(s) not shown — SNMP not enabled or fetch not run yet.
        </div>
      )}

      {firmwareModal && (
        <FirmwareModal
          deviceName={firmwareModal.device.name}
          result={firmwareModal.result}
          checkedAt={firmwareModal.checkedAt}
          onClose={() => setFirmwareModal(null)}
        />
      )}
    </div>
  )
}

// ── Devices Tab ───────────────────────────────────────────────────────────────

function DevicesTab({ devices, snmpProfiles, onChanged }: { devices: Server[]; snmpProfiles: SnmpProfile[]; onChanged: () => void }) {
  const [filter, setFilter] = useState('')
  const [filterType, setFilterType] = useState<string>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'office', os_type: 'router' as NetworkOsType })
  const [addError, setAddError] = useState('')
  const [editDevice, setEditDevice] = useState<Server | null>(null)
  const [editForm, setEditForm] = useState({ name: '', hostname: '', ssh_port: 22, environment: 'office', os_type: 'router' as NetworkOsType })
  const [editError, setEditError] = useState('')
  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'failed' | 'testing'>>({})
  const [snmpFetching, setSnmpFetching] = useState<Record<string, boolean>>({})
  const [snmpModal, setSnmpModal] = useState<{ device: Server; profile: NetworkProfile } | null>(null)
  const [firmChecking, setFirmChecking] = useState<Record<string, boolean>>({})
  const [firmModal, setFirmModal] = useState<{ device: Server; result: FirmwareCheckResult; checkedAt: string } | null>(null)
  const [profileDevice, setProfileDevice] = useState<Server | null>(null)
  const [rebooting, setRebooting] = useState<Record<string, boolean>>({})
  const { requestElevation: reqElevation } = useTotpElevation()
  const navigate = useNavigate()

  const testConnection = useCallback(async (d: Server) => {
    setTestResults(r => ({ ...r, [d.id]: 'testing' }))
    try { await api.post(`/servers/${d.id}/test-connection`, {}); setTestResults(r => ({ ...r, [d.id]: 'ok' })) }
    catch { setTestResults(r => ({ ...r, [d.id]: 'failed' })) }
  }, [])

  const openSsh = useCallback(async (d: Server) => {
    if (d.access_ssh_auth_type === 'password') {
      try {
        const p = await api.get<NetworkProfile>(`/servers/${d.id}/network-profile`)
        navigate(p.ssh_credential_id ? `/terminal?server=${d.id}&credential_id=${p.ssh_credential_id}` : `/terminal?server=${d.id}`)
      } catch { navigate(`/terminal?server=${d.id}`) }
    } else { navigate(`/terminal?server=${d.id}`) }
  }, [navigate])

  const rebootDevice = useCallback(async (d: Server) => {
    if (rebooting[d.id]) return
    try { await reqElevation('network_device_reboot') } catch { return }
    if (!window.confirm(`Reboot ${d.name} (${d.hostname})? The device will be unreachable for a moment.`)) return
    setRebooting(r => ({ ...r, [d.id]: true }))
    try {
      await api.post(`/servers/${d.id}/reboot`, {})
    } catch (e: any) {
      alert(`Reboot failed: ${e?.data?.error ?? e?.message ?? 'Unknown error'}`)
    } finally {
      setRebooting(r => { const n = { ...r }; delete n[d.id]; return n })
    }
  }, [rebooting, reqElevation])

  const fetchSnmp = useCallback(async (d: Server) => {
    setSnmpFetching(s => ({ ...s, [d.id]: true }))
    try {
      await api.post(`/servers/${d.id}/snmp-fetch`)
      const profile = await api.get<NetworkProfile>(`/servers/${d.id}/network-profile`)
      setSnmpModal({ device: d, profile })
      onChanged()
    } catch (e: any) { alert(`SNMP fetch failed: ${e?.data?.error ?? e?.message}`) }
    finally { setSnmpFetching(s => ({ ...s, [d.id]: false })) }
  }, [onChanged])

  const checkFirmware = useCallback(async (d: Server) => {
    setFirmChecking(s => ({ ...s, [d.id]: true }))
    try {
      const r = await api.post<{ ok: boolean; checked_at: string; result: FirmwareCheckResult }>(`/servers/${d.id}/firmware-check`)
      setFirmModal({ device: d, result: r.result, checkedAt: r.checked_at })
      onChanged()
    } catch (e: any) { alert(`Firmware check failed: ${e?.data?.error ?? e?.message}`) }
    finally { setFirmChecking(s => ({ ...s, [d.id]: false })) }
  }, [onChanged])

  const handleAdd = async () => {
    setAddError('')
    try {
      await api.post('/servers', { ...addForm, device_category: 'network' })
      setShowAdd(false); setAddForm({ name: '', hostname: '', ssh_port: 22, environment: 'office', os_type: 'router' }); onChanged()
    } catch (e: any) { setAddError(e?.data?.error ?? e?.message ?? 'Failed to add device') }
  }

  const handleEdit = async () => {
    if (!editDevice) return; setEditError('')
    try {
      await api.put(`/servers/${editDevice.id}`, { ...editForm, device_category: 'network' })
      setEditDevice(null); onChanged()
    } catch (e: any) { setEditError(e?.data?.error ?? e?.message ?? 'Failed to update') }
  }

  const handleDelete = async (d: Server) => {
    if (!confirm(`Delete "${d.name}"?`)) return
    await api.delete(`/servers/${d.id}`).catch(() => {}); onChanged()
  }

  const filtered = devices.filter(d => {
    const q = filter.toLowerCase()
    return (!q || d.name.toLowerCase().includes(q) || d.hostname.toLowerCase().includes(q))
      && (filterType === 'all' || d.os_type === filterType)
  })

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by name or hostname…" style={{ ...inp, width: 220 }} />
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...inp, width: 180 }}>
          <option value="all">All types</option>
          {osTypeGroups.map(g => (
            <optgroup key={g.group} label={`── ${g.group}`}>
              {g.options.map(v => <option key={v} value={v}>{DEVICE_META[v].icon} {DEVICE_META[v].label}</option>)}
            </optgroup>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowAdd(true)} style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
          + Add Device
        </button>
      </div>

      {/* Stats chips */}
      {devices.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {Object.entries(DEVICE_META).map(([type, m]) => {
            const count = devices.filter(d => d.os_type === type).length
            if (!count) return null
            return (
              <button key={type} onClick={() => setFilterType(filterType === type ? 'all' : type)} style={{ fontSize: 11, fontWeight: 600, background: m.bg, border: `1px solid ${filterType === type ? m.color : m.border}`, color: m.color, borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>
                {m.icon} {count} {m.label}
              </button>
            )
          })}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 4px', alignSelf: 'center' }}>{devices.length} total</span>
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 14 }}>
          {devices.length === 0 ? 'No network devices yet. Click "+ Add Device" to get started.' : 'No devices match your filter.'}
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '9%'  }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '29%' }} />
            </colgroup>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                {['Device', 'Type', 'Hostname / IP', 'Ping', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => {
                const tr = testResults[d.id]
                const fetching = snmpFetching[d.id]
                const firmChecks = firmChecking[d.id]
                const dAny = d as any
                const envColors: Record<string, { bg: string; color: string }> = {
                  office:     { bg: 'rgba(99,102,241,0.12)',  color: '#818cf8' },
                  branch:     { bg: 'rgba(52,211,153,0.12)',  color: '#34d399' },
                  datacenter: { bg: 'rgba(251,146,60,0.12)',  color: '#fb923c' },
                  home:       { bg: 'rgba(167,139,250,0.12)', color: '#a78bfa' },
                  warehouse:  { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af' },
                }
                const envStyle = envColors[d.environment] ?? envColors.office
                // icon button base
                const btn = (extra: React.CSSProperties = {}): React.CSSProperties => ({
                  width: 26, height: 26, borderRadius: 5, border: '1px solid var(--border-med)',
                  background: 'transparent', cursor: 'pointer', display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0,
                  ...extra,
                })
                return (
                  <tr key={d.id} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>

                    {/* Device: name + env badge + model */}
                    <td style={{ padding: '8px 12px', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                        <span style={{ fontSize: 10, fontWeight: 600, borderRadius: 3, padding: '0 5px', background: envStyle.bg, color: envStyle.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{d.environment}</span>
                      </div>
                      {(dAny.snmp_vendor || dAny.snmp_model) && (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {[dAny.snmp_vendor, dAny.snmp_model].filter(Boolean).join(' ')}
                        </div>
                      )}
                    </td>

                    {/* Type */}
                    <td style={{ padding: '8px 12px' }}><DeviceBadge type={d.os_type} /></td>

                    {/* Hostname + access method icons */}
                    <td style={{ padding: '8px 12px', overflow: 'hidden' }}>
                      <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.hostname}</div>
                      <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>
                        {d.access_ssh_enabled && <span title="SSH enabled" style={{ fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '0 4px', background: 'rgba(46,160,67,0.15)', border: '1px solid rgba(46,160,67,0.3)', color: '#3fb950' }}>SSH</span>}
                        {d.web_enabled        && <span title="Web UI"      style={{ fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '0 4px', background: 'rgba(56,139,253,0.15)', border: '1px solid rgba(56,139,253,0.3)', color: '#58a6ff' }}>WEB</span>}
                        {d.snmp_enabled       && <span title="SNMP"        style={{ fontSize: 9, fontWeight: 700, borderRadius: 3, padding: '0 4px', background: 'rgba(210,153,34,0.15)', border: '1px solid rgba(210,153,34,0.3)', color: '#e3b341' }}>SNMP</span>}
                      </div>
                    </td>

                    {/* Ping */}
                    <td style={{ padding: '8px 12px' }}>
                      <PingDot status={dAny.in_stock ? null : !dAny.ping_enabled ? null : dAny.ping_last_status} />
                      {dAny.ping_last_latency_ms != null && !dAny.in_stock && dAny.ping_enabled && (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{dAny.ping_last_latency_ms} ms</div>
                      )}
                    </td>

                    {/* Status: FW badge + SNMP date */}
                    <td style={{ padding: '8px 12px' }}>
                      <FirmwareBadge result={dAny.firmware_check_result} />
                      {d.snmp_last_fetched_at && (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                          SNMP {new Date(d.snmp_last_fetched_at).toLocaleDateString()}
                        </div>
                      )}
                    </td>

                    {/* Actions — icon-only buttons */}
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'nowrap' }}>

                        {/* SSH */}
                        {d.access_ssh_enabled ? (
                          <button onClick={() => openSsh(d)} title="Open SSH terminal" style={btn({ background: 'var(--accent-hex)', border: 'none', color: '#fff' })}>⌨</button>
                        ) : (
                          <button onClick={() => testConnection(d)} title="Test SSH connection" style={btn({ color: tr === 'ok' ? '#3fb950' : tr === 'failed' ? '#f87171' : 'var(--text-muted)' })}>
                            {tr === 'testing' ? '…' : tr === 'ok' ? '✓' : tr === 'failed' ? '✗' : '⌨'}
                          </button>
                        )}

                        {/* Reboot */}
                        {d.access_ssh_enabled && (
                          <button onClick={() => rebootDevice(d)} disabled={!!rebooting[d.id]} title="Reboot device via SSH" style={btn({ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', color: '#fbbf24', opacity: rebooting[d.id] ? 0.55 : 1, cursor: rebooting[d.id] ? 'default' : 'pointer' })}>
                            {rebooting[d.id] ? '…' : '↺'}
                          </button>
                        )}

                        {/* Web UI */}
                        {d.web_enabled && d.web_url && (
                          <a href={d.web_url} target="_blank" rel="noopener noreferrer" title="Open Web UI" style={{ ...btn({ background: 'rgba(56,139,253,0.12)', border: '1px solid rgba(56,139,253,0.35)', color: '#58a6ff', textDecoration: 'none' }) }}>🌐</a>
                        )}

                        {/* SNMP fetch */}
                        {d.snmp_enabled && (
                          <button onClick={() => fetchSnmp(d)} disabled={fetching} title="Fetch SNMP data" style={btn({ background: 'rgba(210,153,34,0.12)', border: '1px solid rgba(210,153,34,0.35)', color: '#e3b341', opacity: fetching ? 0.55 : 1, cursor: fetching ? 'default' : 'pointer' })}>
                            {fetching ? '…' : '📊'}
                          </button>
                        )}

                        {/* View SNMP result */}
                        {d.snmp_enabled && d.snmp_last_fetched_at && !fetching && (
                          <button onClick={async () => { const p = await api.get<NetworkProfile>(`/servers/${d.id}/network-profile`); setSnmpModal({ device: d, profile: p }) }} title="View SNMP data" style={btn()}>📋</button>
                        )}

                        {/* AI firmware check */}
                        {dAny.snmp_firmware && (
                          <button onClick={() => checkFirmware(d)} disabled={firmChecks} title="AI firmware check" style={btn({ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.35)', color: '#a78bfa', opacity: firmChecks ? 0.55 : 1, cursor: firmChecks ? 'default' : 'pointer' })}>
                            {firmChecks ? '…' : '🤖'}
                          </button>
                        )}

                        {/* View firmware result */}
                        {dAny.firmware_check_result && dAny.firmware_check_at && (
                          <button onClick={() => setFirmModal({ device: d, result: dAny.firmware_check_result, checkedAt: dAny.firmware_check_at })} title="View firmware analysis" style={btn()}>🔍</button>
                        )}

                        {/* Divider */}
                        <span style={{ width: 1, height: 16, background: 'var(--border-med)', flexShrink: 0, margin: '0 1px' }} />

                        {/* Configure */}
                        <button onClick={() => setProfileDevice(d)} title="Configure SSH/Web/SNMP" style={btn()}>⚙</button>

                        {/* Edit */}
                        <button onClick={() => { setEditDevice(d); setEditForm({ name: d.name, hostname: d.hostname, ssh_port: d.ssh_port, environment: d.environment, os_type: (d.os_type as NetworkOsType) ?? 'other-network' }); setEditError('') }} title="Edit device" style={btn()}>✎</button>

                        {/* Delete */}
                        <button onClick={() => handleDelete(d)} title="Delete device" style={btn({ color: 'var(--danger)', borderColor: 'rgba(248,113,113,0.3)' })}>✕</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Modal */}
      {showAdd && (
        <Modal title="Add Network Device" onClose={() => setShowAdd(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 380 }}>
            <div><label style={lbl}>Device Type</label><DeviceTypeSelect value={addForm.os_type} onChange={v => setAddForm(f => ({ ...f, os_type: v }))} style={inp} /></div>
            <div><label style={lbl}>Name</label><input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} placeholder="Office Router" style={inp} /></div>
            <div><label style={lbl}>Hostname / IP Address</label><input value={addForm.hostname} onChange={e => setAddForm(f => ({ ...f, hostname: e.target.value }))} placeholder="192.168.1.1" style={inp} /></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}><label style={lbl}>SSH Port</label><input type="number" value={addForm.ssh_port} onChange={e => setAddForm(f => ({ ...f, ssh_port: Number(e.target.value) }))} style={inp} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Environment</label>
                <select value={addForm.environment} onChange={e => setAddForm(f => ({ ...f, environment: e.target.value }))} style={inp}>
                  {['office', 'branch', 'datacenter', 'home', 'warehouse'].map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            </div>
            {addError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{addError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleAdd} style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Add Device</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit Modal */}
      {editDevice && (
        <Modal title={`Edit — ${editDevice.name}`} onClose={() => setEditDevice(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 380 }}>
            <div><label style={lbl}>Device Type</label><DeviceTypeSelect value={editForm.os_type} onChange={v => setEditForm(f => ({ ...f, os_type: v }))} style={inp} /></div>
            <div><label style={lbl}>Name</label><input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} style={inp} /></div>
            <div><label style={lbl}>Hostname / IP Address</label><input value={editForm.hostname} onChange={e => setEditForm(f => ({ ...f, hostname: e.target.value }))} style={inp} /></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}><label style={lbl}>SSH Port</label><input type="number" value={editForm.ssh_port} onChange={e => setEditForm(f => ({ ...f, ssh_port: Number(e.target.value) }))} style={inp} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Environment</label>
                <select value={editForm.environment} onChange={e => setEditForm(f => ({ ...f, environment: e.target.value }))} style={inp}>
                  {['office', 'branch', 'datacenter', 'home', 'warehouse'].map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            </div>
            {editError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => setEditDevice(null)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleEdit} style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Save Changes</button>
            </div>
          </div>
        </Modal>
      )}

      {profileDevice && <AccessProfileModal device={profileDevice} snmpProfiles={snmpProfiles} onClose={() => setProfileDevice(null)} onSaved={onChanged} />}
      {snmpModal && <SnmpResultModal deviceName={snmpModal.device.name} profile={snmpModal.profile} onClose={() => setSnmpModal(null)} />}
      {firmModal && <FirmwareModal deviceName={firmModal.device.name} result={firmModal.result} checkedAt={firmModal.checkedAt} onClose={() => setFirmModal(null)} />}
    </div>
  )
}

// ── Port Dashboard Tab ────────────────────────────────────────────────────────

interface SnmpPort {
  index: number
  name: string
  descr: string
  alias: string
  mac: string
  admin_up: boolean
  oper_up: boolean
  speed_mbps: number
  pvid: number | null
}

function PortStatusDot({ up }: { up: boolean }) {
  return (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: up ? '#3fb950' : '#4b5563', boxShadow: up ? '0 0 4px #3fb950' : 'none', flexShrink: 0 }} />
  )
}

function speedLabel(mbps: number): string {
  if (!mbps) return '—'
  if (mbps >= 1000) return `${mbps / 1000}G`
  return `${mbps}M`
}

function PortsTab({ devices }: { devices: Server[] }) {
  const snmpDevices = devices.filter(d => d.snmp_enabled)
  const [selectedId, setSelectedId] = useState<string>(snmpDevices[0]?.id ?? '')
  const [ports, setPorts] = useState<SnmpPort[] | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'up' | 'down'>('all')
  const [search, setSearch] = useState('')
  const [toggling, setToggling] = useState<Record<number, boolean>>({})
  const { requestElevation } = useTotpElevation()

  const selected = devices.find(d => d.id === selectedId)

  // Load cached ports from snmp_interfaces on device switch
  useEffect(() => {
    setPorts(null); setError(''); setFetchedAt(null)
    if (!selectedId) return
    api.get<any>(`/servers/${selectedId}/network-profile`)
      .then(p => {
        if (p.snmp_interfaces) {
          setPorts(p.snmp_interfaces as SnmpPort[])
          setFetchedAt(p.snmp_last_fetched_at ?? null)
        }
      })
      .catch(() => {})
  }, [selectedId])

  const togglePort = async (p: SnmpPort) => {
    if (!selectedId || toggling[p.index]) return
    try {
      await requestElevation('network_port_shutdown')
    } catch { return }
    setToggling(t => ({ ...t, [p.index]: true }))
    try {
      await api.post(`/servers/${selectedId}/snmp-port-admin`, { ifIndex: p.index, adminUp: !p.admin_up })
      setPorts(prev => prev ? prev.map(x => x.index === p.index ? { ...x, admin_up: !p.admin_up } : x) : prev)
    } catch (e: any) {
      setError(e?.data?.error ?? e?.message ?? 'Toggle failed')
    } finally {
      setToggling(t => { const n = { ...t }; delete n[p.index]; return n })
    }
  }

  const pollPorts = async () => {
    if (!selectedId) return
    setFetching(true); setError('')
    try {
      const r = await api.post<{ ok: boolean; fetched_at: string; ports: SnmpPort[] }>(`/servers/${selectedId}/snmp-ports`)
      setPorts(r.ports)
      setFetchedAt(r.fetched_at)
    } catch (e: any) {
      setError(e?.data?.error ?? e?.message ?? 'Port poll failed')
    } finally { setFetching(false) }
  }

  const filtered = (ports ?? []).filter(p => {
    if (filterStatus === 'up' && !p.oper_up) return false
    if (filterStatus === 'down' && p.oper_up) return false
    if (search) {
      const q = search.toLowerCase()
      return p.name.toLowerCase().includes(q) || p.descr.toLowerCase().includes(q) || p.alias.toLowerCase().includes(q)
    }
    return true
  })

  const upCount = (ports ?? []).filter(p => p.oper_up).length
  const downCount = (ports ?? []).filter(p => !p.oper_up).length

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value)}
          style={{ ...inp, width: 220 }}
        >
          {snmpDevices.length === 0
            ? <option value="">No SNMP-enabled devices</option>
            : snmpDevices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.hostname})</option>)
          }
        </select>

        <button
          onClick={pollPorts}
          disabled={fetching || !selectedId || snmpDevices.length === 0}
          style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: fetching ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: fetching ? 0.65 : 1 }}
        >
          {fetching ? 'Polling…' : '🔌 Poll Ports'}
        </button>

        {ports && (
          <>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['all', 'up', 'down'] as const).map(f => (
                <button key={f} onClick={() => setFilterStatus(f)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: 'pointer', fontWeight: filterStatus === f ? 600 : 400, background: filterStatus === f ? 'var(--accent-hex)' : 'transparent', border: `1px solid ${filterStatus === f ? 'var(--accent-hex)' : 'var(--border-med)'}`, color: filterStatus === f ? '#fff' : 'var(--text-muted)' }}>
                  {f === 'up' ? `✓ Up (${upCount})` : f === 'down' ? `✗ Down (${downCount})` : `All (${ports.length})`}
                </button>
              ))}
            </div>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search port name…"
              style={{ ...inp, width: 180 }}
            />
          </>
        )}

        <div style={{ flex: 1 }} />
        {fetchedAt && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Polled {new Date(fetchedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 7, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.35)', color: '#f87171', fontSize: 13 }}>
          {error}
        </div>
      )}

      {snmpDevices.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          No SNMP-enabled devices. Enable SNMP on a device in the Devices tab → Configure (⚙) → SNMP.
        </div>
      ) : !ports ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          {fetching ? 'Walking interface table…' : 'Click "Poll Ports" to fetch interface status from this device via SNMP.'}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          No ports match.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-med)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
          {/* Visual port strip */}
          {selected && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-med)', background: 'var(--bg-card)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                {selected.name} — {ports.length} interfaces &nbsp;
                <span style={{ color: '#3fb950' }}>▲ {upCount} up</span>
                <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>·</span>
                <span style={{ color: '#9ca3af' }}>▼ {downCount} down</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {ports.map(p => (
                  <div
                    key={p.index}
                    title={`${p.name}${p.alias ? ` — ${p.alias}` : ''}\n${p.oper_up ? 'Up' : 'Down'} · ${speedLabel(p.speed_mbps)}${p.pvid ? ` · VLAN ${p.pvid}` : ''}`}
                    style={{
                      width: 20, height: 20, borderRadius: 3,
                      background: p.oper_up ? 'rgba(52,211,153,0.2)' : 'rgba(75,85,99,0.25)',
                      border: `1px solid ${p.oper_up ? 'rgba(52,211,153,0.55)' : 'rgba(75,85,99,0.45)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'default',
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 1, background: p.oper_up ? '#3fb950' : '#4b5563' }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '1px solid var(--border-med)' }}>
                {['#', 'Port', 'Description / Alias', 'MAC', 'Admin', 'Link', 'Speed', 'VLAN', ''].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={p.index} style={{ borderBottom: i < filtered.length - 1 ? '1px solid var(--border-weak)' : 'none' }}>
                  <td style={{ padding: '9px 14px', color: 'var(--text-muted)', fontSize: 11 }}>{p.index}</td>
                  <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</td>
                  <td style={{ padding: '9px 14px', fontSize: 12 }}>
                    {p.descr && <div style={{ color: 'var(--text-secondary)' }}>{p.descr}</div>}
                    {p.alias && p.alias !== p.descr && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>↪ {p.alias}</div>}
                  </td>
                  <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{p.mac || '—'}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ fontSize: 11, color: p.admin_up ? '#3fb950' : '#9ca3af' }}>{p.admin_up ? 'Enabled' : 'Disabled'}</span>
                  </td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: p.oper_up ? '#3fb950' : '#6b7280' }}>
                      <PortStatusDot up={p.oper_up} />
                      {p.oper_up ? 'Up' : 'Down'}
                    </span>
                  </td>
                  <td style={{ padding: '9px 14px', fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{speedLabel(p.speed_mbps)}</td>
                  <td style={{ padding: '9px 14px', fontSize: 12 }}>
                    {p.pvid ? (
                      <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 4, padding: '1px 7px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8' }}>
                        VLAN {p.pvid}
                      </span>
                    ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <button
                      onClick={() => togglePort(p)}
                      disabled={!!toggling[p.index]}
                      title={p.admin_up ? 'Disable port (SNMP SET)' : 'Enable port (SNMP SET)'}
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: `1px solid ${p.admin_up ? 'rgba(248,113,113,0.4)' : 'rgba(52,211,153,0.4)'}`, background: p.admin_up ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)', color: p.admin_up ? '#f87171' : '#34d399', cursor: toggling[p.index] ? 'default' : 'pointer', opacity: toggling[p.index] ? 0.6 : 1, fontWeight: 600 }}
                    >
                      {toggling[p.index] ? '…' : p.admin_up ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function NetworkDevices() {
  const [pageTab, setPageTab] = useState<'devices' | 'snmp-profiles' | 'ping' | 'firmware' | 'ports'>('devices')
  const [devices, setDevices] = useState<Server[]>([])
  const [snmpProfiles, setSnmpProfiles] = useState<SnmpProfile[]>([])

  const loadDevices = useCallback(() => {
    api.get<Server[]>('/servers?device_category=network').then(setDevices).catch(() => {})
  }, [])

  const loadProfiles = useCallback(() => {
    api.get<SnmpProfile[]>('/snmp-profiles').then(setSnmpProfiles).catch(() => {})
  }, [])

  useEffect(() => { loadDevices(); loadProfiles() }, [loadDevices, loadProfiles])

  const pageTabs = [
    { id: 'devices',       label: '🌐 Devices',       count: devices.length },
    { id: 'snmp-profiles', label: '📊 SNMP Profiles', count: snmpProfiles.length },
    { id: 'ping',          label: '📡 Ping Monitor',  count: null },
    { id: 'ports',         label: '🔌 Port Dashboard', count: null },
    { id: 'firmware',      label: '🛡 Firmware AI',   count: null },
  ] as const

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1280 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>🌐 Network Devices</h1>
        <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
          Routers, switches, firewalls — SSH, Web UI, SNMP, ping monitoring, port dashboard & AI firmware analysis
        </p>
      </div>

      {/* Page Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-med)', marginBottom: 20 }}>
        {pageTabs.map(t => (
          <button key={t.id} onClick={() => setPageTab(t.id)} style={{ padding: '9px 20px', background: 'none', border: 'none', borderBottom: pageTab === t.id ? '2px solid var(--accent-hex)' : '2px solid transparent', color: pageTab === t.id ? 'var(--accent-hex)' : 'var(--text-muted)', fontWeight: pageTab === t.id ? 600 : 400, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            {t.label}
            {t.count != null && t.count > 0 && <span style={{ fontSize: 10, background: pageTab === t.id ? 'var(--accent-hex)' : 'var(--border-med)', color: pageTab === t.id ? '#fff' : 'var(--text-muted)', borderRadius: 10, padding: '0 5px', minWidth: 16, textAlign: 'center' }}>{t.count}</span>}
          </button>
        ))}
      </div>

      {pageTab === 'devices'       && <DevicesTab devices={devices} snmpProfiles={snmpProfiles} onChanged={() => { loadDevices(); loadProfiles() }} />}
      {pageTab === 'snmp-profiles' && <SnmpProfilesTab />}
      {pageTab === 'ping'          && <PingMonitorTab devices={devices} />}
      {pageTab === 'ports'         && <PortsTab devices={devices} />}
      {pageTab === 'firmware'      && <FirmwareTab devices={devices} onDevicesChanged={loadDevices} />}
    </div>
  )
}
