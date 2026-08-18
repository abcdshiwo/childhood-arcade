#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { computeBuildFingerprint } from '../../server/services/build-contract.js'
import { createContentStore } from '../../server/services/content-store.js'
import {
  canonicalizeLibraryJson,
  computeCoreArtifactFingerprint,
  hashCanonicalLibraryJson,
} from '../../server/services/library-service.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function positiveInteger(value, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${field} must be a positive integer`)
  }
  return number
}

function requiredSha256(value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value.toLowerCase())) {
    throw new TypeError(`${field} must be a 64-character SHA-256 hex string`)
  }
  return value.toLowerCase()
}

function parseBuildEvidence(build) {
  try {
    const evidence = JSON.parse(build.static_failure_details_json || 'null')
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new Error('expected an object')
    }
    return evidence
  } catch (error) {
    throw new Error(`build ${build.id} evidence is invalid JSON: ${error.message}`, {
      cause: error,
    })
  }
}

function candidateId(build) {
  return requiredString(
    parseBuildEvidence(build).candidateId,
    `build ${build.id} candidateId`,
  ).toLowerCase()
}

function coreIdentity(core) {
  return {
    coreName: core.core_name,
    displayVersion: core.display_version,
    sourceCommit: core.source_commit,
    jsSha256: core.js_sha256,
    wasmSha256: core.wasm_sha256,
    datSha256: core.dat_sha256 ?? null,
    biosManifestSha256: core.bios_manifest_sha256 ?? null,
  }
}

function validateCore(sqlite, coreId, contentStore) {
  const core = sqlite.prepare('SELECT * FROM core_artifacts WHERE id = ?').get(coreId)
  if (!core) throw new Error(`core artifact ${coreId} was not found`)
  const actualFingerprint = computeCoreArtifactFingerprint(coreIdentity(core))
  if (actualFingerprint !== requiredSha256(core.artifact_fingerprint, 'core artifact fingerprint')) {
    throw new Error(`core artifact ${core.id} fingerprint does not match its immutable identity`)
  }

  for (const [assetId, digest, kind, label] of [
    [core.js_asset_id, core.js_sha256, 'core_js', 'core JavaScript'],
    [core.wasm_asset_id, core.wasm_sha256, 'core_wasm', 'core WebAssembly'],
  ]) {
    const asset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)
    if (!asset || asset.kind !== kind || asset.sha256 !== digest) {
      throw new Error(`${label} asset does not match the core identity`)
    }
    verifyStoredAsset(contentStore, asset, label)
  }
  return core
}

