import { Hono } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { customAlphabet } from 'nanoid'
import { db } from '../db/index.js'
import {
  buildValidationRuns,
  coreArtifacts,
  romBuilds,
  rooms,
  roms,
  users,
  STATUS,
} from '../db/schema.js'
import { requireAuth, currentUser } from '../middleware/auth.js'
import { getSetting } from './settings.js'
import { isHostOnline } from '../room-hub.js'

const liveRoom = (extra) =>
  extra ? and(eq(rooms.status, STATUS.normal), isNull(rooms.closedAt), extra)
        : and(eq(rooms.status, STATUS.normal), isNull(rooms.closedAt))

// 6-char alphanumeric codes, unambiguous (no 0/O/1/I/L)
const makeCode = customAlphabet('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 6)

const createSchema = z.object({
  name: z.string().min(1).max(60),
  romId: z.number().int().positive(),
  isPublic: z.boolean().default(true),
  allowPlay: z.boolean().default(true),
  password: z.string().min(0).max(64).optional(),
})

export const roomRoutes = new Hono()

function serializeRoom(row, extras = {}) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isPublic: Boolean(row.isPublic),
    allowPlay: row.allowPlay === undefined ? true : Boolean(row.allowPlay),
    hasPassword: !!row.passwordHash,
    hostUserId: row.hostUserId,
    romId: row.romId,
    romBuildId: row.romBuildId,
    createdAt: row.createdAt,
    ...extras,
  }
}

function buildExtras({ rom, build, core }) {
  return {
    romTitle: rom.title,
    romPlatform: rom.platform,
    romSetName: rom.setNameNormalized,
    romVersionLabel: rom.versionLabel ?? null,
    romVariantKind: rom.variantKind ?? null,
    buildFingerprint: build.buildFingerprint,
    contentManifestSha256: build.contentManifestSha256,
    archiveLayout: build.archiveLayout,
    coreName: core.coreName,
    coreVersion: core.displayVersion,
    coreArtifactFingerprint: core.artifactFingerprint,
  }
}

function readyActiveBuild(tx, rom) {
  if (!Number.isInteger(rom.activeBuildId)) return null
  const build = tx.select().from(romBuilds).where(and(
    eq(romBuilds.id, rom.activeBuildId),
    eq(romBuilds.romId, rom.id),
    eq(romBuilds.staticStatus, 'complete'),
  )).limit(1).get()
  if (!build) return null
  const accepted = tx.select({ result: buildValidationRuns.result })
    .from(buildValidationRuns)
    .where(and(
      eq(buildValidationRuns.romBuildId, build.id),
      eq(buildValidationRuns.acceptance, 'accepted'),
      eq(buildValidationRuns.result, 'passed'),
    ))
    .limit(1).get()
  if (!accepted) return null
  const core = tx.select().from(coreArtifacts)
    .where(eq(coreArtifacts.id, build.coreArtifactId)).limit(1).get()
  return core ? { build, core } : null
}

async function detailsForRoom(row) {
  const rom = (await db.select().from(roms).where(eq(roms.id, row.romId)).limit(1))[0]
  const build = (await db.select().from(romBuilds)
    .where(and(eq(romBuilds.id, row.romBuildId), eq(romBuilds.romId, row.romId)))
    .limit(1))[0]
  const core = build
    ? (await db.select().from(coreArtifacts).where(eq(coreArtifacts.id, build.coreArtifactId)).limit(1))[0]
    : null
  return rom && build && core ? buildExtras({ rom, build, core }) : {}
}

// List open public rooms with basic info
roomRoutes.get('/', async (c) => {
  const rows = await db.select({
    r: rooms,
    hostUsername: users.username,
    rom: roms,
    build: romBuilds,
    core: coreArtifacts,
  })
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.hostUserId))
    .innerJoin(roms, eq(roms.id, rooms.romId))
    .innerJoin(romBuilds, and(eq(romBuilds.id, rooms.romBuildId), eq(romBuilds.romId, rooms.romId)))
    .innerJoin(coreArtifacts, eq(coreArtifacts.id, romBuilds.coreArtifactId))
    .where(liveRoom(eq(rooms.isPublic, true)))
    .orderBy(desc(rooms.createdAt))

  return c.json({
    rooms: rows.map(({ r, hostUsername, rom, build, core }) =>
      serializeRoom(r, {
        hostUsername,
        ...buildExtras({ rom, build, core }),
        hostOnline: isHostOnline(r.code),
      }),
    ),
  })
})

