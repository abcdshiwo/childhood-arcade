import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import { computeBuildFingerprint } from '../server/services/build-contract.js'
import {
  computeCoreArtifactFingerprint,
  hashCanonicalLibraryJson,
} from '../server/services/library-service.js'
import { rollbackBatch } from '../tools/arcade-import/rollback_batch.js'

const remediationModule = await import('../tools/arcade-import/remediate-runtime-parent.js')
  .catch(() => null)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function storedPath(digest) {
  return `sha256/${digest.slice(0, 2)}/${digest}`
}

function putAsset(root, bytes) {
  const buffer = Buffer.from(bytes)
  const digest = sha256(buffer)
  const filePath = storedPath(digest)
  const absolutePath = join(root, ...filePath.split('/'))
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, buffer)
  return { bytes: buffer, sha256: digest, filePath, fileSize: buffer.length }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'arcade-runtime-parent-'))
  const assetRoot = join(root, 'assets')
  const dbPath = join(root, 'app.db')
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')

  const coreJs = putAsset(assetRoot, 'fbalpha2012-cps1-js')
  const coreWasm = putAsset(assetRoot, 'fbalpha2012-cps1-wasm')
  const parentArchive = putAsset(assetRoot, 'dynwar-parent-archive')
  const childArchive = putAsset(assetRoot, 'dynwarj-clone-archive')
  const coreIdentity = {
    coreName: 'fbalpha2012_cps1',
    displayVersion: 'v0.2.97.28',
    sourceCommit: '2499e30247da4d2535c2df886186e165cbff48e7',
    jsSha256: coreJs.sha256,
    wasmSha256: coreWasm.sha256,
    datSha256: 'd'.repeat(64),
    biosManifestSha256: null,
  }
  const coreFingerprint = computeCoreArtifactFingerprint(coreIdentity)
  const parentContentManifest = sha256('dynwar-content')
  const childContentManifest = sha256('dynwarj-content')
  const parentFingerprint = computeBuildFingerprint({
    logicalRomScope: 'w165:fbalpha2012:dynwar',
    setNameNormalized: 'dynwar',
    coreArtifactFingerprint: coreFingerprint,
    archiveSha256: parentArchive.sha256,
    contentManifestSha256: parentContentManifest,
    archiveLayout: 'standalone',
    runtimeParentBuildFingerprint: null,
    biosManifestSha256: null,
  })
  const childFingerprint = computeBuildFingerprint({
    logicalRomScope: 'w165:fbalpha2012:dynwarj',
    setNameNormalized: 'dynwarj',
    coreArtifactFingerprint: coreFingerprint,
    archiveSha256: childArchive.sha256,
    contentManifestSha256: childContentManifest,
    archiveLayout: 'standalone',
    runtimeParentBuildFingerprint: null,
    biosManifestSha256: null,
  })

  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, status INTEGER NOT NULL);
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL, sha256 TEXT NOT NULL
    );
    CREATE TABLE core_artifacts (
      id INTEGER PRIMARY KEY, core_name TEXT NOT NULL, display_version TEXT NOT NULL,
      source_commit TEXT, js_asset_id INTEGER NOT NULL, js_sha256 TEXT NOT NULL,
      wasm_asset_id INTEGER NOT NULL, wasm_sha256 TEXT NOT NULL, dat_asset_id INTEGER,
      dat_sha256 TEXT, bios_asset_id INTEGER, bios_manifest_sha256 TEXT,
      artifact_fingerprint TEXT NOT NULL, provenance_json TEXT
    );
    CREATE TABLE roms (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, set_name_normalized TEXT NOT NULL,
      dat_parent_set_name TEXT, active_build_id INTEGER
    );
    CREATE TABLE rom_builds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rom_id INTEGER NOT NULL,
      core_artifact_id INTEGER NOT NULL, archive_asset_id INTEGER,
      archive_sha256 TEXT, content_manifest_sha256 TEXT NOT NULL,
      build_fingerprint TEXT NOT NULL UNIQUE, static_status TEXT NOT NULL,
      static_failure_code TEXT, static_failure_details_json TEXT,
      archive_layout TEXT NOT NULL, runtime_parent_build_id INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE import_batches (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, cold_source_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL, planned_count INTEGER NOT NULL,
      actual_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL,
      status TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()), published_at INTEGER, rolled_back_at INTEGER
    );
    CREATE TABLE batch_build_refs (
      import_batch_id TEXT NOT NULL, rom_build_id INTEGER NOT NULL,
      PRIMARY KEY (import_batch_id, rom_build_id)
    );
    CREATE TABLE build_source_members (
      import_batch_id TEXT NOT NULL, rom_build_id INTEGER NOT NULL,
      source_archive_path TEXT NOT NULL, member_name TEXT NOT NULL,
      member_role TEXT NOT NULL, member_order INTEGER NOT NULL,
      member_size INTEGER NOT NULL, crc32 TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY (import_batch_id, rom_build_id, source_archive_path, member_name)
    );
    CREATE TABLE import_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, import_batch_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, operation_kind TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_key TEXT NOT NULL,
      before_json TEXT, after_json TEXT, reverted_at INTEGER,
      UNIQUE (import_batch_id, sequence)
    );
    CREATE TABLE rooms (id INTEGER PRIMARY KEY, rom_build_id INTEGER, closed_at INTEGER);
    CREATE TABLE save_states (id INTEGER PRIMARY KEY, rom_build_id INTEGER);
    CREATE TABLE build_validation_runs (id INTEGER PRIMARY KEY, rom_build_id INTEGER);

    CREATE TRIGGER rom_builds_runtime_parent_insert
    BEFORE INSERT ON rom_builds
    WHEN NOT (
      (NEW.archive_layout = 'standalone' AND NEW.runtime_parent_build_id IS NULL)
      OR (
        NEW.archive_layout = 'split'
        AND EXISTS (
          SELECT 1
          FROM rom_builds parent_build
          JOIN roms child_rom ON child_rom.id = NEW.rom_id
          JOIN roms parent_rom ON parent_rom.id = parent_build.rom_id
          WHERE parent_build.id = NEW.runtime_parent_build_id
            AND parent_build.archive_layout = 'standalone'
            AND parent_build.runtime_parent_build_id IS NULL
            AND parent_build.static_status = 'complete'
            AND parent_build.core_artifact_id = NEW.core_artifact_id
            AND child_rom.dat_parent_set_name = parent_rom.set_name_normalized COLLATE NOCASE
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid runtime parent');
    END;
  `)

  db.prepare('INSERT INTO users (id, status) VALUES (1, 1)').run()
  for (const [id, kind, asset] of [
    [1, 'core_js', coreJs],
    [2, 'core_wasm', coreWasm],
    [10, 'rom', parentArchive],
    [11, 'rom', childArchive],
  ]) {
    db.prepare('INSERT INTO assets (id, kind, file_path, file_size, sha256) VALUES (?, ?, ?, ?, ?)')
      .run(id, kind, asset.filePath, asset.fileSize, asset.sha256)
  }
  db.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, dat_sha256, artifact_fingerprint, provenance_json)
    VALUES (2, ?, ?, ?, 1, ?, 2, ?, ?, ?, '{}')
  `).run(
    coreIdentity.coreName,
    coreIdentity.displayVersion,
    coreIdentity.sourceCommit,
    coreIdentity.jsSha256,
    coreIdentity.wasmSha256,
    coreIdentity.datSha256,
    coreFingerprint,
  )
  db.prepare('INSERT INTO roms (id, user_id, set_name_normalized, dat_parent_set_name, active_build_id) VALUES (?, 1, ?, ?, ?)')
    .run(76, 'dynwar', null, 76)
  db.prepare('INSERT INTO roms (id, user_id, set_name_normalized, dat_parent_set_name, active_build_id) VALUES (?, 1, ?, ?, ?)')
    .run(78, 'dynwarj', 'dynwar', 78)
  db.prepare(`
    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256,
       content_manifest_sha256, build_fingerprint, static_status,
       static_failure_details_json, archive_layout, runtime_parent_build_id)
    VALUES (?, ?, 2, ?, ?, ?, ?, 'complete', ?, 'standalone', NULL)
  `).run(
    76, 76, 10, parentArchive.sha256, parentContentManifest, parentFingerprint,
    JSON.stringify({ candidateId: 'fbalpha2012:dynwar', runtimeArchiveFileName: 'dynwar.zip' }),
  )
  db.prepare(`
    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256,
       content_manifest_sha256, build_fingerprint, static_status,
       static_failure_details_json, archive_layout, runtime_parent_build_id)
    VALUES (?, ?, 2, ?, ?, ?, ?, 'complete', ?, 'standalone', NULL)
  `).run(
    78, 78, 11, childArchive.sha256, childContentManifest, childFingerprint,
    JSON.stringify({ candidateId: 'fbalpha2012:dynwarj', runtimeArchiveFileName: 'dynwarj.zip' }),
  )
  db.prepare(`
    INSERT INTO import_batches
      (id, owner_user_id, cold_source_sha256, manifest_sha256,
       planned_count, actual_count, total_bytes, status)
    VALUES ('w165-origin', 1, ?, ?, 2, 2, ?, 'committed_private')
  `).run('a'.repeat(64), 'b'.repeat(64), parentArchive.fileSize + childArchive.fileSize)
  db.prepare('INSERT INTO batch_build_refs VALUES (?, ?)').run('w165-origin', 76)
  db.prepare('INSERT INTO batch_build_refs VALUES (?, ?)').run('w165-origin', 78)
  db.prepare(`
    INSERT INTO build_source_members
      (import_batch_id, rom_build_id, source_archive_path, member_name,
       member_role, member_order, member_size, crc32, sha256)
    VALUES ('w165-origin', 78, 'roms/dynwarj.zip', '36.12f',
            'primary', 0, 131072, '1a516657', ?)
  `).run(sha256('dynwarj-member'))

  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    assetRoot,
    dbPath,
    db,
    childArchive,
    parentFingerprint,
    childFingerprint,
  }
}

