#!/usr/bin/env node
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { createContentStore } from '../../server/services/content-store.js'
import {
  canonicalizeLibraryJson,
  countAssetReferences,
  hashCanonicalLibraryJson,
} from '../../server/services/library-service.js'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe SQL identifier: ${value}`)
  return `"${value}"`
}

function readManifest(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'))
  const body = { ...manifest }
  delete body.manifestSha256
  if (hashCanonicalLibraryJson(body) !== manifest.manifestSha256) {
    throw new Error('manifest hash mismatch')
  }
  return manifest
}

function parsed(value) {
  return value === null || value === undefined ? null : JSON.parse(value)
}

function sameRow(actual, expected) {
  return canonicalizeLibraryJson(actual) === canonicalizeLibraryJson(expected)
}

function writeStatusOperation(sqlite, batchId, before, after) {
  const sequence = Number(sqlite.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM import_operations WHERE import_batch_id = ?
  `).get(batchId).sequence)
  sqlite.prepare(`
    INSERT INTO import_operations
      (import_batch_id, sequence, operation_kind, entity_type,
       entity_key, before_json, after_json)
    VALUES (?, ?, 'status', 'import_batch', ?, ?, ?)
  `).run(
    batchId,
    sequence,
    batchId,
    canonicalizeLibraryJson(before),
    canonicalizeLibraryJson(after),
  )
}

function transitionBatchStatus(sqlite, batchId, manifestSha256, fromStatuses, toStatus) {
  const before = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
  if (!before || !fromStatuses.includes(before.status)) {
    throw new Error(`rollback status compare-and-swap failed from ${before?.status ?? 'missing'}`)
  }
  const placeholders = fromStatuses.map(() => '?').join(', ')
  const changed = sqlite.prepare(`
    UPDATE import_batches SET status = ?, updated_at = unixepoch()
    WHERE id = ? AND manifest_sha256 = ? AND status IN (${placeholders})
  `).run(toStatus, batchId, manifestSha256, ...fromStatuses)
  if (changed.changes !== 1) throw new Error('rollback status compare-and-swap failed')
  const after = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
  writeStatusOperation(sqlite, batchId, before, after)
  return after
}

function acquireLock(dbPath) {
  const path = `${resolve(dbPath)}.arcade-import.lock`
  let descriptor
  try {
    descriptor = openSync(path, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`arcade import lock already exists: ${path}`)
    throw error
  }
  return () => {
    closeSync(descriptor)
    rmSync(path, { force: true })
  }
}

function rowForOperation(sqlite, operation) {
  const after = parsed(operation.after_json)
  switch (operation.entity_type) {
    case 'asset':
      return sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(operation.entity_key) ?? null
    case 'core_artifact':
      return sqlite.prepare('SELECT * FROM core_artifacts WHERE artifact_fingerprint = ?').get(operation.entity_key) ?? null
    case 'rom':
      return sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(Number(operation.entity_key)) ?? null
    case 'rom_build':
      return sqlite.prepare('SELECT * FROM rom_builds WHERE id = ?').get(Number(operation.entity_key)) ?? null
    case 'rom_asset_ref':
      return sqlite.prepare('SELECT * FROM rom_asset_refs WHERE id = ?').get(Number(operation.entity_key)) ?? null
    case 'batch_build_ref':
      return sqlite.prepare('SELECT * FROM batch_build_refs WHERE import_batch_id = ? AND rom_build_id = ?')
        .get(after.import_batch_id, after.rom_build_id) ?? null
    case 'build_source_member':
      return sqlite.prepare(`
        SELECT * FROM build_source_members
        WHERE import_batch_id = ? AND rom_build_id = ?
          AND source_archive_path = ? AND member_name = ?
      `).get(after.import_batch_id, after.rom_build_id, after.source_archive_path, after.member_name) ?? null
    case 'import_batch':
      return sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(operation.entity_key) ?? null
    case 'candidate_resolution':
      return after
    default:
      throw new Error(`unsupported rollback entity type: ${operation.entity_type}`)
  }
}

function restoreRow(sqlite, table, idColumn, id, before) {
  const entries = Object.entries(before).filter(([key]) => key !== idColumn)
  const assignments = entries.map(([key]) => `${quoteIdentifier(key)} = ?`).join(', ')
  sqlite.prepare(`UPDATE ${quoteIdentifier(table)} SET ${assignments} WHERE ${quoteIdentifier(idColumn)} = ?`)
    .run(...entries.map(([, value]) => value), id)
}

