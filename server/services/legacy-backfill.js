import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readLibraryMigrationState } from '../db/migration-runner.js'
import {
  computeBuildFingerprint,
  computeCompatibilityStatus,
} from './build-contract.js'
import { createContentStore } from './content-store.js'
import {
  assetIsReferencedBySha,
  canonicalizeLibraryJson,
  ensureAssetRecord,
  ensureCoreArtifactRecord,
  hashCanonicalLibraryJson,
  loadLegacyLibraryManifest,
  resolveManifestSourcePath,
  resolvedManifestSourceRoots,
} from './library-service.js'

function assertSqlite(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== 'function' || typeof sqlite.transaction !== 'function') {
    throw new TypeError('a better-sqlite3 connection is required')
  }
}

function queryLegacyRoms(sqlite) {
  return sqlite
    .prepare(`
      SELECT id, user_id AS userId, title, platform,
             file_name AS fileName, file_path AS filePath,
             file_size AS fileSize, is_public AS isPublic,
             parent_rom_id AS parentRomId, version_label AS versionLabel,
             status, created_at AS createdAt, updated_at AS updatedAt
      FROM roms ORDER BY id
    `)
    .all()
}

function scalarCount(sqlite, query, parameters = {}) {
  const statement = sqlite.prepare(query)
  const row = Array.isArray(parameters)
    ? statement.get(...parameters)
    : statement.get(parameters)
  return Number(row.count)
}

function summary(sqlite, phase = readLibraryMigrationState(sqlite).phase) {
  return {
    phase,
    romCount: scalarCount(sqlite, 'SELECT COUNT(*) AS count FROM roms'),
    deletedRomCount: scalarCount(
      sqlite,
      'SELECT COUNT(*) AS count FROM roms WHERE status = 0',
    ),
    romsWithBuild: scalarCount(
      sqlite,
      'SELECT COUNT(*) AS count FROM roms WHERE active_build_id IS NOT NULL',
    ),
    deletedRomsWithBuild: scalarCount(
      sqlite,
      'SELECT COUNT(*) AS count FROM roms WHERE status = 0 AND active_build_id IS NOT NULL',
    ),
    favoriteCount: scalarCount(sqlite, 'SELECT COUNT(*) AS count FROM favorites'),
    roomCount: scalarCount(sqlite, 'SELECT COUNT(*) AS count FROM rooms'),
    roomsWithBuild: scalarCount(
      sqlite,
      'SELECT COUNT(*) AS count FROM rooms WHERE rom_build_id IS NOT NULL',
    ),
    saveStateCount: scalarCount(sqlite, 'SELECT COUNT(*) AS count FROM save_states'),
    savesWithBuild: scalarCount(
      sqlite,
      'SELECT COUNT(*) AS count FROM save_states WHERE rom_build_id IS NOT NULL',
    ),
    validationRunCount: scalarCount(
      sqlite,
      'SELECT COUNT(*) AS count FROM build_validation_runs',
    ),
    acceptedValidationCount: scalarCount(
      sqlite,
      "SELECT COUNT(*) AS count FROM build_validation_runs WHERE acceptance = 'accepted'",
    ),
  }
}

function legacyPreservationSnapshot(sqlite) {
  return {
    users: sqlite.prepare('SELECT * FROM users ORDER BY id').all(),
    roms: sqlite
      .prepare(`
        SELECT id, user_id, title, platform, file_name, file_path, file_size,
               is_public, parent_rom_id, status, created_at, updated_at
        FROM roms ORDER BY id
      `)
      .all(),
    favorites: sqlite
      .prepare('SELECT user_id, rom_id, created_at FROM favorites ORDER BY user_id, rom_id')
      .all(),
    rooms: sqlite
      .prepare(`
        SELECT id, code, host_user_id, rom_id, name, is_public, allow_play,
               password_hash, status, created_at, updated_at, closed_at
        FROM rooms ORDER BY id
      `)
      .all(),
    saves: sqlite
      .prepare(`
        SELECT id, user_id, rom_id, slot, file_path, file_size, status, updated_at
        FROM save_states ORDER BY id
      `)
      .all(),
    sequences: sqlite
      .prepare(`
        SELECT name, seq FROM sqlite_sequence
        WHERE name IN ('users', 'roms', 'rooms', 'save_states')
        ORDER BY name
      `)
      .all(),
  }
}

function assertLegacyPreserved(before, after) {
  if (canonicalizeLibraryJson(before) !== canonicalizeLibraryJson(after)) {
    throw new Error('legacy rows, ownership, files, statuses, or sequences changed during backfill')
  }
}

function assertManifestRowsMatchDatabase(rows, records) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const manifestIds = new Set(records.map((record) => record.romId))
  const missing = [...byId.keys()].filter((id) => !manifestIds.has(id))
  const extra = [...manifestIds].filter((id) => !byId.has(id))
  if (missing.length > 0 || extra.length > 0 || rows.length !== records.length) {
    throw new Error(
      `manifest ROM ID coverage mismatch; unplanned=[${missing.join(',')}], missing=[${extra.join(',')}]`,
    )
  }
  for (const record of records) {
    const row = byId.get(record.romId)
    if (!row) throw new Error(`manifest ROM ${record.romId} is missing from the database`)
    const actualDigest = hashCanonicalLibraryJson(row)
    if (
      actualDigest !== record.expectedLegacyRow.sha256 ||
      canonicalizeLibraryJson(row) !==
        canonicalizeLibraryJson(record.expectedLegacyRow.fields)
    ) {
      throw new Error(`legacy row ${record.romId} has drifted from the manifest`)
    }
  }
}

