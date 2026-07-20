import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../db/client'
import { requireAuth } from '../../middleware/auth'

const DEFAULT_WINDOWS = [
  // General
  { category: 'General', label: 'System info', command: 'systeminfo', description: 'OS version, hostname, uptime, RAM, hotfixes' },
  { category: 'General', label: 'IP config', command: 'ipconfig /all', description: 'All adapters, IP, DNS, gateway' },
  { category: 'General', label: 'Disk usage', command: 'wmic logicaldisk get DeviceID,Size,FreeSpace', description: 'Disk size and free space per drive' },
  { category: 'General', label: 'CPU info', command: 'wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors', description: 'CPU model and core count' },
  { category: 'General', label: 'RAM info', command: 'wmic memorychip get Capacity,Speed', description: 'RAM sticks capacity and speed' },
  { category: 'General', label: 'Recent errors', command: 'Get-EventLog -LogName System -Newest 50 -EntryType Error,Warning | Format-Table -AutoSize', description: '(PS) Last 50 system errors/warnings' },
  { category: 'General', label: 'Repair system files', command: 'sfc /scannow', description: 'Scan and repair corrupted system files' },
  { category: 'General', label: 'Repair Windows image', command: 'DISM /Online /Cleanup-Image /RestoreHealth', description: 'Repair Windows image from Windows Update' },
  { category: 'General', label: 'Recent patches', command: 'Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 10', description: '(PS) 10 most recently installed patches' },
  { category: 'General', label: 'Reboot now', command: 'shutdown /r /t 0', description: 'Reboot immediately' },
  // Services
  { category: 'Services (SC)', label: 'List all services', command: 'sc query type= all state= all', description: 'All services and their current state' },
  { category: 'Services (SC)', label: 'Stopped services', command: 'Get-Service | Where-Object {$_.Status -eq \'Stopped\'} | Format-Table -AutoSize', description: '(PS) All stopped services' },
  { category: 'Services (SC)', label: 'Start service', command: 'sc start <ServiceName>', description: 'Start a service by name' },
  { category: 'Services (SC)', label: 'Stop service', command: 'sc stop <ServiceName>', description: 'Stop a service by name' },
  { category: 'Services (SC)', label: 'Restart service (PS)', command: 'Restart-Service -Name <ServiceName> -Force', description: '(PS) Force restart a service' },
  { category: 'Services (SC)', label: 'Set auto-start', command: 'sc config <ServiceName> start= auto', description: 'Set service to start automatically on boot' },
  { category: 'Services (SC)', label: 'Auto-restart on failure', command: 'sc failure <ServiceName> reset= 0 actions= restart/60000/restart/60000/restart/60000', description: 'Auto-restart service on failure (every 60s)' },
  // Print Server
  { category: 'Print Server', label: 'List printers', command: 'Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus | Format-Table -AutoSize', description: '(PS) All installed printers' },
  { category: 'Print Server', label: 'Show print queue', command: 'Get-PrintJob -PrinterName \'<PrinterName>\'', description: '(PS) Print queue for a specific printer' },
  { category: 'Print Server', label: 'Clear print queue', command: 'Get-PrintJob -PrinterName \'<PrinterName>\' | Remove-PrintJob', description: '(PS) Cancel all jobs in a print queue' },
  { category: 'Print Server', label: 'Restart spooler', command: 'net stop spooler && net start spooler', description: 'Restart Print Spooler (clears stuck jobs)' },
  { category: 'Print Server', label: 'Delete spooled files', command: 'del /Q /F /S "%systemroot%\\System32\\spool\\PRINTERS\\*"', description: 'Delete spooled files (stop spooler first)' },
  { category: 'Print Server', label: 'List printer drivers', command: 'Get-PrinterDriver | Format-Table -AutoSize', description: '(PS) All installed printer drivers' },
  { category: 'Print Server', label: 'Add printer port', command: 'Add-PrinterPort -Name \'IP_<IP>\' -PrinterHostAddress \'<IP>\'', description: '(PS) Add a TCP/IP printer port' },
  { category: 'Print Server', label: 'Add printer', command: 'Add-Printer -Name \'<Name>\' -DriverName \'<Driver>\' -PortName \'IP_<IP>\'', description: '(PS) Add a new network printer' },
  { category: 'Print Server', label: 'Print service logs', command: 'Get-WinEvent -LogName \'Microsoft-Windows-PrintService/Operational\' -MaxEvents 30', description: '(PS) Recent print service event logs' },
  // File Sharing
  { category: 'File Sharing', label: 'List shares', command: 'net share', description: 'All current shares on this server' },
  { category: 'File Sharing', label: 'Active sessions', command: 'net session', description: 'SMB sessions and connected users' },
  { category: 'File Sharing', label: 'Open files', command: 'net file', description: 'Files currently open over network shares' },
  { category: 'File Sharing', label: 'SMB shares (PS)', command: 'Get-SmbShare | Format-Table -AutoSize', description: '(PS) All SMB shares with details' },
  { category: 'File Sharing', label: 'SMB sessions (PS)', command: 'Get-SmbSession | Format-Table -AutoSize', description: '(PS) Active SMB sessions' },
  { category: 'File Sharing', label: 'Close all sessions', command: 'Close-SmbSession -Force', description: '(PS) Force-close all SMB sessions' },
  { category: 'File Sharing', label: 'Create share', command: 'New-SmbShare -Name \'<ShareName>\' -Path \'<Path>\' -FullAccess \'<Domain\\User>\'', description: '(PS) Create a new SMB share' },
  { category: 'File Sharing', label: 'NTFS permissions', command: 'Get-Acl \'<Path>\' | Format-List', description: '(PS) Show NTFS permissions on a folder' },
  { category: 'File Sharing', label: 'Grant NTFS access', command: 'icacls \'<Path>\' /grant \'<User>:(OI)(CI)F\'', description: 'Grant full NTFS permissions recursively' },
  // NPS
  { category: 'NPS / RADIUS', label: 'List RADIUS clients', command: 'Get-NpsRadiusClient | Format-Table -AutoSize', description: '(PS) All RADIUS clients (NAS devices)' },
  { category: 'NPS / RADIUS', label: 'List network policies', command: 'Get-NpsNetworkPolicy | Format-Table -AutoSize', description: '(PS) All NPS network policies' },
  { category: 'NPS / RADIUS', label: 'NPS config', command: 'netsh nps show config', description: 'Show full NPS configuration' },
  { category: 'NPS / RADIUS', label: 'Export NPS config', command: 'netsh nps export filename=\'C:\\nps-backup.xml\' exportPSK=YES', description: 'Export NPS config with shared secrets' },
  { category: 'NPS / RADIUS', label: 'Import NPS config', command: 'netsh nps import filename=\'C:\\nps-backup.xml\'', description: 'Restore NPS config from backup' },
  { category: 'NPS / RADIUS', label: 'Auth successes', command: 'Get-WinEvent -LogName \'Security\' -FilterXPath \'*[System[EventID=6272]]\' -MaxEvents 20', description: '(PS) Successful RADIUS authentications' },
  { category: 'NPS / RADIUS', label: 'Auth failures', command: 'Get-WinEvent -LogName \'Security\' -FilterXPath \'*[System[EventID=6273]]\' -MaxEvents 20', description: '(PS) Failed RADIUS authentications' },
  { category: 'NPS / RADIUS', label: 'Restart NPS', command: 'Restart-Service IAS', description: 'Restart the NPS (IAS) service' },
  { category: 'NPS / RADIUS', label: 'Add RADIUS client', command: 'Add-NpsRadiusClient -Address \'<IP>\' -Name \'<DeviceName>\' -SharedSecret \'<Secret>\'', description: '(PS) Add a new RADIUS client' },
  // Network
  { category: 'Network', label: 'All connections', command: 'netstat -ano', description: 'All connections with owning PID' },
  { category: 'Network', label: 'Listening ports', command: 'netstat -ano | findstr LISTENING', description: 'All listening ports' },
  { category: 'Network', label: 'Port to process', command: 'netstat -ano | findstr :<Port>', description: 'Which process is using a port' },
  { category: 'Network', label: 'Traceroute', command: 'tracert <IP or hostname>', description: 'Trace route to destination' },
  { category: 'Network', label: 'Continuous ping', command: 'ping <IP> -t', description: 'Ping forever (Ctrl+C to stop)' },
  { category: 'Network', label: 'DNS lookup', command: 'nslookup <hostname>', description: 'Resolve hostname to IP' },
  { category: 'Network', label: 'Port connectivity (PS)', command: 'Test-NetConnection -ComputerName <IP> -Port <Port>', description: '(PS) Test TCP port reachability' },
  { category: 'Network', label: 'Firewall rules', command: 'Get-NetFirewallRule | Where-Object {$_.Enabled -eq \'True\'} | Format-Table -AutoSize', description: '(PS) All enabled firewall rules' },
  { category: 'Network', label: 'Open firewall port', command: 'New-NetFirewallRule -DisplayName \'<Name>\' -Direction Inbound -LocalPort <Port> -Protocol TCP -Action Allow', description: '(PS) Allow inbound TCP port' },
  { category: 'Network', label: 'ARP table', command: 'arp -a', description: 'IP to MAC address mapping' },
  { category: 'Network', label: 'Routing table', command: 'route print', description: 'Current routing table' },
]

