/**
 * Virtualization / hypervisor platform detection.
 *
 * Detects whether a server is running on:
 *   VMware ESXi · Hyper-V · Proxmox · KVM/QEMU · VirtualBox · Xen
 *   LXC container · Docker container · AWS · Azure · GCP · Physical
 *
 * Works for both Linux (bash) and Windows (PowerShell) SSH sessions.
 */

import type { Client } from 'ssh2'

type SshExecFn = (client: Client, cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>

export type HostType =
  | 'vmware'
  | 'hyperv'
  | 'proxmox'
  | 'kvm'
  | 'virtualbox'
  | 'xen'
  | 'lxc'
  | 'docker'
  | 'aws'
  | 'azure'
  | 'gcp'
  | 'linode'
  | 'physical'
  | 'unknown'

export interface VirtInfo {
  /** Normalized platform key */
  host_type: HostType
  /** Human-readable label */
  label: string
  /** Additional detail e.g. "VMware ESXi 7.0.3" or "AWS t3.medium" */
  detail: string | null
  /** Icon for UI */
  icon: string
  /** Colour hint for badge */
  color: string
}

// ── Linux detection ─────────────────────────────────────────────────────────────

const LINUX_DETECT_SCRIPT = `
# 1. systemd-detect-virt (most reliable on modern Linux)
VIRT=""
if command -v systemd-detect-virt >/dev/null 2>&1; then
  VIRT=$(systemd-detect-virt 2>/dev/null)
fi

# 2. DMI data (available without root on most systems via /sys)
VENDOR=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null | tr -d '\\n' || echo "")
PRODUCT=$(cat /sys/class/dmi/id/product_name 2>/dev/null | tr -d '\\n' || echo "")
BIOS=$(cat /sys/class/dmi/id/bios_vendor 2>/dev/null | tr -d '\\n' || echo "")
CHASSIS=$(cat /sys/class/dmi/id/chassis_vendor 2>/dev/null | tr -d '\\n' || echo "")
VERSION=$(cat /sys/class/dmi/id/product_version 2>/dev/null | tr -d '\\n' || echo "")

# 3. CPU hypervisor flag
CPUFLAGS=$(grep -m1 "^flags" /proc/cpuinfo 2>/dev/null | grep -o "hypervisor" || echo "")

# 4. Cloud metadata endpoints (non-blocking, 1s timeout)
AWS_META=$(curl -s --max-time 1 http://169.254.169.254/latest/meta-data/instance-type 2>/dev/null || echo "")
AWS_AZ=$(curl -s --max-time 1 http://169.254.169.254/latest/meta-data/placement/availability-zone 2>/dev/null || echo "")
GCP_META=$(curl -s --max-time 1 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/machine-type 2>/dev/null || echo "")
AZURE_META=$(curl -s --max-time 1 -H "Metadata:true" "http://169.254.169.254/metadata/instance/compute/vmSize?api-version=2021-02-01&format=text" 2>/dev/null || echo "")

# 5. Container checks
IN_DOCKER="no"
if [ -f /.dockerenv ] || grep -q docker /proc/1/cgroup 2>/dev/null; then IN_DOCKER="yes"; fi
IN_LXC="no"
if grep -q lxc /proc/1/cgroup 2>/dev/null || [ "$VIRT" = "lxc" ]; then IN_LXC="yes"; fi

# 6. Proxmox guest agent
QEMU_AGENT=$(command -v qemu-ga >/dev/null 2>&1 && echo "yes" || systemctl is-active qemu-guest-agent 2>/dev/null | grep -c active || echo "no")

echo "VIRT=$VIRT"
echo "VENDOR=$VENDOR"
echo "PRODUCT=$PRODUCT"
echo "BIOS=$BIOS"
echo "CHASSIS=$CHASSIS"
echo "VERSION=$VERSION"
echo "CPUFLAGS=$CPUFLAGS"
echo "AWS_META=$AWS_META"
echo "AWS_AZ=$AWS_AZ"
echo "GCP_META=$GCP_META"
echo "AZURE_META=$AZURE_META"
echo "IN_DOCKER=$IN_DOCKER"
echo "IN_LXC=$IN_LXC"
echo "QEMU_AGENT=$QEMU_AGENT"
`.trim()

export async function detectVirtLinux(client: Client, sshExec: SshExecFn): Promise<VirtInfo> {
  try {
    const out = await sshExec(client, LINUX_DETECT_SCRIPT)
    const kv: Record<string, string> = {}
    for (const line of out.stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) kv[line.slice(0, eq)] = line.slice(eq + 1).trim()
    }

    const virt    = (kv['VIRT'] ?? '').toLowerCase()
    const vendor  = (kv['VENDOR'] ?? '').toLowerCase()
    const product = (kv['PRODUCT'] ?? '').toLowerCase()
    const bios    = (kv['BIOS'] ?? '').toLowerCase()
    const chassis = (kv['CHASSIS'] ?? '').toLowerCase()
    const version = (kv['VERSION'] ?? '')
    const awsMeta = kv['AWS_META'] ?? ''
    const awsAz   = kv['AWS_AZ'] ?? ''
    const gcpMeta = kv['GCP_META'] ?? ''
    const azureMeta = kv['AZURE_META'] ?? ''

    // ── Containers first (run inside VMs too, so check before VM type) ──

    if (kv['IN_DOCKER'] === 'yes') {
      return mk('docker', 'Docker Container', null, '🐳', '#0ea5e9')
    }
    if (kv['IN_LXC'] === 'yes' || virt === 'lxc') {
      return mk('lxc', 'LXC Container', null, '📦', '#8b5cf6')
    }

    // ── Cloud platforms ──────────────────────────────────────────────────
    // NOTE: 169.254.169.254 is a SHARED link-local metadata address — AWS,
    // Azure, and several other providers (including Linode, if its own
    // metadata service is enabled) all listen on the same IP. Just getting a
    // short, non-HTML response from the AWS-shaped path is NOT proof it's
    // actually AWS: a Linode host answering with anything short at that path
    // was being misidentified as AWS. Require independent confirmation via
    // the DMI vendor string (which real AWS EC2 instances set to "Amazon
    // EC2") before trusting the metadata probe.
    const looksLikeAws = vendor.includes('amazon') || bios.includes('amazon')
    if (awsMeta && awsMeta.length < 30 && !awsMeta.includes('<') && looksLikeAws) {
      const region = awsAz ? awsAz.replace(/-[a-z]$/, '') : ''
      return mk('aws', 'Amazon Web Services', `${awsMeta}${region ? ' · ' + region : ''}`, '☁️', '#f97316')
    }

    // GCP's metadata host (metadata.google.internal) only resolves inside
    // GCP, so this probe doesn't share the false-positive risk above.
    if (gcpMeta && gcpMeta.length < 60 && !gcpMeta.includes('<')) {
      const parts = gcpMeta.split('/')
      return mk('gcp', 'Google Cloud Platform', parts[parts.length - 1] ?? null, '☁️', '#3b82f6')
    }

    // Azure shares the same 169.254.169.254 address — same confirmation need.
    const looksLikeAzure = vendor.includes('microsoft') || bios.includes('microsoft') || chassis.includes('microsoft')
    if (azureMeta && azureMeta.length < 40 && !azureMeta.includes('<') && looksLikeAzure) {
      return mk('azure', 'Microsoft Azure', azureMeta, '☁️', '#0ea5e9')
    }

    // Linode (KVM-based) sets its DMI system/board vendor to "Linode".
    if (vendor.includes('linode') || product.includes('linode')) {
      return mk('linode', 'Linode (Akamai)', kv['PRODUCT'] || null, '🟢', '#00b39f')
    }

    // ── Hypervisors ─────────────────────────────────────────────────────

    if (virt === 'vmware' || vendor.includes('vmware') || product.includes('vmware') || bios.includes('vmware')) {
      const detail = kv['PRODUCT'] || kv['VERSION'] || null
      return mk('vmware', 'VMware', detail, '🟦', '#1d6fa5')
    }

    if (virt === 'microsoft' || vendor.includes('microsoft') || product.includes('virtual machine') || chassis.includes('microsoft')) {
      return mk('hyperv', 'Microsoft Hyper-V', version || null, '🟦', '#0078d4')
    }

    // Proxmox: QEMU vendor + qemu-guest-agent running
    const isQemu = vendor.includes('qemu') || product.includes('standard pc') || product.includes('qemu') || virt === 'kvm'
    const hasQemuAgent = kv['QEMU_AGENT'] && kv['QEMU_AGENT'] !== 'no' && kv['QEMU_AGENT'] !== '0'
    if (isQemu && hasQemuAgent) {
      return mk('proxmox', 'Proxmox VE (KVM)', null, '🟧', '#e57000')
    }

    if (virt === 'kvm' || isQemu) {
      return mk('kvm', 'KVM / QEMU', null, '🟩', '#22c55e')
    }

    if (virt === 'oracle' || vendor.includes('innotek') || product.includes('virtualbox')) {
      return mk('virtualbox', 'VirtualBox', null, '🔵', '#0d6efd')
    }

    if (virt === 'xen' || vendor.includes('xen') || product.includes('hvm domU')) {
      return mk('xen', 'Xen', null, '🔷', '#6366f1')
    }

    // ── Physical ─────────────────────────────────────────────────────────

    if (virt === 'none' || (!kv['CPUFLAGS']?.includes('hypervisor') && !isQemu)) {
      const detail = [kv['VENDOR'], kv['PRODUCT']].filter(Boolean).join(' · ') || null
      return mk('physical', 'Physical / Bare Metal', detail, '🖥️', '#6b7280')
    }

    return mk('unknown', 'Unknown', null, '❓', '#6b7280')
  } catch {
    return mk('unknown', 'Unknown', null, '❓', '#6b7280')
  }
}

