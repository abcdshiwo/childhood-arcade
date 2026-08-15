import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import test from 'node:test'

import {
  canonicalizeContentBytes,
  createContentStore,
} from '../server/services/content-store.js'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function makeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'arcade-content-store-'))
  const root = join(directory, 'assets')
  const source = join(directory, 'source.bin')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    root,
    source,
    store: createContentStore({ root, allowedSourceRoots: [directory] }),
  }
}

function allFiles(root) {
  if (!existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else found.push(path)
    }
  }
  visit(root)
  return found.sort()
}

test('content paths reject absolute, traversal, and ambiguous stored paths', (t) => {
  const { root, store } = makeFixture(t)

  assert.throws(() => store.resolveStoredPath('../escape'), /relative|traversal|contain/i)
  assert.throws(() => store.resolveStoredPath('sha256/aa/../../escape'), /traversal|contain/i)
  assert.throws(() => store.resolveStoredPath('sha256\\aa\\file'), /separator|stored path/i)
  assert.throws(
    () => store.resolveStoredPath(join(root, 'sha256', 'aa')),
    /absolute|relative|separator/i,
  )

  const valid = store.resolveStoredPath(`sha256/aa/${'a'.repeat(64)}`)
  assert.equal(isAbsolute(valid), true)
  assert.equal(relative(root, valid).startsWith('..'), false)
})

