import { createHash } from 'node:crypto'
import { createReadStream, statSync, unlinkSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '../db/index.js'
import {
  assets,
  batchBuildRefs,
  buildSourceMembers,
  buildValidationRuns,
  coreArtifacts,
  favorites,
  importOperations,
  romAssetRefs,
  romBuilds,
  roms,
  rooms,
  saveStates,
  users,
  STATUS,
} from '../db/schema.js'
import { currentUser, currentUserPrincipal, requireAuth } from '../middleware/auth.js'
import {
  computeBuildFingerprint,
  computeCompatibilityStatus,
} from '../services/build-contract.js'
import { createContentStore } from '../services/content-store.js'
import {
  countAssetReferences,
  hashCanonicalLibraryJson,
} from '../services/library-service.js'
import { getSetting } from './settings.js'

const ASSET_ROOT = resolve(process.env.LIBRARY_ASSET_ROOT || 'data/library-assets')
const MAX_SIZE = Number(process.env.MAX_UPLOAD_BYTES) || 100 * 1024 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const contentStore = createContentStore({ root: ASSET_ROOT })

const PLATFORM_DEFAULT_CORE = Object.freeze({
  arcade: 'fbneo',
  nes: 'fceumm',
  famicom: 'fceumm',
  fds: 'fceumm',
  sfc: 'snes9x',
  snes: 'snes9x',
  gb: 'mgba',
  gbc: 'mgba',
  gba: 'mgba',
  megadrive: 'genesis_plus_gx',
  genesis: 'genesis_plus_gx',
  sms: 'genesis_plus_gx',
  gamegear: 'genesis_plus_gx',
  psx: 'pcsx_rearmed',
})
const PLATFORM_ARCHIVE_EXTENSION = Object.freeze({
  arcade: '.zip',
  nes: '.nes',
  famicom: '.nes',
  fds: '.fds',
  sfc: '.sfc',
  snes: '.sfc',
  gb: '.gb',
  gbc: '.gbc',
  gba: '.gba',
  megadrive: '.md',
  genesis: '.md',
  sms: '.sms',
  gamegear: '.gg',
  psx: '.bin',
})
const ALLOWED_PLATFORMS = new Set(Object.keys(PLATFORM_DEFAULT_CORE))

const liveRom = (extra) =>
  extra ? and(eq(roms.status, STATUS.normal), extra) : eq(roms.status, STATUS.normal)

export const romRoutes = new Hono()
export const romBuildRoutes = new Hono()

function canonicalSetName(fileName) {
  const extension = extname(fileName)
  const stem = fileName.slice(0, extension ? -extension.length : undefined)
  const normalized = stem
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || `upload_${createHash('sha256').update(fileName).digest('hex').slice(0, 12)}`
}

function runtimeArchiveFileName(value) {
  if (typeof value !== 'string') return null
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.trim()
  if (!leaf || leaf.length > 255 || /[\u0000-\u001f\u007f]/.test(leaf)) return null
  return leaf
}

function runtimeHardwareFamily(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null
  }
  return normalized
}

function buildHardwareFamily(build) {
  try {
    const details = JSON.parse(build?._build?.staticFailureDetailsJson || 'null')
    return runtimeHardwareFamily(details?.hardwareFamily)
  } catch {
    return null
  }
}

function archiveFileName(build, rom) {
  try {
    const stored = JSON.parse(build.staticFailureDetailsJson || 'null')?.runtimeArchiveFileName
    const fileName = runtimeArchiveFileName(stored)
    if (fileName) return fileName
  } catch {}
  const extension = PLATFORM_ARCHIVE_EXTENSION[rom.platform] || '.bin'
  return `${rom.setNameNormalized}${extension}`
}

function resolveAssetPath(asset) {
  return contentStore.resolveStoredPath(asset?.filePath)
}

function biosMembers(core) {
  if (!core?.provenanceJson) return []
  try {
    const members = JSON.parse(core.provenanceJson)?.bios?.members
    if (!Array.isArray(members)) return []
    return members
      .filter((member) =>
        Number.isInteger(member?.assetId) &&
        typeof member?.fileName === 'string' &&
        SHA256_PATTERN.test(String(member?.sha256 || '').toLowerCase()),
      )
      .map((member) => ({
        assetId: member.assetId,
        fileName: member.fileName,
        sha256: member.sha256.toLowerCase(),
      }))
  } catch {
    return []
  }
}

