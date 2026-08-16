import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, unlinkSync, createReadStream, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stream } from 'hono/streaming'
import { db } from '../db/index.js'
import { coreArtifacts, romBuilds, saveStates, roms, STATUS } from '../db/schema.js'
import { requireAuth } from '../middleware/auth.js'

const liveSave = (extra) =>
  extra ? and(eq(saveStates.status, STATUS.normal), extra) : eq(saveStates.status, STATUS.normal)

const SAVES_DIR = resolve(process.env.SAVES_DIR || 'data/saves')
const MAX_STATE_BYTES = Number(process.env.MAX_STATE_BYTES) || 8 * 1024 * 1024 // 8 MB

export const saveRoutes = new Hono()

function serialize(row) {
  return {
    id: row.id,
    romId: row.romId,
    romBuildId: row.romBuildId,
    buildFingerprint: row.buildFingerprint,
    coreArtifactFingerprint: row.coreArtifactFingerprint,
    contentManifestSha256: row.contentManifestSha256,
    slot: row.slot,
    size: row.fileSize,
    updatedAt: row.updatedAt,
  }
}

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

async function resolveBuildIdentity({ romId, buildId, user }) {
  const rom = (await db.select().from(roms).where(and(
    eq(roms.id, romId),
    eq(roms.status, STATUS.normal),
  )).limit(1))[0]
  if (!rom) return { error: 'ROM 不存在', status: 404 }
  if (rom.userId !== user.id && !rom.isPublic && user.role !== 'admin') {
    return { error: '无权为该 ROM 存档', status: 403 }
  }
  const build = (await db.select().from(romBuilds).where(eq(romBuilds.id, buildId)).limit(1))[0]
  if (!build || build.romId !== romId) {
    return { error: '构建与 ROM 不匹配', status: 409 }
  }
  const core = (await db.select().from(coreArtifacts)
    .where(eq(coreArtifacts.id, build.coreArtifactId)).limit(1))[0]
  if (!core) return { error: '构建核心不存在', status: 409 }
  return {
    rom,
    build,
    core,
    identity: {
      romId,
      romBuildId: build.id,
      buildFingerprint: build.buildFingerprint,
      coreArtifactFingerprint: core.artifactFingerprint,
      contentManifestSha256: build.contentManifestSha256,
    },
  }
}

function saveIdentityWhere(userId, buildId, slot) {
  return liveSave(and(
    eq(saveStates.userId, userId),
    eq(saveStates.romBuildId, buildId),
    eq(saveStates.slot, slot),
  ))
}

// List all saves for the current user
saveRoutes.get('/mine', requireAuth, async (c) => {
  const me = c.get('user')
  const rows = await db.select().from(saveStates)
    .where(liveSave(eq(saveStates.userId, me.id)))
  return c.json({ saves: rows.map(serialize) })
})

// Get the save for a specific ROM + slot (returns binary blob)
saveRoutes.get('/:romId', requireAuth, async (c) => {
  const me = c.get('user')
  const romId = Number(c.req.param('romId'))
  const buildId = positiveInteger(c.req.query('buildId'))
  const slot = Number(c.req.query('slot') || 0)
  if (!buildId) return c.json({ error: '缺少有效的 buildId' }, 400)
  const resolved = await resolveBuildIdentity({ romId, buildId, user: me })
  if (resolved.error) return c.json({ error: resolved.error }, resolved.status)
  const row = (await db.select().from(saveStates)
    .where(saveIdentityWhere(me.id, buildId, slot))
    .limit(1))[0]
  if (!row) return c.json({ error: '无存档' }, 404)

  let st
  try { st = statSync(row.filePath) }
  catch { return c.json({ error: '存档文件缺失' }, 404) }

  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(st.size))
  c.header('X-Save-Updated-At', String(row.updatedAt instanceof Date ? Math.floor(row.updatedAt.getTime()/1000) : row.updatedAt))
  return stream(c, async (s) => {
    const rs = createReadStream(row.filePath)
    await s.pipe(new ReadableStream({
      start(controller) {
        rs.on('data', (chunk) => controller.enqueue(chunk))
        rs.on('end', () => controller.close())
        rs.on('error', (err) => controller.error(err))
      },
    }))
  })
})

// Upload / overwrite save for a ROM + slot (body is raw binary)
saveRoutes.post('/:romId', requireAuth, async (c) => {
  const me = c.get('user')
  const romId = Number(c.req.param('romId'))
  const buildId = positiveInteger(c.req.query('buildId'))
  const slot = Number(c.req.query('slot') || 0)
  if (!buildId) return c.json({ error: '缺少有效的 buildId' }, 400)

  const resolved = await resolveBuildIdentity({ romId, buildId, user: me })
  if (resolved.error) return c.json({ error: resolved.error }, resolved.status)

  const buf = Buffer.from(await c.req.arrayBuffer())
  if (!buf.length) return c.json({ error: '空存档' }, 400)
  if (buf.length > MAX_STATE_BYTES) return c.json({ error: `存档超过 ${Math.round(MAX_STATE_BYTES/1024/1024)}MB` }, 413)

  const userDir = join(SAVES_DIR, String(me.id), resolved.build.buildFingerprint)
  mkdirSync(userDir, { recursive: true })
  const fileName = `slot-${slot}.state`
  const filePath = join(userDir, fileName)
  await writeFile(filePath, buf)

  // Upsert DB row
  const existing = (await db.select().from(saveStates)
    .where(saveIdentityWhere(me.id, buildId, slot))
    .limit(1))[0]

  let row
  if (existing) {
    [row] = await db.update(saveStates)
      .set({ filePath, fileSize: buf.length, updatedAt: new Date() })
      .where(eq(saveStates.id, existing.id))
      .returning()
  } else {
    [row] = await db.insert(saveStates).values({
      userId: me.id,
      ...resolved.identity,
      slot,
      filePath,
      fileSize: buf.length,
    }).returning()
  }
  return c.json(serialize(row))
})

// Delete a save
saveRoutes.delete('/:romId', requireAuth, async (c) => {
  const me = c.get('user')
  const romId = Number(c.req.param('romId'))
  const buildId = positiveInteger(c.req.query('buildId'))
  const slot = Number(c.req.query('slot') || 0)
  if (!buildId) return c.json({ error: '缺少有效的 buildId' }, 400)
  const resolved = await resolveBuildIdentity({ romId, buildId, user: me })
  if (resolved.error) return c.json({ error: resolved.error }, resolved.status)
  const row = (await db.select().from(saveStates)
    .where(saveIdentityWhere(me.id, buildId, slot))
    .limit(1))[0]
  if (!row) return c.json({ ok: true })
  try { unlinkSync(row.filePath) } catch {}
  await db.update(saveStates).set({ status: STATUS.deleted }).where(eq(saveStates.id, row.id))
  return c.json({ ok: true })
})
