import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'

import Database from 'better-sqlite3'

import { createContentStore } from '../server/services/content-store.js'
import {
  canonicalizeLibraryJson,
  computeCoreArtifactFingerprint,
  hashCanonicalLibraryJson,
} from '../server/services/library-service.js'
import { commitBatch } from '../tools/arcade-import/commit_batch.js'
import { rollbackBatch } from '../tools/arcade-import/rollback_batch.js'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function storedPath(hash) {
  return `sha256/${hash.slice(0, 2)}/${hash}`
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value) {
  const out = Buffer.alloc(2)
  out.writeUInt16LE(value)
  return out
}

function u32(value) {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value >>> 0)
  return out
}

function deterministicZip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, bytes] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(bytes, { level: 9 })
    const crc = crc32(bytes)
    const localHeader = Buffer.concat([
      Buffer.from('PK\x03\x04', 'binary'), u16(20), u16(0), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), nameBytes,
    ])
    local.push(localHeader, compressed)
    central.push(Buffer.concat([
      Buffer.from('PK\x01\x02', 'binary'), u16(0x0314), u16(20), u16(0), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0o100644 << 16), u32(offset), nameBytes,
    ]))
    offset += localHeader.length + compressed.length
  }
  const body = Buffer.concat(local)
  const directory = Buffer.concat(central)
  return Buffer.concat([
    body, directory,
    Buffer.from('PK\x05\x06', 'binary'), Buffer.alloc(4), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(body.length), u16(0),
  ])
}

