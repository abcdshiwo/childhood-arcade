import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SET_NAME_PATTERN = /^[a-z0-9_]+$/
const HASH_MODES = new Set(['raw', 'lf-normalized-text'])
const VARIANT_KINDS = new Set(['official', 'hack', 'bootleg'])
const THUMBNAIL_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const CORE_VALIDATION_STATUSES = new Set([
  'existing-core-not-revalidated-for-w165',
  'runtime-validated',
  'static-unverified',
])

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function requiredString(value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null
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

function requiredSize(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return value
}

export function canonicalizeLibraryJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeLibraryJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeLibraryJson(value[key])}`,
      )
      .join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('canonical JSON cannot contain undefined values')
  }
  return serialized
}

export function hashCanonicalLibraryJson(value) {
  return createHash('sha256')
    .update(canonicalizeLibraryJson(value), 'utf8')
    .digest('hex')
}

export function computeCoreArtifactFingerprint(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new TypeError('core artifact identity must be an object')
  }
  const canonicalIdentity = {
    schemaVersion: 1,
    kind: 'core-artifact-v1',
    coreName: requiredString(identity.coreName, 'coreName'),
    displayVersion: requiredString(identity.displayVersion, 'displayVersion'),
    sourceCommit: requiredString(identity.sourceCommit, 'sourceCommit'),
    jsSha256: requiredSha256(identity.jsSha256, 'jsSha256'),
    wasmSha256: requiredSha256(identity.wasmSha256, 'wasmSha256'),
    datSha256: requiredSha256(identity.datSha256, 'datSha256'),
    biosManifestSha256: requiredSha256(
      identity.biosManifestSha256,
      'biosManifestSha256',
    ),
  }
  return hashCanonicalLibraryJson(canonicalIdentity)
}

function validateFileContract(
  contract,
  field,
  { allowedHashModes = HASH_MODES } = {},
) {
  if (!contract || typeof contract !== 'object') {
    throw new TypeError(`${field} file contract is required`)
  }
  requiredString(contract.path, `${field}.path`)
  if (!HASH_MODES.has(contract.hashMode)) {
    throw new TypeError(`${field}.hashMode must be raw or lf-normalized-text`)
  }
  if (!allowedHashModes.has(contract.hashMode)) {
    throw new TypeError(`${field} must use raw hash mode`)
  }
  requiredSha256(contract.expectedRawSha256, `${field}.expectedRawSha256`)
  requiredSize(contract.expectedRawSize, `${field}.expectedRawSize`)
  requiredSha256(contract.expectedSha256, `${field}.expectedSha256`)
  requiredSize(contract.expectedSize, `${field}.expectedSize`)
  if (
    contract.hashMode === 'raw' &&
    (contract.expectedRawSha256.toLowerCase() !==
      contract.expectedSha256.toLowerCase() ||
      contract.expectedRawSize !== contract.expectedSize)
  ) {
    throw new Error(`${field} raw source and stored content contracts must match`)
  }
  return true
}

function validateExpectedLegacyRow(record) {
  const expected = record.expectedLegacyRow
  if (!expected || typeof expected !== 'object' || !expected.fields) {
    throw new TypeError(`ROM ${record.romId} requires expectedLegacyRow fields and digest`)
  }
  if (expected.fields.id !== record.romId) {
    throw new Error(`ROM ${record.romId} expected legacy row has a different id`)
  }
  const expectedDigest = requiredSha256(
    expected.sha256,
    `ROM ${record.romId} expectedLegacyRow.sha256`,
  )
  const actualDigest = hashCanonicalLibraryJson(expected.fields)
  if (actualDigest !== expectedDigest) {
    throw new Error(`ROM ${record.romId} expected legacy row digest is invalid`)
  }
}

function validateBiosManifest(core) {
  const bios = core.artifacts.bios
  if (!Array.isArray(bios) || bios.length === 0) {
    throw new Error(`arcade core ${core.id} requires exact BIOS contracts`)
  }
  const names = new Set()
  for (const [index, member] of bios.entries()) {
    requiredString(member.fileName, `${core.id}.artifacts.bios[${index}].fileName`)
    if (names.has(member.fileName)) {
      throw new Error(`core ${core.id} has duplicate BIOS member ${member.fileName}`)
    }
    names.add(member.fileName)
    validateFileContract(member, `${core.id}.artifacts.bios[${index}]`, {
      allowedHashModes: new Set(['raw']),
    })
  }
  const expectedMembers = [...bios]
    .sort((left, right) => left.fileName.localeCompare(right.fileName, 'en'))
    .map((member) => ({
      fileName: member.fileName,
      sha256: member.expectedSha256.toLowerCase(),
      fileSize: member.expectedSize,
      filePath: `sha256/${member.expectedSha256.slice(0, 2).toLowerCase()}/${member.expectedSha256.toLowerCase()}`,
    }))
  const derived = {
    schemaVersion: 1,
    kind: 'core-bios-manifest-v1',
    members: expectedMembers,
  }
  if (
    canonicalizeLibraryJson(core.expectedBiosManifest) !==
    canonicalizeLibraryJson(derived)
  ) {
    throw new Error(`core ${core.id} BIOS manifest does not match its exact members`)
  }
  const manifestHash = hashCanonicalLibraryJson(derived)
  if (
    manifestHash !==
    requiredSha256(
      core.expectedBiosManifestSha256,
      `${core.id}.expectedBiosManifestSha256`,
    )
  ) {
    throw new Error(`core ${core.id} BIOS manifest hash mismatch`)
  }
  return { manifest: derived, sha256: manifestHash }
}

function validateCoreContract(core, { arcadeRequired }) {
  requiredString(core.id, 'core.id')
  requiredString(core.coreName, `${core.id}.coreName`)
  requiredString(core.displayVersion, `${core.id}.displayVersion`)
  requiredString(core.sourceCommit, `${core.id}.sourceCommit`)
  requiredString(core.runtimeValidationStatus, `${core.id}.runtimeValidationStatus`)
  if (!CORE_VALIDATION_STATUSES.has(core.runtimeValidationStatus)) {
    throw new Error(
      `core ${core.id} has unsupported runtimeValidationStatus ${core.runtimeValidationStatus}`,
    )
  }
  if (typeof core.enabled !== 'boolean') {
    throw new TypeError(`${core.id}.enabled must be boolean`)
  }
  if (core.runtimeValidationStatus === 'static-unverified' && core.enabled) {
    throw new Error(
      `core ${core.id} is static-unverified and cannot be enabled before smoke validation`,
    )
  }
  if (!core.artifacts || typeof core.artifacts !== 'object') {
    throw new TypeError(`${core.id}.artifacts is required`)
  }
  validateFileContract(core.artifacts.js, `${core.id}.artifacts.js`)
  validateFileContract(core.artifacts.wasm, `${core.id}.artifacts.wasm`, {
    allowedHashModes: new Set(['raw']),
  })
  if (arcadeRequired) {
    if (!core.artifacts.dat) {
      throw new Error(`arcade core ${core.id} requires an exact DAT contract`)
    }
    validateFileContract(core.artifacts.dat, `${core.id}.artifacts.dat`, {
      allowedHashModes: new Set(['raw']),
    })
  }
  const biosManifest = arcadeRequired ? validateBiosManifest(core) : null
  const identity = {
    schemaVersion: 1,
    kind: 'core-artifact-v1',
    coreName: core.coreName,
    displayVersion: core.displayVersion,
    sourceCommit: core.sourceCommit,
    jsSha256: core.artifacts.js.expectedSha256,
    wasmSha256: core.artifacts.wasm.expectedSha256,
    datSha256: core.artifacts.dat?.expectedSha256,
    biosManifestSha256: biosManifest?.sha256,
  }
  const fingerprint = computeCoreArtifactFingerprint(identity)
  if (
    fingerprint !==
    requiredSha256(
      core.expectedArtifactFingerprint,
      `${core.id}.expectedArtifactFingerprint`,
    )
  ) {
    throw new Error(`core ${core.id} artifact fingerprint mismatch`)
  }
  return { identity, fingerprint, biosManifest }
}

function validateRomRecord(record, coreIds) {
  if (!Number.isInteger(record.romId) || record.romId <= 0) {
    throw new TypeError('manifest romId must be a positive integer')
  }
  validateExpectedLegacyRow(record)
  if (!coreIds.has(record.coreContractId)) {
    throw new Error(`ROM ${record.romId} references unknown core ${record.coreContractId}`)
  }
  if (
    typeof record.setNameNormalized !== 'string' ||
    !SET_NAME_PATTERN.test(record.setNameNormalized)
  ) {
    throw new TypeError(`ROM ${record.romId} setNameNormalized is invalid`)
  }
  if (
    record.variantKind !== null &&
    !VARIANT_KINDS.has(record.variantKind)
  ) {
    throw new TypeError(
      `ROM ${record.romId} variantKind must be explicit official, hack, bootleg, or null`,
    )
  }
  for (const field of ['datParentSetName', 'familyRootSetName', 'versionLabel']) {
    if (!hasOwn(record, field)) {
      throw new TypeError(`ROM ${record.romId} requires resolved ${field}`)
    }
    if (record[field] !== null && typeof record[field] !== 'string') {
      throw new TypeError(`ROM ${record.romId} ${field} must be string or null`)
    }
  }
  if (!['standalone', 'split'].includes(record.archiveLayout)) {
    throw new TypeError(`ROM ${record.romId} archiveLayout must be standalone or split`)
  }
  if (!hasOwn(record, 'runtimeParentRomId')) {
    throw new TypeError(`ROM ${record.romId} requires resolved runtimeParentRomId`)
  }
  if (
    record.archiveLayout === 'standalone' &&
    record.runtimeParentRomId !== null
  ) {
    throw new Error(`ROM ${record.romId} standalone layout cannot have a runtime parent`)
  }
  if (
    record.archiveLayout === 'split' &&
    (!Number.isInteger(record.runtimeParentRomId) || record.runtimeParentRomId <= 0)
  ) {
    throw new Error(`ROM ${record.romId} split layout requires a runtime parent`)
  }
  validateFileContract(record.source, `ROM ${record.romId}.source`, {
    allowedHashModes: new Set(['raw']),
  })
  requiredString(record.source.archiveName, `ROM ${record.romId}.source.archiveName`)
  const expectedManifest = record.source.expectedContentManifest
  if (
    !expectedManifest ||
    expectedManifest.schemaVersion !== 1 ||
    expectedManifest.kind !== 'legacy-opaque-v1'
  ) {
    throw new Error(`ROM ${record.romId} requires legacy-opaque-v1 content manifest data`)
  }
  const contentHash = hashCanonicalLibraryJson(expectedManifest)
  if (
    contentHash !==
    requiredSha256(
      record.source.expectedContentManifestSha256,
      `ROM ${record.romId}.source.expectedContentManifestSha256`,
    )
  ) {
    throw new Error(`ROM ${record.romId} content manifest hash mismatch`)
  }
  if (record.thumbnail) {
    validateFileContract(record.thumbnail, `ROM ${record.romId}.thumbnail`, {
      allowedHashModes: new Set(['raw']),
    })
    if (!['exact', 'alias', 'parent', 'source_reference', 'placeholder'].includes(record.thumbnail.matchKind)) {
      throw new TypeError(`ROM ${record.romId} thumbnail matchKind is invalid`)
    }
    if (!hasOwn(record.thumbnail, 'sourceSetName')) {
      throw new TypeError(`ROM ${record.romId}.thumbnail.sourceSetName is required`)
    }
    if (
      record.thumbnail.sourceSetName !== null &&
      (typeof record.thumbnail.sourceSetName !== 'string' ||
        !SET_NAME_PATTERN.test(record.thumbnail.sourceSetName))
    ) {
      throw new TypeError(
        `ROM ${record.romId}.thumbnail.sourceSetName must be a canonical string or null`,
      )
    }
    const sourceFileSha256 = requiredSha256(
      record.thumbnail.sourceFileSha256,
      `ROM ${record.romId}.thumbnail.sourceFileSha256`,
    )
    if (sourceFileSha256 !== record.thumbnail.expectedRawSha256.toLowerCase()) {
      throw new Error(
        `ROM ${record.romId} thumbnail source hash must match its raw file contract`,
      )
    }
    const mimeType = requiredString(
      record.thumbnail.mimeType,
      `ROM ${record.romId}.thumbnail.mimeType`,
    )
    if (!THUMBNAIL_MIME_TYPES.has(mimeType)) {
      throw new TypeError(`ROM ${record.romId} thumbnail must use a safe image MIME type`)
    }
  }
}

export function validateLegacyLibraryManifest(
  manifest,
  { manifestPath, expectedRomIds } = {},
) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('legacy library manifest must be an object')
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'legacy-library-backfill-v1'
  ) {
    throw new Error('unsupported legacy library manifest schema')
  }
  if (!Array.isArray(manifest.allowedSourceRoots) || manifest.allowedSourceRoots.length === 0) {
    throw new Error('manifest requires explicit allowed source roots')
  }
  for (const sourceRoot of manifest.allowedSourceRoots) {
    requiredString(sourceRoot, 'allowedSourceRoots[]')
  }
  if (!Array.isArray(manifest.cores) || manifest.cores.length === 0) {
    throw new Error('manifest requires at least one core contract')
  }
  if (!Array.isArray(manifest.roms)) {
    throw new Error('manifest roms must be an array')
  }

  const coreIds = new Set()
  for (const core of manifest.cores) {
    if (coreIds.has(core.id)) throw new Error(`duplicate core contract id ${core.id}`)
    coreIds.add(core.id)
  }
  const arcadeCoreIds = new Set(
    manifest.roms
      .filter((record) => record.expectedLegacyRow?.fields?.platform === 'arcade')
      .map((record) => record.coreContractId),
  )
  const coreContracts = new Map()
  for (const core of manifest.cores) {
    coreContracts.set(
      core.id,
      validateCoreContract(core, { arcadeRequired: arcadeCoreIds.has(core.id) }),
    )
  }

  const romIds = new Set()
  for (const record of manifest.roms) {
    if (romIds.has(record.romId)) throw new Error(`duplicate manifest ROM id ${record.romId}`)
    romIds.add(record.romId)
    validateRomRecord(record, coreIds)
  }
  if (expectedRomIds) {
    const expected = [...new Set(expectedRomIds)].sort((left, right) => left - right)
    const actual = [...romIds].sort((left, right) => left - right)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const missing = expected.filter((id) => !romIds.has(id))
      const extra = actual.filter((id) => !expected.includes(id))
      throw new Error(
        `manifest ROM ID coverage mismatch; missing=[${missing.join(',')}], extra=[${extra.join(',')}]`,
      )
    }
  }

  if (manifest.platformCoreContracts) {
    for (const [platform, coreId] of Object.entries(manifest.platformCoreContracts)) {
      requiredString(platform, 'platformCoreContracts platform')
      if (!coreIds.has(coreId)) {
        throw new Error(`platform ${platform} references unknown core ${coreId}`)
      }
    }
  }
  return {
    manifestPath: manifestPath ? resolve(manifestPath) : null,
    coreContracts,
    romIds: [...romIds].sort((left, right) => left - right),
  }
}

export function loadLegacyLibraryManifest(manifestPath, options = {}) {
  const absolutePath = resolve(manifestPath)
  const manifest = JSON.parse(readFileSync(absolutePath, 'utf8'))
  const validation = validateLegacyLibraryManifest(manifest, {
    ...options,
    manifestPath: absolutePath,
  })
  return { manifest, manifestPath: absolutePath, validation }
}

export function resolveManifestSourcePath(manifestPath, sourcePath) {
  return isAbsolute(sourcePath)
    ? resolve(sourcePath)
    : resolve(dirname(resolve(manifestPath)), sourcePath)
}

export function resolvedManifestSourceRoots(manifest, manifestPath) {
  return manifest.allowedSourceRoots.map((sourceRoot) =>
    resolveManifestSourcePath(manifestPath, sourceRoot),
  )
}

export function ensureAssetRecord(sqlite, asset) {
  let row = sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(asset.sha256)
  if (row) {
    const expected = {
      kind: asset.kind,
      file_path: asset.filePath,
      mime_type: asset.mimeType ?? null,
      file_size: asset.fileSize,
    }
    for (const [field, value] of Object.entries(expected)) {
      const actual = field === 'file_size' ? Number(row[field]) : row[field]
      if (actual !== value) {
        throw new Error(
          `immutable asset ${asset.sha256} has conflicting ${field} metadata`,
        )
      }
    }
    return { row, created: false }
  }
  const conflict = sqlite.prepare('SELECT * FROM assets WHERE file_path = ?').get(asset.filePath)
  if (conflict) {
    throw new Error(`content path ${asset.filePath} belongs to a different asset`)
  }
  const result = sqlite
    .prepare(`
      INSERT INTO assets (kind, file_path, mime_type, file_size, sha256)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(asset.kind, asset.filePath, asset.mimeType ?? null, asset.fileSize, asset.sha256)
  row = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(Number(result.lastInsertRowid))
  return { row, created: true }
}