export function serializeCoreArtifact(core) {
  if (!core) return null
  const fingerprint = core.artifactFingerprint
  const coreName = core.coreName
  const root = `/api/cores/${fingerprint}`
  return {
    id: core.id,
    name: coreName,
    version: core.displayVersion,
    artifactFingerprint: fingerprint,
    jsSha256: core.jsSha256,
    wasmSha256: core.wasmSha256,
    datSha256: core.datSha256 ?? null,
    biosManifestSha256: core.biosManifestSha256 ?? null,
    jsUrl: `${root}/${core.jsSha256}/${encodeURIComponent(coreName)}.js`,
    wasmUrl: `${root}/${core.wasmSha256}/${encodeURIComponent(coreName)}.wasm`,
    datUrl: core.datSha256
      ? `${root}/${core.datSha256}/${encodeURIComponent(coreName)}.dat`
      : null,
    bios: biosMembers(core).map((member) => ({
      fileName: member.fileName,
      sha256: member.sha256,
      url: `/api/bios/${fingerprint}/${member.sha256}/${encodeURIComponent(member.fileName)}`,
    })),
  }
}

async function acceptedResults(buildIds) {
  if (buildIds.length === 0) return new Map()
  const rows = await db
    .select({ buildId: buildValidationRuns.romBuildId, result: buildValidationRuns.result })
    .from(buildValidationRuns)
    .where(and(
      inArray(buildValidationRuns.romBuildId, buildIds),
      eq(buildValidationRuns.acceptance, 'accepted'),
    ))
  return new Map(rows.map((row) => [row.buildId, row.result]))
}

async function rowsByIds(table, column, ids) {
  if (ids.length === 0) return []
  return db.select().from(table).where(inArray(column, ids))
}

async function hydrateBuilds(buildIds) {
  const uniqueBuildIds = [...new Set(buildIds.filter(Number.isInteger))]
  if (uniqueBuildIds.length === 0) return new Map()

  const rootBuilds = await rowsByIds(romBuilds, romBuilds.id, uniqueBuildIds)
  const parents = await rowsByIds(
    romBuilds,
    romBuilds.id,
    [...new Set(rootBuilds.map((build) => build.runtimeParentBuildId).filter(Number.isInteger))],
  )
  const allBuilds = [...rootBuilds, ...parents]
  const buildById = new Map(allBuilds.map((build) => [build.id, build]))
  const romRows = await rowsByIds(
    roms,
    roms.id,
    [...new Set(allBuilds.map((build) => build.romId))],
  )
  const romById = new Map(romRows.map((rom) => [rom.id, rom]))
  const cores = await rowsByIds(
    coreArtifacts,
    coreArtifacts.id,
    [...new Set(rootBuilds.map((build) => build.coreArtifactId))],
  )
  const coreById = new Map(cores.map((core) => [core.id, core]))
  const archiveAssets = await rowsByIds(
    assets,
    assets.id,
    [...new Set(allBuilds.map((build) => build.archiveAssetId).filter(Number.isInteger))],
  )
  const assetById = new Map(archiveAssets.map((asset) => [asset.id, asset]))
  const validationByBuild = await acceptedResults(uniqueBuildIds)
  const result = new Map()

  for (const root of rootBuilds) {
    const rom = romById.get(root.romId)
    const core = coreById.get(root.coreArtifactId)
    if (!rom || !core) continue
    const compatStatus = computeCompatibilityStatus({
      staticStatus: root.staticStatus,
      acceptedResult: validationByBuild.get(root.id) ?? null,
    })
    const chain = []
    if (root.archiveLayout === 'split') {
      const parent = buildById.get(root.runtimeParentBuildId)
      if (parent) chain.push({ build: parent, role: 'parent' })
    }
    chain.push({ build: root, role: 'primary' })
    if (chain.some(({ build }) => {
      const asset = assetById.get(build.archiveAssetId)
      return !asset || asset.sha256 !== build.archiveSha256 || asset.fileSize < 0
    })) continue
    const archives = chain.map(({ build, role }) => {
      const archiveRom = romById.get(build.romId)
      const asset = assetById.get(build.archiveAssetId)
      if (!archiveRom || !asset) return null
      const fileName = archiveFileName(build, archiveRom)
      return {
        buildId: build.id,
        role,
        fileName,
        sha256: asset.sha256,
        fileSize: asset.fileSize,
        url: `/api/rom-builds/${build.id}/file/${encodeURIComponent(fileName)}?forBuild=${root.id}`,
      }
    }).filter(Boolean)

    result.set(root.id, {
      id: root.id,
      romId: root.romId,
      fingerprint: root.buildFingerprint,
      contentManifestSha256: root.contentManifestSha256,
      compatStatus,
      archiveLayout: root.archiveLayout,
      runtimeParentBuildId: root.runtimeParentBuildId ?? null,
      core: serializeCoreArtifact(core),
      archives,
      createdAt: root.createdAt,
      _build: root,
      _rom: rom,
      _archiveAssets: new Map(
        chain.map(({ build }) => [build.id, assetById.get(build.archiveAssetId)]),
      ),
    })
  }
  return result
}

async function thumbnailDetails(romRows) {
  const refs = await rowsByIds(
    romAssetRefs,
    romAssetRefs.id,
    romRows.map((rom) => rom.activeThumbnailRefId).filter(Number.isInteger),
  )
  const refById = new Map(refs.map((ref) => [ref.id, ref]))
  const thumbAssets = await rowsByIds(
    assets,
    assets.id,
    [...new Set(refs.map((ref) => ref.assetId))],
  )
  return {
    refById,
    assetById: new Map(thumbAssets.map((asset) => [asset.id, asset])),
  }
}

