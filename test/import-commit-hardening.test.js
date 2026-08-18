import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'

import Database from 'better-sqlite3'

import {
  canonicalizeLibraryJson,
  computeCoreArtifactFingerprint,
  hashCanonicalLibraryJson,
} from '../server/services/library-service.js'
import { commitBatch } from '../tools/arcade-import/commit_batch.js'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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

function deterministicZip(entries, { preserveEntryOrder = false } = {}) {
  const local = []
  const central = []
  let offset = 0
  const orderedEntries = preserveEntryOrder
    ? [...entries]
    : [...entries].sort(([left], [right]) => left.localeCompare(right))
  for (const [name, bytes] of orderedEntries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(bytes, { level: 9 })
    const crc = crc32(bytes)
    const header = Buffer.concat([
      Buffer.from('PK\x03\x04', 'binary'), u16(20), u16(0), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), nameBytes,
    ])
    local.push(header, compressed)
    central.push(Buffer.concat([
      Buffer.from('PK\x01\x02', 'binary'), u16(0x0314), u16(20), u16(0), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0o100644 << 16), u32(offset), nameBytes,
    ]))
    offset += header.length + compressed.length
  }
  const body = Buffer.concat(local)
  const directory = Buffer.concat(central)
  return Buffer.concat([
    body, directory,
    Buffer.from('PK\x05\x06', 'binary'), Buffer.alloc(4), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(body.length), u16(0),
  ])
}

function storedPath(hash) {
  return `sha256/${hash.slice(0, 2)}/${hash}`
}

function writeContractLedger(contractsDir, documents) {
  const hashes = {}
  for (const [name, document] of Object.entries(documents)) {
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
    writeFileSync(join(contractsDir, name), bytes)
    hashes[name] = sha256(bytes)
  }
  const sums = Buffer.from(`${Object.entries(hashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join('\n')}\n`)
  writeFileSync(join(contractsDir, 'SHA256SUMS.txt'), sums)
  return { hashes, sums }
}

function writeManifest(path, manifest) {
  const body = { ...manifest }
  delete body.manifestSha256
  manifest.manifestSha256 = hashCanonicalLibraryJson(body)
  writeFileSync(path, `${canonicalizeLibraryJson(manifest)}\n`)
}

function memberRecord(name, bytes, sourcePath = 'roms/source.zip!game.bin') {
  return {
    name,
    size: bytes.length,
    crc32: crc32(bytes).toString(16).padStart(8, '0'),
    sha256: sha256(bytes),
    sourcePath,
  }
}