const DEFAULT_LINUX = [
  // System
  { category: 'System', label: 'System info', command: 'uname -a', description: 'Kernel version, hostname, architecture' },
  { category: 'System', label: 'OS release', command: 'cat /etc/os-release', description: 'Distribution name and version' },
  { category: 'System', label: 'Uptime & load', command: 'uptime', description: 'Uptime and load averages' },
  { category: 'System', label: 'CPU info', command: 'lscpu', description: 'CPU architecture, cores, speed' },
  { category: 'System', label: 'Memory usage', command: 'free -h', description: 'RAM and swap usage in human-readable format' },
  { category: 'System', label: 'Disk usage', command: 'df -h', description: 'Disk space per mounted filesystem' },
  { category: 'System', label: 'Disk usage (folder)', command: 'du -sh /var/log/*', description: 'Size of each item in a directory' },
  { category: 'System', label: 'Block devices', command: 'lsblk', description: 'All disks and partitions' },
  { category: 'System', label: 'Top processes', command: 'top -b -n 1 | head -20', description: 'Snapshot of CPU/memory top processes' },
  { category: 'System', label: 'All processes', command: 'ps aux --sort=-%cpu | head -20', description: 'Processes sorted by CPU usage' },
  { category: 'System', label: 'Kill process', command: 'kill -9 <PID>', description: 'Force-kill a process by PID' },
  { category: 'System', label: 'Reboot', command: 'reboot', description: 'Reboot the server immediately' },
  { category: 'System', label: 'Shutdown', command: 'shutdown -h now', description: 'Shut down immediately' },
  { category: 'System', label: 'Who is logged in', command: 'w', description: 'Active users and what they are doing' },
  { category: 'System', label: 'Last logins', command: 'last -n 20', description: '20 most recent login events' },
  // Services (systemd)
  { category: 'Services', label: 'Service status', command: 'systemctl status <service>', description: 'Status, recent logs of a service' },
  { category: 'Services', label: 'Start service', command: 'systemctl start <service>', description: 'Start a systemd service' },
  { category: 'Services', label: 'Stop service', command: 'systemctl stop <service>', description: 'Stop a systemd service' },
  { category: 'Services', label: 'Restart service', command: 'systemctl restart <service>', description: 'Restart a systemd service' },
  { category: 'Services', label: 'Enable on boot', command: 'systemctl enable <service>', description: 'Auto-start service at boot' },
  { category: 'Services', label: 'Disable on boot', command: 'systemctl disable <service>', description: 'Prevent service starting at boot' },
  { category: 'Services', label: 'Failed services', command: 'systemctl --failed', description: 'List all failed services' },
  { category: 'Services', label: 'All running services', command: 'systemctl list-units --type=service --state=running', description: 'All currently running services' },
  { category: 'Services', label: 'Service logs', command: 'journalctl -u <service> -n 50 --no-pager', description: 'Last 50 log lines for a service' },
  { category: 'Services', label: 'Follow service logs', command: 'journalctl -u <service> -f', description: 'Live-tail logs for a service' },
  // Network
  { category: 'Network', label: 'IP addresses', command: 'ip addr show', description: 'All interfaces and IP addresses' },
  { category: 'Network', label: 'Routing table', command: 'ip route show', description: 'Current routing table' },
  { category: 'Network', label: 'Listening ports', command: 'ss -tlnp', description: 'TCP listening ports with process names' },
  { category: 'Network', label: 'All connections', command: 'ss -tunp', description: 'All TCP/UDP connections with PIDs' },
  { category: 'Network', label: 'Port check', command: 'nc -zv <host> <port>', description: 'Test if a TCP port is open' },
  { category: 'Network', label: 'Traceroute', command: 'traceroute <host>', description: 'Trace network path to host' },
  { category: 'Network', label: 'DNS lookup', command: 'dig <hostname>', description: 'Resolve hostname (detailed)' },
  { category: 'Network', label: 'Continuous ping', command: 'ping -c 100 <IP>', description: 'Ping 100 times' },
  { category: 'Network', label: 'Bandwidth usage', command: 'iftop -n', description: 'Live network bandwidth per connection' },
  { category: 'Network', label: 'Firewall rules (iptables)', command: 'iptables -L -n -v --line-numbers', description: 'List all firewall rules with packet counts' },
  { category: 'Network', label: 'Firewall rules (ufw)', command: 'ufw status verbose', description: 'UFW firewall status and rules' },
  { category: 'Network', label: 'Open port (ufw)', command: 'ufw allow <port>/tcp', description: 'Allow inbound TCP port via UFW' },
  // Logs
  { category: 'Logs', label: 'System log (tail)', command: 'tail -f /var/log/syslog', description: 'Live-tail system log' },
  { category: 'Logs', label: 'Auth log', command: 'tail -n 50 /var/log/auth.log', description: 'Last 50 authentication events' },
  { category: 'Logs', label: 'Kernel messages', command: 'dmesg | tail -30', description: 'Last 30 kernel ring buffer messages' },
  { category: 'Logs', label: 'Kernel errors', command: 'dmesg --level=err,crit | tail -20', description: 'Recent kernel errors and critical messages' },
  { category: 'Logs', label: 'All recent logs', command: 'journalctl -n 100 --no-pager', description: 'Last 100 system journal entries' },
  { category: 'Logs', label: 'Logs since boot', command: 'journalctl -b --no-pager | tail -50', description: 'Journal entries since last boot' },
  { category: 'Logs', label: 'Failed logins', command: 'grep "Failed password" /var/log/auth.log | tail -20', description: 'Recent failed SSH login attempts' },
  // Files & Disk
  { category: 'Files & Disk', label: 'Find large files', command: 'find / -type f -size +100M 2>/dev/null | head -20', description: 'Files larger than 100MB' },
  { category: 'Files & Disk', label: 'Largest directories', command: 'du -h / --max-depth=2 2>/dev/null | sort -rh | head -15', description: 'Top directories by disk usage' },
  { category: 'Files & Disk', label: 'Inode usage', command: 'df -i', description: 'Inode usage per filesystem (diagnose "disk full" with space remaining)' },
  { category: 'Files & Disk', label: 'Open file handles', command: 'lsof | wc -l', description: 'Total open file descriptors system-wide' },
  { category: 'Files & Disk', label: 'Files opened by process', command: 'lsof -p <PID>', description: 'All files opened by a process' },
  { category: 'Files & Disk', label: 'Check filesystem', command: 'fsck -n /dev/<device>', description: 'Dry-run filesystem check (read-only)' },
  // Packages
  { category: 'Packages', label: 'Update packages (apt)', command: 'apt update && apt upgrade -y', description: 'Update package list and upgrade all (Debian/Ubuntu)' },
  { category: 'Packages', label: 'Install package (apt)', command: 'apt install -y <package>', description: 'Install a package (Debian/Ubuntu)' },
  { category: 'Packages', label: 'Remove package (apt)', command: 'apt remove -y <package>', description: 'Remove a package (Debian/Ubuntu)' },
  { category: 'Packages', label: 'Search package (apt)', command: 'apt search <keyword>', description: 'Find packages by keyword' },
  { category: 'Packages', label: 'Update packages (yum)', command: 'yum update -y', description: 'Update all packages (CentOS/RHEL)' },
  { category: 'Packages', label: 'Install package (yum)', command: 'yum install -y <package>', description: 'Install a package (CentOS/RHEL)' },
  { category: 'Packages', label: 'List installed', command: 'dpkg -l | grep <keyword>', description: 'Search installed packages (Debian/Ubuntu)' },
]

