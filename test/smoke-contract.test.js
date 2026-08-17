import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CANARY_BYTE_LENGTH,
  HEADLESS_SHELL_SHA256,
  SMOKE_CONTRACT,
  appendEvidenceRecord,
  buildCaseProfilePath,
  buildRuntimeCase,
  classifyContentStatus,
  createCanaryHtml,
  createRoutePolicy,
  inspectPng,
  normalizeRetryPolicy,
  resolveHeadlessShell,
  shouldRetrySmokeResult,
  validateSmokeResult,
} from '../tools/arcade-smoke/run-smoke.mjs'
import {
  assertLegacyPublishGate,
  derivePublishManifest,
  hashPublishManifest,
} from '../tools/arcade-smoke/derive-publish-manifest.mjs'
import {
  buildCapturePlan,
  buildCaptureCommand,
  buildRemoteBackupCommand,
  captureProductionLegacy,
  validateCaptureRequest,
} from '../tools/arcade-smoke/capture-production-legacy.mjs'

const HEADLESS_SHELL = 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1208\\chrome-headless-shell-win64\\chrome-headless-shell.exe'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function acceptedRun(overrides = {}) {
  return {
    runId: 'run-1',
    candidateId: 'candidate:one',
    logicalRomKey: 'w165:candidate:one',
    buildFingerprint: 'a'.repeat(64),
    coreArtifactFingerprint: 'b'.repeat(64),
    runtimeContractFingerprint: 'd'.repeat(64),
    rawContentContractSha256: 'e'.repeat(64),
    biosManifestSha256: null,
    browserSha256: HEADLESS_SHELL_SHA256,
    harnessVersion: SMOKE_CONTRACT.harnessVersion,
    result: 'passed',
    acceptance: 'accepted',
    failureCode: null,
    evidence: { logPath: 'evidence/run-1.json', framePath: 'screenshots/run-1.png' },
    ...overrides,
  }
}

test('smoke contract pins the bundled shell and fail-closed browser policy', () => {
  assert.equal(SMOKE_CONTRACT.browserRevision, 1208)
  assert.equal(SMOKE_CONTRACT.browserSha256, HEADLESS_SHELL_SHA256)
  assert.equal(HEADLESS_SHELL_SHA256, 'ac9bc025ed6be1ba6cf403116a68d2467c3e8da03844e642498e77cc2c799ac2'.toLowerCase())
  assert.equal(SMOKE_CONTRACT.origin, 'https://arcade-smoke.invalid')
  assert.equal(SMOKE_CONTRACT.serviceWorkers, 'block')
  assert.equal(SMOKE_CONTRACT.acceptDownloads, false)
  assert.equal(SMOKE_CONTRACT.networkPolicy, 'catch-all-abort')
  assert.equal(SMOKE_CONTRACT.contentDisposition, 'absent')
})

test('headless shell resolution verifies the exact executable and SHA-256', () => {
  if (!existsSync(HEADLESS_SHELL)) return
  const resolved = resolveHeadlessShell({ executablePath: HEADLESS_SHELL })
  assert.equal(resolved.path, HEADLESS_SHELL)
  assert.equal(resolved.sha256, HEADLESS_SHELL_SHA256)
  assert.throws(
    () => resolveHeadlessShell({ executablePath: HEADLESS_SHELL, expectedSha256: '0'.repeat(64) }),
    /SHA-256/i,
  )
})

test('case profiles are isolated and reject traversal', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arcade-smoke-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = buildCaseProfilePath(root, 'fbneo:kof97')
  const second = buildCaseProfilePath(root, 'fbneo:mslug')
  assert.notEqual(first, second)
  assert.ok(first.startsWith(root))
  assert.ok(second.startsWith(root))
  assert.throws(() => buildCaseProfilePath(root, '../escape'), /case|path|traversal/i)
})

test('the no-ROM canary is exactly 1 KiB and contains no remote dependency', () => {
  const html = createCanaryHtml()
  assert.equal(CANARY_BYTE_LENGTH, 1024)
  assert.equal(Buffer.byteLength(html), CANARY_BYTE_LENGTH)
  assert.doesNotMatch(html, /https?:\/\/(?!arcade-smoke\.invalid)/i)
  assert.doesNotMatch(html, /\.zip|\.rom|\.bin/i)
})