// ── Windows detection ────────────────────────────────────────────────────────

export async function detectVirtWindows(client: Client, sshExec: SshExecFn): Promise<VirtInfo> {
  try {
    const script = `
$cs = Get-WmiObject Win32_ComputerSystem -ErrorAction SilentlyContinue
$bios = Get-WmiObject Win32_BIOS -ErrorAction SilentlyContinue
$bb = Get-WmiObject Win32_BaseBoard -ErrorAction SilentlyContinue
Write-Output "Manufacturer=$($cs.Manufacturer)"
Write-Output "Model=$($cs.Model)"
Write-Output "BIOSVendor=$($bios.Manufacturer)"
Write-Output "BIOSVersion=$($bios.SMBIOSBIOSVersion)"
Write-Output "IsVM=$($cs.HypervisorPresent)"
Write-Output "HVType=$($cs.Model)"
# Check Hyper-V guest
$hvSvc = Get-Service "vmicheartbeat" -ErrorAction SilentlyContinue
Write-Output "HyperVGuest=$(if($hvSvc){'yes'}else{'no'})"
# Check VMware tools
$vmSvc = Get-Service "VMTools" -ErrorAction SilentlyContinue
Write-Output "VMwareTools=$(if($vmSvc){'yes'}else{'no'})"
# Check VirtualBox
$vbSvc = Get-Service "VBoxService" -ErrorAction SilentlyContinue
Write-Output "VBoxGuest=$(if($vbSvc){'yes'}else{'no'})"
# Check AWS (IMDS)
try { $aws = (Invoke-WebRequest -Uri "http://169.254.169.254/latest/meta-data/instance-type" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop).Content; Write-Output "AWS=$aws" } catch { Write-Output "AWS=" }
# Check Azure
try { $az = (Invoke-WebRequest -Uri "http://169.254.169.254/metadata/instance/compute/vmSize?api-version=2021-02-01&format=text" -Headers @{"Metadata"="true"} -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop).Content; Write-Output "Azure=$az" } catch { Write-Output "Azure=" }
`.trim()

    const out = await sshExec(client, `powershell -NonInteractive -Command "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`)
    const kv: Record<string, string> = {}
    for (const line of out.stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }

    const mfr   = (kv['Manufacturer'] ?? '').toLowerCase()
    const model = (kv['Model'] ?? '').toLowerCase()
    const bios  = (kv['BIOSVendor'] ?? '').toLowerCase()
    const biosV = kv['BIOSVersion'] ?? ''
    const aws   = kv['AWS'] ?? ''
    const azure = kv['Azure'] ?? ''

    // Same shared-IP caveat as the Linux path: 169.254.169.254 answers for
    // multiple providers, so require DMI vendor confirmation before trusting it.
    if (aws && aws.length < 30 && !aws.includes('<') && (mfr.includes('amazon') || bios.includes('amazon'))) {
      return mk('aws', 'Amazon Web Services', aws, '☁️', '#f97316')
    }
    if (azure && azure.length < 40 && !azure.includes('<') && mfr.includes('microsoft')) {
      return mk('azure', 'Microsoft Azure', azure, '☁️', '#0ea5e9')
    }
    if (mfr.includes('linode') || model.includes('linode')) {
      return mk('linode', 'Linode (Akamai)', kv['Model'] || null, '🟢', '#00b39f')
    }
    if (kv['VMwareTools'] === 'yes' || mfr.includes('vmware') || model.includes('vmware') || bios.includes('vmware')) {
      return mk('vmware', 'VMware', biosV || null, '🟦', '#1d6fa5')
    }
    if (kv['HyperVGuest'] === 'yes' || mfr.includes('microsoft') || model.includes('virtual machine')) {
      return mk('hyperv', 'Microsoft Hyper-V', null, '🟦', '#0078d4')
    }
    if (kv['VBoxGuest'] === 'yes' || mfr.includes('innotek') || model.includes('virtualbox')) {
      return mk('virtualbox', 'VirtualBox', null, '🔵', '#0d6efd')
    }
    if (mfr.includes('qemu') || model.includes('standard pc') || bios.includes('seabios')) {
      return mk('kvm', 'KVM / QEMU', null, '🟩', '#22c55e')
    }

    // Physical — real vendor names
    const physicalVendors = ['dell', 'hp', 'hewlett', 'lenovo', 'supermicro', 'fujitsu', 'cisco', 'huawei', 'asus', 'acer', 'intel', 'ibm']
    if (physicalVendors.some((v) => mfr.includes(v))) {
      return mk('physical', 'Physical / Bare Metal', `${kv['Manufacturer']} ${kv['Model']}`.trim() || null, '🖥️', '#6b7280')
    }

    return mk('unknown', 'Unknown', null, '❓', '#6b7280')
  } catch {
    return mk('unknown', 'Unknown', null, '❓', '#6b7280')
  }
}

// ── Helper ───────────────────────────────────────────────────────────────────

function mk(host_type: HostType, label: string, detail: string | null, icon: string, color: string): VirtInfo {
  return { host_type, label, detail, icon, color }
}
