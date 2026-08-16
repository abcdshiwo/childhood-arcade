import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { assets, coreArtifacts } from '../db/schema.js'
import { createContentStore } from '../services/content-store.js'

const ASSET_ROOT = resolve(process.env.LIBRARY_ASSET_ROOT || 'data/library-assets')
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const contentStore = createContentStore({ root: ASSET_ROOT })

export const biosRoutes = new Hono()

function assetPath(asset) {
  return contentStore.resolveStoredPath(asset?.filePath)
}

function biosMember(core, fileName, sha) {
  try {
    const members = JSON.parse(core.provenanceJson || 'null')?.bios?.members
    if (!Array.isArray(members)) return null
    return members.find((member) =>
      member?.fileName === fileName &&
      String(member?.sha256 || '').toLowerCase() === sha &&
      Number.isInteger(member?.assetId),
    ) ?? null
  } catch {
    return null
  }
}

biosRoutes.get('/:fingerprint/:sha/:file', async (c) => {
  const fingerprint = c.req.param('fingerprint').toLowerCase()
  const requestedSha = c.req.param('sha').toLowerCase()
  const fileName = c.req.param('file')
  if (!SHA256_PATTERN.test(fingerprint) || !SHA256_PATTERN.test(requestedSha)) {
    return c.text('not found', 404)
  }
  const core = (await db.select().from(coreArtifacts)
    .where(eq(coreArtifacts.artifactFingerprint, fingerprint)).limit(1))[0]
  const member = core ? biosMember(core, fileName, requestedSha) : null
  if (!member) return c.text('not found', 404)
  const asset = (await db.select().from(assets)
    .where(eq(assets.id, member.assetId)).limit(1))[0]
  if (!asset || asset.sha256 !== requestedSha) return c.text('not found', 404)

  let body
  try {
    body = readFileSync(assetPath(asset))
  } catch {
    return c.text('not found', 404)
  }
  const contentType = extname(fileName).toLowerCase() === '.zip'
    ? 'application/zip'
    : 'application/octet-stream'
  return new Response(body, {
    headers: {
      'Content-Type': asset.mimeType || contentType,
      'Content-Length': String(body.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${asset.sha256}"`,
    },
  })
})