function publicBuild(build, rom) {
  return Boolean(
    build &&
    rom.status === STATUS.normal &&
    rom.isPublic &&
    build.compatStatus === 'ready',
  )
}

function publicBuildView(build) {
  if (!build) return null
  const { _build, _rom, _archiveAssets, ...view } = build
  return view
}

export async function serializeRomRows(romRows, {
  ownerById = new Map(),
  favoriteIds = new Set(),
  versionCounts = new Map(),
} = {}) {
  const builds = await hydrateBuilds(
    romRows.map((rom) => rom.activeBuildId).filter(Number.isInteger),
  )
  const { refById, assetById } = await thumbnailDetails(romRows)
  return romRows.map((rom) => {
    const build = builds.get(rom.activeBuildId) ?? null
    const primaryArchive = build?.archives.find((archive) => archive.role === 'primary') ?? null
    const candidateThumbnailRef = refById.get(rom.activeThumbnailRefId) ?? null
    const candidateThumbnailAsset = candidateThumbnailRef
      ? assetById.get(candidateThumbnailRef.assetId)
      : null
    const thumbnailAsset = candidateThumbnailAsset?.kind === 'thumbnail'
      ? candidateThumbnailAsset
      : null
    const thumbnailRef = thumbnailAsset ? candidateThumbnailRef : null
    return {
      id: rom.id,
      title: rom.title,
      platform: rom.platform,
      hardwareFamily: buildHardwareFamily(build),
      setName: rom.setNameNormalized,
      setNameNormalized: rom.setNameNormalized,
      variantKind: rom.variantKind ?? null,
      datParentSetName: rom.datParentSetName ?? null,
      familyRootSetName: rom.familyRootSetName ?? null,
      versionLabel: rom.versionLabel ?? null,
      isPublic: Boolean(rom.isPublic),
      userId: rom.userId,
      owner: ownerById.get(rom.userId),
      parentRomId: rom.parentRomId ?? null,
      versionCount: versionCounts.get(rom.id),
      isFavorite: favoriteIds.has(rom.id),
      buildId: build?.id ?? null,
      coreName: build?.core?.name ?? null,
      coreVersion: build?.core?.version ?? null,
      coreArtifactFingerprint: build?.core?.artifactFingerprint ?? null,
      compatStatus: build?.compatStatus ?? null,
      archiveLayout: build?.archiveLayout ?? null,
      activeBuild: publicBuildView(build),
      thumbnailUrl: thumbnailAsset
        ? `/api/roms/${rom.id}/thumbnail?v=${thumbnailAsset.sha256}`
        : null,
      thumbnailMatchKind: thumbnailRef?.matchKind ?? null,
      thumbnailSourceSetName: thumbnailRef?.sourceSetName ?? null,
      fileName: primaryArchive?.fileName ?? null,
      fileSize: primaryArchive?.fileSize ?? null,
      createdAt: rom.createdAt,
      updatedAt: rom.updatedAt,
    }
  })
}

async function serializeRomById(id) {
  const rom = (await db.select().from(roms).where(eq(roms.id, id)).limit(1))[0]
  if (!rom) return null
  return (await serializeRomRows([rom]))[0]
}

async function childCountsFor(parentIds) {
  if (parentIds.length === 0) return new Map()
  const rows = await db
    .select({ parentRomId: roms.parentRomId, n: sql`count(*)`.as('n') })
    .from(roms)
    .where(and(eq(roms.status, STATUS.normal), inArray(roms.parentRomId, parentIds)))
    .groupBy(roms.parentRomId)
  return new Map(rows.map((row) => [row.parentRomId, Number(row.n)]))
}

async function favoriteSetFor(user, romIds) {
  if (!user || romIds.length === 0) return new Set()
  const rows = await db
    .select({ romId: favorites.romId })
    .from(favorites)
    .where(and(eq(favorites.userId, user.id), inArray(favorites.romId, romIds)))
  return new Set(rows.map((row) => row.romId))
}

function ownerMap(rows) {
  return new Map(rows.map(({ user }) => [user.id, user]))
}

romRoutes.get('/mine', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(roms)
    .where(liveRom(eq(roms.userId, user.id)))
    .orderBy(desc(roms.createdAt))
  const favoriteIds = await favoriteSetFor(user, rows.map((rom) => rom.id))
  const versionCounts = await childCountsFor(rows.filter((rom) => !rom.parentRomId).map((rom) => rom.id))
  return c.json({ roms: await serializeRomRows(rows, { favoriteIds, versionCounts }) })
})

romRoutes.get('/trash', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(roms)
    .where(and(eq(roms.status, STATUS.deleted), eq(roms.userId, user.id)))
    .orderBy(desc(roms.updatedAt))
  return c.json({ roms: await serializeRomRows(rows) })
})

