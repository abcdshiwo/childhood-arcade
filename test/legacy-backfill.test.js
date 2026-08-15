import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  applyMigrationEntries,
  loadMigrationManifest,
  readLibraryMigrationState,
} from '../server/db/migration-runner.js'
import { computeCompatibilityStatus } from '../server/services/build-contract.js'
import { createContentStore } from '../server/services/content-store.js'
import {
  backfillLegacyLibrary,
  stringifyLegacyBackfillEvidence,
} from '../server/services/legacy-backfill.js'
import {
  computeCoreArtifactFingerprint,
  countAssetReferences,
  validateLegacyLibraryManifest,
} from '../server/services/library-service.js'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, 'server', 'db', 'migrations')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalHash(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'))
}

function storedPath(contentSha) {
  return `sha256/${contentSha.slice(0, 2)}/${contentSha}`
}

function coreIdentity({
  coreName,
  displayVersion,
  sourceCommit,
  jsSha256,
  wasmSha256,
  datSha256,
  biosManifestSha256,
}) {
  return {
    schemaVersion: 1,
    kind: 'core-artifact-v1',
    coreName,
    displayVersion,
    sourceCommit,
    jsSha256,
    wasmSha256,
    datSha256,
    biosManifestSha256,
  }
}

function opaqueManifest({ archiveName, archiveSize, archiveSha256, parentFingerprint }) {
  return {
    schemaVersion: 1,
    kind: 'legacy-opaque-v1',
    archiveName,
    archiveSize,
    archiveSha256,
    runtimeParentBuildFingerprint: parentFingerprint,
  }
}

function buildIdentity({
  romId,
  setNameNormalized,
  coreArtifactFingerprint,
  archiveSha256,
  contentManifestSha256,
  archiveLayout,
  runtimeParentBuildFingerprint,
  biosManifestSha256,
}) {
  return {
    logicalRomScope: `legacy:rom:${romId}`,
    setNameNormalized,
    coreArtifactFingerprint,
    archiveSha256,
    contentManifestSha256,
    archiveLayout,
    runtimeParentBuildFingerprint,
    biosManifestSha256,
  }
}

function expectedBuildFingerprint(identity) {
  return sha256(Buffer.from(JSON.stringify(identity), 'utf8'))
}

function fileContract(path, bytes, hashMode = 'raw') {
  const canonical =
    hashMode === 'lf-normalized-text'
      ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))
      : bytes
  return {
    path,
    hashMode,
    expectedRawSha256: sha256(bytes),
    expectedRawSize: bytes.length,
    expectedSha256: sha256(canonical),
    expectedSize: canonical.length,
  }
}

function selectLegacyRom(sqlite, romId) {
  return sqlite
    .prepare(`
      SELECT id, user_id AS userId, title, platform,
             file_name AS fileName, file_path AS filePath,
             file_size AS fileSize, is_public AS isPublic,
             parent_rom_id AS parentRomId, version_label AS versionLabel,
             status, created_at AS createdAt, updated_at AS updatedAt
      FROM roms WHERE id = ?
    `)
    .get(romId)
}

function expectedLegacyRow(sqlite, romId) {
  const fields = selectLegacyRom(sqlite, romId)
  return { fields, sha256: canonicalHash(fields) }
}

function libraryMigrationEntries() {
  const entries = loadMigrationManifest(MIGRATIONS_FOLDER)
  const expandIndex = entries.findIndex(
    ({ tag }) => tag === '0001_arcade_library_expand',
  )
  return entries.slice(0, expandIndex + 1)
}

function listContentFiles(root) {
  if (!existsSync(root)) return []
  const result = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (!/\.lock$|\.tmp-/i.test(entry.name)) result.push(path)
    }
  }
  visit(root)
  return result.sort()
}