test('PNG frame inspection works for WebGL screenshots without a 2D canvas context', () => {
  const redPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
  const frame = inspectPng(redPixel)
  assert.equal(frame.width, 1)
  assert.equal(frame.height, 1)
  assert.equal(frame.nonBlank, false, 'one pixel is below the anti-noise threshold')
  assert.equal(frame.nonBlankPixels, 1)
})

test('route policy allows only virtual-origin case assets and aborts everything else', () => {
  const policy = createRoutePolicy({
    origin: SMOKE_CONTRACT.origin,
    allowedPaths: new Set(['/case/one/index.html', '/case/one/rom.zip']),
  })
  assert.equal(policy.classify(`${SMOKE_CONTRACT.origin}/case/one/rom.zip`), 'allow')
  assert.equal(policy.classify(`${SMOKE_CONTRACT.origin}/case/one/index.html`), 'allow')
  assert.equal(policy.classify(`${SMOKE_CONTRACT.origin}/case/one/sw.js`), 'abort')
  assert.equal(policy.classify('https://example.com/anything'), 'abort')
  assert.equal(policy.classify('http://127.0.0.1:9999/rom.zip'), 'abort')
  assert.equal(policy.responseHeaders['content-disposition'], undefined)
})

test('smoke result schema maps timeouts to structured failures and rejects unsafe outcomes', () => {
  const result = validateSmokeResult({
    ...acceptedRun(),
    result: 'failed',
    acceptance: 'pending',
    failureCode: 'timeout',
  })
  assert.equal(result.result, 'failed')
  assert.equal(result.failureCode, 'timeout')
  assert.throws(
    () => validateSmokeResult({ ...acceptedRun(), result: 'inconclusive', acceptance: 'accepted' }),
    /accepted/i,
  )
  assert.throws(
    () => validateSmokeResult({ ...acceptedRun(), browserSha256: '0'.repeat(64) }),
    /browser|contract|SHA/i,
  )
  assert.throws(
    () => validateSmokeResult({ ...acceptedRun(), result: 'unsupported' }),
    /result/i,
  )
  assert.throws(
    () => validateSmokeResult({ ...acceptedRun(), evidence: { logPath: '..\\outside.json' } }),
    /evidence.*relative|path/i,
  )
})

test('retry policy is bounded and retries only configured structured failures', () => {
  const policy = normalizeRetryPolicy({ maxAttempts: 3, retryFailureCodes: ['timeout', 'runtime-error'] })
  assert.equal(policy.maxAttempts, 3)
  assert.equal(shouldRetrySmokeResult({ result: 'failed', failureCode: 'timeout' }, 1, policy), true)
  assert.equal(shouldRetrySmokeResult({ result: 'failed', failureCode: 'isolation-violation' }, 1, policy), false)
  assert.equal(shouldRetrySmokeResult({ result: 'failed', failureCode: 'timeout' }, 3, policy), false)
  assert.equal(shouldRetrySmokeResult({ result: 'passed', failureCode: null }, 1, policy), false)
  assert.throws(() => normalizeRetryPolicy({ maxAttempts: 0 }), /attempt/i)
})

test('evidence writes are append-only and cannot replace an existing attempt', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arcade-smoke-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'results', 'run-1.json')
  appendEvidenceRecord(path, acceptedRun())
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).runId, 'run-1')
  assert.throws(() => appendEvidenceRecord(path, acceptedRun({ result: 'failed', failureCode: 'timeout' })), /exist|EEXIST|append/i)
})

test('runtime case maps local ROM, parent, core, and BIOS bytes only to virtual routes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arcade-smoke-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = Object.fromEntries(['core.js', 'core.wasm', 'parent.zip', 'child.zip', 'neogeo.zip'].map((name) => {
    const path = join(root, name)
    writeFileSync(path, name)
    return [name, path]
  }))
  const record = buildRuntimeCase({
    caseId: 'fbneo-kof97',
    candidateId: 'fbneo:kof97',
    logicalRomKey: 'w165:fbneo:kof97',
    buildFingerprint: 'a'.repeat(64),
    coreArtifactFingerprint: 'b'.repeat(64),
    runtime: {
      coreName: 'fbneo',
      coreJs: { filePath: files['core.js'] },
      coreWasm: { filePath: files['core.wasm'] },
      archives: [
        { fileName: 'kof97.zip', role: 'parent', filePath: files['parent.zip'] },
        { fileName: 'kof97h.zip', role: 'primary', filePath: files['child.zip'] },
      ],
      bios: [{ fileName: 'neogeo.zip', filePath: files['neogeo.zip'] }],
    },
  })
  assert.equal(record.requireCanvas, true)
  assert.equal(record.requireContent, true)
  assert.equal(record.assets.length, 6)
  assert.ok(record.assets.every((asset) => asset.path.startsWith('/case/fbneo-kof97/')))
  assert.match(record.html, /Nostalgist/)
  assert.doesNotMatch(record.html, /https?:\/\/(?!arcade-smoke\.invalid)/i)
})