romRoutes.post('/:id/restore', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const rom = (await db.select().from(roms).where(eq(roms.id, id)).limit(1))[0]
  if (!rom) return c.json({ error: '不存在' }, 404)
  if (rom.userId !== user.id && user.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
  if (rom.status !== STATUS.normal) {
    await db.update(roms).set({ status: STATUS.normal }).where(eq(roms.id, id))
  }
  return c.json({ ok: true })
})

romRoutes.get('/public', async (c) => {
  const rows = await db.select({
    rom: roms,
    user: { id: users.id, username: users.username },
  })
    .from(roms)
    .innerJoin(users, eq(users.id, roms.userId))
    .where(liveRom(eq(roms.isPublic, true)))
    .orderBy(desc(roms.createdAt))
  const me = await currentUser(c)
  const favoriteIds = await favoriteSetFor(me, rows.map(({ rom }) => rom.id))
  const versionCounts = await childCountsFor(rows.filter(({ rom }) => !rom.parentRomId).map(({ rom }) => rom.id))
  const serialized = await serializeRomRows(rows.map(({ rom }) => rom), {
    ownerById: ownerMap(rows),
    favoriteIds,
    versionCounts,
  })
  return c.json({ roms: serialized.filter((rom) => rom.compatStatus === 'ready') })
})

romRoutes.get('/:id/versions', async (c) => {
  const id = Number(c.req.param('id'))
  const seed = (await db.select().from(roms).where(liveRom(eq(roms.id, id))).limit(1))[0]
  if (!seed) return c.json({ versions: [] })
  const parentId = seed.parentRomId ?? seed.id
  const rows = await db.select({
    rom: roms,
    user: { id: users.id, username: users.username },
  })
    .from(roms)
    .innerJoin(users, eq(users.id, roms.userId))
    .where(liveRom(or(eq(roms.id, parentId), eq(roms.parentRomId, parentId))))
    .orderBy(roms.id)
  const me = await currentUser(c)
  const serialized = await serializeRomRows(rows.map(({ rom }) => rom), {
    ownerById: ownerMap(rows),
  })
  return c.json({
    parentId,
    versions: serialized.filter((rom) =>
      me?.role === 'admin' || rom.userId === me?.id || (rom.isPublic && rom.compatStatus === 'ready'),
    ),
  })
})

romRoutes.get('/favorites', requireAuth, async (c) => {
  const user = c.get('user')
  const rows = await db.select({
    rom: roms,
    user: { id: users.id, username: users.username },
  })
    .from(favorites)
    .innerJoin(roms, eq(roms.id, favorites.romId))
    .innerJoin(users, eq(users.id, roms.userId))
    .where(and(eq(favorites.userId, user.id), eq(roms.status, STATUS.normal)))
    .orderBy(desc(favorites.createdAt))
  const serialized = await serializeRomRows(rows.map(({ rom }) => rom), {
    ownerById: ownerMap(rows),
    favoriteIds: new Set(rows.map(({ rom }) => rom.id)),
  })
  return c.json({
    roms: serialized.filter((rom) =>
      user.role === 'admin' || rom.userId === user.id || (rom.isPublic && rom.compatStatus === 'ready'),
    ),
  })
})

romRoutes.post('/:id/favorite', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const source = (await db.select().from(roms).where(liveRom(eq(roms.id, id))).limit(1))[0]
  const rom = source ? await serializeRomById(id) : null
  if (!rom) return c.json({ error: '不存在' }, 404)
  if (
    user.role !== 'admin' &&
    rom.userId !== user.id &&
    !(rom.isPublic && rom.compatStatus === 'ready')
  ) {
    return c.json({ error: 'forbidden' }, 403)
  }
  await db.insert(favorites).values({ userId: user.id, romId: id }).onConflictDoNothing()
  return c.json({ ok: true, isFavorite: true })
})

romRoutes.delete('/:id/favorite', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  await db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.romId, id)))
  return c.json({ ok: true, isFavorite: false })
})

async function defaultCoreFor(platform) {
  const coreName = PLATFORM_DEFAULT_CORE[platform]
  if (!coreName) return null
  return (await db.select().from(coreArtifacts)
    .where(and(eq(coreArtifacts.coreName, coreName), eq(coreArtifacts.isEnabled, true)))
    .orderBy(desc(coreArtifacts.createdAt), desc(coreArtifacts.id))
    .limit(1))[0] ?? null
}

function existingLogicalRom(tx, userId, platform, setName) {
  return tx.select().from(roms).where(and(
    eq(roms.userId, userId),
    eq(roms.platform, platform),
    eq(roms.setNameNormalized, setName),
  )).limit(1).get()
}