function options(f) {
  return {
    assetRoot: f.assetRoot,
    originBatchId: 'w165-origin',
    remediationBatchId: 'w165-runtime-parent-dynwarj-v1',
    childRomId: 78,
    parentRomId: 76,
    expectedChildBuildId: 78,
    expectedParentBuildId: 76,
    expectedSourceMemberCount: 1,
  }
}

test('runtime parent remediation appends a split build and atomically promotes it', (t) => {
  assert.ok(remediationModule, 'runtime parent remediation module must exist')
  const f = fixture(t)

  const result = remediationModule.applyRuntimeParentRemediation(f.db, options(f))
  assert.equal(result.noop, false)
  assert.equal(result.remediatedBuilds, 1)

  const source = f.db.prepare('SELECT * FROM rom_builds WHERE id = 78').get()
  const activeId = f.db.prepare('SELECT active_build_id FROM roms WHERE id = 78').get().active_build_id
  const replacement = f.db.prepare('SELECT * FROM rom_builds WHERE id = ?').get(activeId)
  assert.notEqual(activeId, 78)
  assert.equal(source.archive_layout, 'standalone')
  assert.equal(source.runtime_parent_build_id, null)
  assert.equal(replacement.archive_layout, 'split')
  assert.equal(replacement.runtime_parent_build_id, 76)
  assert.equal(replacement.archive_asset_id, source.archive_asset_id)
  assert.equal(replacement.content_manifest_sha256, source.content_manifest_sha256)

  const expectedFingerprint = computeBuildFingerprint({
    logicalRomScope: 'w165:fbalpha2012:dynwarj',
    setNameNormalized: 'dynwarj',
    coreArtifactFingerprint: f.db.prepare('SELECT artifact_fingerprint FROM core_artifacts WHERE id = 2').get().artifact_fingerprint,
    archiveSha256: source.archive_sha256,
    contentManifestSha256: source.content_manifest_sha256,
    archiveLayout: 'split',
    runtimeParentBuildFingerprint: f.parentFingerprint,
    biosManifestSha256: null,
  })
  assert.equal(replacement.build_fingerprint, expectedFingerprint)
  assert.equal(
    f.db.prepare('SELECT status FROM import_batches WHERE id = ?').get(options(f).remediationBatchId).status,
    'committed_private',
  )
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM import_operations WHERE import_batch_id = ?')
      .get(options(f).remediationBatchId).count > 0,
    true,
  )
  assert.equal(
    f.db.prepare(`
      SELECT COUNT(*) AS count FROM build_source_members
      WHERE import_batch_id = ? AND rom_build_id = ?
    `).get(options(f).remediationBatchId, replacement.id).count,
    1,
  )
  assert.equal(remediationModule.applyRuntimeParentRemediation(f.db, options(f)).noop, true)
})

