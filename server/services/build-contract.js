import { createHash } from 'node:crypto'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SET_NAME_PATTERN = /^[a-z0-9_]+$/
const LOGICAL_ROM_SCOPE_PATTERN = /^[a-z0-9][a-z0-9:._/-]*$/
const ARCHIVE_LAYOUTS = new Set(['standalone', 'split'])
const STATIC_STATUSES = new Set(['complete', 'blocked', 'unsupported'])
const VALIDATION_RESULTS = new Set(['passed', 'failed', 'inconclusive'])
const ACCEPTANCE_STATES = new Set(['pending', 'accepted', 'rejected'])

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function normalizedSha256(value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value.toLowerCase())) {
    throw new TypeError(`${field} must be a 64-character SHA-256 hex string`)
  }
  return value.toLowerCase()
}

function normalizedSetName(value) {
  if (typeof value !== 'string') {
    throw new TypeError('setNameNormalized must be a string')
  }
  const normalized = value.trim().toLowerCase()
  if (!SET_NAME_PATTERN.test(normalized)) {
    throw new TypeError('setNameNormalized must be a lowercase canonical shortname')
  }
  return normalized
}

function normalizedLogicalRomScope(value) {
  if (typeof value !== 'string') {
    throw new TypeError('logicalRomScope must be a string')
  }
  const normalized = value.trim()
  if (!LOGICAL_ROM_SCOPE_PATTERN.test(normalized)) {
    throw new TypeError('logicalRomScope must be a stable lowercase scope key')
  }
  return normalized
}

export function canonicalizeBuildFingerprint(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new TypeError('build identity must be an object')
  }
  for (const field of [
    'logicalRomScope',
    'setNameNormalized',
    'coreArtifactFingerprint',
    'archiveSha256',
    'contentManifestSha256',
    'archiveLayout',
    'runtimeParentBuildFingerprint',
    'biosManifestSha256',
  ]) {
    if (!hasOwn(identity, field)) throw new TypeError(`${field} is required`)
  }

  if (!ARCHIVE_LAYOUTS.has(identity.archiveLayout)) {
    throw new TypeError('archiveLayout must be standalone or split')
  }

  const parentFingerprint = normalizedSha256(
    identity.runtimeParentBuildFingerprint,
    'runtimeParentBuildFingerprint',
    { nullable: true },
  )
  if (identity.archiveLayout === 'standalone' && parentFingerprint !== null) {
    throw new TypeError('standalone archiveLayout cannot have a runtime parent')
  }
  if (identity.archiveLayout === 'split' && parentFingerprint === null) {
    throw new TypeError('split archiveLayout requires a runtime parent')
  }

  return JSON.stringify({
    logicalRomScope: normalizedLogicalRomScope(identity.logicalRomScope),
    setNameNormalized: normalizedSetName(identity.setNameNormalized),
    coreArtifactFingerprint: normalizedSha256(
      identity.coreArtifactFingerprint,
      'coreArtifactFingerprint',
    ),
    archiveSha256: normalizedSha256(identity.archiveSha256, 'archiveSha256', {
      nullable: true,
    }),
    contentManifestSha256: normalizedSha256(
      identity.contentManifestSha256,
      'contentManifestSha256',
    ),
    archiveLayout: identity.archiveLayout,
    runtimeParentBuildFingerprint: parentFingerprint,
    biosManifestSha256: normalizedSha256(
      identity.biosManifestSha256,
      'biosManifestSha256',
      { nullable: true },
    ),
  })
}

export function computeBuildFingerprint(identity) {
  return createHash('sha256')
    .update(canonicalizeBuildFingerprint(identity), 'utf8')
    .digest('hex')
}

export function validateValidationAcceptance({ result, acceptance }) {
  if (!VALIDATION_RESULTS.has(result)) {
    throw new TypeError(`unknown validation result: ${result}`)
  }
  if (!ACCEPTANCE_STATES.has(acceptance)) {
    throw new TypeError(`unknown validation acceptance: ${acceptance}`)
  }
  if (result === 'inconclusive' && acceptance === 'accepted') {
    throw new TypeError('inconclusive validation cannot be accepted')
  }
  return true
}

export function computeCompatibilityStatus({ staticStatus, acceptedResult = null }) {
  if (!STATIC_STATUSES.has(staticStatus)) {
    throw new TypeError(`unknown static status: ${staticStatus}`)
  }
  if (acceptedResult !== null) {
    validateValidationAcceptance({ result: acceptedResult, acceptance: 'accepted' })
  }

  if (staticStatus === 'unsupported') return 'unsupported'
  if (staticStatus === 'blocked') return 'blocked'
  if (acceptedResult === null) return 'unverified'
  if (acceptedResult === 'passed') return 'ready'
  return 'blocked'
}

export function assertActivePointerOwnership({
  romId,
  activeBuild = null,
  activeThumbnailRef = null,
}) {
  if (!Number.isInteger(romId) || romId <= 0) {
    throw new TypeError('romId must be a positive integer')
  }
  if (activeBuild !== null && activeBuild.romId !== romId) {
    throw new Error(`active build does not belong to ROM ${romId}`)
  }
  if (activeThumbnailRef !== null && activeThumbnailRef.romId !== romId) {
    throw new Error(`active thumbnail does not belong to ROM ${romId}`)
  }
  return true
}
