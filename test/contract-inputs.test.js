import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const CONTRACTS_URL = new URL('../tools/arcade-import/contracts/', import.meta.url)

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, CONTRACTS_URL), 'utf8'))
}

function countBy(values) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function byteContractHash(members) {
  const unique = new Set(members.map(([, size, crc32]) => `${size}:${crc32}`))
  const canonical = [...unique]
    .map((record) => {
      const [size, crc32] = record.split(':')
      return [Number(size), crc32]
    })
    .sort(([leftSize, leftCrc], [rightSize, rightCrc]) =>
      leftSize - rightSize || leftCrc.localeCompare(rightCrc),
    )
    .map(([size, crc32]) => `${size}:${crc32}`)
    .join(';')

  return createHash('sha256').update(canonical, 'ascii').digest('hex')
}

function runtimeContractFingerprint(row) {
  const canonical = JSON.stringify({
    runtimeContractCoreId: row.runtimeContractCoreId,
    contractSourceIds: row.contractSourceIds,
    rawContentContractSha256: row.rawContentContractSha256,
  })

  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

async function sha256File(relativePath, hashMode = 'raw') {
  let bytes = await readFile(new URL(`../${relativePath}`, import.meta.url))
  if (hashMode === 'lf-normalized-text') {
    bytes = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))
  }
  return createHash('sha256').update(bytes).digest('hex')
}

test('frozen arcade candidates preserve the exact audited ledger invariants', async () => {
  const manifest = await readJson('candidates.json')

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.rows.length, 656)
  assert.equal(new Set(manifest.rows.map((row) => row.id)).size, 656)
  assert.equal(new Set(manifest.rows.map((row) => row.rawContentContractSha256)).size, 654)
  assert.equal(new Set(manifest.rows.map((row) => row.runtimeContractFingerprint)).size, 655)
  assert.deepEqual(countBy(manifest.rows.map((row) => row.source)), {
    fbalpha2012: 282,
    fbneo: 277,
    mame2003_plus: 97,
  })
  assert.deepEqual(countBy(manifest.rows.map((row) => row.relationKind)), {
    bootleg: 64,
    clone: 361,
    hack: 4,
    parent: 227,
  })
  assert.deepEqual(countBy(manifest.rows.map((row) => row.thumbnail.matchKind)), {
    'direct-or-alias': 463,
    parent: 53,
    'source-reference': 140,
  })
  assert.equal(manifest.rows.filter((row) => row.archiveLayout === 'split').length, 98)

  for (const row of manifest.rows) {
    assert.match(row.id, /^(fbneo|mame2003_plus|fbalpha2012):[a-z0-9_]+$/)
    assert.match(row.coreArtifactId, /^(fbneo|mame2003_plus|fbalpha2012)/)
    assert.match(row.runtimeContractCoreId, /^(fbneo|mame2003_plus|fbalpha2012)/)
    assert.ok(row.contractSourceIds.length > 0, `${row.id} must retain contract provenance`)
    assert.match(row.rawContentContractSha256, /^[0-9a-f]{64}$/)
    assert.match(row.runtimeContractFingerprint, /^[0-9a-f]{64}$/)
    assert.ok(row.members.length > 0, `${row.id} must retain its byte members`)
    assert.equal(byteContractHash(row.members), row.rawContentContractSha256, row.id)
    assert.equal(runtimeContractFingerprint(row), row.runtimeContractFingerprint, row.id)
    assert.ok(row.thumbnail.sourceSetName, `${row.id} must retain thumbnail evidence`)

    if (row.archiveLayout === 'split') {
      assert.ok(row.runtimeParentSetName, `${row.id} must retain its runtime parent`)
    } else {
      assert.equal(row.runtimeParentSetName, null, row.id)
    }
  }
})

