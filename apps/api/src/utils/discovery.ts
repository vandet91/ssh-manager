/**
 * Server discovery — collects everything needed to plan a migration.
 * Runs all sections in parallel where possible for speed.
 */
import { Client } from 'ssh2'
import { sshExec } from './ssh'

async function exec(client: Client, cmd: string): Promise<string> {
  try { return (await sshExec(client, cmd)).stdout.trim() } catch { return '' }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoverySnapshot {
  discovered_at: string

  system: {
    hostname: string
    os_name: string
    os_version: string
    os_id: string
    kernel: string
    arch: string
    timezone: string
    locale: string
    uptime: string
  }

  hardware: {
    cpu_model: string
    cpu_cores: number
    ram_total_mb: number
    swap_total_mb: number
  }

  network: {
    interfaces: Array<{ name: string; addresses: string[] }>
    default_gateway: string
    dns_servers: string[]
    hostname_fqdn: string
    open_ports: Array<{ port: number; proto: string; service: string }>
  }

  storage: {
    disks: Array<{ device: string; size: string; type: string }>
    mounts: Array<{ device: string; mount: string; fstype: string; size: string; used: string; avail: string; use_pct: string }>
    large_dirs: Array<{ path: string; size: string }>
  }

  packages: {
    manager: 'apt' | 'yum' | 'dnf' | 'pacman' | 'unknown'
    total: number
    list: Array<{ name: string; version: string }>
  }

  services: {
    running: Array<{ name: string; status: string; enabled: boolean }>
  }

  users: {
    local_users: Array<{ username: string; uid: number; shell: string; home: string; groups: string }>
    sudo_rules: string[]
  }

  cron: {
    system_crons: string[]
    user_crons: Array<{ user: string; entries: string[] }>
  }

  databases: {
    mysql: { installed: boolean; version: string; databases: string[] }
    postgresql: { installed: boolean; version: string; databases: string[] }
    mongodb: { installed: boolean; version: string; databases: string[] }
    redis: { installed: boolean; version: string }
  }

  web_servers: {
    nginx: { installed: boolean; version: string; vhosts: string[] }
    apache: { installed: boolean; version: string; vhosts: string[] }
  }

  docker: {
    installed: boolean
    version: string
    containers: Array<{ id: string; name: string; image: string; status: string; ports: string }>
    images: Array<{ id: string; repository: string; tag: string; size: string }>
    compose_files: string[]
  }

  ssl: {
    certificates: Array<{ path: string; subject: string; expiry: string; days_left: number }>
  }

  env_files: string[]

  systemd_timers: Array<{ name: string; next: string; last: string }>

  cluster: {
    kubernetes: {
      detected: boolean
      role: 'control-plane' | 'worker' | 'none'
      version: string
      nodes: Array<{ name: string; role: string; status: string; version: string }>
      namespaces: string[]
    }
    docker_swarm: {
      detected: boolean
      role: 'manager' | 'worker' | 'none'
      nodes: Array<{ id: string; hostname: string; status: string; availability: string; role: string }>
    }
    pacemaker: {
      detected: boolean
      nodes: string[]
      resources: string[]
    }
    galera: {
      detected: boolean
      cluster_size: number
      status: string
    }
    redis_cluster: {
      detected: boolean
      mode: 'cluster' | 'sentinel' | 'standalone'
      nodes: string[]
    }
    patroni: { detected: boolean; status: string }
    haproxy: { detected: boolean; version: string }
    keepalived: { detected: boolean; virtual_ips: string[] }
    glusterfs: { detected: boolean; peers: string[]; volumes: string[] }
    ceph: { detected: boolean; status: string; health: string }
    mysql_replication: {
      detected: boolean
      role: 'primary' | 'replica' | 'none'
      mode: 'replication' | 'group_replication' | 'none'
      replicas: number
      group_members: string[]
    }
    pg_replication: {
      detected: boolean
      role: 'primary' | 'standby' | 'none'
      standbys: Array<{ host: string; state: string; sync_state: string }>
    }
    mongodb: {
      detected: boolean
      mode: 'replica_set' | 'sharded' | 'standalone'
      set_name: string
      members: Array<{ host: string; state: string }>
    }
    cassandra: {
      detected: boolean
      version: string
      datacenter: string
      nodes: string[]
    }
    elasticsearch: {
      detected: boolean
      version: string
      cluster_name: string
      nodes: number
      status: string
    }
  }
}

// ── Section collectors ────────────────────────────────────────────────────────

async function collectSystem(client: Client): Promise<DiscoverySnapshot['system']> {
  const [osRelease, kernel, arch, tz, locale, uptime, hostname] = await Promise.all([
    exec(client, 'cat /etc/os-release 2>/dev/null'),
    exec(client, 'uname -r'),
    exec(client, 'uname -m'),
    exec(client, 'cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo "UTC"'),
    exec(client, 'echo "${LANG:-unknown}"'),
    exec(client, 'uptime -p 2>/dev/null || uptime'),
    exec(client, 'hostname -f 2>/dev/null || hostname'),
  ])

  const osInfo: Record<string, string> = {}
  for (const line of osRelease.split('\n')) {
    const [k, v] = line.split('=')
    if (k && v) osInfo[k.trim()] = v.trim().replace(/^"|"$/g, '')
  }

  return {
    hostname,
    os_name: osInfo['NAME'] || osInfo['PRETTY_NAME'] || 'Unknown',
    os_version: osInfo['VERSION'] || osInfo['VERSION_ID'] || '',
    os_id: osInfo['ID'] || '',
    kernel,
    arch,
    timezone: tz,
    locale,
    uptime,
  }
}

async function collectHardware(client: Client): Promise<DiscoverySnapshot['hardware']> {
  const [cpuModel, cpuCores, mem, swap] = await Promise.all([
    exec(client, "grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs"),
    exec(client, 'nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo'),
    exec(client, "grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}'"),
    exec(client, "grep SwapTotal /proc/meminfo 2>/dev/null | awk '{print $2}'"),
  ])
  return {
    cpu_model: cpuModel || 'Unknown',
    cpu_cores: parseInt(cpuCores) || 1,
    ram_total_mb: Math.round((parseInt(mem) || 0) / 1024),
    swap_total_mb: Math.round((parseInt(swap) || 0) / 1024),
  }
}

async function collectNetwork(client: Client): Promise<DiscoverySnapshot['network']> {
  const [ifaceRaw, gateway, dnsRaw, fqdn, portsRaw] = await Promise.all([
    exec(client, "ip -4 addr show 2>/dev/null | awk '/^[0-9]+:/{iface=$2} /inet /{print iface\" \"$2}'"),
    exec(client, "ip route 2>/dev/null | grep '^default' | awk '{print $3}' | head -1"),
    exec(client, "grep '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}'"),
    exec(client, 'hostname -f 2>/dev/null || hostname'),
    exec(client, "ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | grep -oP ':\\K[0-9]+' | sort -un | head -30"),
  ])

  const interfaces: Array<{ name: string; addresses: string[] }> = []
  const ifMap: Record<string, string[]> = {}
  for (const line of ifaceRaw.split('\n').filter(Boolean)) {
    const [name, addr] = line.trim().split(' ')
    if (name && addr) {
      const key = name.replace(/:$/, '')
      ;(ifMap[key] = ifMap[key] || []).push(addr)
    }
  }
  for (const [name, addresses] of Object.entries(ifMap)) {
    if (name !== 'lo:') interfaces.push({ name: name.replace(/:$/, ''), addresses })
  }

  const openPorts = portsRaw.split('\n').filter(Boolean).map((p) => {
    const port = parseInt(p)
    const SERVICE_MAP: Record<number, string> = {
      22: 'ssh', 80: 'http', 443: 'https', 3306: 'mysql', 5432: 'postgresql',
      6379: 'redis', 27017: 'mongodb', 8080: 'http-alt', 8443: 'https-alt',
      25: 'smtp', 587: 'smtp', 993: 'imaps', 3000: 'node', 5000: 'app',
    }
    return { port, proto: 'tcp', service: SERVICE_MAP[port] || '' }
  })

  return {
    interfaces,
    default_gateway: gateway,
    dns_servers: dnsRaw.split('\n').filter(Boolean),
    hostname_fqdn: fqdn,
    open_ports: openPorts,
  }
}

async function collectStorage(client: Client): Promise<DiscoverySnapshot['storage']> {
  const [diskRaw, mountRaw, largeDirRaw] = await Promise.all([
    exec(client, "lsblk -d -o NAME,SIZE,TYPE 2>/dev/null | grep -E 'disk|ssd' | head -10"),
    exec(client, "df -h --output=source,target,fstype,size,used,avail,pcent 2>/dev/null | tail -n +2 | grep -v tmpfs | grep -v devtmpfs | head -20"),
    exec(client, "du -sh /var /opt /home /srv /data /app /www 2>/dev/null | sort -rh | head -10"),
  ])

  const disks = diskRaw.split('\n').filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/)
    return { device: `/dev/${parts[0] || ''}`, size: parts[1] || '', type: parts[2] || '' }
  })

  const mounts = mountRaw.split('\n').filter(Boolean).map((line) => {
    const [device, mount, fstype, size, used, avail, use_pct] = line.trim().split(/\s+/)
    return { device: device || '', mount: mount || '', fstype: fstype || '', size: size || '', used: used || '', avail: avail || '', use_pct: use_pct || '' }
  })

  const large_dirs = largeDirRaw.split('\n').filter(Boolean).map((line) => {
    const [size, path] = line.trim().split(/\s+/)
    return { path: path || '', size: size || '' }
  })

  return { disks, mounts, large_dirs }
}

