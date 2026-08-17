#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  readSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

import Database from 'better-sqlite3'

import { computeBuildFingerprint } from '../../server/services/build-contract.js'
import {
  canonicalizeContentBytes,
  createContentStore,
} from '../../server/services/content-store.js'
import {
  canonicalizeLibraryJson,
  computeCoreArtifactFingerprint,
  ensureAssetRecord,
  hashCanonicalLibraryJson,
} from '../../server/services/library-service.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SET_PATTERN = /^[a-z0-9_]+$/
const CONTRACT_FILES = ['alias-folds.json', 'candidates.json', 'cores.json', 'sources.json']
const RESOLUTION_STATES = new Set(['ready', 'blocked', 'unsupported', 'unverified'])
const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP_MAX_COMMENT_BYTES = 0xffff
const ZIP_UTF8_FLAG = 0x0800
const ZIP_UNIX_PLATFORM = 3
const ZIP_REGULAR_FILE_MODE = 0o100000
const ZIP_FILE_TYPE_MASK = 0o170000
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return value >>> 0
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

function sha256File(path) {
  const descriptor = openSync(path, 'r')
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let size = 0
  try {
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null)
      if (read === 0) break
      digest.update(buffer.subarray(0, read))
      size += read
    }
    if (fstatSync(descriptor).size !== size) throw new Error(`content object changed while hashing: ${path}`)
  } finally {
    closeSync(descriptor)
  }
  return { sha256: digest.digest('hex'), fileSize: size }
}

function readManifest(manifestPath) {
  const absolute = resolve(manifestPath)
  const manifest = JSON.parse(readFileSync(absolute, 'utf8'))
  if (manifest?.kind !== 'w165-import-batch-v1' || manifest?.schemaVersion !== 1) {
    throw new Error('unsupported arcade import manifest')
  }
  if (!SHA256_PATTERN.test(String(manifest.manifestSha256 || '').toLowerCase())) {
    throw new Error('manifestSha256 must be a 64-character SHA-256')
  }
  const body = { ...manifest }
  delete body.manifestSha256
  const actual = hashCanonicalLibraryJson(body)
  if (actual !== manifest.manifestSha256.toLowerCase()) {
    throw new Error(`manifest hash mismatch: expected ${manifest.manifestSha256}, got ${actual}`)
  }
  return { manifest, manifestPath: absolute }
}

function readContractLedger(contractsDir) {
  if (typeof contractsDir !== 'string' || contractsDir.trim() === '') {
    throw new TypeError('contractsDir is required')
  }
  const root = resolve(contractsDir)
  const sumsBytes = readFileSync(resolve(root, 'SHA256SUMS.txt'))
  const expected = new Map()
  for (const rawLine of sumsBytes.toString('utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^([0-9a-fA-F]{64})\s+([^\s]+)$/.exec(line)
    if (!match) throw new Error('SHA256SUMS.txt contains a malformed line')
    if (expected.has(match[2])) throw new Error(`SHA256SUMS.txt repeats ${match[2]}`)
    expected.set(match[2], match[1].toLowerCase())
  }
  if (expected.size !== CONTRACT_FILES.length || CONTRACT_FILES.some((name) => !expected.has(name))) {
    throw new Error('SHA256SUMS.txt must cover exactly the four contract JSON files')
  }
  const documents = new Map()
  for (const name of CONTRACT_FILES) {
    const bytes = readFileSync(resolve(root, name))
    const actual = sha256(bytes)
    if (actual !== expected.get(name)) {
      throw new Error(`contract hash mismatch for ${name}: expected ${expected.get(name)}, got ${actual}`)
    }
    documents.set(name, JSON.parse(bytes.toString('utf8')))
  }
  return {
    root,
    expected,
    sumsSha256: sha256(sumsBytes),
    candidates: documents.get('candidates.json'),
    cores: documents.get('cores.json'),
  }
}

function thumbnailMatchKind(contract) {
  const thumbnail = contract?.thumbnail ?? {}
  if (thumbnail.matchKind === 'parent') return 'parent'
  if (thumbnail.matchKind === 'source-reference') return 'source_reference'
  return String(thumbnail.evidence || '').toLowerCase().includes('alias') ? 'alias' : 'exact'
}

function expectedOutputMembers(contract, contractsByCoreSet) {
  if (contract.archiveLayout !== 'split') return contract.members ?? []
  const parent = contractsByCoreSet.get(`${contract.coreArtifactId}\0${contract.runtimeParentSetName}`)
  if (!parent) throw new Error(`split candidate contract lacks its parent: ${contract.id}`)
  const parentMembers = new Set((parent.members ?? []).map(([name, size, crc]) => `${name}\0${size}\0${String(crc).toLowerCase().padStart(8, '0')}`))
  return (contract.members ?? []).filter(([name, size, crc]) => !parentMembers.has(`${name}\0${size}\0${String(crc).toLowerCase().padStart(8, '0')}`))
}

function assertManifestContractBinding(manifest, ledger) {
  const expectedBinding = {
    sha256sumsSha256: ledger.sumsSha256,
    ...Object.fromEntries([...ledger.expected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, digest]) => [`${name.slice(0, -'.json'.length)}Sha256`, digest])),
  }
  if (canonicalizeLibraryJson(manifest.contracts) !== canonicalizeLibraryJson(expectedBinding)) {
    throw new Error('contract hash binding mismatch')
  }
  const expectedCores = [...(ledger.cores?.cores ?? [])].sort((left, right) => String(left.id).localeCompare(String(right.id)))
  if (canonicalizeLibraryJson(manifest.cores) !== canonicalizeLibraryJson(expectedCores)) {
    throw new Error('core contract ledger mismatch')
  }

  const contracts = ledger.candidates?.rows ?? []
  const contractIds = contracts.map((row) => String(row.id))
  if (new Set(contractIds).size !== contractIds.length) throw new Error('frozen candidate contract contains duplicate IDs')
  const contractById = new Map(contracts.map((row) => [String(row.id), row]))
  const uniqueCandidateMap = (rows, label) => {
    if (!Array.isArray(rows)) throw new Error(`${label} candidate ledger must be an array`)
    const ids = rows.map((row) => String(row.candidateId))
    if (new Set(ids).size !== ids.length) throw new Error(`${label} candidate ledger contains duplicate IDs`)
    return new Map(rows.map((row) => [String(row.candidateId), row]))
  }
  const archiveById = uniqueCandidateMap(manifest.archives, 'archive')
  const resolutionById = uniqueCandidateMap(manifest.candidateResolutions, 'resolution')
  const thumbnailById = uniqueCandidateMap(manifest.thumbnails, 'thumbnail')
  const contractsByCoreSet = new Map(contracts.map((row) => [`${row.coreArtifactId}\0${row.setName}`, row]))
  for (const [label, map] of [['archive', archiveById], ['resolution', resolutionById], ['thumbnail', thumbnailById]]) {
    if (map.size !== contractById.size || [...map.keys()].some((id) => !contractById.has(id))) {
      throw new Error(`${label} candidate contract coverage mismatch`)
    }
  }

  for (const [candidateId, contract] of contractById) {
    const resolution = resolutionById.get(candidateId)
    if (!RESOLUTION_STATES.has(resolution.state)) {
      throw new Error(`candidate ${candidateId} has invalid resolution state`)
    }
    for (const field of ['runtimeContractFingerprint', 'rawContentContractSha256']) {
      if (resolution[field] !== contract[field]) {
        throw new Error(`candidate contract mismatch for ${candidateId} at ${field}`)
      }
    }
    const archive = archiveById.get(candidateId)
    const expectedArchive = {
      coreArtifactId: contract.coreArtifactId,
      setName: contract.setName,
      title: contract.title,
      platform: String(contract.platform || 'arcade').toLowerCase(),
      relationKind: contract.relationKind,
      datParentSetName: contract.datParentSetName ?? null,
      familyRootSetName: contract.runtimeParentSetName || contract.datParentSetName || contract.setName,
      archiveLayout: contract.archiveLayout,
      archivePath: `archives/${contract.coreArtifactId}/${contract.setName}.zip`,
    }
    for (const [field, expected] of Object.entries(expectedArchive)) {
      if ((archive[field] ?? null) !== expected) {
        throw new Error(`candidate contract mismatch for ${candidateId} at ${field}`)
      }
    }
    if (!['blocked', 'unsupported'].includes(resolution.state)) {
      const expectedMembers = expectedOutputMembers(contract, contractsByCoreSet)
        .map(([name, size, crc]) => [String(name), Number(size), String(crc).toLowerCase().padStart(8, '0')])
        .sort(([left], [right]) => left.localeCompare(right))
      const actualMembers = archive.members.map((member) => [String(member.name), Number(member.size), String(member.crc32).toLowerCase().padStart(8, '0')])
      if (canonicalizeLibraryJson(actualMembers) !== canonicalizeLibraryJson(expectedMembers)) {
        throw new Error(`candidate contract mismatch for ${candidateId} at members`)
      }
    }
    const thumbnail = thumbnailById.get(candidateId)
    const expectedSourceSet = String(contract.thumbnail?.sourceSetName || contract.setName || '').toLowerCase()
    if (thumbnail.sourceSetName !== expectedSourceSet || thumbnail.matchKind !== thumbnailMatchKind(contract)) {
      throw new Error(`candidate contract mismatch for ${candidateId} at thumbnail`)
    }
  }
}