function topologicalRomRecords(records) {
  const byId = new Map(records.map((record) => [record.romId, record]))
  const visiting = new Set()
  const visited = new Set()
  const ordered = []

  function visit(record) {
    if (visited.has(record.romId)) return
    if (visiting.has(record.romId)) {
      throw new Error(`legacy runtime-parent cycle includes ROM ${record.romId}`)
    }
    visiting.add(record.romId)
    if (record.runtimeParentRomId !== null) {
      const parent = byId.get(record.runtimeParentRomId)
      if (!parent) {
        throw new Error(
          `ROM ${record.romId} is missing runtime parent ${record.runtimeParentRomId}`,
        )
      }
      if (parent.coreContractId !== record.coreContractId) {
        throw new Error(
          `ROM ${record.romId} runtime parent must use the same core contract`,
        )
      }
      visit(parent)
      if (
        record.datParentSetName === null ||
        record.datParentSetName !== parent.setNameNormalized
      ) {
        throw new Error(
          `ROM ${record.romId} DAT parent ${record.datParentSetName ?? 'null'} does not match runtime parent set ${parent.setNameNormalized}`,
        )
      }
      if (parent.archiveLayout !== 'standalone') {
        throw new Error(
          `ROM ${record.romId} runtime parent ${parent.romId} must be a standalone direct parent build`,
        )
      }
    }
    visiting.delete(record.romId)
    visited.add(record.romId)
    ordered.push(record)
  }

  for (const record of [...records].sort((left, right) => left.romId - right.romId)) {
    visit(record)
  }
  return ordered
}

function addAsset(assetMap, asset, { kind, mimeType = null }) {
  const planned = { ...asset, kind, mimeType }
  const existing = assetMap.get(asset.sha256)
  if (existing) {
    if (
      existing.filePath !== planned.filePath ||
      existing.fileSize !== planned.fileSize ||
      existing.kind !== planned.kind ||
      (existing.mimeType ?? null) !== (planned.mimeType ?? null)
    ) {
      throw new Error(`content hash ${asset.sha256} has conflicting planned metadata`)
    }
    return existing
  }
  assetMap.set(asset.sha256, planned)
  return planned
}

function artifactProvenance(asset, contract, resolvedPath) {
  return {
    sourcePath: resolvedPath,
    hashMode: contract.hashMode,
    rawSha256: asset.rawSha256,
    rawFileSize: asset.rawFileSize,
    storedSha256: asset.sha256,
    storedFileSize: asset.fileSize,
    storedPath: asset.filePath,
  }
}

function putSource(contentStore, contract, manifestPath, { kind, mimeType, dryRun }) {
  const sourcePath = resolveManifestSourcePath(manifestPath, contract.path)
  const asset = contentStore.putSource({
    sourcePath,
    expectedSha256: contract.expectedSha256,
    expectedSize: contract.expectedSize,
    expectedRawSha256: contract.expectedRawSha256,
    expectedRawSize: contract.expectedRawSize,
    hashMode: contract.hashMode,
    kind,
    dryRun,
  })
  return {
    asset: { ...asset, kind, mimeType },
    sourcePath,
    provenance: artifactProvenance(asset, contract, sourcePath),
  }
}

function assertRomSourceIsLegacyPath(record, manifestPath) {
  const manifestSource = resolveManifestSourcePath(manifestPath, record.source.path)
  const legacyPath = resolveManifestSourcePath(
    manifestPath,
    record.expectedLegacyRow.fields.filePath,
  )
  if (manifestSource !== legacyPath) {
    throw new Error(
      `ROM ${record.romId} source path does not match legacy row.file_path`,
    )
  }
}