function fixture(t, {
  archiveBytes,
  archiveEntries,
  contractEntries,
  mutateManifestMembers,
  mutateCore,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arcade-import-commit-hardening-'))
  const batchRoot = join(root, 'batch')
  const assetRoot = join(root, 'assets')
  const contractsDir = join(root, 'contracts')
  const dbPath = join(root, 'app.db')
  const archiveRel = 'archives/fixture-core/game.zip'
  mkdirSync(join(batchRoot, 'archives', 'fixture-core'), { recursive: true })
  mkdirSync(assetRoot, { recursive: true })
  mkdirSync(contractsDir, { recursive: true })

  const canonicalGame = Buffer.from('fixture-game')
  const outputEntries = archiveEntries ?? [['game.bin', canonicalGame]]
  const expectedEntries = contractEntries ?? [['game.bin', canonicalGame]]
  const generatedArchive = archiveBytes ?? deterministicZip(outputEntries)
  writeFileSync(join(batchRoot, archiveRel), generatedArchive)

  const coreJsBytes = Buffer.from('fixture-core-js')
  const coreWasmBytes = Buffer.from('fixture-core-wasm')
  const coreJsSha = sha256(coreJsBytes)
  const coreWasmSha = sha256(coreWasmBytes)
  const coreSourceCommit = 'e'.repeat(40)
  const coreDatSha = 'f'.repeat(64)
  const coreFingerprint = computeCoreArtifactFingerprint({
    coreName: 'fixture', displayVersion: '1', sourceCommit: coreSourceCommit,
    jsSha256: coreJsSha, wasmSha256: coreWasmSha,
    datSha256: coreDatSha, biosManifestSha256: null,
  })
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
  const runtimeContractFingerprint = 'c'.repeat(64)
  const rawContentContractSha256 = 'd'.repeat(64)
  const contractMembers = expectedEntries.map(([name, bytes]) => [
    name,
    bytes.length,
    crc32(bytes).toString(16).padStart(8, '0'),
  ])
  const candidateContract = {
    id: 'fixture:game', coreArtifactId: 'fixture-core', setName: 'game',
    title: 'Fixture Game', platform: 'arcade', relationKind: 'parent',
    datParentSetName: null, archiveLayout: 'standalone', runtimeParentSetName: null,
    members: contractMembers,
    runtimeContractFingerprint, rawContentContractSha256,
    thumbnail: {
      matchKind: 'direct-or-alias', sourceSetName: 'game', evidence: 'exact canonical driver basename',
    },
  }
  const { hashes, sums } = writeContractLedger(contractsDir, {
    'alias-folds.json': { schemaVersion: 1, rows: [] },
    'candidates.json': { schemaVersion: 1, rows: [candidateContract] },
    'cores.json': { schemaVersion: 1, cores: [coreContract] },
    'sources.json': { schemaVersion: 1, inputs: [] },
  })
  const archiveMembers = expectedEntries.map(([name, bytes]) => memberRecord(name, bytes))
  mutateManifestMembers?.(archiveMembers)
  const manifest = {
    schemaVersion: 1,
    kind: 'w165-import-batch-v1',
    batchId: `fixture-${sha256(generatedArchive).slice(0, 12)}`,
    coldSource: { sha256: 'a'.repeat(64), fileSize: 1 },
    contracts: {
      sha256sumsSha256: sha256(sums),
      ...Object.fromEntries(Object.entries(hashes).map(([name, digest]) => [`${name.slice(0, -5)}Sha256`, digest])),
    },
    cores: [coreContract],
    candidateResolutions: [{
      candidateId: 'fixture:game', state: 'unverified',
      runtimeContractFingerprint, rawContentContractSha256,
    }],
    archives: [{
      candidateId: 'fixture:game', coreArtifactId: 'fixture-core', setName: 'game',
      title: 'Fixture Game', platform: 'arcade', relationKind: 'parent',
      datParentSetName: null, familyRootSetName: 'game', archiveLayout: 'standalone',
      archivePath: archiveRel, archiveSha256: sha256(generatedArchive), archiveSize: generatedArchive.length,
      mounts: [{ role: 'primary', candidateId: 'fixture:game', path: archiveRel }],
      members: archiveMembers,
    }],
    thumbnails: [{ candidateId: 'fixture:game', sourceSetName: 'game', matchKind: 'exact' }],
    auxiliaryEvidence: [],
    saveSampleEvidence: [],
    summary: { candidateRows: 1, runtimeCoreScopedContracts: 1, globalRawPayloadIdentities: 1 },
  }
  const manifestPath = join(batchRoot, 'manifest.json')
  writeManifest(manifestPath, manifest)

  const storedCoreAssets = [
    { id: 1, kind: 'core_js', mimeType: 'text/javascript', bytes: coreJsBytes, sha256: coreJsSha },
    { id: 2, kind: 'core_wasm', mimeType: 'application/wasm', bytes: coreWasmBytes, sha256: coreWasmSha },
  ]
  for (const asset of storedCoreAssets) {
    const path = join(assetRoot, storedPath(asset.sha256))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, asset.bytes)
  }

  const sqlite = new Database(dbPath)
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, status INTEGER NOT NULL);
    CREATE TABLE import_batches (id TEXT PRIMARY KEY, manifest_sha256 TEXT, status TEXT, actual_count INTEGER);
    CREATE TABLE assets (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE core_artifacts (id INTEGER PRIMARY KEY, core_name TEXT NOT NULL, display_version TEXT NOT NULL, source_commit TEXT, js_asset_id INTEGER NOT NULL, js_sha256 TEXT NOT NULL, wasm_asset_id INTEGER NOT NULL, wasm_sha256 TEXT NOT NULL, dat_sha256 TEXT, artifact_fingerprint TEXT NOT NULL, is_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE roms (id INTEGER PRIMARY KEY);
    CREATE TABLE rom_builds (id INTEGER PRIMARY KEY);
    CREATE TABLE rom_asset_refs (id INTEGER PRIMARY KEY);
    CREATE TABLE batch_build_refs (import_batch_id TEXT, rom_build_id INTEGER);
    CREATE TABLE build_source_members (import_batch_id TEXT, rom_build_id INTEGER);
    CREATE TABLE import_operations (id INTEGER PRIMARY KEY, import_batch_id TEXT, sequence INTEGER, operation_kind TEXT, entity_type TEXT, entity_key TEXT, before_json TEXT, after_json TEXT, reverted_at INTEGER);
    CREATE TABLE library_migration_state (id INTEGER PRIMARY KEY, phase TEXT NOT NULL);
    INSERT INTO users (id, status) VALUES (1, 1);
    INSERT INTO library_migration_state (id, phase) VALUES (1, 'contracted');
  `)
  for (const asset of storedCoreAssets) {
    sqlite.prepare('INSERT INTO assets (id, kind, file_path, mime_type, file_size, sha256) VALUES (?, ?, ?, ?, ?, ?)').run(
      asset.id, asset.kind, storedPath(asset.sha256), asset.mimeType, asset.bytes.length, asset.sha256,
    )
  }
  sqlite.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256, wasm_asset_id, wasm_sha256, dat_sha256, artifact_fingerprint, is_enabled)
    VALUES (1, 'fixture', '1', ?, 1, ?, 2, ?, ?, ?, 1)
  `).run(coreSourceCommit, coreJsSha, coreWasmSha, coreDatSha, coreFingerprint)
  mutateCore?.({ sqlite, assetRoot, coreJsSha, coreWasmSha, coreJsBytes, coreWasmBytes })

  t.after(() => {
    sqlite.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { assetRoot, batchRoot, contractsDir, dbPath, manifestPath }
}

function commitFixture(f) {
  return commitBatch({
    dbPath: f.dbPath,
    assetRoot: f.assetRoot,
    manifestPath: f.manifestPath,
    batchRoot: f.batchRoot,
    contractsDir: f.contractsDir,
    ownerUserId: 1,
    apply: false,
  })
}

test('commit accepts a deterministic prepared ZIP and a complete existing core without repoRoot', (t) => {
  const result = commitFixture(fixture(t))
  assert.equal(result.dryRun, true)
  assert.equal(result.plannedAssets, 1)
})

test('commit accepts manifest members in deterministic byte order', (t) => {
  const entries = [
    ['41-1m.3a', Buffer.from('dash-member')],
    ['41_19.12c', Buffer.from('underscore-member')],
  ]
  const result = commitFixture(fixture(t, {
    archiveBytes: deterministicZip(entries, { preserveEntryOrder: true }),
    contractEntries: entries,
  }))
  assert.equal(result.dryRun, true)
  assert.equal(result.plannedCandidates, 1)
})

test('commit independently rejects malformed prepared archive members', (t) => {
  const expected = Buffer.from('fixture-game')
  const sameLengthDifferentPayload = Buffer.from('fixture-gamE')
  const cases = [
    ['non-ZIP bytes', { archiveBytes: Buffer.from('not-a-zip') }, /ZIP|archive/i],
    ['wrong archive member name', { archiveEntries: [['other.bin', expected]] }, /member.*(?:name|content)|ZIP/i],
    ['traversal archive member', { contractEntries: [['../game.bin', expected]], archiveEntries: [['../game.bin', expected]] }, /traversal|ZIP member/i],
    ['duplicate archive member', { contractEntries: [['game.bin', expected], ['game.bin', expected]], archiveEntries: [['game.bin', expected], ['game.bin', expected]] }, /duplicate.*member/i],
    ['member SHA-256 detached from archive data', {
      archiveEntries: [['game.bin', sameLengthDifferentPayload]],
      contractEntries: [['game.bin', sameLengthDifferentPayload]],
      mutateManifestMembers: (members) => { members[0].sha256 = sha256(expected) },
    }, /member.*SHA-256|member.*content/i],
    ['unsafe source member provenance', {
      mutateManifestMembers: (members) => { members[0].sourcePath = '../source.zip!game.bin' },
    }, /source.*member|traversal|provenance/i],
  ]
  for (const [label, options, expectedError] of cases) {
    assert.throws(() => commitFixture(fixture(t, options)), expectedError, label)
  }
})

test('commit validates the existing core asset records and content without repoRoot', (t) => {
  const cases = [
    ['missing referenced asset', ({ sqlite }) => sqlite.prepare('UPDATE core_artifacts SET js_asset_id = 99').run(), /core.*JS.*asset|core.*asset/i],
    ['core SHA-256 detached from the contract', ({ sqlite }) => sqlite.prepare("UPDATE core_artifacts SET js_sha256 = '0' || substr(js_sha256, 2)").run(), /core.*artifact|core.*asset/i],
    ['wrong asset kind', ({ sqlite }) => sqlite.prepare("UPDATE assets SET kind = 'rom' WHERE id = 1").run(), /core.*JS.*asset|core.*asset/i],
    ['wrong asset MIME type', ({ sqlite }) => sqlite.prepare("UPDATE assets SET mime_type = 'application/octet-stream' WHERE id = 1").run(), /core.*JS.*asset|core.*asset/i],
    ['wrong asset SHA-256', ({ sqlite }) => sqlite.prepare("UPDATE assets SET sha256 = '0' || substr(sha256, 2) WHERE id = 1").run(), /core.*JS.*asset|core.*asset/i],
    ['wrong content-addressed path', ({ sqlite }) => sqlite.prepare("UPDATE assets SET file_path = 'sha256/00/not-the-contract-hash' WHERE id = 1").run(), /core.*JS.*asset|core.*asset/i],
    ['wrong asset size', ({ sqlite }) => sqlite.prepare('UPDATE assets SET file_size = file_size + 1 WHERE id = 1').run(), /core.*JS.*asset|core.*asset/i],
    ['missing stored content', ({ assetRoot, coreJsSha }) => rmSync(join(assetRoot, storedPath(coreJsSha))), /core.*JS.*asset|core.*asset/i],
    ['tampered stored content', ({ assetRoot, coreJsSha }) => writeFileSync(join(assetRoot, storedPath(coreJsSha)), Buffer.from('tampered-core-js')), /core.*JS.*asset|core.*asset/i],
  ]
  for (const [label, mutateCore, expectedError] of cases) {
    assert.throws(() => commitFixture(fixture(t, { mutateCore })), expectedError, label)
  }
})