romRoutes.post('/upload', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody({ all: false })
  const file = body.file
  if (!file || typeof file === 'string') return c.json({ error: '未收到文件' }, 400)
  if (file.size > MAX_SIZE) {
    return c.json({ error: `文件超过 ${Math.max(1, Math.round(MAX_SIZE / 1024 / 1024))}MB` }, 413)
  }
  const platform = String(body.platform || '')
  if (!ALLOWED_PLATFORMS.has(platform)) return c.json({ error: '不支持的平台' }, 400)
  let core = await defaultCoreFor(platform)
  if (!core) return c.json({ error: '该平台尚未配置可用核心' }, 409)

  const titleResult = z.string().min(1).max(128).safeParse(
    String(body.title || '').trim() || file.name,
  )
  if (!titleResult.success) return c.json({ error: '标题格式不正确' }, 400)

  let parentRomId = null
  let versionLabel = null
  let runtimeParentBuild = null
  let datParentSetName = null
  let familyRootSetName = null
  if (body.parentRomId) {
    const pid = Number(body.parentRomId)
    if (Number.isInteger(pid) && pid > 0) {
      const parent = (await db.select().from(roms).where(liveRom(eq(roms.id, pid))).limit(1))[0]
      if (!parent) return c.json({ error: '父 ROM 不存在' }, 400)
      if (parent.platform !== platform) return c.json({ error: '父 ROM 平台不匹配' }, 400)
      if (!parent.isPublic && parent.userId !== user.id && user.role !== 'admin') {
        return c.json({ error: '无权引用该父 ROM' }, 403)
      }
      if (parent.parentRomId) return c.json({ error: '不支持嵌套版本' }, 400)
      runtimeParentBuild = parent.activeBuildId
        ? (await db.select().from(romBuilds)
            .where(eq(romBuilds.id, parent.activeBuildId)).limit(1))[0] ?? null
        : null
      if (!runtimeParentBuild || runtimeParentBuild.romId !== parent.id) {
        return c.json({ error: '父 ROM 尚未配置可运行构建' }, 409)
      }
      core = (await db.select().from(coreArtifacts)
        .where(eq(coreArtifacts.id, runtimeParentBuild.coreArtifactId)).limit(1))[0] ?? null
      if (!core) return c.json({ error: '父 ROM 的核心构建不存在' }, 409)
      parentRomId = parent.id
      datParentSetName = parent.setNameNormalized
      familyRootSetName = parent.familyRootSetName || parent.setNameNormalized
      versionLabel = String(body.versionLabel || '').trim().slice(0, 64) || '变体'
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  let mutationLock
  try {
    mutationLock = contentStore.acquireMutationLock({
      operation: 'manual-upload',
      userId: user.id,
    })
  } catch (error) {
    if (/content mutation lock already exists/i.test(error.message)) {
      return c.json({ error: '内容库正在维护，请稍后重试' }, 503)
    }
    throw error
  }
  try {
  const stored = contentStore.putBytes({
    bytes,
    expectedSha256: archiveSha256,
    expectedSize: bytes.length,
    kind: 'rom',
  })
  const setName = canonicalSetName(file.name)
  const contentManifestSha256 = hashCanonicalLibraryJson({
    schemaVersion: 1,
    kind: 'manual-opaque-v1',
    archiveName: file.name,
    archiveSize: bytes.length,
    archiveSha256,
    runtimeParentBuildFingerprint: runtimeParentBuild?.buildFingerprint ?? null,
  })

  let romId
  try {
    romId = db.transaction((tx) => {
      let rom = existingLogicalRom(tx, user.id, platform, setName)
      if (!rom) {
        rom = tx.insert(roms).values({
          userId: user.id,
          title: titleResult.data,
          platform,
          fileName: file.name,
          filePath: stored.filePath,
          fileSize: bytes.length,
          isPublic: false,
          parentRomId,
          setNameNormalized: setName,
          datParentSetName,
          familyRootSetName: familyRootSetName || setName,
          versionLabel,
        }).returning().get()
      } else if (rom.parentRomId !== parentRomId) {
        throw new Error('同名 ROM 已存在且版本归属不同')
      }

      if (runtimeParentBuild) {
        const currentParent = tx.select({ activeBuildId: roms.activeBuildId }).from(roms)
          .where(eq(roms.id, parentRomId)).limit(1).get()
        if (currentParent?.activeBuildId !== runtimeParentBuild.id) {
          throw new Error('父 ROM 的活动构建已更新，请重试')
        }
      }

      let asset = tx.select().from(assets).where(eq(assets.sha256, stored.sha256)).limit(1).get()
      if (!asset) {
        asset = tx.insert(assets).values({
          kind: 'rom',
          filePath: stored.filePath,
          mimeType: file.type || 'application/octet-stream',
          fileSize: stored.fileSize,
          sha256: stored.sha256,
        }).returning().get()
      }

      const buildFingerprint = computeBuildFingerprint({
        logicalRomScope: `manual:rom:${rom.id}`,
        setNameNormalized: setName,
        coreArtifactFingerprint: core.artifactFingerprint,
        archiveSha256,
        contentManifestSha256,
        archiveLayout: runtimeParentBuild ? 'split' : 'standalone',
        runtimeParentBuildFingerprint: runtimeParentBuild?.buildFingerprint ?? null,
        biosManifestSha256: core.biosManifestSha256 ?? null,
      })
      let build = tx.select().from(romBuilds)
        .where(eq(romBuilds.buildFingerprint, buildFingerprint)).limit(1).get()
      if (!build) {
        build = tx.insert(romBuilds).values({
          romId: rom.id,
          coreArtifactId: core.id,
          archiveAssetId: asset.id,
          archiveSha256,
          contentManifestSha256,
          buildFingerprint,
          staticStatus: 'complete',
          staticFailureDetailsJson: JSON.stringify({
            runtimeArchiveFileName: runtimeArchiveFileName(file.name),
          }),
          archiveLayout: runtimeParentBuild ? 'split' : 'standalone',
          runtimeParentBuildId: runtimeParentBuild?.id ?? null,
        }).returning().get()
      }

      tx.update(roms).set({
        title: titleResult.data,
        fileName: file.name,
        filePath: stored.filePath,
        fileSize: bytes.length,
        isPublic: false,
        activeBuildId: build.id,
        status: STATUS.normal,
      }).where(eq(roms.id, rom.id)).run()
      return rom.id
    })
  } catch (error) {
    contentStore.cleanupCreated([stored], {
      isReferenced: () => Boolean(
        db.select({ id: assets.id }).from(assets).where(eq(assets.sha256, stored.sha256)).limit(1).get(),
      ),
    })
    if (/同名 ROM|父 ROM/.test(error.message)) return c.json({ error: error.message }, 409)
    throw error
  }
    return c.json(await serializeRomById(romId))
  } finally {
    mutationLock.release()
  }
})

romRoutes.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const rom = (await db.select().from(roms).where(liveRom(eq(roms.id, id))).limit(1))[0]
  if (!rom) return c.json({ error: '不存在' }, 404)
  if (rom.userId !== user.id && user.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
  const body = await c.req.json().catch(() => ({}))
  const patch = {}
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 128)
  if (typeof body.isPublic === 'boolean') {
    if (body.isPublic && (await serializeRomById(id))?.compatStatus !== 'ready') {
      return c.json({ error: '构建尚未通过验证，不能公开' }, 409)
    }
    patch.isPublic = body.isPublic
  }
  if (Object.keys(patch).length > 0) {
    await db.update(roms).set(patch).where(eq(roms.id, id))
  }
  return c.json(await serializeRomById(id))
})

