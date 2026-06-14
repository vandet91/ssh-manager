/**
 * Best-practice recommendations engine.
 *
 * Given the list of installed software and server hardware specs (RAM in MB,
 * CPU core count) this module produces per-software recommendation objects
 * that can be shown in the UI with explanations and ready-to-paste config
 * snippets.
 */

export type RecSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type RecCategory = 'performance' | 'security' | 'stability' | 'monitoring'

export interface Recommendation {
  id: string
  software: string
  category: RecCategory
  severity: RecSeverity
  title: string
  description: string
  /** The setting name / directive */
  parameter?: string
  /** What we recommend the value should be */
  recommended?: string
  /** Human-readable explanation of why */
  rationale: string
  /** Ready-to-use config snippet */
  snippet?: string
  /** Official docs or reference URL */
  reference?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mb(n: number) { return `${n}M` }
function humanMb(n: number) { return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB` }

/** Parse the first number from a free-form memory string like "MemTotal: 4096MB" or just "4096" */
function parseRamMb(raw: string): number {
  const kb = raw.match(/MemTotal:\s*(\d+)\s*kB/i)
  if (kb) return Math.round(parseInt(kb[1]) / 1024)
  const mb2 = raw.match(/(\d+)\s*MB/i)
  if (mb2) return parseInt(mb2[1])
  const plain = raw.match(/(\d+)/)
  if (plain) return parseInt(plain[1])
  return 1024  // safe fallback
}

// ── Per-software recommendation generators ────────────────────────────────────

function phpRecs(ramMb: number, version: string | null): Recommendation[] {
  const memLimit = Math.max(128, Math.round(ramMb / 8))
  const opcacheMem = Math.min(256, Math.max(64, Math.round(ramMb / 16)))
  const ver = version ?? '8.x'
  const recs: Recommendation[] = [
    {
      id: 'php-memory-limit',
      software: 'PHP',
      category: 'performance',
      severity: 'high',
      title: 'Set memory_limit based on available RAM',
      description: `With ${humanMb(ramMb)} of RAM, PHP processes should be capped at ${memLimit}M each.`,
      parameter: 'memory_limit',
      recommended: mb(memLimit),
      rationale: 'Too low causes fatal errors in large apps; too high risks OOM when many workers run concurrently.',
      snippet: `; php.ini\nmemory_limit = ${memLimit}M`,
    },
    {
      id: 'php-opcache',
      software: 'PHP',
      category: 'performance',
      severity: 'high',
      title: 'Enable OPcache',
      description: 'OPcache caches compiled PHP bytecode, dramatically reducing CPU and response time.',
      parameter: 'opcache.enable',
      recommended: '1',
      rationale: 'Without OPcache every request re-parses and compiles PHP source. Enabling it is the single biggest performance win for PHP.',
      snippet: `; php.ini\nopcache.enable = 1\nopcache.enable_cli = 0\nopcache.memory_consumption = ${opcacheMem}\nopcache.interned_strings_buffer = 16\nopcache.max_accelerated_files = 10000\nopcache.validate_timestamps = 0\nopcache.revalidate_freq = 0`,
      reference: 'https://www.php.net/manual/en/opcache.configuration.php',
    },
    {
      id: 'php-expose',
      software: 'PHP',
      category: 'security',
      severity: 'medium',
      title: 'Hide PHP version from HTTP headers',
      parameter: 'expose_php',
      recommended: 'Off',
      rationale: 'The X-Powered-By header reveals your PHP version, aiding targeted exploits.',
      description: 'Disabling expose_php removes the X-Powered-By: PHP/x.x.x response header.',
      snippet: '; php.ini\nexpose_php = Off',
    },
    {
      id: 'php-display-errors',
      software: 'PHP',
      category: 'security',
      severity: 'critical',
      title: 'Disable display_errors in production',
      parameter: 'display_errors',
      recommended: 'Off',
      rationale: 'Displaying errors leaks internal paths, DB credentials, and code logic to end-users.',
      description: 'Error output should go to logs only, never to the browser in production.',
      snippet: '; php.ini\ndisplay_errors = Off\nlog_errors = On\nerror_log = /var/log/php/error.log',
    },
    {
      id: 'php-upload-size',
      software: 'PHP',
      category: 'stability',
      severity: 'medium',
      title: 'Align upload_max_filesize and post_max_size',
      description: 'Both values must be set consistently; post_max_size must be larger than upload_max_filesize.',
      parameter: 'upload_max_filesize',
      recommended: '64M',
      rationale: 'Mismatched values cause silent upload failures that are hard to debug.',
      snippet: '; php.ini\nupload_max_filesize = 64M\npost_max_size = 72M\nmax_execution_time = 300\nmax_input_time = 300',
    },
    {
      id: 'php-session-security',
      software: 'PHP',
      category: 'security',
      severity: 'high',
      title: 'Harden PHP session settings',
      description: 'Default session settings are permissive; several tweaks reduce session hijacking risk.',
      rationale: 'session.cookie_httponly prevents JavaScript access; session.cookie_secure enforces HTTPS cookies.',
      snippet: `; php.ini\nsession.cookie_httponly = 1\nsession.cookie_secure = 1\nsession.cookie_samesite = Strict\nsession.use_strict_mode = 1\nsession.gc_maxlifetime = 1440`,
      reference: `https://www.php.net/manual/en/session.security.ini.php`,
    },
    {
      id: 'php-fpm-pm',
      software: 'PHP',
      category: 'performance',
      severity: 'medium',
      title: 'Tune PHP-FPM process manager for available RAM',
      description: `With ${humanMb(ramMb)}, set pm=dynamic with max_children based on per-process memory usage (~${memLimit}M each).`,
      parameter: 'pm.max_children',
      recommended: `${Math.max(2, Math.floor((ramMb * 0.7) / memLimit))}`,
      rationale: 'Too many workers exhaust RAM causing swap, degrading the whole server. Too few creates a request queue.',
      snippet: `; /etc/php/${ver}/fpm/pool.d/www.conf\npm = dynamic\npm.max_children = ${Math.max(2, Math.floor((ramMb * 0.7) / memLimit))}\npm.start_servers = ${Math.max(1, Math.floor(Math.max(2, Math.floor((ramMb * 0.7) / memLimit)) / 4))}\npm.min_spare_servers = ${Math.max(1, Math.floor(Math.max(2, Math.floor((ramMb * 0.7) / memLimit)) / 4))}\npm.max_spare_servers = ${Math.max(2, Math.floor(Math.max(2, Math.floor((ramMb * 0.7) / memLimit)) / 2))}\npm.max_requests = 500`,
      reference: 'https://www.php.net/manual/en/install.fpm.configuration.php',
    },
  ]
  return recs
}