function verifyStoredAsset(contentStore, asset, label) {
  const path = contentStore.resolveStoredPath(asset.file_path)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} is not a regular content-store file`)
  }
  const bytes = readFileSync(path)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256 || bytes.length !== Number(asset.file_size)) {
    throw new Error(`${label} content does not match its database hash and size`)
  }
}

function validateArchive(sqlite, contentStore, build, label) {
  const digest = requiredSha256(build.archive_sha256, `${label} SHA-256`)
  const asset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(build.archive_asset_id)
  const expectedPath = `sha256/${digest.slice(0, 2)}/${digest}`
  if (
    !asset ||
    asset.kind !== 'rom' ||
    asset.sha256 !== digest ||
    asset.file_path !== expectedPath
  ) {
    throw new Error(`${label} asset does not match the immutable build identity`)
  }
  verifyStoredAsset(contentStore, asset, label)
}

function assertBuildFingerprint(build, rom, core, runtimeParentFingerprint) {
  const expected = computeBuildFingerprint({
    logicalRomScope: `w165:${candidateId(build)}`,
    setNameNormalized: rom.set_name_normalized,
    coreArtifactFingerprint: core.artifact_fingerprint,
    archiveSha256: build.archive_sha256,
    contentManifestSha256: build.content_manifest_sha256,
    archiveLayout: build.archive_layout,
    runtimeParentBuildFingerprint: runtimeParentFingerprint,
    biosManifestSha256: core.bios_manifest_sha256 ?? null,
  })
  if (expected !== build.build_fingerprint) {
    throw new Error(`build ${build.id} fingerprint does not match its immutable identity`)
  }
}

function sourceRecord(sqlite, romId, buildId, label) {
  const row = sqlite.prepare(`
    SELECT r.*, b.id AS source_build_id, b.rom_id AS build_rom_id,
           b.core_artifact_id, b.archive_asset_id, b.archive_sha256,
           b.content_manifest_sha256, b.build_fingerprint, b.static_status,
           b.static_failure_code, b.static_failure_details_json,
           b.archive_layout, b.runtime_parent_build_id, b.created_at AS build_created_at
    FROM roms r
    JOIN rom_builds b ON b.id = ?
    WHERE r.id = ?
  `).get(buildId, romId)
  if (!row) throw new Error(`${label} ROM/build pair was not found`)
  if (row.build_rom_id !== romId) {
    throw new Error(`${label} build ${buildId} does not belong to ROM ${romId}`)
  }
  return row
}

function buildFromRecord(record) {
  return {
    id: record.source_build_id,
    rom_id: record.build_rom_id,
    core_artifact_id: record.core_artifact_id,
    archive_asset_id: record.archive_asset_id,
    archive_sha256: record.archive_sha256,
    content_manifest_sha256: record.content_manifest_sha256,
    build_fingerprint: record.build_fingerprint,
    static_status: record.static_status,
    static_failure_code: record.static_failure_code,
    static_failure_details_json: record.static_failure_details_json,
    archive_layout: record.archive_layout,
    runtime_parent_build_id: record.runtime_parent_build_id,
    created_at: record.build_created_at,
  }
}

function assertOriginReference(sqlite, batchId, buildId, label) {
  const row = sqlite.prepare(`
    SELECT 1 FROM batch_build_refs
    WHERE import_batch_id = ? AND rom_build_id = ?
  `).get(batchId, buildId)
  if (!row) throw new Error(`${label} build ${buildId} is not part of origin batch ${batchId}`)
}

function canonicalSourceMember(row) {
  return {
    sourceArchivePath: row.source_archive_path,
    memberName: row.member_name,
    memberRole: row.member_role,
    memberOrder: Number(row.member_order),
    memberSize: Number(row.member_size),
    crc32: row.crc32,
    sha256: row.sha256,
  }
}

function sourceMemberDigest(rows) {
  return hashCanonicalLibraryJson(rows.map(canonicalSourceMember))
}

export function planRuntimeParentRemediation(sqlite, options) {
  if (!sqlite || typeof sqlite.prepare !== 'function') {
    throw new TypeError('a better-sqlite3 connection is required')
  }
  const assetRoot = resolve(requiredString(options.assetRoot, 'asset root'))
  const originBatchId = requiredString(options.originBatchId, 'origin batch id')
  const remediationBatchId = requiredString(options.remediationBatchId, 'remediation batch id')
  const childRomId = positiveInteger(options.childRomId, 'child ROM id')
  const parentRomId = positiveInteger(options.parentRomId, 'parent ROM id')
  const expectedChildBuildId = positiveInteger(
    options.expectedChildBuildId,
    'expected child build id',
  )
  const expectedParentBuildId = positiveInteger(
    options.expectedParentBuildId,
    'expected parent build id',
  )
  const expectedSourceMemberCount = positiveInteger(
    options.expectedSourceMemberCount,
    'expected source member count',
  )
  if (childRomId === parentRomId) throw new Error('child and parent ROM IDs must differ')

  const origin = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(originBatchId)
  if (!origin) throw new Error(`origin import batch was not found: ${originBatchId}`)
  const existingBatch = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?')
    .get(remediationBatchId)
  const child = sourceRecord(sqlite, childRomId, expectedChildBuildId, 'child')
  const parent = sourceRecord(sqlite, parentRomId, expectedParentBuildId, 'parent')
  const childBuild = buildFromRecord(child)
  const parentBuild = buildFromRecord(parent)

  if (child.dat_parent_set_name?.toLowerCase() !== parent.set_name_normalized.toLowerCase()) {
    throw new Error(
      `child DAT parent ${child.dat_parent_set_name ?? 'null'} does not match ${parent.set_name_normalized}`,
    )
  }
  if (childBuild.core_artifact_id !== parentBuild.core_artifact_id) {
    throw new Error('child and parent builds must use the same core artifact')
  }
  for (const [build, label] of [[childBuild, 'child'], [parentBuild, 'parent']]) {
    if (build.static_status !== 'complete') throw new Error(`${label} build must be complete`)
    if (build.archive_layout !== 'standalone' || build.runtime_parent_build_id !== null) {
      throw new Error(`${label} source build must be standalone without a runtime parent`)
    }
  }
  if (!existingBatch && child.active_build_id !== expectedChildBuildId) {
    throw new Error(`child ROM ${childRomId} active build changed from ${expectedChildBuildId}`)
  }
  if (parent.active_build_id !== expectedParentBuildId) {
    throw new Error(`parent ROM ${parentRomId} active build changed from ${expectedParentBuildId}`)
  }
  assertOriginReference(sqlite, originBatchId, expectedChildBuildId, 'child')
  assertOriginReference(sqlite, originBatchId, expectedParentBuildId, 'parent')
  const sourceMembers = sqlite.prepare(`
    SELECT * FROM build_source_members
    WHERE import_batch_id = ? AND rom_build_id = ?
    ORDER BY member_order, source_archive_path, member_name
  `).all(originBatchId, expectedChildBuildId)
  if (sourceMembers.length !== expectedSourceMemberCount) {
    throw new Error(
      `expected ${expectedSourceMemberCount} child source members, found ${sourceMembers.length}`,
    )
  }

  const contentStore = createContentStore({ root: assetRoot })
  const core = validateCore(sqlite, childBuild.core_artifact_id, contentStore)
  assertBuildFingerprint(parentBuild, parent, core, null)
  assertBuildFingerprint(childBuild, child, core, null)
  validateArchive(sqlite, contentStore, parentBuild, 'parent ROM archive')
  validateArchive(sqlite, contentStore, childBuild, 'child ROM archive')

  const buildFingerprint = computeBuildFingerprint({
    logicalRomScope: `w165:${candidateId(childBuild)}`,
    setNameNormalized: child.set_name_normalized,
    coreArtifactFingerprint: core.artifact_fingerprint,
    archiveSha256: childBuild.archive_sha256,
    contentManifestSha256: childBuild.content_manifest_sha256,
    archiveLayout: 'split',
    runtimeParentBuildFingerprint: parentBuild.build_fingerprint,
    biosManifestSha256: core.bios_manifest_sha256 ?? null,
  })
  const replacement = {
    sourceBuildId: childBuild.id,
    sourceBuildFingerprint: childBuild.build_fingerprint,
    romId: childRomId,
    coreArtifactId: childBuild.core_artifact_id,
    archiveAssetId: childBuild.archive_asset_id,
    archiveSha256: childBuild.archive_sha256,
    contentManifestSha256: childBuild.content_manifest_sha256,
    buildFingerprint,
    staticStatus: childBuild.static_status,
    staticFailureCode: childBuild.static_failure_code ?? null,
    staticFailureDetailsJson: childBuild.static_failure_details_json,
    archiveLayout: 'split',
    runtimeParentBuildId: parentBuild.id,
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'runtime-parent-remediation-v1',
    originBatchId,
    batchId: remediationBatchId,
    child: {
      romId: childRomId,
      setNameNormalized: child.set_name_normalized,
      sourceBuildId: childBuild.id,
      sourceBuildFingerprint: childBuild.build_fingerprint,
      replacementBuildFingerprint: buildFingerprint,
      sourceMemberCount: sourceMembers.length,
      sourceMembersSha256: sourceMemberDigest(sourceMembers),
    },
    parent: {
      romId: parentRomId,
      setNameNormalized: parent.set_name_normalized,
      buildId: parentBuild.id,
      buildFingerprint: parentBuild.build_fingerprint,
    },
  }
  return {
    origin,
    existingBatch,
    child,
    parent,
    replacement,
    sourceMembers,
    manifest,
    manifestSha256: hashCanonicalLibraryJson(manifest),
  }
}

function assertMatchingReplacement(row, planned) {
  const expected = {
    rom_id: planned.romId,
    core_artifact_id: planned.coreArtifactId,
    archive_asset_id: planned.archiveAssetId,
    archive_sha256: planned.archiveSha256,
    content_manifest_sha256: planned.contentManifestSha256,
    build_fingerprint: planned.buildFingerprint,
    static_status: planned.staticStatus,
    static_failure_code: planned.staticFailureCode,
    static_failure_details_json: planned.staticFailureDetailsJson,
    archive_layout: planned.archiveLayout,
    runtime_parent_build_id: planned.runtimeParentBuildId,
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if ((row[field] ?? null) !== (expectedValue ?? null)) {
      throw new Error(`replacement build conflicts at ${field}`)
    }
  }
}

function operationWriter(sqlite, batchId) {
  let sequence = 0
  return (operationKind, entityType, entityKey, before, after) => {
    sequence += 1
    sqlite.prepare(`
      INSERT INTO import_operations
        (import_batch_id, sequence, operation_kind, entity_type,
         entity_key, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      sequence,
      operationKind,
      entityType,
      String(entityKey),
      before === null ? null : canonicalizeLibraryJson(before),
      after === null ? null : canonicalizeLibraryJson(after),
    )
  }
}