async function hardDeleteBlocker(rom, builds) {
  const buildIds = builds.map((build) => build.id)
  if ((await db.select({ id: roms.id }).from(roms)
    .where(eq(roms.parentRomId, rom.id)).limit(1))[0]) {
    return '存在引用该 ROM 的版本'
  }
  if (buildIds.length === 0) return null
  if (await importHistoryReferencesBuilds(builds)) {
    return '存在引用该构建的导入或回滚历史'
  }
  const checks = [
    ['存在引用该构建的房间', rooms, rooms.romBuildId],
    ['存在引用该构建的存档', saveStates, saveStates.romBuildId],
    ['存在引用该构建的运行时子构建', romBuilds, romBuilds.runtimeParentBuildId],
    ['存在引用该构建的导入批次', batchBuildRefs, batchBuildRefs.romBuildId],
    ['存在引用该构建的来源历史', buildSourceMembers, buildSourceMembers.romBuildId],
    ['存在引用该构建的验证历史', buildValidationRuns, buildValidationRuns.romBuildId],
  ]
  for (const [message, table, column] of checks) {
    if ((await db.select({ id: column }).from(table).where(inArray(column, buildIds)).limit(1))[0]) {
      return message
    }
  }
  return null
}

const BUILD_ID_FIELDS = new Set([
  'activeBuildId',
  'active_build_id',
  'buildId',
  'build_id',
  'romBuildId',
  'rom_build_id',
  'runtimeParentBuildId',
  'runtime_parent_build_id',
])
const BUILD_FINGERPRINT_FIELDS = new Set([
  'buildFingerprint',
  'build_fingerprint',
  'runtimeParentBuildFingerprint',
  'runtime_parent_build_fingerprint',
])

function operationPayloadReferencesBuild(value, buildIds, buildFingerprints, entityIsBuild = false) {
  if (Array.isArray(value)) {
    return value.some((item) =>
      operationPayloadReferencesBuild(item, buildIds, buildFingerprints, entityIsBuild),
    )
  }
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => {
    if (BUILD_ID_FIELDS.has(key) && buildIds.has(Number(child))) return true
    if (BUILD_FINGERPRINT_FIELDS.has(key) && buildFingerprints.has(String(child))) return true
    if (entityIsBuild && key === 'id' && buildIds.has(Number(child))) return true
    if (entityIsBuild && key === 'fingerprint' && buildFingerprints.has(String(child))) return true
    return operationPayloadReferencesBuild(child, buildIds, buildFingerprints, entityIsBuild)
  })
}

