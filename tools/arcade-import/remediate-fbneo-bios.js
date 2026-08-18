#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
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
  return value
}

function requiredSha256(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value.toLowerCase())) {
    throw new TypeError(`${field} must be a 64-character SHA-256 hex string`)
  }
  return value.toLowerCase()
}

function parseJson(value, field) {
  try {
    const parsed = JSON.parse(value || 'null')
    if (!parsed || typeof parsed !== 'object') throw new Error('expected an object')
    return parsed
  } catch (error) {
    throw new Error(`${field} is invalid JSON: ${error.message}`, { cause: error })
  }
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

function assertCoreFingerprint(core, label) {
  const actual = computeCoreArtifactFingerprint(coreIdentity(core))
  const expected = requiredSha256(core.artifact_fingerprint, `${label} artifact fingerprint`)
  if (actual !== expected) {
    throw new Error(`${label} artifact fingerprint does not match its immutable identity`)
  }
}

function verifyStoredAsset(contentStore, asset, label) {
  const fullPath = contentStore.resolveStoredPath(asset.file_path)
  const stat = lstatSync(fullPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} is not a regular content-store file`)
  }
  const bytes = readFileSync(fullPath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.sha256 || bytes.length !== Number(asset.file_size)) {
    throw new Error(`${label} content does not match its database hash and size`)
  }
  return bytes
}

function validateCoreRuntimeAssets(sqlite, core, assetRoot) {
  const contentStore = createContentStore({ root: resolve(assetRoot) })
  for (const { assetId, digest, kind, label } of [
    {
      assetId: core.js_asset_id,
      digest: core.js_sha256,
      kind: 'core_js',
      label: 'target core JavaScript',
    },
    {
      assetId: core.wasm_asset_id,
      digest: core.wasm_sha256,
      kind: 'core_wasm',
      label: 'target core WebAssembly',
    },
  ]) {
    const asset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)
    if (!asset || asset.kind !== kind || asset.sha256 !== digest) {
      throw new Error(`${label} asset is invalid`)
    }
    verifyStoredAsset(contentStore, asset, label)
  }
}

function validateBiosCore(sqlite, core, assetRoot) {
  const provenance = parseJson(core.provenance_json, 'target core provenance')
  const bios = provenance.bios
  if (!bios || !Array.isArray(bios.members)) {
    throw new Error('target core BIOS provenance is missing')
  }
  if (
    Number(bios.manifestAssetId) !== Number(core.bios_asset_id) ||
    String(bios.manifestSha256 || '').toLowerCase() !== core.bios_manifest_sha256
  ) {
    throw new Error('target core BIOS provenance does not match its manifest identity')
  }
  const member = bios.members.find((candidate) => candidate?.fileName === 'neogeo.zip')
  if (!member) throw new Error('target core BIOS provenance has no neogeo.zip member')

  const manifestAsset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(core.bios_asset_id)
  const memberAsset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(member.assetId)
  if (
    !manifestAsset || manifestAsset.kind !== 'bios_manifest' ||
    manifestAsset.sha256 !== core.bios_manifest_sha256
  ) {
    throw new Error('target core BIOS manifest asset is invalid')
  }
  if (
    !memberAsset || memberAsset.kind !== 'bios' ||
    memberAsset.sha256 !== String(member.sha256 || '').toLowerCase() ||
    memberAsset.file_path !== member.filePath ||
    Number(memberAsset.file_size) !== Number(member.fileSize)
  ) {
    throw new Error('target core neogeo.zip BIOS asset is invalid')
  }

  const contentStore = createContentStore({ root: resolve(assetRoot) })
  const manifestBytes = verifyStoredAsset(contentStore, manifestAsset, 'BIOS manifest')
  verifyStoredAsset(contentStore, memberAsset, 'neogeo.zip BIOS')
  const manifest = parseJson(manifestBytes.toString('utf8'), 'BIOS manifest asset')
  const expectedManifest = {
    schemaVersion: 1,
    kind: 'core-bios-manifest-v1',
    members: [...bios.members]
      .map((entry) => ({
        fileName: entry.fileName,
        sha256: entry.sha256,
        fileSize: entry.fileSize,
        filePath: entry.filePath,
      }))
      .sort((left, right) => left.fileName.localeCompare(right.fileName, 'en')),
  }
  if (canonicalizeLibraryJson(manifest) !== canonicalizeLibraryJson(expectedManifest)) {
    throw new Error('target core BIOS manifest asset conflicts with BIOS provenance')
  }
  return member
}

function validateCorePair(sqlite, {
  assetRoot,
  sourceCoreFingerprint,
  targetCoreFingerprint,
}) {
  const source = sqlite.prepare('SELECT * FROM core_artifacts WHERE artifact_fingerprint = ?')
    .get(requiredSha256(sourceCoreFingerprint, 'source core fingerprint'))
  const target = sqlite.prepare('SELECT * FROM core_artifacts WHERE artifact_fingerprint = ?')
    .get(requiredSha256(targetCoreFingerprint, 'target core fingerprint'))
  if (!source) throw new Error('source FBNeo core artifact was not found')
  if (!target) throw new Error('target FBNeo core artifact was not found')
  assertCoreFingerprint(source, 'source core')
  assertCoreFingerprint(target, 'target core')
  if (source.core_name !== 'fbneo' || target.core_name !== 'fbneo') {
    throw new Error('BIOS remediation is restricted to exact FBNeo core artifacts')
  }
  for (const field of [
    'core_name', 'display_version', 'source_commit', 'js_sha256', 'wasm_sha256', 'dat_sha256',
  ]) {
    if ((source[field] ?? null) !== (target[field] ?? null)) {
      throw new Error(`source and target FBNeo cores differ at ${field}`)
    }
  }
  if (source.bios_asset_id !== null || source.bios_manifest_sha256 !== null) {
    throw new Error('source FBNeo core is not the expected BIOS-less artifact')
  }
  if (target.bios_asset_id === null || target.bios_manifest_sha256 === null) {
    throw new Error('target FBNeo core has no immutable BIOS identity')
  }
  validateCoreRuntimeAssets(sqlite, target, assetRoot)
  validateBiosCore(sqlite, target, assetRoot)
  return { source, target }
}

function validateSourceArchives(sqlite, sourceBuilds, assetRoot) {
  const contentStore = createContentStore({ root: resolve(assetRoot) })
  const verifiedAssets = new Set()
  for (const build of sourceBuilds) {
    const assetId = Number(build.archive_asset_id)
    const digest = String(build.archive_sha256 || '').toLowerCase()
    if (!Number.isSafeInteger(assetId) || assetId <= 0 || !SHA256_PATTERN.test(digest)) {
      throw new Error(`build ${build.id} ROM archive identity is invalid`)
    }
    const identity = `${assetId}:${digest}`
    if (verifiedAssets.has(identity)) continue
    const asset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)
    const expectedPath = `sha256/${digest.slice(0, 2)}/${digest}`
    if (
      !asset || asset.kind !== 'rom' || asset.sha256 !== digest ||
      asset.file_path !== expectedPath || !Number.isSafeInteger(Number(asset.file_size)) ||
      Number(asset.file_size) < 0
    ) {
      throw new Error(`build ${build.id} ROM archive asset is invalid`)
    }
    verifyStoredAsset(contentStore, asset, `build ${build.id} ROM archive`)
    verifiedAssets.add(identity)
  }
}

function candidateId(build) {
  const evidence = parseJson(build.static_failure_details_json, `build ${build.id} evidence`)
  return requiredString(evidence.candidateId, `build ${build.id} candidateId`).toLowerCase()
}

function replacementBuildPlan(sourceBuilds, targetCore) {
  const sourceById = new Map(sourceBuilds.map((build) => [build.id, build]))
  const plannedBySourceId = new Map()
  const pending = new Map(sourceById)

  while (pending.size > 0) {
    let progressed = false
    for (const [sourceBuildId, build] of pending) {
      const sourceParentId = build.runtime_parent_build_id ?? null
      if (sourceParentId !== null && !plannedBySourceId.has(sourceParentId)) {
        if (!sourceById.has(sourceParentId)) {
          throw new Error(`build ${build.id} depends on a parent outside the remediation set`)
        }
        continue
      }
      const parent = sourceParentId === null ? null : plannedBySourceId.get(sourceParentId)
      const nextFingerprint = computeBuildFingerprint({
        logicalRomScope: `w165:${candidateId(build)}`,
        setNameNormalized: build.set_name_normalized,
        coreArtifactFingerprint: targetCore.artifact_fingerprint,
        archiveSha256: build.archive_sha256,
        contentManifestSha256: build.content_manifest_sha256,
        archiveLayout: build.archive_layout,
        runtimeParentBuildFingerprint: parent?.buildFingerprint ?? null,
        biosManifestSha256: targetCore.bios_manifest_sha256,
      })
      plannedBySourceId.set(sourceBuildId, {
        sourceBuildId,
        sourceBuildFingerprint: build.build_fingerprint,
        romId: build.rom_id,
        setNameNormalized: build.set_name_normalized,
        coreArtifactId: targetCore.id,
        archiveAssetId: build.archive_asset_id,
        archiveSha256: build.archive_sha256,
        contentManifestSha256: build.content_manifest_sha256,
        buildFingerprint: nextFingerprint,
        staticStatus: build.static_status,
        staticFailureCode: build.static_failure_code ?? null,
        staticFailureDetailsJson: build.static_failure_details_json,
        archiveLayout: build.archive_layout,
        sourceParentBuildId: sourceParentId,
      })
      pending.delete(sourceBuildId)
      progressed = true
    }
    if (!progressed) throw new Error('FBNeo build dependency graph contains a cycle')
  }
  return [...plannedBySourceId.values()]
}

export function planFbneoBiosRemediation(sqlite, options) {
  if (!sqlite || typeof sqlite.prepare !== 'function') {
    throw new TypeError('a better-sqlite3 connection is required')
  }
  const originBatchId = requiredString(options.originBatchId, 'origin batch id')
  const remediationBatchId = requiredString(options.remediationBatchId, 'remediation batch id')
  const expectedBuildCount = Number(options.expectedBuildCount)
  if (!Number.isSafeInteger(expectedBuildCount) || expectedBuildCount <= 0) {
    throw new TypeError('expected build count must be a positive integer')
  }
  const origin = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(originBatchId)
  if (!origin) throw new Error(`origin import batch was not found: ${originBatchId}`)
  const { source, target } = validateCorePair(sqlite, options)
  const sourceBuilds = sqlite.prepare(`
    SELECT b.*, r.set_name_normalized, r.active_build_id
    FROM rom_builds b
    JOIN roms r ON r.id = b.rom_id
    JOIN batch_build_refs ref ON ref.rom_build_id = b.id
    WHERE ref.import_batch_id = ? AND b.core_artifact_id = ?
    ORDER BY b.id
  `).all(originBatchId, source.id)
  if (sourceBuilds.length !== expectedBuildCount) {
    throw new Error(`expected ${expectedBuildCount} FBNeo builds, found ${sourceBuilds.length}`)
  }
  if (sourceBuilds.some((build) => build.static_status !== 'complete')) {
    throw new Error('FBNeo BIOS remediation only accepts complete source builds')
  }
  validateSourceArchives(sqlite, sourceBuilds, options.assetRoot)
  const builds = replacementBuildPlan(sourceBuilds, target)
  const manifest = {
    schemaVersion: 1,
    kind: 'fbneo-bios-remediation-v1',
    originBatchId,
    remediationBatchId,
    sourceCoreFingerprint: source.artifact_fingerprint,
    targetCoreFingerprint: target.artifact_fingerprint,
    biosManifestSha256: target.bios_manifest_sha256,
    builds: builds.map((build) => ({
      sourceBuildId: build.sourceBuildId,
      sourceBuildFingerprint: build.sourceBuildFingerprint,
      buildFingerprint: build.buildFingerprint,
      sourceParentBuildId: build.sourceParentBuildId,
      romId: build.romId,
    })),
  }
  return {
    origin,
    sourceCore: source,
    targetCore: target,
    builds,
    manifest,
    manifestSha256: hashCanonicalLibraryJson(manifest),
  }
}

function assertMatchingReplacement(row, planned, runtimeParentBuildId) {
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
    runtime_parent_build_id: runtimeParentBuildId,
  }
  for (const [field, value] of Object.entries(expected)) {
    if ((row[field] ?? null) !== (value ?? null)) {
      throw new Error(`replacement build ${planned.buildFingerprint} conflicts at ${field}`)
    }
  }
}

function operationWriter(sqlite, batchId) {
  let sequence = 0
  return (operationKind, entityType, entityKey, before, after) => {
    sequence += 1
    sqlite.prepare(`
      INSERT INTO import_operations
        (import_batch_id, sequence, operation_kind, entity_type, entity_key, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId, sequence, operationKind, entityType, String(entityKey),
      before === null ? null : canonicalizeLibraryJson(before),
      after === null ? null : canonicalizeLibraryJson(after),
    )
  }
}

