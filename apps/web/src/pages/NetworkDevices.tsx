import React, { useEffect, useState, useCallback, useRef } from 'react'
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
  const [tab, setTab] = useState<'ssh' | 'web' | 'snmp' | 'monitor' | 'actions' | 'guide'>('ssh')
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
    { id: 'actions', label: '⚡ Actions' }, { id: 'guide', label: '📖 Guide' },
  ] as const

  return (
    <Modal title={`Access Profile — ${device.name}`} onClose={onClose} size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-med)', marginBottom: 16, flexShrink: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '7px 16px', background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid var(--accent-hex)' : '2px solid transparent', color: tab === t.id ? 'var(--accent-hex)' : 'var(--text-muted)', fontWeight: tab === t.id ? 600 : 400, fontSize: 13, cursor: 'pointer' }}>
              {t.label}
            </button>
          ))}
        </div>

        <div>
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

        {tab === 'actions' && (
          <HttpActionsTab device={device} />
        )}

        {tab === 'guide' && (
          <GuideTab />
        )}
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '8px 0 0', flexShrink: 0 }}>{error}</p>}
        {tab !== 'actions' && tab !== 'guide' && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexShrink: 0 }}>
            <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{saving ? 'Saving…' : 'Save Profile'}</button>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Guide Tab ─────────────────────────────────────────────────────────────────

