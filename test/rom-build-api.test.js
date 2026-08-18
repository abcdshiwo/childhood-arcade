import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'

import Database from 'better-sqlite3'
import { Hono } from 'hono'

import { createContentStore } from '../server/services/content-store.js'
import {
  applyMigrationEntries,
  loadMigrationManifest,
} from '../server/db/migration-runner.js'
import { contractLibraryDatabase } from '../server/db/contract-runner.js'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'rom-build-api-'))
const databasePath = join(fixtureDirectory, 'app.db')
const assetRoot = join(fixtureDirectory, 'library-assets')

process.env.DB_PATH = databasePath
process.env.LIBRARY_ASSET_ROOT = assetRoot
process.env.SAVES_DIR = join(fixtureDirectory, 'saves')
process.env.MAX_UPLOAD_BYTES = '8'

let fixture
fixture = await createFixture()

const [
  { romRoutes, romBuildRoutes },
  { coreRoutes },
  { biosRoutes },
  { adminRoutes },
  { roomRoutes },
  { saveRoutes },
] =
  await Promise.all([
    import('../server/routes/roms.js'),
    import('../server/routes/cores.js'),
    import('../server/routes/bios.js'),
    import('../server/routes/admin.js'),
    import('../server/routes/rooms.js'),
    import('../server/routes/saves.js'),
  ])