// List all OPEN rooms the current user hosts (public + private)
roomRoutes.get('/mine', requireAuth, async (c) => {
  const me = c.get('user')
  const rows = await db.select({
    r: rooms,
    rom: roms,
    build: romBuilds,
    core: coreArtifacts,
  })
    .from(rooms)
    .innerJoin(roms, eq(roms.id, rooms.romId))
    .innerJoin(romBuilds, and(eq(romBuilds.id, rooms.romBuildId), eq(romBuilds.romId, rooms.romId)))
    .innerJoin(coreArtifacts, eq(coreArtifacts.id, romBuilds.coreArtifactId))
    .where(liveRoom(eq(rooms.hostUserId, me.id)))
    .orderBy(desc(rooms.createdAt))
  return c.json({
    rooms: rows.map(({ r, rom, build, core }) =>
      serializeRoom(r, {
        hostUsername: me.username,
        ...buildExtras({ rom, build, core }),
        hostOnline: isHostOnline(r.code),
      }),
    ),
  })
})

// Create room (must be authed; rom must be accessible to user)
roomRoutes.post('/', requireAuth, async (c) => {
  const me = c.get('user')
  // Honor global netplay kill-switch (admins bypass)
  if (me.role !== 'admin' && (await getSetting('netplayEnabled', '1')) !== '1') {
    return c.json({ error: '管理员已关闭对战功能' }, 403)
  }
  const body = await c.req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: '参数不合法' }, 400)
  const { name, romId, isPublic, allowPlay, password } = parsed.data

  const rom = (await db.select().from(roms)
    .where(and(eq(roms.id, romId), eq(roms.status, STATUS.normal))).limit(1))[0]
  if (!rom) return c.json({ error: 'ROM 不存在' }, 404)
  if (rom.userId !== me.id && !rom.isPublic && me.role !== 'admin') {
    return c.json({ error: '无权使用该 ROM' }, 403)
  }

  const passwordHash = password ? await bcrypt.hash(password, 10) : null

  // try a few times in case of a code collision
  let code, inserted, pinned
  for (let i = 0; i < 5; i++) {
    code = makeCode()
    try {
      const result = db.transaction((tx) => {
        const currentRom = tx.select().from(roms).where(and(
          eq(roms.id, romId),
          eq(roms.status, STATUS.normal),
        )).limit(1).get()
        const ready = currentRom ? readyActiveBuild(tx, currentRom) : null
        if (!currentRom || !ready) {
          const error = new Error('ROM 当前构建尚未通过验证')
          error.code = 'BUILD_NOT_READY'
          throw error
        }
        const room = tx.insert(rooms).values({
          code,
          hostUserId: me.id,
          romId,
          romBuildId: ready.build.id,
          name: name.trim(),
          isPublic,
          allowPlay,
          passwordHash,
        }).returning().get()
        return { room, ready, currentRom }
      })
      inserted = result.room
      pinned = result
      break
    } catch (err) {
      if (err.code === 'BUILD_NOT_READY') {
        return c.json({ error: err.message }, 409)
      }
      if (i === 4) throw err
    }
  }

  return c.json(serializeRoom(inserted, {
    hostUsername: me.username,
    ...buildExtras({
      rom: pinned.currentRom,
      build: pinned.ready.build,
      core: pinned.ready.core,
    }),
  }))
})

