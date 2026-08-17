#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalizeLibraryJson, computeCoreArtifactFingerprint } from '../../server/services/library-service.js'
import { computeBuildFingerprint } from '../../server/services/build-contract.js'

const SHA256 = /^[0-9a-f]{64}$/i
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FINAL_STATES = new Set(['ready', 'blocked', 'unsupported', 'unverified'])
const RUN_RESULTS = new Set(['passed', 'failed', 'inconclusive'])
const ACCEPTANCE = new Set(['pending', 'accepted', 'rejected'])
const LAYOUTS = new Set(['standalone', 'split'])
const PINNED_BROWSER_SHA256 = 'ac9bc025ed6be1ba6cf403116a68d2467c3e8da03844e642498e77cc2c799ac2'
const PINNED_HARNESS_VERSION = 'arcade-smoke-v1'

export const W165_LEDGER_EXPECTATIONS = Object.freeze({
  candidateRows: 656,
  runtimeCoreScopedContracts: 655,
  globalRawPayloadIdentities: 654,
  archiveLayouts: Object.freeze({ standalone: 558, split: 98 }),
  thumbnailMatchKinds: Object.freeze({ exact: 455, alias: 8, parent: 53, source_reference: 140 }),
  coreCount: 5,
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function requiredHash(value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${field} must be a 64-character SHA-256`)
  }
  return value.toLowerCase()
}

function uniqueRows(rows, key, label) {
  if (!Array.isArray(rows)) throw new TypeError(`${label} must be an array`)
  const index = new Map()
  for (const row of rows) {
    const value = requiredString(row?.[key], `${label}.${key}`)
    if (index.has(value)) throw new Error(`${label} contains duplicate ${key} ${value}`)
    index.set(value, row)
  }
  return index
}

function candidateIndex(candidateManifest) {
  if (!candidateManifest || typeof candidateManifest !== 'object') {
    throw new TypeError('candidateManifest is required')
  }
  if (candidateManifest.schemaVersion !== undefined && candidateManifest.schemaVersion !== 1) {
    throw new Error('unsupported candidate manifest schema')
  }
  if (candidateManifest.kind !== undefined && candidateManifest.kind !== 'w165-import-batch-v1') {
    throw new Error('unsupported candidate manifest kind')
  }
  if (candidateManifest.manifestSha256 !== undefined) {
    requiredHash(candidateManifest.manifestSha256, 'candidateManifest.manifestSha256')
  }
  const resolutions = uniqueRows(candidateManifest.candidateResolutions, 'candidateId', 'candidateResolutions')
  for (const [candidateId, resolution] of resolutions) {
    if (!FINAL_STATES.has(resolution.state)) throw new Error(`candidate ${candidateId} has invalid final state ${resolution.state}`)
    if (resolution.runtimeContractFingerprint !== undefined) requiredHash(resolution.runtimeContractFingerprint, `candidate ${candidateId}.runtimeContractFingerprint`)
    if (resolution.rawContentContractSha256 !== undefined) requiredHash(resolution.rawContentContractSha256, `candidate ${candidateId}.rawContentContractSha256`)
  }
  const archives = Array.isArray(candidateManifest.archives)
    ? uniqueRows(candidateManifest.archives, 'candidateId', 'archives')
    : new Map()
  const thumbnails = Array.isArray(candidateManifest.thumbnails)
    ? uniqueRows(candidateManifest.thumbnails, 'candidateId', 'thumbnails')
    : new Map()
  const cores = Array.isArray(candidateManifest.cores)
    ? uniqueRows(candidateManifest.cores, 'id', 'cores')
    : new Map()
  const allIds = new Set(resolutions.keys())
  if (archives.size && (archives.size !== allIds.size || [...archives.keys()].some((id) => !allIds.has(id)))) {
    throw new Error('candidate archive coverage does not match candidate resolutions')
  }
  if (thumbnails.size && (thumbnails.size !== allIds.size || [...thumbnails.keys()].some((id) => !allIds.has(id)))) {
    throw new Error('candidate thumbnail coverage does not match candidate resolutions')
  }
  return { resolutions, archives, thumbnails, cores }
}

function coreFingerprint(core) {
  if (!core || typeof core !== 'object') throw new Error('candidate archive references a missing core contract')
  return computeCoreArtifactFingerprint({
    coreName: core.coreName,
    displayVersion: core.runtimeVersion || core.displayVersion,
    sourceCommit: core.source?.commit || core.sourceCommit,
    jsSha256: core.artifacts?.js?.sha256,
    wasmSha256: core.artifacts?.wasm?.sha256,
    datSha256: core.contract?.sha256 ?? core.datSha256 ?? null,
    biosManifestSha256: core.biosManifestSha256 ?? null,
  })
}

function buildExpectation(candidateId, resolutions, archives, cores, cache = new Map(), visiting = new Set()) {
  if (cache.has(candidateId)) return cache.get(candidateId)
  if (visiting.has(candidateId)) throw new Error(`candidate build identity has a parent cycle at ${candidateId}`)
  const archive = archives.get(candidateId)
  if (!archive) return null
  if (['blocked', 'unsupported'].includes(resolutions.get(candidateId)?.state)) return null
  const core = cores.get(String(archive.coreArtifactId))
  if (!core) return null
  visiting.add(candidateId)
  const parentCandidateId = archive.mounts?.find((mount) => mount.role === 'parent')?.candidateId ?? null
  const parent = parentCandidateId
    ? buildExpectation(String(parentCandidateId), resolutions, archives, cores, cache, visiting)
    : null
  if (archive.archiveLayout === 'split' && !parent) return null
  const contentManifestSha256 = sha256(canonicalizeLibraryJson({
    schemaVersion: 1,
    kind: 'w165-archive-content-v1',
    members: archive.members,
  }))
  const coreArtifactFingerprint = coreFingerprint(core)
  const runtimeParentBuildFingerprint = parent?.buildFingerprint ?? null
  const buildFingerprint = computeBuildFingerprint({
    logicalRomScope: `w165:${String(candidateId).toLowerCase()}`,
    setNameNormalized: String(archive.setName).toLowerCase(),
    coreArtifactFingerprint,
    archiveSha256: archive.archiveSha256,
    contentManifestSha256,
    archiveLayout: archive.archiveLayout,
    runtimeParentBuildFingerprint,
    biosManifestSha256: core.biosManifestSha256 ?? null,
  })
  const expectation = {
    buildFingerprint,
    coreArtifactFingerprint,
    contentManifestSha256,
    runtimeParentBuildFingerprint,
    biosManifestSha256: core.biosManifestSha256 ?? null,
    archiveSha256: archive.archiveSha256,
    archiveLayout: archive.archiveLayout,
    coreArtifactId: archive.coreArtifactId,
    parentCandidateId,
    parentArchiveSha256: parent?.archiveSha256 ?? null,
  }
  visiting.delete(candidateId)
  cache.set(candidateId, expectation)
  return expectation
}

function compareDeclaredIdentity(run, expected, runId) {
  if (!expected) return
  for (const field of [
    'buildFingerprint', 'coreArtifactFingerprint', 'contentManifestSha256',
    'runtimeParentBuildFingerprint', 'biosManifestSha256', 'archiveSha256',
    'archiveLayout', 'coreArtifactId', 'parentArchiveSha256', 'parentCandidateId',
  ]) {
    const expectedValue = expected[field] ?? null
    const actualValue = run[field] ?? null
    if (expectedValue === null) {
      if (actualValue !== null) throw new Error(`validation run ${runId} has unexpected ${field}`)
    } else if (String(actualValue).toLowerCase() !== String(expectedValue).toLowerCase()) {
      throw new Error(`validation run ${runId} ${field} does not match the candidate contract`)
    }
  }
}

function validateRun(run, index, candidates, { archives = new Map(), cores = new Map(), expectations = new Map() } = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new TypeError(`validationRuns[${index}] must be an object`)
  }
  const candidateId = requiredString(run.candidateId, `validationRuns[${index}].candidateId`)
  if (!candidates.has(candidateId)) throw new Error(`validation run references unknown candidate ${candidateId}`)
  const runId = requiredString(run.runId, `validationRuns[${index}].runId`)
  requiredString(run.logicalRomKey, `validationRuns[${index}].logicalRomKey`)
  requiredHash(run.buildFingerprint, `validationRuns[${index}].buildFingerprint`)
  requiredHash(run.coreArtifactFingerprint, `validationRuns[${index}].coreArtifactFingerprint`)
  requiredHash(run.browserSha256, `validationRuns[${index}].browserSha256`)
  requiredString(run.harnessVersion, `validationRuns[${index}].harnessVersion`)
  if (String(run.browserSha256).toLowerCase() !== PINNED_BROWSER_SHA256) {
    throw new Error(`validation run ${runId} does not use the pinned Headless Shell`)
  }
  if (run.harnessVersion !== PINNED_HARNESS_VERSION) {
    throw new Error(`validation run ${runId} does not use the pinned smoke harness`)
  }
  if (!RUN_RESULTS.has(run.result)) throw new Error(`validation run ${runId} has invalid result`)
  if (!ACCEPTANCE.has(run.acceptance)) throw new Error(`validation run ${runId} has invalid acceptance`)
  if (run.acceptance === 'accepted' && run.result !== 'passed') {
    throw new Error(`validation run ${runId} can only accept a passed result`)
  }
  if (run.result === 'inconclusive' && run.acceptance === 'accepted') {
    throw new Error(`validation run ${runId} cannot accept an inconclusive result`)
  }
  if (run.result !== 'passed' && (!run.failureCode || typeof run.failureCode !== 'string')) {
    throw new Error(`validation run ${runId} requires failureCode`)
  }
  const resolution = candidates.get(candidateId)
  const archive = archives.get(candidateId)
  const expected = expectations.get(candidateId)
  if (resolution?.runtimeContractFingerprint && String(run.runtimeContractFingerprint || '').toLowerCase() !== String(resolution.runtimeContractFingerprint).toLowerCase()) {
    throw new Error(`validation run ${runId} runtime contract does not match candidate ${candidateId}`)
  }
  if (resolution?.rawContentContractSha256 && String(run.rawContentContractSha256 || '').toLowerCase() !== String(resolution.rawContentContractSha256).toLowerCase()) {
    throw new Error(`validation run ${runId} raw content contract does not match candidate ${candidateId}`)
  }
  if (archive?.mounts) {
    const expectedParent = archive.mounts.find((mount) => mount.role === 'parent')?.candidateId ?? null
    if ((run.parentCandidateId ?? null) !== expectedParent) {
      throw new Error(`validation run ${runId} parent candidate does not match candidate ${candidateId}`)
    }
  }
  compareDeclaredIdentity(run, expected, runId)
  return run
}

function logicalKeyFor(candidateId, resolution, archive) {
  const value = resolution.logicalRomKey || archive?.logicalRomKey
  return value === undefined || value === null ? null : requiredString(value, `candidate ${candidateId} logicalRomKey`)
}

function compareRuns(left, right) {
  // Run IDs are the stable tie-breaker. Timestamps are advisory and never
  // allowed to make a publish manifest non-deterministic.
  return String(left.runId).localeCompare(String(right.runId), 'en')
}

function deriveCandidateStates(resolutions, acceptedByCandidate, acceptedBy) {
  return [...resolutions.values()]
    .sort((left, right) => String(left.candidateId).localeCompare(String(right.candidateId), 'en'))
    .map((resolution) => {
      const accepted = acceptedByCandidate.get(String(resolution.candidateId))
      const original = FINAL_STATES.has(resolution.state) ? resolution.state : 'unverified'
      const state = accepted && !['blocked', 'unsupported'].includes(original) ? 'ready' : original
      return {
        ...resolution,
        state,
        acceptedRunId: accepted?.runId ?? null,
        acceptedBy: accepted?.acceptedBy ?? acceptedBy ?? null,
      }
    })
}

/**
 * Hash a publish manifest without its self-referential manifestSha256 field.
 * The canonical serializer is shared with the database/import ledgers.
 */
export function hashPublishManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('publish manifest is required')
  const body = { ...manifest }
  delete body.manifestSha256
  return sha256(canonicalizeLibraryJson(body))
}

/**
 * Resolve append-only smoke attempts into a separate, immutable publish view.
 * No input array is mutated and failed attempts are intentionally retained only
 * through validationAttemptCount/validationRunIds; callers should keep the raw
 * run files as private evidence.
 */
export function derivePublishManifest({
  candidateManifest,
  validationRuns = [],
  acceptedBy = null,
  acceptedAt = null,
  requireContract = null,
  requireW165 = false,
  requireCompleteCoverage = false,
} = {}) {
  const { resolutions, archives, thumbnails, cores } = candidateIndex(candidateManifest)
  if (requireW165) assertW165CandidateLedger(candidateManifest)
  if (!Array.isArray(validationRuns)) throw new TypeError('validationRuns must be an array')
  const expectations = new Map()
  if (cores.size) {
    for (const candidateId of resolutions.keys()) {
      const expectation = buildExpectation(candidateId, resolutions, archives, cores)
      if (expectation) expectations.set(candidateId, expectation)
    }
  }

  const runIds = new Set()
  const runs = validationRuns.map((run, index) => {
    const validated = validateRun(run, index, resolutions, { archives, cores, expectations })
    if (runIds.has(validated.runId)) throw new Error(`validation runs contain duplicate runId ${validated.runId}`)
    runIds.add(validated.runId)
    return validated
  })
  const accepted = runs.filter((run) => run.result === 'passed' && run.acceptance === 'accepted')
  const acceptedByCandidate = new Map()
  const acceptedByLogicalKey = new Map()
  const logicalByCandidate = new Map()
  for (const [candidateId, resolution] of resolutions) {
    logicalByCandidate.set(candidateId, logicalKeyFor(candidateId, resolution, archives.get(candidateId)))
  }

  for (const run of accepted) {
    const candidateId = String(run.candidateId)
    if (['blocked', 'unsupported'].includes(resolutions.get(candidateId).state)) {
      throw new Error(`candidate ${candidateId} cannot publish from static state ${resolutions.get(candidateId).state}`)
    }
    const logicalRomKey = String(run.logicalRomKey)
    const declaredLogicalKey = logicalByCandidate.get(candidateId)
    if (declaredLogicalKey !== null && logicalRomKey !== declaredLogicalKey) {
      throw new Error(`validation run ${run.runId} logicalRomKey does not match candidate ${candidateId}`)
    }
    if (declaredLogicalKey === null) logicalByCandidate.set(candidateId, logicalRomKey)
    if (requireContract && typeof requireContract === 'object') {
      for (const [field, expected] of Object.entries(requireContract)) {
        if (expected !== undefined && run[field] !== expected) {
          throw new Error(`validation run ${run.runId} does not match required ${field}`)
        }
      }
    }
    const existingCandidate = acceptedByCandidate.get(candidateId)
    if (existingCandidate && !sameBuildIdentity(existingCandidate, run)) {
      throw new Error(`candidate ${candidateId} has accepted runs for different builds`)
    }
    const existingLogical = acceptedByLogicalKey.get(logicalRomKey)
    if (existingLogical && !sameBuildIdentity(existingLogical, run)) {
      throw new Error(`logical ROM ${logicalRomKey} has multiple non-identical accepted builds`)
    }
    const selected = !existingCandidate || compareRuns(run, existingCandidate) < 0 ? run : existingCandidate
    acceptedByCandidate.set(candidateId, selected)
    acceptedByLogicalKey.set(logicalRomKey, selected)
  }

  for (const [candidateId] of resolutions) {
    if (logicalByCandidate.get(candidateId) === null) logicalByCandidate.set(candidateId, candidateId)
  }
  if (requireCompleteCoverage) assertValidationCoverage(candidateManifest, runs, { requireW165 })
  const candidateStates = deriveCandidateStates(resolutions, acceptedByCandidate, acceptedBy)
  const selectedBuilds = [...acceptedByLogicalKey.values()]
    .sort((left, right) => String(left.logicalRomKey).localeCompare(String(right.logicalRomKey), 'en'))
    .map((run) => {
      const archive = archives.get(String(run.candidateId))
      const thumbnail = thumbnails.get(String(run.candidateId))
      return {
        logicalRomKey: run.logicalRomKey,
        candidateId: run.candidateId,
        buildFingerprint: run.buildFingerprint.toLowerCase(),
        coreArtifactFingerprint: run.coreArtifactFingerprint.toLowerCase(),
        biosManifestSha256: run.biosManifestSha256 ?? null,
        archiveSha256: run.archiveSha256 ?? archive?.archiveSha256 ?? null,
        contentManifestSha256: run.contentManifestSha256 ?? null,
        archiveLayout: run.archiveLayout ?? archive?.archiveLayout ?? null,
        runtimeParentBuildFingerprint: run.runtimeParentBuildFingerprint ?? null,
        thumbnailSha256: run.thumbnailSha256 ?? thumbnail?.sha256 ?? null,
        acceptedRunId: run.runId,
        acceptedBy: run.acceptedBy ?? acceptedBy,
        acceptedAt: run.acceptedAt ?? acceptedAt,
      }
    })

  const finalStateCounts = Object.fromEntries([...FINAL_STATES].map((state) => [state, 0]))
  for (const row of candidateStates) finalStateCounts[row.state] += 1
  const runtimeContractFingerprints = new Set()
  const rawContentContractHashes = new Set()
  for (const row of resolutions.values()) {
    if (row.runtimeContractFingerprint) runtimeContractFingerprints.add(String(row.runtimeContractFingerprint).toLowerCase())
    if (row.rawContentContractSha256) rawContentContractHashes.add(String(row.rawContentContractSha256).toLowerCase())
  }
  const coreArtifactFingerprints = new Set(runs.map((run) => run.coreArtifactFingerprint.toLowerCase()))
  const archiveLayouts = new Set()
  for (const row of selectedBuilds) if (LAYOUTS.has(row.archiveLayout)) archiveLayouts.add(row.archiveLayout)
  const thumbnailMatchKinds = new Set()
  for (const row of [...acceptedByCandidate.keys()]) {
    const matchKind = thumbnails.get(row)?.matchKind
    if (matchKind) thumbnailMatchKinds.add(String(matchKind))
  }
  const thumbnailMatchCounts = thumbnails.size ? countBy([...thumbnails.values()], 'matchKind') : {}

  const result = {
    schemaVersion: 1,
    kind: 'w165-publish-manifest-v1',
    batchId: requiredString(candidateManifest.batchId, 'candidateManifest.batchId'),
    candidateManifestSha256: candidateManifest.manifestSha256 ?? null,
    candidateResolutionCount: candidateStates.length,
    runtimeContractCount: runtimeContractFingerprints.size,
    globalRawContentIdentityCount: rawContentContractHashes.size,
    validationAttemptCount: runs.length,
    validationRunIds: runs.map((run) => run.runId).sort((left, right) => String(left).localeCompare(String(right), 'en')),
    finalStateCounts,
    coverage: {
      coreArtifactFingerprints: [...coreArtifactFingerprints].sort(),
      archiveLayouts: [...archiveLayouts].sort(),
      thumbnailMatchKinds: [...thumbnailMatchKinds].sort(),
      thumbnailMatchCounts,
    },
    candidateResolutions: candidateStates,
    selectedBuilds,
    acceptedBy: acceptedBy ?? null,
    acceptedAt: acceptedAt ?? null,
  }
  return { ...result, manifestSha256: hashPublishManifest(result) }
}

function sameBuildIdentity(left, right) {
  for (const field of [
    'buildFingerprint', 'coreArtifactFingerprint', 'biosManifestSha256',
    'archiveSha256', 'contentManifestSha256', 'archiveLayout',
    'runtimeParentBuildFingerprint', 'thumbnailSha256', 'runtimeContractFingerprint',
    'rawContentContractSha256', 'coreArtifactId', 'parentArchiveSha256', 'parentCandidateId',
  ]) {
    const leftValue = left[field] ?? null
    const rightValue = right[field] ?? null
    if (String(leftValue).toLowerCase() !== String(rightValue).toLowerCase()) return false
  }
  return true
}

function countBy(rows, key) {
  const counts = {}
  for (const row of rows) {
    const value = String(row?.[key] ?? '')
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function exactCounts(actual, expected, label) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
  for (const key of keys) {
    if ((actual[key] ?? 0) !== (expected[key] ?? 0)) {
      throw new Error(`${label} mismatch for ${key}: expected ${expected[key] ?? 0}, got ${actual[key] ?? 0}`)
    }
  }
}

/** Assert the immutable W165 candidate ledger rather than a smaller publish subset. */
export function assertW165CandidateLedger(candidateManifest) {
  const { resolutions, archives, thumbnails, cores: coreContracts } = candidateIndex(candidateManifest)
  if (resolutions.size !== W165_LEDGER_EXPECTATIONS.candidateRows) {
    throw new Error(`W165 candidate count must be ${W165_LEDGER_EXPECTATIONS.candidateRows}`)
  }
  if (archives.size !== resolutions.size || thumbnails.size !== resolutions.size) {
    throw new Error('W165 archive and thumbnail coverage must equal the candidate ledger')
  }
  const runtimeContracts = new Set([...resolutions.values()].map((row) => requiredHash(row.runtimeContractFingerprint, 'runtimeContractFingerprint')))
  const rawPayloads = new Set([...resolutions.values()].map((row) => requiredHash(row.rawContentContractSha256, 'rawContentContractSha256')))
  if (runtimeContracts.size !== W165_LEDGER_EXPECTATIONS.runtimeCoreScopedContracts) {
    throw new Error(`W165 runtime contract count must be ${W165_LEDGER_EXPECTATIONS.runtimeCoreScopedContracts}`)
  }
  if (rawPayloads.size !== W165_LEDGER_EXPECTATIONS.globalRawPayloadIdentities) {
    throw new Error(`W165 raw payload identity count must be ${W165_LEDGER_EXPECTATIONS.globalRawPayloadIdentities}`)
  }
  exactCounts(countBy([...archives.values()], 'archiveLayout'), W165_LEDGER_EXPECTATIONS.archiveLayouts, 'W165 archive layout')
  exactCounts(countBy([...thumbnails.values()], 'matchKind'), W165_LEDGER_EXPECTATIONS.thumbnailMatchKinds, 'W165 thumbnail match kind')
  const coreIds = new Set([...archives.values()].map((row) => requiredString(row.coreArtifactId, 'archive.coreArtifactId')))
  if (coreIds.size !== W165_LEDGER_EXPECTATIONS.coreCount || coreContracts.size !== W165_LEDGER_EXPECTATIONS.coreCount) {
    throw new Error(`W165 must cover ${W165_LEDGER_EXPECTATIONS.coreCount} cores`)
  }
  if ([...coreIds].some((id) => !coreContracts.has(id))) throw new Error('W165 archive core coverage does not match core contracts')
  return Object.freeze({
    candidateRows: resolutions.size,
    runtimeCoreScopedContracts: runtimeContracts.size,
    globalRawPayloadIdentities: rawPayloads.size,
    archiveLayouts: countBy([...archives.values()], 'archiveLayout'),
    thumbnailMatchKinds: countBy([...thumbnails.values()], 'matchKind'),
    coreArtifactIds: [...coreIds].sort(),
  })
}

/** Ensure every buildable candidate was attempted without deleting retry evidence. */
export function assertValidationCoverage(candidateManifest, validationRuns, { requireW165 = false } = {}) {
  const { resolutions, archives, cores } = candidateIndex(candidateManifest)
  if (requireW165) assertW165CandidateLedger(candidateManifest)
  if (!Array.isArray(validationRuns)) throw new TypeError('validationRuns must be an array')
  const expectations = new Map()
  if (cores.size) {
    for (const candidateId of resolutions.keys()) {
      const expectation = buildExpectation(candidateId, resolutions, archives, cores)
      if (expectation) expectations.set(candidateId, expectation)
    }
  }
  const attempted = new Set()
  for (const [index, run] of validationRuns.entries()) {
    const validated = validateRun(run, index, resolutions, { archives, cores, expectations })
    attempted.add(String(validated.candidateId))
  }
  const requiredCandidates = [...resolutions.values()]
    .filter((resolution) => !['blocked', 'unsupported'].includes(resolution.state))
    .map((resolution) => String(resolution.candidateId))
  const missing = requiredCandidates.filter((candidateId) => !attempted.has(candidateId))
  if (missing.length) throw new Error(`validation coverage is missing ${missing.length} buildable candidates`)
  const modes = new Set(requiredCandidates.map((candidateId) => archives.get(candidateId)?.archiveLayout).filter(Boolean))
  const coreIds = new Set(requiredCandidates.map((candidateId) => archives.get(candidateId)?.coreArtifactId).filter(Boolean))
  return Object.freeze({
    attemptedCandidateCount: attempted.size,
    requiredCandidateCount: requiredCandidates.length,
    archiveLayouts: [...modes].sort(),
    coreArtifactIds: [...coreIds].sort(),
  })
}

/** Deployment gate for the preserved legacy IDs 1-7. */
export function assertLegacyPublishGate(rows, { expectedRomIds = [1, 2, 3, 4, 5, 6, 7] } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('legacy publish rows must be an array')
  const byId = new Map()
  for (const row of rows) {
    if (!Number.isInteger(row?.romId) || row.romId <= 0) throw new TypeError('legacy publish row romId must be positive')
    if (byId.has(row.romId)) throw new Error(`legacy publish rows repeat ROM ${row.romId}`)
    byId.set(row.romId, row)
  }
  const missing = expectedRomIds.filter((id) => !byId.has(id))
  if (missing.length) throw new Error(`legacy publish gate is missing ROM IDs: ${missing.join(',')}`)
  for (const id of expectedRomIds) {
    const row = byId.get(id)
    const hasRawAcceptance = row.acceptance !== undefined || row.result !== undefined
    const acceptedPassed = hasRawAcceptance
      ? row.acceptance === 'accepted' && row.result === 'passed' && (row.acceptedResult === undefined || row.acceptedResult === 'passed')
      : row.acceptedResult === 'passed'
    if (row.public !== true || row.startable !== true || !acceptedPassed) {
      throw new Error(`legacy ROM ${id} is not accepted, public, and startable`)
    }
  }
  return true
}

export function loadPublishInputs({ candidateManifestPath, validationRunsPath } = {}) {
  if (typeof candidateManifestPath !== 'string' || isAbsolute(candidateManifestPath) === false) {
    throw new TypeError('candidateManifestPath must be an absolute path')
  }
  if (typeof validationRunsPath !== 'string' || isAbsolute(validationRunsPath) === false) {
    throw new TypeError('validationRunsPath must be an absolute path')
  }
  return {
    candidateManifest: JSON.parse(readFileSync(resolve(candidateManifestPath), 'utf8')),
    validationRuns: JSON.parse(readFileSync(resolve(validationRunsPath), 'utf8')),
  }
}

export function assertPublishOutputOutsideRepository(value) {
  const candidate = resolve(value)
  const realPathWithMissing = (input) => {
    let cursor = resolve(input)
    const missing = []
    while (!existsSync(cursor)) {
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error('publish output has no resolvable ancestor')
      missing.unshift(cursor.slice(parent.length + 1))
      cursor = parent
    }
    return resolve(realpathSync(cursor), ...missing)
  }
  const realCandidate = realPathWithMissing(candidate)
  const realRepository = realPathWithMissing(REPO_ROOT)
  const normalizedCandidate = process.platform === 'win32' ? realCandidate.toLowerCase() : realCandidate
  const normalizedRepository = process.platform === 'win32' ? realRepository.toLowerCase() : realRepository
  if (normalizedCandidate === normalizedRepository || normalizedCandidate.startsWith(`${normalizedRepository}${sep}`)) {
    throw new Error('publish output must be outside the Git worktree')
  }
  return candidate
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`)
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
    options[key] = next
    index += 1
  }
  for (const key of ['candidateManifest', 'validationRuns', 'output']) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const inputs = loadPublishInputs({
    candidateManifestPath: resolve(options.candidateManifest),
    validationRunsPath: resolve(options.validationRuns),
  })
  const outputPath = assertPublishOutputOutsideRepository(resolve(options.output))
  const manifest = derivePublishManifest({
    ...inputs,
    acceptedBy: options.acceptedBy ?? null,
    acceptedAt: options.acceptedAt ?? null,
    requireW165: true,
    requireCompleteCoverage: true,
  })
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`derive-publish-manifest: ${error.message}\n`)
    process.exitCode = 2
  }
}