function coreBiosMembers(plan, assetsBySha) {
  return plan.biosMembers.map((member) => ({
    fileName: member.fileName,
    assetId: assetsBySha.get(member.sha256).id,
    rawSha256: member.rawSha256,
    rawFileSize: member.rawFileSize,
    sha256: member.sha256,
    fileSize: member.fileSize,
    filePath: member.filePath,
  }))
}

function coreProvenance(plan, assetsBySha) {
  const biosManifestAsset = assetsBySha.get(plan.biosManifest.sha256)
  return {
    schemaVersion: 1,
    kind: 'legacy-core-artifact-provenance-v1',
    contractId: plan.contractId,
    runtimeValidationStatus: plan.runtimeValidationStatus,
    operatorProvenance: plan.operatorProvenance ?? null,
    artifacts: {
      js: plan.jsProvenance,
      wasm: plan.wasmProvenance,
      dat: plan.datProvenance,
    },
    bios: {
      manifestAssetId: biosManifestAsset.id,
      manifestSha256: plan.biosManifest.sha256,
      members: coreBiosMembers(plan, assetsBySha),
    },
  }
}

function assertCoreArtifactProvenance(row, plan, assetsBySha) {
  let provenance
  try {
    provenance = JSON.parse(row.provenance_json)
  } catch {
    throw new Error(`core artifact ${plan.artifactFingerprint} provenance is invalid JSON`)
  }
  if (
    provenance?.schemaVersion !== 1 ||
    provenance?.kind !== 'legacy-core-artifact-provenance-v1'
  ) {
    throw new Error(`core artifact ${plan.artifactFingerprint} provenance is invalid`)
  }
  for (const [field, value] of [
    ['contractId', plan.contractId],
    ['runtimeValidationStatus', plan.runtimeValidationStatus],
  ]) {
    if (provenance[field] !== value) {
      throw new Error(
        `core artifact ${plan.artifactFingerprint} provenance conflicts at ${field}`,
      )
    }
  }
  for (const name of ['js', 'wasm', 'dat']) {
    const actual = provenance.artifacts?.[name]
    const expected = plan[`${name}Provenance`]
    for (const field of [
      'hashMode',
      'rawSha256',
      'rawFileSize',
      'storedSha256',
      'storedFileSize',
      'storedPath',
    ]) {
      if (actual?.[field] !== expected[field]) {
        throw new Error(
          `core artifact ${plan.artifactFingerprint} provenance conflicts at ${name}.${field}`,
        )
      }
    }
    if (typeof actual.sourcePath !== 'string' || actual.sourcePath.length === 0) {
      throw new Error(
        `core artifact ${plan.artifactFingerprint} provenance lacks ${name}.sourcePath`,
      )
    }
    if (
      actual.hashMode === 'raw' &&
      (actual.rawSha256 !== actual.storedSha256 ||
        actual.rawFileSize !== actual.storedFileSize)
    ) {
      throw new Error(
        `core artifact ${plan.artifactFingerprint} raw provenance is inconsistent`,
      )
    }
  }
  const expectedBios = {
    manifestAssetId: assetsBySha.get(plan.biosManifest.sha256).id,
    manifestSha256: plan.biosManifest.sha256,
    members: coreBiosMembers(plan, assetsBySha),
  }
  if (
    canonicalizeLibraryJson(provenance.bios) !==
    canonicalizeLibraryJson(expectedBios)
  ) {
    throw new Error(
      `core artifact ${plan.artifactFingerprint} BIOS provenance conflicts`,
    )
  }
}