function rewriteManifest(f) {
  const body = { ...f.manifest }
  delete body.manifestSha256
  f.manifest.manifestSha256 = hashCanonicalLibraryJson(body)
  writeFileSync(f.manifestPath, `${canonicalizeLibraryJson(f.manifest)}\n`)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'arcade-import-rollback-'))
  const batchRoot = join(root, 'batch')
  const assetRoot = join(root, 'assets')
  const contractsDir = join(root, 'contracts')
  const repoRoot = join(root, 'repo')
  const dbPath = join(root, 'app.db')
  mkdirSync(join(batchRoot, 'archives', 'fixture-core'), { recursive: true })
  mkdirSync(join(batchRoot, 'thumbnails'), { recursive: true })
  mkdirSync(contractsDir, { recursive: true })
  mkdirSync(join(repoRoot, 'data', 'cores'), { recursive: true })
  const archiveMemberBytes = Buffer.from('archive-fixture')
  const archiveBytes = deterministicZip([['game.bin', archiveMemberBytes]])
  const thumbBytes = Buffer.from('thumbnail-fixture')
  const archiveSha = sha256(archiveBytes)
  const archiveMemberSha = sha256(archiveMemberBytes)
  const archiveMemberCrc = crc32(archiveMemberBytes).toString(16).padStart(8, '0')
  const thumbSha = sha256(thumbBytes)
  const archiveRel = `archives/fixture-core/fixture_game.zip`
  const thumbRel = `thumbnails/sha256/${thumbSha.slice(0, 2)}/${thumbSha}.webp`
  mkdirSync(join(batchRoot, 'thumbnails', 'sha256', thumbSha.slice(0, 2)), { recursive: true })
  writeFileSync(join(batchRoot, archiveRel), archiveBytes)
  writeFileSync(join(batchRoot, thumbRel), thumbBytes)
  const coreJsBytes = Buffer.from('fixture-core-js')
  const coreWasmBytes = Buffer.from('fixture-core-wasm')
  const coreJsSha = sha256(coreJsBytes)
  const coreWasmSha = sha256(coreWasmBytes)
  const coreSourceCommit = 'e'.repeat(40)
  const coreDatSha = 'f'.repeat(64)
  writeFileSync(join(repoRoot, 'data', 'cores', 'fixture.js'), coreJsBytes)
  writeFileSync(join(repoRoot, 'data', 'cores', 'fixture.wasm'), coreWasmBytes)
  const coreFingerprint = computeCoreArtifactFingerprint({
    coreName: 'fixture', displayVersion: '1', sourceCommit: coreSourceCommit,
    jsSha256: coreJsSha, wasmSha256: coreWasmSha,
    datSha256: coreDatSha, biosManifestSha256: null,
  })
  const runtimeContractFingerprint = 'c'.repeat(64)
  const rawContentContractSha256 = 'd'.repeat(64)
  const coreContract = {
    id: 'fixture-core', coreName: 'fixture', runtimeVersion: '1', frontendVersion: '1',
    contractEnabled: true, runtimeValidationStatus: 'static-unverified',
    artifactFingerprint: coreFingerprint,
    artifacts: {
      js: { path: 'data/cores/fixture.js', sha256: coreJsSha, hashMode: 'raw' },
      wasm: { path: 'data/cores/fixture.wasm', sha256: coreWasmSha, hashMode: 'raw' },
    },
    source: { commit: coreSourceCommit },
    contract: { kind: 'fixture-dat', name: 'fixture.dat', sha256: coreDatSha },
  }
  const candidateContract = {
    id: 'fixture:game', coreArtifactId: 'fixture-core', setName: 'fixture_game',
    title: 'Fixture Game', platform: 'arcade', relationKind: 'parent',
    datParentSetName: null, archiveLayout: 'standalone', runtimeParentSetName: null,
    members: [['game.bin', archiveMemberBytes.length, archiveMemberCrc]],
    runtimeContractFingerprint, rawContentContractSha256,
    thumbnail: {
      matchKind: 'direct-or-alias', sourceSetName: 'fixture_game',
      evidence: 'exact canonical driver basename',
    },
  }
  const contractDocuments = {
    'alias-folds.json': { schemaVersion: 1, rows: [] },
    'candidates.json': { schemaVersion: 1, rows: [candidateContract] },
    'cores.json': { schemaVersion: 1, cores: [coreContract] },
    'sources.json': { schemaVersion: 1, inputs: [] },
  }
  const contractHashes = {}
  for (const [name, document] of Object.entries(contractDocuments)) {
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
    writeFileSync(join(contractsDir, name), bytes)
    contractHashes[name] = sha256(bytes)
  }
  const sumsBytes = Buffer.from(`${Object.entries(contractHashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join('\n')}\n`)
  writeFileSync(join(contractsDir, 'SHA256SUMS.txt'), sumsBytes)

  const manifestBody = {
    schemaVersion: 1,
    kind: 'w165-import-batch-v1',
    batchId: 'fixture-batch',
    coldSource: { sha256: 'a'.repeat(64), fileSize: 1 },
    contracts: {
      sha256sumsSha256: sha256(sumsBytes),
      ...Object.fromEntries(Object.entries(contractHashes).map(([name, digest]) => [`${name.slice(0, -5)}Sha256`, digest])),
    },
    cores: [coreContract],
    candidateResolutions: [{
      candidateId: 'fixture:game', state: 'unverified',
      runtimeContractFingerprint, rawContentContractSha256,
    }],
    archives: [{
      candidateId: 'fixture:game', coreArtifactId: 'fixture-core', setName: 'fixture_game',
      title: 'Fixture Game', platform: 'arcade', relationKind: 'parent',
      datParentSetName: null, familyRootSetName: 'fixture_game',
      archiveLayout: 'standalone', archivePath: archiveRel, archiveSha256: archiveSha,
      archiveSize: archiveBytes.length, mounts: [{ role: 'primary', candidateId: 'fixture:game', path: archiveRel }],
      members: [{ name: 'game.bin', size: archiveMemberBytes.length, crc32: archiveMemberCrc, sha256: archiveMemberSha, sourcePath: 'roms/source.zip!source-game.bin' }],
    }],
    thumbnails: [{
      candidateId: 'fixture:game', sourceSetName: 'fixture_game', matchKind: 'exact',
      sourcePath: 'sshots/fixture_game.bmp', sourceFileSha256: 'b'.repeat(64),
      assetPath: thumbRel, sha256: thumbSha, fileSize: thumbBytes.length,
    }],
    auxiliaryEvidence: [],
    saveSampleEvidence: [],
    summary: { candidateRows: 1, runtimeCoreScopedContracts: 1, globalRawPayloadIdentities: 1 },
  }
  const manifestSha = hashCanonicalLibraryJson(manifestBody)
  const manifest = { ...manifestBody, manifestSha256: manifestSha }
  const manifestPath = join(batchRoot, 'manifest.json')
  writeFileSync(manifestPath, `${canonicalizeLibraryJson(manifest)}\n`)

  for (const [bytes, hash] of [[coreJsBytes, coreJsSha], [coreWasmBytes, coreWasmSha]]) {
    const path = join(assetRoot, storedPath(hash))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }

  const sqlite = new Database(dbPath)
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE import_batches (id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, cold_source_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, planned_count INTEGER NOT NULL, actual_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER, updated_at INTEGER, published_at INTEGER, rolled_back_at INTEGER);
    CREATE TABLE assets (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, mime_type TEXT, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE, created_at INTEGER);
    CREATE TABLE core_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, core_name TEXT NOT NULL, display_version TEXT NOT NULL, source_commit TEXT, js_asset_id INTEGER NOT NULL, js_sha256 TEXT NOT NULL, wasm_asset_id INTEGER NOT NULL, wasm_sha256 TEXT NOT NULL, dat_asset_id INTEGER, dat_sha256 TEXT, bios_asset_id INTEGER, bios_manifest_sha256 TEXT, artifact_fingerprint TEXT NOT NULL UNIQUE, provenance_json TEXT, is_enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER);
    CREATE TABLE roms (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, platform TEXT NOT NULL, file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_size INTEGER NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, parent_rom_id INTEGER, set_name_normalized TEXT NOT NULL, variant_kind TEXT, dat_parent_set_name TEXT, family_root_set_name TEXT, version_label TEXT, active_build_id INTEGER, active_thumbnail_ref_id INTEGER, status INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE rom_builds (id INTEGER PRIMARY KEY AUTOINCREMENT, rom_id INTEGER NOT NULL, core_artifact_id INTEGER NOT NULL, archive_asset_id INTEGER, archive_sha256 TEXT, content_manifest_sha256 TEXT NOT NULL, build_fingerprint TEXT NOT NULL UNIQUE, static_status TEXT NOT NULL, static_failure_code TEXT, static_failure_details_json TEXT, archive_layout TEXT NOT NULL, runtime_parent_build_id INTEGER, created_at INTEGER);
    CREATE TABLE rom_asset_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, rom_id INTEGER NOT NULL, asset_id INTEGER NOT NULL, match_kind TEXT NOT NULL, source_set_name TEXT, source_file_sha256 TEXT, import_batch_id TEXT, created_at INTEGER);
    CREATE TABLE batch_build_refs (import_batch_id TEXT NOT NULL, rom_build_id INTEGER NOT NULL, created_at INTEGER, PRIMARY KEY(import_batch_id, rom_build_id));
    CREATE TABLE build_source_members (import_batch_id TEXT NOT NULL, rom_build_id INTEGER NOT NULL, source_archive_path TEXT NOT NULL, member_name TEXT NOT NULL, member_role TEXT NOT NULL, member_order INTEGER NOT NULL, member_size INTEGER NOT NULL, crc32 TEXT NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER, PRIMARY KEY(import_batch_id, rom_build_id, source_archive_path, member_name));
    CREATE TABLE import_operations (id INTEGER PRIMARY KEY AUTOINCREMENT, import_batch_id TEXT NOT NULL, sequence INTEGER NOT NULL, operation_kind TEXT NOT NULL, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, before_json TEXT, after_json TEXT, reverted_at INTEGER, created_at INTEGER, UNIQUE(import_batch_id, sequence));
    CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, host_user_id INTEGER NOT NULL, rom_id INTEGER NOT NULL, rom_build_id INTEGER NOT NULL, name TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 1, allow_play INTEGER NOT NULL DEFAULT 1, password_hash TEXT, status INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at, closed_at INTEGER);
    CREATE TABLE save_states (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, rom_id INTEGER NOT NULL, rom_build_id INTEGER NOT NULL, build_fingerprint TEXT NOT NULL, core_artifact_fingerprint TEXT NOT NULL, content_manifest_sha256 TEXT NOT NULL, slot INTEGER NOT NULL, file_path TEXT NOT NULL, file_size INTEGER NOT NULL, status INTEGER NOT NULL DEFAULT 1, updated_at INTEGER);
    CREATE TABLE favorites (user_id INTEGER NOT NULL, rom_id INTEGER NOT NULL, created_at INTEGER, PRIMARY KEY(user_id, rom_id));
    CREATE TABLE build_validation_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, rom_build_id INTEGER NOT NULL, browser_sha256 TEXT NOT NULL, harness_version TEXT NOT NULL, core_artifact_fingerprint TEXT NOT NULL, result TEXT NOT NULL, acceptance TEXT NOT NULL, log_asset_id INTEGER, frame_asset_id INTEGER, created_at INTEGER);
    CREATE TABLE library_migration_state (id INTEGER PRIMARY KEY, phase TEXT NOT NULL);
    INSERT INTO library_migration_state (id, phase) VALUES (1, 'contracted');
    INSERT INTO users (id, username, password_hash, role, status) VALUES (1, 'owner', 'hash', 'user', 1);
  `)
  sqlite.prepare(`
    INSERT INTO assets (id, kind, file_path, mime_type, file_size, sha256)
    VALUES
      (1, 'core_js', ?, 'text/javascript', ?, ?),
      (2, 'core_wasm', ?, 'application/wasm', ?, ?)
  `).run(
    storedPath(coreJsSha), coreJsBytes.length, coreJsSha,
    storedPath(coreWasmSha), coreWasmBytes.length, coreWasmSha,
  )
  sqlite.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256, wasm_asset_id, wasm_sha256, dat_sha256, artifact_fingerprint, is_enabled)
    VALUES (1, 'fixture', '1', ?, 1, ?, 2, ?, ?, ?, 1)
  `).run(coreSourceCommit, coreJsSha, coreWasmSha, coreDatSha, coreFingerprint)
  t.after(() => {
    sqlite.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, batchRoot, assetRoot, contractsDir, repoRoot, dbPath, manifestPath, sqlite, manifest, coreFingerprint }
}

