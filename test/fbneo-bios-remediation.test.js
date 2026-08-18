import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import { computeBuildFingerprint } from '../server/services/build-contract.js'
import {
  computeCoreArtifactFingerprint,
  hashCanonicalLibraryJson,
} from '../server/services/library-service.js'
import {
  applyFbneoBiosRemediation,
} from '../tools/arcade-import/remediate-fbneo-bios.js'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function storedPath(digest) {
  return `sha256/${digest.slice(0, 2)}/${digest}`
}

function putAsset(root, bytes) {
  const digest = sha256(bytes)
  const filePath = storedPath(digest)
  const path = join(root, ...filePath.split('/'))
  mkdirSync(join(root, ...filePath.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(path, bytes)
  return { bytes, sha256: digest, filePath, fileSize: bytes.length }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'arcade-fbneo-bios-'))
  const assetRoot = join(root, 'assets')
  const db = new Database(join(root, 'app.db'))
  const js = putAsset(assetRoot, Buffer.from('fbneo-js'))
  const wasm = putAsset(assetRoot, Buffer.from('fbneo-wasm'))
  const bios = putAsset(assetRoot, Buffer.from('exact-neogeo-bios'))
  const parentArchive = putAsset(assetRoot, Buffer.from('parent-rom-archive'))
  const cloneArchive = putAsset(assetRoot, Buffer.from('clone-rom-archive'))
  const biosManifest = {
    schemaVersion: 1,
    kind: 'core-bios-manifest-v1',
    members: [{ fileName: 'neogeo.zip', sha256: bios.sha256, fileSize: bios.fileSize, filePath: bios.filePath }],
  }
  const biosManifestAsset = putAsset(assetRoot, Buffer.from(JSON.stringify(biosManifest)))
  const sourceCore = {
    coreName: 'fbneo',
    displayVersion: 'v1.0.0.03 2f41022',
    sourceCommit: '2f41022002337ed20186144bbddb2d53392fab85',
    jsSha256: js.sha256,
    wasmSha256: wasm.sha256,
    datSha256: 'e'.repeat(64),
    biosManifestSha256: null,
  }
  const targetCore = { ...sourceCore, biosManifestSha256: biosManifestAsset.sha256 }
  const sourceFingerprint = computeCoreArtifactFingerprint(sourceCore)
  const targetFingerprint = computeCoreArtifactFingerprint(targetCore)

  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, status INTEGER NOT NULL);
    CREATE TABLE assets (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, file_path TEXT NOT NULL, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE core_artifacts (
      id INTEGER PRIMARY KEY, core_name TEXT NOT NULL, display_version TEXT NOT NULL,
      source_commit TEXT, js_asset_id INTEGER NOT NULL, js_sha256 TEXT NOT NULL,
      wasm_asset_id INTEGER NOT NULL, wasm_sha256 TEXT NOT NULL, dat_sha256 TEXT,
      bios_asset_id INTEGER, bios_manifest_sha256 TEXT, artifact_fingerprint TEXT NOT NULL,
      provenance_json TEXT
    );
    CREATE TABLE roms (id INTEGER PRIMARY KEY, set_name_normalized TEXT NOT NULL, active_build_id INTEGER);
    CREATE TABLE rom_builds (
      id INTEGER PRIMARY KEY, rom_id INTEGER NOT NULL, core_artifact_id INTEGER NOT NULL,
      archive_asset_id INTEGER, archive_sha256 TEXT, content_manifest_sha256 TEXT NOT NULL,
      build_fingerprint TEXT NOT NULL UNIQUE, static_status TEXT NOT NULL,
      static_failure_code TEXT, static_failure_details_json TEXT, archive_layout TEXT NOT NULL,
      runtime_parent_build_id INTEGER
    );
    CREATE TABLE import_batches (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, cold_source_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL, planned_count INTEGER NOT NULL, actual_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE batch_build_refs (import_batch_id TEXT NOT NULL, rom_build_id INTEGER NOT NULL, PRIMARY KEY (import_batch_id, rom_build_id));
    CREATE TABLE import_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, import_batch_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      operation_kind TEXT NOT NULL, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL,
      before_json TEXT, after_json TEXT, UNIQUE (import_batch_id, sequence)
    );
    CREATE TABLE rooms (id INTEGER PRIMARY KEY, rom_build_id INTEGER NOT NULL, closed_at INTEGER);
  `)
  db.prepare('INSERT INTO users (id, status) VALUES (1, 1)').run()
  const assetRows = [
    [1, 'core_js', js], [2, 'core_wasm', wasm], [3, 'bios', bios], [4, 'bios_manifest', biosManifestAsset],
    [20, 'rom', parentArchive], [21, 'rom', cloneArchive],
  ]
  for (const [id, kind, asset] of assetRows) {
    db.prepare('INSERT INTO assets (id, kind, file_path, file_size, sha256) VALUES (?, ?, ?, ?, ?)')
      .run(id, kind, asset.filePath, asset.fileSize, asset.sha256)
  }
  db.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, dat_sha256, bios_asset_id, bios_manifest_sha256,
       artifact_fingerprint, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    5, sourceCore.coreName, sourceCore.displayVersion, sourceCore.sourceCommit,
    1, js.sha256, 2, wasm.sha256, sourceCore.datSha256, null, null,
    sourceFingerprint, JSON.stringify({ kind: 'w165-core-artifact-provenance-v1' }),
  )
  db.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, dat_sha256, bios_asset_id, bios_manifest_sha256,
       artifact_fingerprint, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, targetCore.coreName, targetCore.displayVersion, targetCore.sourceCommit,
    1, js.sha256, 2, wasm.sha256, targetCore.datSha256, 4, biosManifestAsset.sha256,
    targetFingerprint, JSON.stringify({
      bios: {
        manifestAssetId: 4,
        manifestSha256: biosManifestAsset.sha256,
        members: [{ assetId: 3, fileName: 'neogeo.zip', sha256: bios.sha256, fileSize: bios.fileSize, filePath: bios.filePath }],
      },
    }),
  )
  db.prepare('INSERT INTO import_batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'w165-source', 1, 'a'.repeat(64), 'b'.repeat(64), 2, 2, 123, 'committed_private',
  )
  db.prepare('INSERT INTO roms (id, set_name_normalized, active_build_id) VALUES (?, ?, ?)').run(10, 'parent', 100)
  db.prepare('INSERT INTO roms (id, set_name_normalized, active_build_id) VALUES (?, ?, ?)').run(11, 'clone', 101)
  const parentFingerprint = computeBuildFingerprint({
    logicalRomScope: 'w165:fbneo:parent', setNameNormalized: 'parent',
    coreArtifactFingerprint: sourceFingerprint, archiveSha256: parentArchive.sha256,
    contentManifestSha256: 'd'.repeat(64), archiveLayout: 'standalone',
    runtimeParentBuildFingerprint: null, biosManifestSha256: null,
  })
  const cloneFingerprint = computeBuildFingerprint({
    logicalRomScope: 'w165:fbneo:clone', setNameNormalized: 'clone',
    coreArtifactFingerprint: sourceFingerprint, archiveSha256: cloneArchive.sha256,
    contentManifestSha256: '0'.repeat(64), archiveLayout: 'split',
    runtimeParentBuildFingerprint: parentFingerprint, biosManifestSha256: null,
  })
  db.prepare(`
    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256, content_manifest_sha256,
       build_fingerprint, static_status, static_failure_details_json, archive_layout, runtime_parent_build_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)
  `).run(100, 10, 5, 20, parentArchive.sha256, 'd'.repeat(64), parentFingerprint, JSON.stringify({ candidateId: 'fbneo:parent' }), 'standalone', null)
  db.prepare(`
    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256, content_manifest_sha256,
       build_fingerprint, static_status, static_failure_details_json, archive_layout, runtime_parent_build_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)
  `).run(101, 11, 5, 21, cloneArchive.sha256, '0'.repeat(64), cloneFingerprint, JSON.stringify({ candidateId: 'fbneo:clone' }), 'split', 100)
  db.prepare('INSERT INTO batch_build_refs VALUES (?, ?)').run('w165-source', 100)
  db.prepare('INSERT INTO batch_build_refs VALUES (?, ?)').run('w165-source', 101)
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  return { db, assetRoot, sourceFingerprint, targetFingerprint }
}

test('FBNeo BIOS remediation appends replacement builds and promotes them atomically', (t) => {
  const f = fixture(t)

  const result = applyFbneoBiosRemediation(f.db, {
    assetRoot: f.assetRoot,
    originBatchId: 'w165-source',
    remediationBatchId: 'w165-fbneo-bios-v1',
    sourceCoreFingerprint: f.sourceFingerprint,
    targetCoreFingerprint: f.targetFingerprint,
    expectedBuildCount: 2,
  })

  assert.equal(result.noop, false)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rom_builds WHERE core_artifact_id = 5').get().n, 2)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rom_builds WHERE core_artifact_id = 1').get().n, 2)
  const parent = f.db.prepare('SELECT * FROM rom_builds WHERE rom_id = 10 AND core_artifact_id = 1').get()
  const clone = f.db.prepare('SELECT * FROM rom_builds WHERE rom_id = 11 AND core_artifact_id = 1').get()
  assert.equal(clone.runtime_parent_build_id, parent.id)
  assert.equal(f.db.prepare('SELECT active_build_id FROM roms WHERE id = 10').get().active_build_id, parent.id)
  assert.equal(f.db.prepare('SELECT active_build_id FROM roms WHERE id = 11').get().active_build_id, clone.id)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM batch_build_refs WHERE import_batch_id = ?').get('w165-fbneo-bios-v1').n, 2)
  assert.equal(f.db.prepare('SELECT status FROM import_batches WHERE id = ?').get('w165-fbneo-bios-v1').status, 'committed_private')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_operations WHERE import_batch_id = ?').get('w165-fbneo-bios-v1').n > 0, true)
  assert.equal(applyFbneoBiosRemediation(f.db, {
    assetRoot: f.assetRoot,
    originBatchId: 'w165-source',
    remediationBatchId: 'w165-fbneo-bios-v1',
    sourceCoreFingerprint: f.sourceFingerprint,
    targetCoreFingerprint: f.targetFingerprint,
    expectedBuildCount: 2,
  }).noop, true)
})

test('FBNeo BIOS remediation rejects a target core without the exact BIOS provenance', (t) => {
  const f = fixture(t)
  f.db.prepare('UPDATE core_artifacts SET provenance_json = ? WHERE artifact_fingerprint = ?')
    .run(JSON.stringify({ bios: { members: [] } }), f.targetFingerprint)

  assert.throws(() => applyFbneoBiosRemediation(f.db, {
    assetRoot: f.assetRoot,
    originBatchId: 'w165-source',
    remediationBatchId: 'w165-fbneo-bios-v1',
    sourceCoreFingerprint: f.sourceFingerprint,
    targetCoreFingerprint: f.targetFingerprint,
    expectedBuildCount: 2,
  }), /neogeo\.zip|BIOS provenance/i)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE id = ?').get('w165-fbneo-bios-v1').n, 0)
})

test('FBNeo BIOS remediation rejects corrupted target core bytes before promotion', (t) => {
  const f = fixture(t)
  const jsAsset = f.db.prepare('SELECT file_path FROM assets WHERE id = 1').get()
  writeFileSync(join(f.assetRoot, ...jsAsset.file_path.split('/')), Buffer.from('corrupted-fbneo-js'))

  assert.throws(() => applyFbneoBiosRemediation(f.db, {
    assetRoot: f.assetRoot,
    originBatchId: 'w165-source',
    remediationBatchId: 'w165-fbneo-bios-v1',
    sourceCoreFingerprint: f.sourceFingerprint,
    targetCoreFingerprint: f.targetFingerprint,
    expectedBuildCount: 2,
  }), /target core JavaScript.*content/i)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE id = ?').get('w165-fbneo-bios-v1').n, 0)
})

test('FBNeo BIOS remediation rejects corrupted source archive bytes before promotion', (t) => {
  const f = fixture(t)
  const archive = f.db.prepare('SELECT file_path FROM assets WHERE id = 21').get()
  writeFileSync(join(f.assetRoot, ...archive.file_path.split('/')), Buffer.from('corrupted-rom-archive'))

  assert.throws(() => applyFbneoBiosRemediation(f.db, {
    assetRoot: f.assetRoot,
    originBatchId: 'w165-source',
    remediationBatchId: 'w165-fbneo-bios-v1',
    sourceCoreFingerprint: f.sourceFingerprint,
    targetCoreFingerprint: f.targetFingerprint,
    expectedBuildCount: 2,
  }), /build 101 ROM archive.*content/i)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE id = ?').get('w165-fbneo-bios-v1').n, 0)
})
