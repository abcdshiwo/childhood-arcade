#!/usr/bin/env node

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  DEFAULT_MIGRATIONS_FOLDER,
  classifyMigrationHash,
  expandLibraryDatabase,
  loadMigrationManifest,
  readLibraryMigrationState,
  readMigrationLedger,
} from '../server/db/migration-runner.js'

const MODES = new Set(['status', 'expand', 'backfill', 'contract', 'all'])

function unavailable(mode) {
  if (mode === 'backfill') {
    throw new Error(
      'backfill is not available until Task 2 installs the audited legacy backfill; no database changes were made',
    )
  }
  if (mode === 'contract') {
    throw new Error(
      'contract is not available until Task 3 installs the verified backup and contract runner; no destructive SQL was executed',
    )
  }
  throw new Error(
    'all is not available until Task 2 backfill and Task 3 contract implementations are installed; run "status" or the safe "expand" mode only',
  )
}

function statusPayload(sqlite, migrationsFolder) {
  const manifest = loadMigrationManifest(migrationsFolder)
  const byTimestamp = new Map(
    manifest.map((entry) => [Number(entry.folderMillis), entry]),
  )
  return {
    ...readLibraryMigrationState(sqlite),
    ledger: readMigrationLedger(sqlite).map((row) => {
      const entry = byTimestamp.get(Number(row.createdAt))
      return {
        tag: entry?.tag ?? null,
        createdAt: Number(row.createdAt),
        hash: row.hash,
        hashStatus: classifyMigrationHash(entry, row.hash),
      }
    }),
  }
}

export function runLibraryMigrationCommand({
  mode,
  dbPath = process.env.DB_PATH || 'data/app.db',
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
} = {}) {
  if (!MODES.has(mode)) {
    throw new Error(`usage: node scripts/migrate-library.js ${[...MODES].join('|')}`)
  }
  if (mode === 'backfill' || mode === 'contract' || mode === 'all') unavailable(mode)

  const absoluteDbPath = resolve(dbPath)
  if (mode === 'expand') mkdirSync(dirname(absoluteDbPath), { recursive: true })
  const sqlite =
    mode === 'status'
      ? new Database(absoluteDbPath, { readonly: true, fileMustExist: true })
      : new Database(absoluteDbPath)
  try {
    if (mode === 'expand') {
      sqlite.pragma('foreign_keys = ON')
      expandLibraryDatabase(sqlite, { migrationsFolder })
    }
    return statusPayload(sqlite, migrationsFolder)
  } finally {
    sqlite.close()
  }
}

export function main(argv = process.argv.slice(2)) {
  const [mode] = argv
  try {
    const result = runLibraryMigrationCommand({ mode })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`[migrate-library] ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