async function collectPackages(client: Client): Promise<DiscoverySnapshot['packages']> {
  // Use file existence checks — more reliable than `which` over restricted SSH PATH
  const [hasApt, hasDpkg, hasDnf, hasYum, hasPacman, hasRpm] = await Promise.all([
    exec(client, 'test -f /usr/bin/apt && echo yes || echo no'),
    exec(client, 'test -f /usr/bin/dpkg-query && echo yes || echo no'),
    exec(client, 'test -f /usr/bin/dnf && echo yes || echo no'),
    exec(client, 'test -f /usr/bin/yum && echo yes || echo no'),
    exec(client, 'test -f /usr/bin/pacman && echo yes || echo no'),
    exec(client, 'test -f /usr/bin/rpm && echo yes || echo no'),
  ])

  let manager: DiscoverySnapshot['packages']['manager'] = 'unknown'
  let raw = ''

  if (hasApt === 'yes' || hasDpkg === 'yes') {
    manager = 'apt'
    // Use awk to avoid shell variable expansion issues with dpkg-query -f format
    raw = await exec(client, "dpkg-query -W -f='${Package} ${Version}\n' 2>/dev/null | head -500")
  } else if (hasDnf === 'yes' || hasRpm === 'yes') {
    manager = hasDnf === 'yes' ? 'dnf' : 'yum'
    raw = await exec(client, "rpm -qa --queryformat '%{NAME} %{VERSION}-%{RELEASE}\n' 2>/dev/null | head -500")
  } else if (hasYum === 'yes') {
    manager = 'yum'
    raw = await exec(client, "rpm -qa --queryformat '%{NAME} %{VERSION}-%{RELEASE}\n' 2>/dev/null | head -500")
  } else if (hasPacman === 'yes') {
    manager = 'pacman'
    raw = await exec(client, 'pacman -Q 2>/dev/null | head -500')
  }

  const list = raw.split('\n').filter(Boolean).map((line) => {
    const idx = line.lastIndexOf(' ')
    const name = idx > 0 ? line.slice(0, idx).trim() : line.trim()
    const version = idx > 0 ? line.slice(idx + 1).trim() : ''
    return { name, version }
  }).filter((p) => p.name)

  return { manager, total: list.length, list }
}