test('commit is explicit, idempotent, and records an operation ledger', (t) => {
  const f = fixture(t)
  const first = commitBatch({
    dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath,
    batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true,
  })
  assert.equal(first.status, 'committed_private')
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM roms').get().n, 1)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM import_operations').get().n > 0, true)
  assert.deepEqual(
    JSON.parse(f.sqlite.prepare("SELECT after_json FROM import_operations WHERE entity_type = 'candidate_resolution'").get().after_json),
    f.manifest.candidateResolutions[0],
  )
  assert.equal(
    f.sqlite.prepare('SELECT source_file_sha256 FROM rom_asset_refs').get().source_file_sha256,
    'b'.repeat(64),
  )
  assert.deepEqual(
    f.sqlite.prepare('SELECT source_archive_path, member_name FROM build_source_members').get(),
    { source_archive_path: 'roms/source.zip', member_name: 'source-game.bin' },
  )
  const second = commitBatch({
    dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath,
    batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true,
  })
  assert.equal(second.noop, true)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM roms').get().n, 1)
})

test('commit persists blocked and unsupported candidates in the resolution ledger', (t) => {
  for (const state of ['blocked', 'unsupported']) {
    const f = fixture(t)
    f.manifest.batchId = `fixture-${state}`
    f.manifest.candidateResolutions[0].state = state
    f.manifest.candidateResolutions[0].reasons = [`fixture ${state}`]
    rewriteManifest(f)
    const result = commitBatch({
      dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath,
      batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true,
    })
    assert.equal(result.status, 'committed_private')
    assert.equal(result.importedCandidates, 0)
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM rom_builds').get().n, 0)
    const operation = f.sqlite.prepare("SELECT * FROM import_operations WHERE entity_type = 'candidate_resolution'").get()
    assert.equal(operation.entity_key, 'fixture:game')
    assert.equal(JSON.parse(operation.after_json).state, state)
  }
})