function createPlan({
  manifest,
  manifestPath,
  validation,
  contentStore,
  writeAssets,
  createdObjects = [],
}) {
  const assets = new Map()
  const cores = []
  const coreByContractId = new Map()

  const rememberCreated = (asset) => {
    if (
      asset.created &&
      !createdObjects.some((candidate) => candidate.filePath === asset.filePath)
    ) {
      createdObjects.push(asset)
    }
  }

  for (const core of [...manifest.cores].sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
    const contractValidation = validation.coreContracts.get(core.id)
    const js = putSource(contentStore, core.artifacts.js, manifestPath, {
      kind: 'core_js',
      mimeType: 'text/javascript',
      dryRun: !writeAssets,
    })
    const wasm = putSource(contentStore, core.artifacts.wasm, manifestPath, {
      kind: 'core_wasm',
      mimeType: 'application/wasm',
      dryRun: !writeAssets,
    })
    const dat =
      core.artifacts.dat === null
        ? null
        : putSource(contentStore, core.artifacts.dat, manifestPath, {
            kind: 'core_dat',
            mimeType: 'text/plain',
            dryRun: !writeAssets,
          })
    for (const item of [js, wasm, ...(dat ? [dat] : [])]) {
      rememberCreated(item.asset)
      addAsset(assets, item.asset, item.asset)
    }

    const biosMembers = []
    for (const member of [...(core.artifacts.bios ?? [])].sort((left, right) =>
      left.fileName.localeCompare(right.fileName, 'en'),
    )) {
      const stored = putSource(contentStore, member, manifestPath, {
        kind: 'bios',
        mimeType: 'application/octet-stream',
        dryRun: !writeAssets,
      })
      rememberCreated(stored.asset)
      addAsset(assets, stored.asset, stored.asset)
      biosMembers.push({
        fileName: member.fileName,
        ...stored.asset,
        sourcePath: stored.sourcePath,
      })
    }
    let biosManifest = null
    if (contractValidation.biosManifest) {
      const biosManifestBytes = Buffer.from(
        canonicalizeLibraryJson(contractValidation.biosManifest.manifest),
        'utf8',
      )
      const storedBiosManifest = contentStore.putBytes({
        bytes: biosManifestBytes,
        expectedSha256: contractValidation.biosManifest.sha256,
        expectedSize: biosManifestBytes.length,
        hashMode: 'raw',
        kind: 'bios_manifest',
        dryRun: !writeAssets,
      })
      rememberCreated(storedBiosManifest)
      addAsset(assets, storedBiosManifest, {
        kind: 'bios_manifest',
        mimeType: 'application/json',
      })
      biosManifest = {
        ...storedBiosManifest,
        kind: 'bios_manifest',
        mimeType: 'application/json',
        manifest: contractValidation.biosManifest.manifest,
      }
    }

    const plan = {
      contractId: core.id,
      coreName: core.coreName,
      displayVersion: core.displayVersion,
      sourceCommit: core.sourceCommit,
      runtimeValidationStatus: core.runtimeValidationStatus,
      enabled: core.enabled,
      artifactFingerprint: contractValidation.fingerprint,
      operatorProvenance: core.provenance ?? null,
      js: js.asset,
      wasm: wasm.asset,
      dat: dat?.asset ?? null,
      biosManifest,
      biosMembers,
      jsProvenance: js.provenance,
      wasmProvenance: wasm.provenance,
      datProvenance: dat?.provenance ?? null,
    }
    cores.push(plan)
    coreByContractId.set(core.id, plan)
  }

  const builds = []
  const buildByRomId = new Map()
  for (const record of topologicalRomRecords(manifest.roms)) {
    assertRomSourceIsLegacyPath(record, manifestPath)
    const source = putSource(contentStore, record.source, manifestPath, {
      kind: 'rom',
      mimeType: 'application/octet-stream',
      dryRun: !writeAssets,
    })
    rememberCreated(source.asset)
    addAsset(assets, source.asset, source.asset)

    const parentPlan =
      record.runtimeParentRomId === null
        ? null
        : buildByRomId.get(record.runtimeParentRomId)
    const derivedContentManifest = {
      schemaVersion: 1,
      kind: 'legacy-opaque-v1',
      archiveName: record.source.archiveName,
      archiveSize: source.asset.rawFileSize,
      archiveSha256: source.asset.rawSha256,
      runtimeParentBuildFingerprint: parentPlan?.buildFingerprint ?? null,
    }
    if (
      canonicalizeLibraryJson(derivedContentManifest) !==
      canonicalizeLibraryJson(record.source.expectedContentManifest)
    ) {
      throw new Error(
        `ROM ${record.romId} legacy-opaque-v1 manifest is detached from actual source or parent build`,
      )
    }
    const contentManifestSha256 = hashCanonicalLibraryJson(derivedContentManifest)
    if (contentManifestSha256 !== record.source.expectedContentManifestSha256) {
      throw new Error(`ROM ${record.romId} content manifest hash mismatch`)
    }
    const core = coreByContractId.get(record.coreContractId)
    const buildFingerprint = computeBuildFingerprint({
      logicalRomScope: `legacy:rom:${record.romId}`,
      setNameNormalized: record.setNameNormalized,
      coreArtifactFingerprint: core.artifactFingerprint,
      archiveSha256: source.asset.rawSha256,
      contentManifestSha256,
      archiveLayout: record.archiveLayout,
      runtimeParentBuildFingerprint: parentPlan?.buildFingerprint ?? null,
      biosManifestSha256: core.biosManifest?.sha256 ?? null,
    })

    let thumbnail = null
    if (record.thumbnail) {
      const stored = putSource(contentStore, record.thumbnail, manifestPath, {
        kind: 'thumbnail',
        mimeType: record.thumbnail.mimeType,
        dryRun: !writeAssets,
      })
      if (
        record.thumbnail.sourceFileSha256 &&
        record.thumbnail.sourceFileSha256.toLowerCase() !== stored.asset.rawSha256
      ) {
        throw new Error(`ROM ${record.romId} thumbnail source hash mismatch`)
      }
      rememberCreated(stored.asset)
      addAsset(assets, stored.asset, stored.asset)
      thumbnail = {
        ...stored.asset,
        matchKind: record.thumbnail.matchKind,
        sourceSetName: record.thumbnail.sourceSetName ?? null,
        sourceFileSha256: stored.asset.rawSha256,
      }
    }

    const build = {
      romId: record.romId,
      logicalRomScope: `legacy:rom:${record.romId}`,
      setNameNormalized: record.setNameNormalized,
      variantKind: record.variantKind,
      datParentSetName: record.datParentSetName,
      familyRootSetName: record.familyRootSetName,
      versionLabel: record.versionLabel,
      coreContractId: record.coreContractId,
      coreArtifactFingerprint: core.artifactFingerprint,
      archive: source.asset,
      archiveSha256: source.asset.rawSha256,
      contentManifest: derivedContentManifest,
      contentManifestSha256,
      archiveLayout: record.archiveLayout,
      runtimeParentRomId: record.runtimeParentRomId,
      runtimeParentBuildFingerprint: parentPlan?.buildFingerprint ?? null,
      buildFingerprint,
      staticStatus: 'complete',
      compatStatus: computeCompatibilityStatus({
        staticStatus: 'complete',
        acceptedResult: null,
      }),
      biosManifestSha256: core.biosManifest?.sha256 ?? null,
      thumbnail,
    }
    builds.push(build)
    buildByRomId.set(record.romId, build)
  }

  const assetEvidence = (asset) => ({
    kind: asset.kind,
    mimeType: asset.mimeType ?? null,
    sha256: asset.sha256,
    fileSize: asset.fileSize,
    filePath: asset.filePath,
  })
  const sourceEvidence = (asset, provenance) => ({
    ...assetEvidence(asset),
    hashMode: provenance.hashMode,
    rawSha256: provenance.rawSha256,
    rawFileSize: provenance.rawFileSize,
  })
  const naturalPlan = {
    schemaVersion: 1,
    kind: 'legacy-library-backfill-plan-v1',
    manifestSha256: hashCanonicalLibraryJson(manifest),
    assets: [...assets.values()]
      .sort((left, right) => left.sha256.localeCompare(right.sha256, 'en'))
      .map(assetEvidence),
    coreArtifacts: cores.map((core) => ({
      contractId: core.contractId,
      artifactFingerprint: core.artifactFingerprint,
      coreName: core.coreName,
      displayVersion: core.displayVersion,
      sourceCommit: core.sourceCommit,
      runtimeValidationStatus: core.runtimeValidationStatus,
      enabled: core.enabled,
      operatorProvenance: core.operatorProvenance,
      js: sourceEvidence(core.js, core.jsProvenance),
      wasm: sourceEvidence(core.wasm, core.wasmProvenance),
      dat: core.dat ? sourceEvidence(core.dat, core.datProvenance) : null,
      biosManifest: core.biosManifest
        ? {
            ...assetEvidence(core.biosManifest),
            manifest: core.biosManifest.manifest,
          }
        : null,
      biosMembers: core.biosMembers.map((member) => ({
        fileName: member.fileName,
        ...assetEvidence(member),
        rawSha256: member.rawSha256,
        rawFileSize: member.rawFileSize,
      })),
    })),
    romBuilds: builds.map((build) => ({
      romId: build.romId,
      expectedLegacyRowSha256: manifest.roms.find(
        (record) => record.romId === build.romId,
      ).expectedLegacyRow.sha256,
      logicalRomScope: build.logicalRomScope,
      setNameNormalized: build.setNameNormalized,
      variantKind: build.variantKind,
      datParentSetName: build.datParentSetName,
      familyRootSetName: build.familyRootSetName,
      versionLabel: build.versionLabel,
      coreContractId: build.coreContractId,
      coreArtifactFingerprint: build.coreArtifactFingerprint,
      archive: {
        ...assetEvidence(build.archive),
        rawSha256: build.archive.rawSha256,
        rawFileSize: build.archive.rawFileSize,
      },
      archiveSha256: build.archiveSha256,
      contentManifest: build.contentManifest,
      contentManifestSha256: build.contentManifestSha256,
      archiveLayout: build.archiveLayout,
      runtimeParentRomId: build.runtimeParentRomId,
      runtimeParentBuildFingerprint: build.runtimeParentBuildFingerprint,
      buildFingerprint: build.buildFingerprint,
      staticStatus: build.staticStatus,
      compatStatus: build.compatStatus,
      biosManifestSha256: build.biosManifestSha256,
      thumbnail: build.thumbnail
        ? {
            ...assetEvidence(build.thumbnail),
            rawSha256: build.thumbnail.rawSha256,
            rawFileSize: build.thumbnail.rawFileSize,
            matchKind: build.thumbnail.matchKind,
            sourceSetName: build.thumbnail.sourceSetName,
            sourceFileSha256: build.thumbnail.sourceFileSha256,
          }
        : null,
    })),
  }
  return {
    assets,
    cores,
    builds,
    buildByRomId,
    records: manifest.roms,
    createdObjects,
    evidence: {
      ...naturalPlan,
      digest: hashCanonicalLibraryJson(naturalPlan),
      assetCount: assets.size,
    },
  }
}

