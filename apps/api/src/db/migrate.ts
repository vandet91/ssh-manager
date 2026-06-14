// Load .env before importing anything that reads process.env
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') })
dotenv.config({ path: path.resolve(__dirname, '../../../.env') }) // fallback: apps/api/.env

import { FileMigrationProvider, Migrator, Kysely, PostgresDialect } from 'kysely'
import * as fs from 'fs/promises'
import { Pool } from 'pg'

async function runMigrations(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('DATABASE_URL is not set. Create a .env file at the project root (copy .env.example).')
    process.exit(1)
  }

  const db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }) })

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
    }),
  })

  const { error, results } = await migrator.migrateToLatest()

  results?.forEach((result) => {
    if (result.status === 'Success') {
      console.log(`✓ Migration "${result.migrationName}" ran successfully`)
    } else if (result.status === 'Error') {
      console.error(`✗ Migration "${result.migrationName}" failed`)
    }
  })

  if (!results?.length) {
    console.log('No pending migrations.')
  }

  if (error) {
    console.error('Migration failed:', error)
    await db.destroy()
    process.exit(1)
  }

  await db.destroy()
  console.log('Done.')
}

runMigrations()
