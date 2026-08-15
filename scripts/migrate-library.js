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
import {
  backfillLegacyLibrary,
  stringifyLegacyBackfillEvidence,
} from '../server/services/legacy-backfill.js'

const MODES = new Set(['status', 'expand', 'backfill', 'contract', 'all'])

function unavailable(mode) {
  if (mode === 'contract') {
    throw new Error(
      'contract is not available until Task 3 installs the verified backup and contract runner; no destructive SQL was executed',
    )
  }
  throw new Error(
    'all is not available until Task 3 installs the verified backup and contract runner; no destructive SQL was executed',
  )
}

function readOption(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function parseArguments(argv) {
  const [mode, ...options] = argv
  const valueOptions = new Set(['--db', '--manifest', '--asset-root'])
  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index]
    if (argument === '--apply') continue
    if (valueOptions.has(argument)) {
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  if (options.includes('--apply') && mode !== 'backfill') {
    throw new Error('--apply is supported only for backfill until Task 3 is installed')
  }
  return {
    mode,
    apply: options.includes('--apply'),
    dbPath: readOption(options, '--db'),
    manifestPath: readOption(options, '--manifest'),
    assetRoot: readOption(options, '--asset-root'),
  }
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
  manifestPath = process.env.LEGACY_LIBRARY_MANIFEST_PATH,
  assetRoot = process.env.LIBRARY_ASSET_ROOT,
  apply = false,
} = {}) {
  if (!MODES.has(mode)) {
    throw new Error(`usage: node scripts/migrate-library.js ${[...MODES].join('|')}`)
  }
  if (mode === 'contract' || mode === 'all') unavailable(mode)

  const absoluteDbPath = resolve(dbPath)
  if (mode === 'expand') mkdirSync(dirname(absoluteDbPath), { recursive: true })
  const sqlite =
    mode === 'status' || mode === 'backfill'
      ? new Database(absoluteDbPath, {
          readonly: mode === 'status' || !apply,
          fileMustExist: true,
        })
      : new Database(absoluteDbPath)
  try {
    if (mode === 'expand') {
      sqlite.pragma('foreign_keys = ON')
      expandLibraryDatabase(sqlite, { migrationsFolder })
    }
    if (mode === 'backfill') {
      sqlite.pragma('foreign_keys = ON')
      return backfillLegacyLibrary({
        sqlite,
        manifestPath,
        assetRoot,
        apply,
      })
    }
    return statusPayload(sqlite, migrationsFolder)
  } finally {
    sqlite.close()
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArguments(argv)
    const result = runLibraryMigrationCommand({
      ...parsed,
      dbPath: parsed.dbPath ?? process.env.DB_PATH ?? 'data/app.db',
      manifestPath:
        parsed.manifestPath ?? process.env.LEGACY_LIBRARY_MANIFEST_PATH,
      assetRoot: parsed.assetRoot ?? process.env.LIBRARY_ASSET_ROOT,
    })
    process.stdout.write(
      parsed.mode === 'backfill'
        ? stringifyLegacyBackfillEvidence(result)
        : `${JSON.stringify(result, null, 2)}\n`,
    )
    return 0
  } catch (error) {
    process.stderr.write(`[migrate-library] ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
