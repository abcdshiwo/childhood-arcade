import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const HASH_MODES = new Set(['raw', 'lf-normalized-text'])
const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EISDIR',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EPERM',
])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizedSha256(value, field = 'expectedSha256') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value.toLowerCase())) {
    throw new TypeError(`${field} must be a 64-character SHA-256 hex string`)
  }
  return value.toLowerCase()
}

function normalizedExpectedSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('expectedSize must be a non-negative safe integer')
  }
  return value
}

function assertContained(root, candidate, label) {
  const pathFromRoot = relative(root, candidate)
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} escapes content-store containment`)
  }
}

function assertNoLinks(root, candidate) {
  if (!existsSync(root)) return
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error('content-store root cannot be a symbolic link or junction')
  }

  const rootReal = realpathSync.native(root)
  assertContained(rootReal, rootReal, 'content-store root')
  const pathFromRoot = relative(root, candidate)
  let cursor = root
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment)
    if (!existsSync(cursor)) break
    const entry = lstatSync(cursor)
    if (entry.isSymbolicLink()) {
      throw new Error(`content-store path contains a symbolic link or junction: ${cursor}`)
    }
    assertContained(rootReal, realpathSync.native(cursor), 'content-store path')
  }
}

function canonicalStoredPath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new TypeError('stored path must be a non-empty relative path')
  }
  if (input.includes('\\')) {
    throw new Error('stored path must use forward-slash separators')
  }
  if (isAbsolute(input) || /^[a-zA-Z]:\//.test(input)) {
    throw new Error('stored path must be relative')
  }
  const segments = input.split('/')
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new Error('stored path traversal is forbidden')
  }
  return segments.join('/')
}

export function canonicalizeContentBytes(bytes, hashMode = 'raw') {
  if (!HASH_MODES.has(hashMode)) {
    throw new TypeError(`unsupported content hash mode: ${hashMode}`)
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (hashMode === 'raw') return Buffer.from(buffer)
  return Buffer.from(buffer.toString('utf8').replaceAll('\r\n', '\n'), 'utf8')
}

function contentAddress(sha) {
  return `sha256/${sha.slice(0, 2)}/${sha}`
}

function inspectCanonicalBytes(bytes, { expectedSha256, expectedSize }) {
  const expectedHash = normalizedSha256(expectedSha256)
  const size = normalizedExpectedSize(expectedSize)
  const actualHash = sha256(bytes)
  if (bytes.length !== size) {
    throw new Error(
      `content size mismatch: expected ${size}, got ${bytes.length}`,
    )
  }
  if (actualHash !== expectedHash) {
    throw new Error(
      `content SHA-256 hash mismatch: expected ${expectedHash}, got ${actualHash}`,
    )
  }
  return { sha256: actualHash, fileSize: bytes.length }
}

function verifyExistingTarget(path, expected) {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('existing content object is not a regular file')
  }
  const bytes = readFileSync(path)
  const actualHash = sha256(bytes)
  if (bytes.length !== expected.fileSize || actualHash !== expected.sha256) {
    throw new Error(
      `existing content object hash mismatch at ${path}: expected ${expected.sha256}, got ${actualHash}`,
    )
  }
}

function collectMissingDirectories(directory) {
  const missing = []
  let cursor = directory
  while (!existsSync(cursor)) {
    missing.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return missing.reverse()
}

function normalizeDurabilityOps(durabilityOps = {}) {
  const normalized = {
    platform: durabilityOps.platform ?? process.platform,
    openSync: durabilityOps.openSync ?? openSync,
    fsyncSync: durabilityOps.fsyncSync ?? fsyncSync,
    closeSync: durabilityOps.closeSync ?? closeSync,
  }
  if (typeof normalized.platform !== 'string') {
    throw new TypeError('durabilityOps.platform must be a string')
  }
  for (const name of ['openSync', 'fsyncSync', 'closeSync']) {
    if (typeof normalized[name] !== 'function') {
      throw new TypeError(`durabilityOps.${name} must be a function`)
    }
  }
  return normalized
}

function syncOpenedPath(path, flags, durabilityOps) {
  const descriptor = durabilityOps.openSync(path, flags)
  try {
    durabilityOps.fsyncSync(descriptor)
  } finally {
    durabilityOps.closeSync(descriptor)
  }
}

function metadataSyncDirectories(destinationDirectory, createdDirectories) {
  const paths = [destinationDirectory]
  for (const directory of [...createdDirectories].reverse()) {
    const parent = dirname(directory)
    if (!paths.includes(parent)) paths.push(parent)
  }
  return paths
}

function syncDirectoryMetadata({
  destinationDirectory,
  createdDirectories,
  durabilityOps,
}) {
  const windows = durabilityOps.platform === 'win32'
  const unsupportedDirectories = []
  for (const directory of metadataSyncDirectories(
    destinationDirectory,
    createdDirectories,
  )) {
    try {
      syncOpenedPath(directory, windows ? 'r+' : 'r', durabilityOps)
    } catch (error) {
      if (
        windows &&
        WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)
      ) {
        unsupportedDirectories.push(directory)
        continue
      }
      throw new Error(
        `failed to fsync published content directory metadata at ${directory}: ${error.message}`,
        { cause: error },
      )
    }
  }
  return unsupportedDirectories
}

function syncPublishedContentMetadata({
  publishedPath,
  destinationDirectory,
  createdDirectories,
  durabilityOps,
  preSyncedPublishedFile = 'temp-fsynced-before-rename',
}) {
  const windows = durabilityOps.platform === 'win32'
  let publishedFile = preSyncedPublishedFile
  if (windows) {
    try {
      syncOpenedPath(publishedPath, 'r+', durabilityOps)
      publishedFile = 'synced'
    } catch (error) {
      throw new Error(
        `failed to fsync published content file ${publishedPath}: ${error.message}`,
        { cause: error },
      )
    }
  }

  const unsupportedDirectories = syncDirectoryMetadata({
    destinationDirectory,
    createdDirectories,
    durabilityOps,
  })

  return {
    publishedFile,
    directoryMetadata:
      unsupportedDirectories.length === 0 ? 'synced' : 'unsupported',
    unsupportedDirectories,
  }
}

function removeOwnedLock(lockPath, token, kind) {
  if (!existsSync(lockPath)) return false
  let current
  try {
    current = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return false
  }
  if (
    current?.kind !== kind ||
    current?.token !== token
  ) {
    return false
  }
  unlinkSync(lockPath)
  return true
}

export function createContentStore({
  root,
  allowedSourceRoots = [],
  durabilityOps: durabilityOverrides = {},
}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('content-store root is required')
  }
  const absoluteRoot = resolve(root)
  const durabilityOps = normalizeDurabilityOps(durabilityOverrides)
  if (!Array.isArray(allowedSourceRoots)) {
    throw new TypeError('allowedSourceRoots must be an array')
  }
  const absoluteSourceRoots = allowedSourceRoots.map((sourceRoot) => {
    if (typeof sourceRoot !== 'string' || sourceRoot.trim() === '') {
      throw new TypeError('allowed source roots must be non-empty paths')
    }
    return resolve(sourceRoot)
  })

  function assertAllowedSourcePath(sourcePath) {
    if (absoluteSourceRoots.length === 0) {
      throw new Error('putSource requires at least one explicit allowed source root')
    }
    const absoluteSourcePath = resolve(sourcePath)
    const sourceEntry = lstatSync(absoluteSourcePath)
    if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
      throw new Error(`source must be a regular non-symbolic file: ${sourcePath}`)
    }
    const sourceReal = realpathSync.native(absoluteSourcePath)
    const allowed = absoluteSourceRoots.some((sourceRoot) => {
      if (!existsSync(sourceRoot)) return false
      const rootEntry = lstatSync(sourceRoot)
      if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) return false
      const rootReal = realpathSync.native(sourceRoot)
      try {
        assertContained(rootReal, sourceReal, 'source path')
        return true
      } catch {
        return false
      }
    })
    if (!allowed) {
      throw new Error(`source path is outside every allowed source root: ${sourcePath}`)
    }
    return absoluteSourcePath
  }

  function resolveStoredPath(storedPath) {
    const normalized = canonicalStoredPath(storedPath)
    const absolutePath = resolve(absoluteRoot, ...normalized.split('/'))
    assertContained(absoluteRoot, absolutePath, 'stored path')
    assertNoLinks(absoluteRoot, absolutePath)
    return absolutePath
  }

  function resultFor({
    expected,
    kind,
    absolutePath,
    created,
    existing,
    dryRun,
    durability = null,
  }) {
    return {
      kind,
      sha256: expected.sha256,
      fileSize: expected.fileSize,
      filePath: contentAddress(expected.sha256),
      absolutePath,
      created,
      existing,
      wouldCreate: dryRun ? !existing : false,
      durability,
    }
  }

  function putCanonicalBytes({ bytes, expectedSha256, expectedSize, kind, dryRun }) {
    const expected = inspectCanonicalBytes(bytes, {
      expectedSha256,
      expectedSize,
    })
    const filePath = contentAddress(expected.sha256)
    const absolutePath = resolveStoredPath(filePath)
    if (existsSync(absolutePath)) {
      verifyExistingTarget(absolutePath, expected)
      return resultFor({
        expected,
        kind,
        absolutePath,
        created: false,
        existing: true,
        dryRun,
      })
    }
    if (dryRun) {
      return resultFor({
        expected,
        kind,
        absolutePath,
        created: false,
        existing: false,
        dryRun: true,
      })
    }

    const destinationDirectory = dirname(absolutePath)
    const createdDirectories = collectMissingDirectories(destinationDirectory)
    mkdirSync(destinationDirectory, { recursive: true })
    assertNoLinks(absoluteRoot, absolutePath)

    const nonce = randomBytes(8).toString('hex')
    const temporaryPath = join(
      destinationDirectory,
      `.${expected.sha256}.tmp-${process.pid}-${nonce}`,
    )
    const lockPath = join(destinationDirectory, `.${expected.sha256}.lock`)
    let lockDescriptor = null
    let published = false
    try {
      lockDescriptor = openSync(lockPath, 'wx')
      if (existsSync(absolutePath)) {
        verifyExistingTarget(absolutePath, expected)
        return resultFor({
          expected,
          kind,
          absolutePath,
          created: false,
          existing: true,
          dryRun: false,
        })
      }
      const temporaryDescriptor = openSync(temporaryPath, 'wx')
      try {
        writeFileSync(temporaryDescriptor, bytes)
        fsyncSync(temporaryDescriptor)
      } finally {
        closeSync(temporaryDescriptor)
      }
      verifyExistingTarget(temporaryPath, expected)
      renameSync(temporaryPath, absolutePath)
      published = true
      verifyExistingTarget(absolutePath, expected)
      const durability = syncPublishedContentMetadata({
        publishedPath: absolutePath,
        destinationDirectory,
        createdDirectories,
        durabilityOps,
      })
      return resultFor({
        expected,
        kind,
        absolutePath,
        created: true,
        existing: false,
        dryRun: false,
        durability,
      })
    } catch (error) {
      if (error?.code === 'EEXIST' && existsSync(absolutePath)) {
        verifyExistingTarget(absolutePath, expected)
        return resultFor({
          expected,
          kind,
          absolutePath,
          created: false,
          existing: true,
          dryRun: false,
        })
      }
      if (published && existsSync(absolutePath)) {
        try {
          unlinkSync(absolutePath)
        } catch {}
      }
      throw error
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
      if (lockDescriptor !== null) {
        closeSync(lockDescriptor)
        if (existsSync(lockPath)) rmSync(lockPath, { force: true })
      }
    }
  }

  function putSource({
    sourcePath,
    expectedSha256,
    expectedSize,
    expectedRawSha256,
    expectedRawSize,
    hashMode = 'raw',
    kind = 'asset',
    dryRun = false,
  }) {
    if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
      throw new TypeError('sourcePath is required')
    }
    const absoluteSourcePath = assertAllowedSourcePath(sourcePath)
    const sourceStat = statSync(absoluteSourcePath)
    if (!sourceStat.isFile()) throw new Error(`source is not a file: ${sourcePath}`)
    if ((expectedRawSha256 === undefined) !== (expectedRawSize === undefined)) {
      throw new TypeError(
        'expectedRawSha256 and expectedRawSize must be supplied together',
      )
    }
    const rawBytes = readFileSync(absoluteSourcePath)
    const raw = {
      rawSha256: sha256(rawBytes),
      rawFileSize: rawBytes.length,
    }
    if (expectedRawSha256 !== undefined) {
      const expectedRawHash = normalizedSha256(
        expectedRawSha256,
        'expectedRawSha256',
      )
      const expectedRawLength = normalizedExpectedSize(expectedRawSize)
      if (raw.rawFileSize !== expectedRawLength) {
        throw new Error(
          `raw source size mismatch: expected ${expectedRawLength}, got ${raw.rawFileSize}`,
        )
      }
      if (raw.rawSha256 !== expectedRawHash) {
        throw new Error(
          `raw source SHA-256 hash mismatch: expected ${expectedRawHash}, got ${raw.rawSha256}`,
        )
      }
    }
    const canonicalBytes = canonicalizeContentBytes(rawBytes, hashMode)
    return {
      ...putCanonicalBytes({
        bytes: canonicalBytes,
        expectedSha256,
        expectedSize,
        kind,
        dryRun,
      }),
      ...raw,
    }
  }

  function putBytes({
    bytes,
    expectedSha256,
    expectedSize,
    hashMode = 'raw',
    kind = 'asset',
    dryRun = false,
  }) {
    return putCanonicalBytes({
      bytes: canonicalizeContentBytes(bytes, hashMode),
      expectedSha256,
      expectedSize,
      kind,
      dryRun,
    })
  }

  function cleanupCreated(records, { isReferenced = () => false } = {}) {
    const removed = []
    for (const record of records) {
      if (!record?.created || isReferenced(record)) continue
      const absolutePath = resolveStoredPath(record.filePath)
      if (!existsSync(absolutePath)) continue
      verifyExistingTarget(absolutePath, record)
      unlinkSync(absolutePath)
      removed.push(record.filePath)
    }
    return removed
  }

  function acquireOwnedLock({ fileName, kind, label, metadata }) {
    const createdDirectories = collectMissingDirectories(absoluteRoot)
    mkdirSync(absoluteRoot, { recursive: true })
    assertNoLinks(absoluteRoot, absoluteRoot)

    const lockPath = join(absoluteRoot, fileName)
    const token = randomBytes(24).toString('hex')
    const lockRecord = {
      ...metadata,
      schemaVersion: 1,
      kind,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }
    let descriptor = null
    let acquired = false
    try {
      descriptor = openSync(lockPath, 'wx')
      acquired = true
      writeFileSync(descriptor, `${JSON.stringify(lockRecord)}\n`, 'utf8')
      fsyncSync(descriptor)
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {}
        descriptor = null
      }
      if (acquired) {
        try {
          removeOwnedLock(lockPath, token, kind)
        } catch {}
      }
      if (error?.code === 'EEXIST') {
        throw new Error(
          `${label} lock already exists at ${lockPath}; treat it as active or stale and inspect it manually`,
          { cause: error },
        )
      }
      throw error
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }

    let durability
    try {
      durability = syncPublishedContentMetadata({
        publishedPath: lockPath,
        destinationDirectory: absoluteRoot,
        createdDirectories,
        durabilityOps,
        preSyncedPublishedFile: 'synced',
      })
    } catch (error) {
      removeOwnedLock(lockPath, token, kind)
      throw error
    }

    let released = false
    let releaseDurability = null
    return Object.freeze({
      path: lockPath,
      token,
      durability,
      release() {
        if (released) return releaseDurability
        let current
        try {
          current = JSON.parse(readFileSync(lockPath, 'utf8'))
        } catch (error) {
          throw new Error(
            `${label} lock ${lockPath} disappeared or became unreadable; refusing to remove it`,
            { cause: error },
          )
        }
        if (current?.kind !== kind || current?.token !== token) {
          throw new Error(
            `${label} lock ${lockPath} is no longer owned by this process; refusing to remove it`,
          )
        }
        unlinkSync(lockPath)
        const unsupportedDirectories = syncDirectoryMetadata({
          destinationDirectory: absoluteRoot,
          createdDirectories: [],
          durabilityOps,
        })
        releaseDurability = {
          directoryMetadata:
            unsupportedDirectories.length === 0 ? 'synced' : 'unsupported',
          unsupportedDirectories,
        }
        released = true
        return releaseDurability
      },
    })
  }

  function acquireMutationLock(metadata = {}) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('content mutation lock metadata must be an object')
    }
    return acquireOwnedLock({
      fileName: '.arcade-content-mutation.lock',
      kind: 'arcade-content-mutation-lock-v1',
      label: 'content mutation',
      metadata,
    })
  }

  function acquireLegacyBackfillLock(metadata = {}) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('legacy backfill lock metadata must be an object')
    }
    return acquireOwnedLock({
      fileName: '.legacy-library-backfill.lock',
      kind: 'legacy-library-backfill-lock-v1',
      label: 'legacy backfill',
      metadata: {
        databasePath: metadata.databasePath ?? null,
        manifestPath: metadata.manifestPath ?? null,
      },
    })
  }

  return Object.freeze({
    root: absoluteRoot,
    allowedSourceRoots: Object.freeze([...absoluteSourceRoots]),
    resolveStoredPath,
    putSource,
    putBytes,
    cleanupCreated,
    acquireMutationLock,
    acquireLegacyBackfillLock,
  })
}