function snapshotLegacyData(sqlite) {
  return {
    roms: sqlite
      .prepare(`
        SELECT id, user_id, title, platform, file_name, file_path, file_size,
               is_public, parent_rom_id, version_label, status, created_at, updated_at
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

function snapshotBackfilledData(sqlite) {
  return {
    phase: readLibraryMigrationState(sqlite).phase,
    assets: sqlite.prepare('SELECT * FROM assets ORDER BY id').all(),
    cores: sqlite.prepare('SELECT * FROM core_artifacts ORDER BY id').all(),
    builds: sqlite.prepare('SELECT * FROM rom_builds ORDER BY id').all(),
    roms: sqlite
      .prepare(`
        SELECT id, set_name_normalized, variant_kind, dat_parent_set_name,
               family_root_set_name, version_label, active_build_id,
               active_thumbnail_ref_id, status, file_path
        FROM roms ORDER BY id
      `)
      .all(),
    refs: sqlite.prepare('SELECT * FROM rom_asset_refs ORDER BY id').all(),
    rooms: sqlite.prepare('SELECT id, rom_id, rom_build_id FROM rooms ORDER BY id').all(),
    saves: sqlite
      .prepare(`
        SELECT id, rom_id, rom_build_id, build_fingerprint,
               core_artifact_fingerprint, content_manifest_sha256
        FROM save_states ORDER BY id
      `)
      .all(),
  }
}

function makeFixture(t, { sameArchiveBytes = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'arcade-legacy-backfill-'))
  const dbPath = join(directory, 'app.db')
  const assetRoot = join(directory, 'library-assets')
  const sourceRoot = join(directory, 'source')
  const manifestPath = join(directory, 'legacy-library.json')
  mkdirSync(sourceRoot, { recursive: true })

  const sqlite = new Database(dbPath)
  sqlite.pragma('foreign_keys = ON')
  applyMigrationEntries(sqlite, libraryMigrationEntries())

  const files = {
    js: { path: join(sourceRoot, 'fbneo.js'), bytes: Buffer.from('core\r\njs\r\n') },
    wasm: { path: join(sourceRoot, 'fbneo.wasm'), bytes: Buffer.from([0, 97, 115, 109, 1]) },
    dat: { path: join(sourceRoot, 'fbneo.dat'), bytes: Buffer.from('driver contract') },
    bios: { path: join(sourceRoot, 'neogeo.zip'), bytes: Buffer.from('bios bytes') },
    parent: { path: join(sourceRoot, 'parent.zip'), bytes: Buffer.from('parent rom bytes') },
    child: {
      path: join(sourceRoot, 'child.zip'),
      bytes: sameArchiveBytes ? Buffer.from('parent rom bytes') : Buffer.from('child rom bytes'),
    },
    thumbnail: { path: join(sourceRoot, 'parent.webp'), bytes: Buffer.from('webp bytes') },
  }
  for (const file of Object.values(files)) writeFileSync(file.path, file.bytes)

  sqlite
    .prepare(
      'INSERT INTO users (id, username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run(7, 'owner', 'hash', 'admin', 1)
  const insertRom = sqlite.prepare(`
    INSERT INTO roms
      (id, user_id, title, platform, file_name, file_path, file_size, is_public,
       parent_rom_id, version_label, status)
    VALUES
      (@id, 7, @title, 'arcade', @fileName, @filePath, @fileSize, 1,
       @parentRomId, @versionLabel, @status)
  `)
  insertRom.run({
    id: 1,
    title: 'Parent',
    fileName: 'parent.zip',
    filePath: files.parent.path,
    fileSize: files.parent.bytes.length,
    parentRomId: null,
    versionLabel: null,
    status: 1,
  })
  insertRom.run({
    id: 7,
    title: 'Deleted Hack',
    fileName: 'child.zip',
    filePath: files.child.path,
    fileSize: files.child.bytes.length,
    parentRomId: 1,
    versionLabel: 'Plus',
    status: 0,
  })
  sqlite.exec(`
    INSERT INTO favorites (user_id, rom_id) VALUES (7, 1), (7, 7);
    INSERT INTO rooms
      (id, code, host_user_id, rom_id, name, is_public, allow_play, status, closed_at)
      VALUES (4, 'ROOM07', 7, 7, 'legacy room', 0, 1, 0, unixepoch());
    INSERT INTO save_states
      (id, user_id, rom_id, slot, file_path, file_size, status)
      VALUES (9, 7, 7, 2, 'saves/7/7/2.state', 321, 1);
    UPDATE sqlite_sequence SET seq = 41 WHERE name = 'users';
    UPDATE sqlite_sequence SET seq = 77 WHERE name = 'roms';
    UPDATE sqlite_sequence SET seq = 88 WHERE name = 'rooms';
    UPDATE sqlite_sequence SET seq = 99 WHERE name = 'save_states';
  `)

  const jsContract = fileContract(files.js.path, files.js.bytes, 'lf-normalized-text')
  const wasmContract = fileContract(files.wasm.path, files.wasm.bytes)
  const datContract = fileContract(files.dat.path, files.dat.bytes)
  const biosContract = {
    fileName: 'neogeo.zip',
    ...fileContract(files.bios.path, files.bios.bytes),
  }
  const biosManifest = {
    schemaVersion: 1,
    kind: 'core-bios-manifest-v1',
    members: [
      {
        fileName: biosContract.fileName,
        sha256: biosContract.expectedSha256,
        fileSize: biosContract.expectedSize,
        filePath: storedPath(biosContract.expectedSha256),
      },
    ],
  }
  const biosManifestBytes = Buffer.from(canonicalJson(biosManifest), 'utf8')
  const biosManifestSha256 = sha256(biosManifestBytes)
  const artifactFingerprint = canonicalHash(
    coreIdentity({
      coreName: 'fbneo',
      displayVersion: 'v1 test',
      sourceCommit: '2f41022002337ed20186144bbddb2d53392fab85',
      jsSha256: jsContract.expectedSha256,
      wasmSha256: wasmContract.expectedSha256,
      datSha256: datContract.expectedSha256,
      biosManifestSha256,
    }),
  )

  const parentSource = fileContract(files.parent.path, files.parent.bytes)
  const parentContentManifest = opaqueManifest({
    archiveName: 'parent.zip',
    archiveSize: parentSource.expectedRawSize,
    archiveSha256: parentSource.expectedRawSha256,
    parentFingerprint: null,
  })
  const parentContentManifestSha256 = canonicalHash(parentContentManifest)
  const parentBuildFingerprint = expectedBuildFingerprint(
    buildIdentity({
      romId: 1,
      setNameNormalized: 'parent',
      coreArtifactFingerprint: artifactFingerprint,
      archiveSha256: parentSource.expectedRawSha256,
      contentManifestSha256: parentContentManifestSha256,
      archiveLayout: 'standalone',
      runtimeParentBuildFingerprint: null,
      biosManifestSha256,
    }),
  )

  const childSource = fileContract(files.child.path, files.child.bytes)
  const childContentManifest = opaqueManifest({
    archiveName: 'child.zip',
    archiveSize: childSource.expectedRawSize,
    archiveSha256: childSource.expectedRawSha256,
    parentFingerprint: parentBuildFingerprint,
  })
  const childContentManifestSha256 = canonicalHash(childContentManifest)

  const manifest = {
    schemaVersion: 1,
    kind: 'legacy-library-backfill-v1',
    allowedSourceRoots: [sourceRoot],
    platformCoreContracts: { arcade: 'fbneo-test' },
    cores: [
      {
        id: 'fbneo-test',
        coreName: 'fbneo',
        displayVersion: 'v1 test',
        sourceCommit: '2f41022002337ed20186144bbddb2d53392fab85',
        runtimeValidationStatus: 'existing-core-not-revalidated-for-w165',
        enabled: true,
        artifacts: {
          js: jsContract,
          wasm: wasmContract,
          dat: datContract,
          bios: [biosContract],
        },
        expectedBiosManifest: biosManifest,
        expectedBiosManifestSha256: biosManifestSha256,
        expectedArtifactFingerprint: artifactFingerprint,
        provenance: { contract: 'fixture' },
      },
    ],
    roms: [
      {
        romId: 1,
        expectedLegacyRow: expectedLegacyRow(sqlite, 1),
        coreContractId: 'fbneo-test',
        setNameNormalized: 'parent',
        variantKind: null,
        datParentSetName: null,
        familyRootSetName: 'parent',
        versionLabel: null,
        archiveLayout: 'standalone',
        runtimeParentRomId: null,
        source: {
          ...parentSource,
          archiveName: 'parent.zip',
          expectedContentManifest: parentContentManifest,
          expectedContentManifestSha256: parentContentManifestSha256,
        },
        thumbnail: {
          ...fileContract(files.thumbnail.path, files.thumbnail.bytes),
          matchKind: 'exact',
          sourceSetName: 'parent',
          sourceFileSha256: sha256(files.thumbnail.bytes),
          mimeType: 'image/webp',
        },
      },
      {
        romId: 7,
        expectedLegacyRow: expectedLegacyRow(sqlite, 7),
        coreContractId: 'fbneo-test',
        setNameNormalized: 'child',
        variantKind: 'hack',
        datParentSetName: 'parent',
        familyRootSetName: 'parent',
        versionLabel: 'Plus',
        archiveLayout: 'split',
        runtimeParentRomId: 1,
        source: {
          ...childSource,
          archiveName: 'child.zip',
          expectedContentManifest: childContentManifest,
          expectedContentManifestSha256: childContentManifestSha256,
        },
      },
    ],
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  t.after(() => {
    if (sqlite.open) sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    sqlite,
    dbPath,
    assetRoot,
    sourceRoot,
    manifestPath,
    manifest,
    files,
    expected: {
      artifactFingerprint,
      biosManifestSha256,
      parentBuildFingerprint,
      childBuildFingerprint: expectedBuildFingerprint(
        buildIdentity({
          romId: 7,
          setNameNormalized: 'child',
          coreArtifactFingerprint: artifactFingerprint,
          archiveSha256: childSource.expectedRawSha256,
          contentManifestSha256: childContentManifestSha256,
          archiveLayout: 'split',
          runtimeParentBuildFingerprint: parentBuildFingerprint,
          biosManifestSha256,
        }),
      ),
      parentSource,
      childSource,
    },
    rewriteManifest() {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    },
  }
}

test('manifest validation requires explicit row coverage, exact arcade dependencies, and safe enablement', (t) => {
  const fixture = makeFixture(t)
  assert.doesNotThrow(() => validateLegacyLibraryManifest(fixture.manifest, {
    manifestPath: fixture.manifestPath,
  }))

  const missingRom = structuredClone(fixture.manifest)
  missingRom.roms.pop()
  assert.throws(
    () =>
      validateLegacyLibraryManifest(missingRom, {
        manifestPath: fixture.manifestPath,
        expectedRomIds: [1, 7],
      }),
    /rom.*ids|coverage|missing.*7/i,
  )

  const missingDat = structuredClone(fixture.manifest)
  delete missingDat.cores[0].artifacts.dat
  assert.throws(
    () => validateLegacyLibraryManifest(missingDat, { manifestPath: fixture.manifestPath }),
    /arcade.*dat|dat.*required/i,
  )

  const missingBios = structuredClone(fixture.manifest)
  missingBios.cores[0].artifacts.bios = []
  assert.throws(
    () => validateLegacyLibraryManifest(missingBios, { manifestPath: fixture.manifestPath }),
    /arcade.*bios|bios.*required/i,
  )

  const unsafeFba = structuredClone(fixture.manifest)
  unsafeFba.cores[0].coreName = 'fbalpha2012'
  unsafeFba.cores[0].runtimeValidationStatus = 'static-unverified'
  unsafeFba.cores[0].enabled = true
  assert.throws(
    () => validateLegacyLibraryManifest(unsafeFba, { manifestPath: fixture.manifestPath }),
    /static-unverified.*enabled|smoke/i,
  )

  const normalizedRom = structuredClone(fixture.manifest)
  normalizedRom.roms[0].source.hashMode = 'lf-normalized-text'
  assert.throws(
    () => validateLegacyLibraryManifest(normalizedRom),
    /ROM 1.*raw|binary.*raw/i,
  )

  const invalidThumbnail = structuredClone(fixture.manifest)
  invalidThumbnail.roms[0].thumbnail.sourceSetName = 42
  assert.throws(
    () => validateLegacyLibraryManifest(invalidThumbnail),
    /thumbnail\.sourceSetName|string or null/i,
  )

  const detachedThumbnailHash = structuredClone(fixture.manifest)
  detachedThumbnailHash.roms[0].thumbnail.sourceFileSha256 = 'f'.repeat(64)
  assert.throws(
    () => validateLegacyLibraryManifest(detachedThumbnailHash),
    /thumbnail.*source.*hash|sourceFileSha256.*match/i,
  )

  const unsafeThumbnailMime = structuredClone(fixture.manifest)
  unsafeThumbnailMime.roms[0].thumbnail.mimeType = 'text/html'
  assert.throws(
    () => validateLegacyLibraryManifest(unsafeThumbnailMime),
    /thumbnail.*image|mimeType/i,
  )
})

test('core fingerprint is immutable and covers every runtime dependency', () => {
  const identity = coreIdentity({
    coreName: 'fbneo',
    displayVersion: 'v1',
    sourceCommit: 'abc',
    jsSha256: '1'.repeat(64),
    wasmSha256: '2'.repeat(64),
    datSha256: '3'.repeat(64),
    biosManifestSha256: '4'.repeat(64),
  })
  assert.equal(computeCoreArtifactFingerprint(identity), canonicalHash(identity))
  for (const patch of [
    { coreName: 'mame2003_plus' },
    { displayVersion: 'v2' },
    { sourceCommit: 'def' },
    { jsSha256: '5'.repeat(64) },
    { wasmSha256: '5'.repeat(64) },
    { datSha256: '5'.repeat(64) },
    { biosManifestSha256: '5'.repeat(64) },
  ]) {
    assert.notEqual(
      computeCoreArtifactFingerprint({ ...identity, ...patch }),
      computeCoreArtifactFingerprint(identity),
    )
  }
})

test('dry-run is byte-for-byte deterministic and performs zero filesystem or database writes', (t) => {
  const fixture = makeFixture(t)
  const before = snapshotBackfilledData(fixture.sqlite)
  const first = backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: false,
  })
  const second = backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: false,
  })

  assert.equal(stringifyLegacyBackfillEvidence(first), stringifyLegacyBackfillEvidence(second))
  assert.deepEqual(first, second)
  assert.equal(first.phase.before, 'expanded')
  assert.equal(first.phase.after, 'backfilled')
  assert.equal(first.plan.romBuilds.length, 2)
  assert.equal(first.plan.romBuilds.every((build) => build.compatStatus === 'unverified'), true)
  assert.equal(first.writes.total, 0)
  assert.equal(existsSync(fixture.assetRoot), false)
  assert.deepEqual(snapshotBackfilledData(fixture.sqlite), before)
})

test('expanded dry-run rejects immutable database conflicts before apply', (t) => {
  {
    const fixture = makeFixture(t)
    const js = fixture.manifest.cores[0].artifacts.js
    fixture.sqlite
      .prepare(`
        INSERT INTO assets (kind, file_path, mime_type, file_size, sha256)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        'wrong_kind',
        storedPath(js.expectedSha256),
        'text/plain',
        js.expectedSize,
        js.expectedSha256,
      )
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: false,
        }),
      /immutable asset|kind.*metadata/i,
    )
  }
  {
    const fixture = makeFixture(t)
    fixture.sqlite
      .prepare("UPDATE roms SET set_name_normalized = 'wrong' WHERE id = 1")
      .run()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: false,
        }),
      /ROM 1.*set_name_normalized|immutable backfill field/i,
    )
  }
})