async function collectServices(client: Client): Promise<DiscoverySnapshot['services']> {
  const raw = await exec(client,
    "systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null | awk '{print $1, $3, $4}' | head -100"
  )
  const enabledRaw = await exec(client,
    "systemctl list-unit-files --type=service --no-pager --no-legend 2>/dev/null | awk '{print $1, $2}' | head -200"
  )
  const enabledMap: Record<string, boolean> = {}
  for (const line of enabledRaw.split('\n').filter(Boolean)) {
    const [name, state] = line.split(/\s+/)
    if (name) enabledMap[name] = state === 'enabled'
  }

  const running = raw.split('\n').filter(Boolean).map((line) => {
    const [name, load, active] = line.trim().split(/\s+/)
    return { name: name || '', status: active || load || '', enabled: enabledMap[name] ?? false }
  }).filter((s) => s.name && s.name.endsWith('.service'))

  return { running }
}

async function collectUsers(client: Client): Promise<DiscoverySnapshot['users']> {
  const [passwdRaw, sudoRaw] = await Promise.all([
    exec(client, "getent passwd 2>/dev/null | awk -F: '$3>=1000||$3==0{print $1\":\"$3\":\"$7\":\"$6}'"),
    exec(client, "grep -v '^#' /etc/sudoers 2>/dev/null; grep -rh -v '^#' /etc/sudoers.d/ 2>/dev/null | grep -v '^$'"),
  ])

  const local_users = await Promise.all(
    passwdRaw.split('\n').filter(Boolean).map(async (line) => {
      const [username, uid, shell, home] = line.split(':')
      const groups = await exec(client, `id -Gn ${username} 2>/dev/null`)
      return { username: username || '', uid: parseInt(uid) || 0, shell: shell || '', home: home || '', groups }
    })
  )

  const sudo_rules = sudoRaw.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('@'))

  return { local_users, sudo_rules }
}

async function collectCron(client: Client): Promise<DiscoverySnapshot['cron']> {
  const [sysRaw, usersRaw] = await Promise.all([
    exec(client, "ls /etc/cron.d/ /etc/cron.daily/ /etc/cron.weekly/ /etc/cron.monthly/ 2>/dev/null"),
    exec(client, "ls /var/spool/cron/crontabs/ 2>/dev/null || ls /var/spool/cron/ 2>/dev/null"),
  ])

  const system_crons = sysRaw.split('\n').filter(Boolean)
  const cronUsers = usersRaw.split('\n').filter(Boolean)

  const user_crons = await Promise.all(
    cronUsers.map(async (user) => {
      const entries = await exec(client, `crontab -l -u ${user} 2>/dev/null | grep -v '^#' | grep -v '^$'`)
      return { user, entries: entries.split('\n').filter(Boolean) }
    })
  )

  return { system_crons, user_crons: user_crons.filter((u) => u.entries.length > 0) }
}

async function collectDatabases(client: Client): Promise<DiscoverySnapshot['databases']> {
  const [mysqlVer, pgVer, mongoVer, redisVer] = await Promise.all([
    exec(client, 'mysql --version 2>/dev/null || mysqld --version 2>/dev/null'),
    exec(client, 'psql --version 2>/dev/null || postgres --version 2>/dev/null'),
    exec(client, 'mongod --version 2>/dev/null | head -1'),
    exec(client, 'redis-server --version 2>/dev/null | head -1'),
  ])

  // MySQL databases
  let mysqlDbs: string[] = []
  if (mysqlVer) {
    const raw = await exec(client, "mysql -u root -e 'SHOW DATABASES;' 2>/dev/null || mysql -e 'SHOW DATABASES;' 2>/dev/null")
    mysqlDbs = raw.split('\n').filter((d) => d && !['Database', 'information_schema', 'performance_schema', 'sys'].includes(d))
  }

  // PostgreSQL databases
  let pgDbs: string[] = []
  if (pgVer) {
    const raw = await exec(client, "sudo -u postgres psql -t -c '\\l' 2>/dev/null | awk -F'|' '{print $1}' | xargs")
    pgDbs = raw.split(/\s+/).filter((d) => d && !['template0', 'template1', 'postgres', ''].includes(d))
  }

  // MongoDB databases
  let mongoDbs: string[] = []
  if (mongoVer) {
    const raw = await exec(client, "mongosh --quiet --eval 'db.adminCommand({listDatabases:1}).databases.forEach(d=>print(d.name))' 2>/dev/null || mongo --quiet --eval 'db.adminCommand({listDatabases:1}).databases.forEach(d=>print(d.name))' 2>/dev/null")
    mongoDbs = raw.split('\n').filter((d) => d && !['admin', 'config', 'local'].includes(d))
  }

  return {
    mysql: { installed: !!mysqlVer, version: mysqlVer.split('\n')[0], databases: mysqlDbs },
    postgresql: { installed: !!pgVer, version: pgVer.split('\n')[0], databases: pgDbs },
    mongodb: { installed: !!mongoVer, version: mongoVer.split('\n')[0], databases: mongoDbs },
    redis: { installed: !!redisVer, version: redisVer },
  }
}

async function collectWebServers(client: Client): Promise<DiscoverySnapshot['web_servers']> {
  const [nginxVer, apacheVer] = await Promise.all([
    exec(client, 'nginx -v 2>&1 | head -1'),
    exec(client, 'apache2 -v 2>/dev/null | head -1 || httpd -v 2>/dev/null | head -1'),
  ])

  let nginxVhosts: string[] = []
  if (nginxVer.includes('nginx')) {
    const raw = await exec(client, "grep -rh 'server_name' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ /etc/nginx/nginx.conf 2>/dev/null | grep -v '#' | awk '{$1=$1; print}'")
    nginxVhosts = raw.split('\n').filter(Boolean)
  }

  let apacheVhosts: string[] = []
  if (apacheVer) {
    const raw = await exec(client, "grep -rh 'ServerName\\|ServerAlias' /etc/apache2/sites-enabled/ /etc/httpd/conf.d/ 2>/dev/null | grep -v '#' | awk '{$1=$1; print}'")
    apacheVhosts = raw.split('\n').filter(Boolean)
  }

  return {
    nginx: { installed: nginxVer.includes('nginx'), version: nginxVer, vhosts: nginxVhosts },
    apache: { installed: !!apacheVer && !apacheVer.includes('not found'), version: apacheVer, vhosts: apacheVhosts },
  }
}