export function ensureCoreArtifactRecord(sqlite, plan, assetsBySha) {
  const jsAsset = assetsBySha.get(plan.js.sha256)
  const wasmAsset = assetsBySha.get(plan.wasm.sha256)
  const datAsset = assetsBySha.get(plan.dat.sha256)
  const biosManifestAsset = assetsBySha.get(plan.biosManifest.sha256)
  const identity = {
    core_name: plan.coreName,
    display_version: plan.displayVersion,
    source_commit: plan.sourceCommit,
    js_asset_id: jsAsset.id,
    js_sha256: plan.js.sha256,
    wasm_asset_id: wasmAsset.id,
    wasm_sha256: plan.wasm.sha256,
    dat_asset_id: datAsset.id,
    dat_sha256: plan.dat.sha256,
    bios_asset_id: biosManifestAsset.id,
    bios_manifest_sha256: plan.biosManifest.sha256,
    artifact_fingerprint: plan.artifactFingerprint,
    is_enabled: plan.enabled ? 1 : 0,
  }
  let row = sqlite
    .prepare('SELECT * FROM core_artifacts WHERE artifact_fingerprint = ?')
    .get(plan.artifactFingerprint)
  if (row) {
    for (const [field, value] of Object.entries(identity)) {
      if (row[field] !== value) {
        throw new Error(
          `immutable core artifact ${plan.artifactFingerprint} conflicts at ${field}`,
        )
      }
    }
    assertCoreArtifactProvenance(row, plan, assetsBySha)
    return { row, created: false }
  }
  const expected = {
    ...identity,
    provenance_json: canonicalizeLibraryJson(coreProvenance(plan, assetsBySha)),
  }
  const result = sqlite
    .prepare(`
      INSERT INTO core_artifacts
        (core_name, display_version, source_commit, js_asset_id, js_sha256,
         wasm_asset_id, wasm_sha256, dat_asset_id, dat_sha256, bios_asset_id,
         bios_manifest_sha256, artifact_fingerprint, provenance_json, is_enabled)
      VALUES
        (@core_name, @display_version, @source_commit, @js_asset_id, @js_sha256,
         @wasm_asset_id, @wasm_sha256, @dat_asset_id, @dat_sha256, @bios_asset_id,
         @bios_manifest_sha256, @artifact_fingerprint, @provenance_json, @is_enabled)
    `)
    .run(expected)
  row = sqlite
    .prepare('SELECT * FROM core_artifacts WHERE id = ?')
    .get(Number(result.lastInsertRowid))
  return { row, created: true }
}