function nginxRecs(ramMb: number, cpuCount: number): Recommendation[] {
  const workerConnections = Math.min(4096, cpuCount * 1024)
  return [
    {
      id: 'nginx-worker-processes',
      software: 'Nginx',
      category: 'performance',
      severity: 'medium',
      title: 'Set worker_processes to auto',
      parameter: 'worker_processes',
      recommended: 'auto',
      rationale: '"auto" detects CPU cores at startup and spawns one worker per core, maximising parallelism.',
      description: `This server has ${cpuCount} CPU core(s). "auto" is always the best choice.`,
      snippet: '# /etc/nginx/nginx.conf\nworker_processes auto;',
    },
    {
      id: 'nginx-worker-connections',
      software: 'Nginx',
      category: 'performance',
      severity: 'medium',
      title: 'Tune worker_connections',
      parameter: 'worker_connections',
      recommended: `${workerConnections}`,
      rationale: 'Maximum simultaneous connections per worker. Must not exceed the system ulimit for open files.',
      description: `Recommended ${workerConnections} for ${cpuCount}-core server.`,
      snippet: `# /etc/nginx/nginx.conf  (events block)\nevents {\n    worker_connections ${workerConnections};\n    use epoll;\n    multi_accept on;\n}`,
    },
    {
      id: 'nginx-gzip',
      software: 'Nginx',
      category: 'performance',
      severity: 'medium',
      title: 'Enable gzip compression',
      parameter: 'gzip',
      recommended: 'on',
      rationale: 'Gzip reduces response sizes by 60–80% for text content, saving bandwidth and improving load times.',
      description: 'Enable for HTML, CSS, JS, JSON, XML, fonts.',
      snippet: `# /etc/nginx/nginx.conf  (http block)\ngzip on;\ngzip_vary on;\ngzip_proxied any;\ngzip_comp_level 6;\ngzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;`,
    },
    {
      id: 'nginx-server-tokens',
      software: 'Nginx',
      category: 'security',
      severity: 'medium',
      title: 'Hide Nginx version in error pages and headers',
      parameter: 'server_tokens',
      recommended: 'off',
      rationale: 'Exposes Nginx version in Server: header and error pages, aiding attackers in targeting known CVEs.',
      description: 'Set server_tokens off in the http block.',
      snippet: '# /etc/nginx/nginx.conf  (http block)\nserver_tokens off;',
    },
    {
      id: 'nginx-security-headers',
      software: 'Nginx',
      category: 'security',
      severity: 'high',
      title: 'Add security headers to all responses',
      description: 'Security headers protect against XSS, clickjacking, MIME sniffing, and information leakage.',
      rationale: 'A single missing header can expose users to client-side attacks.',
      snippet: `# /etc/nginx/nginx.conf  (http block)\nadd_header X-Frame-Options SAMEORIGIN always;\nadd_header X-Content-Type-Options nosniff always;\nadd_header X-XSS-Protection "1; mode=block" always;\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;\nadd_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;`,
    },
    {
      id: 'nginx-keepalive',
      software: 'Nginx',
      category: 'performance',
      severity: 'low',
      title: 'Set keepalive_timeout',
      parameter: 'keepalive_timeout',
      recommended: '65',
      rationale: 'Keep-alive reuses TCP connections for multiple requests, reducing connection overhead.',
      description: '65 seconds is a reasonable default for production web traffic.',
      snippet: '# /etc/nginx/nginx.conf  (http block)\nkeepalive_timeout 65;\nkeepalive_requests 1000;',
    },
    {
      id: 'nginx-client-body',
      software: 'Nginx',
      category: 'security',
      severity: 'medium',
      title: 'Limit client request body size',
      parameter: 'client_max_body_size',
      recommended: '16m',
      rationale: 'Unbounded uploads can exhaust disk space and memory. Set to match your application\'s needs.',
      description: 'Adjust to match your app\'s maximum file upload requirement.',
      snippet: '# /etc/nginx/nginx.conf  (http block)\nclient_max_body_size 16m;\nclient_body_timeout 30s;\nclient_header_timeout 30s;',
    },
    {
      id: 'nginx-rate-limit',
      software: 'Nginx',
      category: 'security',
      severity: 'high',
      title: 'Add rate limiting to protect login and API endpoints',
      description: 'Rate limiting prevents brute-force attacks on authentication endpoints.',
      rationale: 'Without rate limiting, attackers can attempt thousands of passwords per second.',
      snippet: `# /etc/nginx/nginx.conf  (http block)\nlimit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;\n\n# Inside your server block, for login endpoint:\nlocation /login {\n    limit_req zone=login burst=10 nodelay;\n    limit_req_status 429;\n    # ... proxy_pass etc.\n}`,
      reference: 'https://nginx.org/en/docs/http/ngx_http_limit_req_module.html',
    },
    {
      id: 'nginx-ssl',
      software: 'Nginx',
      category: 'security',
      severity: 'critical',
      title: 'Use strong TLS configuration',
      description: 'Disable old TLS versions (1.0, 1.1) and weak ciphers.',
      rationale: 'TLS 1.0 and 1.1 are deprecated and vulnerable to attacks like POODLE and BEAST.',
      snippet: `# /etc/nginx/nginx.conf  (server block - HTTPS)\nssl_protocols TLSv1.2 TLSv1.3;\nssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;\nssl_prefer_server_ciphers off;\nssl_session_cache shared:SSL:10m;\nssl_session_timeout 1d;\nssl_session_tickets off;\n# HSTS (once confident)\nadd_header Strict-Transport-Security "max-age=63072000" always;`,
      reference: 'https://ssl-config.mozilla.org/',
    },
  ]
}