test('content paths reject a symlink or junction that leaves the asset root', (t) => {
  const { directory, root, store } = makeFixture(t)
  const outside = join(directory, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  try {
    symlinkSync(outside, join(root, 'sha256'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symlink/junction creation unavailable: ${error.code}`)
      return
    }
    throw error
  }

  assert.throws(
    () => store.resolveStoredPath(`sha256/aa/${'a'.repeat(64)}`),
    /symbolic|junction|contain|link/i,
  )
})

test('source files must be regular files inside an explicitly allowed real root', (t) => {
  const { directory, root } = makeFixture(t)
  const allowedRoot = join(directory, 'allowed')
  const outsideRoot = join(directory, 'outside')
  mkdirSync(allowedRoot)
  mkdirSync(outsideRoot)
  const allowed = join(allowedRoot, 'ok.bin')
  const outside = join(outsideRoot, 'outside.bin')
  writeFileSync(allowed, 'ok')
  writeFileSync(outside, 'outside')
  const store = createContentStore({ root, allowedSourceRoots: [allowedRoot] })

  assert.doesNotThrow(() =>
    store.putSource({
      sourcePath: allowed,
      expectedSha256: sha256(Buffer.from('ok')),
      expectedSize: 2,
      expectedRawSha256: sha256(Buffer.from('ok')),
      expectedRawSize: 2,
      dryRun: true,
    }),
  )
  assert.throws(
    () =>
      store.putSource({
        sourcePath: outside,
        expectedSha256: sha256(Buffer.from('outside')),
        expectedSize: 7,
        expectedRawSha256: sha256(Buffer.from('outside')),
        expectedRawSize: 7,
        dryRun: true,
      }),
    /allowed source root|contain|outside/i,
  )
})

test('putSource fails closed when no allowed source root was configured', (t) => {
  const { directory, root, source } = makeFixture(t)
  const bytes = Buffer.from('explicit roots only')
  writeFileSync(source, bytes)
  const store = createContentStore({ root: join(directory, 'unscoped-assets') })

  assert.throws(
    () =>
      store.putSource({
        sourcePath: source,
        expectedSha256: sha256(bytes),
        expectedSize: bytes.length,
        hashMode: 'raw',
        kind: 'rom',
        dryRun: true,
      }),
    /allowed source root|required/i,
  )
})

test('LF-normalized text is verified and stored as canonical LF bytes', (t) => {
  const { root, source, store } = makeFixture(t)
  const original = Buffer.from('alpha\r\nbeta\r\n', 'utf8')
  const canonical = Buffer.from('alpha\nbeta\n', 'utf8')
  writeFileSync(source, original)

  assert.deepEqual(
    canonicalizeContentBytes(original, 'lf-normalized-text'),
    canonical,
  )
  const result = store.putSource({
    sourcePath: source,
    expectedSha256: sha256(canonical),
    expectedSize: canonical.length,
    expectedRawSha256: sha256(original),
    expectedRawSize: original.length,
    hashMode: 'lf-normalized-text',
    kind: 'core_js',
  })

  assert.equal(result.created, true)
  assert.equal(result.existing, false)
  assert.equal(result.sha256, sha256(canonical))
  assert.equal(result.rawSha256, sha256(original))
  assert.equal(result.rawFileSize, original.length)
  assert.equal(result.filePath, `sha256/${result.sha256.slice(0, 2)}/${result.sha256}`)
  assert.deepEqual(readFileSync(result.absolutePath), canonical)
  assert.deepEqual(readFileSync(source), original, 'source bytes must never be changed')
  assert.deepEqual(
    allFiles(root).filter((path) => /\.tmp-|\.lock$/i.test(path)),
    [],
  )

  assert.throws(
    () =>
      store.putSource({
        sourcePath: source,
        expectedSha256: sha256(canonical),
        expectedSize: canonical.length,
        expectedRawSha256: 'f'.repeat(64),
        expectedRawSize: original.length,
        hashMode: 'lf-normalized-text',
        kind: 'core_js',
      }),
    /raw.*sha-?256|raw.*hash mismatch/i,
  )
})

test('raw content remains byte exact and dry-run performs no filesystem writes', (t) => {
  const { root, source, store } = makeFixture(t)
  const bytes = Buffer.from([0, 13, 10, 255, 4])
  writeFileSync(source, bytes)

  const planned = store.putSource({
    sourcePath: source,
    expectedSha256: sha256(bytes),
    expectedSize: bytes.length,
    hashMode: 'raw',
    kind: 'rom',
    dryRun: true,
  })

  assert.equal(planned.created, false)
  assert.equal(planned.existing, false)
  assert.equal(planned.wouldCreate, true)
  assert.equal(existsSync(root), false)

  const stored = store.putSource({
    sourcePath: source,
    expectedSha256: sha256(bytes),
    expectedSize: bytes.length,
    hashMode: 'raw',
    kind: 'rom',
  })
  assert.deepEqual(readFileSync(stored.absolutePath), bytes)
})

test('dedupe reverifies existing bytes and never overwrites a content object', (t) => {
  const { directory, source, store } = makeFixture(t)
  const firstSource = Buffer.from('same bytes\r\n')
  const canonical = Buffer.from('same bytes\n')
  writeFileSync(source, firstSource)
  const first = store.putSource({
    sourcePath: source,
    expectedSha256: sha256(canonical),
    expectedSize: canonical.length,
    hashMode: 'lf-normalized-text',
    kind: 'core_js',
  })
  const originalStat = lstatSync(first.absolutePath)

  const secondSource = join(directory, 'second.js')
  writeFileSync(secondSource, canonical)
  const second = store.putSource({
    sourcePath: secondSource,
    expectedSha256: sha256(canonical),
    expectedSize: canonical.length,
    hashMode: 'lf-normalized-text',
    kind: 'core_js',
  })
  assert.equal(second.created, false)
  assert.equal(second.existing, true)
  assert.equal(second.absolutePath, first.absolutePath)
  assert.equal(lstatSync(first.absolutePath).mtimeMs, originalStat.mtimeMs)

  const corrupted = Buffer.from('corrupt')
  writeFileSync(first.absolutePath, corrupted)
  assert.throws(
    () =>
      store.putSource({
        sourcePath: secondSource,
        expectedSha256: sha256(canonical),
        expectedSize: canonical.length,
        hashMode: 'lf-normalized-text',
        kind: 'core_js',
      }),
    /existing.*hash|content object.*mismatch/i,
  )
  assert.deepEqual(readFileSync(first.absolutePath), corrupted)
})

test('a writer never removes a content lock it did not acquire', (t) => {
  const { root, source, store } = makeFixture(t)
  const bytes = Buffer.from('locked payload')
  const contentSha = sha256(bytes)
  const directory = join(root, 'sha256', contentSha.slice(0, 2))
  const lockPath = join(directory, `.${contentSha}.lock`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(lockPath, 'owned by another writer')
  writeFileSync(source, bytes)

  assert.throws(
    () =>
      store.putSource({
        sourcePath: source,
        expectedSha256: contentSha,
        expectedSize: bytes.length,
        hashMode: 'raw',
        kind: 'rom',
      }),
    /EEXIST|lock/i,
  )
  assert.equal(existsSync(lockPath), true)
})

test('hash or size mismatch leaves no target or temporary file', (t) => {
  const { root, source, store } = makeFixture(t)
  const bytes = Buffer.from('payload')
  writeFileSync(source, bytes)

  assert.throws(
    () =>
      store.putSource({
        sourcePath: source,
        expectedSha256: '0'.repeat(64),
        expectedSize: bytes.length,
        hashMode: 'raw',
        kind: 'rom',
      }),
    /sha-?256|hash mismatch/i,
  )
  assert.deepEqual(allFiles(root), [])

  assert.throws(
    () =>
      store.putSource({
        sourcePath: source,
        expectedSha256: sha256(bytes),
        expectedSize: bytes.length + 1,
        hashMode: 'raw',
        kind: 'rom',
      }),
    /size/i,
  )
  assert.deepEqual(allFiles(root), [])
})

test('cleanup removes only newly-created, unreferenced objects', (t) => {
  const { directory, source, store } = makeFixture(t)
  const existingBytes = Buffer.from('existing')
  writeFileSync(source, existingBytes)
  const existing = store.putSource({
    sourcePath: source,
    expectedSha256: sha256(existingBytes),
    expectedSize: existingBytes.length,
    hashMode: 'raw',
    kind: 'rom',
  })
  const repeat = store.putSource({
    sourcePath: source,
    expectedSha256: sha256(existingBytes),
    expectedSize: existingBytes.length,
    hashMode: 'raw',
    kind: 'rom',
  })

  const createdSource = join(directory, 'created.bin')
  const createdBytes = Buffer.from('created')
  writeFileSync(createdSource, createdBytes)
  const created = store.putSource({
    sourcePath: createdSource,
    expectedSha256: sha256(createdBytes),
    expectedSize: createdBytes.length,
    hashMode: 'raw',
    kind: 'rom',
  })

  const removed = store.cleanupCreated([repeat, created], {
    isReferenced: ({ sha256: contentSha }) => contentSha === created.sha256,
  })
  assert.deepEqual(removed, [])
  assert.equal(existsSync(existing.absolutePath), true)
  assert.equal(existsSync(created.absolutePath), true)

  const removedLater = store.cleanupCreated([repeat, created], {
    isReferenced: () => false,
  })
  assert.deepEqual(removedLater, [created.filePath])
  assert.equal(existsSync(existing.absolutePath), true, 'pre-existing object must remain')
  assert.equal(existsSync(created.absolutePath), false)
})