function resolveContained(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) {
    throw new Error('manifest asset path must be a non-empty POSIX relative path')
  }
  if (isAbsolute(relativePath) || /^[a-zA-Z]:\//.test(relativePath)) {
    throw new Error('manifest asset path must be relative')
  }
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`manifest asset path contains traversal: ${relativePath}`)
  }
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, ...parts)
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`manifest asset path escapes batch root: ${relativePath}`)
  }
  return target
}

function assertContainedRegularFile(root, relativePath, label) {
  const absoluteRoot = resolve(root)
  const target = resolveContained(absoluteRoot, relativePath)
  const rootEntry = lstatSync(absoluteRoot)
  const targetEntry = lstatSync(target)
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`${label} root must be a regular directory`)
  }
  if (targetEntry.isSymbolicLink() || !targetEntry.isFile()) {
    throw new Error(`${label} must be a regular non-symbolic file: ${relativePath}`)
  }
  const realRoot = realpathSync.native(absoluteRoot)
  const realTarget = realpathSync.native(target)
  const pathFromRoot = relative(realRoot, realTarget)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} escapes its root: ${relativePath}`)
  }
  return target
}

function requireZipRange(bytes, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset > bytes.length - length) {
    throw new Error(`malformed ZIP ${label}`)
  }
}

function zipU16(bytes, offset, label) {
  requireZipRange(bytes, offset, 2, label)
  return bytes.readUInt16LE(offset)
}

function zipU32(bytes, offset, label) {
  requireZipRange(bytes, offset, 4, label)
  return bytes.readUInt32LE(offset)
}

function normalizeCrc32(value, label) {
  const normalized = String(value ?? '').toLowerCase()
  if (!/^[0-9a-f]{1,8}$/.test(normalized)) {
    throw new Error(`${label} must be a hexadecimal CRC-32`)
  }
  return normalized.padStart(8, '0')
}

function safeZipMemberName(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty safe ZIP member name`)
  }
  if (value.startsWith('/') || /^[a-zA-Z]:\//.test(value)) {
    throw new Error(`${label} contains ZIP member traversal`)
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} contains ZIP member traversal`)
  }
  return value
}

function assertSourceMemberReference(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} source member provenance is missing`)
  const separator = value.indexOf('!')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${label} source member provenance must use archive.zip!member syntax`)
  }
  const archivePath = value.slice(0, separator)
  const memberName = value.slice(separator + 1)
  resolveContained(resolve('.'), archivePath)
  if (!archivePath.toLowerCase().endsWith('.zip')) {
    throw new Error(`${label} source member provenance must reference a ZIP archive`)
  }
  safeZipMemberName(memberName, `${label} source member`)
}

function decodeZipMemberName(bytes, label) {
  let name
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} has an invalid UTF-8 member name`)
  }
  return safeZipMemberName(name, label)
}