test('evidence digest covers nullable ROM metadata and the full operator manifest', (t) => {
  const fixture = makeFixture(t)
  const before = backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: false,
  })
  fixture.manifest.roms[0].versionLabel = 'Original'
  fixture.rewriteManifest()
  const after = backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: false,
  })

  assert.match(before.plan.manifestSha256, /^[0-9a-f]{64}$/)
  assert.match(after.plan.manifestSha256, /^[0-9a-f]{64}$/)
  assert.notEqual(after.plan.manifestSha256, before.plan.manifestSha256)
  assert.notEqual(after.plan.digest, before.plan.digest)
  assert.equal(after.plan.romBuilds[0].versionLabel, 'Original')
})

test('apply backfills every active/deleted row and preserves legacy ownership, files, children, and sequences', (t) => {
  const fixture = makeFixture(t)
  const legacyBefore = snapshotLegacyData(fixture.sqlite)
  const sourceBefore = Object.fromEntries(
    Object.entries(fixture.files).map(([name, file]) => [name, readFileSync(file.path)]),
  )

  const evidence = backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: true,
  })

  assert.equal(readLibraryMigrationState(fixture.sqlite).phase, 'backfilled')
  assert.deepEqual(snapshotLegacyData(fixture.sqlite), legacyBefore)
  for (const [name, bytes] of Object.entries(sourceBefore)) {
    assert.deepEqual(readFileSync(fixture.files[name].path), bytes)
  }

  const romRows = fixture.sqlite
    .prepare(`
      SELECT id, status, file_path, set_name_normalized, variant_kind,
             dat_parent_set_name, family_root_set_name, version_label,
             active_build_id, active_thumbnail_ref_id
      FROM roms ORDER BY id
    `)
    .all()
  assert.deepEqual(
    romRows.map(({ id, status, file_path: filePath }) => ({ id, status, filePath })),
    [
      { id: 1, status: 1, filePath: fixture.files.parent.path },
      { id: 7, status: 0, filePath: fixture.files.child.path },
    ],
  )
  assert.equal(romRows[0].variant_kind, null, 'unknown variant must stay null')
  assert.equal(romRows[1].variant_kind, 'hack')
  assert.ok(romRows.every(({ active_build_id: buildId }) => Number.isInteger(buildId)))
  assert.ok(Number.isInteger(romRows[0].active_thumbnail_ref_id))
  assert.equal(romRows[1].active_thumbnail_ref_id, null)

  const builds = fixture.sqlite
    .prepare(`
      SELECT b.*, c.artifact_fingerprint
      FROM rom_builds b JOIN core_artifacts c ON c.id = b.core_artifact_id
      ORDER BY b.rom_id
    `)
    .all()
  assert.equal(builds.length, 2)
  assert.equal(builds[0].build_fingerprint, fixture.expected.parentBuildFingerprint)
  assert.equal(builds[1].build_fingerprint, fixture.expected.childBuildFingerprint)
  assert.equal(builds[0].runtime_parent_build_id, null)
  assert.equal(builds[1].runtime_parent_build_id, builds[0].id)
  assert.equal(builds.every(({ artifact_fingerprint: fp }) => fp === fixture.expected.artifactFingerprint), true)
  assert.equal(
    builds.every(
      (build) =>
        computeCompatibilityStatus({
          staticStatus: build.static_status,
          acceptedResult: null,
        }) === 'unverified',
    ),
    true,
  )
  assert.equal(
    fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM build_validation_runs').get().count,
    0,
  )

  const room = fixture.sqlite
    .prepare('SELECT rom_id, rom_build_id FROM rooms WHERE id = 4')
    .get()
  assert.equal(room.rom_build_id, builds[1].id)
  const save = fixture.sqlite
    .prepare(`
      SELECT rom_id, rom_build_id, build_fingerprint,
             core_artifact_fingerprint, content_manifest_sha256
      FROM save_states WHERE id = 9
    `)
    .get()
  assert.deepEqual(save, {
    rom_id: 7,
    rom_build_id: builds[1].id,
    build_fingerprint: builds[1].build_fingerprint,
    core_artifact_fingerprint: fixture.expected.artifactFingerprint,
    content_manifest_sha256: builds[1].content_manifest_sha256,
  })
  assert.equal(evidence.after.deletedRomsWithBuild, 1)
  assert.ok(evidence.writes.total > 0)
  assert.equal(fixture.sqlite.pragma('foreign_key_check').length, 0)
  assert.equal(fixture.sqlite.pragma('integrity_check', { simple: true }), 'ok')
})