function tableExists(sqlite, name) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function buildIsProtected(sqlite, buildId) {
  const checks = [
    ['roms', 'SELECT 1 FROM roms WHERE active_build_id = ? LIMIT 1'],
    ['rom_builds', 'SELECT 1 FROM rom_builds WHERE runtime_parent_build_id = ? LIMIT 1'],
    ['batch_build_refs', 'SELECT 1 FROM batch_build_refs WHERE rom_build_id = ? LIMIT 1'],
    ['rooms', 'SELECT 1 FROM rooms WHERE rom_build_id = ? LIMIT 1'],
    ['save_states', 'SELECT 1 FROM save_states WHERE rom_build_id = ? LIMIT 1'],
    ['build_validation_runs', 'SELECT 1 FROM build_validation_runs WHERE rom_build_id = ? LIMIT 1'],
  ]
  return checks.some(([table, sql]) => tableExists(sqlite, table) && sqlite.prepare(sql).get(buildId))
}

function coreIsProtected(sqlite, coreId) {
  return tableExists(sqlite, 'rom_builds') && Boolean(
    sqlite.prepare('SELECT 1 FROM rom_builds WHERE core_artifact_id = ? LIMIT 1').get(coreId),
  )
}

function romIsProtected(sqlite, romId) {
  const checks = [
    ['rom_builds', 'SELECT 1 FROM rom_builds WHERE rom_id = ? LIMIT 1'],
    ['rooms', 'SELECT 1 FROM rooms WHERE rom_id = ? LIMIT 1'],
    ['save_states', 'SELECT 1 FROM save_states WHERE rom_id = ? LIMIT 1'],
    ['favorites', 'SELECT 1 FROM favorites WHERE rom_id = ? LIMIT 1'],
    ['roms', 'SELECT 1 FROM roms WHERE parent_rom_id = ? LIMIT 1'],
  ]
  return checks.some(([table, sql]) => tableExists(sqlite, table) && sqlite.prepare(sql).get(romId))
}

function reverseOperation(sqlite, operation, filesToRemove, preserved) {
  const before = parsed(operation.before_json)
  const after = parsed(operation.after_json)
  if (operation.operation_kind === 'record' && operation.entity_type === 'candidate_resolution') return
  if (operation.operation_kind === 'update') {
    if (operation.entity_type === 'rom') {
      restoreRow(sqlite, 'roms', 'id', Number(operation.entity_key), before)
      return
    }
    if (operation.entity_type === 'import_batch') return
    throw new Error(`unsupported rollback update entity: ${operation.entity_type}`)
  }
  if (operation.operation_kind !== 'create') {
    throw new Error(`unsupported rollback operation kind: ${operation.operation_kind}`)
  }
  switch (operation.entity_type) {
    case 'build_source_member':
      sqlite.prepare(`
        DELETE FROM build_source_members
        WHERE import_batch_id = ? AND rom_build_id = ?
          AND source_archive_path = ? AND member_name = ?
      `).run(after.import_batch_id, after.rom_build_id, after.source_archive_path, after.member_name)
      return
    case 'batch_build_ref':
      sqlite.prepare('DELETE FROM batch_build_refs WHERE import_batch_id = ? AND rom_build_id = ?')
        .run(after.import_batch_id, after.rom_build_id)
      return
    case 'rom_asset_ref':
      sqlite.prepare('DELETE FROM rom_asset_refs WHERE id = ?').run(after.id)
      return
    case 'rom_build':
      if (buildIsProtected(sqlite, after.id)) {
        preserved.push({ entityType: 'rom_build', entityKey: String(after.id), reason: 'referenced' })
      } else {
        sqlite.prepare('DELETE FROM rom_builds WHERE id = ?').run(after.id)
      }
      return
    case 'core_artifact':
      if (coreIsProtected(sqlite, after.id)) {
        preserved.push({ entityType: 'core_artifact', entityKey: after.artifact_fingerprint, reason: 'referenced' })
      } else {
        sqlite.prepare('DELETE FROM core_artifacts WHERE id = ?').run(after.id)
      }
      return
    case 'rom':
      if (romIsProtected(sqlite, after.id)) {
        preserved.push({ entityType: 'rom', entityKey: String(after.id), reason: 'referenced' })
      } else {
        sqlite.prepare('DELETE FROM roms WHERE id = ?').run(after.id)
      }
      return
    case 'import_batch':
      return
    case 'asset': {
      const row = sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(after.sha256)
      if (!row) return
      if (countAssetReferences(sqlite, row.id) > 0) {
        preserved.push({ entityType: 'asset', entityKey: after.sha256, reason: 'referenced' })
        return
      }
      sqlite.prepare('DELETE FROM assets WHERE id = ?').run(row.id)
      filesToRemove.push({
        created: true,
        filePath: row.file_path,
        sha256: row.sha256,
        fileSize: row.file_size,
      })
      return
    }
    default:
      throw new Error(`unsupported rollback create entity: ${operation.entity_type}`)
  }
}