function GuideTab() {
  const [section, setSection] = useState<'tabs' | 'dahua' | 'unifi' | 'mikrotik' | 'pfsense' | 'tplink' | 'cisco'>('tabs')

  const h2: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', margin: '0 0 6px 0' }
  const h3: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--accent-hex)', margin: '10px 0 4px 0' }
  const p: React.CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 6px 0', lineHeight: 1.6 }
  const badge = (color: string, text: string) => (
    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: `${color}20`, color, marginRight: 4 }}>{text}</span>
  )
  const tag = (text: string) => (
    <code style={{ fontSize: 11, background: 'var(--bg-body)', padding: '1px 5px', borderRadius: 3, color: 'var(--text-secondary)' }}>{text}</code>
  )

  type Row = { method: string; path: string; body?: string; note?: string }
  function ApiTable({ rows }: { rows: Row[] }) {
    const colors: Record<string, string> = { GET: '#3b82f6', POST: '#10b981', PUT: '#f59e0b', PATCH: '#8b5cf6', DELETE: '#ef4444' }
    return (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginBottom: 8 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-med)' }}>
            {['Method', 'URL Path', 'Body / Note'].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border-weak)' }}>
              <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: 700, fontSize: 10, padding: '1px 5px', borderRadius: 3, background: `${colors[r.method] ?? '#888'}20`, color: colors[r.method] ?? '#888' }}>{r.method}</span>
              </td>
              <td style={{ padding: '5px 6px' }}><code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{r.path}</code></td>
              <td style={{ padding: '5px 6px', color: 'var(--text-muted)', fontSize: 11 }}>{r.body ?? r.note ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  const navItems: { id: typeof section; label: string; icon: string }[] = [
    { id: 'tabs',      label: 'Tab Overview',  icon: '📋' },
    { id: 'dahua',     label: 'Dahua',         icon: '📷' },
    { id: 'unifi',     label: 'UniFi',         icon: '📡' },
    { id: 'mikrotik',  label: 'MikroTik',      icon: '🔀' },
    { id: 'pfsense',   label: 'pfSense / OPNsense', icon: '🔥' },
    { id: 'tplink',    label: 'TP-Link Omada', icon: '🔗' },
    { id: 'cisco',     label: 'Cisco Switch',  icon: '🔵' },
  ]

  return (
    <div style={{ display: 'flex', gap: 14, minHeight: 340 }}>
      {/* Sidebar nav */}
      <div style={{ width: 140, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setSection(n.id)} style={{
            textAlign: 'left', padding: '6px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12,
            background: section === n.id ? 'var(--accent-hex)20' : 'transparent',
            color: section === n.id ? 'var(--accent-hex)' : 'var(--text-secondary)',
            fontWeight: section === n.id ? 600 : 400,
          }}>
            {n.icon} {n.label}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div style={{ width: 1, background: 'var(--border-med)', flexShrink: 0 }} />

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto' }}>

        {section === 'tabs' && (
          <div>
            <h2 style={h2}>Access Profile — Tab Overview</h2>
            <p style={p}>Each tab configures a different access method for this network device.</p>

            <h3 style={h3}>⌨ SSH Tab</h3>
            <p style={p}>Enable SSH access and configure authentication (SSH key or password). You can link a vault entry so credentials are never stored in plain text. Port defaults to 22.</p>

            <h3 style={h3}>🌐 Web Tab</h3>
            <p style={p}>Set the device's base web URL (e.g. {tag('http://192.168.1.100')}). This URL is used as the base for HTTP Actions. You can also enable a web proxy to open the device UI through SSH Manager.</p>

            <h3 style={h3}>📊 SNMP Tab</h3>
            <p style={p}>Attach an SNMP profile to poll device metrics (uptime, interfaces, CPU, memory). Requires SNMP to be enabled on the device. Supports SNMPv1, v2c, and v3.</p>

            <h3 style={h3}>📡 Monitor Tab</h3>
            <p style={p}>Configure ping-based monitoring. SSH Manager will periodically ping the device and alert if it goes offline.</p>

            <h3 style={h3}>⚡ Actions Tab</h3>
            <p style={p}>Define HTTP actions — one-click requests sent from the SSH Manager server to the device's REST API. Useful for rebooting, saving config, checking firmware, etc. without SSH.</p>

            <div style={{ background: 'var(--bg-body)', borderRadius: 8, padding: '10px 12px', marginTop: 8 }}>
              <p style={{ ...p, margin: 0, color: 'var(--text-muted)', fontSize: 11 }}>
                💡 <strong>Tip:</strong> HTTP Actions work even if the device has no SSH. As long as the device has a web/REST interface and SSH Manager can reach it on the network, actions will work.
              </p>
            </div>
          </div>
        )}

        {section === 'dahua' && (
          <div>
            <h2 style={h2}>Dahua NVR / IP Camera</h2>
            <p style={p}>Dahua devices expose a CGI API. Set {tag('Web URL')} to {tag('http://192.168.x.x')} and use <strong>Basic Auth</strong> with your admin credentials.</p>

            <h3 style={h3}>Authentication</h3>
            <p style={p}>{badge('#3b82f6', 'Auth')} Basic Auth — username: {tag('admin')}, password: device password<br />
            {badge('#f59e0b', 'Content-Type')} {tag('application/x-www-form-urlencoded')}</p>

            <h3 style={h3}>Common Actions</h3>
            <ApiTable rows={[
              { method: 'GET',  path: '/cgi-bin/magicBox.cgi?action=getSystemInfo', note: 'System info (model, serial, firmware)' },
              { method: 'GET',  path: '/cgi-bin/magicBox.cgi?action=getDeviceType', note: 'Device type' },
              { method: 'GET',  path: '/cgi-bin/magicBox.cgi?action=getSoftwareVersion', note: 'Firmware version' },
              { method: 'POST', path: '/cgi-bin/magicBox.cgi?action=reboot', note: 'Reboot the device' },
              { method: 'GET',  path: '/cgi-bin/configManager.cgi?action=getConfig&name=Network', note: 'Get network config' },
              { method: 'GET',  path: '/cgi-bin/userManager.cgi?action=getUserInfoAll', note: 'List users' },
            ]} />

            <div style={{ background: 'rgba(239,68,68,0.07)', borderRadius: 7, padding: '8px 10px', marginTop: 4 }}>
              <p style={{ ...p, margin: 0, fontSize: 11 }}>⚠️ Dahua uses Digest Auth on some firmware versions. If Basic Auth fails, try setting the device to allow Basic Auth in <strong>Security → Web Service</strong>.</p>
            </div>
          </div>
        )}

        {section === 'unifi' && (
          <div>
            <h2 style={h2}>UniFi (Ubiquiti)</h2>
            <p style={p}>UniFi Network Application exposes a REST API. Use an <strong>API Key</strong> (UniFi OS 3.x+) for token-based auth, or session cookies for older versions.</p>

            <h3 style={h3}>Authentication (UniFi OS 3.x+)</h3>
            <p style={p}>{badge('#8b5cf6', 'Bearer')} Create API key in <strong>UniFi OS → Settings → API</strong><br />
            {badge('#f59e0b', 'Header')} {tag('X-API-Key: <your-key>')} — add as a Custom Header instead of using Bearer field</p>

            <h3 style={h3}>Common Actions</h3>
            <ApiTable rows={[
              { method: 'GET',  path: '/proxy/network/api/s/default/stat/device', note: 'List all devices' },
              { method: 'GET',  path: '/proxy/network/api/s/default/stat/sta',    note: 'List connected clients' },
              { method: 'GET',  path: '/proxy/network/api/s/default/stat/health', note: 'Site health status' },
              { method: 'POST', path: '/proxy/network/api/s/default/cmd/devmgr',  body: '{"cmd":"restart","mac":"AA:BB:CC:DD:EE:FF"}' },
              { method: 'POST', path: '/proxy/network/api/s/default/cmd/devmgr',  body: '{"cmd":"upgrade","mac":"AA:BB:CC:DD:EE:FF"}' },
            ]} />

            <div style={{ background: 'var(--bg-body)', borderRadius: 7, padding: '8px 10px', marginTop: 4 }}>
              <p style={{ ...p, margin: 0, fontSize: 11 }}>💡 Replace {tag('default')} with your site name. Replace MAC with the device MAC from the UniFi dashboard.</p>
            </div>
          </div>
        )}

        {section === 'mikrotik' && (
          <div>
            <h2 style={h2}>MikroTik (RouterOS REST API)</h2>
            <p style={p}>Available on RouterOS 7.1+. Enable in <strong>IP → Services → www</strong> (port 80) or <strong>www-ssl</strong> (port 443).</p>

            <h3 style={h3}>Authentication</h3>
            <p style={p}>{badge('#3b82f6', 'Basic')} username: {tag('admin')}, password: RouterOS password<br />
            {badge('#f59e0b', 'Content-Type')} {tag('application/json')}</p>

            <h3 style={h3}>Common Actions</h3>
            <ApiTable rows={[
              { method: 'GET',  path: '/rest/system/resource',         note: 'CPU, memory, uptime' },
              { method: 'GET',  path: '/rest/system/routerboard',      note: 'Hardware info, firmware' },
              { method: 'GET',  path: '/rest/interface',               note: 'All interfaces' },
              { method: 'GET',  path: '/rest/ip/address',              note: 'IP addresses' },
              { method: 'GET',  path: '/rest/ip/route',                note: 'Routing table' },
              { method: 'POST', path: '/rest/system/reboot',           body: '{}' },
              { method: 'POST', path: '/rest/system/package/update',   body: '{}' },
            ]} />

            <div style={{ background: 'var(--bg-body)', borderRadius: 7, padding: '8px 10px', marginTop: 4 }}>
              <p style={{ ...p, margin: 0, fontSize: 11 }}>💡 Use {tag('/rest/system/package/update')} to check and download firmware updates. Apply with a reboot.</p>
            </div>
          </div>
        )}

        {section === 'pfsense' && (
          <div>
            <h2 style={h2}>pfSense / OPNsense</h2>

            <h3 style={h3}>OPNsense REST API</h3>
            <p style={p}>OPNsense has a built-in API. Create an API key in <strong>System → Access → Users → Edit user → API Keys</strong>.<br />
            {badge('#3b82f6', 'Basic')} Key as username, Secret as password</p>
            <ApiTable rows={[
              { method: 'GET',  path: '/api/core/firmware/status',       note: 'Firmware update status' },
              { method: 'POST', path: '/api/core/firmware/update',        body: '{}' },
              { method: 'POST', path: '/api/core/system/reboot',          body: '{}' },
              { method: 'GET',  path: '/api/core/system/status',          note: 'System status' },
              { method: 'GET',  path: '/api/interfaces/overview/export',  note: 'Interface overview' },
              { method: 'GET',  path: '/api/diagnostics/interface/getarp', note: 'ARP table' },
            ]} />

            <h3 style={h3}>pfSense — FauxAPI Package</h3>
            <p style={p}>Install <strong>FauxAPI</strong> package in pfSense. Set API key + secret in {tag('/etc/fauxapi/credentials.ini')}.<br />
            {badge('#f59e0b', 'Header')} {tag('fauxapi-auth: <generated-auth-string>')}</p>
            <ApiTable rows={[
              { method: 'GET',  path: '/fauxapi/v1/?action=system_stats',   note: 'CPU, mem, uptime' },
              { method: 'GET',  path: '/fauxapi/v1/?action=gateway_status', note: 'WAN gateway status' },
              { method: 'POST', path: '/fauxapi/v1/?action=system_reboot',  body: '{}' },
            ]} />
          </div>
        )}

        {section === 'tplink' && (
          <div>
            <h2 style={h2}>TP-Link Omada SDN Controller</h2>
            <p style={p}>Omada Software Controller exposes a REST API. Default port is {tag('8088')} (HTTP) or {tag('8043')} (HTTPS).</p>

            <h3 style={h3}>Authentication Flow</h3>
            <p style={p}>Omada uses session-based login. You must login first to get a token, then use it in subsequent requests.</p>
            <ApiTable rows={[
              { method: 'POST', path: '/api/v2/hotspot/login', body: '{"username":"admin","password":"xxx"}' },
              { method: 'GET',  path: '/api/v2/sites',         note: 'List sites (requires login session)' },
            ]} />

            <h3 style={h3}>Omada Controller v5 API (newer)</h3>
            <ApiTable rows={[
              { method: 'POST', path: '/openapi/v1/{omadacId}/login', body: '{"username":"admin","password":"xxx"}' },
              { method: 'GET',  path: '/openapi/v1/{omadacId}/sites', note: 'List all sites' },
              { method: 'GET',  path: '/openapi/v1/{omadacId}/sites/{siteId}/devices', note: 'Devices in site' },
            ]} />

            <div style={{ background: 'rgba(239,68,68,0.07)', borderRadius: 7, padding: '8px 10px', marginTop: 4 }}>
              <p style={{ ...p, margin: 0, fontSize: 11 }}>⚠️ TP-Link Omada relies on session cookies. HTTP Actions work best for stateless endpoints. For session-based auth, consider using SSH to the controller host instead.</p>
            </div>
          </div>
        )}

        {section === 'cisco' && (
          <div>
            <h2 style={h2}>Cisco Switch — HTTP / REST API</h2>
            <p style={p}>
              Many Cisco switch models expose a web management interface or REST API even without SSH.
              The approach differs by product family:
            </p>

            <h3 style={h3}>Cisco SG / SF Small Business Switches (no SSH)</h3>
            <p style={p}>
              Models like SG200, SG300, SG500, SF300 have a web UI only. They use a CGI-based API accessible via HTTP.
              {badge('#3b82f6', 'Basic')} username: {tag('cisco')}, password: device password<br />
              {badge('#f59e0b', 'Content-Type')} {tag('application/x-www-form-urlencoded')}
            </p>
            <ApiTable rows={[
              { method: 'GET',  path: '/System.xml',                       note: 'System info, firmware, uptime' },
              { method: 'GET',  path: '/PortStatistics.xml',               note: 'Per-port TX/RX counters' },
              { method: 'GET',  path: '/vlanPortAssign.xml',               note: 'VLAN port assignments' },
              { method: 'POST', path: '/SaveConf.xml',                     body: 'form body — saves running config' },
              { method: 'POST', path: '/Restart.xml',                      body: 'form body — reboot device' },
            ]} />

            <h3 style={h3}>Cisco CBS (Business Switching) Series</h3>
            <p style={p}>
              CBS110, CBS220, CBS250, CBS350 — these models have a REST-style JSON API (firmware 3.x+).
              {badge('#3b82f6', 'Basic')} admin credentials<br />
              {badge('#f59e0b', 'Content-Type')} {tag('application/json')}
            </p>
            <ApiTable rows={[
              { method: 'GET',  path: '/api/v1/system/info',               note: 'Model, serial, firmware version' },
              { method: 'GET',  path: '/api/v1/system/status',             note: 'CPU, memory, temperature' },
              { method: 'GET',  path: '/api/v1/interface/status',          note: 'All interface link status' },
              { method: 'GET',  path: '/api/v1/vlan/list',                 note: 'VLAN table' },
              { method: 'POST', path: '/api/v1/system/save-config',        body: '{}' },
              { method: 'POST', path: '/api/v1/system/reboot',             body: '{}' },
              { method: 'POST', path: '/api/v1/firmware/check',            body: '{}' },
            ]} />

            <h3 style={h3}>Cisco Catalyst (IOS-XE REST API)</h3>
            <p style={p}>
              Catalyst 9000 series running IOS-XE 16.6+ supports RESTCONF. Enable with {tag('ip http server')} and {tag('restconf')} in IOS config.
              {badge('#8b5cf6', 'Bearer')} or {badge('#3b82f6', 'Basic')} admin credentials<br />
              {badge('#f59e0b', 'Accept')} header: {tag('application/yang-data+json')}
            </p>
            <ApiTable rows={[
              { method: 'GET',  path: '/restconf/data/Cisco-IOS-XE-native:native/hostname',          note: 'Device hostname' },
              { method: 'GET',  path: '/restconf/data/Cisco-IOS-XE-native:native/version',           note: 'IOS-XE version' },
              { method: 'GET',  path: '/restconf/data/ietf-interfaces:interfaces',                   note: 'All interfaces' },
              { method: 'GET',  path: '/restconf/data/Cisco-IOS-XE-native:native/vlan',              note: 'VLAN config' },
              { method: 'GET',  path: '/restconf/data/Cisco-IOS-XE-memory-oper:memory-statistics',   note: 'Memory usage' },
              { method: 'POST', path: '/restconf/operations/cisco-ia:save-config',                   body: '{}' },
            ]} />

            <div style={{ background: 'var(--bg-body)', borderRadius: 7, padding: '8px 10px', marginTop: 6 }}>
              <p style={{ ...p, margin: '0 0 4px 0', fontSize: 11, fontWeight: 600 }}>💡 How to identify your model's API:</p>
              <p style={{ ...p, margin: 0, fontSize: 11 }}>
                1. Open the device web UI and check the URL structure when navigating menus — CGI paths like {tag('/System.xml')} indicate the SG/SF API.<br />
                2. Check firmware release notes — CBS350 firmware 3.0+ added the JSON REST API.<br />
                3. For Catalyst, run {tag('show ip http server status')} in CLI to confirm REST is enabled.
              </p>
            </div>

            <div style={{ background: 'rgba(239,68,68,0.07)', borderRadius: 7, padding: '8px 10px', marginTop: 6 }}>
              <p style={{ ...p, margin: 0, fontSize: 11 }}>
                ⚠️ Older SG200/SF200 models (end-of-life) have no API at all — only the web UI. For these, use SNMP to read stats and consider upgrading to CBS series for full API access.
              </p>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

// ── HTTP Actions Tab ──────────────────────────────────────────────────────────

type AuthType = 'none' | 'basic' | 'bearer' | 'vault'
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface HttpAction {
  id: string
  name: string
  description: string | null
  method: HttpMethod
  url_path: string
  headers: Record<string, string>
  body: string | null
  content_type: string
  auth_type: AuthType
  auth_username: string | null
  vault_id: string | null
  vault_title: string | null
  follow_redirects: boolean
  timeout_ms: number
  sort_order: number
}

interface ActionResult {
  ok: boolean
  status?: number
  status_text?: string
  duration_ms?: number
  response?: string
  error?: string
}

const BUILT_IN_TEMPLATES: Omit<HttpAction, 'id' | 'vault_id' | 'vault_title'>[] = [
  { name: 'Reboot', description: 'Reboot the device', method: 'POST', url_path: '/api/system/reboot', headers: {}, body: null, content_type: 'application/json', auth_type: 'none', auth_username: null, follow_redirects: true, timeout_ms: 10000, sort_order: 0 },
  { name: 'Save Config', description: 'Save running config to startup', method: 'POST', url_path: '/api/system/save-config', headers: {}, body: null, content_type: 'application/json', auth_type: 'none', auth_username: null, follow_redirects: true, timeout_ms: 10000, sort_order: 1 },
  { name: 'Get System Info', description: 'Fetch system status/info', method: 'GET', url_path: '/api/system/info', headers: {}, body: null, content_type: 'application/json', auth_type: 'none', auth_username: null, follow_redirects: true, timeout_ms: 10000, sort_order: 2 },
  { name: 'Firmware Update Check', description: 'Check for firmware updates', method: 'GET', url_path: '/api/firmware/check', headers: {}, body: null, content_type: 'application/json', auth_type: 'none', auth_username: null, follow_redirects: true, timeout_ms: 15000, sort_order: 3 },
]

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: '#3b82f6', POST: '#10b981', PUT: '#f59e0b', PATCH: '#8b5cf6', DELETE: '#ef4444',
}

const emptyForm = (): Partial<HttpAction> & { auth_password: string } => ({
  name: '', description: '', method: 'POST', url_path: '',
  headers: {}, body: '', content_type: 'application/json',
  auth_type: 'none', auth_username: '', auth_password: '',
  vault_id: null, follow_redirects: true, timeout_ms: 10000, sort_order: 0,
})

function HttpActionsTab({ device }: { device: Server }) {
  const [actions, setActions] = useState<HttpAction[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<HttpAction | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [headerKey, setHeaderKey] = useState('')
  const [headerVal, setHeaderVal] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [results, setResults] = useState<Record<string, ActionResult>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [showResult, setShowResult] = useState<string | null>(null)
  const [vaultEntries, setVaultEntries] = useState<{ id: string; title: string }[]>([])

  const load = () => {
    setLoading(true)
    api.get<HttpAction[]>(`/network-devices/${device.id}/actions`)
      .then(setActions).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    api.get<{ id: string; title: string }[]>('/vault?type=database&limit=200')
      .then(rows => setVaultEntries(rows)).catch(() => {})
  }, [device.id])

  function openCreate(template?: Partial<HttpAction>) {
    setEditing(null)
    setForm({ ...emptyForm(), ...(template ?? {}) })
    setHeaderKey(''); setHeaderVal(''); setFormError('')
    setShowForm(true)
  }

  function openEdit(a: HttpAction) {
    setEditing(a)
    setForm({ ...a, auth_password: '' })
    setHeaderKey(''); setHeaderVal(''); setFormError('')
    setShowForm(true)
  }

  async function saveForm() {
    if (!form.name || !form.url_path) { setFormError('Name and URL path are required'); return }
    setSaving(true); setFormError('')
    try {
      const payload = {
        name: form.name, description: form.description ?? null,
        method: form.method, url_path: form.url_path,
        headers: form.headers ?? {}, body: form.body || null,
        content_type: form.content_type, auth_type: form.auth_type,
        auth_username: form.auth_username || null,
        auth_password: (form as any).auth_password || undefined,
        vault_id: form.vault_id || null,
        follow_redirects: form.follow_redirects,
        timeout_ms: form.timeout_ms, sort_order: form.sort_order ?? 0,
      }
      if (editing) {
        await api.patch(`/network-devices/${device.id}/actions/${editing.id}`, payload)
      } else {
        await api.post(`/network-devices/${device.id}/actions`, payload)
      }
      setShowForm(false); load()
    } catch (e: any) { setFormError(e.message) }
    finally { setSaving(false) }
  }

  async function deleteAction(a: HttpAction) {
    if (!confirm(`Delete action "${a.name}"?`)) return
    await api.delete(`/network-devices/${device.id}/actions/${a.id}`)
    load()
  }

  async function execute(a: HttpAction) {
    setRunning(r => ({ ...r, [a.id]: true }))
    setShowResult(a.id)
    try {
      const res = await api.post<ActionResult>(`/network-devices/${device.id}/actions/${a.id}/execute`, {})
      setResults(r => ({ ...r, [a.id]: res }))
    } catch (e: any) {
      setResults(r => ({ ...r, [a.id]: { ok: false, error: e.message } }))
    } finally {
      setRunning(r => ({ ...r, [a.id]: false }))
    }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12, boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 2, fontWeight: 500 }

  if (showForm) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-heading)', marginBottom: 0 }}>
        {editing ? `Edit — ${editing.name}` : 'New HTTP Action'}
      </div>

      {formError && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{formError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
        <div>
          <label style={lbl}>Method</label>
          <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value as HttpMethod }))} style={{ ...inp, color: METHOD_COLORS[form.method as HttpMethod] ?? 'var(--text-primary)', fontWeight: 700 }}>
            {(['GET','POST','PUT','PATCH','DELETE'] as HttpMethod[]).map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>URL Path *</label>
          <input value={form.url_path ?? ''} onChange={e => setForm(f => ({ ...f, url_path: e.target.value }))} placeholder="/api/system/reboot" style={inp} />
        </div>
      </div>

      <div>
        <label style={lbl}>Action Name *</label>
        <input value={form.name ?? ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Reboot" style={inp} />
      </div>

      <div>
        <label style={lbl}>Description</label>
        <input value={form.description ?? ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What does this action do?" style={inp} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <label style={lbl}>Content-Type</label>
          <select value={form.content_type} onChange={e => setForm(f => ({ ...f, content_type: e.target.value }))} style={inp}>
            <option value="application/json">application/json</option>
            <option value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</option>
            <option value="text/plain">text/plain</option>
            <option value="multipart/form-data">multipart/form-data</option>
          </select>
        </div>
        <div>
          <label style={lbl}>Timeout (ms)</label>
          <input type="number" value={form.timeout_ms} onChange={e => setForm(f => ({ ...f, timeout_ms: Number(e.target.value) }))} min={1000} max={60000} step={1000} style={inp} />
        </div>
      </div>

      {/* Body */}
      {!['GET','DELETE'].includes(form.method ?? '') && (
        <div>
          <label style={lbl}>Request Body</label>
          <textarea value={form.body ?? ''} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            placeholder={'{\n  "confirm": true\n}'} rows={4}
            style={{ ...inp, fontFamily: 'monospace', resize: 'vertical' }} />
        </div>
      )}

      {/* Custom headers */}
      <div>
        <label style={lbl}>Custom Headers</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
          <input value={headerKey} onChange={e => setHeaderKey(e.target.value)} placeholder="X-API-Key" style={{ ...inp, flex: 1 }} />
          <input value={headerVal} onChange={e => setHeaderVal(e.target.value)} placeholder="value" style={{ ...inp, flex: 1 }} />
          <button type="button" onClick={() => {
            if (!headerKey.trim()) return
            setForm(f => ({ ...f, headers: { ...(f.headers ?? {}), [headerKey.trim()]: headerVal } }))
            setHeaderKey(''); setHeaderVal('')
          }} style={{ padding: '5px 10px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>+ Add</button>
        </div>
        {Object.entries(form.headers ?? {}).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '3px 6px', background: 'var(--bg-body)', borderRadius: 4, marginBottom: 3 }}>
            <code style={{ color: 'var(--accent-hex)', flex: '0 0 auto' }}>{k}</code>
            <span style={{ color: 'var(--text-muted)' }}>:</span>
            <span style={{ flex: 1, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
            <button onClick={() => setForm(f => { const h = { ...(f.headers ?? {}) }; delete h[k]; return { ...f, headers: h } })}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '0 2px' }}>✕</button>
          </div>
        ))}
      </div>

      {/* Auth */}
      <div>
        <label style={lbl}>Authentication</label>
        <select value={form.auth_type} onChange={e => setForm(f => ({ ...f, auth_type: e.target.value as AuthType }))} style={inp}>
          <option value="none">None</option>
          <option value="basic">Basic Auth (username + password)</option>
          <option value="bearer">Bearer Token</option>
          <option value="vault">From Vault (basic auth)</option>
        </select>
      </div>

      {form.auth_type === 'basic' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div><label style={lbl}>Username</label><input value={form.auth_username ?? ''} onChange={e => setForm(f => ({ ...f, auth_username: e.target.value }))} style={inp} /></div>
          <div><label style={lbl}>Password {editing ? '(blank = keep)' : ''}</label><input type="password" value={(form as any).auth_password ?? ''} onChange={e => setForm(f => ({ ...f, auth_password: e.target.value } as any))} style={inp} /></div>
        </div>
      )}
      {form.auth_type === 'bearer' && (
        <div><label style={lbl}>Token {editing ? '(blank = keep)' : ''}</label><input type="password" value={(form as any).auth_password ?? ''} onChange={e => setForm(f => ({ ...f, auth_password: e.target.value } as any))} placeholder="Bearer token" style={inp} /></div>
      )}
      {(form.auth_type === 'vault' || form.auth_type === 'basic') && (
        <div>
          <label style={lbl}>Vault Entry (optional — credentials from vault)</label>
          <select value={form.vault_id ?? ''} onChange={e => setForm(f => ({ ...f, vault_id: e.target.value || null }))} style={inp}>
            <option value="">— Manual credentials above —</option>
            {vaultEntries.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}
          </select>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" id="followRedir" checked={form.follow_redirects} onChange={e => setForm(f => ({ ...f, follow_redirects: e.target.checked }))} />
        <label htmlFor="followRedir" style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>Follow redirects</label>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
        <button onClick={() => setShowForm(false)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
        <button onClick={saveForm} disabled={saving} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>{saving ? 'Saving…' : (editing ? 'Save Changes' : 'Create Action')}</button>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>
          HTTP requests sent from the server to <code style={{ color: 'var(--accent-hex)' }}>{device.web_url || '(no web URL set)'}</code>
        </span>
        <button onClick={() => openCreate()} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>+ New Action</button>
      </div>

      {/* Templates */}
      {actions.length === 0 && !loading && (
        <div style={{ background: 'var(--bg-body)', border: '1px dashed var(--border-med)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>Quick-start templates:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {BUILT_IN_TEMPLATES.map(t => (
              <button key={t.name} onClick={() => openCreate(t)}
                style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--bg-input)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action list */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '12px 0' }}>Loading…</div>
      ) : actions.length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {actions.map(a => (
            <div key={a.id} style={{ background: 'var(--bg-body)', border: '1px solid var(--border-med)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Method badge */}
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: `${METHOD_COLORS[a.method]}20`, color: METHOD_COLORS[a.method], flexShrink: 0 }}>
                  {a.method}
                </span>
                <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-heading)', flex: 1 }}>{a.name}</span>
                {a.vault_id && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--accent-hex)20', color: 'var(--accent-hex)' }}>🔐 vault</span>}
                {/* Execute */}
                <button onClick={() => execute(a)} disabled={running[a.id]} style={{ padding: '4px 10px', borderRadius: 5, border: 'none', background: running[a.id] ? 'var(--bg-input)' : '#10b981', color: running[a.id] ? 'var(--text-muted)' : '#fff', cursor: running[a.id] ? 'default' : 'pointer', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                  {running[a.id] ? '…' : '▶ Run'}
                </button>
                <button onClick={() => openEdit(a)} style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>Edit</button>
                <button onClick={() => deleteAction(a)} style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid rgba(239,68,68,0.3)', background: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11 }}>Del</button>
              </div>

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, paddingLeft: 2 }}>
                <code style={{ fontSize: 10 }}>{a.url_path}</code>
                {a.description && <span style={{ marginLeft: 8 }}>— {a.description}</span>}
              </div>

              {/* Result panel */}
              {showResult === a.id && results[a.id] && (
                <div style={{ marginTop: 8, borderTop: '1px solid var(--border-weak)', paddingTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: results[a.id].ok ? '#10b981' : '#ef4444' }}>
                      {results[a.id].ok ? '✓' : '✗'} {results[a.id].status ? `HTTP ${results[a.id].status} ${results[a.id].status_text}` : results[a.id].error}
                    </span>
                    {results[a.id].duration_ms !== undefined && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{results[a.id].duration_ms}ms</span>
                    )}
                    <button onClick={() => setShowResult(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>✕</button>
                  </div>
                  {results[a.id].response && (
                    <pre style={{ fontSize: 10, color: 'var(--text-secondary)', background: 'var(--bg-card)', borderRadius: 5, padding: '6px 8px', overflowX: 'auto', maxHeight: 120, margin: 0 }}>
                      {(() => { try { return JSON.stringify(JSON.parse(results[a.id].response!), null, 2) } catch { return results[a.id].response } })()}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Templates when there are already some actions */}
      {actions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 2 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>Templates:</span>
          {BUILT_IN_TEMPLATES.map(t => (
            <button key={t.name} onClick={() => openCreate(t)}
              style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--border-weak)', background: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
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
  mode?: 'access' | 'trunk' | 'unknown'
  stp_state?: string | null
  edge_port?: boolean | null
  dot1x?: string | null
  neighbor?: { chassis: string; port_id: string; sys_name: string; sys_desc: string } | null
}

interface RadiusServer {
  id: string
  name: string
  description?: string | null
  host: string
  auth_port: number
  acct_port: number
  secret: string
  timeout: number
  retries: number
}

function ModeBadge({ mode }: { mode?: 'access' | 'trunk' | 'unknown' }) {
  if (!mode || mode === 'unknown') return <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>—</span>
  const isT = mode === 'trunk'
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.03em', borderRadius: 4, padding: '1px 6px',
      background: isT ? 'rgba(251,191,36,0.12)' : 'rgba(52,211,153,0.1)',
      border: `1px solid ${isT ? 'rgba(251,191,36,0.4)' : 'rgba(52,211,153,0.35)'}`,
      color: isT ? '#fbbf24' : '#34d399' }}>
      {isT ? 'TRUNK' : 'ACCESS'}
    </span>
  )
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

type PortAction = 'description' | 'vlan' | 'mode' | 'portfast'

function PortsTab({ devices }: { devices: Server[] }) {
  const snmpDevices = devices.filter(d => d.snmp_enabled)
  const [selectedId, setSelectedId] = useState<string>(snmpDevices[0]?.id ?? '')
  const [ports, setPorts] = useState<SnmpPort[] | null>(null)
  const [fetching, setFetching] = useState(false)
  const pollAbortRef = useRef<AbortController | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'up' | 'down'>('all')
  const [search, setSearch] = useState('')
  // per-port SNMP toggle busy state
  const [toggling, setToggling] = useState<Record<number, boolean>>({})
  // range-select state
  const [checkedPorts, setCheckedPorts] = useState<Set<number>>(new Set())
  const [lastCheckedIdx, setLastCheckedIdx] = useState<number | null>(null)
  // action modal
  const [actionModal, setActionModal] = useState<PortAction | null>(null)
  const [actionInput, setActionInput] = useState('')
  const [actionRunning, setActionRunning] = useState(false)
  const [actionError, setActionError] = useState('')
  // extended mode-change fields
  const [modeTarget, setModeTarget] = useState<'access' | 'trunk'>('access')
  const [allowedVlans, setAllowedVlans] = useState('') // trunk: VLANs to tag e.g. "10,20,30"
  const [nativeVlan, setNativeVlan] = useState('1')    // trunk: native/untagged VLAN
  const [accessVlan, setAccessVlan] = useState('1')    // access: access VLAN
  const [vlanMode, setVlanMode] = useState<'tagged' | 'untagged'>('untagged')

  // VLANs discovered via SNMP
  type SnmpVlan = { id: string; server_id: string; vlan_id: number; name: string; description: string | null; discovered_at: string }
  type DiscoveredRadius = { id: string; server_id: string; radius_index: number; address: string; auth_port: number; access_requests: number; access_accepts: number; access_rejects: number }
  const [vlans, setVlans] = useState<SnmpVlan[]>([])
  const [showVlanPanel, setShowVlanPanel] = useState(false)
  const [vlanDescEdit, setVlanDescEdit] = useState<Record<number, string>>({})
  const [vlanNameEdit, setVlanNameEdit] = useState<Record<number, string>>({})
  const [vlanSaving, setVlanSaving] = useState<number | null>(null)
  const [vlanSelected, setVlanSelected] = useState<Set<number>>(new Set())
  const [vlanCopied, setVlanCopied] = useState(false)
  const [vlanAddForm, setVlanAddForm] = useState({ vlan_id: '', name: '', description: '' })
  const [vlanAdding, setVlanAdding] = useState(false)
  const [vlanAddError, setVlanAddError] = useState('')
  const [discoveredRadius, setDiscoveredRadius] = useState<DiscoveredRadius[]>([])

  // RADIUS management
  const [radiusServers, setRadiusServers] = useState<RadiusServer[]>([])
  const [showRadiusPanel, setShowRadiusPanel] = useState(false)
  const [radiusModal, setRadiusModal] = useState<'new' | 'edit' | 'push' | null>(null)
  const [editingRadius, setEditingRadius] = useState<RadiusServer | null>(null)
  const [radiusForm, setRadiusForm] = useState({ name: '', description: '', host: '', auth_port: 1812, acct_port: 1813, secret: '', timeout: 5, retries: 2 })
  const [radiusSelected, setRadiusSelected] = useState<Set<string>>(new Set())
  const [radiusSaving, setRadiusSaving] = useState(false)
  const [radiusPushing, setRadiusPushing] = useState(false)
  const [radiusError, setRadiusError] = useState('')
  // 802.1X port push
  const [dot1xPushing, setDot1xPushing] = useState(false)
  // Authenticated hosts panel per port
  const [dot1xHosts, setDot1xHosts] = useState<Record<number, { mac: string; status: string }[]>>({})
  const [loadingHosts, setLoadingHosts] = useState<number | null>(null)

  useEffect(() => {
    api.get<RadiusServer[]>('/radius-servers').then(setRadiusServers).catch(() => {})
  }, [])

  const { requestElevation } = useTotpElevation()

  const selected = devices.find(d => d.id === selectedId)
  const hasSsh = !!selected?.access_ssh_enabled

  // Mixed-mode detection — computed from currently checked ports
  const selModes = new Set(
    [...checkedPorts].map(idx => ports?.find(p => p.index === idx)?.mode ?? 'unknown')
  )
  const hasMixedModes = selModes.has('access') && selModes.has('trunk')
  const allSameMode = !hasMixedModes && (selModes.size === 1 && !selModes.has('unknown'))

  // Clear selection when device changes
  useEffect(() => { setCheckedPorts(new Set()); setLastCheckedIdx(null) }, [selectedId])

  // Checkbox with shift-click range support
  const handleCheck = (p: SnmpPort, rowIdx: number, shiftKey: boolean) => {
    if (shiftKey && lastCheckedIdx !== null) {
      const lo = Math.min(lastCheckedIdx, rowIdx)
      const hi = Math.max(lastCheckedIdx, rowIdx)
      setCheckedPorts(prev => {
        const next = new Set(prev)
        filtered.slice(lo, hi + 1).forEach(x => next.add(x.index))
        return next
      })
    } else {
      setCheckedPorts(prev => {
        const next = new Set(prev)
        if (next.has(p.index)) next.delete(p.index)
        else next.add(p.index)
        return next
      })
      setLastCheckedIdx(rowIdx)
    }
  }

  const toggleAllVisible = () => {
    const allChecked = filtered.every(p => checkedPorts.has(p.index))
    if (allChecked) {
      setCheckedPorts(prev => { const n = new Set(prev); filtered.forEach(p => n.delete(p.index)); return n })
    } else {
      setCheckedPorts(prev => { const n = new Set(prev); filtered.forEach(p => n.add(p.index)); return n })
    }
  }

  // Bulk SNMP enable/disable
  const bulkAdmin = async (adminUp: boolean) => {
    const targets = [...checkedPorts]
    try { await requestElevation('network_port_shutdown') } catch { return }
    const busy: Record<number, boolean> = {}
    targets.forEach(i => { busy[i] = true })
    setToggling(t => ({ ...t, ...busy }))
    setError('')
    await Promise.allSettled(targets.map(async ifIndex => {
      try {
        await api.post(`/servers/${selectedId}/snmp-port-admin`, { ifIndex, adminUp })
        setPorts(prev => prev ? prev.map(x => x.index === ifIndex ? { ...x, admin_up: adminUp } : x) : prev)
      } catch {}
    }))
    setToggling(t => { const n = { ...t }; targets.forEach(i => delete n[i]); return n })
  }

  // SSH port-cli action
  const runPortCli = async (action: PortAction, params: Record<string, unknown>) => {
    if (!selectedId) return
    setActionRunning(true); setActionError('')
    try { await requestElevation('network_port_config') } catch { setActionRunning(false); return }
    const portsArg = [...checkedPorts].map(idx => {
      const p = (ports ?? []).find(x => x.index === idx)
      return { ifIndex: idx, ifName: p?.name ?? `ifIndex${idx}` }
    })
    try {
      await api.post<any>(`/servers/${selectedId}/port-cli`, { ports: portsArg, action, params })
      // Optimistic local state update
      if (action === 'description') setPorts(prev => prev ? prev.map(x => checkedPorts.has(x.index) ? { ...x, alias: params.description as string } : x) : prev)
      setCheckedPorts(new Set()); setActionModal(null); setActionInput('')
      setModeTarget('access'); setAllowedVlans(''); setNativeVlan('1'); setAccessVlan('1'); setVlanMode('untagged')
    } catch (e: any) {
      setActionError(e?.data?.error ?? e?.message ?? 'CLI action failed')
    } finally { setActionRunning(false) }
  }

  // Single-port SNMP toggle (from row button)
  const togglePort = async (p: SnmpPort) => {
    if (!selectedId || toggling[p.index]) return
    try { await requestElevation('network_port_shutdown') } catch { return }
    setToggling(t => ({ ...t, [p.index]: true }))
    try {
      await api.post(`/servers/${selectedId}/snmp-port-admin`, { ifIndex: p.index, adminUp: !p.admin_up })
      setPorts(prev => prev ? prev.map(x => x.index === p.index ? { ...x, admin_up: !p.admin_up } : x) : prev)
    } catch (e: any) {
      setError(e?.data?.error ?? e?.message ?? 'Toggle failed')
    } finally { setToggling(t => { const n = { ...t }; delete n[p.index]; return n }) }
  }

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
    api.get<SnmpVlan[]>(`/servers/${selectedId}/snmp-vlans`).then(setVlans).catch(() => {})
    api.get<DiscoveredRadius[]>(`/servers/${selectedId}/snmp-discovered-radius`).then(setDiscoveredRadius).catch(() => {})
  }, [selectedId])

  const pollPorts = async () => {
    if (!selectedId) return
    const abort = new AbortController()
    pollAbortRef.current = abort
    setFetching(true); setError('')
    try {
      const r = await api.post<{ ok: boolean; fetched_at: string; ports: SnmpPort[]; vlans?: SnmpVlan[]; discovered_radius?: DiscoveredRadius[] }>(`/servers/${selectedId}/snmp-ports`, undefined, abort.signal)
      setPorts(r.ports)
      setFetchedAt(r.fetched_at)
      if (r.vlans) setVlans(r.vlans)
      if (r.discovered_radius) setDiscoveredRadius(r.discovered_radius)
    } catch (e: any) {
      if ((e as any)?.name === 'AbortError') return
      setError(e?.data?.error ?? e?.message ?? 'Port poll failed')
    } finally {
      pollAbortRef.current = null
      setFetching(false)
    }
  }

  const stopPoll = () => {
    pollAbortRef.current?.abort()
    pollAbortRef.current = null
    setFetching(false)
  }

  const saveVlan = async (vlanId: number) => {
    if (!selectedId) return
    setVlanSaving(vlanId)
    try {
      const patch: any = {}
      if (vlanDescEdit[vlanId] !== undefined) patch.description = vlanDescEdit[vlanId]
      if (vlanNameEdit[vlanId] !== undefined) patch.name = vlanNameEdit[vlanId]
      await api.patch(`/servers/${selectedId}/snmp-vlans/${vlanId}`, patch)
      setVlans(prev => prev.map(v => v.vlan_id === vlanId ? { ...v, ...patch } : v))
      setVlanDescEdit(prev => { const n = { ...prev }; delete n[vlanId]; return n })
      setVlanNameEdit(prev => { const n = { ...prev }; delete n[vlanId]; return n })
    } finally { setVlanSaving(null) }
  }

  const addVlan = async () => {
    if (!selectedId || !vlanAddForm.vlan_id) return
    setVlanAdding(true); setVlanAddError('')
    try {
      const row = await api.post<SnmpVlan>(`/servers/${selectedId}/snmp-vlans`, {
        vlan_id: parseInt(vlanAddForm.vlan_id, 10),
        name: vlanAddForm.name,
        description: vlanAddForm.description || undefined,
      })
      setVlans(prev => {
        const filtered = prev.filter(v => v.vlan_id !== row.vlan_id)
        return [...filtered, row].sort((a, b) => a.vlan_id - b.vlan_id)
      })
      setVlanAddForm({ vlan_id: '', name: '', description: '' })
    } catch (e: any) {
      setVlanAddError(e?.data?.error ?? e?.message ?? 'Failed to add VLAN')
    } finally { setVlanAdding(false) }
  }

  const deleteVlan = async (vlanId: number) => {
    if (!selectedId || !confirm(`Remove VLAN ${vlanId} from the list?`)) return
    await api.delete(`/servers/${selectedId}/snmp-vlans/${vlanId}`)
    setVlans(prev => prev.filter(v => v.vlan_id !== vlanId))
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

        {fetching && (
          <button
            onClick={stopPoll}
            style={{ padding: '7px 12px', borderRadius: 7, border: '1px solid rgba(239,68,68,0.5)', background: 'rgba(239,68,68,0.1)', color: '#ef4444', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
          >
            ✕ Stop
          </button>
        )}

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
                {ports.map((p, stripIdx) => {
                  const isChecked = checkedPorts.has(p.index)
                  const isTrunk = p.mode === 'trunk'
                  return (
                    <div
                      key={p.index}
                      title={`${p.name}${p.alias ? ` — ${p.alias}` : ''}\n${p.mode ? p.mode.toUpperCase() : ''} · ${p.oper_up ? 'Up' : 'Down'} · ${speedLabel(p.speed_mbps)}${p.pvid ? ` · VLAN ${p.pvid}` : ''}`}
                      onClick={e => {
                        const portsCopy = ports
                        if (e.shiftKey && lastCheckedIdx !== null) {
                          // Find range in ports array (strip uses full ports, not filtered)
                          const stripIndexes = portsCopy.map(x => x.index)
                          const a = stripIndexes.indexOf(ports[lastCheckedIdx]?.index ?? -1)
                          const b = stripIdx
                          const lo = Math.min(a === -1 ? b : a, b)
                          const hi = Math.max(a === -1 ? b : a, b)
                          setCheckedPorts(prev => {
                            const n = new Set(prev)
                            portsCopy.slice(lo, hi + 1).forEach(x => n.add(x.index))
                            return n
                          })
                        } else {
                          setCheckedPorts(prev => { const n = new Set(prev); if (n.has(p.index)) n.delete(p.index); else n.add(p.index); return n })
                          setLastCheckedIdx(stripIdx)
                        }
                      }}
                      style={{
                        width: 20, height: 20, borderRadius: isTrunk ? 10 : 3,
                        background: isChecked ? 'rgba(99,102,241,0.4)' : p.oper_up ? (isTrunk ? 'rgba(251,191,36,0.15)' : 'rgba(52,211,153,0.2)') : 'rgba(75,85,99,0.25)',
                        border: `1px solid ${isChecked ? '#818cf8' : p.oper_up ? (isTrunk ? 'rgba(251,191,36,0.6)' : 'rgba(52,211,153,0.55)') : 'rgba(75,85,99,0.45)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', flexShrink: 0,
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: isTrunk ? 3 : 1, background: isChecked ? '#818cf8' : p.oper_up ? (isTrunk ? '#fbbf24' : '#3fb950') : '#4b5563' }} />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Table */}
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1060, borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 36 }} />   {/* checkbox */}
              <col style={{ width: 34 }} />   {/* # */}
              <col style={{ width: 82 }} />   {/* port */}
              <col style={{ width: 175 }} />  {/* description */}
              <col style={{ width: 125 }} />  {/* mac */}
              <col style={{ width: 74 }} />   {/* mode */}
              <col style={{ width: 84 }} />   {/* status */}
              <col style={{ width: 52 }} />   {/* speed */}
              <col style={{ width: 58 }} />   {/* vlan */}
              <col style={{ width: 106 }} />  {/* stp */}
              <col style={{ width: 120 }} />  {/* 802.1x */}
              <col style={{ width: 170 }} />  {/* neighbor */}
              <col style={{ width: 90 }} />   {/* action — enough for "Disable" */}
            </colgroup>
            <thead>
              <tr style={{ background: 'var(--bg-table-header)', borderBottom: '2px solid var(--border-med)' }}>
                <th style={{ padding: '8px 0 8px 12px' }}>
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every(p => checkedPorts.has(p.index))}
                    ref={el => { if (el) el.indeterminate = filtered.some(p => checkedPorts.has(p.index)) && !filtered.every(p => checkedPorts.has(p.index)) }}
                    onChange={toggleAllVisible}
                    title="Select all visible ports"
                  />
                </th>
                {[
                  ['#', 'left'],
                  ['Port', 'left'],
                  ['Description / Alias', 'left'],
                  ['MAC', 'left'],
                  ['Mode', 'center'],
                  ['Status', 'center'],
                  ['Speed', 'center'],
                  ['VLAN', 'center'],
                  ['STP', 'left'],
                  ['802.1X', 'left'],
                  ['Neighbor', 'left'],
                  ['', 'right'],
                ].map(([h, align]) => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: align as any, fontWeight: 600, fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr
                  key={p.index}
                  style={{
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--border-weak)' : 'none',
                    background: checkedPorts.has(p.index) ? 'rgba(99,102,241,0.06)' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                >
                  {/* Checkbox */}
                  <td style={{ padding: '10px 0 10px 12px', verticalAlign: 'middle' }}>
                    <input
                      type="checkbox"
                      checked={checkedPorts.has(p.index)}
                      onChange={() => {}}
                      onClick={e => { e.stopPropagation(); handleCheck(p, i, (e as React.MouseEvent).shiftKey) }}
                    />
                  </td>
                  {/* # */}
                  <td style={{ padding: '10px 6px', color: 'var(--text-muted)', fontSize: 10, textAlign: 'left', verticalAlign: 'middle' }}>{p.index}</td>
                  {/* Port name */}
                  <td style={{ padding: '10px 10px', verticalAlign: 'middle' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{p.name}</span>
                  </td>
                  {/* Description / Alias */}
                  <td style={{ padding: '10px 10px', verticalAlign: 'middle', overflow: 'hidden' }}>
                    {p.descr && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.descr}>{p.descr}</div>
                    )}
                    {p.alias && p.alias !== p.descr && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.alias}>
                        <span style={{ opacity: 0.5, marginRight: 3 }}>↪</span>{p.alias}
                      </div>
                    )}
                  </td>
                  {/* MAC */}
                  <td style={{ padding: '10px 10px', verticalAlign: 'middle', overflow: 'hidden' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.02em' }} title={p.mac || undefined}>
                      {p.mac || '—'}
                    </span>
                  </td>
                  {/* Mode */}
                  <td style={{ padding: '10px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                    <ModeBadge mode={p.mode} />
                  </td>
                  {/* Status: Admin + Link stacked */}
                  <td style={{ padding: '10px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: p.oper_up ? '#3fb950' : '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <PortStatusDot up={p.oper_up} />
                        {p.oper_up ? 'Up' : 'Down'}
                      </span>
                      <span style={{ fontSize: 9, color: p.admin_up ? 'var(--text-muted)' : '#f87171' }}>
                        {p.admin_up ? 'admin on' : 'admin off'}
                      </span>
                    </div>
                  </td>
                  {/* Speed */}
                  <td style={{ padding: '10px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', fontWeight: 600 }}>{speedLabel(p.speed_mbps)}</span>
                  </td>
                  {/* VLAN */}
                  <td style={{ padding: '10px 10px', textAlign: 'center', verticalAlign: 'middle' }}>
                    {p.pvid ? (() => {
                      const vlan = vlans.find(v => v.vlan_id === p.pvid)
                      return (
                        <div title={vlan?.description ? `${vlan.name}${vlan.description ? ` — ${vlan.description}` : ''}` : vlan?.name ?? ''}>
                          <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 4, padding: '2px 6px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8', whiteSpace: 'nowrap' }}>
                            {p.pvid}
                          </span>
                          {vlan?.name && (
                            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vlan.name}</div>
                          )}
                        </div>
                      )
                    })() : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                  </td>
                  {/* STP */}
                  <td style={{ padding: '10px 10px', verticalAlign: 'middle' }}>
                    {p.stp_state ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, color: p.stp_state === 'forwarding' ? '#34d399' : p.stp_state === 'blocking' ? '#f87171' : 'var(--text-muted)' }}>
                          {p.stp_state}
                        </span>
                        {p.edge_port && <span style={{ fontSize: 9, color: '#fbbf24' }}>⚡ edge</span>}
                      </div>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                  </td>
                  {/* 802.1X */}
                  <td style={{ padding: '10px 10px', verticalAlign: 'middle' }}>
                    {p.dot1x ? (
                      <div>
                        <span style={{ fontSize: 10, fontWeight: 600, color: p.dot1x === 'auto' ? '#fbbf24' : p.dot1x === 'force-authorized' ? '#34d399' : '#f87171' }}>
                          {p.dot1x === 'force-authorized' ? 'authorized' : p.dot1x === 'force-unauthorized' ? 'unauthorized' : p.dot1x}
                        </span>
                        {p.dot1x === 'auto' && discoveredRadius.length === 0 && (
                          <span title="802.1X enabled but no RADIUS server detected on this device" style={{ marginLeft: 4, fontSize: 10, color: '#fbbf24', cursor: 'default' }}>⚠</span>
                        )}
                        {p.dot1x === 'auto' && (
                          <button
                            onClick={async () => {
                              setLoadingHosts(p.index)
                              try {
                                const r = await api.get<{ hosts: { mac: string; status: string }[] }>(`/servers/${selectedId}/dot1x-hosts/${p.index}`)
                                setDot1xHosts(prev => ({ ...prev, [p.index]: r.hosts }))
                              } catch {}
                              setLoadingHosts(null)
                            }}
                            style={{ marginLeft: 5, fontSize: 9, padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
                          >
                            {loadingHosts === p.index ? '…' : 'hosts'}
                          </button>
                        )}
                        {dot1xHosts[p.index]?.length > 0 && (
                          <div style={{ marginTop: 3 }}>
                            {dot1xHosts[p.index].map(h => (
                              <div key={h.mac} style={{ fontSize: 9, fontFamily: 'monospace', color: '#34d399' }}>{h.mac}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                  </td>
                  {/* Neighbor */}
                  <td style={{ padding: '10px 10px', verticalAlign: 'middle', overflow: 'hidden' }}>
                    {p.neighbor?.sys_name ? (
                      <div title={`${p.neighbor.sys_name}\n${p.neighbor.sys_desc ?? ''}\nPort: ${p.neighbor.port_id}\nMAC: ${p.neighbor.chassis}`} style={{ cursor: 'help' }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          🔗 {p.neighbor.sys_name}
                        </div>
                        {p.neighbor.port_id && (
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                            {p.neighbor.port_id}
                          </div>
                        )}
                      </div>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                  </td>
                  {/* Action */}
                  <td style={{ padding: '10px 10px', textAlign: 'right', verticalAlign: 'middle' }}>
                    <button
                      onClick={() => togglePort(p)}
                      disabled={!!toggling[p.index]}
                      title={p.admin_up ? 'Disable port (SNMP SET)' : 'Enable port (SNMP SET)'}
                      style={{ fontSize: 10, padding: '3px 9px', borderRadius: 4, border: `1px solid ${p.admin_up ? 'rgba(248,113,113,0.4)' : 'rgba(52,211,153,0.4)'}`, background: p.admin_up ? 'rgba(248,113,113,0.08)' : 'rgba(52,211,153,0.08)', color: p.admin_up ? '#f87171' : '#34d399', cursor: toggling[p.index] ? 'default' : 'pointer', opacity: toggling[p.index] ? 0.6 : 1, fontWeight: 600, whiteSpace: 'nowrap' }}
                    >
                      {toggling[p.index] ? '…' : p.admin_up ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* ── Bulk action toolbar — floats when ports are selected ── */}
      {checkedPorts.size > 0 && (
        <div style={{ position: 'sticky', bottom: 16, marginTop: 12, borderRadius: 10, background: 'var(--card-bg)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: `1px solid ${hasMixedModes ? 'rgba(251,191,36,0.5)' : 'var(--border-med)'}`, boxShadow: '0 8px 32px rgba(0,0,0,0.55)', overflow: 'hidden' }}>

          {/* Mixed-mode warning banner */}
          {hasMixedModes && (
            <div style={{ padding: '7px 16px', background: 'rgba(251,191,36,0.1)', borderBottom: '1px solid rgba(251,191,36,0.3)', fontSize: 12, color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700 }}>⚠ Mixed port modes selected</span>
              <span style={{ color: 'var(--text-muted)' }}>—</span>
              <span>Your selection contains both ACCESS and TRUNK ports. VLAN, Mode, and PortFast actions require a uniform mode selection. Deselect one type to continue, or use Enable/Disable which works on all modes.</span>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 16px' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-hex)', marginRight: 4 }}>
              {checkedPorts.size} port{checkedPorts.size > 1 ? 's' : ''} selected
              {allSameMode && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>({[...selModes][0]})</span>}
            </span>
            <span style={{ width: 1, height: 18, background: 'var(--border-med)' }} />

            {/* SNMP — always available regardless of mode */}
            <button onClick={() => bulkAdmin(true)}  style={tbBtn('#34d399', 'rgba(52,211,153,0.15)', 'rgba(52,211,153,0.35)')}>✓ Enable</button>
            <button onClick={() => bulkAdmin(false)} style={tbBtn('#f87171', 'rgba(248,113,113,0.12)', 'rgba(248,113,113,0.35)')}>✕ Disable</button>

            {/* SSH CLI actions — only when device has SSH; blocked when mixed modes */}
            {hasSsh && <>
              <span style={{ width: 1, height: 18, background: 'var(--border-med)' }} />
              <button
                onClick={() => { setActionModal('description'); setActionInput('') }}
                style={tbBtn('#60a5fa', 'rgba(96,165,250,0.12)', 'rgba(96,165,250,0.35)')}>
                ✎ Description
              </button>
              <button
                onClick={() => !hasMixedModes && (setActionModal('vlan'), setActionInput(''))}
                disabled={hasMixedModes}
                title={hasMixedModes ? 'Deselect mixed port modes first' : undefined}
                style={{ ...tbBtn('#a78bfa', 'rgba(167,139,250,0.12)', 'rgba(167,139,250,0.35)'), opacity: hasMixedModes ? 0.4 : 1, cursor: hasMixedModes ? 'not-allowed' : 'pointer' }}>
                🏷 VLAN
              </button>
              <button
                onClick={() => { if (hasMixedModes) return; const cur = [...selModes][0] as 'access'|'trunk'|'unknown'; setModeTarget(cur === 'trunk' ? 'access' : 'trunk'); setAllowedVlans(''); setNativeVlan('1'); setAccessVlan('1'); setActionModal('mode') }}
                disabled={hasMixedModes}
                title={hasMixedModes ? 'Deselect mixed port modes first' : undefined}
                style={{ ...tbBtn('#fbbf24', 'rgba(251,191,36,0.12)', 'rgba(251,191,36,0.35)'), opacity: hasMixedModes ? 0.4 : 1, cursor: hasMixedModes ? 'not-allowed' : 'pointer' }}>
                ⇄ Mode
              </button>
              <button
                onClick={() => { if (hasMixedModes) return; const curMode = [...selModes][0] as string; runPortCli('portfast', { enabled: true, currentMode: curMode }) }}
                disabled={hasMixedModes}
                title={hasMixedModes ? 'Deselect mixed port modes first' : undefined}
                style={{ ...tbBtn('#34d399', 'rgba(52,211,153,0.12)', 'rgba(52,211,153,0.25)'), opacity: hasMixedModes ? 0.4 : 1, cursor: hasMixedModes ? 'not-allowed' : 'pointer' }}>
                ⚡ Edge On
              </button>
              <button
                onClick={() => { if (hasMixedModes) return; const curMode = [...selModes][0] as string; runPortCli('portfast', { enabled: false, currentMode: curMode }) }}
                disabled={hasMixedModes}
                title={hasMixedModes ? 'Deselect mixed port modes first' : undefined}
                style={{ ...tbBtn('#9ca3af', 'rgba(156,163,175,0.12)', 'rgba(156,163,175,0.3)'), opacity: hasMixedModes ? 0.4 : 1, cursor: hasMixedModes ? 'not-allowed' : 'pointer' }}>
                ⚡ Edge Off
              </button>
              <span style={{ width: 1, height: 18, background: 'var(--border-med)' }} />
              {/* 802.1X port control */}
              <button
                disabled={dot1xPushing}
                onClick={async () => {
                  if (!selectedId) return
                  const ifNames = [...checkedPorts].map(idx => ports?.find(p => p.index === idx)?.name).filter(Boolean) as string[]
                  setDot1xPushing(true)
                  try {
                    await requestElevation('network_config_push')
                    await api.post(`/servers/${selectedId}/push-dot1x-ports`, { if_names: ifNames, enabled: true })
                  } catch {}
                  setDot1xPushing(false)
                }}
                style={{ ...tbBtn('#f97316', 'rgba(249,115,22,0.12)', 'rgba(249,115,22,0.35)'), opacity: dot1xPushing ? 0.6 : 1 }}>
                🔐 802.1X On
              </button>
              <button
                disabled={dot1xPushing}
                onClick={async () => {
                  if (!selectedId) return
                  const ifNames = [...checkedPorts].map(idx => ports?.find(p => p.index === idx)?.name).filter(Boolean) as string[]
                  setDot1xPushing(true)
                  try {
                    await requestElevation('network_config_push')
                    await api.post(`/servers/${selectedId}/push-dot1x-ports`, { if_names: ifNames, enabled: false })
                  } catch {}
                  setDot1xPushing(false)
                }}
                style={{ ...tbBtn('#6b7280', 'rgba(107,114,128,0.12)', 'rgba(107,114,128,0.35)'), opacity: dot1xPushing ? 0.6 : 1 }}>
                🔓 802.1X Off
              </button>
            </>}

            <div style={{ flex: 1 }} />
            <button onClick={() => setCheckedPorts(new Set())} style={tbBtn('var(--text-muted)', 'transparent', 'var(--border-weak)')}>✕ Clear</button>
          </div>
        </div>
      )}

      {/* ── Port action modal (description / vlan / mode) ── */}
      {actionModal && (
        <Modal title="" onClose={() => { setActionModal(null); setActionError('') }}>
          <div style={{ padding: '24px 28px', minWidth: 340 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>
              {actionModal === 'description' ? '✎ Set Port Description' : actionModal === 'vlan' ? '🏷 Set VLAN' : '⇄ Set Port Mode'}
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                {checkedPorts.size} port{checkedPorts.size > 1 ? 's' : ''}
              </span>
            </h3>

            {actionModal === 'description' && (
              <>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Description / alias</label>
                <input
                  autoFocus value={actionInput} onChange={e => setActionInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && actionInput.trim() && runPortCli('description', { description: actionInput.trim() })}
                  placeholder="e.g. Uplink to Core SW"
                  style={{ ...inp, width: '100%' }}
                />
              </>
            )}

            {actionModal === 'vlan' && (
              <>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>VLAN ID (1–4094)</label>
                <input
                  autoFocus type="number" min={1} max={4094} value={actionInput}
                  onChange={e => setActionInput(e.target.value)}
                  placeholder="e.g. 100"
                  style={{ ...inp, width: '100%' }}
                />
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', margin: '10px 0 6px' }}>Apply as</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['untagged', 'tagged'] as const).map(m => (
                    <button key={m} onClick={() => setVlanMode(m)}
                      style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: `1px solid ${vlanMode === m ? 'var(--accent-hex)' : 'var(--border-med)'}`, background: vlanMode === m ? 'var(--accent-hex)' : 'transparent', color: vlanMode === m ? '#fff' : 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {m === 'untagged' ? '📥 Untagged (access)' : '🏷 Tagged (trunk)'}
                    </button>
                  ))}
                </div>
              </>
            )}

            {actionModal === 'mode' && (
              <>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>Target mode</label>
                <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                  {(['access', 'trunk'] as const).map(m => (
                    <button key={m} onClick={() => setModeTarget(m)}
                      style={{ flex: 1, padding: '8px 0', borderRadius: 6, border: `1px solid ${modeTarget === m ? 'var(--accent-hex)' : 'var(--border-med)'}`, background: modeTarget === m ? 'var(--accent-hex)' : 'transparent', color: modeTarget === m ? '#fff' : 'var(--text-muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {m === 'access' ? '📥 Access' : '🔀 Trunk'}
                    </button>
                  ))}
                </div>

                {modeTarget === 'trunk' && (
                  <>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                      Allowed VLANs <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(comma-separated, or leave blank for all)</span>
                    </label>
                    <input value={allowedVlans} onChange={e => setAllowedVlans(e.target.value)}
                      placeholder="e.g. 10,20,30  or blank = all"
                      style={{ ...inp, width: '100%', marginBottom: 10 }} />
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Native VLAN</label>
                    <input type="number" min={1} max={4094} value={nativeVlan} onChange={e => setNativeVlan(e.target.value)}
                      style={{ ...inp, width: 90 }} />
                  </>
                )}

                {modeTarget === 'access' && (
                  <>
                    <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
                      Access VLAN <span style={{ color: '#f97316', fontWeight: 400, fontSize: 11 }}>⚠ Tagged VLANs will be removed first</span>
                    </label>
                    <input type="number" min={1} max={4094} value={accessVlan} onChange={e => setAccessVlan(e.target.value)}
                      style={{ ...inp, width: 90 }} />
                  </>
                )}
              </>
            )}

            {actionError && (
              <p style={{ margin: '10px 0 0', fontSize: 12, color: '#f87171' }}>{actionError}</p>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <button onClick={() => { setActionModal(null); setActionError('') }} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button
                disabled={actionRunning || (actionModal !== 'mode' && !actionInput.trim())}
                onClick={() => {
                  if (actionModal === 'description') runPortCli('description', { description: actionInput.trim() })
                  else if (actionModal === 'vlan') runPortCli('vlan', { vlan: +actionInput, vlanMode })
                  else if (actionModal === 'mode') runPortCli('mode', {
                    mode: modeTarget,
                    allowedVlans: allowedVlans || 'all',
                    nativeVlan,
                    accessVlan,
                    currentMode: [...selModes][0] ?? 'unknown',
                  })
                }}
                style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: actionRunning ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: actionRunning ? 0.65 : 1 }}
              >
                {actionRunning ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Bottom-right action buttons ── */}
      {selected && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 50, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <button
            onClick={() => setShowVlanPanel(v => !v)}
            style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.4)', background: 'rgba(99,102,241,0.15)', color: '#818cf8', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
            🏷 VLANs{vlans.length > 0 ? ` (${vlans.length})` : ''}
          </button>
          <button
            onClick={() => setShowRadiusPanel(v => !v)}
            style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid rgba(249,115,22,0.4)', background: discoveredRadius.length > 0 ? 'rgba(249,115,22,0.25)' : 'rgba(249,115,22,0.15)', color: '#f97316', fontWeight: 700, fontSize: 13, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
            🔐 RADIUS{discoveredRadius.length > 0 ? ` ✓` : ''}
          </button>
        </div>
      )}

      {/* ── RADIUS panel ── */}
      {showRadiusPanel && (
        <Modal title="" onClose={() => setShowRadiusPanel(false)}>
          <div style={{ padding: '24px 28px', minWidth: 500, maxWidth: 660 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>🔐 RADIUS Servers</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => { setRadiusForm({ name: '', description: '', host: '', auth_port: 1812, acct_port: 1813, secret: '', timeout: 5, retries: 2 }); setEditingRadius(null); setRadiusModal('new') }}
                  style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(99,102,241,0.4)', background: 'rgba(99,102,241,0.12)', color: '#818cf8', cursor: 'pointer', fontWeight: 600 }}>
                  + New Server
                </button>
                {radiusSelected.size > 0 && (
                  <button
                    onClick={() => setRadiusModal('push')}
                    style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(249,115,22,0.4)', background: 'rgba(249,115,22,0.12)', color: '#f97316', cursor: 'pointer', fontWeight: 600 }}>
                    Push to {selected?.name ?? 'device'} ({radiusSelected.size})
                  </button>
                )}
              </div>
            </div>

            {/* Discovered RADIUS servers from SNMP */}
            {discoveredRadius.length > 0 && (
              <div style={{ marginBottom: 20, padding: '12px 14px', borderRadius: 8, background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)' }}>
                <p style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  ✓ Detected on {selected?.name ?? 'device'} via SNMP
                </p>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(52,211,153,0.15)' }}>
                      {['Server IP', 'Port', 'Requests', 'Accepts', 'Rejects'].map(h => (
                        <th key={h} style={{ padding: '4px 8px', textAlign: 'left', fontWeight: 600, fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {discoveredRadius.map(r => (
                      <tr key={r.radius_index} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#34d399', fontWeight: 600 }}>{r.address}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{r.auth_port}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{r.access_requests.toLocaleString()}</td>
                        <td style={{ padding: '6px 8px', color: r.access_accepts > 0 ? '#34d399' : 'var(--text-muted)' }}>{r.access_accepts.toLocaleString()}</td>
                        <td style={{ padding: '6px 8px', color: r.access_rejects > 0 ? '#f87171' : 'var(--text-muted)' }}>{r.access_rejects.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {discoveredRadius.length === 0 && (ports ?? []).length > 0 && (
              <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', fontSize: 12, color: '#fbbf24' }}>
                ⚠ No RADIUS servers detected on this device via SNMP. Poll Ports to check.
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                📋 Saved Profiles
              </p>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Select profiles below then push to device</span>
            </div>
            {radiusServers.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No RADIUS servers configured. Add one to get started.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}></th>
                    {['Name', 'Host', 'Auth Port', 'Timeout', ''].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {radiusServers.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid var(--border-weak)' }}>
                      <td style={{ padding: '8px 10px' }}>
                        <input type="checkbox" checked={radiusSelected.has(r.id)}
                          onChange={e => setRadiusSelected(prev => { const s = new Set(prev); e.target.checked ? s.add(r.id) : s.delete(r.id); return s })} />
                      </td>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--text)' }}>{r.name}</td>
                      <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)' }}>{r.host}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{r.auth_port}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>{r.timeout}s</td>
                      <td style={{ padding: '8px 10px', display: 'flex', gap: 6 }}>
                        <button onClick={() => { setEditingRadius(r); setRadiusForm({ name: r.name, description: r.description ?? '', host: r.host, auth_port: r.auth_port, acct_port: r.acct_port, secret: r.secret, timeout: r.timeout, retries: r.retries }); setRadiusModal('edit') }}
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>Edit</button>
                        <button onClick={async () => { if (!confirm(`Delete "${r.name}"?`)) return; await api.delete(`/radius-servers/${r.id}`); setRadiusServers(prev => prev.filter(x => x.id !== r.id)) }}
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(248,113,113,0.3)', background: 'transparent', color: '#f87171', cursor: 'pointer' }}>Del</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Modal>
      )}

      {/* ── VLAN reference panel ── */}
      {showVlanPanel && (
        <Modal title="" onClose={() => setShowVlanPanel(false)}>
          <div style={{ padding: '20px 20px', minWidth: 520, maxWidth: 680, display: 'flex', flexDirection: 'column', maxHeight: '85vh', overflow: 'hidden' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700 }}>🏷 VLAN Reference — {selected?.name}</h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
              {vlans.length > 0 ? `${vlans.length} VLANs · ` : ''}Auto-discovered via SNMP on Poll Ports, or add manually. Names and descriptions help when assigning ports.
            </p>

            {/* Add VLAN form */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'flex-end', padding: '12px 14px', borderRadius: 8, background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>VLAN ID *</label>
                <input
                  type="number" min={1} max={4094} placeholder="e.g. 10"
                  value={vlanAddForm.vlan_id}
                  onChange={e => setVlanAddForm(p => ({ ...p, vlan_id: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addVlan() }}
                  style={{ width: 72, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Name</label>
                <input
                  type="text" placeholder="e.g. Management"
                  value={vlanAddForm.name}
                  onChange={e => setVlanAddForm(p => ({ ...p, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addVlan() }}
                  style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Description</label>
                <input
                  type="text" placeholder="e.g. Core network management"
                  value={vlanAddForm.description}
                  onChange={e => setVlanAddForm(p => ({ ...p, description: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addVlan() }}
                  style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13 }}
                />
              </div>
              <button
                onClick={addVlan} disabled={vlanAdding || !vlanAddForm.vlan_id}
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: vlanAdding || !vlanAddForm.vlan_id ? 'default' : 'pointer', opacity: vlanAdding || !vlanAddForm.vlan_id ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                {vlanAdding ? '…' : '+ Add'}
              </button>
            </div>
            {vlanAddError && <p style={{ color: '#f87171', fontSize: 12, margin: '-8px 0 12px' }}>{vlanAddError}</p>}

            {/* Scrollable table area — grows to fill available space */}
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {vlans.length === 0 ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🏷</div>
                No VLANs yet. Add one above or click <strong>Poll Ports</strong> to auto-discover from the switch.
              </div>
            ) : (<>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '6px 8px', width: 32 }}>
                      <input type="checkbox"
                        checked={vlanSelected.size === vlans.length && vlans.length > 0}
                        ref={el => { if (el) el.indeterminate = vlanSelected.size > 0 && vlanSelected.size < vlans.length }}
                        onChange={e => setVlanSelected(e.target.checked ? new Set(vlans.map(v => v.vlan_id)) : new Set())}
                      />
                    </th>
                    {['ID', 'Name', 'Description', ''].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {vlans.map(v => {
                    const isUnnamed = !v.name || /^vlan\s*\d+$/i.test(v.name)
                    const nameVal  = vlanNameEdit[v.vlan_id]  !== undefined ? vlanNameEdit[v.vlan_id]  : v.name
                    const descVal  = vlanDescEdit[v.vlan_id] !== undefined ? vlanDescEdit[v.vlan_id] : (v.description ?? '')
                    const isDirty  = vlanNameEdit[v.vlan_id] !== undefined || vlanDescEdit[v.vlan_id] !== undefined
                    const isChecked = vlanSelected.has(v.vlan_id)
                    return (
                      <tr key={v.vlan_id} style={{ borderBottom: '1px solid var(--border-weak)', background: isChecked ? 'rgba(99,102,241,0.08)' : isUnnamed ? 'rgba(251,191,36,0.04)' : 'transparent' }}>
                        <td style={{ padding: '7px 8px', width: 32 }}>
                          <input type="checkbox" checked={isChecked}
                            onChange={e => setVlanSelected(prev => {
                              const s = new Set(prev)
                              e.target.checked ? s.add(v.vlan_id) : s.delete(v.vlan_id)
                              return s
                            })}
                          />
                        </td>
                        <td style={{ padding: '7px 10px', fontFamily: 'monospace', fontWeight: 700, color: '#818cf8', width: 50 }}>{v.vlan_id}</td>
                        <td style={{ padding: '7px 10px', width: '28%' }}>
                          <input
                            value={nameVal}
                            placeholder={isUnnamed ? 'Unnamed ⚠' : ''}
                            onChange={e => setVlanNameEdit(prev => ({ ...prev, [v.vlan_id]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') saveVlan(v.vlan_id) }}
                            style={{ width: '100%', padding: '3px 7px', borderRadius: 4, border: `1px solid ${isUnnamed && !vlanNameEdit[v.vlan_id] ? 'rgba(251,191,36,0.4)' : 'var(--border-med)'}`, background: 'var(--input-bg)', color: isUnnamed && !vlanNameEdit[v.vlan_id] ? '#fbbf24' : 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                          />
                        </td>
                        <td style={{ padding: '7px 10px' }}>
                          <input
                            value={descVal}
                            placeholder="Add description…"
                            onChange={e => setVlanDescEdit(prev => ({ ...prev, [v.vlan_id]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') saveVlan(v.vlan_id) }}
                            style={{ width: '100%', padding: '3px 7px', borderRadius: 4, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                          />
                        </td>
                        <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', display: 'flex', gap: 5, alignItems: 'center' }}>
                          {isDirty && (
                            <button onClick={() => saveVlan(v.vlan_id)} disabled={vlanSaving === v.vlan_id}
                              style={{ fontSize: 11, padding: '2px 9px', borderRadius: 4, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: 'pointer', opacity: vlanSaving === v.vlan_id ? 0.6 : 1 }}>
                              {vlanSaving === v.vlan_id ? '…' : 'Save'}
                            </button>
                          )}
                          <button onClick={() => deleteVlan(v.vlan_id)}
                            style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, border: '1px solid rgba(248,113,113,0.3)', background: 'transparent', color: '#f87171', cursor: 'pointer' }}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

            </>)}
            </div>{/* end scroll area */}

            {/* Selection summary bar — always at bottom, no layout jump */}
            {vlanSelected.size > 0 && ((): React.ReactElement => {
              const sel = vlans.filter(v => vlanSelected.has(v.vlan_id)).sort((a, b) => a.vlan_id - b.vlan_id)
              const idList = sel.map(v => v.vlan_id).join(',')
              return (
                <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {sel.length} VLAN{sel.length > 1 ? 's' : ''} selected — trunk allowed list
                    </span>
                    <button onClick={() => setVlanSelected(new Set())}
                      style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                      Clear
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <code style={{ flex: 1, fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#e2e8f0', background: 'rgba(0,0,0,0.3)', padding: '6px 10px', borderRadius: 6, userSelect: 'all', wordBreak: 'break-all' }}>
                      {idList}
                    </code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(idList); setVlanCopied(true); setTimeout(() => setVlanCopied(false), 2000) }}
                      style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: vlanCopied ? '#34d399' : 'var(--accent-hex)', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      {vlanCopied ? '✓ Copied!' : '📋 Copy IDs'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {sel.map(v => (
                      <span key={v.vlan_id} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.3)', color: '#a5b4fc' }}>
                        {v.vlan_id}{v.name ? ` · ${v.name}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>
        </Modal>
      )}

      {/* ── RADIUS add/edit form modal ── */}
      {(radiusModal === 'new' || radiusModal === 'edit') && (
        <Modal title="" onClose={() => { setRadiusModal(null); setRadiusError('') }}>
          <div style={{ padding: '24px 28px', minWidth: 400 }}>
            <h3 style={{ margin: '0 0 18px', fontSize: 15, fontWeight: 700 }}>
              {radiusModal === 'new' ? '+ New RADIUS Server' : 'Edit RADIUS Server'}
            </h3>
            {radiusError && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 12 }}>{radiusError}</div>}
            {[
              { label: 'Name', key: 'name', type: 'text', placeholder: 'e.g. Main RADIUS' },
              { label: 'Host / IP', key: 'host', type: 'text', placeholder: '192.168.1.10' },
              { label: 'Auth Port', key: 'auth_port', type: 'number', placeholder: '1812' },
              { label: 'Acct Port', key: 'acct_port', type: 'number', placeholder: '1813' },
              { label: 'Shared Secret', key: 'secret', type: 'password', placeholder: '••••••••' },
              { label: 'Timeout (s)', key: 'timeout', type: 'number', placeholder: '5' },
              { label: 'Retries', key: 'retries', type: 'number', placeholder: '2' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{f.label}</label>
                <input
                  type={f.type} placeholder={f.placeholder}
                  value={(radiusForm as any)[f.key]}
                  onChange={e => setRadiusForm(prev => ({ ...prev, [f.key]: f.type === 'number' ? +e.target.value : e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button onClick={() => { setRadiusModal(null); setRadiusError('') }} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button
                disabled={radiusSaving}
                onClick={async () => {
                  if (!radiusForm.name || !radiusForm.host || !radiusForm.secret) { setRadiusError('Name, host, and secret are required'); return }
                  setRadiusSaving(true); setRadiusError('')
                  try {
                    if (radiusModal === 'new') {
                      const row = await api.post<{ id: string }>('/radius-servers', radiusForm)
                      setRadiusServers(prev => [...prev, { ...radiusForm, id: row.id, description: null }])
                    } else {
                      await api.put(`/radius-servers/${editingRadius!.id}`, radiusForm)
                      setRadiusServers(prev => prev.map(r => r.id === editingRadius!.id ? { ...r, ...radiusForm } : r))
                    }
                    setRadiusModal(null)
                  } catch (e: any) { setRadiusError(e.message ?? 'Save failed') }
                  setRadiusSaving(false)
                }}
                style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: 'var(--accent-hex)', color: '#fff', cursor: radiusSaving ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: radiusSaving ? 0.65 : 1 }}>
                {radiusSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── RADIUS push confirm modal ── */}
      {radiusModal === 'push' && (
        <Modal title="" onClose={() => { setRadiusModal(null); setRadiusError('') }}>
          <div style={{ padding: '24px 28px', minWidth: 380 }}>
            <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700 }}>🔐 Push RADIUS Config</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-muted)' }}>
              Push RADIUS + AAA + 802.1X global config to <strong style={{ color: 'var(--text)' }}>{selected?.name}</strong> via SSH.
            </p>
            <div style={{ marginBottom: 16 }}>
              {radiusServers.filter(r => radiusSelected.has(r.id)).map(r => (
                <div key={r.id} style={{ padding: '8px 12px', marginBottom: 6, borderRadius: 6, background: 'var(--bg-panel)', border: '1px solid var(--border)', fontSize: 13 }}>
                  <strong>{r.name}</strong>
                  <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontFamily: 'monospace', fontSize: 12 }}>{r.host}:{r.auth_port}</span>
                </div>
              ))}
            </div>
            {radiusError && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: 12 }}>{radiusError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setRadiusModal(null); setRadiusError('') }} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border-med)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button
                disabled={radiusPushing}
                onClick={async () => {
                  if (!selectedId) return
                  setRadiusPushing(true); setRadiusError('')
                  try {
                    await requestElevation('radius_config_push')
                    await api.post(`/servers/${selectedId}/push-radius`, { radius_server_ids: [...radiusSelected] })
                    setRadiusModal(null)
                    setShowRadiusPanel(false)
                  } catch (e: any) { setRadiusError(e.message ?? 'Push failed') }
                  setRadiusPushing(false)
                }}
                style={{ padding: '7px 14px', borderRadius: 6, border: 'none', background: '#f97316', color: '#fff', cursor: radiusPushing ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: radiusPushing ? 0.65 : 1 }}>
                {radiusPushing ? 'Pushing…' : 'Push Config'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// Toolbar button helper
const tbBtn = (color: string, bg: string, border: string): React.CSSProperties => ({
  fontSize: 12, padding: '5px 12px', borderRadius: 6, border: `1px solid ${border}`,
  background: bg, color, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
})

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