test('idempotent commit refuses missing resolution evidence or content objects', (t) => {
  const first = fixture(t)
  commitBatch({ dbPath: first.dbPath, assetRoot: first.assetRoot, manifestPath: first.manifestPath, batchRoot: first.batchRoot, contractsDir: first.contractsDir, ownerUserId: 1, apply: true })
  first.sqlite.prepare("DELETE FROM import_operations WHERE entity_type = 'candidate_resolution'").run()
  assert.throws(
    () => commitBatch({ dbPath: first.dbPath, assetRoot: first.assetRoot, manifestPath: first.manifestPath, batchRoot: first.batchRoot, contractsDir: first.contractsDir, ownerUserId: 1, apply: true }),
    /resolution.*ledger|integrity/i,
  )

  const second = fixture(t)
  commitBatch({ dbPath: second.dbPath, assetRoot: second.assetRoot, manifestPath: second.manifestPath, batchRoot: second.batchRoot, contractsDir: second.contractsDir, ownerUserId: 1, apply: true })
  const asset = second.sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(second.manifest.archives[0].archiveSha256)
  rmSync(join(second.assetRoot, asset.file_path), { force: true })
  assert.throws(
    () => commitBatch({ dbPath: second.dbPath, assetRoot: second.assetRoot, manifestPath: second.manifestPath, batchRoot: second.batchRoot, contractsDir: second.contractsDir, ownerUserId: 1, apply: true }),
    /content object.*missing|integrity/i,
  )
})