function emptyWrites() {
  return {
    filesystemCreated: 0,
    assetsInserted: 0,
    coreArtifactsInserted: 0,
    buildsInserted: 0,
    romsUpdated: 0,
    thumbnailRefsInserted: 0,
    roomsUpdated: 0,
    savesUpdated: 0,
    phaseUpdated: 0,
    total: 0,
  }
}

function summarizeDurability(durability) {
  if (!durability) return null
  return {
    publishedFile: durability.publishedFile ?? null,
    directoryMetadata: durability.directoryMetadata,
    unsupportedDirectoryCount:
      durability.unsupportedDirectories?.length ?? 0,
  }
}

function emptyOperationalDurability() {
  return {
    schemaVersion: 1,
    kind: 'legacy-library-backfill-operational-durability-v1',
    lock: {
      acquired: false,
      publication: null,
      release: null,
    },
    publishedObjects: [],
  }
}

function appliedOperationalDurability({
  lock,
  releaseDurability,
  createdObjects,
}) {
  return {
    schemaVersion: 1,
    kind: 'legacy-library-backfill-operational-durability-v1',
    lock: {
      acquired: true,
      publication: summarizeDurability(lock.durability),
      release: summarizeDurability(releaseDurability),
    },
    publishedObjects: [...createdObjects]
      .sort((left, right) => left.filePath.localeCompare(right.filePath, 'en'))
      .map((record) => ({
        filePath: record.filePath,
        sha256: record.sha256,
        ...summarizeDurability(record.durability),
      })),
  }
}

function finalizeWrites(writes) {
  writes.total = Object.entries(writes)
    .filter(([key]) => key !== 'total')
    .reduce((total, [, value]) => total + value, 0)
  return writes
}

function expectedAfter(before) {
  return {
    ...before,
    phase: 'backfilled',
    romsWithBuild: before.romCount,
    deletedRomsWithBuild: before.deletedRomCount,
    roomsWithBuild: before.roomCount,
    savesWithBuild: before.saveStateCount,
  }
}