async function collectDocker(client: Client): Promise<DiscoverySnapshot['docker']> {
  const dockerVer = await exec(client, 'docker --version 2>/dev/null')
  if (!dockerVer) {
    return { installed: false, version: '', containers: [], images: [], compose_files: [] }
  }

  const [containersRaw, imagesRaw, composeRaw] = await Promise.all([
    exec(client, "docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | head -30"),
    exec(client, "docker images --format '{{.ID}}\\t{{.Repository}}\\t{{.Tag}}\\t{{.Size}}' 2>/dev/null | head -30"),
    exec(client, "find / -name 'docker-compose.yml' -o -name 'docker-compose.yaml' -o -name 'compose.yml' 2>/dev/null | grep -v '/proc/' | grep -v '/sys/' | head -20"),
  ])

  const containers = containersRaw.split('\n').filter(Boolean).map((line) => {
    const [id, name, image, ...rest] = line.split('\t')
    const ports = rest.pop() || ''
    const status = rest.join(' ')
    return { id: id || '', name: name || '', image: image || '', status, ports }
  })

  const images = imagesRaw.split('\n').filter(Boolean).map((line) => {
    const [id, repository, tag, size] = line.split('\t')
    return { id: id || '', repository: repository || '', tag: tag || '', size: size || '' }
  })

  return {
    installed: true,
    version: dockerVer,
    containers,
    images,
    compose_files: composeRaw.split('\n').filter(Boolean),
  }
}

async function collectSSL(client: Client): Promise<DiscoverySnapshot['ssl']> {
  const certPaths = await exec(client,
    "find /etc/letsencrypt/live /etc/ssl/certs /etc/nginx /etc/apache2 /etc/httpd -name '*.crt' -o -name '*.pem' 2>/dev/null | grep -v chain | grep -v fullchain | head -20"
  )

  const certificates = await Promise.all(
    certPaths.split('\n').filter(Boolean).map(async (path) => {
      const [subject, expiry] = await Promise.all([
        exec(client, `openssl x509 -in ${path} -noout -subject 2>/dev/null | sed 's/subject=//'`),
        exec(client, `openssl x509 -in ${path} -noout -enddate 2>/dev/null | sed 's/notAfter=//'`),
      ])
      if (!subject && !expiry) return null
      let days_left = 0
      if (expiry) {
        const exp = new Date(expiry)
        days_left = Math.round((exp.getTime() - Date.now()) / 86400000)
      }
      return { path, subject, expiry, days_left }
    })
  )

  return { certificates: certificates.filter(Boolean) as DiscoverySnapshot['ssl']['certificates'] }
}

async function collectEnvFiles(client: Client): Promise<string[]> {
  const raw = await exec(client,
    "find /var/www /opt /app /home /srv /root -maxdepth 5 -name '.env' -o -name '.env.production' -o -name '.env.local' 2>/dev/null | grep -v node_modules | head -20"
  )
  return raw.split('\n').filter(Boolean)
}

async function collectTimers(client: Client): Promise<DiscoverySnapshot['systemd_timers']> {
  const raw = await exec(client,
    "systemctl list-timers --all --no-pager --no-legend 2>/dev/null | awk '{print $1, $2, $3, $5, $6, $7}' | head -20"
  )
  return raw.split('\n').filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s{2,}|\t/)
    return { name: parts[3] || line, next: parts[0] || '', last: parts[2] || '' }
  })
}

// ── Cluster detection ─────────────────────────────────────────────────────────