test('runtime status rejects a contentless RetroArch menu while accepting active content', () => {
  assert.deepEqual(classifyContentStatus('GET_STATUS CONTENTLESS'), { state: 'contentless', ready: false })
  assert.deepEqual(classifyContentStatus('GET_STATUS PLAYING'), { state: 'playing', ready: true })
  assert.deepEqual(classifyContentStatus('GET_STATUS MENU'), { state: 'menu', ready: false })
  assert.deepEqual(classifyContentStatus(''), { state: 'unavailable', ready: false })
})

test('runtime cases require explicit build and core identities', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arcade-smoke-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['core.js', 'core.wasm', 'rom.zip']) writeFileSync(join(root, name), name)
  assert.throws(() => buildRuntimeCase({
    caseId: 'missing-identity',
    runtime: {
      coreName: 'fbneo',
      coreJs: { filePath: join(root, 'core.js') },
      coreWasm: { filePath: join(root, 'core.wasm') },
      archives: [{ fileName: 'game.zip', role: 'primary', filePath: join(root, 'rom.zip') }],
    },
  }), /buildFingerprint|coreArtifactFingerprint/i)
})

test('publish derivation is append-only and selects one accepted passed build per logical ROM', () => {
  const candidateManifest = {
    schemaVersion: 1,
    kind: 'w165-import-batch-v1',
    batchId: 'batch-1',
    manifestSha256: 'c'.repeat(64),
    candidateResolutions: [
      { candidateId: 'candidate:one', state: 'unverified', runtimeContractFingerprint: 'd'.repeat(64), rawContentContractSha256: 'e'.repeat(64) },
      { candidateId: 'candidate:two', state: 'blocked', runtimeContractFingerprint: 'f'.repeat(64), rawContentContractSha256: '0'.repeat(64) },
    ],
  }
  const runs = [
    acceptedRun({ runId: 'run-timeout', result: 'failed', acceptance: 'pending', failureCode: 'timeout' }),
    acceptedRun({ runId: 'run-1', result: 'passed', acceptance: 'accepted' }),
    acceptedRun({ runId: 'run-other', candidateId: 'candidate:two', logicalRomKey: 'w165:candidate:two', buildFingerprint: '9'.repeat(64), runtimeContractFingerprint: 'f'.repeat(64), rawContentContractSha256: '0'.repeat(64), result: 'passed', acceptance: 'pending' }),
  ]
  const result = derivePublishManifest({ candidateManifest, validationRuns: runs, acceptedBy: 'operator-1' })
  assert.equal(result.kind, 'w165-publish-manifest-v1')
  assert.equal(result.batchId, 'batch-1')
  assert.equal(result.selectedBuilds.length, 1)
  assert.equal(result.selectedBuilds[0].buildFingerprint, 'a'.repeat(64))
  assert.equal(result.candidateResolutionCount, 2)
  assert.equal(result.validationAttemptCount, 3)
  assert.equal(hashPublishManifest(result).length, 64)
  assert.equal(result.candidateManifestSha256, 'c'.repeat(64))
})