function apacheRecs(ramMb: number, cpuCount: number): Recommendation[] {
  const maxWorkers = Math.max(5, Math.floor((ramMb * 0.7) / 50))  // ~50MB per worker
  return [
    {
      id: 'apache-servertokens',
      software: 'Apache',
      category: 'security',
      severity: 'medium',
      title: 'Minimize version disclosure',
      parameter: 'ServerTokens',
      recommended: 'Prod',
      rationale: 'Exposes Apache version in response headers and error pages, helping attackers target CVEs.',
      description: '"Prod" shows only "Apache" in the Server header; pair with ServerSignature Off.',
      snippet: '# /etc/apache2/conf-enabled/security.conf\nServerTokens Prod\nServerSignature Off',
    },
    {
      id: 'apache-maxworkers',
      software: 'Apache',
      category: 'performance',
      severity: 'high',
      title: 'Tune MaxRequestWorkers based on RAM',
      parameter: 'MaxRequestWorkers',
      recommended: `${maxWorkers}`,
      rationale: 'Exceeding available memory causes swap, severely degrading performance.',
      description: `With ${humanMb(ramMb)} RAM, ~${maxWorkers} workers is safe (assuming ~50 MB/worker for prefork).`,
      snippet: `# /etc/apache2/mods-enabled/mpm_prefork.conf\n<IfModule mpm_prefork_module>\n    StartServers          ${Math.max(2, Math.floor(maxWorkers / 8))}\n    MinSpareServers       ${Math.max(2, Math.floor(maxWorkers / 8))}\n    MaxSpareServers       ${Math.max(4, Math.floor(maxWorkers / 4))}\n    MaxRequestWorkers     ${maxWorkers}\n    MaxConnectionsPerChild 1000\n</IfModule>`,
    },
    {
      id: 'apache-keepalive',
      software: 'Apache',
      category: 'performance',
      severity: 'medium',
      title: 'Enable KeepAlive with a short timeout',
      parameter: 'KeepAlive',
      recommended: 'On',
      rationale: 'KeepAlive reduces TCP handshake overhead for browsers that make multiple requests.',
      description: 'Keep timeout short (5s) to free workers quickly for other clients.',
      snippet: '# /etc/apache2/apache2.conf\nKeepAlive On\nMaxKeepAliveRequests 100\nKeepAliveTimeout 5',
    },
    {
      id: 'apache-security-headers',
      software: 'Apache',
      category: 'security',
      severity: 'high',
      title: 'Add security response headers',
      description: 'Add X-Frame-Options, X-Content-Type-Options, and other protective headers.',
      rationale: 'Missing security headers expose users to clickjacking, MIME-sniffing, and XSS attacks.',
      snippet: `# /etc/apache2/conf-enabled/security.conf\nHeader always set X-Frame-Options SAMEORIGIN\nHeader always set X-Content-Type-Options nosniff\nHeader always set X-XSS-Protection "1; mode=block"\nHeader always set Referrer-Policy "strict-origin-when-cross-origin"`,
    },
    {
      id: 'apache-directory',
      software: 'Apache',
      category: 'security',
      severity: 'high',
      title: 'Disable directory listing',
      parameter: 'Options',
      recommended: '-Indexes',
      rationale: 'Directory listing reveals file structure and potentially sensitive files to anyone.',
      description: 'Ensure Options -Indexes in your VirtualHost or .htaccess.',
      snippet: `# /etc/apache2/sites-available/your-site.conf\n<Directory /var/www/html>\n    Options -Indexes -Includes\n    AllowOverride All\n    Require all granted\n</Directory>`,
    },
    {
      id: 'apache-mod-evasive',
      software: 'Apache',
      category: 'security',
      severity: 'medium',
      title: 'Install mod_evasive for DDoS/brute-force protection',
      description: 'mod_evasive blocks IPs that make too many requests in a short period.',
      rationale: 'Provides basic protection against HTTP flood attacks and brute-force attempts.',
      snippet: '# Install:\napt install libapache2-mod-evasive\na2enmod evasive\n\n# /etc/apache2/mods-enabled/evasive.conf\n<IfModule mod_evasive20.c>\n    DOSHashTableSize    3097\n    DOSPageCount        5\n    DOSSiteCount        50\n    DOSPageInterval     1\n    DOSSiteInterval     1\n    DOSBlockingPeriod   10\n</IfModule>',
    },
  ]
}

function mysqlRecs(ramMb: number): Recommendation[] {
  const bufferPool = Math.round(ramMb * 0.7)
  const maxConn = Math.min(500, Math.max(50, Math.floor(ramMb / 8)))
  return [
    {
      id: 'mysql-innodb-buffer-pool',
      software: 'MySQL',
      category: 'performance',
      severity: 'critical',
      title: 'Set InnoDB buffer pool to 70% of RAM',
      parameter: 'innodb_buffer_pool_size',
      recommended: mb(bufferPool),
      rationale: 'The buffer pool is the most important MySQL setting — it caches data and indexes in memory. The default (128M) is nearly always too small.',
      description: `With ${humanMb(ramMb)} RAM, allocate ~${humanMb(bufferPool)} to the InnoDB buffer pool.`,
      snippet: `# /etc/mysql/mysql.conf.d/mysqld.cnf  [mysqld]\ninnodb_buffer_pool_size = ${bufferPool}M\ninnodb_buffer_pool_instances = ${Math.max(1, Math.floor(bufferPool / 1024))}`,
      reference: 'https://dev.mysql.com/doc/refman/8.0/en/innodb-buffer-pool.html',
    },
    {
      id: 'mysql-max-connections',
      software: 'MySQL',
      category: 'performance',
      severity: 'high',
      title: 'Set max_connections based on RAM',
      parameter: 'max_connections',
      recommended: `${maxConn}`,
      rationale: 'Each connection consumes memory. Too many can exhaust RAM; too few blocks applications.',
      description: `~${maxConn} connections is appropriate for ${humanMb(ramMb)} RAM.`,
      snippet: `# /etc/mysql/mysql.conf.d/mysqld.cnf\nmax_connections = ${maxConn}\nwait_timeout = 600\ninteractive_timeout = 600`,
    },
    {
      id: 'mysql-slow-query-log',
      software: 'MySQL',
      category: 'monitoring',
      severity: 'medium',
      title: 'Enable slow query log',
      parameter: 'slow_query_log',
      recommended: '1',
      rationale: 'The slow query log identifies queries taking longer than a threshold, revealing optimization opportunities.',
      description: 'Queries over 1 second are logged. Review regularly and add indexes.',
      snippet: `# /etc/mysql/mysql.conf.d/mysqld.cnf\nslow_query_log = 1\nslow_query_log_file = /var/log/mysql/slow.log\nlong_query_time = 1\nlog_queries_not_using_indexes = 1`,
    },
    {
      id: 'mysql-binlog',
      software: 'MySQL',
      category: 'stability',
      severity: 'high',
      title: 'Enable binary logging for point-in-time recovery',
      parameter: 'log_bin',
      recommended: 'mysql-bin',
      rationale: 'Binary logs allow point-in-time recovery after a disaster — essential for production databases.',
      description: 'Set expire_logs_days to prevent disk exhaustion.',
      snippet: `# /etc/mysql/mysql.conf.d/mysqld.cnf\nlog_bin = /var/log/mysql/mysql-bin.log\nbinlog_expire_logs_seconds = 604800\nmax_binlog_size = 100M\nsync_binlog = 1`,
    },
    {
      id: 'mysql-security-root',
      software: 'MySQL',
      category: 'security',
      severity: 'critical',
      title: 'Secure the MySQL root account and remove anonymous users',
      description: 'Run mysql_secure_installation to harden a fresh MySQL install.',
      rationale: 'Default MySQL installs have anonymous users and no root password — trivially exploitable.',
      snippet: `# Run on the server:\nmysql_secure_installation\n\n# Or manually:\nALTER USER 'root'@'localhost' IDENTIFIED BY 'strong_password_here';\nDELETE FROM mysql.user WHERE User='';\nDELETE FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost', '127.0.0.1', '::1');\nDROP DATABASE IF EXISTS test;\nFLUSH PRIVILEGES;`,
    },
    {
      id: 'mysql-bind-address',
      software: 'MySQL',
      category: 'security',
      severity: 'critical',
      title: 'Bind MySQL to localhost only',
      parameter: 'bind-address',
      recommended: '127.0.0.1',
      rationale: 'Binding to 0.0.0.0 exposes MySQL to the network — a common attack vector.',
      description: 'If remote access is needed, use SSH tunneling instead of opening port 3306.',
      snippet: `# /etc/mysql/mysql.conf.d/mysqld.cnf\nbind-address = 127.0.0.1`,
    },
  ]
}