function assertCompletedRemediation(sqlite, plan) {
  const refs = sqlite.prepare(`
    SELECT b.* FROM batch_build_refs ref
    JOIN rom_builds b ON b.id = ref.rom_build_id
    WHERE ref.import_batch_id = ?
  `).all(plan.manifest.remediationBatchId)
  if (refs.length !== plan.builds.length) {
    throw new Error('existing remediation batch has incomplete build references')
  }
  const byFingerprint = new Map(refs.map((build) => [build.build_fingerprint, build]))
  for (const planned of plan.builds) {
    const row = byFingerprint.get(planned.buildFingerprint)
    if (!row) throw new Error(`existing remediation batch is missing ${planned.buildFingerprint}`)
  }
}

export function applyFbneoBiosRemediation(sqlite, options) {
  const plan = planFbneoBiosRemediation(sqlite, options)
  const existingBatch = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?')
    .get(plan.manifest.remediationBatchId)
  if (existingBatch) {
    if (
      existingBatch.manifest_sha256 !== plan.manifestSha256 ||
      existingBatch.status !== 'committed_private'
    ) {
      throw new Error('existing remediation batch conflicts with the requested immutable plan')
    }
    assertCompletedRemediation(sqlite, plan)
    return {
      kind: plan.manifest.kind,
      batchId: plan.manifest.remediationBatchId,
      manifestSha256: plan.manifestSha256,
      remediatedBuilds: plan.builds.length,
      noop: true,
    }
  }

  const execute = sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT INTO import_batches
        (id, owner_user_id, cold_source_sha256, manifest_sha256,
         planned_count, actual_count, total_bytes, status)
      VALUES (?, ?, ?, ?, ?, 0, 0, 'staged')
    `).run(
      plan.manifest.remediationBatchId,
      plan.origin.owner_user_id,
      plan.origin.cold_source_sha256,
      plan.manifestSha256,
      plan.builds.length,
    )
    const writeOperation = operationWriter(sqlite, plan.manifest.remediationBatchId)
    writeOperation(
      'create', 'import_batch', plan.manifest.remediationBatchId, null,
      sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(plan.manifest.remediationBatchId),
    )

    const replacementBySourceId = new Map()
    let promoted = 0
    for (const planned of plan.builds) {
      const parent = planned.sourceParentBuildId === null
        ? null
        : replacementBySourceId.get(planned.sourceParentBuildId)
      if (planned.sourceParentBuildId !== null && !parent) {
        throw new Error(`replacement parent was not created for source build ${planned.sourceBuildId}`)
      }
      let replacement = sqlite.prepare('SELECT * FROM rom_builds WHERE build_fingerprint = ?')
        .get(planned.buildFingerprint)
      if (replacement) {
        assertMatchingReplacement(replacement, planned, parent?.id ?? null)
      } else {
        const inserted = sqlite.prepare(`
          INSERT INTO rom_builds
            (rom_id, core_artifact_id, archive_asset_id, archive_sha256,
             content_manifest_sha256, build_fingerprint, static_status,
             static_failure_code, static_failure_details_json, archive_layout,
             runtime_parent_build_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          planned.romId, planned.coreArtifactId, planned.archiveAssetId,
          planned.archiveSha256, planned.contentManifestSha256,
          planned.buildFingerprint, planned.staticStatus,
          planned.staticFailureCode, planned.staticFailureDetailsJson,
          planned.archiveLayout, parent?.id ?? null,
        )
        replacement = sqlite.prepare('SELECT * FROM rom_builds WHERE id = ?')
          .get(Number(inserted.lastInsertRowid))
        writeOperation('create', 'rom_build', replacement.id, null, replacement)
      }
      replacementBySourceId.set(planned.sourceBuildId, replacement)

      sqlite.prepare('INSERT INTO batch_build_refs (import_batch_id, rom_build_id) VALUES (?, ?)')
        .run(plan.manifest.remediationBatchId, replacement.id)
      writeOperation(
        'create', 'batch_build_ref', `${plan.manifest.remediationBatchId}:${replacement.id}`,
        null, { import_batch_id: plan.manifest.remediationBatchId, rom_build_id: replacement.id },
      )

      const rom = sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(planned.romId)
      if (rom.active_build_id === planned.sourceBuildId) {
        const changed = sqlite.prepare('UPDATE roms SET active_build_id = ? WHERE id = ? AND active_build_id = ?')
          .run(replacement.id, planned.romId, planned.sourceBuildId)
        if (changed.changes !== 1) throw new Error(`ROM ${planned.romId} active build changed concurrently`)
        const updated = sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(planned.romId)
        writeOperation('update', 'rom', planned.romId, rom, updated)
        promoted += 1
      }
    }

    const staged = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?')
      .get(plan.manifest.remediationBatchId)
    const changed = sqlite.prepare(`
      UPDATE import_batches
      SET actual_count = ?, status = 'committed_private'
      WHERE id = ? AND manifest_sha256 = ? AND status = 'staged'
    `).run(plan.builds.length, plan.manifest.remediationBatchId, plan.manifestSha256)
    if (changed.changes !== 1) throw new Error('remediation batch status compare-and-swap failed')
    const committed = sqlite.prepare('SELECT * FROM import_batches WHERE id = ?')
      .get(plan.manifest.remediationBatchId)
    writeOperation('update', 'import_batch', plan.manifest.remediationBatchId, staged, committed)
    return { promoted }
  })

  const applied = execute.immediate()
  return {
    kind: plan.manifest.kind,
    batchId: plan.manifest.remediationBatchId,
    manifestSha256: plan.manifestSha256,
    remediatedBuilds: plan.builds.length,
    promotedBuilds: applied.promoted,
    noop: false,
  }
}

