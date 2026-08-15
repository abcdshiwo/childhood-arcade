#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  backfillLegacyLibrary,
  stringifyLegacyBackfillEvidence,
} from '../server/services/legacy-backfill.js'

function readOption(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function assertKnownArguments(argv) {
  const valueOptions = new Set(['--db', '--manifest', '--asset-root'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--apply') continue
    if (valueOptions.has(argument)) {
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
}

export function runLegacyBackfillCommand({
  dbPath = process.env.DB_PATH || 'data/app.db',
  manifestPath = process.env.LEGACY_LIBRARY_MANIFEST_PATH,
  assetRoot = process.env.LIBRARY_ASSET_ROOT,
  apply = false,
} = {}) {
  const absoluteDbPath = resolve(dbPath)
  const sqlite = new Database(absoluteDbPath, {
    readonly: !apply,
    fileMustExist: true,
  })
  try {
    sqlite.pragma('foreign_keys = ON')
    return backfillLegacyLibrary({
      sqlite,
      manifestPath,
      assetRoot,
      apply,
    })
  } finally {
    sqlite.close()
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    assertKnownArguments(argv)
    const result = runLegacyBackfillCommand({
      dbPath: readOption(argv, '--db') ?? process.env.DB_PATH ?? 'data/app.db',
      manifestPath:
        readOption(argv, '--manifest') ??
        process.env.LEGACY_LIBRARY_MANIFEST_PATH,
      assetRoot:
        readOption(argv, '--asset-root') ?? process.env.LIBRARY_ASSET_ROOT,
      apply: argv.includes('--apply'),
    })
    process.stdout.write(stringifyLegacyBackfillEvidence(result))
    return 0
  } catch (error) {
    process.stderr.write(`[backfill-legacy-library] ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