function assertBackfilledConsistency(sqlite, plan) {
  const assetRowsBySha = new Map()
  for (const asset of plan.assets.values()) {
    if (!existsSync(asset.absolutePath)) {
      throw new Error(`backfilled content object ${asset.sha256} is missing from disk`)
    }
    const bytes = readFileSync(asset.absolutePath)
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== asset.fileSize || actualSha256 !== asset.sha256) {
      throw new Error(`backfilled content object ${asset.sha256} is corrupt on disk`)
    }
    const row = sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(asset.sha256)
    if (!row) {
      throw new Error(`backfilled asset ${asset.sha256} is missing or inconsistent`)
    }
    const ensured = ensureAssetRecord(sqlite, asset)
    if (ensured.created) {
      throw new Error(`backfilled asset ${asset.sha256} was not immutable`)
    }
    assetRowsBySha.set(asset.sha256, ensured.row)
  }
  const coreRows = new Map()
  for (const core of plan.cores) {
    const existing = sqlite
      .prepare('SELECT id FROM core_artifacts WHERE artifact_fingerprint = ?')
      .get(core.artifactFingerprint)
    if (!existing) {
      throw new Error(`core artifact ${core.artifactFingerprint} is missing`)
    }
    const ensured = ensureCoreArtifactRecord(sqlite, core, assetRowsBySha)
    if (ensured.created) {
      throw new Error(`core artifact ${core.artifactFingerprint} was not immutable`)
    }
    coreRows.set(core.contractId, ensured.row)
  }

  const buildRows = new Map()
  for (const build of plan.builds) {
    const row = sqlite
      .prepare('SELECT * FROM rom_builds WHERE build_fingerprint = ?')
      .get(build.buildFingerprint)
    if (!row || row.rom_id !== build.romId) {
      throw new Error(`backfilled ROM ${build.romId} build is missing or cross-owned`)
    }
    const parentRow =
      build.runtimeParentRomId === null
        ? null
        : buildRows.get(build.runtimeParentRomId)
    const expected = {
      core_artifact_id: coreRows.get(build.coreContractId).id,
      archive_asset_id: assetRowsBySha.get(build.archive.sha256).id,
      archive_sha256: build.archiveSha256,
      content_manifest_sha256: build.contentManifestSha256,
      static_status: 'complete',
      static_failure_code: null,
      static_failure_details_json: null,
      archive_layout: build.archiveLayout,
      runtime_parent_build_id: parentRow?.id ?? null,
    }
    for (const [field, value] of Object.entries(expected)) {
      if (row[field] !== value) {
        throw new Error(`backfilled ROM ${build.romId} build conflicts at ${field}`)
      }
    }
    const rom = sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(build.romId)
    const romExpected = {
      set_name_normalized: build.setNameNormalized,
      variant_kind: build.variantKind,
      dat_parent_set_name: build.datParentSetName,
      family_root_set_name: build.familyRootSetName,
      version_label: build.versionLabel,
      active_build_id: row.id,
    }
    for (const [field, value] of Object.entries(romExpected)) {
      if (rom[field] !== value) {
        throw new Error(`backfilled ROM ${build.romId} conflicts at ${field}`)
      }
    }
    if (build.thumbnail) {
      const ref = sqlite
        .prepare(`
          SELECT r.*, a.sha256 AS asset_sha256 FROM rom_asset_refs r
          JOIN assets a ON a.id = r.asset_id
          WHERE r.id = ?
        `)
        .get(rom.active_thumbnail_ref_id)
      const expectedThumbnail = {
        rom_id: build.romId,
        asset_sha256: build.thumbnail.sha256,
        match_kind: build.thumbnail.matchKind,
        source_set_name: build.thumbnail.sourceSetName,
        source_file_sha256: build.thumbnail.sourceFileSha256,
        import_batch_id: null,
      }
      for (const [field, value] of Object.entries(expectedThumbnail)) {
        if (!ref || ref[field] !== value) {
          throw new Error(
            `backfilled ROM ${build.romId} thumbnail conflicts at ${field}`,
          )
        }
      }
    } else if (rom.active_thumbnail_ref_id !== null) {
      throw new Error(`backfilled ROM ${build.romId} has an undeclared thumbnail`)
    }
    buildRows.set(build.romId, row)
  }

  for (const room of sqlite.prepare('SELECT id, rom_id, rom_build_id FROM rooms').all()) {
    if (room.rom_build_id !== buildRows.get(room.rom_id)?.id) {
      throw new Error(`room ${room.id} is not locked to its legacy ROM build`)
    }
  }
  for (const save of sqlite
    .prepare(`
      SELECT id, rom_id, rom_build_id, build_fingerprint,
             core_artifact_fingerprint, content_manifest_sha256
      FROM save_states
    `)
    .all()) {
    const build = plan.buildByRomId.get(save.rom_id)
    const buildRow = buildRows.get(save.rom_id)
    if (
      !build ||
      save.rom_build_id !== buildRow.id ||
      save.build_fingerprint !== build.buildFingerprint ||
      save.core_artifact_fingerprint !== build.coreArtifactFingerprint ||
      save.content_manifest_sha256 !== build.contentManifestSha256
    ) {
      throw new Error(`save state ${save.id} is not locked to its exact legacy build`)
    }
  }
  const buildIds = [...buildRows.values()].map((row) => row.id)
  if (buildIds.length > 0) {
    const placeholders = buildIds.map(() => '?').join(',')
    const accepted = scalarCount(
      sqlite,
      `SELECT COUNT(*) AS count FROM build_validation_runs WHERE rom_build_id IN (${placeholders}) AND acceptance = 'accepted'`,
      buildIds,
    )
    if (accepted !== 0) {
      throw new Error('legacy builds cannot have fabricated accepted validations')
    }
  }
  return { coreRows, buildRows }
}

function assertNoMissingBuildPointers(sqlite) {
  for (const [label, query] of [
    ['ROM', 'SELECT COUNT(*) AS count FROM roms WHERE active_build_id IS NULL'],
    ['room', 'SELECT COUNT(*) AS count FROM rooms WHERE rom_build_id IS NULL'],
    ['save state', 'SELECT COUNT(*) AS count FROM save_states WHERE rom_build_id IS NULL'],
  ]) {
    const missing = scalarCount(sqlite, query)
    if (missing !== 0) {
      throw new Error(`${missing} ${label} rows are missing exact build pointers`)
    }
  }
}

function updateRomPointers(sqlite, build, buildRow, thumbnailRefId) {
  const row = sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(build.romId)
  const desired = desiredRomValues(build, buildRow?.id ?? null, thumbnailRefId)
  const updates = {}
  for (const [field, value] of Object.entries(desired)) {
    if (row[field] === value) continue
    if (row[field] !== null) {
      throw new Error(`ROM ${build.romId} immutable backfill field ${field} conflicts`)
    }
    if (value !== null) updates[field] = value
  }
  const entries = Object.entries(updates)
  if (entries.length === 0) return 0
  const setSql = entries.map(([field]) => `${field} = @${field}`).join(', ')
  return sqlite
    .prepare(`UPDATE roms SET ${setSql} WHERE id = @romId`)
    .run({ ...updates, romId: build.romId }).changes
}

function desiredRomValues(build, buildId, thumbnailRefId) {
  return {
    set_name_normalized: build.setNameNormalized,
    variant_kind: build.variantKind,
    dat_parent_set_name: build.datParentSetName,
    family_root_set_name: build.familyRootSetName,
    version_label: build.versionLabel,
    active_build_id: buildId,
    active_thumbnail_ref_id: thumbnailRefId,
  }
}

