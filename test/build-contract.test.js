import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  assertActivePointerOwnership,
  canonicalizeBuildFingerprint,
  computeBuildFingerprint,
  computeCompatibilityStatus,
  validateValidationAcceptance,
} from '../server/services/build-contract.js'

const BASE_BUILD = Object.freeze({
  setNameNormalized: ' KOF97 ',
  coreArtifactFingerprint: 'A'.repeat(64),
  archiveSha256: 'B'.repeat(64),
  contentManifestSha256: 'C'.repeat(64),
  archiveLayout: 'standalone',
  runtimeParentBuildFingerprint: null,
  biosManifestSha256: 'D'.repeat(64),
})

test('build fingerprints use one canonical normalized JSON representation', () => {
  const canonical = canonicalizeBuildFingerprint(BASE_BUILD)
  const expected = JSON.stringify({
    setNameNormalized: 'kof97',
    coreArtifactFingerprint: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    contentManifestSha256: 'c'.repeat(64),
    archiveLayout: 'standalone',
    runtimeParentBuildFingerprint: null,
    biosManifestSha256: 'd'.repeat(64),
  })

  assert.equal(canonical, expected)
  assert.equal(
    computeBuildFingerprint(BASE_BUILD),
    createHash('sha256').update(expected, 'utf8').digest('hex'),
  )
  assert.equal(
    computeBuildFingerprint({
      biosManifestSha256: 'd'.repeat(64),
      runtimeParentBuildFingerprint: null,
      archiveLayout: 'standalone',
      contentManifestSha256: 'c'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      coreArtifactFingerprint: 'a'.repeat(64),
      setNameNormalized: 'kof97',
    }),
    computeBuildFingerprint(BASE_BUILD),
  )
})

test('build fingerprint canonicalization rejects incomplete or ambiguous identities', () => {
  assert.throws(
    () => {
      const { archiveSha256: _omitted, ...incomplete } = BASE_BUILD
      return canonicalizeBuildFingerprint(incomplete)
    },
    /archiveSha256/i,
  )
  assert.throws(
    () => canonicalizeBuildFingerprint({ ...BASE_BUILD, archiveLayout: 'merged' }),
    /archiveLayout/i,
  )
  assert.throws(
    () =>
      canonicalizeBuildFingerprint({
        ...BASE_BUILD,
        archiveLayout: 'standalone',
        runtimeParentBuildFingerprint: 'e'.repeat(64),
      }),
    /standalone.*parent/i,
  )
  assert.throws(
    () =>
      canonicalizeBuildFingerprint({
        ...BASE_BUILD,
        archiveLayout: 'split',
        runtimeParentBuildFingerprint: null,
      }),
    /split.*parent/i,
  )
  assert.throws(
    () =>
      canonicalizeBuildFingerprint({
        ...BASE_BUILD,
        archiveSha256: 'not-a-sha256',
      }),
    /archiveSha256.*64-character/i,
  )
})

test('every build identity field participates in the fingerprint', () => {
  const baselineFingerprint = computeBuildFingerprint(BASE_BUILD)
  for (const changed of [
    { setNameNormalized: 'kof98' },
    { coreArtifactFingerprint: 'e'.repeat(64) },
    { archiveSha256: 'e'.repeat(64) },
    { contentManifestSha256: 'e'.repeat(64) },
    { biosManifestSha256: null },
    {
      archiveLayout: 'split',
      runtimeParentBuildFingerprint: 'e'.repeat(64),
    },
  ]) {
    assert.notEqual(
      computeBuildFingerprint({ ...BASE_BUILD, ...changed }),
      baselineFingerprint,
    )
  }

  const split = {
    ...BASE_BUILD,
    archiveLayout: 'split',
    runtimeParentBuildFingerprint: 'e'.repeat(64),
  }
  assert.notEqual(
    computeBuildFingerprint({
      ...split,
      runtimeParentBuildFingerprint: 'f'.repeat(64),
    }),
    computeBuildFingerprint(split),
  )
})

test('computed compatibility status follows the static and accepted-validation contract', () => {
  assert.equal(
    computeCompatibilityStatus({ staticStatus: 'unsupported', acceptedResult: null }),
    'unsupported',
  )
  assert.equal(
    computeCompatibilityStatus({ staticStatus: 'blocked', acceptedResult: null }),
    'blocked',
  )
  assert.equal(
    computeCompatibilityStatus({ staticStatus: 'complete', acceptedResult: null }),
    'unverified',
  )
  assert.equal(
    computeCompatibilityStatus({ staticStatus: 'complete', acceptedResult: 'passed' }),
    'ready',
  )
  assert.equal(
    computeCompatibilityStatus({ staticStatus: 'complete', acceptedResult: 'failed' }),
    'blocked',
  )
  assert.throws(
    () =>
      computeCompatibilityStatus({
        staticStatus: 'complete',
        acceptedResult: 'inconclusive',
      }),
    /inconclusive.*accepted/i,
  )
})

test('inconclusive validation cannot be accepted', () => {
  assert.doesNotThrow(() =>
    validateValidationAcceptance({ result: 'inconclusive', acceptance: 'pending' }),
  )
  assert.throws(
    () => validateValidationAcceptance({ result: 'inconclusive', acceptance: 'accepted' }),
    /inconclusive.*accepted/i,
  )
})

test('active build and thumbnail ownership are checked against the logical ROM', () => {
  assert.doesNotThrow(() =>
    assertActivePointerOwnership({
      romId: 7,
      activeBuild: { id: 11, romId: 7 },
      activeThumbnailRef: { id: 13, romId: 7 },
    }),
  )
  assert.doesNotThrow(() =>
    assertActivePointerOwnership({
      romId: 7,
      activeBuild: null,
      activeThumbnailRef: null,
    }),
  )
  assert.throws(
    () =>
      assertActivePointerOwnership({
        romId: 7,
        activeBuild: { id: 11, romId: 6 },
        activeThumbnailRef: null,
      }),
    /build.*rom 7/i,
  )
  assert.throws(
    () =>
      assertActivePointerOwnership({
        romId: 7,
        activeBuild: null,
        activeThumbnailRef: { id: 13, romId: 6 },
      }),
    /thumbnail.*rom 7/i,
  )
})