// Fetch room info by code (public endpoint; validates password if provided)
roomRoutes.post('/:code/join', async (c) => {
  const code = c.req.param('code').toUpperCase()
  const body = await c.req.json().catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password : ''

  const row = (await db.select({
    r: rooms,
    hostUsername: users.username,
    rom: roms,
    build: romBuilds,
    core: coreArtifacts,
  })
    .from(rooms)
    .innerJoin(users, eq(users.id, rooms.hostUserId))
    .innerJoin(roms, eq(roms.id, rooms.romId))
    .innerJoin(romBuilds, and(eq(romBuilds.id, rooms.romBuildId), eq(romBuilds.romId, rooms.romId)))
    .innerJoin(coreArtifacts, eq(coreArtifacts.id, romBuilds.coreArtifactId))
    .where(eq(rooms.code, code))
    .limit(1))[0]

  if (!row || row.r.closedAt || row.r.status !== STATUS.normal) return c.json({ error: '房间不存在或已关闭' }, 404)

  if (row.r.passwordHash) {
    if (!password) return c.json({ error: '此房间需要密码', needsPassword: true }, 401)
    const ok = await bcrypt.compare(password, row.r.passwordHash)
    if (!ok) return c.json({ error: '密码不正确' }, 401)
  }

  // Block guests from entering when the host isn't currently connected.
  // The host themselves can always re-enter (their socket re-creates the
  // in-memory hub entry).
  const me = await currentUser(c)
  const isHost = me && me.id === row.r.hostUserId
  if (!isHost && !isHostOnline(code)) {
    return c.json({ error: '房主不在线，请稍后再试', hostOffline: true }, 503)
  }

  return c.json(serializeRoom(row.r, {
    hostUsername: row.hostUsername,
    ...buildExtras({ rom: row.rom, build: row.build, core: row.core }),
    hostOnline: isHostOnline(code),
  }))
})

const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  romId: z.number().int().positive().optional(),
  isPublic: z.boolean().optional(),
  allowPlay: z.boolean().optional(),
  // password: null clears, '' is treated as null, otherwise sets new hash
  password: z.union([z.string().max(64), z.null()]).optional(),
})

// Update room (host or admin)
roomRoutes.patch('/:code', requireAuth, async (c) => {
  const me = c.get('user')
  const code = c.req.param('code').toUpperCase()
  const row = (await db.select().from(rooms).where(eq(rooms.code, code)).limit(1))[0]
  if (!row || row.status !== STATUS.normal) return c.json({ error: '房间不存在' }, 404)
  if (row.closedAt) return c.json({ error: '房间已关闭' }, 410)
  if (row.hostUserId !== me.id && me.role !== 'admin') {
    return c.json({ error: '无权修改该房间' }, 403)
  }
  const body = await c.req.json().catch(() => null)
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: '参数不合法' }, 400)

  const patch = {}
  if (typeof parsed.data.name === 'string') patch.name = parsed.data.name.trim()
  if (typeof parsed.data.isPublic === 'boolean') patch.isPublic = parsed.data.isPublic
  if (typeof parsed.data.allowPlay === 'boolean') patch.allowPlay = parsed.data.allowPlay
  if (typeof parsed.data.romId === 'number' && parsed.data.romId !== row.romId) {
    return c.json({ error: '房间游戏和版本已锁定，请关闭后重新建房' }, 409)
  }
  if ('password' in parsed.data) {
    const pw = parsed.data.password
    patch.passwordHash = (pw === null || pw === '') ? null : await bcrypt.hash(pw, 10)
  }
  if (Object.keys(patch).length === 0) {
    return c.json(serializeRoom(row, {
      ...(await detailsForRoom(row)),
      hostUsername: me.username,
    }))
  }

  const [updated] = await db.update(rooms).set(patch).where(eq(rooms.code, code)).returning()
  return c.json(serializeRoom(updated, {
    ...(await detailsForRoom(updated)),
    hostUsername: me.username,
  }))
})

// Close a room (host or admin)
roomRoutes.delete('/:code', requireAuth, async (c) => {
  const me = c.get('user')
  const code = c.req.param('code').toUpperCase()
  const row = (await db.select().from(rooms).where(eq(rooms.code, code)).limit(1))[0]
  if (!row) return c.json({ error: '房间不存在' }, 404)
  if (row.hostUserId !== me.id && me.role !== 'admin') {
    return c.json({ error: '无权关闭该房间' }, 403)
  }
  await db.update(rooms)
    .set({ closedAt: new Date(), status: STATUS.deleted })
    .where(eq(rooms.code, code))
  return c.json({ ok: true })
})