function postgresRecs(ramMb: number, cpuCount: number): Recommendation[] {
  const sharedBuffers = Math.round(ramMb * 0.25)
  const effectiveCache = Math.round(ramMb * 0.75)
  const workMem = Math.max(4, Math.round(ramMb / 100))
  const maintenanceWorkMem = Math.round(ramMb / 16)
  return [
    {
      id: 'pg-shared-buffers',
      software: 'PostgreSQL',
      category: 'performance',
      severity: 'critical',
      title: 'Set shared_buffers to 25% of RAM',
      parameter: 'shared_buffers',
      recommended: mb(sharedBuffers),
      rationale: 'shared_buffers is PostgreSQL\'s primary data cache. The default (128MB) is far too small for any real workload.',
      description: `Allocate ${humanMb(sharedBuffers)} (25% of ${humanMb(ramMb)} RAM).`,
      snippet: `# postgresql.conf\nshared_buffers = ${sharedBuffers}MB`,
      reference: 'https://pgtune.leopard.in.ua/',
    },
    {
      id: 'pg-effective-cache-size',
      software: 'PostgreSQL',
      category: 'performance',
      severity: 'high',
      title: 'Set effective_cache_size to 75% of RAM',
      parameter: 'effective_cache_size',
      recommended: mb(effectiveCache),
      rationale: 'This hint tells the query planner how much memory is available for caching, enabling it to choose index scans over sequential scans.',
      description: `Set to ${humanMb(effectiveCache)} (75% of total RAM).`,
      snippet: `# postgresql.conf\neffective_cache_size = ${effectiveCache}MB`,
    },
    {
      id: 'pg-work-mem',
      software: 'PostgreSQL',
      category: 'performance',
      severity: 'medium',
      title: 'Tune work_mem for sorts and joins',
      parameter: 'work_mem',
      recommended: mb(workMem),
      rationale: 'work_mem is allocated per-sort/join-operation, per connection. Too high exhausts RAM; too low spills to disk.',
      description: `${workMem}MB balances performance and memory safety for ${humanMb(ramMb)} RAM.`,
      snippet: `# postgresql.conf\nwork_mem = ${workMem}MB\nmaintenance_work_mem = ${maintenanceWorkMem}MB`,
    },
    {
      id: 'pg-wal',
      software: 'PostgreSQL',
      category: 'stability',
      severity: 'high',
      title: 'Configure WAL for durability and archiving',
      description: 'Proper WAL configuration ensures data durability and enables point-in-time recovery.',
      rationale: 'The default WAL settings are conservative for safety but not optimal for performance or recoverability.',
      snippet: `# postgresql.conf\nwal_level = replica\nmax_wal_senders = 3\narchive_mode = on\narchive_command = 'test ! -f /var/lib/postgresql/wal/%f && cp %p /var/lib/postgresql/wal/%f'\ncheckpoint_completion_target = 0.9\nwal_buffers = 16MB`,
    },
    {
      id: 'pg-connections',
      software: 'PostgreSQL',
      category: 'performance',
      severity: 'medium',
      title: 'Use a connection pooler (PgBouncer)',
      description: 'PostgreSQL creates a new process per connection, which is expensive. Use PgBouncer in transaction mode.',
      rationale: 'Each Postgres connection uses ~5-10MB RAM. 100+ direct connections from app servers wastes resources.',
      snippet: `# Install PgBouncer:\napt install pgbouncer\n\n# /etc/pgbouncer/pgbouncer.ini\n[databases]\nmydb = host=127.0.0.1 port=5432 dbname=mydb\n\n[pgbouncer]\nlisten_port = 6432\nlisten_addr = 127.0.0.1\nauth_type = md5\npool_mode = transaction\nmax_client_conn = 200\ndefault_pool_size = ${Math.max(10, cpuCount * 5)}`,
      reference: 'https://www.pgbouncer.org/',
    },
    {
      id: 'pg-logging',
      software: 'PostgreSQL',
      category: 'monitoring',
      severity: 'medium',
      title: 'Enable slow query logging',
      parameter: 'log_min_duration_statement',
      recommended: '1000',
      rationale: 'Identifying slow queries (>1s) enables targeted optimization with EXPLAIN ANALYZE.',
      description: 'Log queries slower than 1000ms (1 second).',
      snippet: `# postgresql.conf\nlog_min_duration_statement = 1000\nlog_checkpoints = on\nlog_connections = off\nlog_disconnections = off\nlog_lock_waits = on`,
    },
    {
      id: 'pg-auth',
      software: 'PostgreSQL',
      category: 'security',
      severity: 'high',
      title: 'Use scram-sha-256 authentication',
      description: 'Replace md5 authentication with scram-sha-256 in pg_hba.conf.',
      rationale: 'MD5 hashes are weak and can be cracked offline. SCRAM-SHA-256 is the modern standard.',
      snippet: `# /etc/postgresql/*/main/pg_hba.conf\n# Change:\n# host all all 0.0.0.0/0 md5\n# To:\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n\n# Also in postgresql.conf:\npassword_encryption = scram-sha-256`,
    },
  ]
}

function redisRecs(ramMb: number): Recommendation[] {
  const maxMem = Math.round(ramMb * 0.3)
  return [
    {
      id: 'redis-maxmemory',
      software: 'Redis',
      category: 'stability',
      severity: 'critical',
      title: 'Set maxmemory to prevent OOM',
      parameter: 'maxmemory',
      recommended: mb(maxMem),
      rationale: 'Without a memory limit, Redis will consume all available RAM, causing the OS to OOM-kill processes.',
      description: `Cap Redis at ${humanMb(maxMem)} (30% of ${humanMb(ramMb)} RAM).`,
      snippet: `# /etc/redis/redis.conf\nmaxmemory ${maxMem}mb\nmaxmemory-policy allkeys-lru`,
    },
    {
      id: 'redis-eviction',
      software: 'Redis',
      category: 'performance',
      severity: 'high',
      title: 'Set an appropriate eviction policy',
      parameter: 'maxmemory-policy',
      recommended: 'allkeys-lru',
      rationale: 'Without an eviction policy, Redis returns errors when full. allkeys-lru removes least-recently-used keys.',
      description: 'Choose based on use case: allkeys-lru for cache, noeviction for message queue/session store.',
      snippet: `# /etc/redis/redis.conf\n# For cache workloads:\nmaxmemory-policy allkeys-lru\n\n# For session/queue (never lose data):\n# maxmemory-policy noeviction`,
    },
    {
      id: 'redis-requirepass',
      software: 'Redis',
      category: 'security',
      severity: 'critical',
      title: 'Set a strong password',
      parameter: 'requirepass',
      recommended: '<strong-password>',
      rationale: 'Redis without a password is trivially exploitable — attackers can read all data and write arbitrary keys.',
      description: 'Use a long random password (32+ characters).',
      snippet: `# /etc/redis/redis.conf\nrequirepass your_strong_password_here\n\n# Generate one:\n# openssl rand -base64 32`,
    },
    {
      id: 'redis-bind',
      software: 'Redis',
      category: 'security',
      severity: 'critical',
      title: 'Bind Redis to localhost only',
      parameter: 'bind',
      recommended: '127.0.0.1 ::1',
      rationale: 'Redis listening on 0.0.0.0 is exposed to the network. Thousands of Redis instances are compromised this way annually.',
      description: 'Never expose Redis port 6379 to the internet.',
      snippet: `# /etc/redis/redis.conf\nbind 127.0.0.1 ::1\nprotected-mode yes`,
    },
    {
      id: 'redis-persistence',
      software: 'Redis',
      category: 'stability',
      severity: 'medium',
      title: 'Configure persistence based on use case',
      description: 'Choose between RDB snapshots, AOF, or both depending on durability needs.',
      rationale: 'Wrong persistence settings risk data loss on crash or excessive disk I/O.',
      snippet: `# /etc/redis/redis.conf\n\n# For cache only (no persistence needed):\nsave ""\nappendonly no\n\n# For session store (some durability):\nsave 900 1\nsave 300 10\nsave 60 10000\n\n# For high durability (queue/critical data):\nappendonly yes\nappendfsync everysec`,
    },
    {
      id: 'redis-rename-commands',
      software: 'Redis',
      category: 'security',
      severity: 'high',
      title: 'Disable or rename dangerous commands',
      description: 'FLUSHALL, FLUSHDB, CONFIG, and DEBUG can be catastrophic if misused.',
      rationale: 'Disabling destructive commands prevents accidental or malicious data loss.',
      snippet: `# /etc/redis/redis.conf\nrename-command FLUSHALL ""\nrename-command FLUSHDB ""\nrename-command CONFIG ""\nrename-command DEBUG ""\nrename-command KEYS ""`,
    },
  ]
}