test('publish derivation rejects invalid static states and non-identical accepted retries', () => {
  const candidateManifest = {
    schemaVersion: 1,
    kind: 'w165-import-batch-v1',
    batchId: 'batch-1',
    manifestSha256: 'c'.repeat(64),
    candidateResolutions: [{ candidateId: 'candidate:one', state: 'unverified', runtimeContractFingerprint: 'd'.repeat(64), rawContentContractSha256: 'e'.repeat(64) }],
  }
  assert.throws(
    () => derivePublishManifest({ candidateManifest: { ...candidateManifest, candidateResolutions: [{ ...candidateManifest.candidateResolutions[0], state: 'wat' }] } }),
    /state/i,
  )
  assert.throws(
    () => derivePublishManifest({
      candidateManifest,
      validationRuns: [
        acceptedRun({ runId: 'run-a', logicalRomKey: 'candidate:one', buildFingerprint: 'a'.repeat(64) }),
        acceptedRun({ runId: 'run-b', logicalRomKey: 'candidate:one', buildFingerprint: 'a'.repeat(64), coreArtifactFingerprint: 'c'.repeat(64) }),
      ],
    }),
    /different|identity|fingerprint/i,
  )
})

test('publish derivation binds accepted runs to candidate runtime and core contracts', () => {
  const candidateManifest = {
    schemaVersion: 1,
    kind: 'w165-import-batch-v1',
    batchId: 'batch-contract',
    manifestSha256: 'c'.repeat(64),
    candidateResolutions: [{
      candidateId: 'candidate:one',
      state: 'unverified',
      runtimeContractFingerprint: 'd'.repeat(64),
      rawContentContractSha256: 'e'.repeat(64),
    }],
    cores: [{
      id: 'fixture-core',
      coreName: 'fixture',
      runtimeVersion: '1',
      source: { commit: 'f'.repeat(40) },
      artifacts: { js: { sha256: '1'.repeat(64) }, wasm: { sha256: '2'.repeat(64) } },
      contract: { sha256: '3'.repeat(64) },
    }],
    archives: [{
      candidateId: 'candidate:one',
      archiveSha256: '4'.repeat(64),
      archiveLayout: 'standalone',
      coreArtifactId: 'fixture-core',
      setName: 'candidate_one',
      members: [],
      mounts: [],
    }],
  }
  assert.throws(
    () => derivePublishManifest({ candidateManifest, validationRuns: [acceptedRun()] }),
    /contract|fingerprint|archive/i,
  )
  assert.throws(
    () => derivePublishManifest({
      candidateManifest: { ...candidateManifest, cores: undefined, archives: undefined },
      validationRuns: [acceptedRun({ runtimeContractFingerprint: '0'.repeat(64) })],
    }),
    /runtime contract/i,
  )
})

test('accepted smoke results must be passed', () => {
  assert.throws(
    () => validateSmokeResult({ ...acceptedRun(), result: 'failed', acceptance: 'accepted', failureCode: 'runtime-error' }),
    /passed.*accepted|accepted.*passed/i,
  )
})

test('legacy publish gate cannot hide a failed current result behind acceptedResult', () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    romId: index + 1,
    public: true,
    startable: true,
    acceptedResult: 'passed',
  }))
  assert.equal(assertLegacyPublishGate(rows), true)
  rows[0] = {
    ...rows[0],
    acceptance: 'accepted',
    result: 'failed',
  }
  assert.throws(() => assertLegacyPublishGate(rows), /legacy ROM 1/i)
})

test('capture request requires explicit remote identity and emits legacy SCP mode', () => {
  assert.throws(() => validateCaptureRequest({}), /host|remote|database/i)
  const request = validateCaptureRequest({
    host: '160.236.110.53',
    port: 59222,
    user: 'root',
    jumpHost: '43.159.2.240',
    jumpPort: 59222,
    remoteDb: '/srv/childhood-arcade/shared/data/app.db',
    remoteDataRoot: '/srv/childhood-arcade/shared/data',
    outputRoot: 'E:\\Project\\webemu\\production-capture',
  })
  const command = buildCaptureCommand(request)
  assert.deepEqual(command.slice(0, 6), ['scp.exe', '-O', '-J', 'root@43.159.2.240:59222', '-P', '59222'])
  assert.ok(command.includes('root@160.236.110.53:/srv/childhood-arcade/shared/data/app.db'))
  assert.equal(command.includes('-r'), false)
  const plan = buildCapturePlan(request)
  assert.equal(plan.commands[0].kind, 'online-backup')
  assert.equal(plan.commands[1].kind, 'database')
  assert.equal(plan.commands.some((entry) => entry.argv.includes('-r')), false)
  const backupCommand = buildRemoteBackupCommand(request)
  assert.equal(backupCommand.includes('root@160.236.110.53:/srv/childhood-arcade/shared/data/app.db'), false)
  assert.equal(backupCommand.includes('root@160.236.110.53'), true)
  assert.throws(() => validateCaptureRequest({ ...request, remoteFiles: [{ remotePath: '/etc/passwd', relativePath: 'roms/passwd' }] }), /remoteDataRoot|contained|outside/i)
})