function assertCompletedRemediation(sqlite, plan) {
  const refs = sqlite.prepare(`
    SELECT b.*
    FROM batch_build_refs ref
    JOIN rom_builds b ON b.id = ref.rom_build_id
    WHERE ref.import_batch_id = ?
  `).all(plan.manifest.batchId)
  if (refs.length !== 1) throw new Error('existing remediation batch has incomplete build references')
  assertMatchingReplacement(refs[0], plan.replacement)
  const active = sqlite.prepare('SELECT active_build_id FROM roms WHERE id = ?')
    .get(plan.replacement.romId)
  if (active?.active_build_id !== refs[0].id) {
    throw new Error('existing remediation batch is not the active child build')
  }
  const sourceMembers = sqlite.prepare(`
    SELECT * FROM build_source_members
    WHERE import_batch_id = ? AND rom_build_id = ?
    ORDER BY member_order, source_archive_path, member_name
  `).all(plan.manifest.batchId, refs[0].id)
  if (
    sourceMembers.length !== plan.sourceMembers.length ||
    sourceMemberDigest(sourceMembers) !== sourceMemberDigest(plan.sourceMembers)
  ) {
    throw new Error('existing remediation batch has incomplete source provenance')
  }
}

function applyRuntimeParentRemediationPlan(sqlite, plan) {
  if (plan.existingBatch) {
    if (
      plan.existingBatch.manifest_sha256 !== plan.manifestSha256 ||
      plan.existingBatch.status !== 'committed_private'
    ) {
      throw new Error('existing remediation batch conflicts with the requested immutable plan')
    }
    assertCompletedRemediation(sqlite, plan)
    return {
      kind: plan.manifest.kind,
      batchId: plan.manifest.batchId,
      manifestSha256: plan.manifestSha256,
      remediatedBuilds: 1,
      noop: true,
    }
  }

  const execute = sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT INTO import_batches
        (id, owner_user_id, cold_source_sha256, manifest_sha256,
         planned_count, actual_count, total_bytes, status)
      VALUES (?, ?, ?, ?, 1, 0, 0, 'staged')
    `).run(
      plan.manifest.batchId,
      plan.origin.owner_user_id,
      plan.origin.cold_source_sha256,
      plan.manifestSha256,
    )
    const writeOperation = operationWriter(sqlite, plan.manifest.batchId)
    writeOperation(
      'create',
      'import_batch',
      plan.manifest.batchId,
      null,
      sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(plan.manifest.batchId),
    )

    if (sqlite.prepare('SELECT 1 FROM rom_builds WHERE build_fingerprint = ?').get(
      plan.replacement.buildFingerprint,
    )) {
      throw new Error('replacement build fingerprint already exists outside this remediation batch')
    }
    const inserted = sqlite.prepare(`
      INSERT INTO rom_builds
        (rom_id, core_artifact_id, archive_asset_id, archive_sha256,
         content_manifest_sha256, build_fingerprint, static_status,
         static_failure_code, static_failure_details_json, archive_layout,
         runtime_parent_build_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.replacement.romId,
      plan.replacement.coreArtifactId,
      plan.replacement.archiveAssetId,
      plan.replacement.archiveSha256,
      plan.replacement.contentManifestSha256,
      plan.replacement.buildFingerprint,
      plan.replacement.staticStatus,
      plan.replacement.staticFailureCode,
      plan.replacement.staticFailureDetailsJson,
      plan.replacement.archiveLayout,
      plan.replacement.runtimeParentBuildId,
    )
    const replacement = sqlite.prepare('SELECT * FROM rom_builds WHERE id = ?')
      .get(Number(inserted.lastInsertRowid))
    assertMatchingReplacement(replacement, plan.replacement)
    writeOperation('create', 'rom_build', replacement.id, null, replacement)

    sqlite.prepare('INSERT INTO batch_build_refs (import_batch_id, rom_build_id) VALUES (?, ?)')
      .run(plan.manifest.batchId, replacement.id)
    writeOperation(
      'create',
      'batch_build_ref',
      `${plan.manifest.batchId}:${replacement.id}`,
      null,
      { import_batch_id: plan.manifest.batchId, rom_build_id: replacement.id },
    )

    for (const source of plan.sourceMembers) {
      sqlite.prepare(`
        INSERT INTO build_source_members
          (import_batch_id, rom_build_id, source_archive_path, member_name,
           member_role, member_order, member_size, crc32, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.manifest.batchId,
        replacement.id,
        source.source_archive_path,
        source.member_name,
        source.member_role,
        source.member_order,
        source.member_size,
        source.crc32,
        source.sha256,
      )
      const created = sqlite.prepare(`
        SELECT * FROM build_source_members
        WHERE import_batch_id = ? AND rom_build_id = ?
          AND source_archive_path = ? AND member_name = ?
      `).get(
        plan.manifest.batchId,
        replacement.id,
        source.source_archive_path,
        source.member_name,
      )
      writeOperation(
        'create',
        'build_source_member',
        `${plan.manifest.batchId}:${replacement.id}:${source.source_archive_path}:${source.member_name}`,
        null,
        created,
      )
    }

    const beforeRom = sqlite.prepare('SELECT * FROM roms WHERE id = ?')
      .get(plan.replacement.romId)
    const changed = sqlite.prepare(`
      UPDATE roms SET active_build_id = ?
      WHERE id = ? AND active_build_id = ?
    `).run(replacement.id, plan.replacement.romId, plan.replacement.sourceBuildId)
    if (changed.changes !== 1) {
      throw new Error(`child ROM ${plan.replacement.romId} active build changed concurrently`)
    }
    writeOperation(
      'update',
      'rom',
      plan.replacement.romId,
      beforeRom,
      sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(plan.replacement.romId),
    )

    const staged = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?')
      .get(plan.manifest.batchId)
    const completed = sqlite.prepare(`
      UPDATE import_batches
      SET actual_count = 1, status = 'committed_private', updated_at = unixepoch()
      WHERE id = ? AND manifest_sha256 = ? AND status = 'staged'
    `).run(plan.manifest.batchId, plan.manifestSha256)
    if (completed.changes !== 1) {
      throw new Error('remediation batch status compare-and-swap failed')
    }
    writeOperation(
      'update',
      'import_batch',
      plan.manifest.batchId,
      staged,
      sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(plan.manifest.batchId),
    )
    return replacement
  })

  const replacement = execute.immediate()
  return {
    kind: plan.manifest.kind,
    batchId: plan.manifest.batchId,
    manifestSha256: plan.manifestSha256,
    remediatedBuilds: 1,
    replacementBuildId: replacement.id,
    noop: false,
  }
}

export function applyRuntimeParentRemediation(sqlite, options) {
  return applyRuntimeParentRemediationPlan(
    sqlite,
    planRuntimeParentRemediation(sqlite, options),
  )
}

function persistRollbackManifest(path, plan) {
  const target = resolve(requiredString(path, 'manifest output path'))
  const payload = `${canonicalizeLibraryJson({
    ...plan.manifest,
    manifestSha256: plan.manifestSha256,
  })}\n`
  try {
    writeFileSync(target, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'EEXIST' || readFileSync(target, 'utf8') !== payload) {
      throw new Error(`rollback manifest output already exists with different content: ${target}`, {
        cause: error,
      })
    }
  }
  return target
}

function acquireImportLock(dbPath) {
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

export function remediateRuntimeParent({
  dbPath,
  apply = false,
  manifestOutputPath = null,
  ...options
}) {
  const resolvedDbPath = resolve(requiredString(dbPath, 'database path'))
  const releaseLock = apply ? acquireImportLock(resolvedDbPath) : null
  let sqlite = null
  try {
    sqlite = new Database(resolvedDbPath, {
      readonly: !apply,
      fileMustExist: true,
    })
    sqlite.pragma('foreign_keys = ON')
    const plan = planRuntimeParentRemediation(sqlite, options)
    const rollbackManifestPath = manifestOutputPath === null
      ? null
      : persistRollbackManifest(manifestOutputPath, plan)
    const result = apply
      ? applyRuntimeParentRemediationPlan(sqlite, plan)
      : {
          kind: plan.manifest.kind,
          batchId: plan.manifest.batchId,
          manifestSha256: plan.manifestSha256,
          remediatedBuilds: 1,
          noop: false,
          dryRun: true,
        }
    return rollbackManifestPath === null
      ? result
      : { ...result, rollbackManifestPath }
  } finally {
    try {
      sqlite?.close()
    } finally {
      releaseLock?.()
    }
  }
}

function parseArgs(argv) {
  const result = { apply: false }
  const names = new Map([
    ['--db', 'dbPath'],
    ['--asset-root', 'assetRoot'],
    ['--origin-batch', 'originBatchId'],
    ['--remediation-batch', 'remediationBatchId'],
    ['--child-rom-id', 'childRomId'],
    ['--parent-rom-id', 'parentRomId'],
    ['--expected-child-build-id', 'expectedChildBuildId'],
    ['--expected-parent-build-id', 'expectedParentBuildId'],
    ['--expected-source-member-count', 'expectedSourceMemberCount'],
    ['--manifest-output', 'manifestOutputPath'],
  ])
  const numericFields = new Set([
    'childRomId',
    'parentRomId',
    'expectedChildBuildId',
    'expectedParentBuildId',
    'expectedSourceMemberCount',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') {
      result.apply = true
      continue
    }
    const field = names.get(arg)
    if (!field) throw new Error(`unknown argument: ${arg}`)
    const value = argv[++index]
    if (value === undefined) throw new Error(`${arg} requires a value`)
    result[field] = numericFields.has(field) ? Number(value) : value
  }
  return result
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const result = remediateRuntimeParent(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`remediate-runtime-parent: ${error.message}\n`)
    process.exitCode = 1
  }
}