function preflight(sqlite, operations) {
  const conflicts = []
  const checkedEntities = new Set()
  for (const operation of operations) {
    if (operation.reverted_at !== null) continue
    if (operation.entity_type === 'import_batch') continue
    const entity = `${operation.entity_type}\0${operation.entity_key}`
    if (checkedEntities.has(entity)) continue
    checkedEntities.add(entity)
    const expected = parsed(operation.after_json)
    const current = rowForOperation(sqlite, operation)
    if (!sameRow(current, expected)) {
      conflicts.push({
        sequence: operation.sequence,
        entityType: operation.entity_type,
        entityKey: operation.entity_key,
      })
    }
  }
  return conflicts
}

function recoverableContentRemovals(sqlite, operations, current = []) {
  const records = new Map(current.map((record) => [record.filePath, record]))
  for (const operation of operations) {
    if (operation.operation_kind !== 'create' || operation.entity_type !== 'asset') continue
    const after = parsed(operation.after_json)
    const stillRegistered = sqlite.prepare('SELECT 1 FROM assets WHERE sha256 = ?').get(after.sha256)
    if (stillRegistered) continue
    records.set(after.file_path, {
      created: true,
      filePath: after.file_path,
      sha256: after.sha256,
      fileSize: after.file_size,
    })
  }
  return [...records.values()]
}

class RollbackPreflightConflict extends Error {
  constructor(conflicts) {
    super('rollback preflight conflict')
    this.conflicts = conflicts
  }
}