test('five hash-pinned core contracts retain exact artifact and source provenance', async () => {
  const manifest = await readJson('cores.json')
  const candidates = await readJson('candidates.json')

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.signed, false)
  assert.equal(manifest.cores.length, 5)
  assert.ok(manifest.cores.every((core) => core.contractEnabled === true))
  assert.deepEqual(countBy(candidates.rows.map((row) => row.coreArtifactId)), {
    fbalpha2012_cps1_028: 36,
    fbalpha2012_cps2_028: 238,
    fbalpha2012_full_029: 8,
    'fbneo_1.0.0.03_2f41022': 277,
    mame2003_plus_62c7089: 97,
  })

  const expected = {
    fbalpha2012_cps1_028: {
      js: '1b6fcfecae9a029dc0ad6706af4e1163da6cfded3d92ec2e193fc711603ff590',
      wasm: '021a05264877a9a1ea8c7722314513c2a1f23ab9491a2369b183b9788c524678',
      contract: '1c4308e91a967f9306e744dc906abafaf5101b4082eb9fb80ffdd20a21ce95aa',
      commit: '2499e30247da4d2535c2df886186e165cbff48e7',
    },
    fbalpha2012_cps2_028: {
      js: '28f5e5e47bb609aaba7ea1cd99270d8b8854c4e3dfd9a4213a083964e05e2627',
      wasm: '67a5ff138215511cf9ab3af872d6499cf4b5a8bb1bae530cbceebd33c050f4e1',
      contract: '4d0d953871e18275862258562eaa6f55d9b633967669673787c13407a41b2636',
      commit: 'd618e992f33bc79d040f01e3b1589a05566725d9',
    },
    fbalpha2012_full_029: {
      js: 'eba6a6074eb6c86d3ac640a3ee716461da188fb35e32de5c3b76ee18d032b80a',
      wasm: 'a19485f4060a3473c0229bd2bd4b68d5e13c1ecae65bb91728f7eaec3337afdb',
      contract: 'fb8d82fb3a222b1c5836af0a8cda09f9192dfa7cebe8448b4c5dc087e3e8ff93',
      commit: '77167cea72e808384c136c8c163a6b4975ce7a84',
    },
    'fbneo_1.0.0.03_2f41022': {
      js: 'cd8e329caa68e7125b1f70ff91129f97b2935745f5fbaa31ba4e3ab1bccd4697',
      wasm: '7ad627b58de8832dbceb9c9b92c18e5ee198b87eb3ada95f4ac1aaa80755ef23',
      contract: 'e7b55931f73f458737d85aff0be1c516083ac8e0ee7ecd76068c864a8acba1c5',
      commit: '2f41022002337ed20186144bbddb2d53392fab85',
    },
    mame2003_plus_62c7089: {
      js: '6d7dc65e13c88837d6aa9757720b11446f09fa6d9b503b5a6e8ee6b8e873941e',
      wasm: '47a47e9555426a04c023303434b432b8c6a70d8ab6a420fe7446e6d6e8c2546c',
      contract: 'e935b1343b39a85fd9e67914f7edfab28f55f4502751d33288397aabd33d6de9',
      commit: '62c7089644966f6ac5fc79fe03592603579a409d',
    },
  }

  for (const core of manifest.cores) {
    const pinned = expected[core.id]
    assert.ok(pinned, `unexpected core ${core.id}`)
    assert.equal(core.artifacts.js.sha256, pinned.js)
    assert.equal(core.artifacts.wasm.sha256, pinned.wasm)
    assert.equal(core.contract.sha256, pinned.contract)
    assert.equal(core.source.commit, pinned.commit)
    assert.match(core.source.provenance, /audit|embedded|commit|binary/i)
    assert.equal(
      await sha256File(core.artifacts.js.path, core.artifacts.js.hashMode),
      pinned.js,
      core.id,
    )
    assert.equal(await sha256File(core.artifacts.wasm.path), pinned.wasm, core.id)
  }
})