async function importHistoryReferencesBuilds(builds) {
  const buildIds = new Set(builds.map((build) => build.id))
  const buildFingerprints = new Set(builds.map((build) => build.buildFingerprint))
  const operations = await db.select({
    entityType: importOperations.entityType,
    entityKey: importOperations.entityKey,
    beforeJson: importOperations.beforeJson,
    afterJson: importOperations.afterJson,
  }).from(importOperations)

  for (const operation of operations) {
    const entityIsBuild = /(^|[_-])build($|[_-])|rombuild/i.test(operation.entityType)
    const entityKey = String(operation.entityKey)
    if (entityIsBuild && (
      buildFingerprints.has(entityKey) ||
      [...buildIds].some((id) => entityKey === String(id) || entityKey.endsWith(`:${id}`))
    )) return true

    for (const raw of [operation.beforeJson, operation.afterJson]) {
      if (raw === null) continue
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return true
      }
      if (operationPayloadReferencesBuild(
        payload,
        buildIds,
        buildFingerprints,
        entityIsBuild,
      )) return true
    }
  }
  return false
}

async function assetStillReferenced(assetId) {
  return countAssetReferences(db.$client, assetId) > 0
}

romRoutes.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const permanent = ['1', 'true'].includes(c.req.query('permanent'))
  const rom = (await db.select().from(roms)
    .where(permanent ? eq(roms.id, id) : liveRom(eq(roms.id, id))).limit(1))[0]
  if (!rom) return c.json({ error: '不存在' }, 404)
  if (rom.userId !== user.id && user.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
  if (!permanent) {
    await db.update(roms).set({ status: STATUS.deleted }).where(eq(roms.id, id))
    return c.json({ ok: true, mode: 'soft' })
  }

  let mutationLock
  try {
    mutationLock = contentStore.acquireMutationLock({
      operation: 'hard-delete',
      userId: user.id,
      romId: id,
    })
  } catch (error) {
    if (/content mutation lock already exists/i.test(error.message)) {
      return c.json({ error: '内容库正在维护，请稍后重试' }, 503)
    }
    throw error
  }
  try {
    const builds = await db.select().from(romBuilds).where(eq(romBuilds.romId, id))
    const blocker = await hardDeleteBlocker(rom, builds)
    if (blocker) return c.json({ error: blocker }, 409)
    const refs = await db.select().from(romAssetRefs).where(eq(romAssetRefs.romId, id))
    const candidateAssetIds = new Set([
      ...builds.map((build) => build.archiveAssetId).filter(Number.isInteger),
      ...refs.map((ref) => ref.assetId),
    ])
    db.transaction((tx) => {
      tx.update(roms).set({ activeBuildId: null, activeThumbnailRefId: null })
        .where(eq(roms.id, id)).run()
      tx.delete(romAssetRefs).where(eq(romAssetRefs.romId, id)).run()
      tx.delete(romBuilds).where(eq(romBuilds.romId, id)).run()
      tx.delete(roms).where(eq(roms.id, id)).run()
    })
    for (const assetId of candidateAssetIds) {
      if (await assetStillReferenced(assetId)) continue
      const asset = (await db.select().from(assets).where(eq(assets.id, assetId)).limit(1))[0]
      if (!asset) continue
      try { unlinkSync(resolveAssetPath(asset)) } catch {}
      await db.delete(assets).where(eq(assets.id, assetId))
    }
    return c.json({ ok: true, mode: 'permanent', purgedCount: builds.length })
  } finally {
    mutationLock.release()
  }
})

async function roomHostCanRead(user, buildId) {
  if (!user) return false
  return Boolean((await db.select({ id: rooms.id }).from(rooms).where(and(
    eq(rooms.romBuildId, buildId),
    eq(rooms.hostUserId, user.id),
    eq(rooms.status, STATUS.normal),
    isNull(rooms.closedAt),
  )).limit(1))[0])
}

async function authorizeBuild(c, build) {
  const user = await currentUser(c)
  if (user?.role === 'admin') return { ok: true, user }
  if (await roomHostCanRead(user, build.id)) return { ok: true, user }
  if (build._rom.activeBuildId !== build.id) {
    return { ok: false, status: 404, error: 'not found' }
  }
  if (build._rom.status !== STATUS.normal) {
    return { ok: false, status: 404, error: 'not found' }
  }
  if (build._rom.userId === user?.id) return { ok: true, user }
  if (!publicBuild(build, build._rom)) {
    return { ok: false, status: user ? 403 : 401, error: user ? 'forbidden' : '请先登录' }
  }
  if (user) return { ok: true, user }
  if ((await getSetting('guestPlayEnabled', '0')) === '1') return { ok: true, user: null }
  return { ok: false, status: 401, error: '请先登录' }
}

async function exactBuild(id) {
  return (await hydrateBuilds([id])).get(id) ?? null
}