const app = new Hono()
app.route('/api/roms', romRoutes)
app.route('/api/rom-builds', romBuildRoutes ?? new Hono())
app.route('/api/cores', coreRoutes)
app.route('/api/bios', biosRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/rooms', roomRoutes)
app.route('/api/saves', saveRoutes)

const { db } = await import('../server/db/index.js')

after(() => {
  db.$client?.close?.()
  rmSync(fixtureDirectory, { recursive: true, force: true })
})

function assetPath(sha) {
  return join(assetRoot, 'sha256', sha.slice(0, 2), sha)
}

function addAsset(sqlite, { id, kind, bytes, mimeType = 'application/octet-stream' }) {
  const buffer = Buffer.from(bytes)
  const sha = sha256(buffer)
  const filePath = `sha256/${sha.slice(0, 2)}/${sha}`
  const absolutePath = assetPath(sha)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, buffer)
  sqlite.prepare(`
    INSERT INTO assets (id, kind, file_path, mime_type, file_size, sha256)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, kind, filePath, mimeType, buffer.length, sha)
  return { id, bytes: buffer, sha, filePath, fileSize: buffer.length, mimeType }
}

function insertRom(sqlite, {
  id,
  userId = 1,
  title,
  setName,
  isPublic,
  parentRomId = null,
  versionLabel = null,
  variantKind = null,
}) {
  sqlite.prepare(`
    INSERT INTO roms
      (id, user_id, title, platform, file_name, file_path, file_size,
       is_public, parent_rom_id, set_name_normalized, variant_kind,
       dat_parent_set_name, family_root_set_name, version_label, status,
       created_at, updated_at)
    VALUES (?, ?, ?, 'arcade', ?, ?, 999999, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    userId,
    title,
    `${setName}.zip`,
    `legacy/${setName}.zip`,
    isPublic ? 1 : 0,
    parentRomId,
    setName,
    variantKind,
    parentRomId ? 'parent' : null,
    parentRomId ? 'parent' : setName,
    versionLabel,
    id,
    id,
  )
}

function insertBuild(sqlite, {
  id,
  romId,
  coreArtifactId,
  archive,
  layout = 'standalone',
  parentBuildId = null,
  acceptedResult = null,
}) {
  const buildFingerprint = sha256(`build:${id}`)
  sqlite.prepare(`
    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256,
       content_manifest_sha256, build_fingerprint, static_status,
       archive_layout, runtime_parent_build_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
  `).run(
    id,
    romId,
    coreArtifactId,
    archive.id,
    archive.sha,
    sha256(`manifest:${id}`),
    buildFingerprint,
    layout,
    parentBuildId,
  )
  sqlite.prepare('UPDATE roms SET active_build_id = ? WHERE id = ?').run(id, romId)
  if (acceptedResult) {
    sqlite.prepare(`
      INSERT INTO build_validation_runs
        (rom_build_id, browser_sha256, harness_version,
         core_artifact_fingerprint, result, acceptance, accepted_at,
         accepted_by, policy_version)
      VALUES (?, ?, 'test-harness', ?, ?, 'accepted', unixepoch(), 3, 'test-v1')
    `).run(
      id,
      sha256(`browser:${id}`),
      fixture.coreFingerprints.get(coreArtifactId),
      acceptedResult,
    )
  }
  return { id, buildFingerprint }
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
    VALUES
      (1, 'owner', 'hash', 'user', 1),
      (2, 'stranger', 'hash', 'user', 1),
      (3, 'admin', 'hash', 'admin', 1);

    INSERT INTO sessions (user_id, token, expires_at)
    VALUES
      (1, 'owner-token', unixepoch() + 3600),
      (2, 'stranger-token', unixepoch() + 3600),
      (3, 'admin-token', unixepoch() + 3600);

    INSERT INTO settings (key, value) VALUES ('guestPlayEnabled', '0');
  `)

  const fbneoJs = addAsset(contracted, {
    id: 1,
    kind: 'core_js',
    bytes: 'fbneo-js',
    mimeType: 'application/javascript',
  })
  const fbneoWasm = addAsset(contracted, {
    id: 2,
    kind: 'core_wasm',
    bytes: 'fbneo-wasm',
    mimeType: 'application/wasm',
  })
  const mameJs = addAsset(contracted, {
    id: 3,
    kind: 'core_js',
    bytes: 'mame-js',
    mimeType: 'application/javascript',
  })
  const mameWasm = addAsset(contracted, {
    id: 4,
    kind: 'core_wasm',
    bytes: 'mame-wasm',
    mimeType: 'application/wasm',
  })
  const pcsxJs = addAsset(contracted, {
    id: 8,
    kind: 'core_js',
    bytes: 'pcsx-js',
    mimeType: 'application/javascript',
  })
  const pcsxWasm = addAsset(contracted, {
    id: 9,
    kind: 'core_wasm',
    bytes: 'pcsx-wasm',
    mimeType: 'application/wasm',
  })
  const biosMember = addAsset(contracted, {
    id: 5,
    kind: 'bios',
    bytes: 'exact-neogeo-bios',
    mimeType: 'application/zip',
  })
  const biosManifest = addAsset(contracted, {
    id: 6,
    kind: 'bios_manifest',
    bytes: JSON.stringify({ members: [{ fileName: 'neogeo.zip', sha256: biosMember.sha }] }),
    mimeType: 'application/json',
  })
  const thumbnail = addAsset(contracted, {
    id: 7,
    kind: 'thumbnail',
    bytes: 'webp-thumbnail',
    mimeType: 'image/webp',
  })

  const coreFingerprints = new Map([
    [10, sha256('core:fbneo')],
    [20, sha256('core:mame')],
  ])

  contracted.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, dat_asset_id, dat_sha256, bios_asset_id,
       bios_manifest_sha256, artifact_fingerprint, provenance_json, is_enabled)
    VALUES
      (10, 'fbneo', '1.0.0.03', 'fbneo-commit', ?, ?, ?, ?, NULL, NULL,
       NULL, NULL, ?, '{}', 1),
      (20, 'mame2003_plus', '62c7089', 'mame-commit', ?, ?, ?, ?, NULL, NULL,
       ?, ?, ?, ?, 1),
      (30, 'pcsx_rearmed', '1.0.0', 'pcsx-commit', ?, ?, ?, ?, NULL, NULL,
       NULL, NULL, ?, '{}', 1)
  `).run(
    fbneoJs.id,
    fbneoJs.sha,
    fbneoWasm.id,
    fbneoWasm.sha,
    coreFingerprints.get(10),
    mameJs.id,
    mameJs.sha,
    mameWasm.id,
    mameWasm.sha,
    biosManifest.id,
    biosManifest.sha,
    coreFingerprints.get(20),
    JSON.stringify({
      bios: {
        manifestAssetId: biosManifest.id,
        manifestSha256: biosManifest.sha,
        members: [{
          fileName: 'neogeo.zip',
          assetId: biosMember.id,
          sha256: biosMember.sha,
          fileSize: biosMember.fileSize,
          mimeType: biosMember.mimeType,
        }],
      },
    }),
    pcsxJs.id,
    pcsxJs.sha,
    pcsxWasm.id,
    pcsxWasm.sha,
    coreFingerprints.set(30, sha256('core:pcsx')).get(30),
  )

  const archiveById = new Map()
  for (const [id, bytes] of [
    [20, 'parent-rom'],
    [21, 'child-rom'],
    [22, 'unverified-rom'],
    [23, 'private-rom'],
    [24, 'stranger-rom'],
    [25, 'retired-room-rom'],
    [26, 'current-room-rom'],
    [27, 'retired-hidden-rom'],
    [28, 'delete-rom'],
  ]) {
    archiveById.set(id, addAsset(contracted, { id, kind: 'rom', bytes }))
  }

  const result = {
    sqlite: contracted,
    coreFingerprints,
    core: { fbneoJs, fbneoWasm, mameJs, mameWasm, pcsxJs, pcsxWasm, biosMember, biosManifest },
    thumbnail,
    archiveById,
  }
  fixture = result

  insertRom(contracted, {
    id: 101,
    title: 'Ready Parent',
    setName: 'parent',
    isPublic: true,
  })
  insertBuild(contracted, {
    id: 1001,
    romId: 101,
    coreArtifactId: 20,
    archive: archiveById.get(20),
    acceptedResult: 'passed',
  })

  insertRom(contracted, {
    id: 102,
    title: 'Ready Split Clone',
    setName: 'child',
    isPublic: true,
    parentRomId: 101,
    versionLabel: 'Clone',
    variantKind: 'official',
  })
  insertBuild(contracted, {
    id: 1002,
    romId: 102,
    coreArtifactId: 20,
    archive: archiveById.get(21),
    layout: 'split',
    parentBuildId: 1001,
    acceptedResult: 'passed',
  })

  insertRom(contracted, {
    id: 103,
    title: 'Public Flag But Unverified',
    setName: 'unverified',
    isPublic: true,
  })
  insertBuild(contracted, {
    id: 1003,
    romId: 103,
    coreArtifactId: 10,
    archive: archiveById.get(22),
  })

  insertRom(contracted, {
    id: 104,
    title: 'Private Unverified',
    setName: 'private',
    isPublic: false,
  })
  insertBuild(contracted, {
    id: 1004,
    romId: 104,
    coreArtifactId: 10,
    archive: archiveById.get(23),
  })

  insertRom(contracted, {
    id: 105,
    userId: 2,
    title: 'Other Private',
    setName: 'other_private',
    isPublic: false,
  })
  insertBuild(contracted, {
    id: 1005,
    romId: 105,
    coreArtifactId: 10,
    archive: archiveById.get(24),
  })

  insertRom(contracted, {
    id: 106,
    title: 'Room Locked Build',
    setName: 'room_game',
    isPublic: false,
  })
  insertBuild(contracted, {
    id: 1006,
    romId: 106,
    coreArtifactId: 10,
    archive: archiveById.get(25),
  })
  insertBuild(contracted, {
    id: 1008,
    romId: 106,
    coreArtifactId: 10,
    archive: archiveById.get(27),
  })
  insertBuild(contracted, {
    id: 1007,
    romId: 106,
    coreArtifactId: 10,
    archive: archiveById.get(26),
  })
  contracted.prepare(`
    INSERT INTO rooms
      (code, host_user_id, rom_id, rom_build_id, name, is_public,
       allow_play, status, closed_at)
    VALUES ('LOCKED', 1, 106, 1006, 'Locked Room', 0, 1, 1, NULL)
  `).run()

  insertRom(contracted, {
    id: 107,
    title: 'Disposable',
    setName: 'disposable',
    isPublic: false,
  })
  insertBuild(contracted, {
    id: 1009,
    romId: 107,
    coreArtifactId: 10,
    archive: archiveById.get(28),
  })

  insertRom(contracted, {
    id: 108,
    title: 'Shared BIOS Bytes',
    setName: 'shared_bios_bytes',
    isPublic: false,
  })
  insertBuild(contracted, {
    id: 1010,
    romId: 108,
    coreArtifactId: 10,
    archive: biosMember,
  })

  contracted.prepare(`
    INSERT INTO rom_asset_refs
      (id, rom_id, asset_id, match_kind, source_set_name, source_file_sha256)
    VALUES (2001, 101, ?, 'exact', 'parent', ?)
  `).run(thumbnail.id, thumbnail.sha)
  contracted.prepare('UPDATE roms SET active_thumbnail_ref_id = 2001 WHERE id = 101').run()
  contracted.prepare(`
    INSERT INTO import_batches
      (id, owner_user_id, cold_source_sha256, manifest_sha256,
       planned_count, actual_count, total_bytes, status)
    VALUES ('experimental-batch', 1, ?, ?, 1, 1, ?, 'committed_private')
  `).run(sha256('experimental-cold-source'), sha256('experimental-manifest'), archiveById.get(22).fileSize)
  contracted.prepare(`
    INSERT INTO batch_build_refs (import_batch_id, rom_build_id)
    VALUES ('experimental-batch', 1003)
  `).run()
  contracted.prepare(`
    INSERT INTO rom_asset_refs
      (id, rom_id, asset_id, match_kind, source_set_name, source_file_sha256,
       import_batch_id)
    VALUES (2002, 103, ?, 'exact', 'unverified', ?, 'experimental-batch')
  `).run(thumbnail.id, thumbnail.sha)
  contracted.prepare('UPDATE roms SET active_thumbnail_ref_id = 2002 WHERE id = 103').run()
  contracted.close()
  return result
}