test('two applies leave identical state and the second performs zero writes', (t) => {
  const fixture = makeFixture(t)
  backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: true,
  })
  const firstState = snapshotBackfilledData(fixture.sqlite)
  const firstFiles = listContentFiles(fixture.assetRoot).map((path) => ({
    path,
    bytes: readFileSync(path),
  }))

  const second = backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: true,
  })
  assert.equal(second.writes.total, 0)
  assert.equal(second.noop, true)
  assert.deepEqual(snapshotBackfilledData(fixture.sqlite), firstState)
  assert.deepEqual(
    listContentFiles(fixture.assetRoot).map((path) => ({ path, bytes: readFileSync(path) })),
    firstFiles,
  )
  const dryNoop = backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: false,
  })
  assert.equal(dryNoop.mode, 'dry-run')
  assert.equal(dryNoop.noop, true)
  assert.equal(dryNoop.writes.total, 0)
  assert.deepEqual(dryNoop.after, second.after)
})

test('backfilled no-op revalidates core provenance, archive assets, and thumbnail metadata', (t) => {
  {
    const fixture = makeFixture(t)
    backfillLegacyLibrary({
      sqlite: fixture.sqlite,
      manifestPath: fixture.manifestPath,
      assetRoot: fixture.assetRoot,
      apply: true,
    })
    const core = fixture.sqlite
      .prepare('SELECT id, provenance_json FROM core_artifacts')
      .get()
    const provenance = JSON.parse(core.provenance_json)
    provenance.artifacts.js.rawSha256 = 'f'.repeat(64)
    fixture.sqlite
      .prepare('UPDATE core_artifacts SET provenance_json = ? WHERE id = ?')
      .run(JSON.stringify(provenance), core.id)
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: false,
        }),
      /core artifact.*provenance|rawSha256/i,
    )
  }
  {
    const fixture = makeFixture(t)
    backfillLegacyLibrary({
      sqlite: fixture.sqlite,
      manifestPath: fixture.manifestPath,
      assetRoot: fixture.assetRoot,
      apply: true,
    })
    const parentAssetId = fixture.sqlite
      .prepare('SELECT archive_asset_id AS id FROM rom_builds WHERE rom_id = 1')
      .get().id
    fixture.sqlite
      .prepare('UPDATE rom_builds SET archive_asset_id = ? WHERE rom_id = 7')
      .run(parentAssetId)
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: false,
        }),
      /ROM 7.*archive_asset_id|build conflicts.*archive/i,
    )
  }
  {
    const fixture = makeFixture(t)
    backfillLegacyLibrary({
      sqlite: fixture.sqlite,
      manifestPath: fixture.manifestPath,
      assetRoot: fixture.assetRoot,
      apply: true,
    })
    fixture.sqlite
      .prepare(`
        UPDATE rom_asset_refs
        SET source_set_name = 'wrong-source'
        WHERE id = (SELECT active_thumbnail_ref_id FROM roms WHERE id = 1)
      `)
      .run()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: false,
        }),
      /thumbnail.*source_set_name|thumbnail.*inconsistent/i,
    )
  }
  {
    const fixture = makeFixture(t)
    backfillLegacyLibrary({
      sqlite: fixture.sqlite,
      manifestPath: fixture.manifestPath,
      assetRoot: fixture.assetRoot,
      apply: true,
    })
    fixture.sqlite
      .prepare(`
        UPDATE assets SET mime_type = 'text/plain'
        WHERE id = (
          SELECT asset_id FROM rom_asset_refs
          WHERE id = (SELECT active_thumbnail_ref_id FROM roms WHERE id = 1)
        )
      `)
      .run()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: false,
        }),
      /immutable asset|mime_type|asset.*metadata/i,
    )
  }
})