const EXTRA_WINDOWS = [
  // AD Health
  { category: 'AD Health', label: 'Full DC diagnostic', command: 'dcdiag /v', description: 'Comprehensive domain controller health check (all tests)' },
  { category: 'AD Health', label: 'DC services check', command: 'dcdiag /test:services', description: 'Verify all required AD services are running (KDC, Netlogon, DFSR, etc.)' },
  { category: 'AD Health', label: 'Replication health', command: 'dcdiag /test:replications', description: 'Check replication status between all DCs' },
  { category: 'AD Health', label: 'Netlogon check', command: 'dcdiag /test:netlogons', description: 'Verify NETLOGON and SYSVOL shares are accessible' },
  { category: 'AD Health', label: 'DNS registration', command: 'dcdiag /test:registerindns', description: 'Check DC DNS records are properly registered' },
  { category: 'AD Health', label: 'Connectivity check', command: 'dcdiag /test:connectivity', description: 'LDAP and RPC connectivity to all DCs' },
  { category: 'AD Health', label: 'Advertising check', command: 'dcdiag /test:advertising', description: 'Verify DC is advertising itself correctly to clients' },
  { category: 'AD Health', label: 'KCC topology check', command: 'dcdiag /test:kccevent', description: 'Check KCC (Knowledge Consistency Checker) events for errors' },
  { category: 'AD Health', label: 'List all DCs', command: 'Get-ADDomainController -Filter * | Select-Object Name,IPv4Address,Site,IsGlobalCatalog,IsReadOnly,OperatingSystem | Format-Table -AutoSize', description: '(PS) All DCs with IP, site, GC/RODC status and OS' },
  { category: 'AD Health', label: 'DC replication summary', command: 'repadmin /replsummary', description: 'Replication success/failure summary across all DCs' },
  { category: 'AD Health', label: 'Replication errors only', command: 'repadmin /showrepl * /errorsonly', description: 'Show only DCs that have replication errors' },
  { category: 'AD Health', label: 'Replication detail', command: 'repadmin /showrepl', description: 'Detailed replication partners and last sync time for this DC' },
  { category: 'AD Health', label: 'Replication queue', command: 'repadmin /queue', description: 'Pending replication changes waiting to be applied' },
  { category: 'AD Health', label: 'Replication latency', command: 'repadmin /showvector /latency <NC>', description: 'Replication latency per DC (replace <NC> with DC=domain,DC=com)' },
  { category: 'AD Health', label: 'Force replication all', command: 'repadmin /syncall /AdeP', description: 'Force full replication sync to all DCs immediately' },
  { category: 'AD Health', label: 'Force replicate from DC', command: 'repadmin /replicate <DestDC> <SourceDC> DC=<domain>,DC=<com>', description: 'Force replicate a specific partition from one DC to another' },
  { category: 'AD Health', label: 'FSMO roles', command: 'netdom query fsmo', description: 'Which DC holds each FSMO role (PDC, RID, Schema, Naming, Infra)' },
  { category: 'AD Health', label: 'FSMO roles (PS)', command: 'Get-ADDomain | Select-Object PDCEmulator,RIDMaster,InfrastructureMaster; Get-ADForest | Select-Object SchemaMaster,DomainNamingMaster', description: '(PS) All five FSMO role holders' },
  { category: 'AD Health', label: 'AD services status', command: 'Get-Service ADWS,DNS,KDC,Netlogon,DFSR,W32Time,NTDS | Select-Object Name,Status,StartType | Format-Table -AutoSize', description: '(PS) Status of all critical AD-related services' },
  { category: 'AD Health', label: 'Netlogon service', command: 'Get-Service Netlogon | Select-Object Name,Status; Test-Path \\\\localhost\\NETLOGON', description: '(PS) Netlogon service status and NETLOGON share availability' },
  { category: 'AD Health', label: 'SYSVOL share check', command: 'Test-Path \\\\localhost\\SYSVOL', description: '(PS) Check SYSVOL share is accessible on this DC' },
  { category: 'AD Health', label: 'SYSVOL replication (DFSR)', command: 'Get-DfsrBacklog -SourceComputerName <PrimaryDC> -DestinationComputerName <SecondaryDC> -GroupName "Domain System Volume" -FolderName "SYSVOL Share"', description: '(PS) Pending SYSVOL replication backlog between DCs' },
  { category: 'AD Health', label: 'DFSR state all DCs', command: 'Get-DfsrState | Format-Table -AutoSize', description: '(PS) DFSR (SYSVOL) replication state for all members' },
  { category: 'AD Health', label: 'Time sync status', command: 'w32tm /query /status', description: 'NTP time sync status — source, offset, stratum' },
  { category: 'AD Health', label: 'Time sync peers', command: 'w32tm /query /peers', description: 'NTP peers configured on this DC' },
  { category: 'AD Health', label: 'Time offset from PDC', command: 'w32tm /stripchart /computer:<PDCname> /samples:3', description: 'Measure clock offset between this DC and the PDC emulator' },
  { category: 'AD Health', label: 'Resync time', command: 'w32tm /resync /force', description: 'Force immediate NTP time resynchronization' },
  { category: 'AD Health', label: 'Secure channel verify', command: 'nltest /sc_verify:<domain>', description: 'Verify the secure channel between this machine and the DC' },
  { category: 'AD Health', label: 'Find DC for domain', command: 'nltest /dsgetdc:<domain>', description: 'Discover which DC this machine is using for authentication' },
  { category: 'AD Health', label: 'Discover all DCs', command: 'nltest /dclist:<domain>', description: 'List all domain controllers registered for the domain' },
  { category: 'AD Health', label: 'AD database size', command: 'Get-Item "C:\\Windows\\NTDS\\ntds.dit" | Select-Object Name,@{N="SizeMB";E={[math]::Round($_.Length/1MB,1)}}', description: '(PS) Size of the AD database file' },
  { category: 'AD Health', label: 'AD event errors', command: 'Get-WinEvent -LogName "Directory Service" -MaxEvents 30 | Where-Object {$_.Level -le 2} | Format-Table TimeCreated,Message -AutoSize', description: '(PS) Recent AD errors and warnings from Directory Services log' },
  { category: 'AD Health', label: 'Replication event errors', command: 'Get-WinEvent -LogName "DFS Replication" -MaxEvents 20 | Where-Object {$_.Level -le 2} | Format-Table TimeCreated,Message -AutoSize', description: '(PS) Recent DFSR/SYSVOL replication errors' },
  { category: 'AD Health', label: 'KDC service check', command: 'Get-Service KDC | Select-Object Name,Status; klist purge', description: '(PS) Kerberos KDC service status and flush Kerberos ticket cache' },
  { category: 'AD Health', label: 'Global Catalog check', command: 'Get-ADDomainController -Filter {IsGlobalCatalog -eq $true} | Select-Object Name,IPv4Address,Site | Format-Table -AutoSize', description: '(PS) All Global Catalog servers' },
  { category: 'AD Health', label: 'Sites and subnets', command: 'Get-ADReplicationSite -Filter * | Select-Object Name,Description | Format-Table -AutoSize', description: '(PS) All AD sites' },
  { category: 'AD Health', label: 'Site link replication', command: 'Get-ADReplicationSiteLink -Filter * | Select-Object Name,Cost,ReplicationFrequencyInMinutes | Format-Table -AutoSize', description: '(PS) Replication schedule and cost between sites' },
  // Active Directory
  { category: 'Active Directory', label: 'Get user', command: 'Get-ADUser -Identity <username> -Properties *', description: '(PS) Full details of an AD user' },
  { category: 'Active Directory', label: 'Search users', command: 'Get-ADUser -Filter {Name -like "*<keyword>*"} | Select-Object Name,SamAccountName,Enabled', description: '(PS) Find users by name' },
  { category: 'Active Directory', label: 'Disabled users', command: 'Get-ADUser -Filter {Enabled -eq $false} | Select-Object Name,SamAccountName | Format-Table -AutoSize', description: '(PS) All disabled AD accounts' },
  { category: 'Active Directory', label: 'Enable user', command: 'Enable-ADAccount -Identity <username>', description: '(PS) Enable a disabled AD account' },
  { category: 'Active Directory', label: 'Disable user', command: 'Disable-ADAccount -Identity <username>', description: '(PS) Disable an AD account' },
  { category: 'Active Directory', label: 'Reset password', command: 'Set-ADAccountPassword -Identity <username> -Reset -NewPassword (ConvertTo-SecureString "<NewPass>" -AsPlainText -Force)', description: '(PS) Reset a user password' },
  { category: 'Active Directory', label: 'Unlock account', command: 'Unlock-ADAccount -Identity <username>', description: '(PS) Unlock a locked-out AD account' },
  { category: 'Active Directory', label: 'Locked accounts', command: 'Search-ADAccount -LockedOut | Select-Object Name,SamAccountName,LockedOut | Format-Table -AutoSize', description: '(PS) All currently locked-out accounts' },
  { category: 'Active Directory', label: 'User group membership', command: 'Get-ADPrincipalGroupMembership <username> | Select-Object Name | Sort-Object Name', description: '(PS) Groups a user belongs to' },
  { category: 'Active Directory', label: 'Add user to group', command: 'Add-ADGroupMember -Identity "<GroupName>" -Members <username>', description: '(PS) Add user to an AD group' },
  { category: 'Active Directory', label: 'Remove from group', command: 'Remove-ADGroupMember -Identity "<GroupName>" -Members <username> -Confirm:$false', description: '(PS) Remove user from a group' },
  { category: 'Active Directory', label: 'List group members', command: 'Get-ADGroupMember -Identity "<GroupName>" | Select-Object Name,SamAccountName | Format-Table -AutoSize', description: '(PS) Members of an AD group' },
  { category: 'Active Directory', label: 'Expiring passwords', command: 'Get-ADUser -Filter {PasswordNeverExpires -eq $false -and Enabled -eq $true} -Properties PasswordLastSet,PasswordExpired | Where-Object {$_.PasswordExpired -eq $true} | Select-Object Name,PasswordLastSet', description: '(PS) Users with expired passwords' },
  { category: 'Active Directory', label: 'Password never expires', command: 'Get-ADUser -Filter {PasswordNeverExpires -eq $true -and Enabled -eq $true} | Select-Object Name,SamAccountName | Format-Table -AutoSize', description: '(PS) Enabled accounts with non-expiring password' },
  { category: 'Active Directory', label: 'Inactive users (90d)', command: 'Get-ADUser -Filter {LastLogonDate -lt (Get-Date).AddDays(-90) -and Enabled -eq $true} -Properties LastLogonDate | Select-Object Name,LastLogonDate | Sort-Object LastLogonDate', description: '(PS) Users not logged in for 90+ days' },
  { category: 'Active Directory', label: 'Force AD sync', command: 'Start-ADSyncSyncCycle -PolicyType Delta', description: '(PS) Trigger delta sync (Azure AD Connect)' },
  { category: 'Active Directory', label: 'Force full AD sync', command: 'Start-ADSyncSyncCycle -PolicyType Initial', description: '(PS) Trigger full sync (Azure AD Connect)' },
  { category: 'Active Directory', label: 'AD replication status', command: 'repadmin /replsummary', description: 'Replication summary across all DCs' },
  { category: 'Active Directory', label: 'Replication errors', command: 'repadmin /showrepl * /errorsonly', description: 'Only DCs with replication errors' },
  { category: 'Active Directory', label: 'Force replication', command: 'repadmin /syncall /AdeP', description: 'Force sync all DCs immediately' },
  { category: 'Active Directory', label: 'Check DC health', command: 'dcdiag /test:replications /v', description: 'Diagnose DC replication issues' },
  { category: 'Active Directory', label: 'Discover DCs', command: 'nltest /dclist:<domain>', description: 'List all domain controllers for a domain' },
  { category: 'Active Directory', label: 'FSMO roles', command: 'netdom query fsmo', description: 'Which DC holds each FSMO role' },
  { category: 'Active Directory', label: 'AD recycle bin', command: 'Get-ADObject -Filter {isDeleted -eq $true} -IncludeDeletedObjects | Select-Object Name,WhenChanged | Sort-Object WhenChanged -Descending | Select-Object -First 20', description: '(PS) Recently deleted AD objects' },
  { category: 'Active Directory', label: 'Restore deleted object', command: 'Restore-ADObject -Identity "<DistinguishedName>"', description: '(PS) Restore from AD recycle bin' },
  // GPO
  { category: 'GPO', label: 'List all GPOs', command: 'Get-GPO -All | Select-Object DisplayName,GpoStatus,CreationTime | Format-Table -AutoSize', description: '(PS) All Group Policy Objects' },
  { category: 'GPO', label: 'GPO details', command: 'Get-GPO -Name "<GPOName>" | Format-List', description: '(PS) Details of a specific GPO' },
  { category: 'GPO', label: 'GPO report (HTML)', command: 'Get-GPOReport -Name "<GPOName>" -ReportType HTML -Path "C:\\gpo-report.html"', description: '(PS) Export GPO settings to HTML' },
  { category: 'GPO', label: 'GPO links on OU', command: 'Get-GPInheritance -Target "<OU=...,DC=domain,DC=com>"', description: '(PS) GPOs linked to an OU' },
  { category: 'GPO', label: 'Force GP update', command: 'gpupdate /force', description: 'Force immediate Group Policy refresh' },
  { category: 'GPO', label: 'GP update remote', command: 'Invoke-GPUpdate -Computer "<ComputerName>" -Force', description: '(PS) Force GP update on remote machine' },
  { category: 'GPO', label: 'GP result (current user)', command: 'gpresult /r', description: 'Applied GPOs for current user/computer' },
  { category: 'GPO', label: 'GP result (HTML)', command: 'gpresult /H "C:\\gpresult.html" /F', description: 'Full GP result report as HTML' },
  { category: 'GPO', label: 'GP result for user', command: 'gpresult /User <username> /r', description: 'Applied GPOs for a specific user' },
  { category: 'GPO', label: 'Backup all GPOs', command: 'Backup-GPO -All -Path "C:\\GPO-Backup"', description: '(PS) Backup all GPOs to folder' },
  { category: 'GPO', label: 'Restore GPO', command: 'Restore-GPO -Name "<GPOName>" -Path "C:\\GPO-Backup"', description: '(PS) Restore a GPO from backup' },
  { category: 'GPO', label: 'Disabled GPOs', command: 'Get-GPO -All | Where-Object {$_.GpoStatus -ne "AllSettingsEnabled"} | Select-Object DisplayName,GpoStatus', description: '(PS) GPOs that are partially or fully disabled' },
  // DNS
  { category: 'DNS', label: 'List DNS zones', command: 'Get-DnsServerZone | Format-Table -AutoSize', description: '(PS) All DNS zones on this server' },
  { category: 'DNS', label: 'DNS records in zone', command: 'Get-DnsServerResourceRecord -ZoneName "<zone.com>" | Format-Table -AutoSize', description: '(PS) All records in a DNS zone' },
  { category: 'DNS', label: 'Find A record', command: 'Get-DnsServerResourceRecord -ZoneName "<zone.com>" -RRType A | Where-Object {$_.HostName -like "*<keyword>*"}', description: '(PS) Find A records by hostname' },
  { category: 'DNS', label: 'Add A record', command: 'Add-DnsServerResourceRecordA -ZoneName "<zone.com>" -Name "<hostname>" -IPv4Address "<IP>"', description: '(PS) Create a new A record' },
  { category: 'DNS', label: 'Add CNAME record', command: 'Add-DnsServerResourceRecordCName -ZoneName "<zone.com>" -Name "<alias>" -HostNameAlias "<target.zone.com>"', description: '(PS) Create a CNAME record' },
  { category: 'DNS', label: 'Delete DNS record', command: 'Remove-DnsServerResourceRecord -ZoneName "<zone.com>" -RRType A -Name "<hostname>" -Force', description: '(PS) Remove an A record' },
  { category: 'DNS', label: 'DNS server stats', command: 'Get-DnsServerStatistics | Select-Object *Query* | Format-List', description: '(PS) DNS query statistics' },
  { category: 'DNS', label: 'Clear DNS cache', command: 'Clear-DnsServerCache -Force', description: '(PS) Flush DNS server cache' },
  { category: 'DNS', label: 'Flush local DNS', command: 'ipconfig /flushdns', description: 'Flush DNS resolver cache on this machine' },
  { category: 'DNS', label: 'DNS forwarders', command: 'Get-DnsServerForwarder | Format-Table -AutoSize', description: '(PS) Configured DNS forwarders' },
  { category: 'DNS', label: 'Lookup via server', command: 'nslookup <hostname> <dns-server-ip>', description: 'Query a specific DNS server' },
  { category: 'DNS', label: 'Reverse lookup zone', command: 'Get-DnsServerZone | Where-Object {$_.IsReverseLookupZone -eq $true}', description: '(PS) List all reverse lookup zones' },
  // DHCP
  { category: 'DHCP', label: 'List DHCP scopes', command: 'Get-DhcpServerv4Scope | Format-Table -AutoSize', description: '(PS) All IPv4 DHCP scopes' },
  { category: 'DHCP', label: 'Scope statistics', command: 'Get-DhcpServerv4ScopeStatistics | Format-Table -AutoSize', description: '(PS) Free/used leases per scope' },
  { category: 'DHCP', label: 'Active leases', command: 'Get-DhcpServerv4Lease -ScopeId <scope-ip> | Format-Table -AutoSize', description: '(PS) Active leases in a scope' },
  { category: 'DHCP', label: 'Find lease by IP', command: 'Get-DhcpServerv4Lease -ScopeId <scope-ip> | Where-Object {$_.IPAddress -eq "<IP>"}', description: '(PS) Find lease for a specific IP' },
  { category: 'DHCP', label: 'Find lease by MAC', command: 'Get-DhcpServerv4Lease -ScopeId <scope-ip> | Where-Object {$_.ClientId -eq "<MAC>"}', description: '(PS) Find lease by MAC address' },
  { category: 'DHCP', label: 'DHCP reservations', command: 'Get-DhcpServerv4Reservation -ScopeId <scope-ip> | Format-Table -AutoSize', description: '(PS) All reservations in a scope' },
  { category: 'DHCP', label: 'Add reservation', command: 'Add-DhcpServerv4Reservation -ScopeId <scope-ip> -IPAddress <IP> -ClientId <MAC> -Description "<Name>"', description: '(PS) Create a DHCP reservation' },
  { category: 'DHCP', label: 'Remove reservation', command: 'Remove-DhcpServerv4Reservation -ScopeId <scope-ip> -IPAddress <IP>', description: '(PS) Delete a DHCP reservation' },
  { category: 'DHCP', label: 'DHCP failover status', command: 'Get-DhcpServerv4Failover | Format-Table -AutoSize', description: '(PS) DHCP failover relationship status' },
  { category: 'DHCP', label: 'Restart DHCP service', command: 'Restart-Service DHCPServer', description: 'Restart the DHCP Server service' },
  // IIS
  { category: 'IIS', label: 'List websites', command: 'Get-Website | Format-Table -AutoSize', description: '(PS) All IIS websites and their state' },
  { category: 'IIS', label: 'List app pools', command: 'Get-WebConfiguration system.applicationHost/applicationPools/add | Select-Object name,state,managedRuntimeVersion | Format-Table -AutoSize', description: '(PS) All application pools' },
  { category: 'IIS', label: 'Start website', command: 'Start-Website -Name "<SiteName>"', description: '(PS) Start a stopped IIS website' },
  { category: 'IIS', label: 'Stop website', command: 'Stop-Website -Name "<SiteName>"', description: '(PS) Stop a running IIS website' },
  { category: 'IIS', label: 'Restart app pool', command: 'Restart-WebAppPool -Name "<AppPoolName>"', description: '(PS) Recycle an application pool' },
  { category: 'IIS', label: 'Stop app pool', command: 'Stop-WebAppPool -Name "<AppPoolName>"', description: '(PS) Stop an application pool' },
  { category: 'IIS', label: 'Start app pool', command: 'Start-WebAppPool -Name "<AppPoolName>"', description: '(PS) Start a stopped app pool' },
  { category: 'IIS', label: 'IIS error log', command: 'Get-Content "C:\\inetpub\\logs\\LogFiles\\W3SVC1\\*.log" | Select-Object -Last 100', description: 'Last 100 lines of IIS access log' },
  { category: 'IIS', label: 'Restart IIS', command: 'iisreset', description: 'Restart all IIS services' },
  { category: 'IIS', label: 'IIS bindings', command: 'Get-WebBinding | Format-Table -AutoSize', description: '(PS) All IIS site bindings (hostname, port, SSL)' },
  { category: 'IIS', label: 'SSL certificates', command: 'Get-ChildItem -Path Cert:\\LocalMachine\\My | Select-Object Subject,Thumbprint,NotAfter | Format-Table -AutoSize', description: '(PS) Installed SSL certs and expiry dates' },
  { category: 'IIS', label: 'Failed request tracing', command: 'Get-WebConfiguration system.webServer/tracing/traceFailedRequests/add -PSPath "IIS:\\Sites\\<SiteName>"', description: '(PS) Failed request tracing rules' },
]