function authHeaders(token, headers = {}) {
  return token ? { cookie: `session=${token}`, ...headers } : headers
}

async function request(path, { token, method = 'GET', body, headers = {} } = {}) {
  const options = { method, headers: authHeaders(token, headers) }
  if (body !== undefined) {
    if (body instanceof FormData) options.body = body
    else {
      options.headers['content-type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
  }
  return app.request(path, options)
}

async function json(path, options) {
  const response = await request(path, options)
  return { response, data: await response.json() }
}

test('public listing exposes only accepted ready active builds with exact metadata', async () => {
  const { response, data } = await json('/api/roms/public')
  assert.equal(response.status, 200)
  assert.deepEqual(data.roms.map((rom) => rom.id), [102, 101])

  const parent = data.roms.find((rom) => rom.id === 101)
  assert.equal(parent.setName, 'parent')
  assert.equal(parent.buildId, 1001)
  assert.equal(parent.coreName, 'mame2003_plus')
  assert.equal(parent.coreVersion, '62c7089')
  assert.equal(parent.compatStatus, 'ready')
  assert.equal(parent.archiveLayout, 'standalone')
  assert.equal(parent.fileName, 'parent.zip')
  assert.equal(parent.fileSize, fixture.archiveById.get(20).fileSize)
  assert.equal('filePath' in parent, false, 'legacy disk paths must never be serialized')
  assert.equal(parent.activeBuild.id, 1001)
  assert.equal(parent.activeBuild.core.artifactFingerprint, fixture.coreFingerprints.get(20))
  assert.match(parent.thumbnailUrl, new RegExp(`\\?v=${fixture.thumbnail.sha}$`))
  assert.equal(parent.thumbnailMatchKind, 'exact')
})

test('owners and admins can see private unverified builds while strangers cannot', async () => {
  const mine = await json('/api/roms/mine', { token: 'owner-token' })
  assert.equal(mine.response.status, 200)
  const privateRom = mine.data.roms.find((rom) => rom.id === 104)
  assert.equal(privateRom.compatStatus, 'unverified')
  assert.equal(privateRom.buildId, 1004)
  assert.equal(privateRom.isPublic, false)

  const denied = await request('/api/rom-builds/1004', { token: 'stranger-token' })
  assert.equal(denied.status, 403)

  const admin = await json('/api/admin/roms', { token: 'admin-token' })
  assert.equal(admin.response.status, 200)
  const adminPrivate = admin.data.roms.find((rom) => rom.id === 104)
  assert.equal(adminPrivate.compatStatus, 'unverified')
  assert.equal(adminPrivate.activeBuild.id, 1004)
})

test('experimental publication exposes only imported unverified builds without forging readiness', async () => {
  process.env.ARCADE_EXPERIMENTAL_UNVERIFIED = '1'
  db.$client.prepare('UPDATE roms SET is_public = 1 WHERE id = 104').run()
  try {
    const { response, data } = await json('/api/roms/public')
    assert.equal(response.status, 200)

    const experimental = data.roms.find((rom) => rom.id === 103)
    assert.ok(experimental)
    assert.equal(experimental.compatStatus, 'unverified')
    assert.equal(experimental.publicationMode, 'experimental')
    assert.equal(experimental.activeBuild.id, 1003)
    assert.equal(data.roms.some((rom) => rom.id === 104), false)
  } finally {
    delete process.env.ARCADE_EXPERIMENTAL_UNVERIFIED
    db.$client.prepare('UPDATE roms SET is_public = 0 WHERE id = 104').run()
  }

  const strict = await json('/api/roms/public')
  assert.equal(strict.data.roms.some((rom) => rom.id === 103), false)
})

test('experimental publication authorizes imported build files and thumbnails only while enabled', async () => {
  process.env.ARCADE_EXPERIMENTAL_UNVERIFIED = '1'
  try {
    const build = await json('/api/rom-builds/1003', { token: 'stranger-token' })
    assert.equal(build.response.status, 200)
    assert.equal(build.data.build.compatStatus, 'unverified')
    assert.equal(build.data.build.publicationMode, 'experimental')

    const thumbnail = await request(`/api/roms/103/thumbnail?v=${fixture.thumbnail.sha}`)
    assert.equal(thumbnail.status, 200)
    assert.equal(thumbnail.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    await thumbnail.arrayBuffer()
  } finally {
    delete process.env.ARCADE_EXPERIMENTAL_UNVERIFIED
  }

  const strictBuild = await request('/api/rom-builds/1003', { token: 'stranger-token' })
  assert.equal(strictBuild.status, 403)
  const strictThumbnail = await request(`/api/roms/103/thumbnail?v=${fixture.thumbnail.sha}`)
  assert.equal(strictThumbnail.status, 401)
})

test('experimental publication allows rooms for imported unverified builds only while enabled', async () => {
  process.env.ARCADE_EXPERIMENTAL_UNVERIFIED = '1'
  let roomId = null
  try {
    const created = await json('/api/rooms', {
      method: 'POST',
      token: 'owner-token',
      body: { name: 'Experimental Imported', romId: 103, isPublic: false },
    })
    assert.equal(created.response.status, 200)
    assert.equal(created.data.romBuildId, 1003)
    assert.equal(created.data.publicationMode, 'experimental')
    roomId = created.data.id
  } finally {
    delete process.env.ARCADE_EXPERIMENTAL_UNVERIFIED
    if (roomId) db.$client.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
  }

  const rejected = await json('/api/rooms', {
    method: 'POST',
    token: 'owner-token',
    body: { name: 'Experimental Disabled', romId: 103, isPublic: false },
  })
  assert.equal(rejected.response.status, 409)
})

test('split build resolution returns exact parent then child archives', async () => {
  const { response, data } = await json('/api/rom-builds/1002', {
    token: 'stranger-token',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(
    data.build.archives.map(({ buildId, role, fileName }) => ({ buildId, role, fileName })),
    [
      { buildId: 1001, role: 'parent', fileName: 'parent.zip' },
      { buildId: 1002, role: 'primary', fileName: 'child.zip' },
    ],
  )
  assert.match(data.build.archives[0].url, /^\/api\/rom-builds\/1001\/file\/parent\.zip\?forBuild=1002$/)
  assert.match(data.build.archives[1].url, /^\/api\/rom-builds\/1002\/file\/child\.zip\?forBuild=1002$/)

  const parentResponse = await request(data.build.archives[0].url, {
    token: 'stranger-token',
  })
  assert.equal(parentResponse.status, 200)
  assert.deepEqual(Buffer.from(await parentResponse.arrayBuffer()), fixture.archiveById.get(20).bytes)
})

test('build-addressed files authorize the active build and reject guessed retired builds', async () => {
  const privateFile = await request('/api/rom-builds/1004/file/private.zip?forBuild=1004', {
    token: 'owner-token',
  })
  assert.equal(privateFile.status, 200)
  assert.deepEqual(Buffer.from(await privateFile.arrayBuffer()), fixture.archiveById.get(23).bytes)

  const stranger = await request('/api/rom-builds/1004/file/private.zip?forBuild=1004', {
    token: 'stranger-token',
  })
  assert.equal(stranger.status, 403)

  const retired = await request('/api/rom-builds/1008/file/room_game.zip?forBuild=1008', {
    token: 'owner-token',
  })
  assert.equal(retired.status, 404)
})

test('a room host can still read the exact retired build locked by an open room', async () => {
  const { response, data } = await json('/api/rom-builds/1006', {
    token: 'owner-token',
  })
  assert.equal(response.status, 200)
  assert.equal(data.build.id, 1006)
  const file = await request(data.build.archives[0].url, { token: 'owner-token' })
  assert.equal(file.status, 200)
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), fixture.archiveById.get(25).bytes)

  const denied = await request('/api/rom-builds/1006', { token: 'stranger-token' })
  assert.equal(denied.status, 404)
})

test('reupload keeps retired build archive names immutable', async () => {
  const form = new FormData()
  form.set('title', 'Room Game Replacement')
  form.set('platform', 'arcade')
  form.set('file', new Blob(['next'], { type: 'application/octet-stream' }), 'room_game.7z')

  const uploaded = await json('/api/roms/upload', {
    method: 'POST',
    token: 'owner-token',
    body: form,
  })
  assert.equal(uploaded.response.status, 200)
  assert.equal(uploaded.data.id, 106, 'same owner/platform/set reuses the logical ROM')

  const retired = await json('/api/rom-builds/1006', { token: 'owner-token' })
  assert.equal(retired.response.status, 200)
  assert.equal(retired.data.build.archives[0].fileName, 'room_game.zip')
  assert.match(
    retired.data.build.archives[0].url,
    /^\/api\/rom-builds\/1006\/file\/room_game\.zip\?forBuild=1006$/,
  )
})

test('reupload preserves each immutable build\'s supported runtime format', async () => {
  const firstForm = new FormData()
  firstForm.set('title', 'PSX Disc')
  firstForm.set('platform', 'psx')
  firstForm.set('file', new Blob(['chd']), 'disc.chd')

  const first = await json('/api/roms/upload', {
    method: 'POST',
    token: 'owner-token',
    body: firstForm,
  })
  assert.equal(first.response.status, 200)
  assert.equal(first.data.fileName, 'disc.chd')

  const secondForm = new FormData()
  secondForm.set('title', 'PSX Disc')
  secondForm.set('platform', 'psx')
  secondForm.set('file', new Blob(['bin']), 'disc.bin')

  const second = await json('/api/roms/upload', {
    method: 'POST',
    token: 'owner-token',
    body: secondForm,
  })
  assert.equal(second.response.status, 200)
  assert.equal(second.data.id, first.data.id)
  assert.notEqual(second.data.buildId, first.data.buildId)
  assert.equal(second.data.fileName, 'disc.bin')

  const retired = await json(`/api/rom-builds/${first.data.buildId}`, {
    token: 'admin-token',
  })
  assert.equal(retired.response.status, 200)
  assert.equal(retired.data.build.archives[0].fileName, 'disc.chd')
  assert.match(
    retired.data.build.archives[0].url,
    new RegExp(`/api/rom-builds/${first.data.buildId}/file/disc\\.chd\\?forBuild=${first.data.buildId}$`),
  )
})

test('core and BIOS artifact URLs are pinned to the build artifact and content hashes', async () => {
  const { data } = await json('/api/rom-builds/1002', { token: 'owner-token' })
  const { core } = data.build
  assert.equal(core.name, 'mame2003_plus')
  assert.equal(core.artifactFingerprint, fixture.coreFingerprints.get(20))
  assert.match(core.jsUrl, new RegExp(`/api/cores/${core.artifactFingerprint}/${fixture.core.mameJs.sha}/mame2003_plus\\.js$`))
  assert.match(core.wasmUrl, new RegExp(`/api/cores/${core.artifactFingerprint}/${fixture.core.mameWasm.sha}/mame2003_plus\\.wasm$`))
  assert.match(core.bios[0].url, new RegExp(`/api/bios/${core.artifactFingerprint}/${fixture.core.biosMember.sha}/neogeo\\.zip$`))

  const jsResponse = await request(core.jsUrl)
  assert.equal(jsResponse.status, 200)
  assert.deepEqual(Buffer.from(await jsResponse.arrayBuffer()), fixture.core.mameJs.bytes)
  assert.equal(jsResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable')

  const biosResponse = await request(core.bios[0].url)
  assert.equal(biosResponse.status, 200)
  assert.deepEqual(Buffer.from(await biosResponse.arrayBuffer()), fixture.core.biosMember.bytes)

  const wrongHash = await request(core.jsUrl.replace(fixture.core.mameJs.sha, 'f'.repeat(64)))
  assert.equal(wrongHash.status, 404)
})

test('normal upload creates one private unverified logical ROM, asset, and manual build', async () => {
  const form = new FormData()
  form.set('title', 'Manual Upload')
  form.set('platform', 'arcade')
  form.set('isPublic', 'true')
  form.set('file', new Blob(['zip!'], { type: 'application/zip' }), 'manual.zip')

  const { response, data } = await json('/api/roms/upload', {
    method: 'POST',
    token: 'owner-token',
    body: form,
  })
  assert.equal(response.status, 200)
  assert.equal(data.isPublic, false)
  assert.equal(data.compatStatus, 'unverified')
  assert.equal(data.coreName, 'fbneo', 'server platform policy selects the default artifact')
  assert.equal(data.archiveLayout, 'standalone')
  assert.equal(data.activeBuild.archives.length, 1)
  assert.equal('filePath' in data, false)

  const sqlite = db.$client
  const rom = sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(data.id)
  const build = sqlite.prepare('SELECT * FROM rom_builds WHERE id = ?').get(data.buildId)
  const asset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(build.archive_asset_id)
  assert.equal(rom.active_build_id, build.id)
  assert.equal(rom.is_public, 0)
  assert.equal(build.static_status, 'complete')
  assert.equal(build.archive_layout, 'standalone')
  assert.equal(asset.sha256, sha256('zip!'))
  assert.deepEqual(readFileSync(assetPath(asset.sha256)), Buffer.from('zip!'))
})

test('normal upload respects the shared content mutation lifecycle lock', async () => {
  const lock = createContentStore({ root: assetRoot }).acquireMutationLock({ operation: 'batch-rollback' })
  try {
    const form = new FormData()
    form.set('title', 'Locked Upload')
    form.set('platform', 'arcade')
    form.set('file', new Blob(['lock'], { type: 'application/zip' }), 'locked_upload.zip')
    const { response, data } = await json('/api/roms/upload', {
      method: 'POST',
      token: 'owner-token',
      body: form,
    })
    assert.equal(response.status, 503)
    assert.match(data.error, /维护|重试|busy/i)
  } finally {
    lock.release()
  }
  assert.equal(
    db.$client.prepare("SELECT COUNT(*) AS n FROM roms WHERE set_name_normalized = 'locked_upload'").get().n,
    0,
  )
})

test('manual variant upload creates a split build pinned to the active parent build', async () => {
  const form = new FormData()
  form.set('title', 'Manual Split Variant')
  form.set('platform', 'arcade')
  form.set('parentRomId', '101')
  form.set('versionLabel', 'Manual Clone')
  form.set('file', new Blob(['part'], { type: 'application/zip' }), 'manual_clone.zip')

  const { response, data } = await json('/api/roms/upload', {
    method: 'POST',
    token: 'owner-token',
    body: form,
  })
  assert.equal(response.status, 200)
  assert.equal(data.parentRomId, 101)
  assert.equal(data.familyRootSetName, 'parent')
  assert.equal(data.archiveLayout, 'split')
  assert.equal(data.activeBuild.runtimeParentBuildId, 1001)
  assert.deepEqual(
    data.activeBuild.archives.map(({ buildId, role, fileName }) => ({ buildId, role, fileName })),
    [
      { buildId: 1001, role: 'parent', fileName: 'parent.zip' },
      { buildId: data.buildId, role: 'primary', fileName: 'manual_clone.zip' },
    ],
  )
})

test('ordinary HTTP upload retains its configured size limit', async () => {
  const form = new FormData()
  form.set('title', 'Too Large')
  form.set('platform', 'arcade')
  form.set('file', new Blob(['123456789']), 'too_large.zip')

  const response = await request('/api/roms/upload', {
    method: 'POST',
    token: 'owner-token',
    body: form,
  })
  assert.equal(response.status, 413)
  assert.equal(
    db.$client.prepare("SELECT COUNT(*) AS n FROM roms WHERE set_name_normalized = 'too_large'").get().n,
    0,
  )
})

test('an unverified active build cannot be made public', async () => {
  const { response, data } = await json('/api/roms/104', {
    method: 'PATCH',
    token: 'owner-token',
    body: { isPublic: true },
  })
  assert.equal(response.status, 409)
  assert.match(data.error, /验证|ready|公开/i)
  assert.equal(db.$client.prepare('SELECT is_public FROM roms WHERE id = 104').get().is_public, 0)
})

test('soft delete and restore preserve the active immutable build', async () => {
  const deleted = await json('/api/roms/107', {
    method: 'DELETE',
    token: 'owner-token',
  })
  assert.equal(deleted.response.status, 200)
  assert.equal(deleted.data.mode, 'soft')

  const trash = await json('/api/roms/trash', { token: 'owner-token' })
  const trashed = trash.data.roms.find((rom) => rom.id === 107)
  assert.equal(trashed.buildId, 1009)
  assert.equal(trashed.compatStatus, 'unverified')

  const hiddenFile = await request('/api/rom-builds/1009/file/disposable.zip?forBuild=1009', {
    token: 'owner-token',
  })
  assert.equal(hiddenFile.status, 404)

  const restored = await request('/api/roms/107/restore', {
    method: 'POST',
    token: 'owner-token',
  })
  assert.equal(restored.status, 200)
  assert.equal(db.$client.prepare('SELECT active_build_id FROM roms WHERE id = 107').get().active_build_id, 1009)
})

test('hard delete rejects builds referenced by runtime children or rooms', async () => {
  const runtimeParent = await json('/api/roms/101?permanent=1', {
    method: 'DELETE',
    token: 'owner-token',
  })
  assert.equal(runtimeParent.response.status, 409)
  assert.match(runtimeParent.data.error, /引用|构建|build/i)

  const roomLocked = await json('/api/roms/106?permanent=1', {
    method: 'DELETE',
    token: 'owner-token',
  })
  assert.equal(roomLocked.response.status, 409)
  assert.match(roomLocked.data.error, /房间|引用|build/i)
  assert.equal(db.$client.prepare('SELECT COUNT(*) AS n FROM roms WHERE id IN (101, 106)').get().n, 2)
})

test('hard delete rejects builds retained by import operation history', async () => {
  db.$client.prepare(`
    INSERT INTO import_batches
      (id, owner_user_id, cold_source_sha256, manifest_sha256,
       planned_count, actual_count, total_bytes, status)
    VALUES ('history-batch', 1, ?, ?, 1, 1, 1, 'committed_private')
  `).run(sha256('cold-source'), sha256('manifest'))
  db.$client.prepare(`
    INSERT INTO import_operations
      (import_batch_id, sequence, operation_kind, entity_type,
       entity_key, before_json, after_json)
    VALUES ('history-batch', 1, 'create', 'rom_build', '1009', NULL, ?)
  `).run(JSON.stringify({ id: 1009, romId: 107 }))

  const blocked = await json('/api/roms/107?permanent=1', {
    method: 'DELETE',
    token: 'owner-token',
  })
  assert.equal(blocked.response.status, 409)
  assert.match(blocked.data.error, /导入|历史|回滚|引用/)
  assert.equal(db.$client.prepare('SELECT COUNT(*) AS n FROM rom_builds WHERE id = 1009').get().n, 1)
})

test('hard delete respects the shared content mutation lifecycle lock', async () => {
  const sqlite = db.$client
  const romId = sqlite.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM roms').get().id
  const buildId = sqlite.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM rom_builds').get().id
  const assetId = sqlite.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM assets').get().id
  const archive = addAsset(sqlite, {
    id: assetId,
    kind: 'rom',
    bytes: 'hard-delete-lock-fixture',
  })
  insertRom(sqlite, {
    id: romId,
    title: 'Hard Delete Lock Fixture',
    setName: 'hard_delete_lock_fixture',
    isPublic: false,
  })
  insertBuild(sqlite, {
    id: buildId,
    romId,
    coreArtifactId: 10,
    archive,
  })

  const expectedRom = sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(romId)
  const expectedBuild = sqlite.prepare('SELECT * FROM rom_builds WHERE id = ?').get(buildId)
  const expectedAsset = sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)
  const lock = createContentStore({ root: assetRoot }).acquireMutationLock({ operation: 'batch-commit' })
  let blocked
  try {
    blocked = await json(`/api/roms/${romId}?permanent=1`, {
      method: 'DELETE',
      token: 'owner-token',
    })
  } finally {
    lock.release()
  }

  assert.equal(blocked.response.status, 503)
  assert.match(blocked.data.error, /维护|重试|busy/i)
  assert.deepEqual(sqlite.prepare('SELECT * FROM roms WHERE id = ?').get(romId), expectedRom)
  assert.deepEqual(sqlite.prepare('SELECT * FROM rom_builds WHERE id = ?').get(buildId), expectedBuild)
  assert.deepEqual(sqlite.prepare('SELECT * FROM assets WHERE id = ?').get(assetId), expectedAsset)
  assert.deepEqual(readFileSync(assetPath(archive.sha)), archive.bytes)

  const deleted = await json(`/api/roms/${romId}?permanent=1`, {
    method: 'DELETE',
    token: 'owner-token',
  })
  assert.equal(deleted.response.status, 200)
  assert.equal(deleted.data.mode, 'permanent')
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM roms WHERE id = ?').get(romId).n, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rom_builds WHERE id = ?').get(buildId).n, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM assets WHERE id = ?').get(assetId).n, 0)
  assert.equal(existsSync(assetPath(archive.sha)), false)

  for (const asset of sqlite.prepare('SELECT file_path, file_size FROM assets').all()) {
    const fullPath = join(assetRoot, asset.file_path)
    assert.equal(existsSync(fullPath), true, `missing asset file ${asset.file_path}`)
    assert.equal(statSync(fullPath).size, asset.file_size, `size mismatch for ${asset.file_path}`)
  }
})

test('ROM, core, and BIOS routes reject a symlink or junction below the asset root', async (t) => {
  const outside = join(fixtureDirectory, 'route-escape-target')
  const link = join(assetRoot, 'route-escape')
  mkdirSync(outside, { recursive: true })
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symlink/junction creation unavailable: ${error.code}`)
      return
    }
    throw error
  }

  const escapedAssets = [
    { id: 9001, kind: 'core_js', name: 'escape.js', bytes: Buffer.from('escaped-js'), mimeType: 'application/javascript' },
    { id: 9002, kind: 'core_wasm', name: 'escape.wasm', bytes: Buffer.from('escaped-wasm'), mimeType: 'application/wasm' },
    { id: 9003, kind: 'bios', name: 'escape.zip', bytes: Buffer.from('escaped-bios'), mimeType: 'application/zip' },
    { id: 9004, kind: 'rom', name: 'escape-rom.zip', bytes: Buffer.from('escaped-rom'), mimeType: 'application/zip' },
  ].map((asset) => ({ ...asset, sha: sha256(asset.bytes) }))
  for (const asset of escapedAssets) {
    writeFileSync(join(outside, asset.name), asset.bytes)
    db.$client.prepare(`
      INSERT INTO assets (id, kind, file_path, mime_type, file_size, sha256)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      asset.id,
      asset.kind,
      `route-escape/${asset.name}`,
      asset.mimeType,
      asset.bytes.length,
      asset.sha,
    )
  }

  const [jsAsset, wasmAsset, biosAsset, romAsset] = escapedAssets
  const coreFingerprint = sha256('escape-core')
  db.$client.prepare(`
    INSERT INTO core_artifacts
      (id, core_name, display_version, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, artifact_fingerprint, provenance_json, is_enabled)
    VALUES (9000, 'escape_core', 'test', ?, ?, ?, ?, ?, ?, 1)
  `).run(
    jsAsset.id,
    jsAsset.sha,
    wasmAsset.id,
    wasmAsset.sha,
    coreFingerprint,
    JSON.stringify({
      bios: {
        members: [{
          fileName: 'escape.zip',
          assetId: biosAsset.id,
          sha256: biosAsset.sha,
        }],
      },
    }),
  )
  insertRom(db.$client, {
    id: 900,
    title: 'Escaped Route Fixture',
    setName: 'escape_route',
    isPublic: false,
  })
  insertBuild(db.$client, {
    id: 9000,
    romId: 900,
    coreArtifactId: 9000,
    archive: romAsset,
  })

  let responses
  try {
    responses = await Promise.all([
      request('/api/rom-builds/9000/file/escape_route.zip?forBuild=9000', { token: 'owner-token' }),
      request(`/api/cores/${coreFingerprint}/${jsAsset.sha}/escape_core.js`),
      request(`/api/bios/${coreFingerprint}/${biosAsset.sha}/escape.zip`),
    ])
    await Promise.all(responses.map((response) => response.arrayBuffer()))
  } finally {
    db.$client.prepare('UPDATE roms SET active_build_id = NULL WHERE id = 900').run()
    db.$client.prepare('DELETE FROM rom_builds WHERE id = 9000').run()
    db.$client.prepare('DELETE FROM roms WHERE id = 900').run()
    db.$client.prepare('DELETE FROM core_artifacts WHERE id = 9000').run()
    db.$client.prepare('DELETE FROM assets WHERE id BETWEEN 9001 AND 9004').run()
    rmSync(link, { recursive: true, force: true })
  }

  assert.deepEqual(responses.map((response) => response.status), [404, 404, 404])
})

