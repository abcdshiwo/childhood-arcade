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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREPARE = join(PROJECT_ROOT, 'tools', 'arcade-import', 'prepare_batch.py')
const VERIFY = join(PROJECT_ROOT, 'tools', 'arcade-import', 'verify_batch.py')
function findPython() {
  const bundled = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')
    : null
  const candidates = [process.env.ARCADE_IMPORT_PYTHON, bundled, 'python3', 'python'].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import PIL'], { windowsHide: true })
    if (!probe.error && probe.status === 0) return candidate
  }
  throw new Error('arcade importer tests require Python with Pillow; set ARCADE_IMPORT_PYTHON')
}

const PYTHON = findPython()

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function writeManifest(path, manifest) {
  delete manifest.manifestSha256
  manifest.manifestSha256 = sha256(JSON.stringify(canonicalize(manifest)))
  writeFileSync(path, `${JSON.stringify(manifest)}\n`)
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

function dosDateTime() {
  return { date: 33, time: 0 }
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

function zipBuffer(entries) {
  const local = []
  const central = []
  let offset = 0
  const { date, time } = dosDateTime()
  for (const [name, bytes] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(bytes, { level: 9 })
    const crc = crc32(bytes)
    const header = Buffer.concat([
      Buffer.from('PK\x03\x04', 'binary'), u16(20), u16(0x800), u16(8), u16(time), u16(date),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), nameBytes,
    ])
    local.push(header, compressed)
    const record = Buffer.concat([
      Buffer.from('PK\x01\x02', 'binary'), u16(20), u16(20), u16(0x800), u16(8), u16(time), u16(date),
      u32(crc), u32(compressed.length), u32(bytes.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0o100644 << 16), u32(offset), nameBytes,
    ])
    central.push(record)
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

function writeZip(path, entries) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, zipBuffer(entries))
}

function kawaksRleFill(byte = 0, size = 65_536) {
  const payload = []
  let remaining = size
  while (remaining > 0) {
    const count = Math.min(63, remaining)
    payload.push(Buffer.from([0xc0 + count, byte]))
    remaining -= count
  }
  const body = Buffer.concat(payload)
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}

function listFiles(root) {
  const result = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else result.push(path)
    }
  }
  visit(root)
  return result
}