function expectedBuildRecord(build, coreRow, archiveAsset, parentRow) {
  return {
    rom_id: build.romId,
    core_artifact_id: coreRow.id,
    archive_asset_id: archiveAsset.id,
    archive_sha256: build.archiveSha256,
    content_manifest_sha256: build.contentManifestSha256,
    build_fingerprint: build.buildFingerprint,
    static_status: 'complete',
    static_failure_code: null,
    static_failure_details_json: null,
    archive_layout: build.archiveLayout,
    runtime_parent_build_id: parentRow?.id ?? null,
  }
}

function assertBuildRecord(row, build, expected) {
  for (const [field, value] of Object.entries(expected)) {
    if (row[field] !== value) {
      throw new Error(`immutable build ${build.buildFingerprint} conflicts at ${field}`)
    }
  }
}

function ensureBuildRecord(sqlite, build, coreRow, archiveAsset, parentRow) {
  const expected = expectedBuildRecord(build, coreRow, archiveAsset, parentRow)
  let row = sqlite
    .prepare('SELECT * FROM rom_builds WHERE build_fingerprint = ?')
    .get(build.buildFingerprint)
  if (row) {
    assertBuildRecord(row, build, expected)
    return { row, created: false }
  }
  const result = sqlite
    .prepare(`
      INSERT INTO rom_builds
        (rom_id, core_artifact_id, archive_asset_id, archive_sha256,
         content_manifest_sha256, build_fingerprint, static_status,
         static_failure_code, static_failure_details_json, archive_layout,
         runtime_parent_build_id)
      VALUES
        (@rom_id, @core_artifact_id, @archive_asset_id, @archive_sha256,
         @content_manifest_sha256, @build_fingerprint, @static_status,
         @static_failure_code, @static_failure_details_json, @archive_layout,
         @runtime_parent_build_id)
    `)
    .run(expected)
  row = sqlite.prepare('SELECT * FROM rom_builds WHERE id = ?').get(Number(result.lastInsertRowid))
  return { row, created: true }
}

function matchingThumbnailRefs(sqlite, build, assetRow) {
  if (!build.thumbnail || !assetRow) return []
  return sqlite
    .prepare(`
      SELECT * FROM rom_asset_refs
      WHERE rom_id = ? AND asset_id = ? AND match_kind = ?
        AND source_set_name IS ? AND source_file_sha256 = ?
        AND import_batch_id IS NULL
      ORDER BY id
    `)
    .all(
      build.romId,
      assetRow.id,
      build.thumbnail.matchKind,
      build.thumbnail.sourceSetName,
      build.thumbnail.sourceFileSha256,
    )
}

