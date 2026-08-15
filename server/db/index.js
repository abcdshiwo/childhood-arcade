import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import bcrypt from 'bcryptjs'
import * as schema from './schema.js'
import { prepareDatabaseForRuntime } from './migration-runner.js'

const DB_PATH = process.env.DB_PATH || 'data/app.db'
mkdirSync(dirname(DB_PATH), { recursive: true })

const sqlite = new Database(DB_PATH)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema, casing: 'snake_case' })

export function runMigrations() {
  prepareDatabaseForRuntime(sqlite)
  seedAdminUser()
}

function seedAdminUser() {
  const row = sqlite.prepare('SELECT COUNT(*) as n FROM users').get()
  if (row.n > 0) return

  const username = process.env.ADMIN_USERNAME || 'admin'
  const password = process.env.ADMIN_PASSWORD || 'admin123'
  const passwordHash = bcrypt.hashSync(password, 10)

  sqlite.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
  ).run(username, passwordHash, 'admin')

  console.log(`[db] seeded initial admin: username="${username}", role=admin`)
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`[db] ⚠️  using default password "admin123" — change it via the profile page or ADMIN_PASSWORD env`)
  }
}
