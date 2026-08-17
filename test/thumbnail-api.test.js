import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'

import Database from 'better-sqlite3'
import { Hono } from 'hono'

import {
  applyMigrationEntries,
  loadMigrationManifest,
} from '../server/db/migration-runner.js'
import { contractLibraryDatabase } from '../server/db/contract-runner.js'
import { countAssetReferences } from '../server/services/library-service.js'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'thumbnail-api-'))
const databasePath = join(fixtureDirectory, 'app.db')
const assetRoot = join(fixtureDirectory, 'library-assets')

process.env.DB_PATH = databasePath
process.env.LIBRARY_ASSET_ROOT = assetRoot

const fixture = await createFixture()
const [{ romRoutes }, { db }] = await Promise.all([
  import('../server/routes/roms.js'),
  import('../server/db/index.js'),
])

const app = new Hono()
app.route('/api/roms', romRoutes)

after(() => {
  db.$client?.close?.()
  rmSync(fixtureDirectory, { recursive: true, force: true })
})

function addAsset(sqlite, { id, kind, bytes, mimeType }) {
  const buffer = Buffer.from(bytes)
  const hash = sha256(buffer)
  const filePath = `sha256/${hash.slice(0, 2)}/${hash}`
  const absolutePath = join(assetRoot, filePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, buffer)
  sqlite.prepare(`
    INSERT INTO assets (id, kind, file_path, mime_type, file_size, sha256)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, kind, filePath, mimeType, buffer.length, hash)
  return { id, bytes: buffer, hash }
}

function insertRom(sqlite, {
  id,
  title,
  setName,
  isPublic = true,
  parentRomId = null,
  versionLabel = null,
  variantKind = 'official',
}) {
  sqlite.prepare(`
    INSERT INTO roms
      (id, user_id, title, platform, file_name, file_path, file_size,
       is_public, parent_rom_id, set_name_normalized, variant_kind,
       dat_parent_set_name, family_root_set_name, version_label, status,
       created_at, updated_at)
    VALUES (?, 1, ?, 'arcade', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    title,
    `${setName}.zip`,
    `legacy/${setName}.zip`,
    isPublic ? 1 : 0,
    parentRomId,
    setName,
    variantKind,
    parentRomId ? 'exact_set' : null,
    parentRomId ? 'exact_set' : setName,
    versionLabel,
    id,
    id,
  )
}

function insertReadyBuild(sqlite, { id, romId, archive, coreFingerprint }) {
  sqlite.prepare(`
    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256,
       content_manifest_sha256, build_fingerprint, static_status, archive_layout)
    VALUES (?, ?, 10, ?, ?, ?, ?, 'complete', 'standalone')
  `).run(
    id,
    romId,
    archive.id,
    archive.hash,
    sha256(`manifest:${id}`),
    sha256(`build:${id}`),
  )
  sqlite.prepare(`
    INSERT INTO build_validation_runs
      (rom_build_id, browser_sha256, harness_version, core_artifact_fingerprint,
       result, acceptance, accepted_at, accepted_by, policy_version)
    VALUES (?, ?, 'thumbnail-test', ?, 'passed', 'accepted', unixepoch(), 1, 'test-v1')
  `).run(id, sha256(`browser:${id}`), coreFingerprint)
  sqlite.prepare('UPDATE roms SET active_build_id = ? WHERE id = ?').run(id, romId)
}

function insertThumbnailRef(sqlite, {
  id,
  romId,
  asset,
  matchKind,
  sourceSetName,
  active = true,
}) {
  sqlite.prepare(`
    INSERT INTO rom_asset_refs
      (id, rom_id, asset_id, match_kind, source_set_name, source_file_sha256)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, romId, asset.id, matchKind, sourceSetName, asset.hash)
  if (active) {
    sqlite.prepare('UPDATE roms SET active_thumbnail_ref_id = ? WHERE id = ?').run(id, romId)
  }
}

async function createFixture() {
  const sqlite = new Database(databasePath)
  const manifest = loadMigrationManifest()
  applyMigrationEntries(sqlite, manifest.slice(0, 2), { manifestEntries: manifest })
  sqlite.prepare("UPDATE library_migration_state SET phase = 'backfilled' WHERE id = 1").run()
  sqlite.close()

  await contractLibraryDatabase({
    dbPath: databasePath,
    backupPath: join(fixtureDirectory, 'pre-contract.sqlite'),
  })

  const contracted = new Database(databasePath)
  contracted.pragma('foreign_keys = ON')
  contracted.exec(`
    INSERT INTO users (id, username, password_hash, role, status)
    VALUES (1, 'owner', 'hash', 'user', 1);

    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (1, 'owner-token', unixepoch() + 3600);
  `)

  const coreJs = addAsset(contracted, {
    id: 1,
    kind: 'core_js',
    bytes: 'thumbnail-test-js',
    mimeType: 'application/javascript',
  })
  const coreWasm = addAsset(contracted, {
    id: 2,
    kind: 'core_wasm',
    bytes: 'thumbnail-test-wasm',
    mimeType: 'application/wasm',
  })
  const archive = addAsset(contracted, {
    id: 3,
    kind: 'rom',
    bytes: 'thumbnail-test-rom',
    mimeType: 'application/zip',
  })
  const sharedThumbnail = addAsset(contracted, {
    id: 4,
    kind: 'thumbnail',
    bytes: 'shared-webp-thumbnail',
    mimeType: 'image/webp',
  })
  const retiredThumbnail = addAsset(contracted, {
    id: 5,
    kind: 'thumbnail',
    bytes: 'retired-webp-thumbnail',
    mimeType: 'image/webp',
  })
  const wrongKindAsset = addAsset(contracted, {
    id: 6,
    kind: 'rom',
    bytes: 'not-a-thumbnail',
    mimeType: 'application/zip',
  })
  const coreFingerprint = sha256('thumbnail-test-core')

  contracted.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, artifact_fingerprint, provenance_json, is_enabled)
    VALUES (10, 'fbneo', '1.0.0', ?, ?, ?, ?, ?, '{}', 1)
  `).run(coreJs.id, coreJs.hash, coreWasm.id, coreWasm.hash, coreFingerprint)

  const rows = [
    { id: 101, title: 'Exact Set', setName: 'exact_set', matchKind: 'exact', source: 'exact_set' },
    { id: 102, title: 'Alias Set', setName: 'alias_set', matchKind: 'alias', source: 'legacy_alias' },
    {
      id: 103,
      title: 'Parent Fallback',
      setName: 'parent_set',
      parentRomId: 101,
      versionLabel: 'World clone',
      matchKind: 'parent',
      source: 'exact_set',
    },
    {
      id: 104,
      title: 'Source Reference',
      setName: 'source_set',
      matchKind: 'source_reference',
      source: 'reference_only',
    },
    { id: 105, title: 'Wrong Kind', setName: 'wrong_kind', matchKind: 'exact', source: 'wrong_kind' },
  ]

  for (const row of rows) {
    insertRom(contracted, row)
    insertReadyBuild(contracted, {
      id: 1000 + row.id,
      romId: row.id,
      archive,
      coreFingerprint,
    })
  }

  for (const row of [
    { id: 106, title: 'Shared Private A', setName: 'shared_private_a', isPublic: false },
    { id: 107, title: 'Shared Private B', setName: 'shared_private_b', isPublic: false },
  ]) {
    insertRom(contracted, row)
  }

  insertThumbnailRef(contracted, {
    id: 2000,
    romId: 101,
    asset: retiredThumbnail,
    matchKind: 'exact',
    sourceSetName: 'retired_exact',
    active: false,
  })
  for (const [index, row] of rows.slice(0, 4).entries()) {
    insertThumbnailRef(contracted, {
      id: 2001 + index,
      romId: row.id,
      asset: sharedThumbnail,
      matchKind: row.matchKind,
      sourceSetName: row.source,
    })
  }
  insertThumbnailRef(contracted, {
    id: 2005,
    romId: 105,
    asset: wrongKindAsset,
    matchKind: 'exact',
    sourceSetName: 'wrong_kind',
  })
  insertThumbnailRef(contracted, {
    id: 2006,
    romId: 106,
    asset: sharedThumbnail,
    matchKind: 'source_reference',
    sourceSetName: 'shared_reference',
  })
  insertThumbnailRef(contracted, {
    id: 2007,
    romId: 107,
    asset: sharedThumbnail,
    matchKind: 'source_reference',
    sourceSetName: 'shared_reference',
  })

  contracted.close()
  return { archive, retiredThumbnail, sharedThumbnail, wrongKindAsset }
}

async function request(path, { method = 'GET', token } = {}) {
  return app.request(path, {
    method,
    headers: token ? { cookie: `session=${token}` } : undefined,
  })
}

test('public rows expose full-SHA active thumbnail URLs and preserve match evidence', async () => {
  const response = await request('/api/roms/public')
  assert.equal(response.status, 200)
  const { roms } = await response.json()

  const evidence = new Map(roms.filter((rom) => rom.id <= 104).map((rom) => [rom.thumbnailMatchKind, {
    source: rom.thumbnailSourceSetName,
    url: rom.thumbnailUrl,
  }]))
  assert.deepEqual([...evidence.keys()].sort(), ['alias', 'exact', 'parent', 'source_reference'])
  assert.equal(evidence.get('exact').source, 'exact_set')
  assert.equal(evidence.get('alias').source, 'legacy_alias')
  assert.equal(evidence.get('parent').source, 'exact_set')
  assert.equal(evidence.get('source_reference').source, 'reference_only')
  for (const { url } of evidence.values()) {
    assert.match(url, /^\/api\/roms\/\d+\/thumbnail\?v=[0-9a-f]{64}$/)
    assert.ok(url.endsWith(fixture.sharedThumbnail.hash))
  }
})

test('thumbnail endpoint serves only the active content hash with immutable caching', async () => {
  const activeUrl = `/api/roms/101/thumbnail?v=${fixture.sharedThumbnail.hash}`
  const active = await request(activeUrl)
  assert.equal(active.status, 200)
  assert.equal(active.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(active.headers.get('etag'), `"${fixture.sharedThumbnail.hash}"`)
  assert.equal(active.headers.get('content-type'), 'image/webp')
  assert.deepEqual(Buffer.from(await active.arrayBuffer()), fixture.sharedThumbnail.bytes)

  const retired = await request(`/api/roms/101/thumbnail?v=${fixture.retiredThumbnail.hash}`)
  assert.equal(retired.status, 404)
  const mismatch = await request(`/api/roms/101/thumbnail?v=${'f'.repeat(64)}`)
  assert.equal(mismatch.status, 404)
  const truncated = await request(`/api/roms/101/thumbnail?v=${fixture.sharedThumbnail.hash.slice(0, 32)}`)
  assert.equal(truncated.status, 404)
})

test('private active thumbnails use private immutable caching and retain authorization', async () => {
  const url = `/api/roms/106/thumbnail?v=${fixture.sharedThumbnail.hash}`
  const owner = await request(url, { token: 'owner-token' })
  assert.equal(owner.status, 200)
  assert.equal(owner.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  await owner.arrayBuffer()

  const guest = await request(url)
  assert.equal(guest.status, 401)
})

test('non-thumbnail assets are never serialized or served through the thumbnail route', async () => {
  const listing = await request('/api/roms/public')
  const { roms } = await listing.json()
  const wrongKind = roms.find((rom) => rom.id === 105)
  assert.equal(wrongKind.thumbnailUrl, null)
  assert.equal(wrongKind.thumbnailMatchKind, null)

  const response = await request(`/api/roms/105/thumbnail?v=${fixture.wrongKindAsset.hash}`)
  assert.equal(response.status, 404)
})

test('shared thumbnail assets retain accurate refcounts when one ROM is deleted', async () => {
  assert.equal(countAssetReferences(db.$client, fixture.sharedThumbnail.id), 6)

  const deleted = await request('/api/roms/106?permanent=1', {
    method: 'DELETE',
    token: 'owner-token',
  })
  assert.equal(deleted.status, 200)
  assert.equal(countAssetReferences(db.$client, fixture.sharedThumbnail.id), 5)
  assert.equal(
    db.$client.prepare('SELECT COUNT(*) AS n FROM assets WHERE id = ?')
      .get(fixture.sharedThumbnail.id).n,
    1,
  )

  const remaining = await request(`/api/roms/104/thumbnail?v=${fixture.sharedThumbnail.hash}`)
  assert.equal(remaining.status, 200)
  await remaining.arrayBuffer()
})
