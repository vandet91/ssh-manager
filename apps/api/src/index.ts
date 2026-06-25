import 'dotenv/config'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyWebSocket from '@fastify/websocket'
import fastifyMultipart from '@fastify/multipart'
import { config } from './config'
import { db } from './db/client'
import { getRedis, closeRedis } from './jobs/redis'
import { setupPassport } from './modules/auth/passport'
import authRoutes from './modules/auth/auth.routes'
import ssoRoutes from './modules/auth/sso.routes'
import usersRoutes from './modules/users/users.routes'
import serversRoutes from './modules/servers/servers.routes'
import keysRoutes from './modules/keys/keys.routes'
import assignmentsRoutes from './modules/assignments/assignments.routes'
import rotationRoutes from './modules/rotation/rotation.routes'
import terminalRoutes from './modules/terminal/terminal.routes'
import securityRoutes from './modules/security/security.routes'
import logsRoutes from './modules/logs/logs.routes'
import credentialsRoutes from './modules/credentials/credentials.routes'
import settingsRoutes from './modules/settings/settings.routes'
import softwareRoutes from './modules/servers/software.routes'
import migrationRoutes from './modules/migration/migration.routes'
import fsRoutes from './modules/servers/fs.routes'
import rdpRoutes from './modules/rdp/rdp.routes'
import shareRoutes from './modules/share/share.routes'
import commandRoutes from './modules/commands/commands.routes'
import vaultRoutes from './modules/vault/vault.routes'
import domainRoutes from './modules/domain/domain.routes'
import psexecRoutes from './modules/psexec/psexec.routes'
import dbConnectorRoutes from './modules/db-connector/db-connector.routes'
import dbAnalysisRoutes from './modules/db-connector/db-analysis.routes'
import diagramRoutes from './modules/diagrams/diagrams.routes'
import distroArtRoutes from './modules/distro-art/distro-art.routes'
import networkProfileRoutes from './modules/servers/network-profile.routes'
import snmpProfileRoutes from './modules/servers/snmp-profiles.routes'
import networkPingRoutes from './modules/servers/network-ping.routes'
import firmwareRepoRoutes from './modules/firmware-repo/firmware-repo.routes'
import configBackupRoutes from './modules/config-backup/config-backup.routes'
import networkScanRoutes from './modules/network-scan/network-scan.routes'
import radiusRoutes from './modules/radius/radius.routes'
import { startTelegramBot } from './modules/telegram/telegram.service'
import { startRotationWorker, scheduleRotations } from './jobs/rotation.worker'
import { FileMigrationProvider, Migrator } from 'kysely'
import * as path from 'path'
import * as fs from 'fs/promises'

async function runMigrations(): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'db', 'migrations'),
    }),
  })
  const { error, results } = await migrator.migrateToLatest()
  results?.forEach((r) => {
    if (r.status === 'Success') console.log(`Migration "${r.migrationName}" ran successfully`)
    else if (r.status === 'Error') console.error(`Migration "${r.migrationName}" failed`)
  })
  if (error) throw error
}

async function bootstrap(): Promise<void> {
  // Ensure bootstrap admin exists
  const adminEmail = config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase()
  const existing = await db.selectFrom('users').select(['id']).where('email', '=', adminEmail).executeTakeFirst()
  if (!existing) {
    await db.insertInto('users').values({
      email: adminEmail,
      provider: 'microsoft',
      provider_id: `bootstrap:${adminEmail}`,
      role: 'admin',
      display_name: 'Admin',
    }).onConflict((oc) => oc.doNothing()).execute()
    console.log(`Bootstrap admin created: ${adminEmail}`)
  }
}

async function build(): Promise<ReturnType<typeof Fastify>> {
  const fastify = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } })

  // Plugins
  await fastify.register(fastifyCors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  })

  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
  })

  await fastify.register(fastifyCookie)

  await fastify.register(fastifySession, {
    secret: config.SESSION_SECRET,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: config.SESSION_MAX_AGE_MS,
    },
  })

  await fastify.register(fastifyRateLimit, {
    global: false,
  })

  await fastify.register(fastifyWebSocket)
  await fastify.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } })

  // Auth rate limiting on /auth/* routes
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url.startsWith('/auth/')) {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: { max: config.RATE_LIMIT_AUTH, timeWindow: '1 minute' },
      }
    }
  })

  // Routes
  setupPassport()
  await fastify.register(ssoRoutes)
  await fastify.register(authRoutes)
  await fastify.register(usersRoutes)
  await fastify.register(serversRoutes)
  await fastify.register(keysRoutes)
  await fastify.register(assignmentsRoutes)
  await fastify.register(rotationRoutes)
  await fastify.register(terminalRoutes)
  await fastify.register(securityRoutes)
  await fastify.register(logsRoutes)
  await fastify.register(credentialsRoutes)
  await fastify.register(settingsRoutes)
  await fastify.register(softwareRoutes)
  await fastify.register(migrationRoutes)
  await fastify.register(fsRoutes)
  await fastify.register(rdpRoutes)
  await fastify.register(shareRoutes)
  await fastify.register(commandRoutes)
  await fastify.register(vaultRoutes)
  await fastify.register(domainRoutes)
  await fastify.register(psexecRoutes)
  await fastify.register(dbConnectorRoutes)
  await fastify.register(dbAnalysisRoutes)
  await fastify.register(diagramRoutes)
  await fastify.register(distroArtRoutes)
  await fastify.register(networkProfileRoutes)
  await fastify.register(snmpProfileRoutes)
  await fastify.register(networkPingRoutes)
  await fastify.register(radiusRoutes)
  await fastify.register(firmwareRepoRoutes)
  await fastify.register(configBackupRoutes)
  await fastify.register(networkScanRoutes)

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  return fastify
}

async function main(): Promise<void> {
  await runMigrations()
  await bootstrap()

  const fastify = await build()

  // Start Telegram bot (polls independently; re-reads settings dynamically)
  const stopTelegram = startTelegramBot()

  // Start BullMQ workers
  const { worker: rotWorker, queue: rotQueue } = startRotationWorker()

  // Schedule rotation check: run immediately on startup, then every hour
  scheduleRotations(rotQueue).catch((err) => fastify.log.error({ err }, 'Initial rotation check failed'))
  const rotationInterval = setInterval(() => scheduleRotations(rotQueue), 60 * 60 * 1000)

  // Graceful shutdown
  const shutdown = async () => {
    fastify.log.info('Shutting down...')
    stopTelegram()
    clearInterval(rotationInterval)
    await rotWorker.close()
    await rotQueue.close()
    await closeRedis()
    await db.destroy()
    await fastify.close()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await fastify.listen({ port: config.PORT, host: '0.0.0.0' })
  fastify.log.info(`SSH Manager API running on port ${config.PORT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

export { build }