function systemRecs(ramMb: number, cpuCount: number): Recommendation[] {
  return [
    {
      id: 'sys-swappiness',
      software: 'System',
      category: 'performance',
      severity: 'medium',
      title: 'Lower vm.swappiness for servers',
      parameter: 'vm.swappiness',
      recommended: '10',
      rationale: 'The default (60) aggressively swaps RAM to disk. For a server with dedicated RAM, keeping data in memory is almost always faster.',
      description: '10 means the kernel only swaps under severe memory pressure.',
      snippet: `# Apply immediately:\nsysctl -w vm.swappiness=10\n\n# Persist on reboot:\necho 'vm.swappiness=10' >> /etc/sysctl.d/99-performance.conf\nsysctl -p /etc/sysctl.d/99-performance.conf`,
    },
    {
      id: 'sys-file-descriptors',
      software: 'System',
      category: 'stability',
      severity: 'medium',
      title: 'Increase open file descriptor limits',
      parameter: 'fs.file-max',
      recommended: '2097152',
      rationale: 'Web servers, databases, and Node.js apps can hit the default ulimit (1024), causing "Too many open files" errors.',
      description: 'Increase both the kernel limit and per-process limits.',
      snippet: `# /etc/sysctl.d/99-performance.conf\nfs.file-max = 2097152\n\n# /etc/security/limits.conf\n* soft nofile 65536\n* hard nofile 131072\nroot soft nofile 65536\nroot hard nofile 131072`,
    },
    {
      id: 'sys-tcp-tuning',
      software: 'System',
      category: 'performance',
      severity: 'low',
      title: 'Tune TCP stack for high-traffic web server',
      description: 'Kernel TCP parameters can significantly improve throughput under high concurrency.',
      rationale: 'Default TCP settings are conservative. These tweaks reduce latency and improve connection handling.',
      snippet: `# /etc/sysctl.d/99-performance.conf\nnet.core.somaxconn = 65535\nnet.ipv4.tcp_max_syn_backlog = 65535\nnet.ipv4.tcp_fin_timeout = 15\nnet.ipv4.tcp_keepalive_time = 300\nnet.ipv4.tcp_max_tw_buckets = 1440000\nnet.core.netdev_max_backlog = 65535\n\n# Apply:\nsysctl -p /etc/sysctl.d/99-performance.conf`,
    },
    {
      id: 'sys-fail2ban',
      software: 'System',
      category: 'security',
      severity: 'high',
      title: 'Install fail2ban to block brute-force attacks',
      description: 'fail2ban monitors log files and automatically bans IPs that show malicious signs (repeated failed logins).',
      rationale: 'Without fail2ban, every service is exposed to unlimited brute-force attempts.',
      snippet: `# Install:\napt install fail2ban\n\n# /etc/fail2ban/jail.local\n[DEFAULT]\nbantime = 3600\nmaxretry = 5\nfindtime = 600\n\n[sshd]\nenabled = true\nport = ssh\n\n[nginx-http-auth]\nenabled = true\n\nsystemctl enable --now fail2ban`,
    },
    {
      id: 'sys-ufw',
      software: 'System',
      category: 'security',
      severity: 'critical',
      title: 'Enable and configure firewall (UFW)',
      description: 'A firewall should allow only necessary ports and block everything else.',
      rationale: 'An unprotected server exposes all running services to the internet.',
      snippet: `# Setup UFW:\nufw default deny incoming\nufw default allow outgoing\nufw allow ssh\nufw allow 80/tcp\nufw allow 443/tcp\n# Add other ports as needed:\n# ufw allow 3306/tcp  # MySQL (only if remote access required)\nufw enable\nufw status verbose`,
    },
    {
      id: 'sys-unattended-upgrades',
      software: 'System',
      category: 'security',
      severity: 'high',
      title: 'Enable automatic security updates',
      description: 'Install unattended-upgrades to automatically apply security patches.',
      rationale: 'Most breaches exploit known, patched vulnerabilities. Automatic security updates close these windows quickly.',
      snippet: `# Install:\napt install unattended-upgrades\ndpkg-reconfigure --priority=low unattended-upgrades\n\n# /etc/apt/apt.conf.d/50unattended-upgrades\nUnattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Mail "admin@yourdomain.com";`,
    },
  ]
}

function dockerRecs(): Recommendation[] {
  return [
    {
      id: 'docker-rootless',
      software: 'Docker',
      category: 'security',
      severity: 'high',
      title: 'Run Docker in rootless mode or use user namespaces',
      description: 'Docker daemon runs as root by default, giving containers potential root access to the host.',
      rationale: 'Rootless Docker significantly reduces the blast radius of a container escape.',
      snippet: `# Enable rootless mode (install as non-root user):\ndockerd-rootless-setuptool.sh install\n\n# Or add userns-remap in daemon.json:\n# /etc/docker/daemon.json\n{\n  "userns-remap": "default"\n}`,
      reference: 'https://docs.docker.com/engine/security/rootless/',
    },
    {
      id: 'docker-log-rotation',
      software: 'Docker',
      category: 'stability',
      severity: 'medium',
      title: 'Configure container log rotation',
      description: 'Without log rotation, container logs can fill up the entire disk.',
      rationale: 'A single busy container can exhaust disk space if logging is unmanaged.',
      snippet: `# /etc/docker/daemon.json\n{\n  "log-driver": "json-file",\n  "log-opts": {\n    "max-size": "50m",\n    "max-file": "5"\n  }\n}\n\n# Restart Docker:\nsystemctl restart docker`,
    },
    {
      id: 'docker-resource-limits',
      software: 'Docker',
      category: 'stability',
      severity: 'high',
      title: 'Always set memory and CPU limits on containers',
      description: 'Containers without resource limits can starve the host and other containers.',
      rationale: 'A runaway container can consume all RAM and CPU, taking down all other services.',
      snippet: `# docker run example:\ndocker run -d \\\n  --memory="512m" \\\n  --memory-swap="512m" \\\n  --cpus="1.0" \\\n  your-image\n\n# docker-compose.yml example:\nservices:\n  app:\n    image: your-image\n    deploy:\n      resources:\n        limits:\n          cpus: '1.0'\n          memory: 512M`,
    },
    {
      id: 'docker-no-privileged',
      software: 'Docker',
      category: 'security',
      severity: 'critical',
      title: 'Never run containers with --privileged',
      description: 'Privileged containers have full access to the host kernel and devices.',
      rationale: 'A compromised privileged container can trivially escape to the host system.',
      snippet: `# Audit existing containers for privileged mode:\ndocker ps -q | xargs docker inspect --format='{{.Name}} privileged={{.HostConfig.Privileged}}'\n\n# If needed for specific capabilities, use --cap-add instead:\ndocker run --cap-add NET_ADMIN --cap-drop ALL your-image`,
    },
  ]
}