test('commit registers a missing hash-pinned core artifact from repoRoot', (t) => {
  const f = fixture(t)
  f.sqlite.prepare('DELETE FROM core_artifacts').run()
  const result = commitBatch({
    dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath,
    batchRoot: f.batchRoot, contractsDir: f.contractsDir, repoRoot: f.repoRoot,
    ownerUserId: 1, apply: true,
  })
  assert.equal(result.status, 'committed_private')
  const core = f.sqlite.prepare('SELECT * FROM core_artifacts').get()
  assert.equal(core.artifact_fingerprint, f.coreFingerprint)
  assert.equal(core.dat_sha256, 'f'.repeat(64))
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM assets WHERE kind IN ('core_js', 'core_wasm')").get().n, 2)
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM import_operations WHERE entity_type = 'core_artifact'").get().n, 1)
})

test('rollback removes a batch-created core after its builds are gone', (t) => {
  const f = fixture(t)
  f.sqlite.prepare('DELETE FROM core_artifacts').run()
  commitBatch({
    dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath,
    batchRoot: f.batchRoot, contractsDir: f.contractsDir, repoRoot: f.repoRoot,
    ownerUserId: 1, apply: true,
  })
  const result = rollbackBatch({
    dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath,
    batchId: 'fixture-batch', apply: true,
  })
  assert.equal(result.status, 'rolled_back')
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM core_artifacts').get().n, 0)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 2)
})

test('rollback rechecks preflight inside the write transaction', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  const buildId = f.sqlite.prepare('SELECT id FROM rom_builds').get().id
  f.sqlite.exec(`
    CREATE TRIGGER mutate_rollback_preflight
    AFTER UPDATE OF status ON import_batches
    WHEN NEW.status = 'rolling_back'
    BEGIN
      UPDATE roms SET active_build_id = active_build_id + 100;
    END;
  `)

  const result = rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true })
  assert.equal(result.status, 'rollback_failed')
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches WHERE id = ?').get('fixture-batch').status, 'rollback_failed')
  assert.equal(f.sqlite.prepare('SELECT active_build_id FROM roms').get().active_build_id, buildId)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM rom_builds').get().n, 1)
})

test('rollback refuses a stale active pointer and leaves the batch unchanged', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  f.sqlite.prepare('UPDATE roms SET active_build_id = active_build_id + 100').run()
  const result = rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true })
  assert.equal(result.status, 'rollback_failed')
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches WHERE id = ?').get('fixture-batch').status, 'rollback_failed')
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM import_operations WHERE entity_type = 'import_batch' AND operation_kind = 'status'").get().n, 1)
})

test('rollback shares the import lock with commit', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  const lockPath = `${f.dbPath}.arcade-import.lock`
  writeFileSync(lockPath, 'active import\n')
  t.after(() => rmSync(lockPath, { force: true }))

  assert.throws(
    () => rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true }),
    /arcade import lock already exists/i,
  )
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches WHERE id = ?').get('fixture-batch').status, 'committed_private')
})

test('rollback respects the shared content mutation lifecycle lock', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  const lock = createContentStore({ root: f.assetRoot }).acquireMutationLock({ operation: 'active-upload' })
  try {
    assert.throws(
      () => rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true }),
      /content mutation lock already exists/i,
    )
    assert.equal(f.sqlite.prepare('SELECT status FROM import_batches WHERE id = ?').get('fixture-batch').status, 'committed_private')
  } finally {
    lock.release()
  }
})

