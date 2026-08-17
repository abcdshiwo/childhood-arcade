import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS_DIR = join(PROJECT_ROOT, 'tools', 'arcade-import')
const PREPARE = join(TOOLS_DIR, 'prepare_batch.py')

function findPython() {
  const bundled = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')
    : null
  const candidates = [process.env.ARCADE_IMPORT_PYTHON, bundled, 'python3', 'python'].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import PIL'], { windowsHide: true })
    if (!probe.error && probe.status === 0) return candidate
  }
  throw new Error('arcade importer tests require the pinned Python runtime')
}

const PYTHON = findPython()

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
  const result = Buffer.alloc(2)
  result.writeUInt16LE(value)
  return result
}

function u32(value) {
  const result = Buffer.alloc(4)
  result.writeUInt32LE(value >>> 0)
  return result
}

function zipBuffer(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(bytes, { level: 9 })
    const crc = crc32(bytes)
    const header = Buffer.concat([
      Buffer.from('PK\x03\x04', 'binary'), u16(20), u16(0x800), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), nameBytes,
    ])
    local.push(header, compressed)
    central.push(Buffer.concat([
      Buffer.from('PK\x01\x02', 'binary'), u16(20), u16(20), u16(0x800), u16(8), u16(0), u16(33),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0o100644 << 16), u32(offset), nameBytes,
    ]))
    offset += header.length + compressed.length
  }
  const body = Buffer.concat(local)
  const directory = Buffer.concat(central)
  return Buffer.concat([
    body,
    directory,
    Buffer.from('PK\x05\x06', 'binary'),
    Buffer.alloc(4),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(body.length),
    u16(0),
  ])
}