test('selected-row provenance stays separate from runtime family fingerprint scope', async () => {
  const candidates = await readJson('candidates.json')
  const cores = await readJson('cores.json')
  const fullOnlySetNames = [
    '3wondersr1',
    'ddtodar1',
    'forgottnuaa',
    'sf2bhh',
    'sf2jf',
    'sf2jh',
    'sf2jl',
    'sfzar1',
  ]

  assert.deepEqual(candidates.fieldSemantics, {
    coreArtifactId: 'selected-row-core-provenance; join cores.json.contract',
    contractSourceIds:
      'runtime-contract-platform-family-scope-only; not row-presence evidence',
  })
  assert.deepEqual(candidates.fbaFullOnlyCoreAllocation, {
    sourceInputId: 'fba2012:candidates',
    supportingCoreArtifactIds: ['fbalpha2012_full_029'],
    setNames: fullOnlySetNames,
  })

  const fullOnlyRows = candidates.rows.filter(
    (row) => row.coreArtifactId === 'fbalpha2012_full_029',
  )
  assert.deepEqual(
    fullOnlyRows.map((row) => row.setName).sort(),
    fullOnlySetNames,
  )
  const dedicatedSetNames = new Set(
    candidates.rows
      .filter((row) => /^fbalpha2012_cps[12]_028$/.test(row.coreArtifactId))
      .map((row) => row.setName),
  )
  assert.ok(fullOnlySetNames.every((setName) => !dedicatedSetNames.has(setName)))

  const fullCore = cores.cores.find((core) => core.id === 'fbalpha2012_full_029')
  assert.equal(
    fullCore.contract.sha256,
    'fb8d82fb3a222b1c5836af0a8cda09f9192dfa7cebe8448b4c5dc087e3e8ff93',
  )
})

test('authoritative source hashes and the 22 FBA baseline alias folds are frozen', async () => {
  const sources = await readJson('sources.json')
  const aliases = await readJson('alias-folds.json')

  assert.equal(sources.schemaVersion, 1)
  assert.equal(sources.signed, false)
  assert.deepEqual(sources.invariants, {
    candidateRows: 656,
    runtimeCoreScopedContracts: 655,
    globalRawPayloadIdentities: 654,
    relationTotals: { parent: 227, clone: 361, hack: 4, bootleg: 64 },
    thumbnailTotals: { 'direct-or-alias': 463, parent: 53, 'source-reference': 140 },
  })

  const inputHashes = Object.fromEntries(
    sources.inputs.map((input) => [input.id, input.sha256]),
  )
  assert.deepEqual(inputHashes, {
    'fbneo:candidates': 'f96e1f1fa9d30f2c73fb4ba0f7627369bb3ecce3c95e49e22b3af4f7e666c280',
    'fbneo:layout': '6c92355f6133b472607cfbe347d24b6d08ec5e2e47895adeef53d401cde8ebda',
    'fbneo:rebuild': 'afdb55bcd819e20221e40aa2010c48ed73df3d7dd12b4471fb41650a0089fdeb',
    'fba2012:aliases': '70278dccc9ba86782d8c184c3c5698445364b414e6e86dce0171231d8fc043c1',
    'fba2012:candidates': '3663b8b5adbf7ab8d2ad3c13dbda67d1c5cd07d550d90b6b4fad892dc367eda3',
    'fba2012:core-inventory': '1d9a4c4b9317a7ccfb46fad80d8bc8879a60fa0d64cee967fb8478638b4e8d14',
    'fba2012:distinct-contracts': 'a38bb2c145accd7a34a6fce0947d1cb626740529410d50114f5686e5fd315073',
    'fba2012:source-lock': '5579c9cb49ca0ea1186f194f9967b876c956195b8328b7a76bc0904ea91d2a8d',
    'mame2003_plus:candidates': '574aadeaa7dd605aea9f4ce9608e7cb0b689a5ab0a8f50e4296276a830d1444a',
    'mame2003_plus:core-provenance': 'c187ed6ec8bc51b695c686195b86cba525196012bc2c6ae97d7d011068b1efba',
    'mame2003_plus:rebuild': 'a4738f1740b867e0840054c38a71d2daae125457dc763520f47e0dd67ee60fd3',
    'thumbnails:coverage': '45dc4c12d9c44d516e4227105087093f3f2c482c34ee8a43480b2a9e7ac2426b',
    'thumbnails:legacy-aliases': '3413479e1bd01f04c2afdd9f14f049cd2b460461272b480de78e050cb599f6b2',
  })

  assert.equal(aliases.schemaVersion, 1)
  assert.equal(aliases.rows.length, 22)
  assert.equal(new Set(aliases.rows.map((row) => row.fbaDriverName)).size, 22)
  for (const row of aliases.rows) {
    assert.match(row.rawContentContractSha256, /^[0-9a-f]{64}$/)
    assert.match(row.baselineSource, /^(FBNeo|MAME2003Plus_incremental)$/)
    assert.ok(row.baselineDriverName)
  }
})