test('hard delete preserves assets referenced through core BIOS provenance', async () => {
  const deleted = await json('/api/roms/108?permanent=1', {
    method: 'DELETE',
    token: 'owner-token',
  })
  assert.equal(deleted.response.status, 200)
  assert.equal(db.$client.prepare('SELECT COUNT(*) AS n FROM roms WHERE id = 108').get().n, 0)
  assert.equal(db.$client.prepare('SELECT COUNT(*) AS n FROM assets WHERE id = ?').get(fixture.core.biosMember.id).n, 1)

  const biosUrl = `/api/bios/${fixture.coreFingerprints.get(20)}/${fixture.core.biosMember.sha}/neogeo.zip`
  const biosResponse = await request(biosUrl)
  assert.equal(biosResponse.status, 200)
  assert.deepEqual(Buffer.from(await biosResponse.arrayBuffer()), fixture.core.biosMember.bytes)
})

test('runtime helpers use exact build core URLs and preserve server mount order', async () => {
  const [{ getPlatformInfo, getBiosUrls }, nostalgist] = await Promise.all([
    import('../src/data/config.js'),
    import('../src/composables/nostalgist.js'),
  ])
  const { data } = await json('/api/rom-builds/1002', { token: 'owner-token' })
  const romMeta = { platform: 'arcade', activeBuild: data.build }
  const platform = getPlatformInfo(romMeta)
  assert.equal(platform.core, 'mame2003_plus')
  assert.equal(platform.coreJsUrl, data.build.core.jsUrl)
  assert.deepEqual(getBiosUrls(romMeta), data.build.core.bios.map(({ fileName, url }) => ({
    fileName,
    fileContent: url,
  })))

  const fetched = []
  const runtime = await nostalgist.resolveBuildArtifacts(data.build, async (url) => {
    fetched.push(url)
    return new Blob([url])
  })
  assert.deepEqual(runtime.rom.map(({ fileName }) => fileName), ['parent.zip', 'child.zip'])
  assert.deepEqual(fetched.slice(0, 2), data.build.archives.map(({ url }) => url))

  const coreRequests = []
  const options = nostalgist.buildEmulatorOptions({
    core: data.build.core.name,
    coreJsUrl: data.build.core.jsUrl,
    coreWasmUrl: data.build.core.wasmUrl,
    rom: runtime.rom,
    bios: runtime.bios,
    assetFetcher: async (url) => {
      coreRequests.push(url)
      return new Blob([url])
    },
  })
  await options.resolveCoreJs('ignored')
  await options.resolveCoreWasm('ignored')
  assert.deepEqual(coreRequests, [data.build.core.jsUrl, data.build.core.wasmUrl])
})