async function commandRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /commands — list all, optionally filtered by os
  fastify.get('/commands', { preHandler: requireAuth }, async (req) => {
    const { os } = z.object({ os: z.enum(['windows', 'linux']).optional() }).parse(req.query)
    let q = (db as any).selectFrom('command_library').selectAll().orderBy('os').orderBy('category').orderBy('sort_order').orderBy('label')
    if (os) q = q.where('os', '=', os)
    return q.execute()
  })

  // POST /commands — create
  fastify.post('/commands', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({
      os:          z.enum(['windows', 'linux']),
      category:    z.string().min(1).max(50).transform(s => s.trim()),
      label:       z.string().min(1).max(200),
      command:     z.string().min(1),
      description: z.string().max(500).optional(),
      sort_order:  z.number().int().default(0),
    }).parse(req.body)
    const [row] = await (db as any).insertInto('command_library').values({ ...body, updated_at: new Date() }).returning('id').execute()
    return reply.code(201).send(row)
  })

  // PUT /commands/:id — update
  fastify.put('/commands/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      os:          z.enum(['windows', 'linux']).optional(),
      category:    z.string().min(1).max(50).transform(s => s.trim()).optional(),
      label:       z.string().min(1).max(200).optional(),
      command:     z.string().min(1).optional(),
      description: z.string().max(500).optional(),
      sort_order:  z.number().int().optional(),
    }).parse(req.body)
    await (db as any).updateTable('command_library').set({ ...body, updated_at: new Date() }).where('id', '=', id).execute()
    return reply.code(204).send()
  })

  // DELETE /commands/:id
  fastify.delete('/commands/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await (db as any).deleteFrom('command_library').where('id', '=', id).execute()
    return reply.code(204).send()
  })

  // POST /commands/seed — load defaults (skips if data already exists)
  fastify.post('/commands/seed', { preHandler: requireAuth }, async (req, reply) => {
    const existing = await (db as any).selectFrom('command_library').select((db as any).fn.count('id').as('n')).executeTakeFirst()
    if (Number(existing?.n) > 0) return reply.code(200).send({ skipped: true, message: 'Commands already seeded' })

    const windows = DEFAULT_WINDOWS.map((c, i) => ({ ...c, os: 'windows', sort_order: i, updated_at: new Date() }))
    const linux   = DEFAULT_LINUX.map((c, i)   => ({ ...c, os: 'linux',   sort_order: i, updated_at: new Date() }))
    await (db as any).insertInto('command_library').values([...windows, ...linux]).execute()
    return { seeded: windows.length + linux.length }
  })

  // POST /commands/seed-more — insert only commands whose label+os don't exist yet (safe to call anytime)
  fastify.post('/commands/seed-more', { preHandler: requireAuth }, async (req, reply) => {
    const extra = EXTRA_WINDOWS.map((c, i) => ({ ...c, os: 'windows', sort_order: 1000 + i, updated_at: new Date() }))
    let inserted = 0
    for (const cmd of extra) {
      const exists = await (db as any).selectFrom('command_library')
        .select('id').where('os', '=', cmd.os).where('label', '=', cmd.label).executeTakeFirst()
      if (!exists) {
        await (db as any).insertInto('command_library').values(cmd).execute()
        inserted++
      }
    }
    return { inserted }
  })
}

export default commandRoutes