test('runtime parent remediation dry-run writes only its rollback manifest', (t) => {
  assert.ok(remediationModule, 'runtime parent remediation module must exist')
  const f = fixture(t)
  const manifestOutputPath = join(f.root, 'runtime-parent-remediation.json')

  const result = remediationModule.remediateRuntimeParent({
    dbPath: f.dbPath,
    manifestOutputPath,
    ...options(f),
  })
  const manifest = JSON.parse(readFileSync(manifestOutputPath, 'utf8'))

  assert.equal(result.dryRun, true)
  assert.equal(result.rollbackManifestPath, manifestOutputPath)
  assert.equal(manifest.kind, 'runtime-parent-remediation-v1')
  assert.equal(manifest.manifestSha256, result.manifestSha256)
  const body = { ...manifest }
  delete body.manifestSha256
  assert.equal(hashCanonicalLibraryJson(body), manifest.manifestSha256)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM rom_builds').get().count, 2)
})

test('runtime parent remediation releases its lock when the database cannot be opened', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arcade-runtime-parent-open-failure-'))
  const dbPath = join(root, 'missing.db')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => remediationModule.remediateRuntimeParent({
      dbPath,
      assetRoot: root,
      originBatchId: 'w165-origin',
      remediationBatchId: 'w165-runtime-parent-open-failure-v1',
      childRomId: 78,
      parentRomId: 76,
      expectedChildBuildId: 78,
      expectedParentBuildId: 76,
      expectedSourceMemberCount: 1,
      apply: true,
    }),
    (error) => error?.code === 'SQLITE_CANTOPEN',
  )
  assert.equal(existsSync(`${dbPath}.arcade-import.lock`), false)
})