function findZipEndOfCentralDirectory(bytes, archivePath) {
  const minimum = 22
  const firstOffset = Math.max(0, bytes.length - minimum - ZIP_MAX_COMMENT_BYTES)
  for (let offset = bytes.length - minimum; offset >= firstOffset; offset -= 1) {
    if (zipU32(bytes, offset, `end of central directory for ${archivePath}`) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue
    const commentLength = zipU16(bytes, offset + 20, `end of central directory for ${archivePath}`)
    if (offset + minimum + commentLength === bytes.length) return offset
  }
  throw new Error(`prepared archive is not a valid ZIP file: ${archivePath}`)
}

function parsePreparedZip(bytes, archivePath) {
  const eocdOffset = findZipEndOfCentralDirectory(bytes, archivePath)
  const diskNumber = zipU16(bytes, eocdOffset + 4, `end of central directory for ${archivePath}`)
  const centralDiskNumber = zipU16(bytes, eocdOffset + 6, `end of central directory for ${archivePath}`)
  const diskEntries = zipU16(bytes, eocdOffset + 8, `end of central directory for ${archivePath}`)
  const totalEntries = zipU16(bytes, eocdOffset + 10, `end of central directory for ${archivePath}`)
  const centralSize = zipU32(bytes, eocdOffset + 12, `end of central directory for ${archivePath}`)
  const centralOffset = zipU32(bytes, eocdOffset + 16, `end of central directory for ${archivePath}`)
  const commentLength = zipU16(bytes, eocdOffset + 20, `end of central directory for ${archivePath}`)
  if (commentLength !== 0) throw new Error(`prepared archive has a ZIP comment: ${archivePath}`)
  if (diskNumber !== 0 || centralDiskNumber !== 0 || diskEntries !== totalEntries) {
    throw new Error(`prepared archive uses unsupported multi-disk ZIP layout: ${archivePath}`)
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error(`prepared archive uses unsupported ZIP64 layout: ${archivePath}`)
  }
  requireZipRange(bytes, centralOffset, centralSize, `central directory for ${archivePath}`)
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error(`prepared archive has an invalid central directory boundary: ${archivePath}`)
  }

  const entries = []
  const names = new Set()
  let offset = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    requireZipRange(bytes, offset, 46, `central directory entry ${index} for ${archivePath}`)
    if (zipU32(bytes, offset, `central directory entry ${index} for ${archivePath}`) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`prepared archive has an invalid central directory entry: ${archivePath}`)
    }
    const madeBy = zipU16(bytes, offset + 4, `central directory entry ${index} for ${archivePath}`)
    const flags = zipU16(bytes, offset + 8, `central directory entry ${index} for ${archivePath}`)
    const compressionMethod = zipU16(bytes, offset + 10, `central directory entry ${index} for ${archivePath}`)
    const modifiedTime = zipU16(bytes, offset + 12, `central directory entry ${index} for ${archivePath}`)
    const modifiedDate = zipU16(bytes, offset + 14, `central directory entry ${index} for ${archivePath}`)
    const crc = zipU32(bytes, offset + 16, `central directory entry ${index} for ${archivePath}`)
    const compressedSize = zipU32(bytes, offset + 20, `central directory entry ${index} for ${archivePath}`)
    const uncompressedSize = zipU32(bytes, offset + 24, `central directory entry ${index} for ${archivePath}`)
    const nameLength = zipU16(bytes, offset + 28, `central directory entry ${index} for ${archivePath}`)
    const extraLength = zipU16(bytes, offset + 30, `central directory entry ${index} for ${archivePath}`)
    const entryCommentLength = zipU16(bytes, offset + 32, `central directory entry ${index} for ${archivePath}`)
    const diskStart = zipU16(bytes, offset + 34, `central directory entry ${index} for ${archivePath}`)
    const externalAttributes = zipU32(bytes, offset + 38, `central directory entry ${index} for ${archivePath}`)
    const localOffset = zipU32(bytes, offset + 42, `central directory entry ${index} for ${archivePath}`)
    const recordSize = 46 + nameLength + extraLength + entryCommentLength
    requireZipRange(bytes, offset, recordSize, `central directory entry ${index} for ${archivePath}`)
    const name = decodeZipMemberName(bytes.subarray(offset + 46, offset + 46 + nameLength), `ZIP member ${index} in ${archivePath}`)
    if (names.has(name)) throw new Error(`prepared archive has duplicate ZIP member ${name}: ${archivePath}`)
    names.add(name)
    if (madeBy >>> 8 !== ZIP_UNIX_PLATFORM || (externalAttributes >>> 16 & ZIP_FILE_TYPE_MASK) !== ZIP_REGULAR_FILE_MODE) {
      throw new Error(`prepared archive member is not a regular Unix file: ${archivePath}!${name}`)
    }
    if ((flags & ~ZIP_UTF8_FLAG) !== 0 || flags & 0x0001 || flags & 0x0008 || compressionMethod !== 0 && compressionMethod !== 8
      || modifiedTime !== 0 || modifiedDate !== 33 || extraLength !== 0 || entryCommentLength !== 0 || diskStart !== 0) {
      throw new Error(`prepared archive member uses an unsupported ZIP layout: ${archivePath}!${name}`)
    }
    entries.push({
      name,
      flags,
      compressionMethod,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    })
    offset += recordSize
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error(`prepared archive has trailing central directory bytes: ${archivePath}`)
  }

  let expectedLocalOffset = 0
  for (const entry of entries) {
    const label = `${archivePath}!${entry.name}`
    if (entry.localOffset !== expectedLocalOffset) {
      throw new Error(`prepared archive has a non-canonical local member layout: ${label}`)
    }
    requireZipRange(bytes, entry.localOffset, 30, `local ZIP header for ${label}`)
    if (zipU32(bytes, entry.localOffset, `local ZIP header for ${label}`) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error(`prepared archive has an invalid local ZIP header: ${label}`)
    }
    const localFlags = zipU16(bytes, entry.localOffset + 6, `local ZIP header for ${label}`)
    const localMethod = zipU16(bytes, entry.localOffset + 8, `local ZIP header for ${label}`)
    const localTime = zipU16(bytes, entry.localOffset + 10, `local ZIP header for ${label}`)
    const localDate = zipU16(bytes, entry.localOffset + 12, `local ZIP header for ${label}`)
    const localCrc = zipU32(bytes, entry.localOffset + 14, `local ZIP header for ${label}`)
    const localCompressedSize = zipU32(bytes, entry.localOffset + 18, `local ZIP header for ${label}`)
    const localUncompressedSize = zipU32(bytes, entry.localOffset + 22, `local ZIP header for ${label}`)
    const localNameLength = zipU16(bytes, entry.localOffset + 26, `local ZIP header for ${label}`)
    const localExtraLength = zipU16(bytes, entry.localOffset + 28, `local ZIP header for ${label}`)
    const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength
    requireZipRange(bytes, entry.localOffset, 30 + localNameLength + localExtraLength + entry.compressedSize, `local ZIP member for ${label}`)
    const localName = decodeZipMemberName(
      bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength),
      `local ZIP member in ${archivePath}`,
    )
    if (localName !== entry.name || localFlags !== entry.flags || localMethod !== entry.compressionMethod
      || localTime !== 0 || localDate !== 33 || localCrc !== entry.crc
      || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize
      || localExtraLength !== 0) {
      throw new Error(`prepared archive local ZIP member does not match its directory entry: ${label}`)
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize)
    let data
    try {
      data = entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 })
    } catch (error) {
      throw new Error(`prepared archive member cannot be decompressed: ${label}`, { cause: error })
    }
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc) {
      throw new Error(`prepared archive member CRC or size mismatch: ${label}`)
    }
    entry.sha256 = sha256(data)
    expectedLocalOffset = dataOffset + entry.compressedSize
  }
  if (expectedLocalOffset !== centralOffset) {
    throw new Error(`prepared archive has trailing local member bytes: ${archivePath}`)
  }
  return entries
}

function assertPreparedArchive(batchRoot, archive) {
  const candidateId = String(archive?.candidateId ?? '')
  const archivePath = String(archive?.archivePath ?? '')
  const sourcePath = assertContainedRegularFile(batchRoot, archivePath, `prepared archive for ${candidateId}`)
  if (!SHA256_PATTERN.test(String(archive?.archiveSha256 ?? '').toLowerCase())
    || !Number.isSafeInteger(Number(archive?.archiveSize)) || Number(archive.archiveSize) < 0) {
    throw new Error(`prepared archive has an invalid content contract: ${candidateId}`)
  }
  const bytes = readFileSync(sourcePath)
  if (bytes.length !== Number(archive.archiveSize) || sha256(bytes) !== String(archive.archiveSha256).toLowerCase()) {
    throw new Error(`prepared archive content mismatch: ${candidateId}`)
  }
  const actualMembers = parsePreparedZip(bytes, archivePath)
  if (!Array.isArray(archive.members) || actualMembers.length !== archive.members.length) {
    throw new Error(`prepared archive member count mismatch: ${candidateId}`)
  }
  const expectedNames = new Set()
  for (let index = 0; index < archive.members.length; index += 1) {
    const expected = archive.members[index]
    const expectedName = safeZipMemberName(expected?.name, `manifest member ${index} for ${candidateId}`)
    if (expectedNames.has(expectedName)) {
      throw new Error(`prepared archive manifest has duplicate ZIP member ${expectedName}: ${candidateId}`)
    }
    expectedNames.add(expectedName)
    if (!Number.isSafeInteger(Number(expected?.size)) || Number(expected.size) < 0
      || !SHA256_PATTERN.test(String(expected?.sha256 ?? '').toLowerCase())) {
      throw new Error(`prepared archive manifest has an invalid member contract: ${candidateId}`)
    }
    assertSourceMemberReference(expected.sourcePath, `manifest member ${index} for ${candidateId}`)
    const expectedCrc = normalizeCrc32(expected.crc32, `manifest member CRC for ${candidateId}`)
    const actual = actualMembers[index]
    if (actual.name !== expectedName || actual.uncompressedSize !== Number(expected.size)
      || actual.crc.toString(16).padStart(8, '0') !== expectedCrc
      || actual.sha256 !== String(expected.sha256).toLowerCase()) {
      throw new Error(`prepared archive member content mismatch: ${candidateId}!${expectedName}`)
    }
  }
}