function ensureThumbnailRef(sqlite, build, assetRow) {
  if (!build.thumbnail) return { id: null, created: false }
  const rows = matchingThumbnailRefs(sqlite, build, assetRow)
  if (rows.length > 1) {
    throw new Error(`ROM ${build.romId} has duplicate legacy thumbnail references`)
  }
  if (rows.length === 1) return { id: rows[0].id, created: false }
  const result = sqlite
    .prepare(`
      INSERT INTO rom_asset_refs
        (rom_id, asset_id, match_kind, source_set_name, source_file_sha256)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      build.romId,
      assetRow.id,
      build.thumbnail.matchKind,
      build.thumbnail.sourceSetName,
      build.thumbnail.sourceFileSha256,
    )
  return { id: Number(result.lastInsertRowid), created: true }
}

function assertExpandedPlanCompatible(sqlite, plan) {
  const assetRowsBySha = new Map()
  for (const asset of plan.assets.values()) {
    const pathConflict = sqlite
      .prepare('SELECT sha256 FROM assets WHERE file_path = ?')
      .get(asset.filePath)
    if (pathConflict && pathConflict.sha256 !== asset.sha256) {
      throw new Error(`content path ${asset.filePath} belongs to a different asset`)
    }
    const row = sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(asset.sha256)
    if (!row) continue
    const ensured = ensureAssetRecord(sqlite, asset)
    assetRowsBySha.set(asset.sha256, ensured.row)
  }

  const coreRows = new Map()
  for (const core of plan.cores) {
    const row = sqlite
      .prepare('SELECT * FROM core_artifacts WHERE artifact_fingerprint = ?')
      .get(core.artifactFingerprint)
    if (!row) {
      coreRows.set(core.contractId, null)
      continue
    }
    for (const sha of [
      core.js.sha256,
      core.wasm.sha256,
      core.dat?.sha256 ?? null,
      core.biosManifest?.sha256 ?? null,
      ...core.biosMembers.map((member) => member.sha256),
    ].filter(Boolean)) {
      if (!assetRowsBySha.has(sha)) {
        throw new Error(
          `core artifact ${core.artifactFingerprint} exists without planned asset ${sha}`,
        )
      }
    }
    const ensured = ensureCoreArtifactRecord(sqlite, core, assetRowsBySha)
    coreRows.set(core.contractId, ensured.row)
  }

  const buildRows = new Map()
  for (const build of plan.builds) {
    const row = sqlite
      .prepare('SELECT * FROM rom_builds WHERE build_fingerprint = ?')
      .get(build.buildFingerprint)
    if (!row) {
      buildRows.set(build.romId, null)
      continue
    }
    const coreRow = coreRows.get(build.coreContractId)
    const archiveAsset = assetRowsBySha.get(build.archive.sha256)
    const parentRow =
      build.runtimeParentRomId === null
        ? null
        : buildRows.get(build.runtimeParentRomId)
    if (!coreRow || !archiveAsset || (build.runtimeParentRomId !== null && !parentRow)) {
      throw new Error(`immutable build ${build.buildFingerprint} has missing natural dependencies`)
    }
    assertBuildRecord(
      row,
      build,
      expectedBuildRecord(build, coreRow, archiveAsset, parentRow),
    )
    buildRows.set(build.romId, row)
  }

  for (const build of plan.builds) {
    const row = sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(build.romId)
    const buildRow = buildRows.get(build.romId)
    const thumbnailAsset = build.thumbnail
      ? assetRowsBySha.get(build.thumbnail.sha256)
      : null
    const thumbnailRefs = matchingThumbnailRefs(sqlite, build, thumbnailAsset)
    if (thumbnailRefs.length > 1) {
      throw new Error(`ROM ${build.romId} has duplicate legacy thumbnail references`)
    }
    const desired = desiredRomValues(
      build,
      buildRow?.id ?? null,
      thumbnailRefs[0]?.id ?? null,
    )
    for (const [field, value] of Object.entries(desired)) {
      if (row[field] !== null && row[field] !== value) {
        throw new Error(`ROM ${build.romId} immutable backfill field ${field} conflicts`)
      }
    }
  }

  for (const room of sqlite.prepare('SELECT id, rom_id, rom_build_id FROM rooms').all()) {
    const buildRow = buildRows.get(room.rom_id)
    const desired = buildRow?.id ?? null
    if (room.rom_build_id !== null && room.rom_build_id !== desired) {
      throw new Error(`room ${room.id} already references a different build`)
    }
  }
  for (const save of sqlite
    .prepare(`
      SELECT id, rom_id, rom_build_id, build_fingerprint,
             core_artifact_fingerprint, content_manifest_sha256
      FROM save_states
    `)
    .all()) {
    const build = plan.buildByRomId.get(save.rom_id)
    const buildRow = buildRows.get(save.rom_id)
    const desired = {
      rom_build_id: buildRow?.id ?? null,
      build_fingerprint: build.buildFingerprint,
      core_artifact_fingerprint: build.coreArtifactFingerprint,
      content_manifest_sha256: build.contentManifestSha256,
    }
    for (const [field, value] of Object.entries(desired)) {
      if (save[field] !== null && save[field] !== value) {
        throw new Error(`save state ${save.id} already references a different ${field}`)
      }
    }
  }
}

function applyPlan(sqlite, plan, writes) {
  const run = sqlite.transaction(() => {
    if (readLibraryMigrationState(sqlite).phase !== 'expanded') {
      throw new Error('legacy backfill apply requires migration phase expanded')
    }
    const preservedBefore = legacyPreservationSnapshot(sqlite)
    assertManifestRowsMatchDatabase(queryLegacyRoms(sqlite), plan.records)
    const assetRowsBySha = new Map()
    for (const asset of [...plan.assets.values()].sort((left, right) =>
      left.sha256.localeCompare(right.sha256, 'en'),
    )) {
      const ensured = ensureAssetRecord(sqlite, asset)
      assetRowsBySha.set(asset.sha256, ensured.row)
      if (ensured.created) writes.assetsInserted += 1
    }

    const coreRows = new Map()
    for (const core of plan.cores) {
      const ensured = ensureCoreArtifactRecord(sqlite, core, assetRowsBySha)
      coreRows.set(core.contractId, ensured.row)
      if (ensured.created) writes.coreArtifactsInserted += 1
    }

    const buildRows = new Map()
    for (const build of plan.builds) {
      const parentRow =
        build.runtimeParentRomId === null
          ? null
          : buildRows.get(build.runtimeParentRomId)
      const ensured = ensureBuildRecord(
        sqlite,
        build,
        coreRows.get(build.coreContractId),
        assetRowsBySha.get(build.archive.sha256),
        parentRow,
      )
      buildRows.set(build.romId, ensured.row)
      if (ensured.created) writes.buildsInserted += 1

      const thumbnailRef = ensureThumbnailRef(
        sqlite,
        build,
        build.thumbnail ? assetRowsBySha.get(build.thumbnail.sha256) : null,
      )
      if (thumbnailRef.created) writes.thumbnailRefsInserted += 1
      writes.romsUpdated += updateRomPointers(
        sqlite,
        build,
        ensured.row,
        thumbnailRef.id,
      )
    }

    for (const room of sqlite.prepare('SELECT id, rom_id, rom_build_id FROM rooms').all()) {
      const buildRow = buildRows.get(room.rom_id)
      if (!buildRow) throw new Error(`room ${room.id} references missing ROM ${room.rom_id}`)
      if (room.rom_build_id === buildRow.id) continue
      if (room.rom_build_id !== null) {
        throw new Error(`room ${room.id} already references a different build`)
      }
      writes.roomsUpdated += sqlite
        .prepare('UPDATE rooms SET rom_build_id = ? WHERE id = ?')
        .run(buildRow.id, room.id).changes
    }

    for (const save of sqlite
      .prepare(`
        SELECT id, rom_id, rom_build_id, build_fingerprint,
               core_artifact_fingerprint, content_manifest_sha256
        FROM save_states
      `)
      .all()) {
      const build = plan.buildByRomId.get(save.rom_id)
      const buildRow = buildRows.get(save.rom_id)
      if (!build || !buildRow) {
        throw new Error(`save state ${save.id} references missing ROM ${save.rom_id}`)
      }
      const desired = {
        romBuildId: buildRow.id,
        buildFingerprint: build.buildFingerprint,
        coreArtifactFingerprint: build.coreArtifactFingerprint,
        contentManifestSha256: build.contentManifestSha256,
      }
      for (const [field, value] of [
        ['rom_build_id', desired.romBuildId],
        ['build_fingerprint', desired.buildFingerprint],
        ['core_artifact_fingerprint', desired.coreArtifactFingerprint],
        ['content_manifest_sha256', desired.contentManifestSha256],
      ]) {
        if (save[field] !== null && save[field] !== value) {
          throw new Error(`save state ${save.id} already references a different ${field}`)
        }
      }
      if (
        save.rom_build_id === desired.romBuildId &&
        save.build_fingerprint === desired.buildFingerprint &&
        save.core_artifact_fingerprint === desired.coreArtifactFingerprint &&
        save.content_manifest_sha256 === desired.contentManifestSha256
      ) {
        continue
      }
      writes.savesUpdated += sqlite
        .prepare(`
          UPDATE save_states
          SET rom_build_id = @romBuildId,
              build_fingerprint = @buildFingerprint,
              core_artifact_fingerprint = @coreArtifactFingerprint,
              content_manifest_sha256 = @contentManifestSha256
          WHERE id = @id
        `)
        .run({ ...desired, id: save.id }).changes
    }

    assertBackfilledConsistency(sqlite, plan)
    assertNoMissingBuildPointers(sqlite)
    assertLegacyPreserved(preservedBefore, legacyPreservationSnapshot(sqlite))
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('legacy backfill foreign-key check failed')
    }
    if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('legacy backfill integrity check failed')
    }
    writes.phaseUpdated += sqlite
      .prepare("UPDATE library_migration_state SET phase = 'backfilled' WHERE id = 1 AND phase = 'expanded'")
      .run().changes
    if (writes.phaseUpdated !== 1) {
      throw new Error('legacy backfill could not advance migration phase')
    }
    assertManifestRowsMatchDatabase(queryLegacyRoms(sqlite), plan.records)
    assertBackfilledConsistency(sqlite, plan)
    assertNoMissingBuildPointers(sqlite)
    assertLegacyPreserved(preservedBefore, legacyPreservationSnapshot(sqlite))
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('legacy backfill foreign-key check failed after phase transition')
    }
    if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('legacy backfill integrity check failed after phase transition')
    }
  })
  run.immediate()
}

export function stringifyLegacyBackfillEvidence(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`
}

export function backfillLegacyLibrary({
  sqlite,
  manifestPath,
  assetRoot,
  apply = false,
  contentStoreFactory = createContentStore,
}) {
  assertSqlite(sqlite)
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '') {
    throw new Error('LEGACY_LIBRARY_MANIFEST_PATH or --manifest is required')
  }
  if (typeof assetRoot !== 'string' || assetRoot.trim() === '') {
    throw new Error('LIBRARY_ASSET_ROOT or --asset-root is required')
  }
  if (typeof contentStoreFactory !== 'function') {
    throw new TypeError('contentStoreFactory must be a function')
  }
  const state = readLibraryMigrationState(sqlite)
  if (!['expanded', 'backfilled'].includes(state.phase)) {
    throw new Error(
      `legacy backfill requires migration phase expanded or backfilled; got ${state.phase}`,
    )
  }
  const rows = queryLegacyRoms(sqlite)
  const loaded = loadLegacyLibraryManifest(manifestPath, {
    expectedRomIds: rows.map(({ id }) => id),
  })
  assertManifestRowsMatchDatabase(rows, loaded.manifest.roms)
  topologicalRomRecords(loaded.manifest.roms)

  const contentStore = contentStoreFactory({
    root: assetRoot,
    allowedSourceRoots: resolvedManifestSourceRoots(
      loaded.manifest,
      loaded.manifestPath,
    ),
  })
  const before = summary(sqlite, state.phase)
  let plan = createPlan({
    manifest: loaded.manifest,
    manifestPath: loaded.manifestPath,
    validation: loaded.validation,
    contentStore,
    writeAssets: false,
  })
  if (state.phase === 'expanded') assertExpandedPlanCompatible(sqlite, plan)

  const writes = emptyWrites()
  const baseEvidence = {
    schemaVersion: 1,
    kind: 'legacy-library-backfill-evidence-v1',
    mode: apply ? 'apply' : 'dry-run',
    phase: { before: state.phase, after: 'backfilled' },
    before,
    after: expectedAfter(before),
    plan: plan.evidence,
    noop: false,
    writes: apply ? writes : emptyWrites(),
    operationalDurability: emptyOperationalDurability(),
  }
  if (state.phase === 'backfilled') {
    assertManifestRowsMatchDatabase(queryLegacyRoms(sqlite), plan.records)
    assertBackfilledConsistency(sqlite, plan)
    assertNoMissingBuildPointers(sqlite)
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('backfilled library foreign-key check failed')
    }
    if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('backfilled library integrity check failed')
    }
    const after = summary(sqlite)
    return {
      ...baseEvidence,
      phase: { before: 'backfilled', after: 'backfilled' },
      after,
      noop: true,
      writes: emptyWrites(),
    }
  }

  if (!apply) return baseEvidence

  const backfillLock = contentStore.acquireLegacyBackfillLock({
    databasePath: sqlite.name ?? null,
    manifestPath: loaded.manifestPath,
  })
  let mutationLock = null
  const createdDuringPlanning = []
  let lockReleaseDurability = null
  try {
    mutationLock = contentStore.acquireMutationLock({
      operation: 'legacy-backfill',
      databasePath: sqlite.name ?? null,
      manifestPath: loaded.manifestPath,
    })
    try {
      const writtenPlan = createPlan({
        manifest: loaded.manifest,
        manifestPath: loaded.manifestPath,
        validation: loaded.validation,
        contentStore,
        writeAssets: true,
        createdObjects: createdDuringPlanning,
      })
      if (writtenPlan.evidence.digest !== plan.evidence.digest) {
        throw new Error('legacy source or backfill plan changed before content publish')
      }
      plan = writtenPlan
      writes.filesystemCreated = plan.createdObjects.length
      const revalidated = createPlan({
        manifest: loaded.manifest,
        manifestPath: loaded.manifestPath,
        validation: loaded.validation,
        contentStore,
        writeAssets: false,
      })
      assertManifestRowsMatchDatabase(queryLegacyRoms(sqlite), loaded.manifest.roms)
      if (revalidated.evidence.digest !== plan.evidence.digest) {
        throw new Error('legacy source or backfill plan changed before database commit')
      }
      applyPlan(sqlite, plan, writes)
    } catch (error) {
      contentStore.cleanupCreated(createdDuringPlanning, {
        isReferenced: ({ sha256 }) => assetIsReferencedBySha(sqlite, sha256),
      })
      throw error
    }
  } finally {
    try {
      if (mutationLock) mutationLock.release()
    } finally {
      lockReleaseDurability = backfillLock.release()
    }
  }

  finalizeWrites(writes)
  return {
    ...baseEvidence,
    after: summary(sqlite),
    writes,
    operationalDurability: appliedOperationalDurability({
      lock: backfillLock,
      releaseDurability: lockReleaseDurability,
      createdObjects: createdDuringPlanning,
    }),
  }
}