test('room creation locks the current ready build and never follows a later active build', async () => {
  const rejected = await json('/api/rooms', {
    method: 'POST',
    token: 'owner-token',
    body: { name: 'Unverified', romId: 103, isPublic: false },
  })
  assert.equal(rejected.response.status, 409)

  const created = await json('/api/rooms', {
    method: 'POST',
    token: 'owner-token',
    body: { name: 'Pinned Parent', romId: 101, isPublic: false },
  })
  assert.equal(created.response.status, 200)
  assert.equal(created.data.romBuildId, 1001)
  assert.equal(created.data.romSetName, 'parent')
  assert.equal(created.data.romVersionLabel, null)
  assert.equal(created.data.coreName, 'mame2003_plus')
  assert.equal(created.data.coreVersion, '62c7089')

  const replacement = addAsset(db.$client, {
    id: 5000,
    kind: 'rom',
    bytes: 'replacement-ready-rom',
  })
  insertBuild(db.$client, {
    id: 5000,
    romId: 101,
    coreArtifactId: 20,
    archive: replacement,
    acceptedResult: 'passed',
  })

  const mine = await json('/api/rooms/mine', { token: 'owner-token' })
  const pinned = mine.data.rooms.find((room) => room.id === created.data.id)
  assert.equal(pinned.romBuildId, 1001)
  assert.equal(pinned.buildFingerprint, sha256('build:1001'))
  assert.equal(
    db.$client.prepare('SELECT rom_build_id FROM rooms WHERE id = ?').get(created.data.id).rom_build_id,
    1001,
  )
})