export function rollbackBatch({
  dbPath,
  assetRoot,
  manifestPath,
  batchId,
  apply = false,
}) {
  const manifest = readManifest(manifestPath)
  if (manifest.batchId !== batchId) throw new Error('batch ID does not match manifest')
  const sqlite = new Database(resolve(dbPath), apply ? {} : { readonly: true, fileMustExist: true })
  let releaseLock = null
  let mutationLock = null
  let contentStore = null
  try {
    if (apply) {
      releaseLock = acquireLock(dbPath)
      contentStore = createContentStore({ root: resolve(assetRoot) })
      mutationLock = contentStore.acquireMutationLock({
        operation: 'rollback',
        databasePath: resolve(dbPath),
        batchId,
      })
    }
    sqlite.pragma('foreign_keys = ON')
    const batch = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
    if (!batch) throw new Error(`import batch does not exist: ${batchId}`)
    if (batch.manifest_sha256 !== manifest.manifestSha256) {
      throw new Error('batch manifest compare-and-swap mismatch')
    }
    if (batch.status === 'rolled_back') {
      return {
        kind: 'w165-import-rollback-evidence-v1',
        batchId,
        manifestSha256: manifest.manifestSha256,
        status: 'rolled_back',
        noop: true,
        writes: 0,
        preserved: [],
      }
    }
    if (!['committed_private', 'rollback_failed', 'rolling_back'].includes(batch.status)) {
      return {
        kind: 'w165-import-rollback-evidence-v1',
        batchId,
        manifestSha256: manifest.manifestSha256,
        status: 'rollback_failed',
        noop: false,
        writes: 0,
        conflicts: [{ entityType: 'import_batch', entityKey: batchId, status: batch.status }],
      }
    }
    const operations = sqlite.prepare(`
      SELECT * FROM import_operations
      WHERE import_batch_id = ? AND operation_kind IN ('create', 'update', 'record')
      ORDER BY sequence DESC
    `).all(batchId)
    if (!apply) {
      const conflicts = preflight(sqlite, operations)
      if (conflicts.length) {
        return {
          kind: 'w165-import-rollback-evidence-v1',
          batchId,
          manifestSha256: manifest.manifestSha256,
          status: 'rollback_failed',
          noop: false,
          writes: 0,
          conflicts,
        }
      }
      return {
        kind: 'w165-import-rollback-evidence-v1',
        batchId,
        manifestSha256: manifest.manifestSha256,
        status: 'rolled_back',
        noop: false,
        dryRun: true,
        writes: 0,
        plannedOperations: operations.length,
        preserved: [],
      }
    }

    const filesToRemove = []
    const preserved = []
    const execute = sqlite.transaction(() => {
      let current = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
      if (current?.status !== 'rolling_back') {
        transitionBatchStatus(
          sqlite,
          batchId,
          manifest.manifestSha256,
          [current?.status],
          'rolling_back',
        )
        current = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
      }
      if (current?.status !== 'rolling_back') throw new Error('rollback batch is not in rolling_back state')
      const lockedOperations = sqlite.prepare(`
        SELECT * FROM import_operations
        WHERE import_batch_id = ? AND operation_kind IN ('create', 'update', 'record')
        ORDER BY sequence DESC
      `).all(batchId)
      const conflicts = preflight(sqlite, lockedOperations)
      if (conflicts.length) throw new RollbackPreflightConflict(conflicts)
      let writes = 0
      for (const operation of lockedOperations) {
        if (operation.reverted_at !== null) continue
        reverseOperation(sqlite, operation, filesToRemove, preserved)
        sqlite.prepare(`
          UPDATE import_operations SET reverted_at = unixepoch()
          WHERE id = ? AND reverted_at IS NULL
        `).run(operation.id)
        writes += 1
      }
      return { writes, operations: lockedOperations }
    })
    let execution
    try {
      execution = execute.immediate()
    } catch (error) {
      if (!(error instanceof RollbackPreflightConflict)) throw error
      const current = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
      if (current?.status !== 'rollback_failed') {
        const fail = sqlite.transaction(() => transitionBatchStatus(
          sqlite,
          batchId,
          manifest.manifestSha256,
          [current?.status],
          'rollback_failed',
        ))
        fail.immediate()
      }
      return {
        kind: 'w165-import-rollback-evidence-v1',
        batchId,
        manifestSha256: manifest.manifestSha256,
        status: 'rollback_failed',
        noop: false,
        writes: 0,
        conflicts: error.conflicts,
      }
    }
    const contentRemovals = recoverableContentRemovals(sqlite, execution.operations, filesToRemove)
    try {
      if (contentRemovals.length) {
        contentStore.cleanupCreated(contentRemovals, {
          isReferenced: (record) => Boolean(
            sqlite.prepare('SELECT 1 FROM assets WHERE sha256 = ?').get(record.sha256),
          ),
        })
      }
    } catch (error) {
      const fail = sqlite.transaction(() => transitionBatchStatus(
        sqlite,
        batchId,
        manifest.manifestSha256,
        ['rolling_back'],
        'rollback_failed',
      ))
      fail.immediate()
      throw error
    }

    const finish = sqlite.transaction(() => {
      const beforeFinished = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
      const finished = sqlite.prepare(`
        UPDATE import_batches
        SET status = 'rolled_back', rolled_back_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ? AND manifest_sha256 = ? AND status = 'rolling_back'
      `).run(batchId, manifest.manifestSha256)
      if (finished.changes !== 1) throw new Error('rollback completion compare-and-swap failed')
      const afterFinished = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId)
      writeStatusOperation(sqlite, batchId, beforeFinished, afterFinished)
      return 1
    })
    const finishWrites = finish.immediate()
    return {
      kind: 'w165-import-rollback-evidence-v1',
      batchId,
      manifestSha256: manifest.manifestSha256,
      status: 'rolled_back',
      noop: false,
      dryRun: false,
      writes: execution.writes + finishWrites,
      preserved,
    }
  } finally {
    try {
      if (mutationLock) mutationLock.release()
    } finally {
      try {
        if (releaseLock) releaseLock()
      } finally {
        sqlite.close()
      }
    }
  }
}

function parseArgs(argv) {
  const options = { apply: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--apply') options.apply = true
    else if (value.startsWith('--')) {
      const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
      options[key] = next
      index += 1
    } else throw new Error(`unexpected argument: ${value}`)
  }
  for (const key of ['db', 'assetRoot', 'manifest', 'batchId']) {
    if (options[key] === undefined) throw new Error(`--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    const result = rollbackBatch({
      dbPath: options.db,
      assetRoot: options.assetRoot,
      manifestPath: options.manifest,
      batchId: options.batchId,
      apply: options.apply,
    })
    process.stdout.write(`${canonicalizeLibraryJson(result)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`rollback_batch: ${error.message}\n`)
    return 2
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) process.exitCode = main()