function assertPreparedArchives(manifest, batchRoot) {
  const resolutions = new Map(manifest.candidateResolutions.map((row) => [String(row.candidateId), row]))
  for (const archive of manifest.archives) {
    if (['blocked', 'unsupported'].includes(resolutions.get(String(archive.candidateId))?.state)) continue
    assertPreparedArchive(batchRoot, archive)
  }
}

function tableNames(sqlite) {
  return new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name))
}

function assertContractedDatabase(sqlite) {
  const required = [
    'assets', 'batch_build_refs', 'build_source_members', 'core_artifacts',
    'import_batches', 'import_operations', 'rom_asset_refs', 'rom_builds', 'roms',
  ]
  const names = tableNames(sqlite)
  const missing = required.filter((name) => !names.has(name))
  if (missing.length) throw new Error(`database lacks contracted import tables: ${missing.join(', ')}`)
  const phase = sqlite.prepare('SELECT phase FROM library_migration_state WHERE id = 1').get()?.phase
  if (phase !== 'contracted') throw new Error(`arcade import requires contracted migration state, got ${phase ?? 'missing'}`)
}

function fullRow(sqlite, table, predicate, parameters) {
  return sqlite.prepare(`SELECT * FROM ${table} WHERE ${predicate}`).get(...parameters) ?? null
}

