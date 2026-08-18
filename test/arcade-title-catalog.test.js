import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  ARCADE_TITLE_CATALOG_SHA256,
  ARCADE_TITLE_CANDIDATES_SHA256,
  ARCADE_TITLE_BY_KEY,
  ARCADE_TITLE_ROWS,
} from '../src/data/arcade-title-catalog.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const CANDIDATES_PATH = resolve(PROJECT_ROOT, 'tools/arcade-import/contracts/candidates.json')
const CORES_PATH = resolve(PROJECT_ROOT, 'tools/arcade-import/contracts/cores.json')
const EXPECTED_CANDIDATES_SHA256 = '3046a5653210d3b15757db3cecc16a77b79cc2374ebf2aedfa12217e271a3042'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function candidateKey(candidate, coreByArtifactId) {
  const coreName = coreByArtifactId.get(candidate.coreArtifactId)
  assert.ok(coreName, `missing core artifact ${candidate.coreArtifactId}`)
  return `${coreName}:${candidate.setName}`
}

function catalogHash(rows) {
  return sha256(`${JSON.stringify(rows)}\n`)
}

test('covers all frozen arcade candidates with exact English source titles', () => {
  const candidates = readJson(CANDIDATES_PATH)
  const cores = readJson(CORES_PATH)
  const coreByArtifactId = new Map(cores.cores.map((core) => [core.id, core.coreName]))
  const candidateByKey = new Map(
    candidates.rows.map((candidate) => [candidateKey(candidate, coreByArtifactId), candidate]),
  )

  assert.equal(sha256(readFileSync(CANDIDATES_PATH)), EXPECTED_CANDIDATES_SHA256)
  assert.equal(ARCADE_TITLE_CANDIDATES_SHA256, EXPECTED_CANDIDATES_SHA256)
  assert.equal(ARCADE_TITLE_ROWS.length, 656)
  assert.equal(ARCADE_TITLE_BY_KEY.size, 656)
  assert.equal(new Set(ARCADE_TITLE_ROWS.map((row) => row.key)).size, 656)
  assert.deepEqual(
    [...ARCADE_TITLE_BY_KEY.keys()].sort(),
    [...candidateByKey.keys()].sort(),
  )

  for (const [key, candidate] of candidateByKey) {
    const entry = ARCADE_TITLE_BY_KEY.get(key)
    assert.ok(entry, `catalog is missing ${key}`)
    assert.equal(entry.titleEn, candidate.title, `${key} must retain the exact DAT title`)
    assert.match(entry.titleZh, /\S/u, `${key} must have a Chinese title`)
    assert.match(entry.titleZh, /\p{Script=Han}/u, `${key} must include a Chinese translation`)
    assert.equal(entry.setName, candidate.setName)
    assert.equal(entry.datParentSetName, candidate.datParentSetName)
    assert.equal(entry.relationKind, candidate.relationKind)
    assert.equal(entry.coreName, coreByArtifactId.get(candidate.coreArtifactId))
    assert.match(entry.familyRootSetName, /^[a-z0-9_]+$/u)
    assert.ok(Array.isArray(entry.aliases), `${key} aliases must be an array`)
  }

  assert.equal(ARCADE_TITLE_CATALOG_SHA256, catalogHash(ARCADE_TITLE_ROWS))
})