test('commit respects the shared content mutation lifecycle lock for first and idempotent runs', (t) => {
  const f = fixture(t)
  const commit = () => commitBatch({
    dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath,
    batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true,
  })
  const assertBlocked = () => {
    const lock = createContentStore({ root: f.assetRoot }).acquireMutationLock({ operation: 'active-upload' })
    try {
      assert.throws(commit, /content mutation lock already exists/i)
    } finally {
      lock.release()
    }
  }

  assertBlocked()
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n, 0)
  assert.equal(commit().status, 'committed_private')
  assertBlocked()
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches WHERE id = ?').get('fixture-batch').status, 'committed_private')
})

test('idempotent commit remains serialized with an active rollback', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  const lockPath = `${f.dbPath}.arcade-import.lock`
  writeFileSync(lockPath, 'active rollback\n')
  t.after(() => rmSync(lockPath, { force: true }))

  assert.throws(
    () => commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true }),
    /arcade import lock already exists/i,
  )
})

test('rollback can resume a logged conflict after the entity is restored', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  const buildId = f.sqlite.prepare('SELECT id FROM rom_builds').get().id
  f.sqlite.prepare('UPDATE roms SET active_build_id = active_build_id + 100').run()
  const failed = rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true })
  assert.equal(failed.status, 'rollback_failed')
  f.sqlite.prepare('UPDATE roms SET active_build_id = ?').run(buildId)
  const resumed = rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true })
  assert.equal(resumed.status, 'rolled_back')
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches WHERE id = ?').get('fixture-batch').status, 'rolled_back')
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM import_operations WHERE entity_type = 'import_batch' AND operation_kind = 'status'").get().n, 3)
})

test('rollback records a retriable failure when content cleanup fails after database reversal', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  const archive = f.manifest.archives[0]
  const asset = f.sqlite.prepare('SELECT * FROM assets WHERE sha256 = ?').get(archive.archiveSha256)
  const publishedPath = join(f.assetRoot, asset.file_path)

  rmSync(publishedPath)
  mkdirSync(publishedPath)
  assert.throws(
    () => rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true }),
    /regular file/i,
  )
  assert.equal(f.sqlite.prepare('SELECT status FROM import_batches WHERE id = ?').get('fixture-batch').status, 'rollback_failed')

  rmSync(publishedPath, { recursive: true, force: true })
  writeFileSync(publishedPath, readFileSync(join(f.batchRoot, archive.archivePath)))
  const resumed = rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true })
  assert.equal(resumed.status, 'rolled_back')
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 2)
})

test('rollback preserves a room and build referenced after import', (t) => {
  const f = fixture(t)
  commitBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchRoot: f.batchRoot, contractsDir: f.contractsDir, ownerUserId: 1, apply: true })
  const buildId = f.sqlite.prepare('SELECT id FROM rom_builds').get().id
  const romId = f.sqlite.prepare('SELECT id FROM roms').get().id
  f.sqlite.prepare('INSERT INTO rooms (code, host_user_id, rom_id, rom_build_id, name) VALUES (?, ?, ?, ?, ?)').run('ROOM1', 1, romId, buildId, 'keep')
  const result = rollbackBatch({ dbPath: f.dbPath, assetRoot: f.assetRoot, manifestPath: f.manifestPath, batchId: 'fixture-batch', apply: true })
  assert.equal(result.status, 'rolled_back')
  assert.deepEqual(
    result.preserved.map(({ entityType, reason }) => ({ entityType, reason })),
    [
      { entityType: 'rom_build', reason: 'referenced' },
      { entityType: 'rom', reason: 'referenced' },
      { entityType: 'asset', reason: 'referenced' },
    ],
  )
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 1)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM rom_builds').get().n, 1)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM roms').get().n, 1)
  assert.deepEqual(
    f.sqlite.prepare('SELECT rom_id, rom_build_id FROM rooms WHERE code = ?').get('ROOM1'),
    { rom_id: romId, rom_build_id: buildId },
  )
})