// ── Windows-specific recommendations ─────────────────────────────────────────

function windowsSystemRecs(ramMb: number, cpuCount: number, roles: string[]): Recommendation[] {
  const recs: Recommendation[] = [
    {
      id: 'win-updates',
      software: 'Windows',
      category: 'security',
      severity: 'critical',
      title: 'Enable automatic security updates',
      description: 'Windows Update should be configured to automatically install security patches.',
      rationale: 'Most Windows Server compromises exploit unpatched vulnerabilities. Automatic updates close these windows rapidly.',
      snippet: `# PowerShell — configure automatic updates:\nSet-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update" -Name AUOptions -Value 4\n\n# Or use Windows Update for Business via Group Policy / Intune for more control`,
    },
    {
      id: 'win-firewall',
      software: 'Windows',
      category: 'security',
      severity: 'critical',
      title: 'Ensure Windows Firewall is enabled and configured',
      description: 'Windows Firewall should be active on all profiles (Domain, Private, Public).',
      rationale: 'A disabled firewall exposes all listening ports to the network.',
      snippet: `# Check status:\nGet-NetFirewallProfile | Select Name, Enabled\n\n# Enable all profiles:\nSet-NetFirewallProfile -Profile Domain,Private,Public -Enabled True\n\n# Allow only necessary inbound ports (example):\nNew-NetFirewallRule -DisplayName "Allow RDP" -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Allow\nNew-NetFirewallRule -DisplayName "Allow HTTP" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow\nNew-NetFirewallRule -DisplayName "Allow HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow`,
    },
    {
      id: 'win-rdp-security',
      software: 'Windows',
      category: 'security',
      severity: 'high',
      title: 'Harden RDP access',
      description: 'Remote Desktop should require NLA and be protected by firewall rules.',
      rationale: 'RDP on port 3389 is one of the most targeted services on the internet. Without NLA, attackers can reach the login screen before authenticating.',
      snippet: `# Enable Network Level Authentication:\nSet-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" -Name UserAuthentication -Value 1\n\n# Restrict RDP to specific IPs via firewall:\nNew-NetFirewallRule -DisplayName "RDP restricted" -Direction Inbound -Protocol TCP -LocalPort 3389 -RemoteAddress "10.0.0.0/8" -Action Allow\nNew-NetFirewallRule -DisplayName "Block RDP public" -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Block`,
      reference: 'https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/clients/remote-desktop-allow-access',
    },
    {
      id: 'win-admin-rename',
      software: 'Windows',
      category: 'security',
      severity: 'medium',
      title: 'Rename the built-in Administrator account',
      description: 'Attackers always try "Administrator" first. Renaming it forces them to guess both username and password.',
      rationale: 'Default account names are part of every brute-force dictionary.',
      snippet: `# Rename built-in Administrator:\nRename-LocalUser -Name "Administrator" -NewName "SrvAdmin"\n\n# Disable the built-in Guest account:\nDisable-LocalUser -Name "Guest"`,
    },
    {
      id: 'win-password-policy',
      software: 'Windows',
      category: 'security',
      severity: 'high',
      title: 'Enforce a strong password policy',
      description: 'Minimum 12 characters, complexity, and history requirements.',
      rationale: 'Weak password policies allow trivial credential stuffing attacks.',
      snippet: `# Set via net accounts (basic):\nnet accounts /minpwlen:12 /maxpwage:90 /minpwage:1 /uniquepw:10\n\n# Or configure Group Policy:\n# Computer Configuration → Windows Settings → Security Settings → Account Policies → Password Policy`,
    },
    {
      id: 'win-audit-logging',
      software: 'Windows',
      category: 'monitoring',
      severity: 'high',
      title: 'Enable comprehensive audit logging',
      description: 'Log logon events, privilege use, object access, and policy changes.',
      rationale: 'Without audit logs you cannot detect or investigate security incidents.',
      snippet: `# Enable audit policies via auditpol:\nauditpol /set /category:"Logon/Logoff" /success:enable /failure:enable\nauditpol /set /category:"Account Logon" /success:enable /failure:enable\nauditpol /set /category:"Privilege Use" /success:enable /failure:enable\nauditpol /set /category:"Policy Change" /success:enable /failure:enable\nauditpol /set /subcategory:"Process Creation" /success:enable\n\n# Increase Security event log size:\nwevtutil sl Security /ms:204800000`,
    },
    {
      id: 'win-smb-hardening',
      software: 'Windows',
      category: 'security',
      severity: 'critical',
      title: 'Disable SMBv1 and harden SMB settings',
      description: 'SMBv1 is vulnerable to EternalBlue (WannaCry). Disable it immediately.',
      rationale: 'SMBv1 was used in the WannaCry and NotPetya ransomware attacks that caused billions in damages.',
      snippet: `# Disable SMBv1:\nSet-SmbServerConfiguration -EnableSMB1Protocol $false -Force\n\n# Verify:\nGet-SmbServerConfiguration | Select EnableSMB1Protocol, EnableSMB2Protocol\n\n# Require SMB signing:\nSet-SmbServerConfiguration -RequireSecuritySignature $true -Force\nSet-SmbClientConfiguration -RequireSecuritySignature $true -Force`,
      reference: 'https://learn.microsoft.com/en-us/windows-server/storage/file-server/troubleshoot/detect-enable-and-disable-smbv1-v2-v3',
    },
    {
      id: 'win-powershell-logging',
      software: 'Windows',
      category: 'monitoring',
      severity: 'medium',
      title: 'Enable PowerShell script block logging',
      description: 'Log all PowerShell script blocks — essential for detecting malicious activity.',
      rationale: 'PowerShell is the most common post-exploitation tool on Windows. Logging reveals exactly what attackers ran.',
      snippet: `# Enable via registry:\n$path = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging"\nNew-Item -Path $path -Force\nSet-ItemProperty -Path $path -Name EnableScriptBlockLogging -Value 1\n\n# Enable module logging too:\n$path2 = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ModuleLogging"\nNew-Item -Path $path2 -Force\nSet-ItemProperty -Path $path2 -Name EnableModuleLogging -Value 1`,
    },
    {
      id: 'win-page-file',
      software: 'Windows',
      category: 'performance',
      severity: 'medium',
      title: 'Configure page file appropriately',
      description: `With ${humanMb(ramMb)} RAM, the page file should be 1–1.5× RAM on the system drive, or moved to a dedicated data disk.`,
      rationale: 'A correctly sized page file prevents "out of virtual memory" crashes and allows crash dump collection.',
      snippet: `# Set page file to 1× RAM:\n$ram = [math]::Round((Get-WmiObject Win32_ComputerSystem).TotalPhysicalMemory / 1MB)\n$wmi = Get-WmiObject -Class Win32_PageFileSetting\n$wmi.InitialSize = $ram\n$wmi.MaximumSize = [math]::Round($ram * 1.5)\n$wmi.Put()`,
    },
    {
      id: 'win-defender',
      software: 'Windows',
      category: 'security',
      severity: 'high',
      title: 'Ensure Windows Defender / Antivirus is active',
      description: 'Real-time protection should be enabled and definitions should be current.',
      rationale: 'Antivirus with up-to-date signatures blocks known malware and ransomware.',
      snippet: `# Check Defender status:\nGet-MpComputerStatus | Select AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled\n\n# Update signatures:\nUpdate-MpSignature\n\n# Enable real-time protection:\nSet-MpPreference -DisableRealtimeMonitoring $false`,
    },
  ]

  // IIS-specific recs if IIS role is installed
  if (roles.some((r) => r.toLowerCase().includes('web-server') || r.toLowerCase().includes('w3svc'))) {
    recs.push(...iisRecs(ramMb))
  }

  return recs
}