export function countAssetReferences(sqlite, assetId) {
  if (!Number.isInteger(assetId) || assetId <= 0) {
    throw new TypeError('assetId must be a positive integer')
  }
  const direct = sqlite
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM core_artifacts WHERE js_asset_id = @id) +
        (SELECT COUNT(*) FROM core_artifacts WHERE wasm_asset_id = @id) +
        (SELECT COUNT(*) FROM core_artifacts WHERE dat_asset_id = @id) +
        (SELECT COUNT(*) FROM core_artifacts WHERE bios_asset_id = @id) +
        (SELECT COUNT(*) FROM rom_builds WHERE archive_asset_id = @id) +
        (SELECT COUNT(*) FROM rom_asset_refs WHERE asset_id = @id) +
        (SELECT COUNT(*) FROM build_validation_runs WHERE log_asset_id = @id) +
        (SELECT COUNT(*) FROM build_validation_runs WHERE frame_asset_id = @id)
        AS count
    `)
    .get({ id: assetId }).count
  let serviceLevel = 0
  for (const { provenance_json: provenanceJson } of sqlite
    .prepare('SELECT provenance_json FROM core_artifacts WHERE provenance_json IS NOT NULL')
    .all()) {
    let provenance
    try {
      provenance = JSON.parse(provenanceJson)
    } catch {
      throw new Error('core artifact provenance JSON is invalid')
    }
    serviceLevel += (provenance?.bios?.members ?? []).filter(
      (member) => member.assetId === assetId,
    ).length
  }
  return Number(direct) + serviceLevel
}

export function assetIsReferencedBySha(sqlite, contentSha256) {
  const row = sqlite.prepare('SELECT id FROM assets WHERE sha256 = ?').get(contentSha256)
  return row ? countAssetReferences(sqlite, row.id) > 0 : false
}
