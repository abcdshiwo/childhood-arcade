import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { chromium } from 'playwright-core'

const IMAGE_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'thumbnail-browser-cache-'))
const databasePath = join(fixtureDirectory, 'app.db')
const assetRoot = join(fixtureDirectory, 'library-assets')
const imageHash = sha256(IMAGE_BYTES)
const storedPath = `sha256/${imageHash.slice(0, 2)}/${imageHash}`
const imagePath = join(assetRoot, storedPath)

mkdirSync(dirname(imagePath), { recursive: true })
writeFileSync(imagePath, IMAGE_BYTES)
createDatabaseFixture()
process.env.DB_PATH = databasePath
process.env.LIBRARY_ASSET_ROOT = assetRoot

const [{ romRoutes }, { authRoutes }, { db }] = await Promise.all([
  import('../../server/routes/roms.js'),
  import('../../server/routes/auth.js'),
  import('../../server/db/index.js'),
])

function createDatabaseFixture() {
  const sqlite = new Database(databasePath)
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      status INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE roms (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      is_public INTEGER NOT NULL,
      active_build_id INTEGER,
      active_thumbnail_ref_id INTEGER,
      status INTEGER NOT NULL
    );
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT,
      file_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE rom_builds (
      id INTEGER PRIMARY KEY,
      rom_id INTEGER NOT NULL,
      static_status TEXT NOT NULL
    );
    CREATE TABLE build_validation_runs (
      id INTEGER PRIMARY KEY,
      rom_build_id INTEGER NOT NULL,
      result TEXT NOT NULL,
      acceptance TEXT NOT NULL
    );
    CREATE TABLE rom_asset_refs (
      id INTEGER PRIMARY KEY,
      rom_id INTEGER NOT NULL,
      asset_id INTEGER NOT NULL,
      import_batch_id TEXT
    );

    INSERT INTO users (id, username, password_hash, role, status)
    VALUES (1, 'owner', 'hash', 'user', 1);
    INSERT INTO sessions (id, user_id, token, expires_at)
    VALUES (1, 1, 'owner-token', unixepoch() + 3600);
    INSERT INTO roms
      (id, user_id, is_public, active_build_id, active_thumbnail_ref_id, status)
    VALUES
      (1, 1, 0, 10, 20, 1),
      (2, 1, 1, 12, 21, 1);
    INSERT INTO rom_builds (id, rom_id, static_status)
    VALUES
      (10, 1, 'complete'),
      (12, 2, 'complete');
    INSERT INTO build_validation_runs (id, rom_build_id, result, acceptance)
    VALUES
      (11, 10, 'passed', 'accepted'),
      (13, 12, 'passed', 'accepted');
    INSERT INTO assets (id, kind, file_path, mime_type, file_size, sha256)
    VALUES (30, 'thumbnail', '${storedPath}', 'image/gif', ${IMAGE_BYTES.length}, '${imageHash}');
    INSERT INTO rom_asset_refs (id, rom_id, asset_id)
    VALUES
      (20, 1, 30),
      (21, 2, 30);
  `)
  sqlite.close()
}

async function startServer(onThumbnailResponse) {
  const app = new Hono()
  app.use('/api/roms/*', async (c, next) => {
    await next()
    if (c.req.path.endsWith('/thumbnail')) onThumbnailResponse(c.res.status)
  })
  app.route('/api/auth', authRoutes)
  app.route('/api/roms', romRoutes)
  app.get('/thumbnail-cache-test', (c) => c.html('<!doctype html><title>thumbnail cache test</title>'))

  let server
  const info = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${info.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function loadImage(page, url) {
  return page.evaluate((source) => new Promise((resolve) => {
    document.querySelector('img')?.remove()
    const image = new Image()
    image.onload = () => resolve({ loaded: true, width: image.naturalWidth })
    image.onerror = () => resolve({ loaded: false, width: image.naturalWidth })
    image.src = source
    document.body.append(image)
  }), url)
}

test('Chromium revalidates thumbnails after logout and public access revocation', async (t) => {
  const responses = []
  const server = await startServer((status) => responses.push(status))
  t.after(server.close)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext()
  t.after(() => context.close())
  await context.addCookies([{
    name: 'session',
    value: 'owner-token',
    url: server.baseUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }])
  const page = await context.newPage()
  await page.goto(`${server.baseUrl}/thumbnail-cache-test`)
  const thumbnailUrl = `${server.baseUrl}/api/roms/1/thumbnail?v=${imageHash}`

  assert.deepEqual(await loadImage(page, thumbnailUrl), { loaded: true, width: 1 })
  assert.deepEqual(responses, [200])

  const logoutStatus = await page.evaluate(async () => (
    (await fetch('/api/auth/logout', { method: 'POST' })).status
  ))
  assert.equal(logoutStatus, 200)
  assert.equal(db.$client.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token = 'owner-token'").get().n, 0)
  assert.ok((await context.cookies()).every((cookie) => cookie.name !== 'session'))

  assert.deepEqual(await loadImage(page, thumbnailUrl), { loaded: false, width: 0 })
  assert.deepEqual(responses, [200, 401])

  const publicUrl = `${server.baseUrl}/api/roms/2/thumbnail?v=${imageHash}`
  assert.deepEqual(await loadImage(page, publicUrl), { loaded: true, width: 1 })
  assert.deepEqual(responses, [200, 401, 200])

  db.$client.prepare('UPDATE roms SET is_public = 0 WHERE id = 2').run()
  await page.reload()
  assert.deepEqual(await loadImage(page, publicUrl), { loaded: false, width: 0 })
  assert.deepEqual(responses, [200, 401, 200, 401])
})

test.after(() => {
  db.$client?.close?.()
  rmSync(fixtureDirectory, { recursive: true, force: true })
})