test('cloud saves are isolated by immutable build and fingerprint identity', async () => {
  const first = await app.request('/api/saves/101?buildId=1001&slot=0', {
    method: 'POST',
    headers: authHeaders('owner-token', { 'content-type': 'application/octet-stream' }),
    body: Buffer.from('state-old-build'),
  })
  assert.equal(first.status, 200)
  const firstMeta = await first.json()
  assert.equal(firstMeta.romBuildId, 1001)
  assert.equal(firstMeta.buildFingerprint, sha256('build:1001'))
  assert.equal(firstMeta.coreArtifactFingerprint, fixture.coreFingerprints.get(20))

  const second = await app.request('/api/saves/101?buildId=5000&slot=0', {
    method: 'POST',
    headers: authHeaders('owner-token', { 'content-type': 'application/octet-stream' }),
    body: Buffer.from('state-new-build'),
  })
  assert.equal(second.status, 200)
  const secondMeta = await second.json()
  assert.equal(secondMeta.romBuildId, 5000)
  assert.notEqual(secondMeta.buildFingerprint, firstMeta.buildFingerprint)

  assert.equal(
    db.$client.prepare('SELECT COUNT(*) AS n FROM save_states WHERE user_id = 1 AND rom_id = 101').get().n,
    2,
  )
  for (const [buildId, expected] of [[1001, 'state-old-build'], [5000, 'state-new-build']]) {
    const loaded = await app.request(`/api/saves/101?buildId=${buildId}&slot=0`, {
      headers: authHeaders('owner-token'),
    })
    assert.equal(loaded.status, 200)
    assert.equal(Buffer.from(await loaded.arrayBuffer()).toString(), expected)
  }

  const mismatched = await app.request('/api/saves/102?buildId=1001&slot=0', {
    method: 'POST',
    headers: authHeaders('owner-token', { 'content-type': 'application/octet-stream' }),
    body: Buffer.from('wrong-rom'),
  })
  assert.equal(mismatched.status, 409)
})