test('staged-file guard allows audited metadata and cores but rejects runtime artifacts', async () => {
  const { findForbiddenArcadePaths } = await import(
    '../scripts/check-arcade-staged-files.mjs'
  )

  assert.deepEqual(
    findForbiddenArcadePaths([
      'tools/arcade-import/contracts/candidates.json',
      'tools/arcade-import/contracts/SHA256SUMS.txt',
      'data/cores/fbalpha2012.js',
      'data/cores/fbalpha2012.wasm',
      'data/cores/fbalpha2012_cps1.js',
      'data/cores/fbalpha2012_cps1.wasm',
      'data/cores/fbalpha2012_cps2.js',
      'data/cores/fbalpha2012_cps2.wasm',
      'test/contract-inputs.test.js',
    ]),
    [],
  )

  const forbidden = findForbiddenArcadePaths([
    '.qa-input/source/W165_709.7z',
    '.superpowers/evidence/result.json',
    'data/cores/unreviewed.wasm',
    'data/roms/kof97.zip',
    'data/saves/kof97.state',
    'screenshots/kof97.png',
    'tools/arcade-import/batch-output/manifest.json',
    'tools/arcade-import/generated/kof97.webp',
    'tools/arcade-import/quarantine/kof97.zip',
    'tools/arcade-smoke/profiles/case-1/Preferences',
    'W165_709.7z',
    'sample.fs',
    'sample.nv',
    'audit-helper.bat',
  ])

  assert.equal(forbidden.length, 14)
  assert.deepEqual(
    forbidden.map(({ path }) => path),
    [
      '.qa-input/source/W165_709.7z',
      '.superpowers/evidence/result.json',
      'data/cores/unreviewed.wasm',
      'data/roms/kof97.zip',
      'data/saves/kof97.state',
      'screenshots/kof97.png',
      'tools/arcade-import/batch-output/manifest.json',
      'tools/arcade-import/generated/kof97.webp',
      'tools/arcade-import/quarantine/kof97.zip',
      'tools/arcade-smoke/profiles/case-1/Preferences',
      'W165_709.7z',
      'sample.fs',
      'sample.nv',
      'audit-helper.bat',
    ],
  )
  assert.ok(forbidden.every(({ reason }) => reason.length > 0))
})