function bmp1x1() {
  const bytes = Buffer.alloc(58, 0)
  bytes.write('BM', 0, 'ascii')
  bytes.writeUInt32LE(58, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(1, 18)
  bytes.writeInt32LE(1, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(4, 34)
  bytes[54] = 0x20
  bytes[55] = 0x80
  bytes[56] = 0xe0
  return bytes
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'arcade-prepare-integrity-'))
  const sourceRoot = join(root, 'source')
  const contractsDir = join(root, 'contracts')
  const outputDir = join(root, 'batch')
  mkdirSync(join(sourceRoot, 'roms'), { recursive: true })
  mkdirSync(join(sourceRoot, 'sshots'), { recursive: true })
  mkdirSync(contractsDir, { recursive: true })

  const memberBytes = Buffer.from('integrity-fixture-rom')
  writeFileSync(join(sourceRoot, 'roms', 'game.zip'), zipBuffer([['game.bin', memberBytes]]))
  writeFileSync(join(sourceRoot, 'sshots', 'game.bmp'), bmp1x1())
  const memberCrc = crc32(memberBytes).toString(16).padStart(8, '0')
  const row = {
    id: 'fixture:game',
    source: 'fixture',
    coreArtifactId: 'fixture_core',
    setName: 'game',
    title: 'Integrity Game',
    platform: 'arcade',
    relationKind: 'parent',
    relationEvidence: 'fixture',
    datParentSetName: null,
    archiveName: 'game.zip',
    archiveLayout: 'standalone',
    runtimeParentSetName: null,
    biosSetNames: [],
    runtimeContractCoreId: 'fixture_core',
    contractSourceIds: ['fixture'],
    rawContentContractSha256: sha256(`${memberBytes.length}:${memberCrc}`),
    runtimeContractFingerprint: sha256('integrity-runtime-contract'),
    members: [['game.bin', memberBytes.length, memberCrc]],
    sourceSetNames: ['game'],
    thumbnail: { matchKind: 'direct-or-alias', sourceSetName: 'game', evidence: 'exact canonical driver basename' },
  }
  const contracts = {
    'candidates.json': { schemaVersion: 1, contractKind: 'fixture', signed: false, rows: [row] },
    'cores.json': {
      schemaVersion: 1,
      contractKind: 'fixture',
      signed: false,
      cores: [{
        id: 'fixture_core', coreName: 'fbneo', runtimeName: 'Fixture', runtimeVersion: '1',
        frontendVersion: '1', contractEnabled: true, runtimeValidationStatus: 'static-unverified',
        candidateRows: 1,
        artifacts: {
          js: { path: 'fixture.js', sha256: '0'.repeat(64), hashMode: 'raw' },
          wasm: { path: 'fixture.wasm', sha256: '1'.repeat(64), hashMode: 'raw' },
        },
      }],
    },
    'sources.json': { schemaVersion: 1, contractKind: 'fixture', signed: false, invariants: { candidateRows: 1 }, inputs: [] },
    'alias-folds.json': { schemaVersion: 1, contractKind: 'fixture', signed: false, rows: [] },
  }
  for (const [name, value] of Object.entries(contracts)) {
    writeFileSync(join(contractsDir, name), `${JSON.stringify(value, null, 2)}\n`)
  }
  const sums = readdirSync(contractsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${sha256(readFileSync(join(contractsDir, name)))}  ${name}`)
    .join('\n') + '\n'
  writeFileSync(join(contractsDir, 'SHA256SUMS.txt'), sums)
  const coldSource = join(root, 'cold-source.7z')
  writeFileSync(coldSource, Buffer.from('integrity-cold-source'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { sourceRoot, contractsDir, outputDir, coldSource }
}

function applyBatch(f) {
  return spawnSync(PYTHON, [
    PREPARE,
    '--apply',
    '--source-root', f.sourceRoot,
    '--cold-source', f.coldSource,
    '--contracts-dir', f.contractsDir,
    '--output-dir', f.outputDir,
  ], { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true })
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`
}

function generatedPaths(f) {
  const manifest = JSON.parse(readFileSync(join(f.outputDir, 'manifest.json'), 'utf8'))
  return {
    archive: join(f.outputDir, manifest.archives[0].archivePath),
    thumbnail: join(f.outputDir, manifest.thumbnailSources[0].assetPath),
  }
}

test('repeated apply rejects a missing archive or WebP object', (t) => {
  for (const kind of ['archive', 'thumbnail']) {
    const f = fixture(t)
    const first = applyBatch(f)
    assert.equal(first.status, 0, output(first))
    unlinkSync(generatedPaths(f)[kind])

    const repeated = applyBatch(f)
    assert.notEqual(repeated.status, 0, `${kind}: repeated apply must not report noop`)
    assert.match(output(repeated), /existing batch asset is missing/i, kind)
  }
})

test('repeated apply rejects a tampered archive or WebP object', (t) => {
  for (const kind of ['archive', 'thumbnail']) {
    const f = fixture(t)
    const first = applyBatch(f)
    assert.equal(first.status, 0, output(first))
    writeFileSync(generatedPaths(f)[kind], Buffer.from(`tampered-${kind}`))

    const repeated = applyBatch(f)
    assert.notEqual(repeated.status, 0, `${kind}: repeated apply must not report noop`)
    assert.match(output(repeated), /existing batch asset content mismatch/i, kind)
  }
})

test('repeated apply rejects an unexpected output file', (t) => {
  const f = fixture(t)
  const first = applyBatch(f)
  assert.equal(first.status, 0, output(first))
  writeFileSync(join(f.outputDir, 'untracked-output.bin'), Buffer.from('unexpected'))

  const repeated = applyBatch(f)
  assert.notEqual(repeated.status, 0)
  assert.match(output(repeated), /existing batch output contains an unexpected file/i)
})

test('runtime guard rejects an unaudited zlib runtime', () => {
  const script = [
    'import sys, zlib',
    `sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})`,
    "zlib.ZLIB_RUNTIME_VERSION = '0.0-test'",
    'import prepare_batch',
    'prepare_batch.assert_deterministic_runtime()',
  ].join('; ')
  const result = spawnSync(PYTHON, ['-c', script], { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true })
  assert.notEqual(result.status, 0)
  assert.match(output(result), /zlib.*1\.3\.2/i)
})

test('runtime guard rejects an unaudited libwebp runtime', () => {
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})`,
    'import prepare_batch',
    'from PIL import features',
    "features.version_module = lambda name: '0.0-test' if name == 'webp' else None",
    'prepare_batch.assert_deterministic_runtime()',
  ].join('; ')
  const result = spawnSync(PYTHON, ['-c', script], { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true })
  assert.notEqual(result.status, 0)
  assert.match(output(result), /libwebp.*1\.6\.0/i)
})
