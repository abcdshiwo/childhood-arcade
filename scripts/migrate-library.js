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
import { contractLibraryDatabase } from '../server/db/contract-runner.js'

const MODES = new Set(['status', 'expand', 'backfill', 'contract', 'all'])

function readOption(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function parseArguments(argv) {
  const [mode, ...options] = argv
  const valueOptions = new Set([
    '--db',
    '--manifest',
    '--asset-root',
    '--backup',
  ])
  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index]
    if (argument === '--apply') continue
    if (valueOptions.has(argument)) {
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  if (
    options.includes('--apply') &&
    !['backfill', 'contract', 'all'].includes(mode)
  ) {
    throw new Error('--apply is supported only for backfill, contract, or all')
  }
  if (options.includes('--backup') && !['contract', 'all'].includes(mode)) {
    throw new Error('--backup is supported only for contract or all')
  }
  return {
    mode,
    apply: options.includes('--apply'),
    dbPath: readOption(options, '--db'),
    manifestPath: readOption(options, '--manifest'),
    assetRoot: readOption(options, '--asset-root'),
    backupPath: readOption(options, '--backup'),
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

export async function runLibraryMigrationCommand({
  mode,
  dbPath = process.env.DB_PATH || 'data/app.db',
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
  manifestPath = process.env.LEGACY_LIBRARY_MANIFEST_PATH,
  assetRoot = process.env.LIBRARY_ASSET_ROOT,
  backupPath = process.env.LIBRARY_CONTRACT_BACKUP_PATH,
  apply = false,
} = {}) {
  if (!MODES.has(mode)) {
    throw new Error(`usage: node scripts/migrate-library.js ${[...MODES].join('|')}`)
  }
  if (['contract', 'all'].includes(mode) && !apply) {
    throw new Error(`${mode} requires --apply`)
  }
  if (mode === 'all' && !backupPath) {
    throw new Error(
      `${mode} requires --backup or LIBRARY_CONTRACT_BACKUP_PATH`,
    )
  }

  const absoluteDbPath = resolve(dbPath)
  if (mode === 'contract') {
    if (!backupPath) {
      const probe = new Database(absoluteDbPath, {
        readonly: true,
        fileMustExist: true,
      })
      let phase
      try {
        phase = readLibraryMigrationState(probe).phase
      } finally {
        probe.close()
      }
      if (phase !== 'contracted') {
        throw new Error(
          'contract requires --backup or LIBRARY_CONTRACT_BACKUP_PATH',
        )
      }
    }
    return contractLibraryDatabase({
      dbPath: absoluteDbPath,
      backupPath,
      migrationsFolder,
    })
  }
  if (mode === 'expand' || mode === 'all') {
    mkdirSync(dirname(absoluteDbPath), { recursive: true })
  }
  const sqlite =
    mode === 'status' || mode === 'backfill'
      ? new Database(absoluteDbPath, {
          readonly: mode === 'status' || !apply,
          fileMustExist: true,
        })
      : new Database(absoluteDbPath)
  try {
    if (mode === 'expand' || mode === 'all') {
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
    if (mode === 'all') {
      const state = readLibraryMigrationState(sqlite)
      let backfill
      if (state.phase === 'expanded') {
        backfill = backfillLegacyLibrary({
          sqlite,
          manifestPath,
          assetRoot,
          apply: true,
        })
      } else if (state.phase === 'backfilled') {
        backfill = 'already-backfilled'
      } else if (state.phase === 'contracted') {
        backfill = 'already-contracted'
      } else {
        throw new Error(`all cannot continue from migration phase ${state.phase}`)
      }
      sqlite.close()
      const contract = await contractLibraryDatabase({
        dbPath: absoluteDbPath,
        backupPath,
        migrationsFolder,
      })
      return {
        schemaVersion: 1,
        kind: 'arcade-library-all-evidence-v1',
        steps: {
          expand: 'verified',
          backfill,
          contract: contract.noop ? 'verified-contracted' : 'applied',
        },
        contract,
      }
    }
    return statusPayload(sqlite, migrationsFolder)
  } finally {
    if (sqlite.open) sqlite.close()
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArguments(argv)
    const result = await runLibraryMigrationCommand({
      ...parsed,
      dbPath: parsed.dbPath ?? process.env.DB_PATH ?? 'data/app.db',
      manifestPath:
        parsed.manifestPath ?? process.env.LEGACY_LIBRARY_MANIFEST_PATH,
      assetRoot: parsed.assetRoot ?? process.env.LIBRARY_ASSET_ROOT,
      backupPath:
        parsed.backupPath ?? process.env.LIBRARY_CONTRACT_BACKUP_PATH,
    })
    process.stdout.write(
      parsed.mode === 'backfill'
        ? stringifyLegacyBackfillEvidence(result)
        : `${JSON.stringify(result, null, 2)}\n`,
    )
    return 0
  } catch (error) {
    if (error.contractEvidence) {
      process.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            error: error.message,
            evidence: error.contractEvidence,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      process.stderr.write(`[migrate-library] ${error.message}\n`)
    }
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}