test('gitignore keeps every arcade working and evidence path outside the index', async () => {
  const ignores = new Set(
    (await readFile(new URL('../.gitignore', import.meta.url), 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )

  for (const required of [
    '.qa-input/',
    '.superpowers/',
    'data/roms/',
    'tools/arcade-import/work/',
    'tools/arcade-import/batch-output/',
    'tools/arcade-import/evidence/',
    'tools/arcade-import/generated/',
    'tools/arcade-import/normalized/',
    'tools/arcade-import/quarantine/',
    'tools/arcade-smoke/profiles/',
    'tools/arcade-smoke/results/',
    'tools/arcade-smoke/evidence/',
    'tools/arcade-smoke/screenshots/',
    'tools/arcade-smoke/downloads/',
  ]) {
    assert.ok(ignores.has(required), `missing ignore: ${required}`)
  }
})

test('package scripts and suite discovery cannot silently skip component or browser tests', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const { discoverTestFiles } = await import('../scripts/run-test-suite.mjs')

  assert.deepEqual(
    {
      test: packageJson.scripts.test,
      node: packageJson.scripts['test:node'],
      component: packageJson.scripts['test:component'],
      browser: packageJson.scripts['test:browser'],
    },
    {
      test: 'node scripts/run-test-suite.mjs',
      node: 'node scripts/run-test-suite.mjs node',
      component: 'node scripts/run-test-suite.mjs component',
      browser: 'node scripts/run-test-suite.mjs browser',
    },
  )
  assert.equal(packageJson.devDependencies['playwright-core'], '1.58.2')
  assert.ok(packageJson.devDependencies.vitest)
  assert.ok(packageJson.devDependencies['@vue/test-utils'])
  assert.ok(packageJson.devDependencies['happy-dom'])

  const nodeFiles = await discoverTestFiles('node')
  const componentFiles = await discoverTestFiles('component')
  const browserFiles = await discoverTestFiles('browser')
  assert.ok(nodeFiles.some((file) => file.endsWith('test/contract-inputs.test.js')))
  assert.ok(
    componentFiles.some((file) =>
      file.endsWith('test/components/harness/component-canary.test.js'),
    ),
  )
  assert.ok(
    browserFiles.some((file) => file.endsWith('test/browser/harness-canary.spec.mjs')),
  )
})

test('Vitest is limited to nested component tests in a DOM environment', async () => {
  const config = (await import('../vitest.config.js')).default
  assert.deepEqual(config.test.include, ['test/components/**/*.test.js'])
  assert.equal(config.test.environment, 'happy-dom')
})

test('SHA256SUMS is the hash-pinned trust anchor and no signature is claimed', async () => {
  const readme = await readFile(new URL('README.md', CONTRACTS_URL), 'utf8')
  const sums = await readFile(new URL('SHA256SUMS.txt', CONTRACTS_URL), 'utf8')

  assert.match(readme, /hash-pinned/i)
  assert.match(readme, /not signed/i)
  assert.match(readme, /654 global raw payload identities/i)
  assert.match(readme, /655 runtime\/core-scoped byte contracts/i)
  assert.match(readme, /outside the worktree/i)
  assert.doesNotMatch(readme, /cryptographically signed/i)

  const entries = sums
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/)
      assert.ok(match, `invalid SHA256SUMS line: ${line}`)
      return { sha256: match[1], path: match[2] }
    })
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['alias-folds.json', 'candidates.json', 'cores.json', 'sources.json'],
  )
  for (const entry of entries) {
    assert.equal(await sha256File(`tools/arcade-import/contracts/${entry.path}`), entry.sha256)
  }
})

test('hash-pinned manifest bytes retain LF line endings across Git checkouts', async () => {
  const attributes = await readFile(new URL('../.gitattributes', import.meta.url), 'utf8')
  const lines = new Set(
    attributes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )
  assert.ok(lines.has('tools/arcade-import/contracts/*.json text eol=lf'))
  assert.ok(lines.has('tools/arcade-import/contracts/SHA256SUMS.txt text eol=lf'))
  assert.ok(lines.has('data/cores/fbalpha2012*.js -whitespace'))
})

test('design wording distinguishes runtime-scoped contracts from raw payload identity', async () => {
  const design = await readFile(
    new URL('../docs/superpowers/specs/2026-08-14-arcade-library-expansion-design.md', import.meta.url),
    'utf8',
  )
  assert.match(design, /655 runtime\/core-scoped byte contracts/i)
  assert.match(design, /654 global raw payload identities/i)
})

test('implementation plan uses the same scoped contract terminology', async () => {
  const plan = await readFile(
    new URL(
      '../docs/superpowers/plans/2026-08-15-arcade-library-expansion-implementation.md',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(plan, /655 runtime\/core-scoped contracts/i)
  assert.match(plan, /654 global raw payload identities/i)
  assert.doesNotMatch(plan, /655 distinct byte contracts/i)
  assert.doesNotMatch(plan, /655 byte contracts/i)
})