async function collectCluster(client: Client): Promise<DiscoverySnapshot['cluster']> {
  // Top-level presence checks in two small batches (stay under MaxSessions=10)
  const [k8sVer, kubeletActive, swarmInfo, pcmkVer, haproxyVer] =
    await Promise.all([
      exec(client, 'kubectl version --client --short 2>/dev/null | head -1'),
      exec(client, 'systemctl is-active kubelet 2>/dev/null'),
      exec(client, 'docker info 2>/dev/null | grep -i "swarm"'),
      exec(client, 'pcs --version 2>/dev/null || crm --version 2>/dev/null'),
      exec(client, 'haproxy -v 2>/dev/null | head -1'),
    ])
  const [keepalivedActive, glusterVer, cephVer, patroniActive] =
    await Promise.all([
      exec(client, 'systemctl is-active keepalived 2>/dev/null'),
      exec(client, 'gluster --version 2>/dev/null | head -1'),
      exec(client, 'ceph --version 2>/dev/null | head -1'),
      exec(client, 'systemctl is-active patroni 2>/dev/null'),
    ])

  // ── Kubernetes ───────────────────────────────────────────────────────────────
  const k8sDetected = kubeletActive === 'active' || !!k8sVer
  let k8sResult: DiscoverySnapshot['cluster']['kubernetes'] = {
    detected: k8sDetected, role: 'none', version: k8sVer, nodes: [], namespaces: [],
  }
  if (k8sDetected) {
    const [roleRaw, nodesRaw, nsRaw] = await Promise.all([
      exec(client, 'kubectl get node $(hostname) -o jsonpath="{.metadata.labels}" 2>/dev/null || cat /etc/kubernetes/manifests/kube-apiserver.yaml 2>/dev/null | grep -q apiserver && echo control-plane || echo worker'),
      exec(client, 'kubectl get nodes --no-headers 2>/dev/null | head -20'),
      exec(client, 'kubectl get namespaces --no-headers 2>/dev/null | awk \'{print $1}\''),
    ])
    const isControlPlane = roleRaw.includes('control-plane') || roleRaw.includes('master')
    const nodes = nodesRaw.split('\n').filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/)
      return { name: parts[0] || '', status: parts[1] || '', role: parts[2] || '', version: parts[4] || '' }
    })
    k8sResult = {
      detected: true,
      role: isControlPlane ? 'control-plane' : 'worker',
      version: k8sVer,
      nodes,
      namespaces: nsRaw.split('\n').filter(Boolean),
    }
  }

  // ── Docker Swarm ─────────────────────────────────────────────────────────────
  const swarmDetected = swarmInfo.toLowerCase().includes('active') || swarmInfo.toLowerCase().includes('swarm: active')
  let swarmResult: DiscoverySnapshot['cluster']['docker_swarm'] = {
    detected: swarmDetected, role: 'none', nodes: [],
  }
  if (swarmDetected) {
    const [swarmRole, nodesRaw] = await Promise.all([
      exec(client, 'docker info 2>/dev/null | grep "Is Manager:" | awk \'{print $3}\''),
      exec(client, 'docker node ls --format "{{.ID}}\\t{{.Hostname}}\\t{{.Status}}\\t{{.Availability}}\\t{{.ManagerStatus}}" 2>/dev/null | head -20'),
    ])
    const nodes = nodesRaw.split('\n').filter(Boolean).map((line) => {
      const [id, hostname, status, availability, role] = line.split('\t')
      return { id: id || '', hostname: hostname || '', status: status || '', availability: availability || '', role: role || 'worker' }
    })
    swarmResult = {
      detected: true,
      role: swarmRole === 'true' ? 'manager' : 'worker',
      nodes,
    }
  }

  // ── Pacemaker / Corosync ─────────────────────────────────────────────────────
  const pcmkDetected = !!pcmkVer
  let pcmkResult: DiscoverySnapshot['cluster']['pacemaker'] = { detected: pcmkDetected, nodes: [], resources: [] }
  if (pcmkDetected) {
    const [nodesRaw, resRaw] = await Promise.all([
      exec(client, 'pcs status nodes 2>/dev/null | head -10 || crm_mon -1 -r 2>/dev/null | grep "Node:" | head -10'),
      exec(client, 'pcs resource status 2>/dev/null | head -20 || crm_mon -1 2>/dev/null | grep "Resource:" | head -20'),
    ])
    pcmkResult = {
      detected: true,
      nodes: nodesRaw.split('\n').filter(Boolean),
      resources: resRaw.split('\n').filter(Boolean),
    }
  }

  // ── Galera (MySQL/MariaDB cluster) ───────────────────────────────────────────
  const galeraRaw = await exec(client,
    "mysql -u root -e \"SHOW STATUS LIKE 'wsrep_cluster_size';\" 2>/dev/null || mysql -e \"SHOW STATUS LIKE 'wsrep_cluster_size';\" 2>/dev/null"
  )
  const galeraSize = parseInt((galeraRaw.match(/wsrep_cluster_size\s+(\d+)/i) || [])[1] || '0')
  const galeraStatus = galeraSize > 1
    ? await exec(client, "mysql -u root -e \"SHOW STATUS WHERE Variable_name LIKE 'wsrep%';\" 2>/dev/null | grep wsrep_cluster_status | awk '{print $2}'")
    : ''

  // ── Redis Cluster / Sentinel ─────────────────────────────────────────────────
  const redisInfoRaw = await exec(client, 'redis-cli info replication 2>/dev/null | head -20')
  const redisClusterEnabled = await exec(client, 'redis-cli info cluster 2>/dev/null | grep cluster_enabled')
  let redisMode: 'cluster' | 'sentinel' | 'standalone' = 'standalone'
  const redisNodes: string[] = []
  if (redisClusterEnabled.includes('cluster_enabled:1')) {
    redisMode = 'cluster'
    const clusterNodes = await exec(client, 'redis-cli cluster nodes 2>/dev/null | head -10')
    clusterNodes.split('\n').filter(Boolean).forEach((line) => {
      const parts = line.split(' ')
      if (parts[1]) redisNodes.push(parts[1])
    })
  } else if (redisInfoRaw.includes('role:master') || redisInfoRaw.includes('role:slave')) {
    const connectedSlaves = (redisInfoRaw.match(/connected_slaves:(\d+)/) || [])[1]
    if (parseInt(connectedSlaves || '0') > 0) {
      redisMode = 'sentinel'
      const slavesRaw = redisInfoRaw.split('\n').filter((l) => l.startsWith('slave'))
      slavesRaw.forEach((l) => {
        const ip = (l.match(/ip=([^,]+)/) || [])[1]
        const port = (l.match(/port=(\d+)/) || [])[1]
        if (ip && port) redisNodes.push(`${ip}:${port}`)
      })
    }
  }

  // ── Patroni (PostgreSQL HA) ──────────────────────────────────────────────────
  const patroniDetected = patroniActive === 'active'
  const patroniStatus = patroniDetected
    ? await exec(client, 'patronictl -c /etc/patroni/config.yml list 2>/dev/null || patronictl -c /etc/patroni.yml list 2>/dev/null | head -20')
    : ''

  // ── HAProxy ──────────────────────────────────────────────────────────────────
  // ── keepalived ───────────────────────────────────────────────────────────────
  let keepalivedVips: string[] = []
  if (keepalivedActive === 'active') {
    const vipRaw = await exec(client, "grep -rh 'virtual_ipaddress' /etc/keepalived/ 2>/dev/null -A5 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+' | head -10")
    keepalivedVips = vipRaw.split('\n').filter(Boolean)
  }

  // ── GlusterFS ────────────────────────────────────────────────────────────────
  const glusterDetected = !!glusterVer
  let glusterPeers: string[] = []
  let glusterVolumes: string[] = []
  if (glusterDetected) {
    const [peersRaw, volsRaw] = await Promise.all([
      exec(client, 'gluster peer status 2>/dev/null | grep Hostname | awk \'{print $2}\''),
      exec(client, 'gluster volume list 2>/dev/null'),
    ])
    glusterPeers = peersRaw.split('\n').filter(Boolean)
    glusterVolumes = volsRaw.split('\n').filter(Boolean)
  }

  // ── Ceph ─────────────────────────────────────────────────────────────────────
  const cephDetected = !!cephVer
  let cephStatus = ''
  let cephHealth = ''
  if (cephDetected) {
    const [statusRaw, healthRaw] = await Promise.all([
      exec(client, 'ceph status 2>/dev/null | head -5'),
      exec(client, 'ceph health 2>/dev/null'),
    ])
    cephStatus = statusRaw
    cephHealth = healthRaw
  }

  // ── MySQL / MariaDB replication ───────────────────────────────────────────────
  const [mysqlSlaveStatus, mysqlMasterStatus, mysqlGroupMembers] = await Promise.all([
    exec(client, "mysql -u root -e 'SHOW SLAVE STATUS\\G' 2>/dev/null || mysql -e 'SHOW REPLICA STATUS\\G' 2>/dev/null | head -20"),
    exec(client, "mysql -u root -e 'SHOW MASTER STATUS\\G' 2>/dev/null | head -10"),
    exec(client, "mysql -u root -e 'SELECT MEMBER_HOST, MEMBER_STATE FROM performance_schema.replication_group_members;' 2>/dev/null"),
  ])
  const mysqlIsGroupReplication = mysqlGroupMembers.includes('MEMBER_HOST') || mysqlGroupMembers.includes('PRIMARY') || mysqlGroupMembers.includes('SECONDARY')
  const mysqlIsReplica = mysqlSlaveStatus.includes('Master_Host') || mysqlSlaveStatus.includes('Source_Host')
  const mysqlIsPrimary = !mysqlIsReplica && !!mysqlMasterStatus
  const mysqlReplicaCount = mysqlIsPrimary
    ? parseInt((await exec(client, "mysql -u root -e 'SHOW STATUS LIKE \"Slaves_connected\";' 2>/dev/null | awk 'NR>1{print $2}'")) || '0')
    : 0
  const mysqlGroupMemberList = mysqlIsGroupReplication
    ? mysqlGroupMembers.split('\n').filter((l) => l.includes('|') && !l.includes('MEMBER_HOST')).map((l) => l.split('|')[1]?.trim()).filter(Boolean) as string[]
    : []
  const mysqlDetected = mysqlIsReplica || mysqlIsPrimary || mysqlIsGroupReplication
  const mysqlMode = mysqlIsGroupReplication ? 'group_replication' : mysqlDetected ? 'replication' : 'none'
  const mysqlRole = mysqlIsReplica ? 'replica' : mysqlIsPrimary ? 'primary' : 'none'

  // ── PostgreSQL streaming replication ─────────────────────────────────────────
  const [pgRecovery, pgStandbys] = await Promise.all([
    exec(client, "sudo -u postgres psql -c 'SELECT pg_is_in_recovery();' -t 2>/dev/null | tr -d ' '"),
    exec(client, "sudo -u postgres psql -c \"SELECT client_addr, state, sync_state FROM pg_stat_replication;\" -t 2>/dev/null"),
  ])
  const pgIsStandby = pgRecovery.trim() === 't'
  const pgStandbyList = pgStandbys.split('\n').filter((l) => l.trim() && l.includes('|')).map((l) => {
    const [host, state, sync] = l.split('|').map((s) => s.trim())
    return { host: host || '', state: state || '', sync_state: sync || '' }
  })
  const pgDetected = pgIsStandby || pgStandbyList.length > 0

  // ── MongoDB replica set / sharded ────────────────────────────────────────────
  const mongoStatusRaw = await exec(client, "mongosh --quiet --eval 'JSON.stringify(rs.status())' 2>/dev/null || mongo --quiet --eval 'JSON.stringify(rs.status())' 2>/dev/null | head -50")
  let mongoMode: 'replica_set' | 'sharded' | 'standalone' = 'standalone'
  let mongoSetName = ''
  const mongoMembers: Array<{ host: string; state: string }> = []
  if (mongoStatusRaw && !mongoStatusRaw.includes('"ok":0') && mongoStatusRaw.includes('"set"')) {
    try {
      const parsed = JSON.parse(mongoStatusRaw.slice(mongoStatusRaw.indexOf('{')))
      if (parsed.set) {
        mongoMode = 'replica_set'
        mongoSetName = parsed.set
        ;(parsed.members ?? []).forEach((m: { name: string; stateStr: string }) => {
          mongoMembers.push({ host: m.name, state: m.stateStr })
        })
      }
    } catch { /* non-json or no rs */ }
  }
  const isSharded = await exec(client, "mongosh --quiet --eval 'sh.status()' 2>/dev/null | grep -c 'shards' || echo 0")
  if (parseInt(isSharded) > 0 && mongoMode === 'standalone') mongoMode = 'sharded'
  const mongoDetected = mongoMode !== 'standalone'

  // ── Cassandra ────────────────────────────────────────────────────────────────
  const cassandraVer = await exec(client, 'nodetool version 2>/dev/null | head -1 || cassandra -v 2>/dev/null | head -1')
  let cassandraDC = ''
  let cassandraNodes: string[] = []
  if (cassandraVer) {
    const [dcRaw, nodesRaw] = await Promise.all([
      exec(client, "nodetool info 2>/dev/null | grep 'Data Center' | awk -F: '{print $2}' | xargs"),
      exec(client, 'nodetool status 2>/dev/null | grep -E "^UN|^DN|^UL|^DL" | awk \'{print $2}\' | head -20'),
    ])
    cassandraDC = dcRaw.trim()
    cassandraNodes = nodesRaw.split('\n').filter(Boolean)
  }

  // ── Elasticsearch / OpenSearch ────────────────────────────────────────────────
  const esHealthRaw = await exec(client, 'curl -s http://localhost:9200/_cluster/health 2>/dev/null | head -c 500')
  let esDetected = false
  let esVersion = ''
  let esClusterName = ''
  let esNodeCount = 0
  let esStatus = ''
  if (esHealthRaw && esHealthRaw.includes('"cluster_name"')) {
    try {
      const esHealth = JSON.parse(esHealthRaw)
      esDetected = true
      esClusterName = esHealth.cluster_name || ''
      esNodeCount = esHealth.number_of_nodes || 0
      esStatus = esHealth.status || ''
      const esVerRaw = await exec(client, 'curl -s http://localhost:9200/ 2>/dev/null | grep -o \'"number" *: *"[^"]*"\' | head -1')
      esVersion = (esVerRaw.match(/"([^"]+)"$/) || [])[1] || ''
    } catch { /* parse error */ }
  }

  return {
    kubernetes: k8sResult,
    docker_swarm: swarmResult,
    pacemaker: pcmkResult,
    galera: { detected: galeraSize > 1, cluster_size: galeraSize, status: galeraStatus },
    redis_cluster: { detected: redisMode !== 'standalone', mode: redisMode, nodes: redisNodes },
    patroni: { detected: patroniDetected, status: patroniStatus },
    haproxy: { detected: !!haproxyVer, version: haproxyVer },
    keepalived: { detected: keepalivedActive === 'active', virtual_ips: keepalivedVips },
    glusterfs: { detected: glusterDetected, peers: glusterPeers, volumes: glusterVolumes },
    ceph: { detected: cephDetected, status: cephStatus, health: cephHealth },
    mysql_replication: {
      detected: mysqlDetected,
      role: mysqlRole,
      mode: mysqlMode,
      replicas: mysqlReplicaCount,
      group_members: mysqlGroupMemberList,
    },
    pg_replication: {
      detected: pgDetected,
      role: pgIsStandby ? 'standby' : pgDetected ? 'primary' : 'none',
      standbys: pgStandbyList,
    },
    mongodb: {
      detected: mongoDetected,
      mode: mongoMode,
      set_name: mongoSetName,
      members: mongoMembers,
    },
    cassandra: {
      detected: !!cassandraVer,
      version: cassandraVer,
      datacenter: cassandraDC,
      nodes: cassandraNodes,
    },
    elasticsearch: {
      detected: esDetected,
      version: esVersion,
      cluster_name: esClusterName,
      nodes: esNodeCount,
      status: esStatus,
    },
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runDiscovery(client: Client): Promise<DiscoverySnapshot> {
  // Run collectors sequentially to avoid overwhelming SSH MaxSessions limit (default=10).
  // Each collector already parallelises its own commands internally, so we still get speed
  // within a section while keeping the total open channels manageable.
  const system     = await collectSystem(client)
  const hardware   = await collectHardware(client)
  const network    = await collectNetwork(client)
  const storage    = await collectStorage(client)
  const packages   = await collectPackages(client)
  const services   = await collectServices(client)
  const users      = await collectUsers(client)
  const cron       = await collectCron(client)
  const databases  = await collectDatabases(client)
  const webServers = await collectWebServers(client)
  const docker     = await collectDocker(client)
  const ssl        = await collectSSL(client)
  const envFiles   = await collectEnvFiles(client)
  const timers     = await collectTimers(client)
  const cluster    = await collectCluster(client)

  return {
    discovered_at: new Date().toISOString(),
    system,
    hardware,
    network,
    storage,
    packages,
    services,
    users,
    cron,
    databases,
    web_servers: webServers,
    docker,
    ssl,
    env_files: envFiles,
    systemd_timers: timers,
    cluster,
  }
}

// ── Diff / comparison ─────────────────────────────────────────────────────────

export type DiffStatus = 'match' | 'missing' | 'mismatch' | 'extra'

export interface DiffItem {
  section: string
  key: string
  status: DiffStatus
  source_value: string
  target_value: string
  note: string
}

export function compareSnapshots(source: DiscoverySnapshot, target: DiscoverySnapshot): DiffItem[] {
  const items: DiffItem[] = []

  const add = (section: string, key: string, status: DiffStatus, sv: string, tv: string, note = '') =>
    items.push({ section, key, status, source_value: sv, target_value: tv, note })

  // System
  if (source.system.os_id !== target.system.os_id)
    add('System', 'OS', 'mismatch', source.system.os_name, target.system.os_name, 'Different OS family — verify compatibility')
  else if (source.system.os_version !== target.system.os_version)
    add('System', 'OS Version', 'mismatch', source.system.os_version, target.system.os_version, 'Version difference — test application compatibility')
  else
    add('System', 'OS', 'match', source.system.os_name, target.system.os_name)

  if (source.system.timezone !== target.system.timezone)
    add('System', 'Timezone', 'mismatch', source.system.timezone, target.system.timezone, 'Timezone mismatch may affect cron jobs and logs')

  // Hardware
  if (target.hardware.ram_total_mb < source.hardware.ram_total_mb)
    add('Hardware', 'RAM', 'mismatch', `${source.hardware.ram_total_mb} MB`, `${target.hardware.ram_total_mb} MB`, 'Target has less RAM — review service requirements')
  else
    add('Hardware', 'RAM', 'match', `${source.hardware.ram_total_mb} MB`, `${target.hardware.ram_total_mb} MB`)

  if (target.hardware.cpu_cores < source.hardware.cpu_cores)
    add('Hardware', 'CPU cores', 'mismatch', `${source.hardware.cpu_cores}`, `${target.hardware.cpu_cores}`, 'Fewer cores on target')
  else
    add('Hardware', 'CPU cores', 'match', `${source.hardware.cpu_cores}`, `${target.hardware.cpu_cores}`)

  // Storage — check each source mount fits in target
  for (const sm of source.storage.mounts) {
    const tm = target.storage.mounts.find((m) => m.mount === sm.mount)
    if (!tm) {
      add('Storage', `Mount ${sm.mount}`, 'missing', `${sm.size} (${sm.use_pct} used)`, '—', 'Mount point not present on target')
    } else {
      const srcUsedPct = parseInt(sm.use_pct) || 0
      const tgtAvailPct = 100 - (parseInt(tm.use_pct) || 0)
      if (srcUsedPct > tgtAvailPct)
        add('Storage', `Mount ${sm.mount}`, 'mismatch', sm.use_pct + ' used', tm.avail + ' available', 'Target may not have enough space')
      else
        add('Storage', `Mount ${sm.mount}`, 'match', `${sm.size} (${sm.use_pct} used)`, `${tm.size} (${tm.avail} free)`)
    }
  }

  // Packages — what's on source but missing on target
  const targetPkgSet = new Set(target.packages.list.map((p) => p.name))
  const sourcePkgSet = new Set(source.packages.list.map((p) => p.name))

  // Only flag non-trivial packages (skip very common base ones)
  const SKIP_PKGS = new Set(['bash', 'coreutils', 'grep', 'gawk', 'sed', 'tar', 'gzip', 'util-linux', 'libc6', 'libgcc-s1'])
  for (const pkg of source.packages.list) {
    if (SKIP_PKGS.has(pkg.name)) continue
    if (!targetPkgSet.has(pkg.name)) {
      const tpkg = target.packages.list.find((p) => p.name === pkg.name)
      if (!tpkg) {
        add('Packages', pkg.name, 'missing', pkg.version, '—', 'Not installed on target')
      }
    } else {
      const tpkg = target.packages.list.find((p) => p.name === pkg.name)
      if (tpkg && tpkg.version !== pkg.version) {
        add('Packages', pkg.name, 'mismatch', pkg.version, tpkg.version, 'Version differs')
      }
    }
  }

  // Check for packages on target that aren't on source (extra)
  for (const pkg of target.packages.list) {
    if (SKIP_PKGS.has(pkg.name)) continue
    if (!sourcePkgSet.has(pkg.name)) {
      add('Packages', pkg.name, 'extra', '—', pkg.version, 'Present on target but not source')
    }
  }

  // Services — running on source but not on target
  const targetSvcSet = new Set(target.services.running.map((s) => s.name))
  for (const svc of source.services.running.filter((s) => s.status === 'active' || s.enabled)) {
    if (!targetSvcSet.has(svc.name)) {
      add('Services', svc.name, 'missing', `active, enabled=${svc.enabled}`, '—', 'Service not found on target')
    } else {
      const tsvc = target.services.running.find((s) => s.name === svc.name)
      if (tsvc && tsvc.status !== svc.status)
        add('Services', svc.name, 'mismatch', svc.status, tsvc.status, 'Status differs on target')
      else
        add('Services', svc.name, 'match', svc.status, tsvc?.status || '—')
    }
  }

  // Users
  const targetUserSet = new Set(target.users.local_users.map((u) => u.username))
  for (const u of source.users.local_users) {
    if (!targetUserSet.has(u.username)) {
      add('Users', u.username, 'missing', `uid=${u.uid}`, '—', 'User not present on target — create before migration')
    } else {
      add('Users', u.username, 'match', `uid=${u.uid}`, `uid=${target.users.local_users.find((t) => t.username === u.username)?.uid}`)
    }
  }

  // Open ports — warn if source has ports not open on target
  for (const p of source.network.open_ports) {
    const found = target.network.open_ports.find((tp) => tp.port === p.port)
    if (!found) {
      add('Network', `Port ${p.port}${p.service ? ' (' + p.service + ')' : ''}`, 'missing', 'open', 'closed', 'Service not listening on target yet')
    }
  }

  // Databases
  if (source.databases.mysql.installed && !target.databases.mysql.installed)
    add('Databases', 'MySQL', 'missing', source.databases.mysql.version, '—', 'MySQL not installed on target')
  if (source.databases.postgresql.installed && !target.databases.postgresql.installed)
    add('Databases', 'PostgreSQL', 'missing', source.databases.postgresql.version, '—', 'PostgreSQL not installed on target')
  if (source.databases.mongodb.installed && !target.databases.mongodb.installed)
    add('Databases', 'MongoDB', 'missing', source.databases.mongodb.version, '—', 'MongoDB not installed on target')
  if (source.databases.redis.installed && !target.databases.redis.installed)
    add('Databases', 'Redis', 'missing', source.databases.redis.version, '—', 'Redis not installed on target')

  // SSL certs
  for (const cert of source.ssl.certificates) {
    const found = target.ssl.certificates.find((c) => c.subject === cert.subject)
    if (!found) {
      add('SSL', cert.subject || cert.path, 'missing', `expires in ${cert.days_left}d`, '—', 'Certificate not present on target — install or issue new cert')
    }
  }

  // Docker
  if (source.docker.installed && !target.docker.installed)
    add('Docker', 'Docker Engine', 'missing', source.docker.version, '—', 'Docker not installed on target')
  else if (source.docker.installed && target.docker.installed) {
    for (const c of source.docker.containers.filter((c) => c.status.startsWith('Up'))) {
      const tc = target.docker.containers.find((tc) => tc.name === c.name)
      if (!tc) add('Docker', `Container ${c.name}`, 'missing', c.image, '—', 'Container not running on target')
    }
  }

  // Web servers
  if (source.web_servers.nginx.installed && !target.web_servers.nginx.installed)
    add('Web Servers', 'nginx', 'missing', source.web_servers.nginx.version, '—', 'nginx not installed on target')
  if (source.web_servers.apache.installed && !target.web_servers.apache.installed)
    add('Web Servers', 'Apache', 'missing', source.web_servers.apache.version, '—', 'Apache not installed on target')

  // Env files
  for (const f of source.env_files) {
    if (!target.env_files.includes(f))
      add('Config Files', f, 'missing', 'present', '—', '.env file not found on target — copy before cutover')
  }

  return items
}