test('shared content is deduplicated and service-level BIOS member references count', (t) => {
  const fixture = makeFixture(t, { sameArchiveBytes: true })
  backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: true,
  })

  const archiveAsset = fixture.sqlite
    .prepare('SELECT * FROM assets WHERE sha256 = ?')
    .get(fixture.expected.parentSource.expectedSha256)
  assert.equal(
    fixture.sqlite
      .prepare('SELECT COUNT(*) AS count FROM rom_builds WHERE archive_asset_id = ?')
      .get(archiveAsset.id).count,
    2,
  )
  assert.equal(countAssetReferences(fixture.sqlite, archiveAsset.id), 2)

  const biosSha = sha256(fixture.files.bios.bytes)
  const biosAsset = fixture.sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(biosSha)
  assert.equal(countAssetReferences(fixture.sqlite, biosAsset.id), 1)
})

test('missing source, source hash drift, manifest path drift, and source-root escape fail closed', (t) => {
  {
    const fixture = makeFixture(t)
    rmSync(fixture.files.child.path)
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /source|ENOENT|missing/i,
    )
    assert.equal(readLibraryMigrationState(fixture.sqlite).phase, 'expanded')
  }
  {
    const fixture = makeFixture(t)
    writeFileSync(fixture.files.child.path, 'changed')
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /raw.*hash|size mismatch/i,
    )
    assert.equal(readLibraryMigrationState(fixture.sqlite).phase, 'expanded')
  }
  {
    const fixture = makeFixture(t)
    fixture.manifest.roms[0].expectedLegacyRow.fields.title = 'drifted title'
    fixture.manifest.roms[0].expectedLegacyRow.sha256 = canonicalHash(
      fixture.manifest.roms[0].expectedLegacyRow.fields,
    )
    fixture.rewriteManifest()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /legacy row.*drift|title/i,
    )
  }
  {
    const fixture = makeFixture(t)
    const outside = join(fixture.directory, 'outside.zip')
    writeFileSync(outside, fixture.files.child.bytes)
    fixture.sqlite.prepare('UPDATE roms SET file_path = ? WHERE id = 7').run(outside)
    fixture.manifest.roms[1].source.path = outside
    fixture.manifest.roms[1].expectedLegacyRow = expectedLegacyRow(
      fixture.sqlite,
      7,
    )
    fixture.rewriteManifest()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /allowed source root|contain|outside/i,
    )
  }
})