function iisRecs(ramMb: number): Recommendation[] {
  return [
    {
      id: 'iis-request-filtering',
      software: 'IIS',
      category: 'security',
      severity: 'high',
      title: 'Enable and configure IIS Request Filtering',
      description: 'Request Filtering blocks malicious URLs, double-encoded requests, and HTTP verb tampering.',
      rationale: 'Request Filtering is the first line of defence against web-based attacks in IIS.',
      snippet: `# Install Request Filtering (usually enabled by default):\nInstall-WindowsFeature Web-Filtering\n\n# Configure via web.config:\n<system.webServer>\n  <security>\n    <requestFiltering>\n      <requestLimits maxAllowedContentLength="30000000" maxUrl="2048" maxQueryString="2048" />\n      <verbs allowUnlisted="false">\n        <add verb="GET" allowed="true" />\n        <add verb="POST" allowed="true" />\n        <add verb="HEAD" allowed="true" />\n      </verbs>\n    </requestFiltering>\n  </security>\n</system.webServer>`,
      reference: 'https://learn.microsoft.com/en-us/iis/configuration/system.webserver/security/requestfiltering/',
    },
    {
      id: 'iis-server-header',
      software: 'IIS',
      category: 'security',
      severity: 'medium',
      title: 'Remove IIS Server version header',
      description: 'IIS exposes its version in the Server: response header by default.',
      rationale: 'Version disclosure helps attackers identify vulnerable IIS versions to target.',
      snippet: `# Remove Server header via web.config:\n<system.webServer>\n  <security>\n    <requestFiltering removeServerHeader="true" />\n  </security>\n</system.webServer>\n\n# Or via PowerShell (IIS 10+):\nSet-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST' -filter "system.webServer/security/requestFiltering" -name "removeServerHeader" -value "True"`,
    },
    {
      id: 'iis-app-pool-identity',
      software: 'IIS',
      category: 'security',
      severity: 'high',
      title: 'Use ApplicationPoolIdentity for app pools',
      description: 'Each application pool should run as its own least-privilege identity.',
      rationale: 'Running app pools as NETWORK SERVICE or SYSTEM gives too much privilege — a compromised app can access all server resources.',
      snippet: `# Set app pool to ApplicationPoolIdentity (default in IIS 7.5+):\n$appPool = Get-Item "IIS:\\AppPools\\DefaultAppPool"\n$appPool.processModel.userName = ""\n$appPool.processModel.password = ""\n$appPool.processModel.identityType = 4  # ApplicationPoolIdentity\n$appPool | Set-Item`,
    },
    {
      id: 'iis-ssl',
      software: 'IIS',
      category: 'security',
      severity: 'critical',
      title: 'Enforce HTTPS and disable weak TLS versions',
      description: 'Disable TLS 1.0/1.1 and SSL 2/3 via registry. Use only TLS 1.2 and 1.3.',
      rationale: 'Old TLS versions are vulnerable to POODLE, BEAST, and DROWN attacks.',
      snippet: `# Disable SSL 3.0:\nNew-Item "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\SSL 3.0\\Server" -Force\nSet-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\SSL 3.0\\Server" -Name Enabled -Value 0\n\n# Disable TLS 1.0:\nNew-Item "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.0\\Server" -Force\nSet-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.0\\Server" -Name Enabled -Value 0\n\n# Disable TLS 1.1:\nNew-Item "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.1\\Server" -Force\nSet-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.1\\Server" -Name Enabled -Value 0\n\n# Restart server after making these changes\n# Consider using IIS Crypto (GUI tool) for easier management`,
      reference: 'https://www.nartac.com/Products/IISCrypto',
    },
    {
      id: 'iis-dynamic-compression',
      software: 'IIS',
      category: 'performance',
      severity: 'medium',
      title: 'Enable dynamic and static compression',
      description: 'GZip compression reduces response sizes by 60–80%, improving performance.',
      rationale: 'Without compression, every request transfers uncompressed HTML/CSS/JS, wasting bandwidth and increasing load times.',
      snippet: `# Enable compression features:\nInstall-WindowsFeature Web-Dyn-Compression, Web-Stat-Compression\n\n# Configure via web.config:\n<system.webServer>\n  <urlCompression doStaticCompression="true" doDynamicCompression="true" />\n</system.webServer>`,
    },
    {
      id: 'iis-output-cache',
      software: 'IIS',
      category: 'performance',
      severity: 'low',
      title: 'Configure output caching for static assets',
      description: `With ${humanMb(ramMb)} RAM, allocate some to IIS kernel-mode caching for static files.`,
      rationale: 'Kernel-mode caching serves static files without leaving kernel mode, giving maximum throughput.',
      snippet: `<system.webServer>\n  <caching enabled="true" enableKernelCache="true">\n    <profiles>\n      <add extension=".css" policy="CacheForTimePeriod" kernelCachePolicy="CacheForTimePeriod" duration="1:00:00" />\n      <add extension=".js" policy="CacheForTimePeriod" kernelCachePolicy="CacheForTimePeriod" duration="1:00:00" />\n      <add extension=".png" policy="CacheForTimePeriod" kernelCachePolicy="CacheForTimePeriod" duration="24:00:00" />\n    </profiles>\n  </caching>\n</system.webServer>`,
    },
  ]
}