function writeOperation(sqlite, state, {
  operationKind,
  entityType,
  entityKey,
  before = null,
  after = null,
}) {
  state.sequence += 1
  sqlite.prepare(`
    INSERT INTO import_operations
      (import_batch_id, sequence, operation_kind, entity_type,
       entity_key, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.batchId,
    state.sequence,
    operationKind,
    entityType,
    String(entityKey),
    before === null ? null : canonicalizeLibraryJson(before),
    after === null ? null : canonicalizeLibraryJson(after),
  )
}

function coreContractPlan(core, repoRoot) {
  const js = core?.artifacts?.js
  const wasm = core?.artifacts?.wasm
  if (!js || !wasm || !SHA256_PATTERN.test(String(js.sha256)) || !SHA256_PATTERN.test(String(wasm.sha256))) {
    throw new Error(`core ${core?.id} must pin JS and WASM SHA-256 contracts`)
  }
  const coreName = String(core.coreName || '')
  const displayVersion = String(core.runtimeVersion || core.displayVersion || '')
  const sourceCommit = String(core.source?.commit || core.sourceCommit || '')
  const datSha256 = core.contract?.sha256 ? String(core.contract.sha256).toLowerCase() : null
  if (!coreName || !displayVersion || !sourceCommit || (datSha256 !== null && !SHA256_PATTERN.test(datSha256))) {
    throw new Error(`core ${core.id} has an incomplete artifact identity contract`)
  }
  const artifactFingerprint = computeCoreArtifactFingerprint({
    coreName,
    displayVersion,
    sourceCommit,
    jsSha256: String(js.sha256).toLowerCase(),
    wasmSha256: String(wasm.sha256).toLowerCase(),
    datSha256,
    biosManifestSha256: core.biosManifestSha256 ?? null,
  })
  if (core.artifactFingerprint && String(core.artifactFingerprint).toLowerCase() !== artifactFingerprint) {
    throw new Error(`core ${core.id} artifact fingerprint does not match its pinned identity`)
  }
  const plan = {
    id: String(core.id),
    contract: core,
    coreName,
    displayVersion,
    sourceCommit,
    artifactFingerprint,
    datSha256,
    enabled: core.contractEnabled === true,
    artifactContracts: [],
    assets: [],
  }
  for (const [kind, mimeType, contract] of [
    ['core_js', 'text/javascript', js],
    ['core_wasm', 'application/wasm', wasm],
  ]) {
    const contractPath = String(contract.path || '')
    resolveContained(resolve('.'), contractPath)
    const artifactContract = {
      kind,
      mimeType,
      sha256: String(contract.sha256).toLowerCase(),
      contractPath,
      hashMode: contract.hashMode,
    }
    plan.artifactContracts.push(artifactContract)
    if (repoRoot === undefined || repoRoot === null) continue
    const root = resolve(repoRoot)
    const sourcePath = resolveContained(root, contract.path)
    const rawBytes = readFileSync(sourcePath)
    const rawSha256 = sha256(rawBytes)
    const canonicalBytes = canonicalizeContentBytes(rawBytes, contract.hashMode)
    const canonicalSha256 = sha256(canonicalBytes)
    if (canonicalSha256 !== String(contract.sha256).toLowerCase()) {
      throw new Error(`core ${core.id} ${kind} SHA-256 mismatch`)
    }
    plan.assets.push({
      ...artifactContract,
      sha256: canonicalSha256, fileSize: canonicalBytes.length,
      sourcePath, expectedRawSha256: rawSha256, expectedRawSize: rawBytes.length,
      expectedSha256: canonicalSha256, expectedSize: canonicalBytes.length,
    })
  }
  return plan
}

function assertExistingCoreAsset(sqlite, plan, row, artifact, store) {
  const shortKind = artifact.kind === 'core_js' ? 'js' : 'wasm'
  const label = shortKind.toUpperCase()
  const assetId = Number(row[`${shortKind}_asset_id`])
  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    throw new Error(`core ${plan.id} ${label} asset reference is missing`)
  }
  const asset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)
  if (!asset) throw new Error(`core ${plan.id} ${label} asset record is missing`)
  const expectedPath = `sha256/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`
  if (asset.kind !== artifact.kind || asset.mime_type !== artifact.mimeType
    || String(asset.sha256).toLowerCase() !== artifact.sha256 || asset.file_path !== expectedPath
    || !Number.isSafeInteger(Number(asset.file_size)) || Number(asset.file_size) < 0) {
    throw new Error(`core ${plan.id} ${label} asset metadata does not match its artifact contract`)
  }
  let sourcePath
  try {
    sourcePath = store.resolveStoredPath(asset.file_path)
    const entry = lstatSync(sourcePath)
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('content object is not a regular file')
    const actual = sha256File(sourcePath)
    if (actual.sha256 !== artifact.sha256 || actual.fileSize !== Number(asset.file_size)) {
      throw new Error('content object SHA-256 or size mismatch')
    }
  } catch (error) {
    throw new Error(`core ${plan.id} ${label} asset content validation failed: ${error.message}`, { cause: error })
  }
  return sourcePath
}

function coreForContract(sqlite, plan, store) {
  const row = sqlite.prepare('SELECT * FROM core_artifacts WHERE artifact_fingerprint = ?').get(plan.artifactFingerprint)
  if (!row) return null
  const js = plan.artifactContracts.find((asset) => asset.kind === 'core_js')
  const wasm = plan.artifactContracts.find((asset) => asset.kind === 'core_wasm')
  const expected = {
    core_name: plan.coreName,
    display_version: plan.displayVersion,
    source_commit: plan.sourceCommit,
    js_sha256: js.sha256,
    wasm_sha256: wasm.sha256,
    dat_sha256: plan.datSha256,
    artifact_fingerprint: plan.artifactFingerprint,
  }
  for (const [field, value] of Object.entries(expected)) {
    if ((row[field] ?? null) !== (value ?? null)) {
      throw new Error(`immutable core artifact ${plan.artifactFingerprint} conflicts at ${field}`)
    }
  }
  assertExistingCoreAsset(sqlite, plan, row, js, store)
  assertExistingCoreAsset(sqlite, plan, row, wasm, store)
  return row
}

function variantKind(relationKind) {
  if (relationKind === 'hack') return 'hack'
  if (relationKind === 'bootleg') return 'bootleg'
  return 'official'
}

function normalizedPlatform(value) {
  const lower = String(value || 'arcade').toLowerCase()
  return ['cps1', 'cps2', 'neogeo'].includes(lower) ? 'arcade' : lower
}

function normalizedCoreFingerprint(coreRow) {
  const value = String(coreRow.artifact_fingerprint || '').toLowerCase()
  return SHA256_PATTERN.test(value)
    ? value
    : hashCanonicalLibraryJson({ kind: 'registered-core-alias-v1', value })
}

function planAssets(manifest, batchRoot, corePlans) {
  const resolutions = new Map(manifest.candidateResolutions.map((row) => [row.candidateId, row]))
  const assets = new Map()
  for (const archive of manifest.archives) {
    if (['blocked', 'unsupported'].includes(resolutions.get(archive.candidateId)?.state)) continue
    if (!SHA256_PATTERN.test(String(archive.archiveSha256 || ''))) {
      throw new Error(`candidate ${archive.candidateId} has no valid archive hash`)
    }
    assets.set(archive.archiveSha256, {
      kind: 'rom', mimeType: 'application/zip', sha256: archive.archiveSha256,
      fileSize: archive.archiveSize, sourcePath: resolveContained(batchRoot, archive.archivePath),
    })
  }
  for (const plan of corePlans.values()) {
    for (const asset of plan.assets) assets.set(asset.sha256, asset)
  }
  for (const thumbnail of manifest.thumbnails) {
    if (!thumbnail.sha256) continue
    assets.set(thumbnail.sha256, {
      kind: 'thumbnail', mimeType: 'image/webp', sha256: thumbnail.sha256,
      fileSize: thumbnail.fileSize, sourcePath: resolveContained(batchRoot, thumbnail.assetPath),
    })
  }
  return [...assets.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
}

function ensureImportedCoreArtifact(sqlite, plan, assetRows, store) {
  const existing = coreForContract(sqlite, plan, store)
  if (existing) return { row: existing, created: false }
  const jsAsset = assetRows.get(plan.assets.find((asset) => asset.kind === 'core_js')?.sha256)
  const wasmAsset = assetRows.get(plan.assets.find((asset) => asset.kind === 'core_wasm')?.sha256)
  if (!jsAsset || !wasmAsset) {
    throw new Error(`core ${plan.id} has no published JS/WASM assets`)
  }
  const provenance = {
    schemaVersion: 1,
    kind: 'w165-core-artifact-provenance-v1',
    contractId: plan.id,
    runtimeValidationStatus: plan.contract.runtimeValidationStatus ?? null,
    sourceCommit: plan.sourceCommit,
    artifacts: plan.assets.map((asset) => ({
      kind: asset.kind,
      path: asset.contractPath ?? plan.contract.artifacts?.[asset.kind === 'core_js' ? 'js' : 'wasm']?.path ?? null,
      hashMode: asset.hashMode,
      rawSha256: asset.expectedRawSha256,
      rawFileSize: asset.expectedRawSize,
      storedSha256: asset.sha256,
      storedFileSize: asset.fileSize,
    })),
    compatibilityContractSha256: plan.datSha256,
  }
  const result = sqlite.prepare(`
    INSERT INTO core_artifacts
      (core_name, display_version, source_commit, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, dat_asset_id, dat_sha256, bios_asset_id,
       bios_manifest_sha256, artifact_fingerprint, provenance_json, is_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)
  `).run(
    plan.coreName,
    plan.displayVersion,
    plan.sourceCommit,
    jsAsset.id,
    jsAsset.sha256,
    wasmAsset.id,
    wasmAsset.sha256,
    plan.datSha256,
    plan.artifactFingerprint,
    canonicalizeLibraryJson(provenance),
    plan.enabled ? 1 : 0,
  )
  return {
    row: sqlite.prepare('SELECT * FROM core_artifacts WHERE id = ?').get(Number(result.lastInsertRowid)),
    created: true,
  }
}

function assertExistingBatchIntegrity(sqlite, row, manifest, assetRoot) {
  const operations = sqlite.prepare(`
    SELECT * FROM import_operations WHERE import_batch_id = ? ORDER BY sequence
  `).all(manifest.batchId)
  if (operations.length === 0 || operations.some((operation, index) => operation.sequence !== index + 1)) {
    throw new Error(`batch ${manifest.batchId} operation ledger integrity check failed`)
  }

  const resolutionOperations = operations.filter((operation) => (
    operation.entity_type === 'candidate_resolution' && operation.reverted_at === null
  ))
  const expectedResolutions = new Map(manifest.candidateResolutions.map((resolution) => [String(resolution.candidateId), resolution]))
  if (resolutionOperations.length !== expectedResolutions.size) {
    throw new Error(`batch ${manifest.batchId} resolution ledger integrity check failed`)
  }
  for (const operation of resolutionOperations) {
    const expected = expectedResolutions.get(operation.entity_key)
    if (!expected || operation.operation_kind !== 'record' || operation.before_json !== null
      || canonicalizeLibraryJson(JSON.parse(operation.after_json)) !== canonicalizeLibraryJson(expected)) {
      throw new Error(`batch ${manifest.batchId} resolution ledger integrity check failed at ${operation.entity_key}`)
    }
  }

  const expectedBuildable = new Set(manifest.candidateResolutions
    .filter((resolution) => !['blocked', 'unsupported'].includes(resolution.state))
    .map((resolution) => String(resolution.candidateId)))
  const batchBuilds = sqlite.prepare(`
    SELECT b.* FROM rom_builds b
    JOIN batch_build_refs r ON r.rom_build_id = b.id
    WHERE r.import_batch_id = ?
  `).all(manifest.batchId)
  const actualCandidates = new Set(batchBuilds.map((build) => {
    try {
      return String(JSON.parse(build.static_failure_details_json)?.candidateId)
    } catch {
      throw new Error(`batch ${manifest.batchId} build ${build.id} has malformed candidate evidence`)
    }
  }))
  if (batchBuilds.length !== expectedBuildable.size || actualCandidates.size !== expectedBuildable.size
    || [...actualCandidates].some((candidateId) => !expectedBuildable.has(candidateId))
    || Number(row.actual_count) !== expectedBuildable.size) {
    throw new Error(`batch ${manifest.batchId} build ledger integrity check failed`)
  }

  const assetIds = new Set()
  for (const operation of operations.filter((entry) => entry.entity_type === 'asset' && entry.operation_kind === 'create')) {
    assetIds.add(Number(JSON.parse(operation.after_json).id))
  }
  for (const build of batchBuilds) {
    if (build.archive_asset_id !== null) assetIds.add(Number(build.archive_asset_id))
    const core = sqlite.prepare('SELECT * FROM core_artifacts WHERE id = ?').get(build.core_artifact_id)
    if (!core) throw new Error(`batch ${manifest.batchId} core artifact is missing for build ${build.id}`)
    for (const field of ['js_asset_id', 'wasm_asset_id', 'dat_asset_id', 'bios_asset_id']) {
      if (core[field] !== null && Number(core[field]) > 0) assetIds.add(Number(core[field]))
    }
  }
  for (const ref of sqlite.prepare('SELECT asset_id FROM rom_asset_refs WHERE import_batch_id = ?').all(manifest.batchId)) {
    assetIds.add(Number(ref.asset_id))
  }
  for (const assetId of assetIds) {
    const asset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)
    if (!asset) throw new Error(`batch ${manifest.batchId} content object metadata is missing for asset ${assetId}`)
    const expectedPath = `sha256/${asset.sha256.slice(0, 2)}/${asset.sha256}`
    if (asset.file_path !== expectedPath) throw new Error(`batch ${manifest.batchId} content object path is invalid for asset ${assetId}`)
    const absolute = resolveContained(assetRoot, asset.file_path)
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
      throw new Error(`batch ${manifest.batchId} content object is missing for asset ${assetId}`)
    }
    const actual = sha256File(absolute)
    if (actual.sha256 !== asset.sha256 || actual.fileSize !== asset.file_size) {
      throw new Error(`batch ${manifest.batchId} content object integrity mismatch for asset ${assetId}`)
    }
  }
}

function existingBatchResult(sqlite, row, manifest, assetRoot) {
  if (!row) return null
  if (row.manifest_sha256 !== manifest.manifestSha256) {
    throw new Error(`batch ${manifest.batchId} already exists with a different manifest hash`)
  }
  if (['committed_private', 'published'].includes(row.status)) {
    assertExistingBatchIntegrity(sqlite, row, manifest, assetRoot)
    return {
      kind: 'w165-import-commit-evidence-v1',
      batchId: manifest.batchId,
      manifestSha256: manifest.manifestSha256,
      status: row.status,
      noop: true,
      writes: 0,
    }
  }
  throw new Error(`batch ${manifest.batchId} cannot resume from status ${row.status}`)
}

function acquireLock(dbPath) {
  const path = `${resolve(dbPath)}.arcade-import.lock`
  let descriptor
  try {
    descriptor = openSync(path, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`arcade import lock already exists: ${path}`)
    throw error
  }
  return () => {
    closeSync(descriptor)
    rmSync(path, { force: true })
  }
}

export function commitBatch({
  dbPath,
  assetRoot,
  manifestPath,
  batchRoot,
  contractsDir,
  repoRoot,
  ownerUserId,
  apply = false,
}) {
  if (!Number.isInteger(Number(ownerUserId)) || Number(ownerUserId) <= 0) {
    throw new TypeError('ownerUserId must be a positive integer')
  }
  const { manifest } = readManifest(manifestPath)
  const contractLedger = readContractLedger(contractsDir)
  assertManifestContractBinding(manifest, contractLedger)
  const absoluteBatchRoot = resolve(batchRoot)
  const sqlite = new Database(resolve(dbPath), apply ? {} : { readonly: true, fileMustExist: true })
  let releaseLock = null
  let mutationLock = null
  let store = null
  const createdContent = []
  try {
    if (apply) {
      releaseLock = acquireLock(dbPath)
    }
    store = createContentStore({
      root: resolve(assetRoot),
      allowedSourceRoots: [absoluteBatchRoot, ...(repoRoot ? [resolve(repoRoot)] : [])],
    })
    if (apply) {
      mutationLock = store.acquireMutationLock({
        operation: 'w165-import-commit',
        databasePath: resolve(dbPath),
        batchId: manifest.batchId,
        manifestSha256: manifest.manifestSha256,
      })
    }
    sqlite.pragma('foreign_keys = ON')
    assertContractedDatabase(sqlite)
    const existing = existingBatchResult(
      sqlite,
      sqlite.prepare('SELECT * FROM import_batches WHERE id = ?').get(manifest.batchId),
      manifest,
      assetRoot,
    )
    if (existing) return existing
    if (!sqlite.prepare('SELECT id FROM users WHERE id = ? AND status = 1').get(Number(ownerUserId))) {
      throw new Error(`owner user ${ownerUserId} does not exist or is disabled`)
    }
    assertPreparedArchives(manifest, absoluteBatchRoot)
    const corePlans = new Map()
    for (const core of manifest.cores ?? []) {
      const plan = coreContractPlan(core, repoRoot)
      const existingCore = coreForContract(sqlite, plan, store)
      if (!existingCore && plan.assets.length === 0) {
        throw new Error(`core artifact contract is not registered and --repo-root was not supplied: ${core.id}`)
      }
      corePlans.set(plan.id, plan)
    }
    const assets = planAssets(manifest, absoluteBatchRoot, corePlans)
    const plannedContent = assets.map((asset) => ({
      ...asset,
      publication: store.putSource({
        sourcePath: asset.sourcePath,
        expectedSha256: asset.expectedSha256 ?? asset.sha256,
        expectedSize: asset.expectedSize ?? asset.fileSize,
        expectedRawSha256: asset.expectedRawSha256 ?? asset.sha256,
        expectedRawSize: asset.expectedRawSize ?? asset.fileSize,
        hashMode: asset.hashMode ?? 'raw',
        kind: asset.kind,
        dryRun: !apply,
      }),
    }))
    if (!apply) {
      return {
        kind: 'w165-import-commit-evidence-v1',
        batchId: manifest.batchId,
        manifestSha256: manifest.manifestSha256,
        status: 'committed_private',
        noop: false,
        dryRun: true,
        writes: 0,
        plannedAssets: plannedContent.length,
        plannedCandidates: manifest.candidateResolutions.filter((row) => !['blocked', 'unsupported'].includes(row.state)).length,
      }
    }
    createdContent.push(...plannedContent.map(({ publication }) => publication).filter(({ created }) => created))

    const execute = sqlite.transaction(() => {
      const state = { batchId: manifest.batchId, sequence: 0 }
      sqlite.prepare(`
        INSERT INTO import_batches
          (id, owner_user_id, cold_source_sha256, manifest_sha256,
           planned_count, actual_count, total_bytes, status)
        VALUES (?, ?, ?, ?, ?, 0, 0, 'staged')
      `).run(
        manifest.batchId,
        Number(ownerUserId),
        manifest.coldSource.sha256,
        manifest.manifestSha256,
        manifest.candidateResolutions.length,
      )

      for (const resolution of [...manifest.candidateResolutions]
        .sort((left, right) => String(left.candidateId).localeCompare(String(right.candidateId)))) {
        writeOperation(sqlite, state, {
          operationKind: 'record', entityType: 'candidate_resolution',
          entityKey: resolution.candidateId, after: resolution,
        })
      }

      const assetRows = new Map()
      for (const asset of plannedContent) {
        const result = ensureAssetRecord(sqlite, {
          kind: asset.kind,
          filePath: asset.publication.filePath,
          mimeType: asset.mimeType,
          fileSize: asset.fileSize,
          sha256: asset.sha256,
        })
        assetRows.set(asset.sha256, result.row)
        if (result.created) {
          writeOperation(sqlite, state, {
            operationKind: 'create', entityType: 'asset', entityKey: asset.sha256,
            after: result.row,
          })
        }
      }

      const cores = new Map()
      for (const plan of corePlans.values()) {
        const ensured = ensureImportedCoreArtifact(sqlite, plan, assetRows, store)
        cores.set(plan.id, ensured.row)
        if (ensured.created) {
          writeOperation(sqlite, state, {
            operationKind: 'create', entityType: 'core_artifact', entityKey: ensured.row.artifact_fingerprint,
            after: ensured.row,
          })
        }
      }
      const resolutionById = new Map(manifest.candidateResolutions.map((row) => [row.candidateId, row]))
      const archiveById = new Map(manifest.archives.map((row) => [row.candidateId, row]))
      const thumbnailById = new Map(manifest.thumbnails.map((row) => [row.candidateId, row]))
      const romByCandidate = new Map()
      const ordered = [
        ...manifest.archives.filter((row) => row.archiveLayout === 'standalone'),
        ...manifest.archives.filter((row) => row.archiveLayout === 'split'),
      ]

      for (const archive of ordered) {
        if (['blocked', 'unsupported'].includes(resolutionById.get(archive.candidateId)?.state)) continue
        const platform = normalizedPlatform(archive.platform)
        const setName = String(archive.setName || '').toLowerCase()
        if (!SET_PATTERN.test(setName)) throw new Error(`invalid canonical set name: ${setName}`)
        let rom = sqlite.prepare(`
          SELECT * FROM roms WHERE user_id = ? AND platform = ? AND set_name_normalized = ?
        `).get(Number(ownerUserId), platform, setName)
        if (!rom) {
          const parentCandidate = archive.mounts?.find((mount) => mount.role === 'parent')?.candidateId
          const parentRomId = parentCandidate ? romByCandidate.get(parentCandidate)?.id ?? null : null
          const archiveAsset = assetRows.get(archive.archiveSha256)
          const insert = sqlite.prepare(`
            INSERT INTO roms
              (user_id, title, platform, file_name, file_path, file_size,
               is_public, parent_rom_id, set_name_normalized, variant_kind,
               dat_parent_set_name, family_root_set_name, version_label, status)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1)
          `).run(
            Number(ownerUserId), archive.title || setName, platform,
            `${setName}.zip`, archiveAsset.file_path, archive.archiveSize,
            parentRomId, setName, variantKind(archive.relationKind),
            archive.datParentSetName ?? null, archive.familyRootSetName ?? setName,
            archive.title || setName,
          )
          rom = fullRow(sqlite, 'roms', 'id = ?', [Number(insert.lastInsertRowid)])
          writeOperation(sqlite, state, {
            operationKind: 'create', entityType: 'rom', entityKey: rom.id, after: rom,
          })
        }
        romByCandidate.set(archive.candidateId, rom)
      }

      const buildByCandidate = new Map()
      for (const archive of ordered) {
        if (['blocked', 'unsupported'].includes(resolutionById.get(archive.candidateId)?.state)) continue
        let rom = romByCandidate.get(archive.candidateId)
        const core = cores.get(archive.coreArtifactId)
        if (!core) throw new Error(`manifest core is missing: ${archive.coreArtifactId}`)
        const archiveAsset = assetRows.get(archive.archiveSha256)
        const parentCandidate = archive.mounts?.find((mount) => mount.role === 'parent')?.candidateId
        const parentBuild = parentCandidate ? buildByCandidate.get(parentCandidate) : null
        if (archive.archiveLayout === 'split' && !parentBuild) {
          throw new Error(`split candidate ${archive.candidateId} lacks a committed parent build`)
        }
        const contentManifestSha256 = hashCanonicalLibraryJson({
          schemaVersion: 1,
          kind: 'w165-archive-content-v1',
          members: archive.members,
        })
        const coreFingerprint = normalizedCoreFingerprint(core)
        const buildFingerprint = computeBuildFingerprint({
          logicalRomScope: `w165:${String(archive.candidateId).toLowerCase()}`,
          setNameNormalized: String(archive.setName).toLowerCase(),
          coreArtifactFingerprint: coreFingerprint,
          archiveSha256: archive.archiveSha256,
          contentManifestSha256,
          archiveLayout: archive.archiveLayout,
          runtimeParentBuildFingerprint: parentBuild?.build_fingerprint ?? null,
          biosManifestSha256: core.bios_manifest_sha256 ?? null,
        })
        let build = sqlite.prepare('SELECT * FROM rom_builds WHERE build_fingerprint = ?').get(buildFingerprint)
        if (build && build.rom_id !== rom.id) {
          throw new Error(`build fingerprint ${buildFingerprint} belongs to another logical ROM`)
        }
        if (!build) {
          const insert = sqlite.prepare(`
            INSERT INTO rom_builds
              (rom_id, core_artifact_id, archive_asset_id, archive_sha256,
               content_manifest_sha256, build_fingerprint, static_status,
               static_failure_details_json, archive_layout, runtime_parent_build_id)
            VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)
          `).run(
            rom.id, core.id, archiveAsset.id, archive.archiveSha256,
            contentManifestSha256, buildFingerprint,
            canonicalizeLibraryJson({
              candidateId: archive.candidateId,
              hardwareFamily: archive.platform ?? null,
              runtimeArchiveFileName: `${archive.setName}.zip`,
            }),
            archive.archiveLayout, parentBuild?.id ?? null,
          )
          build = fullRow(sqlite, 'rom_builds', 'id = ?', [Number(insert.lastInsertRowid)])
          writeOperation(sqlite, state, {
            operationKind: 'create', entityType: 'rom_build', entityKey: build.id, after: build,
          })
        }
        buildByCandidate.set(archive.candidateId, build)
        const batchRef = sqlite.prepare('SELECT * FROM batch_build_refs WHERE import_batch_id = ? AND rom_build_id = ?').get(manifest.batchId, build.id)
        if (!batchRef) {
          sqlite.prepare('INSERT INTO batch_build_refs (import_batch_id, rom_build_id) VALUES (?, ?)').run(manifest.batchId, build.id)
          writeOperation(sqlite, state, {
            operationKind: 'create', entityType: 'batch_build_ref', entityKey: `${manifest.batchId}:${build.id}`,
            after: fullRow(sqlite, 'batch_build_refs', 'import_batch_id = ? AND rom_build_id = ?', [manifest.batchId, build.id]),
          })
        }
        for (const [index, member] of archive.members.entries()) {
            const separator = String(member.sourcePath).indexOf('!')
            const sourceArchivePath = separator === -1 ? member.sourcePath : member.sourcePath.slice(0, separator)
            const sourceMemberName = separator === -1 ? member.name : member.sourcePath.slice(separator + 1)
            const exists = sqlite.prepare(`
            SELECT 1 FROM build_source_members
            WHERE import_batch_id = ? AND rom_build_id = ? AND source_archive_path = ? AND member_name = ?
          `).get(manifest.batchId, build.id, sourceArchivePath, sourceMemberName)
          if (exists) continue
          sqlite.prepare(`
            INSERT INTO build_source_members
              (import_batch_id, rom_build_id, source_archive_path, member_name,
               member_role, member_order, member_size, crc32, sha256)
            VALUES (?, ?, ?, ?, 'primary', ?, ?, ?, ?)
            `).run(manifest.batchId, build.id, sourceArchivePath, sourceMemberName, index, member.size, member.crc32, member.sha256)
          writeOperation(sqlite, state, {
            operationKind: 'create', entityType: 'build_source_member',
            entityKey: `${manifest.batchId}:${build.id}:${sourceArchivePath}:${sourceMemberName}`,
            after: fullRow(sqlite, 'build_source_members', 'import_batch_id = ? AND rom_build_id = ? AND source_archive_path = ? AND member_name = ?', [manifest.batchId, build.id, sourceArchivePath, sourceMemberName]),
          })
        }
        if (rom.active_build_id === null || rom.active_build_id === undefined) {
          const before = rom
          sqlite.prepare('UPDATE roms SET active_build_id = ? WHERE id = ? AND active_build_id IS NULL').run(build.id, rom.id)
          rom = fullRow(sqlite, 'roms', 'id = ?', [rom.id])
          romByCandidate.set(archive.candidateId, rom)
          writeOperation(sqlite, state, {
            operationKind: 'update', entityType: 'rom', entityKey: rom.id, before, after: rom,
          })
        }

        const thumbnail = thumbnailById.get(archive.candidateId)
        if (thumbnail?.sha256) {
          const thumbAsset = assetRows.get(thumbnail.sha256)
          let ref = sqlite.prepare(`
            SELECT * FROM rom_asset_refs
            WHERE rom_id = ? AND asset_id = ? AND import_batch_id = ?
          `).get(rom.id, thumbAsset.id, manifest.batchId)
          if (!ref) {
            const insert = sqlite.prepare(`
              INSERT INTO rom_asset_refs
                (rom_id, asset_id, match_kind, source_set_name,
                 source_file_sha256, import_batch_id)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              rom.id, thumbAsset.id, thumbnail.matchKind,
              thumbnail.sourceSetName ?? null, thumbnail.sourceFileSha256, manifest.batchId,
            )
            ref = fullRow(sqlite, 'rom_asset_refs', 'id = ?', [Number(insert.lastInsertRowid)])
            writeOperation(sqlite, state, {
              operationKind: 'create', entityType: 'rom_asset_ref', entityKey: ref.id, after: ref,
            })
          }
          rom = fullRow(sqlite, 'roms', 'id = ?', [rom.id])
          if (rom.active_thumbnail_ref_id === null || rom.active_thumbnail_ref_id === undefined) {
            const before = rom
            sqlite.prepare('UPDATE roms SET active_thumbnail_ref_id = ? WHERE id = ? AND active_thumbnail_ref_id IS NULL').run(ref.id, rom.id)
            rom = fullRow(sqlite, 'roms', 'id = ?', [rom.id])
            romByCandidate.set(archive.candidateId, rom)
            writeOperation(sqlite, state, {
              operationKind: 'update', entityType: 'rom', entityKey: rom.id, before, after: rom,
            })
          }
        }
      }

      const importedCount = buildByCandidate.size
      const totalBytes = plannedContent.reduce((sum, asset) => sum + asset.fileSize, 0)
      const beforeBatch = fullRow(sqlite, 'import_batches', 'id = ?', [manifest.batchId])
      const changed = sqlite.prepare(`
        UPDATE import_batches
        SET actual_count = ?, total_bytes = ?, status = 'committed_private'
        WHERE id = ? AND manifest_sha256 = ? AND status = 'staged'
      `).run(importedCount, totalBytes, manifest.batchId, manifest.manifestSha256)
      if (changed.changes !== 1) throw new Error('batch status compare-and-swap failed')
      const afterBatch = fullRow(sqlite, 'import_batches', 'id = ?', [manifest.batchId])
      writeOperation(sqlite, state, {
        operationKind: 'update', entityType: 'import_batch', entityKey: manifest.batchId,
        before: beforeBatch, after: afterBatch,
      })
      return { importedCount, totalBytes, operations: state.sequence }
    })
    const committed = execute.immediate()
    return {
      kind: 'w165-import-commit-evidence-v1',
      batchId: manifest.batchId,
      manifestSha256: manifest.manifestSha256,
      status: 'committed_private',
      noop: false,
      dryRun: false,
      writes: committed.operations,
      importedCandidates: committed.importedCount,
      totalBytes: committed.totalBytes,
    }
  } catch (error) {
    if (createdContent.length) {
      try {
        store.cleanupCreated(createdContent, {
          isReferenced: (record) => {
            try {
              return Boolean(sqlite.prepare('SELECT 1 FROM assets WHERE sha256 = ?').get(record.sha256))
            } catch {
              return true
            }
          },
        })
      } catch {}
    }
    throw error
  } finally {
    try {
      if (mutationLock) mutationLock.release()
    } finally {
      try {
        if (releaseLock) releaseLock()
      } finally {
        sqlite.close()
      }
    }
  }
}

function parseArgs(argv) {
  const options = { apply: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--apply') options.apply = true
    else if (value.startsWith('--')) {
      const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
      options[key] = next
      index += 1
    } else throw new Error(`unexpected argument: ${value}`)
  }
  for (const key of ['db', 'assetRoot', 'manifest', 'batchRoot', 'contractsDir', 'ownerUserId']) {
    if (options[key] === undefined) throw new Error(`--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    const result = commitBatch({
      dbPath: options.db,
      assetRoot: options.assetRoot,
      manifestPath: options.manifest,
      batchRoot: options.batchRoot,
      contractsDir: options.contractsDir,
      repoRoot: options.repoRoot,
      ownerUserId: Number(options.ownerUserId),
      apply: options.apply,
    })
    process.stdout.write(`${canonicalizeLibraryJson(result)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`commit_batch: ${error.message}\n`)
    return 2
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) process.exitCode = main()