test('runtime parent remediation rejects a mismatched DAT parent without writes', (t) => {
  assert.ok(remediationModule, 'runtime parent remediation module must exist')
  const f = fixture(t)
  f.db.prepare("UPDATE roms SET dat_parent_set_name = 'other' WHERE id = 78").run()

  assert.throws(
    () => remediationModule.applyRuntimeParentRemediation(f.db, options(f)),
    /DAT parent|dynwar/i,
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM rom_builds').get().count, 2)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count, 1)
})

test('runtime parent remediation verifies the source archive before promotion', (t) => {
  assert.ok(remediationModule, 'runtime parent remediation module must exist')
  const f = fixture(t)
  const archivePath = join(f.assetRoot, ...f.childArchive.filePath.split('/'))
  writeFileSync(archivePath, 'corrupt')

  assert.throws(
    () => remediationModule.applyRuntimeParentRemediation(f.db, options(f)),
    /child ROM archive.*content/i,
  )
  assert.equal(f.db.prepare('SELECT active_build_id FROM roms WHERE id = 78').get().active_build_id, 78)
})

test('runtime parent remediation manifest is reversible by the batch rollback workflow', (t) => {
  assert.ok(remediationModule, 'runtime parent remediation module must exist')
  const f = fixture(t)
  const manifestOutputPath = join(f.root, 'runtime-parent-remediation.json')

  const applied = remediationModule.remediateRuntimeParent({
    dbPath: f.dbPath,
    manifestOutputPath,
    apply: true,
    ...options(f),
  })
  assert.equal(applied.noop, false)

  const rollback = rollbackBatch({
    dbPath: f.dbPath,
    assetRoot: f.assetRoot,
    manifestPath: manifestOutputPath,
    batchId: options(f).remediationBatchId,
    apply: true,
  })

  assert.equal(rollback.status, 'rolled_back')
  assert.equal(f.db.prepare('SELECT active_build_id FROM roms WHERE id = 78').get().active_build_id, 78)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM rom_builds WHERE rom_id = 78').get().count, 1)
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM build_source_members WHERE import_batch_id = ?')
      .get(options(f).remediationBatchId).count,
    0,
  )
})