function sqlServerRecs(ramMb: number, cpuCount: number): Recommendation[] {
  const maxServerMemMb = Math.round(ramMb * 0.8)
  const maxDop = Math.min(8, cpuCount)
  return [
    {
      id: 'mssql-max-server-memory',
      software: 'SQL Server',
      category: 'performance',
      severity: 'critical',
      title: 'Set max server memory to leave RAM for the OS',
      parameter: 'max server memory (MB)',
      recommended: `${maxServerMemMb}`,
      rationale: 'Without a limit, SQL Server will claim all available RAM, causing Windows to page out, severely degrading performance.',
      description: `Cap SQL Server memory at ${humanMb(maxServerMemMb)} (80% of ${humanMb(ramMb)} total RAM).`,
      snippet: `-- Run in SSMS or sqlcmd:\nEXEC sp_configure 'show advanced options', 1;\nRECONFIGURE;\nEXEC sp_configure 'max server memory (MB)', ${maxServerMemMb};\nRECONFIGURE;`,
      reference: 'https://learn.microsoft.com/en-us/sql/database-engine/configure-windows/server-memory-server-configuration-options',
    },
    {
      id: 'mssql-maxdop',
      software: 'SQL Server',
      category: 'performance',
      severity: 'high',
      title: 'Configure MAXDOP (Max Degree of Parallelism)',
      parameter: 'max degree of parallelism',
      recommended: `${maxDop}`,
      rationale: 'Incorrect MAXDOP can cause parallel query plans to consume all CPUs, blocking other queries.',
      description: `On a ${cpuCount}-core server, MAXDOP of ${maxDop} prevents runaway parallelism.`,
      snippet: `EXEC sp_configure 'show advanced options', 1;\nRECONFIGURE;\nEXEC sp_configure 'max degree of parallelism', ${maxDop};\nRECONFIGURE;\n\n-- Also set cost threshold for parallelism (default 5 is too low):\nEXEC sp_configure 'cost threshold for parallelism', 50;\nRECONFIGURE;`,
    },
    {
      id: 'mssql-auto-growth',
      software: 'SQL Server',
      category: 'performance',
      severity: 'high',
      title: 'Disable auto-grow percentage, use fixed size instead',
      description: 'Default auto-grow of 10% means small files grow quickly but large files cause multi-minute pauses.',
      rationale: 'Auto-grow events freeze the database while space is allocated. Pre-sizing files eliminates these pauses.',
      snippet: `-- Pre-size your database files and set fixed growth:\nALTER DATABASE [YourDB]\nMODIFY FILE (NAME = YourDB, SIZE = 10240MB, FILEGROWTH = 1024MB);\nALTER DATABASE [YourDB]\nMODIFY FILE (NAME = YourDB_log, SIZE = 2048MB, FILEGROWTH = 512MB);\n\n-- Check current auto-grow settings:\nSELECT name, size/128 AS SizeMB, growth, is_percent_growth\nFROM sys.master_files;`,
    },
    {
      id: 'mssql-backup',
      software: 'SQL Server',
      category: 'stability',
      severity: 'critical',
      title: 'Implement and test a backup strategy',
      description: 'Every production SQL Server database needs full, differential, and transaction log backups.',
      rationale: 'A database with no tested backup is a database you will lose. RPO and RTO must be defined before disaster strikes.',
      snippet: `-- Full backup (run daily):\nBACKUP DATABASE [YourDB]\nTO DISK = 'D:\\Backups\\YourDB_full.bak'\nWITH COMPRESSION, CHECKSUM, STATS = 10;\n\n-- Transaction log backup (run every 15 min for critical DBs):\nBACKUP LOG [YourDB]\nTO DISK = 'D:\\Backups\\YourDB_log.bak'\nWITH COMPRESSION, CHECKSUM;\n\n-- Verify backup integrity:\nRESTORE VERIFYONLY FROM DISK = 'D:\\Backups\\YourDB_full.bak';`,
    },
    {
      id: 'mssql-sa-disable',
      software: 'SQL Server',
      category: 'security',
      severity: 'critical',
      title: 'Disable or rename the SA account',
      description: 'The "sa" (System Administrator) account is targeted in every SQL Server brute-force attack.',
      rationale: 'The SA account has unrestricted server access. It must be disabled or renamed and assigned a complex password.',
      snippet: `-- Rename SA:\nALTER LOGIN [sa] WITH NAME = [sql_admin];\n\n-- Disable SA entirely (preferred if not needed):\nALTER LOGIN [sa] DISABLE;\n\n-- Set strong password on SA:\nALTER LOGIN [sa] WITH PASSWORD = 'Str0ng#Password!Here2024';`,
    },
    {
      id: 'mssql-least-privilege',
      software: 'SQL Server',
      category: 'security',
      severity: 'high',
      title: 'Use least-privilege logins for applications',
      description: 'Application logins should have only the permissions they need — never sysadmin.',
      rationale: 'An app running as sysadmin can execute xp_cmdshell and escalate to OS-level access if compromised.',
      snippet: `-- Create a restricted app login:\nCREATE LOGIN [AppUser] WITH PASSWORD = 'App#Password2024!';\nUSE [YourDB];\nCREATE USER [AppUser] FOR LOGIN [AppUser];\nGRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::dbo TO [AppUser];\n-- Do NOT add to sysadmin or db_owner`,
    },
  ]
}


// ── Main export ────────────────────────────────────────────────────────────────

export interface RecommendationRequest {
  /** Output of 'free -m' or /proc/meminfo snippet — for Linux */
  memoryRaw: string
  /** Total RAM in MB — for Windows (takes precedence over memoryRaw if > 0) */
  ramMbDirect?: number
  /** Number of logical CPUs */
  cpuCount: number
  /** List of installed software names (matches SoftwareItem.name) */
  installedSoftware: string[]
  /** Map of software name → version string */
  versions: Record<string, string | null>
  /** OS type — changes recommendation set */
  osType?: 'linux' | 'windows'
  /** Windows Server roles (from Get-WindowsFeature) */
  windowsRoles?: string[]
}

export function generateRecommendations(req: RecommendationRequest): Recommendation[] {
  const ramMb = req.ramMbDirect && req.ramMbDirect > 0 ? req.ramMbDirect : parseRamMb(req.memoryRaw)
  const { cpuCount, installedSoftware, versions } = req
  const osType = req.osType ?? 'linux'

  const has = (name: string) => installedSoftware.some((s) => s.toLowerCase() === name.toLowerCase())

  const recs: Recommendation[] = []

  if (osType === 'windows') {
    recs.push(...windowsSystemRecs(ramMb, cpuCount, req.windowsRoles ?? []))
    if (has('IIS') || has('W3SVC')) recs.push(...iisRecs(ramMb))
    if (has('SQL Server') || has('SQL Express')) recs.push(...sqlServerRecs(ramMb, cpuCount))
    if (has('MySQL')) recs.push(...mysqlRecs(ramMb))
    if (has('PostgreSQL')) recs.push(...postgresRecs(ramMb, cpuCount))
    if (has('Redis')) recs.push(...redisRecs(ramMb))
    if (has('Nginx')) recs.push(...nginxRecs(ramMb, cpuCount))
    if (has('Apache')) recs.push(...apacheRecs(ramMb, cpuCount))
    if (has('PHP')) recs.push(...phpRecs(ramMb, versions['PHP'] ?? null))
    if (has('.NET') || has('Node.js')) {
      /* generic perf recs could go here */
    }
  } else {
    // Linux
    recs.push(...systemRecs(ramMb, cpuCount))
    if (has('PHP')) recs.push(...phpRecs(ramMb, versions['PHP'] ?? null))
    if (has('Nginx')) recs.push(...nginxRecs(ramMb, cpuCount))
    if (has('Apache')) recs.push(...apacheRecs(ramMb, cpuCount))
    if (has('MySQL') || has('MariaDB')) recs.push(...mysqlRecs(ramMb))
    if (has('PostgreSQL')) recs.push(...postgresRecs(ramMb, cpuCount))
    if (has('Redis')) recs.push(...redisRecs(ramMb))
    if (has('Docker')) recs.push(...dockerRecs())
  }

  return recs
}