function bmp1x1(pixel = [0, 0, 0]) {
  const bytes = Buffer.alloc(58, 0)
  bytes.write('BM', 0, 'ascii')
  bytes.writeUInt32LE(58, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(1, 18)
  bytes.writeInt32LE(1, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(0, 30)
  bytes.writeUInt32LE(4, 34)
  bytes[54] = pixel[2]
  bytes[55] = pixel[1]
  bytes[56] = pixel[0]
  return bytes
}

function run(script, args, { env = {}, cwd = PROJECT_ROOT } = {}) {
  const result = spawnSync(PYTHON, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  })
  return {
    ...result,
    output: `${result.stdout || ''}${result.stderr || ''}`,
    spawnError: result.error ?? null,
  }
}

function rewriteContractHashes(contractsDir) {
  const sums = readdirSync(contractsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${sha256(readFileSync(join(contractsDir, name)))}  ${name}`)
    .join('\n') + '\n'
  writeFileSync(join(contractsDir, 'SHA256SUMS.txt'), sums)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'arcade-import-manifest-'))
  const sourceRoot = join(root, 'source')
  const contractsDir = join(root, 'contracts')
  const outputDir = join(root, 'batch')
  mkdirSync(join(sourceRoot, 'roms', 'Cps1'), { recursive: true })
  mkdirSync(join(sourceRoot, 'roms', 'NeoGeo'), { recursive: true })
  mkdirSync(join(sourceRoot, 'sshots'), { recursive: true })
  mkdirSync(join(sourceRoot, 'eeprom'), { recursive: true })
  mkdirSync(contractsDir, { recursive: true })
  const parentBytes = Buffer.from('parent-payload')
  const childBytes = Buffer.from('child-payload')
  const sharedBytes = Buffer.from('shared-payload')
  writeZip(join(sourceRoot, 'roms', 'Cps1', 'parent.zip'), [['p.bin', parentBytes]])
  writeZip(join(sourceRoot, 'roms', 'Cps1', 'child.zip'), [
    ['p.bin', parentBytes],
    ['renamed-parent.bin', parentBytes],
    ['c.bin', childBytes],
  ])
  writeZip(join(sourceRoot, 'roms', 'NeoGeo', 'alias.zip'), [['p.bin', parentBytes]])
  writeZip(join(sourceRoot, 'roms', 'NeoGeo', 'ref.zip'), [['s.bin', sharedBytes]])
  writeZip(join(sourceRoot, 'roms', 'NeoGeo', 'neogeo.zip'), [['sp-s2.sp1', Buffer.from('bios-payload')]])
  writeFileSync(join(sourceRoot, 'sshots', 'parent.bmp'), bmp1x1([255, 0, 0]))
  writeFileSync(join(sourceRoot, 'sshots', 'PARENT.PNG'), bmp1x1([0, 0, 255]))
  writeFileSync(join(sourceRoot, 'sshots', 'child.bmp'), bmp1x1([0, 255, 0]))
  writeFileSync(join(sourceRoot, 'sshots', 'rotd.bmp'), bmp1x1([0, 0, 255]))
  writeFileSync(join(sourceRoot, 'sshots', 'rotd.png'), Buffer.from('png-placeholder'))
  writeFileSync(join(sourceRoot, 'sshots', 'orphan.BMP'), bmp1x1([255, 255, 0]))
  writeFileSync(join(sourceRoot, 'eeprom', 'dino.epm'), Buffer.alloc(128, 0x5a))
  const sharedSrm = kawaksRleFill(0x00)
  writeFileSync(join(sourceRoot, 'eeprom', 'bangbead.srm'), sharedSrm)
  writeFileSync(join(sourceRoot, 'eeprom', 'mslug4.srm'), sharedSrm)
  writeFileSync(join(sourceRoot, 'eeprom', 'kof99nd.srm'), kawaksRleFill(0x01))
  const member = (name, bytes) => [name, bytes.length, crc32(bytes).toString(16).padStart(8, '0')]
  const rows = [
    {
      id: 'fixture:parent', source: 'fixture', coreArtifactId: 'fixture_core', setName: 'parent',
      title: 'Parent', platform: 'CPS1', relationKind: 'parent', relationEvidence: 'fixture',
      datParentSetName: null, archiveName: 'parent.zip', archiveLayout: 'standalone', runtimeParentSetName: null,
      biosSetNames: [], runtimeContractCoreId: 'fixture_core', contractSourceIds: ['fixture'],
      rawContentContractSha256: sha256(Buffer.from(`${parentBytes.length}:${member('p.bin', parentBytes)[2]}`)),
      runtimeContractFingerprint: sha256('parent-contract'), members: [member('p.bin', parentBytes)],
      sourceSetNames: ['parent'], thumbnail: { matchKind: 'direct-or-alias', sourceSetName: 'parent', evidence: 'exact canonical driver basename' },
    },
    {
      id: 'fixture:child', source: 'fixture', coreArtifactId: 'fixture_core', setName: 'child',
      title: 'Child', platform: 'CPS1', relationKind: 'clone', relationEvidence: 'fixture',
      datParentSetName: 'parent', archiveName: 'child.zip', archiveLayout: 'split', runtimeParentSetName: 'parent',
      biosSetNames: [], runtimeContractCoreId: 'fixture_core', contractSourceIds: ['fixture'],
      rawContentContractSha256: sha256(Buffer.from(`${parentBytes.length}:${member('p.bin', parentBytes)[2]};${childBytes.length}:${member('c.bin', childBytes)[2]}`)),
      runtimeContractFingerprint: sha256('child-contract'),
      members: [member('p.bin', parentBytes), member('renamed-parent.bin', parentBytes), member('c.bin', childBytes)],
      sourceSetNames: ['child'], thumbnail: { matchKind: 'parent', sourceSetName: 'parent', evidence: 'fixture parent' },
    },
    {
      id: 'fixture:alias', source: 'fixture', coreArtifactId: 'fixture_core', setName: 'bangbead',
      title: 'Alias', platform: 'NeoGeo', relationKind: 'clone', relationEvidence: 'fixture',
      datParentSetName: 'parent', archiveName: 'alias.zip', archiveLayout: 'standalone', runtimeParentSetName: null,
      biosSetNames: [], runtimeContractCoreId: 'fixture_core', contractSourceIds: ['fixture'],
      rawContentContractSha256: sha256(Buffer.from(`${parentBytes.length}:${member('p.bin', parentBytes)[2]}`)),
      runtimeContractFingerprint: sha256('alias-contract'), members: [member('p.bin', parentBytes)],
      sourceSetNames: ['alias'], thumbnail: { matchKind: 'direct-or-alias', sourceSetName: 'parent', evidence: 'legacy alias map' },
    },
    {
      id: 'fixture:reference', source: 'fixture', coreArtifactId: 'fixture_core', setName: 'mslug4',
      title: 'Reference', platform: 'NeoGeo', relationKind: 'bootleg', relationEvidence: 'fixture',
      datParentSetName: null, archiveName: 'ref.zip', archiveLayout: 'standalone', runtimeParentSetName: null,
      biosSetNames: [], runtimeContractCoreId: 'fixture_core', contractSourceIds: ['fixture'],
      rawContentContractSha256: sha256(Buffer.from(`${sharedBytes.length}:${member('s.bin', sharedBytes)[2]}`)),
      runtimeContractFingerprint: sha256('reference-contract'), members: [member('s.bin', sharedBytes)],
      sourceSetNames: ['ref'], thumbnail: { matchKind: 'source-reference', sourceSetName: 'parent', evidence: 'fixture source reference' },
    },
  ]
  const core = {
    id: 'fixture_core', coreName: 'fbneo', runtimeName: 'Fixture', runtimeVersion: '1',
    frontendVersion: '1', contractEnabled: true, runtimeValidationStatus: 'static-unverified',
    candidateRows: rows.length, artifacts: { js: { path: 'fixture.js', sha256: '0'.repeat(64), hashMode: 'raw' }, wasm: { path: 'fixture.wasm', sha256: '1'.repeat(64), hashMode: 'raw' } },
  }
  const mameCore = {
    id: 'fixture_mame_core', coreName: 'mame2003_plus', runtimeName: 'Fixture MAME', runtimeVersion: '1',
    frontendVersion: '1', contractEnabled: true, runtimeValidationStatus: 'static-unverified',
    candidateRows: 0, artifacts: { js: { path: 'fixture-mame.js', sha256: '2'.repeat(64), hashMode: 'raw' }, wasm: { path: 'fixture-mame.wasm', sha256: '3'.repeat(64), hashMode: 'raw' } },
  }
  const candidates = { schemaVersion: 1, contractKind: 'fixture', signed: false, rows }
  const sources = { schemaVersion: 1, contractKind: 'fixture', signed: false, invariants: { candidateRows: rows.length }, inputs: [] }
  for (const [name, value] of Object.entries({ 'candidates.json': candidates, 'cores.json': { schemaVersion: 1, contractKind: 'fixture', signed: false, cores: [core, mameCore] }, 'sources.json': sources, 'alias-folds.json': { schemaVersion: 1, contractKind: 'fixture', signed: false, rows: [] } })) {
    writeFileSync(join(contractsDir, name), `${JSON.stringify(value, null, 2)}\n`)
  }
  rewriteContractHashes(contractsDir)
  const coldSource = join(root, 'cold-source.7z')
  writeFileSync(coldSource, Buffer.from('cold-source-fixture'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, sourceRoot, contractsDir, outputDir, coldSource, rows }
}

function verifyArgs(f, manifestPath = join(f.outputDir, 'manifest.json')) {
  return [
    '--manifest', manifestPath,
    '--contracts-dir', f.contractsDir,
    '--batch-root', f.outputDir,
    '--cold-source', f.coldSource,
    '--source-root', f.sourceRoot,
  ]
}

test('prepare_batch defaults to deterministic dry-run with zero writes', (t) => {
  const f = fixture(t)
  const args = ['--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir]
  const first = run(PREPARE, args)
  const second = run(PREPARE, args)
  assert.equal(first.status, 0, first.output)
  assert.equal(second.status, 0, second.output)
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout))
  assert.equal(existsSync(f.outputDir), false)
})

test('production contract kind requires the frozen 656 candidate rows', (t) => {
  const f = fixture(t)
  const candidatePath = join(f.contractsDir, 'candidates.json')
  const sourcePath = join(f.contractsDir, 'sources.json')
  const candidates = JSON.parse(readFileSync(candidatePath, 'utf8'))
  const sources = JSON.parse(readFileSync(sourcePath, 'utf8'))
  candidates.contractKind = 'hash-pinned-non-rom-candidate-ledger'
  sources.contractKind = 'hash-pinned-authoritative-audit-inputs'
  sources.invariants = {
    candidateRows: 656,
    runtimeCoreScopedContracts: 655,
    globalRawPayloadIdentities: 654,
    relationTotals: { parent: 227, clone: 361, hack: 4, bootleg: 64 },
    thumbnailTotals: { 'direct-or-alias': 463, parent: 53, 'source-reference': 140 },
  }
  writeFileSync(candidatePath, `${JSON.stringify(candidates, null, 2)}\n`)
  writeFileSync(sourcePath, `${JSON.stringify(sources, null, 2)}\n`)
  rewriteContractHashes(f.contractsDir)

  const result = run(PREPARE, ['--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.notEqual(result.status, 0, result.output)
  assert.match(result.output, /production candidate ledger.*656/i)
})

test('SRM-only evidence does not require an unrelated MAME core contract', (t) => {
  const f = fixture(t)
  rmSync(join(f.sourceRoot, 'eeprom', 'dino.epm'))
  const coresPath = join(f.contractsDir, 'cores.json')
  const cores = JSON.parse(readFileSync(coresPath, 'utf8'))
  cores.cores = cores.cores.filter((core) => core.coreName !== 'mame2003_plus')
  writeFileSync(coresPath, `${JSON.stringify(cores, null, 2)}\n`)
  rewriteContractHashes(f.contractsDir)

  const result = run(PREPARE, ['--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(result.status, 0, result.output)
  assert.deepEqual(JSON.parse(result.stdout).manifest.summary.saveSampleFormats, { 'kawaks-srm-rle-v1': 3 })
})

test('dry-run previews the exact apply manifest and a repeated apply is a no-op', (t) => {
  const f = fixture(t)
  const args = ['--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir]
  const dryRun = run(PREPARE, args)
  assert.equal(dryRun.status, 0, dryRun.output)

  const firstApply = run(PREPARE, ['--apply', ...args])
  assert.equal(firstApply.status, 0, firstApply.output)
  assert.deepEqual(JSON.parse(firstApply.stdout).manifest, JSON.parse(dryRun.stdout).manifest)

  const manifestBytes = readFileSync(join(f.outputDir, 'manifest.json'))
  const secondApply = run(PREPARE, ['--apply', ...args])
  assert.equal(secondApply.status, 0, secondApply.output)
  assert.equal(JSON.parse(secondApply.stdout).noop, true)
  assert.deepEqual(readFileSync(join(f.outputDir, 'manifest.json')), manifestBytes)
})

test('apply emits deterministic split mounts, thumbnail evidence, and archived save samples', (t) => {
  const f = fixture(t)
  const result = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(result.status, 0, result.output)
  const manifest = JSON.parse(readFileSync(join(f.outputDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.candidateResolutions.length, 4)
  assert.equal(manifest.archives.find((row) => row.candidateId === 'fixture:child').mounts[0].role, 'parent')
  assert.equal(manifest.archives.find((row) => row.candidateId === 'fixture:child').mounts[1].role, 'primary')
  assert.deepEqual(
    manifest.archives.find((row) => row.candidateId === 'fixture:child').members.map((row) => row.name),
    ['c.bin', 'renamed-parent.bin'],
  )
  assert.equal(manifest.summary.thumbnailMatchKinds.exact, 1)
  assert.equal(manifest.summary.thumbnailMatchKinds.alias, 1)
  assert.equal(manifest.summary.thumbnailMatchKinds.parent, 1)
  assert.equal(manifest.summary.thumbnailMatchKinds.source_reference, 1)
  assert.equal(manifest.thumbnailSources.length, 4)
  assert.deepEqual(manifest.thumbnailSources.map((row) => row.basename), ['child', 'orphan', 'parent', 'rotd'])
  for (const source of manifest.thumbnailSources) {
    assert.equal(source.sourcePath.startsWith('sshots/'), true)
    assert.match(source.assetPath, /^thumbnails\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/)
    assert.match(source.sha256, /^[0-9a-f]{64}$/)
    assert.ok(source.fileSize > 0)
    const originalBytes = readFileSync(join(f.sourceRoot, source.sourcePath))
    assert.equal(source.sourceFileSha256, sha256(originalBytes))
    assert.equal(source.sourceFileSize, originalBytes.length)
    assert.equal(existsSync(join(f.outputDir, source.assetPath)), true)
    assert.equal(readFileSync(join(f.outputDir, source.assetPath)).subarray(12, 16).toString('ascii'), 'VP8 ')
  }
  assert.equal(manifest.thumbnailSources.find((row) => row.basename === 'parent').sourcePath, 'sshots/parent.bmp')
  assert.equal(manifest.summary.thumbnailUniqueObjects, 4)
  for (const thumbnail of manifest.thumbnails) {
    const source = manifest.thumbnailSources.find((row) => row.basename === thumbnail.sourceSetName)
    assert.ok(source)
    assert.equal(thumbnail.assetPath, source.assetPath)
    assert.equal(thumbnail.sha256, source.sha256)
    assert.equal(thumbnail.sourceFileSha256, source.sourceFileSha256)
  }
  assert.equal(manifest.saveSampleEvidence.length, 4)
  assert.equal('saveConversions' in manifest, false)
  const epm = manifest.saveSampleEvidence.find((row) => row.path.endsWith('/dino.epm'))
  assert.equal(epm.format, 'mame2003-plus-raw-eeprom-v1')
  assert.equal(epm.mappingState, 'exact')
  assert.equal(epm.runtimeVerified, false)
  assert.equal(epm.archivalOnly, true)
  assert.equal(epm.runtimeWriteAllowed, false)
  assert.equal(epm.decodedSha256, epm.sha256)
  assert.equal(epm.decodedSize, 128)
  assert.deepEqual(epm.candidateTarget, {
    coreArtifactId: 'fixture_mame_core',
    coreName: 'mame2003_plus',
    fileName: 'dino.nv',
    sha256: epm.sha256,
    fileSize: 128,
  })

  const bangbead = manifest.saveSampleEvidence.find((row) => row.path.endsWith('/bangbead.srm'))
  const mslug4 = manifest.saveSampleEvidence.find((row) => row.path.endsWith('/mslug4.srm'))
  for (const sample of [bangbead, mslug4]) {
    assert.equal(sample.format, 'kawaks-srm-rle-v1')
    assert.equal(sample.mappingState, 'exact')
    assert.equal(sample.decodedSize, 65_536)
    assert.equal(sample.runtimeVerified, false)
    assert.equal(sample.archivalOnly, true)
    assert.equal(sample.runtimeWriteAllowed, false)
    assert.equal(sample.independentRuntimeVerificationRequired, true)
    assert.equal(sample.candidateTarget.fileName, `${sample.shortname}.fs`)
    assert.equal(sample.candidateTarget.sha256, sample.decodedSha256)
    assert.equal(sample.candidateTarget.fileSize, 65_536)
  }
  assert.equal(bangbead.sha256, mslug4.sha256)
  assert.equal(bangbead.decodedSha256, mslug4.decodedSha256)
  assert.notEqual(bangbead.semanticSampleId, mslug4.semanticSampleId)

  const unmapped = manifest.saveSampleEvidence.find((row) => row.path.endsWith('/kof99nd.srm'))
  assert.equal(unmapped.mappingState, 'unmapped')
  assert.equal(unmapped.candidateTarget, null)
  assert.equal(unmapped.independentRuntimeVerificationRequired, false)
  assert.match(unmapped.reason, /exact.*driver/i)
  assert.equal(listFiles(f.outputDir).some((path) => /\.(?:fs|nv)$/i.test(path)), false)
  assert.equal(existsSync(join(f.outputDir, 'report.md')), true)
  assert.equal(
    manifest.auxiliaryEvidence.find((row) => row.path === 'roms/NeoGeo/neogeo.zip').category,
    'bios_archive',
  )
  const verify = run(VERIFY, verifyArgs(f))
  assert.equal(verify.status, 0, verify.output)
})

test('verify binds report and the complete extracted source tree', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)

  writeFileSync(join(f.outputDir, 'report.md'), '# detached report\n')
  let verify = run(VERIFY, verifyArgs(f))
  assert.notEqual(verify.status, 0)
  assert.match(verify.output, /report/i)

  const second = fixture(t)
  const preparedSecond = run(PREPARE, ['--apply', '--source-root', second.sourceRoot, '--cold-source', second.coldSource, '--contracts-dir', second.contractsDir, '--output-dir', second.outputDir])
  assert.equal(preparedSecond.status, 0, preparedSecond.output)
  writeFileSync(join(second.sourceRoot, 'cheats.dat'), Buffer.from('added after preparation'))
  verify = run(VERIFY, verifyArgs(second))
  assert.notEqual(verify.status, 0)
  assert.match(verify.output, /source inventory/i)
})

test('verify rejects missing, duplicate, detached, or forged save evidence', (t) => {
  const cases = [
    ['missing sample', (rows) => rows.pop()],
    ['duplicate sample', (rows) => rows.push({ ...rows[0] })],
    ['detached source digest', (rows) => { rows[0].sha256 = 'a'.repeat(64) }],
    ['wrong decoded digest', (rows) => { rows.find((row) => row.path.endsWith('/bangbead.srm')).decodedSha256 = 'b'.repeat(64) }],
    ['wrong exact mapping', (rows) => {
      const row = rows.find((sample) => sample.path.endsWith('/bangbead.srm'))
      row.candidateTarget = { coreArtifactId: 'fixture_core', coreName: 'fbneo', fileName: 'guessed.fs', sha256: row.decodedSha256, fileSize: row.decodedSize }
    }],
    ['forged unmapped candidate', (rows) => {
      const row = rows.find((sample) => sample.path.endsWith('/kof99nd.srm'))
      row.mappingState = 'exact'
      row.candidateTarget = { coreArtifactId: 'fixture_core', coreName: 'fbneo', fileName: 'kof99nd.fs', sha256: row.decodedSha256, fileSize: row.decodedSize }
    }],
  ]

  for (const [label, mutate] of cases) {
    const f = fixture(t)
    const prepared = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
    assert.equal(prepared.status, 0, `${label}: ${prepared.output}`)
    const manifestPath = join(f.outputDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    mutate(manifest.saveSampleEvidence)
    writeManifest(manifestPath, manifest)

    const verify = run(VERIFY, verifyArgs(f))
    assert.notEqual(verify.status, 0, label)
    assert.match(verify.output, /save sample evidence/i, label)
  }
})

test('verify rejects fs and nv files anywhere in batch output', (t) => {
  for (const [extension, core, shortname] of [['fs', 'fbneo', 'bangbead'], ['nv', 'mame2003_plus', 'dino']]) {
    const f = fixture(t)
    const prepared = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
    assert.equal(prepared.status, 0, prepared.output)
    const forbidden = join(f.outputDir, 'auxiliary', 'nvram-candidates', core, `${shortname}.${extension}`)
    mkdirSync(dirname(forbidden), { recursive: true })
    if (!existsSync(forbidden)) writeFileSync(forbidden, Buffer.from('must never be a runtime artifact'))

    const verify = run(VERIFY, verifyArgs(f))
    assert.notEqual(verify.status, 0)
    assert.match(verify.output, /runtime NVRAM file is forbidden/i)
  }
})

test('prepare strictly validates raw EPM and Kawaks RLE container boundaries', (t) => {
  const cases = [
    ['raw EEPROM', 'dino.epm', Buffer.alloc(127), /exactly 128 bytes/i],
    ['declared payload', 'bangbead.srm', Buffer.concat([u32(2), Buffer.from([0])]), /payload length mismatch/i],
    ['repeat boundary', 'bangbead.srm', Buffer.concat([u32(1), Buffer.from([0xc1])]), /repeat opcode lacks a value/i],
    ['decoded length', 'bangbead.srm', Buffer.concat([u32(1), Buffer.from([0])]), /instead of 65,536/i],
  ]

  for (const [label, name, bytes, expected] of cases) {
    const f = fixture(t)
    writeFileSync(join(f.sourceRoot, 'eeprom', name), bytes)
    const prepared = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
    assert.notEqual(prepared.status, 0, label)
    assert.match(prepared.output, expected, label)
    assert.equal(existsSync(f.outputDir), false, label)
  }
})

test('prepare rejects traversal members before writing any batch output', (t) => {
  const f = fixture(t)
  writeZip(join(f.sourceRoot, 'roms', 'Cps1', 'evil.zip'), [['../escape.bin', Buffer.from('escape')]])
  const result = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.notEqual(result.status, 0)
  assert.match(result.output, /traversal|path|member/i)
  assert.equal(existsSync(f.outputDir), false)
})

test('verify checks thumbnail source objects that no candidate references', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const orphan = manifest.thumbnailSources.find((row) => row.basename === 'orphan')
  writeFileSync(join(f.outputDir, orphan.assetPath), Buffer.from('tampered-thumbnail'))

  const verify = run(VERIFY, verifyArgs(f, manifestPath))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /thumbnail source content mismatch.*orphan/i)
})

test('verify binds original thumbnail hashes to the cold extraction evidence', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.thumbnailSources.find((row) => row.basename === 'orphan').sourceFileSha256 = 'c'.repeat(64)
  writeManifest(manifestPath, manifest)

  const verify = run(VERIFY, verifyArgs(f, manifestPath))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /thumbnail source evidence mismatch.*orphan/i)
})

test('verify rejects a self-rehashed manifest detached from the frozen contract hashes', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.contracts.candidatesSha256 = 'd'.repeat(64)
  writeManifest(manifestPath, manifest)

  const verify = run(VERIFY, verifyArgs(f, manifestPath))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /contract hash binding mismatch/i)
})

test('verify rejects self-rehashed candidate metadata that differs from the frozen ledger', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.archives.find((row) => row.candidateId === 'fixture:parent').title = 'Detached title'
  writeManifest(manifestPath, manifest)

  const verify = run(VERIFY, verifyArgs(f, manifestPath))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /candidate contract mismatch.*fixture:parent.*title/i)
})

test('verify rejects case-insensitive duplicate thumbnail source basenames', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const orphan = manifest.thumbnailSources.find((row) => row.basename === 'orphan')
  manifest.thumbnailSources.push({ ...orphan, basename: 'ORPHAN' })
  manifest.summary.thumbnailSourceBasenames = manifest.thumbnailSources.length
  writeManifest(manifestPath, manifest)

  const verify = run(VERIFY, verifyArgs(f, manifestPath))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /duplicate thumbnail source basename/i)
})

test('verify requires candidate thumbnails to reuse their source object', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const orphan = manifest.thumbnailSources.find((row) => row.basename === 'orphan')
  const parent = manifest.thumbnails.find((row) => row.candidateId === 'fixture:parent')
  Object.assign(parent, {
    sourcePath: orphan.sourcePath,
    assetPath: orphan.assetPath,
    sha256: orphan.sha256,
    fileSize: orphan.fileSize,
  })
  writeManifest(manifestPath, manifest)

  const verify = run(VERIFY, verifyArgs(f, manifestPath))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /thumbnail source object mismatch.*fixture:parent/i)
})

test('verify binds normalized archive members to their recorded source ZIP members', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.archives.find((row) => row.candidateId === 'fixture:parent').members[0].sourcePath = 'roms/Cps1/parent.zip!missing.bin'
  writeManifest(manifestPath, manifest)

  const verify = run(VERIFY, verifyArgs(f))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /source member evidence/i)
})

test('verify rejects duplicate candidate rows even when every frozen ID remains present', (t) => {
  const f = fixture(t)
  const prepare = run(PREPARE, ['--apply', '--source-root', f.sourceRoot, '--cold-source', f.coldSource, '--contracts-dir', f.contractsDir, '--output-dir', f.outputDir])
  assert.equal(prepare.status, 0, prepare.output)
  const manifestPath = join(f.outputDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.archives.push({ ...manifest.archives[0] })
  writeManifest(manifestPath, manifest)

  const verify = run(VERIFY, verifyArgs(f, manifestPath))
  assert.notEqual(verify.status, 0, verify.output)
  assert.match(verify.output, /archive candidate ledger contains duplicate IDs/i)
})

test('checked-in production contract ledger keeps the frozen 656/655/654 identity counts', () => {
  const contracts = JSON.parse(readFileSync(join(PROJECT_ROOT, 'tools', 'arcade-import', 'contracts', 'candidates.json'), 'utf8'))
  const raw = new Set(contracts.rows.map((row) => row.rawContentContractSha256))
  const runtime = new Set(contracts.rows.map((row) => row.runtimeContractFingerprint))
  assert.equal(contracts.rows.length, 656)
  assert.equal(runtime.size, 655)
  assert.equal(raw.size, 654)
})