test('capture rejects an outputRoot symlink into the Git worktree', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arcade-capture-link-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const link = join(root, 'repo-link')
  try {
    symlinkSync(process.cwd(), link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code || error.message}`)
    return
  }
  assert.throws(
    () => validateCaptureRequest({
      host: '160.236.110.53',
      port: 59222,
      user: 'root',
      jumpHost: '43.159.2.240',
      jumpPort: 59222,
      remoteDb: '/srv/childhood-arcade/shared/data/app.db',
      remoteDataRoot: '/srv/childhood-arcade/shared/data',
      outputRoot: link,
    }),
    /outside|worktree|Git/i,
  )
})

test('capture rejects remote shell globbing and validates remotePath overrides', () => {
  const request = validateCaptureRequest({
    host: '160.236.110.53',
    port: 59222,
    user: 'root',
    jumpHost: '43.159.2.240',
    jumpPort: 59222,
    remoteDb: '/srv/childhood-arcade/shared/data/app.db',
    remoteDataRoot: '/srv/childhood-arcade/shared/data',
    outputRoot: 'E:\\Project\\webemu\\capture-evidence',
  })
  assert.throws(
    () => validateCaptureRequest({ ...request, remoteFiles: ['/srv/childhood-arcade/shared/data/*.zip'] }),
    /unsafe|glob|remote/i,
  )
  assert.throws(
    () => buildCaptureCommand(request, { remotePath: '/srv/childhood-arcade/shared/data/*.zip' }),
    /unsafe|glob|remote/i,
  )
  assert.throws(
    () => buildCaptureCommand(request, { remotePath: '/srv/childhood-arcade/shared/data/rom file.zip' }),
    /unsafe|whitespace|remote/i,
  )
})

test('apply verifies remote file size and SHA metadata and cleans its temporary backup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arcade-capture-apply-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const payload = Buffer.from('trusted-rom-payload')
  const request = validateCaptureRequest({
    host: '160.236.110.53',
    port: 59222,
    user: 'root',
    jumpHost: '43.159.2.240',
    jumpPort: 59222,
    remoteDb: '/srv/childhood-arcade/shared/data/app.db',
    remoteDataRoot: '/srv/childhood-arcade/shared/data',
    outputRoot: root,
    remoteFiles: [{
      remotePath: '/srv/childhood-arcade/shared/data/roms/trusted.zip',
      relativePath: 'roms/trusted.zip',
      size: payload.length,
      sha256: sha256(payload),
    }],
  })
  const calls = []
  const result = captureProductionLegacy(request, {
    apply: true,
    runner: (file, args) => {
      calls.push([file, args])
      if (file !== 'scp.exe') return
      const destination = args.at(-1)
      writeFileSync(destination, payload)
    },
  })
  assert.equal(result.applied, true)
  assert.deepEqual(result.verified.map((entry) => entry.relativePath), ['roms/trusted.zip'])
  assert.equal(calls.at(-1)[0], 'ssh.exe', 'the final remote command removes the temporary backup')
  assert.match(calls.at(-1)[1].join(' '), /rm\s+--\s+\/tmp\/arcade-capture-/)
})

test('apply rejects a remote file without a complete expected fingerprint', () => {
  const request = validateCaptureRequest({
    host: '160.236.110.53',
    port: 59222,
    user: 'root',
    jumpHost: '43.159.2.240',
    jumpPort: 59222,
    remoteDb: '/srv/childhood-arcade/shared/data/app.db',
    remoteDataRoot: '/srv/childhood-arcade/shared/data',
    outputRoot: 'E:\\Project\\webemu\\capture-evidence',
    remoteFiles: [{
      remotePath: '/srv/childhood-arcade/shared/data/roms/unfingerprinted.zip',
      relativePath: 'roms/unfingerprinted.zip',
    }],
  })
  assert.throws(
    () => captureProductionLegacy(request, { apply: true, runner: () => {} }),
    /size|SHA|fingerprint|expected/i,
  )
})