test('source symlinks that escape an allowed root fail closed when supported', (t) => {
  const fixture = makeFixture(t)
  const outside = join(fixture.directory, 'outside-real.zip')
  const link = join(fixture.sourceRoot, 'linked-child.zip')
  writeFileSync(outside, fixture.files.child.bytes)
  try {
    symlinkSync(outside, link, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`)
      return
    }
    throw error
  }
  fixture.sqlite.prepare('UPDATE roms SET file_path = ? WHERE id = 7').run(link)
  fixture.manifest.roms[1].source.path = link
  fixture.manifest.roms[1].expectedLegacyRow = expectedLegacyRow(
    fixture.sqlite,
    7,
  )
  fixture.rewriteManifest()
  try {
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /symbolic|allowed source root|contain/i,
    )
  } finally {
    if (existsSync(link)) unlinkSync(link)
  }
})

test('missing parent, parent cycle, and cross-core runtime parent fail before writes', (t) => {
  {
    const fixture = makeFixture(t)
    fixture.sqlite.prepare('UPDATE roms SET parent_rom_id = 999 WHERE id = 7').run()
    fixture.manifest.roms[1].expectedLegacyRow = expectedLegacyRow(fixture.sqlite, 7)
    fixture.manifest.roms[1].runtimeParentRomId = 999
    fixture.rewriteManifest()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /missing.*parent|parent.*999/i,
    )
    assert.equal(existsSync(fixture.assetRoot), false)
  }
  {
    const fixture = makeFixture(t)
    fixture.sqlite.prepare('UPDATE roms SET parent_rom_id = 7 WHERE id = 1').run()
    fixture.manifest.roms[0].expectedLegacyRow = expectedLegacyRow(fixture.sqlite, 1)
    fixture.manifest.roms[0].archiveLayout = 'split'
    fixture.manifest.roms[0].runtimeParentRomId = 7
    fixture.rewriteManifest()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /cycle/i,
    )
    assert.equal(existsSync(fixture.assetRoot), false)
  }
  {
    const fixture = makeFixture(t)
    const secondCore = structuredClone(fixture.manifest.cores[0])
    secondCore.id = 'mame-test'
    secondCore.coreName = 'mame2003_plus'
    secondCore.displayVersion = 'mame test'
    secondCore.expectedArtifactFingerprint = canonicalHash(
      coreIdentity({
        coreName: secondCore.coreName,
        displayVersion: secondCore.displayVersion,
        sourceCommit: secondCore.sourceCommit,
        jsSha256: secondCore.artifacts.js.expectedSha256,
        wasmSha256: secondCore.artifacts.wasm.expectedSha256,
        datSha256: secondCore.artifacts.dat.expectedSha256,
        biosManifestSha256: secondCore.expectedBiosManifestSha256,
      }),
    )
    fixture.manifest.cores.push(secondCore)
    fixture.manifest.roms[1].coreContractId = secondCore.id
    fixture.rewriteManifest()
    assert.throws(
      () =>
        backfillLegacyLibrary({
          sqlite: fixture.sqlite,
          manifestPath: fixture.manifestPath,
          assetRoot: fixture.assetRoot,
          apply: true,
        }),
      /parent.*core|same core|core mismatch/i,
    )
    assert.equal(existsSync(fixture.assetRoot), false)
  }
})

test('legacy UI parent grouping does not force a runtime parent for standalone builds', (t) => {
  const fixture = makeFixture(t)
  const child = fixture.manifest.roms[1]
  child.archiveLayout = 'standalone'
  child.runtimeParentRomId = null
  child.source.expectedContentManifest = opaqueManifest({
    archiveName: child.source.archiveName,
    archiveSize: child.source.expectedRawSize,
    archiveSha256: child.source.expectedRawSha256,
    parentFingerprint: null,
  })
  child.source.expectedContentManifestSha256 = canonicalHash(
    child.source.expectedContentManifest,
  )
  fixture.rewriteManifest()

  backfillLegacyLibrary({
    sqlite: fixture.sqlite,
    manifestPath: fixture.manifestPath,
    assetRoot: fixture.assetRoot,
    apply: true,
  })

  assert.equal(
    fixture.sqlite.prepare('SELECT parent_rom_id FROM roms WHERE id = 7').get()
      .parent_rom_id,
    1,
  )
  const build = fixture.sqlite
    .prepare('SELECT archive_layout, runtime_parent_build_id FROM rom_builds WHERE rom_id = 7')
    .get()
  assert.deepEqual(build, {
    archive_layout: 'standalone',
    runtime_parent_build_id: null,
  })
})

test('transaction failure rolls back database and removes only newly-created unreferenced objects', (t) => {
  const fixture = makeFixture(t)
  const store = createContentStore({
    root: fixture.assetRoot,
    allowedSourceRoots: [fixture.sourceRoot],
  })
  const js = fixture.manifest.cores[0].artifacts.js
  const preexisting = store.putSource({
    sourcePath: js.path,
    expectedSha256: js.expectedSha256,
    expectedSize: js.expectedSize,
    expectedRawSha256: js.expectedRawSha256,
    expectedRawSize: js.expectedRawSize,
    hashMode: js.hashMode,
    kind: 'core_js',
  })
  fixture.sqlite.exec(`
    CREATE TRIGGER reject_child_build
    BEFORE UPDATE OF active_build_id ON roms
    WHEN NEW.id = 7
    BEGIN
      SELECT RAISE(ABORT, 'forced backfill rollback');
    END;
  `)

  assert.throws(
    () =>
      backfillLegacyLibrary({
        sqlite: fixture.sqlite,
        manifestPath: fixture.manifestPath,
        assetRoot: fixture.assetRoot,
        apply: true,
      }),
    /forced backfill rollback/i,
  )
  assert.equal(readLibraryMigrationState(fixture.sqlite).phase, 'expanded')
  assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0)
  assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM core_artifacts').get().count, 0)
  assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM rom_builds').get().count, 0)
  assert.equal(existsSync(preexisting.absolutePath), true)
  assert.deepEqual(listContentFiles(fixture.assetRoot), [preexisting.absolutePath])
})

test('phase transition rolls back if an unplanned ROM appears inside the transaction', (t) => {
  const fixture = makeFixture(t)
  fixture.sqlite.exec(`
    CREATE TRIGGER inject_unplanned_rom_before_backfilled
    BEFORE UPDATE OF phase ON library_migration_state
    WHEN NEW.phase = 'backfilled'
    BEGIN
      INSERT INTO roms
        (id, user_id, title, platform, file_name, file_path, file_size,
         is_public, parent_rom_id, version_label, status)
      VALUES
        (99, 7, 'Injected', 'arcade', 'injected.zip',
         'injected.zip', 0, 0, NULL, NULL, 1);
    END;
  `)

  assert.throws(
    () =>
      backfillLegacyLibrary({
        sqlite: fixture.sqlite,
        manifestPath: fixture.manifestPath,
        assetRoot: fixture.assetRoot,
        apply: true,
      }),
    /coverage|unplanned|missing.*build|ROM ID/i,
  )
  assert.equal(readLibraryMigrationState(fixture.sqlite).phase, 'expanded')
  assert.equal(
    fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM roms WHERE id = 99').get().count,
    0,
  )
  assert.equal(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0)
  assert.deepEqual(listContentFiles(fixture.assetRoot), [])
})

test('backfill rejects absent, contracted, and invalid phases', (t) => {
  const fixture = makeFixture(t)
  fixture.sqlite.prepare("UPDATE library_migration_state SET phase = 'backfilled' WHERE id = 1").run()
  fixture.sqlite.prepare("UPDATE library_migration_state SET phase = 'contracted' WHERE id = 1").run()
  assert.throws(
    () =>
      backfillLegacyLibrary({
        sqlite: fixture.sqlite,
        manifestPath: fixture.manifestPath,
        assetRoot: fixture.assetRoot,
        apply: false,
      }),
    /contracted.*backfill|phase/i,
  )

  const absentDirectory = mkdtempSync(join(tmpdir(), 'arcade-backfill-absent-'))
  const absentPath = join(absentDirectory, 'absent.db')
  const absent = new Database(absentPath)
  t.after(() => {
    absent.close()
    rmSync(absentDirectory, { recursive: true, force: true })
  })
  assert.throws(
    () =>
      backfillLegacyLibrary({
        sqlite: absent,
        manifestPath: fixture.manifestPath,
        assetRoot: join(absentDirectory, 'assets'),
        apply: false,
      }),
    /expanded|phase.*absent/i,
  )
})

test('dedicated and migration CLIs default to dry-run, require --apply, and keep Task 3 modes closed', (t) => {
  const fixture = makeFixture(t)
  const run = (script, args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DB_PATH: fixture.dbPath,
        LEGACY_LIBRARY_MANIFEST_PATH: fixture.manifestPath,
        LIBRARY_ASSET_ROOT: fixture.assetRoot,
      },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })

  fixture.sqlite.close()
  const dry = run('scripts/backfill-legacy-library.js', [])
  assert.equal(dry.status, 0, dry.stderr)
  assert.equal(JSON.parse(dry.stdout).mode, 'dry-run')
  assert.equal(existsSync(fixture.assetRoot), false)

  const migrateDry = run('scripts/migrate-library.js', ['backfill'])
  assert.equal(migrateDry.status, 0, migrateDry.stderr)
  assert.equal(JSON.parse(migrateDry.stdout).mode, 'dry-run')
  assert.equal(existsSync(fixture.assetRoot), false)

  const applied = run('scripts/migrate-library.js', ['backfill', '--apply'])
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(JSON.parse(applied.stdout).mode, 'apply')

  for (const [mode, args] of [
    ['contract', ['contract']],
    ['all', ['all', '--apply']],
  ]) {
    const result = run('scripts/migrate-library.js', args)
    assert.notEqual(result.status, 0, `${mode} unexpectedly succeeded`)
    assert.match(`${result.stdout}\n${result.stderr}`, /Task 3|not available/i)
  }
})