export function remediateFbneoBios({ dbPath, apply = false, ...options }) {
  const sqlite = new Database(resolve(requiredString(dbPath, 'database path')), {
    readonly: !apply,
    fileMustExist: true,
  })
  try {
    sqlite.pragma('foreign_keys = ON')
    if (apply) return applyFbneoBiosRemediation(sqlite, options)
    const plan = planFbneoBiosRemediation(sqlite, options)
    return {
      kind: plan.manifest.kind,
      batchId: plan.manifest.remediationBatchId,
      manifestSha256: plan.manifestSha256,
      remediatedBuilds: plan.builds.length,
      noop: false,
      dryRun: true,
    }
  } finally {
    sqlite.close()
  }
}

function parseArgs(argv) {
  const result = { apply: false }
  const names = new Map([
    ['--db', 'dbPath'],
    ['--asset-root', 'assetRoot'],
    ['--origin-batch', 'originBatchId'],
    ['--remediation-batch', 'remediationBatchId'],
    ['--source-core', 'sourceCoreFingerprint'],
    ['--target-core', 'targetCoreFingerprint'],
    ['--expected-build-count', 'expectedBuildCount'],
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
    result[field] = field === 'expectedBuildCount' ? Number(value) : value
  }
  return result
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const result = remediateFbneoBios(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`remediate-fbneo-bios: ${error.message}\n`)
    process.exitCode = 1
  }
}