romBuildRoutes.get('/:buildId/file/:name', async (c) => {
  const requestedBuildId = Number(c.req.param('buildId'))
  const rootBuildId = Number(c.req.query('forBuild') || requestedBuildId)
  const root = await exactBuild(rootBuildId)
  if (!root) return c.json({ error: 'not found' }, 404)
  const access = await authorizeBuild(c, root)
  if (!access.ok) return c.json({ error: access.error }, access.status)
  const archive = root.archives.find((candidate) => candidate.buildId === requestedBuildId)
  if (!archive || archive.fileName !== c.req.param('name')) {
    return c.json({ error: 'not found' }, 404)
  }
  const asset = root._archiveAssets.get(requestedBuildId)
  if (!asset) return c.json({ error: 'not found' }, 404)
  let fullPath
  let metadata
  try {
    fullPath = resolveAssetPath(asset)
    metadata = statSync(fullPath)
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
  c.header('Content-Type', asset.mimeType || 'application/octet-stream')
  c.header('Content-Length', String(metadata.size))
  c.header('Content-Disposition', `inline; filename="${encodeURIComponent(archive.fileName)}"`)
  c.header('ETag', `"${asset.sha256}"`)
  c.header('Cache-Control', 'private, max-age=31536000, immutable')
  return stream(c, async (target) => {
    const source = createReadStream(fullPath)
    await target.pipe(new ReadableStream({
      start(controller) {
        source.on('data', (chunk) => controller.enqueue(chunk))
        source.on('end', () => controller.close())
        source.on('error', (error) => controller.error(error))
      },
    }))
  })
})

romBuildRoutes.get('/:buildId', async (c) => {
  const id = Number(c.req.param('buildId'))
  const build = await exactBuild(id)
  if (!build) return c.json({ error: 'not found' }, 404)
  const access = await authorizeBuild(c, build)
  if (!access.ok) return c.json({ error: access.error }, access.status)
  return c.json({ build: publicBuildView(build) })
})

romRoutes.get('/:id/thumbnail', async (c) => {
  const id = Number(c.req.param('id'))
  const version = String(c.req.query('v') || '').toLowerCase()
  if (!SHA256_PATTERN.test(version)) return c.json({ error: 'not found' }, 404)
  const resource = (await db.select({
    ownerId: roms.userId,
    romStatus: roms.status,
    isPublic: roms.isPublic,
    thumbnailImportBatchId: romAssetRefs.importBatchId,
    asset: assets,
    buildStaticStatus: romBuilds.staticStatus,
    acceptedResult: buildValidationRuns.result,
  })
    .from(roms)
    .innerJoin(romAssetRefs, and(
      eq(romAssetRefs.id, roms.activeThumbnailRefId),
      eq(romAssetRefs.romId, roms.id),
    ))
    .innerJoin(assets, eq(assets.id, romAssetRefs.assetId))
    .leftJoin(romBuilds, and(
      eq(romBuilds.id, roms.activeBuildId),
      eq(romBuilds.romId, roms.id),
    ))
    .leftJoin(buildValidationRuns, and(
      eq(buildValidationRuns.romBuildId, romBuilds.id),
      eq(buildValidationRuns.acceptance, 'accepted'),
    ))
    .where(eq(roms.id, id))
    .limit(1))[0]
  const asset = resource?.asset
  if (!asset || asset.kind !== 'thumbnail' || asset.sha256 !== version) {
    return c.json({ error: 'not found' }, 404)
  }
  const publiclyReadable = Boolean(
    resource.romStatus === STATUS.normal &&
    resource.isPublic &&
    resource.buildStaticStatus &&
    computeCompatibilityStatus({
      staticStatus: resource.buildStaticStatus,
      acceptedResult: resource.acceptedResult,
    }) === 'ready',
  )
  if (!publiclyReadable) {
    const user = await currentUserPrincipal(c)
    if (user?.role !== 'admin' && user?.id !== resource.ownerId) {
      return c.json({ error: user ? 'forbidden' : 'unauthorized' }, user ? 403 : 401)
    }
  }
  let fullPath
  let metadata
  try {
    fullPath = resolveAssetPath(asset)
    metadata = statSync(fullPath)
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
  c.header('Content-Type', asset.mimeType || 'image/webp')
  c.header('Content-Length', String(metadata.size))
  c.header('ETag', `"${asset.sha256}"`)
  const immutableCatalogAsset = Boolean(
    publiclyReadable && resource.thumbnailImportBatchId,
  )
  c.header(
    'Cache-Control',
    immutableCatalogAsset
      ? 'public, max-age=31536000, immutable'
      : publiclyReadable
        ? 'public, max-age=0, must-revalidate'
        : 'private, no-store',
  )
  return stream(c, async (target) => {
    const source = createReadStream(fullPath)
    await target.pipe(new ReadableStream({
      start(controller) {
        source.on('data', (chunk) => controller.enqueue(chunk))
        source.on('end', () => controller.close())
        source.on('error', (error) => controller.error(error))
      },
    }))
  })
})
