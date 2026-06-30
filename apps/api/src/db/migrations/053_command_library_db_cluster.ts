import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO command_library (os, category, label, command, description, sort_order)
    VALUES
      -- PostgreSQL
      ('linux', 'DB Cluster', 'PG: List databases', 'psql -U postgres -c "\\l+"', 'List all PostgreSQL databases with sizes', 10),
      ('linux', 'DB Cluster', 'PG: Active connections', 'psql -U postgres -c "SELECT pid, usename, datname, state, query_start, query FROM pg_stat_activity ORDER BY query_start DESC;"', 'Show active PostgreSQL connections', 11),
      ('linux', 'DB Cluster', 'PG: Replication status', 'psql -U postgres -c "SELECT * FROM pg_stat_replication;"', 'Check PostgreSQL replication lag and status', 12),
      ('linux', 'DB Cluster', 'PG: Database sizes', 'psql -U postgres -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database ORDER BY pg_database_size(datname) DESC;"', 'Show disk usage per database', 13),
      ('linux', 'DB Cluster', 'PG: Long running queries', 'psql -U postgres -c "SELECT pid, now() - query_start AS duration, query, state FROM pg_stat_activity WHERE state != ''idle'' AND query_start < now() - interval ''5 minutes'' ORDER BY duration DESC;"', 'Find queries running longer than 5 minutes', 14),

      -- MySQL / MariaDB
      ('linux', 'DB Cluster', 'MySQL: Show databases', 'mysql -u root -p -e "SHOW DATABASES;"', 'List all MySQL/MariaDB databases', 20),
      ('linux', 'DB Cluster', 'MySQL: Process list', 'mysql -u root -p -e "SHOW FULL PROCESSLIST;"', 'Show running MySQL queries and connections', 21),
      ('linux', 'DB Cluster', 'MySQL: Replication status', 'mysql -u root -p -e "SHOW SLAVE STATUS\\G"', 'Check MySQL replication lag and errors', 22),
      ('linux', 'DB Cluster', 'MySQL: Database sizes', 'mysql -u root -p -e "SELECT table_schema AS db, ROUND(SUM(data_length+index_length)/1024/1024,2) AS size_mb FROM information_schema.tables GROUP BY table_schema ORDER BY size_mb DESC;"', 'Show disk usage per database in MB', 23),
      ('linux', 'DB Cluster', 'MySQL: Global status', 'mysql -u root -p -e "SHOW GLOBAL STATUS LIKE ''%conn%'';"', 'Check connection statistics and limits', 24),

      -- MongoDB
      ('linux', 'DB Cluster', 'Mongo: Server status', 'mongosh --eval "db.adminCommand({serverStatus:1})" --quiet | head -60', 'Overview of MongoDB server health', 30),
      ('linux', 'DB Cluster', 'Mongo: Replica set status', 'mongosh --eval "rs.status()" --quiet', 'Show replica set members and their states', 31),
      ('linux', 'DB Cluster', 'Mongo: List databases', 'mongosh --eval "db.adminCommand({listDatabases:1})" --quiet', 'List all MongoDB databases with sizes', 32),
      ('linux', 'DB Cluster', 'Mongo: Current operations', 'mongosh --eval "db.currentOp({active:true})" --quiet', 'Show active operations in MongoDB', 33),
      ('linux', 'DB Cluster', 'Mongo: Replication lag', 'mongosh --eval "rs.printSlaveReplicationInfo()" --quiet', 'Check replication lag per secondary member', 34),

      -- Redis
      ('linux', 'DB Cluster', 'Redis: Server info', 'redis-cli INFO server | grep -E "redis_version|uptime|hz|aof|rdb"', 'Key Redis server configuration and version', 40),
      ('linux', 'DB Cluster', 'Redis: Memory usage', 'redis-cli INFO memory | grep -E "used_memory_human|maxmemory_human|mem_fragmentation_ratio"', 'Check Redis memory consumption', 41),
      ('linux', 'DB Cluster', 'Redis: Replication info', 'redis-cli INFO replication', 'Show Redis master/replica replication status', 42),
      ('linux', 'DB Cluster', 'Redis: Slow log', 'redis-cli SLOWLOG GET 10', 'Retrieve the last 10 slow Redis commands', 43),
      ('linux', 'DB Cluster', 'Redis: Connected clients', 'redis-cli CLIENT LIST', 'List all connected Redis clients', 44),

      -- Time Sync (chrony / NTP)
      ('linux', 'Time Sync', 'Chrony: Tracking', 'chronyc tracking', 'Current time source, offset, and drift statistics', 50),
      ('linux', 'Time Sync', 'Chrony: Sources', 'chronyc sources -v', 'List NTP sources with reach and offset details', 51),
      ('linux', 'Time Sync', 'Chrony: Source stats', 'chronyc sourcestats', 'Frequency and offset statistics for each source', 52),
      ('linux', 'Time Sync', 'Chrony: Activity', 'chronyc activity', 'How many sources are online/offline/burst', 53),
      ('linux', 'Time Sync', 'NTP: Query peers', 'ntpq -p', 'Show NTP peers, stratum, and offset (ntpd)', 54),
      ('linux', 'Time Sync', 'NTP: Sync status', 'timedatectl show --all', 'System clock sync status via systemd-timesyncd', 55),
      ('linux', 'Time Sync', 'System: Date & time', 'timedatectl status', 'Local time, RTC, timezone, and NTP status', 56),
      ('linux', 'Time Sync', 'Chrony: Force sync', 'chronyc makestep', 'Immediately step the clock to the NTP source', 57)
    ON CONFLICT DO NOTHING
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM command_library WHERE os = 'linux' AND category IN ('DB Cluster', 'Time Sync')`.execute(db)
}
