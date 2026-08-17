#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  realpathSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

const TOOL_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_ROOT, '../..')

export const HEADLESS_SHELL_SHA256 = 'ac9bc025ed6be1ba6cf403116a68d2467c3e8da03844e642498e77cc2c799ac2'
export const DEFAULT_HEADLESS_SHELL = process.env.ARCADE_HEADLESS_SHELL || join(
  process.env.LOCALAPPDATA || '',
  'ms-playwright',
  'chromium_headless_shell-1208',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
)

export const SMOKE_CONTRACT = Object.freeze({
  kind: 'arcade-isolated-smoke-contract-v1',
  browserRevision: 1208,
  browserSha256: HEADLESS_SHELL_SHA256,
  harnessVersion: 'arcade-smoke-v1',
  origin: 'https://arcade-smoke.invalid',
  serviceWorkers: 'block',
  acceptDownloads: false,
  networkPolicy: 'catch-all-abort',
  contentDisposition: 'absent',
  noListenerPorts: true,
  noExternalDownloader: true,
})

export const CANARY_BYTE_LENGTH = 1024
export const DEFAULT_RETRY_FAILURE_CODES = Object.freeze(['timeout', 'runtime-error', 'content-status-unavailable'])
export const FORBIDDEN_EXTERNAL_PROCESS_NAMES = Object.freeze([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe',
  'aria2c.exe', 'wget.exe', 'curl.exe', 'idm.exe', 'baidunetdiskunite.exe',
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'aria2c', 'wget', 'curl',
])
const PROCESS_SNAPSHOT_HELPERS = new Set([
  'tasklist.exe', 'conhost.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe', 'netstat.exe',
  'node.exe', 'chrome-headless-shell.exe', 'tasklist', 'ss', 'ps', 'sh', 'node',
])

const SHA256 = /^[0-9a-f]{64}$/
const RESULT_VALUES = new Set(['passed', 'failed', 'inconclusive'])
const ACCEPTANCE_VALUES = new Set(['pending', 'accepted', 'rejected'])
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.json': 'application/json',
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalCaseIdentity(caseRecord) {
  return JSON.stringify({
    candidateId: caseRecord.candidateId || caseRecord.caseId,
    logicalRomKey: caseRecord.logicalRomKey || caseRecord.candidateId || caseRecord.caseId,
    buildFingerprint: caseRecord.buildFingerprint || null,
    coreArtifactFingerprint: caseRecord.coreArtifactFingerprint || null,
    biosManifestSha256: caseRecord.biosManifestSha256 || null,
    archiveSha256: caseRecord.archiveSha256 || null,
    parentArchiveSha256: caseRecord.parentArchiveSha256 || null,
    contentManifestSha256: caseRecord.contentManifestSha256 || null,
    archiveLayout: caseRecord.archiveLayout || null,
    runtimeParentBuildFingerprint: caseRecord.runtimeParentBuildFingerprint || null,
    runtimeContractFingerprint: caseRecord.runtimeContractFingerprint || null,
    rawContentContractSha256: caseRecord.rawContentContractSha256 || null,
    coreArtifactId: caseRecord.coreArtifactId || null,
    parentCandidateId: caseRecord.parentCandidateId || null,
    harnessVersion: SMOKE_CONTRACT.harnessVersion,
  })
}

function hashCaseIdentity(caseRecord) {
  return sha256(Buffer.from(canonicalCaseIdentity(caseRecord), 'utf8'))
}

function safeId(value, label = 'case ID') {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (value.includes('..') || value.includes('/') || value.includes('\\') || /[<>|?*]/.test(value)) {
    throw new Error(`${label} contains path traversal`)
  }
  return value.trim()
}

function requiredCaseHash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value.toLowerCase())) {
    throw new TypeError(`${label} must be an explicit SHA-256 identity`)
  }
  return value.toLowerCase()
}

function contained(root, candidate, label) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(prefix)) {
    throw new Error(`${label} escapes its root`)
  }
  return absoluteCandidate
}

function assertEvidenceRootOutsideRepository(path, label) {
  const candidate = resolve(path)
  const realPathWithMissing = (value) => {
    let cursor = resolve(value)
    const missing = []
    while (!existsSync(cursor)) {
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error(`${label} has no resolvable ancestor`)
      missing.unshift(basename(cursor))
      cursor = parent
    }
    return resolve(realpathSync(cursor), ...missing)
  }
  const realCandidate = realPathWithMissing(candidate)
  const repository = realPathWithMissing(REPO_ROOT)
  const normalizedCandidate = process.platform === 'win32' ? realCandidate.toLowerCase() : realCandidate
  const normalizedRepository = process.platform === 'win32' ? repository.toLowerCase() : repository
  if (normalizedCandidate === normalizedRepository || normalizedCandidate.startsWith(`${normalizedRepository}${sep}`)) {
    throw new Error(`${label} must be outside the Git worktree`)
  }
  return candidate
}

function assertRegularFile(path, label) {
  const stat = statSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
}

export function resolveHeadlessShell({ executablePath = DEFAULT_HEADLESS_SHELL, expectedSha256 = HEADLESS_SHELL_SHA256 } = {}) {
  if (typeof executablePath !== 'string' || executablePath.trim() === '') {
    throw new TypeError('headless shell executablePath is required')
  }
  if (!SHA256.test(String(expectedSha256).toLowerCase())) {
    throw new TypeError('headless shell expected SHA-256 is invalid')
  }
  const path = resolve(executablePath)
  assertRegularFile(path, 'headless shell executable')
  const actualSha256 = sha256(readFileSync(path))
  if (actualSha256 !== String(expectedSha256).toLowerCase()) {
    throw new Error(`headless shell SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }
  return Object.freeze({ path, sha256: actualSha256 })
}

export function buildCaseProfilePath(profileRoot, caseId, scope = null) {
  safeId(caseId)
  const root = resolve(profileRoot)
  mkdirSync(root, { recursive: true })
  if (scope !== null) safeId(String(scope), 'profile scope')
  const profileKey = scope === null ? caseId : `${caseId}\0${scope}`
  const profile = join(root, `case-${sha256(Buffer.from(profileKey, 'utf8')).slice(0, 32)}`)
  const safeProfile = contained(root, profile, 'case profile')
  const existing = lstatSync(safeProfile, { throwIfNoEntry: false })
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error('case profile path must be a regular directory')
  }
  return safeProfile
}

function normalizeAllowedPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new Error(`unsafe smoke route path: ${path}`)
  }
  return path
}

export function createRoutePolicy({ origin = SMOKE_CONTRACT.origin, allowedPaths = [] } = {}) {
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.protocol !== 'https:' || !parsedOrigin.hostname.endsWith('.invalid')) {
    throw new Error('smoke origin must be an HTTPS .invalid virtual origin')
  }
  const allowed = new Set([...allowedPaths].map(normalizeAllowedPath))
  const classify = (rawUrl) => {
    let url
    try {
      url = new URL(rawUrl)
    } catch {
      return 'abort'
    }
    return url.origin === parsedOrigin.origin && allowed.has(url.pathname) ? 'allow' : 'abort'
  }
  return Object.freeze({
    origin: parsedOrigin.origin,
    allowedPaths: Object.freeze([...allowed].sort()),
    responseHeaders: Object.freeze({
      'cache-control': 'no-store',
      // Deliberately omit Content-Disposition: ROM bytes are not downloads.
      'x-arcade-smoke-origin': 'virtual-invalid',
    }),
    classify,
  })
}

function relativeEvidencePath(root, candidate, label) {
  const value = String(candidate || '')
  if (!value || isAbsolute(value) || value.includes('..') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a safe relative evidence path`)
  }
  return contained(root, join(root, value), label)
}

export function normalizeRetryPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('retry policy must be an object')
  const maxAttempts = Number(input.maxAttempts ?? 2)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError('maxAttempts must be an integer from 1 to 10')
  }
  const retryFailureCodes = [...new Set(input.retryFailureCodes ?? DEFAULT_RETRY_FAILURE_CODES)]
  if (retryFailureCodes.some((code) => typeof code !== 'string' || code.trim() === '')) {
    throw new TypeError('retryFailureCodes must contain non-empty strings')
  }
  return Object.freeze({ maxAttempts, retryFailureCodes: Object.freeze(retryFailureCodes.map((code) => code.trim())) })
}

export function shouldRetrySmokeResult(result, attempt, policy) {
  const normalized = normalizeRetryPolicy(policy)
  return Number.isInteger(attempt)
    && attempt >= 1
    && attempt < normalized.maxAttempts
    && result?.result !== 'passed'
    && normalized.retryFailureCodes.includes(result?.failureCode)
}

export function validateSmokeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('smoke result must be an object')
  }
  for (const field of ['runId', 'candidateId', 'logicalRomKey', 'buildFingerprint', 'coreArtifactFingerprint']) {
    if (typeof result[field] !== 'string' || result[field].trim() === '') {
      throw new Error(`smoke result ${field} is required`)
    }
  }
  for (const field of ['buildFingerprint', 'coreArtifactFingerprint']) {
    if (!SHA256.test(result[field].toLowerCase())) throw new Error(`smoke result ${field} is not a SHA-256`)
  }
  if (!SHA256.test(String(result.browserSha256 || '').toLowerCase())
    || result.browserSha256.toLowerCase() !== SMOKE_CONTRACT.browserSha256) {
    throw new Error('smoke result browser SHA-256 does not match the pinned contract')
  }
  if (result.harnessVersion !== SMOKE_CONTRACT.harnessVersion) throw new Error('smoke result harness contract mismatch')
  if (!RESULT_VALUES.has(result.result)) throw new Error(`invalid smoke result: ${result.result}`)
  if (!ACCEPTANCE_VALUES.has(result.acceptance)) throw new Error(`invalid smoke acceptance: ${result.acceptance}`)
  if (result.acceptance === 'accepted' && result.result !== 'passed') {
    throw new Error('only a passed smoke result can be accepted')
  }
  if (result.result === 'inconclusive' && result.acceptance === 'accepted') {
    throw new Error('inconclusive smoke result cannot be accepted')
  }
  if (result.result !== 'passed' && (typeof result.failureCode !== 'string' || result.failureCode.trim() === '')) {
    throw new Error('failed or inconclusive smoke result requires failureCode')
  }
  if (result.evidence !== undefined) {
    if (!result.evidence || typeof result.evidence !== 'object') throw new Error('smoke evidence must be an object')
    for (const value of Object.values(result.evidence)) {
      if (value !== null && value !== undefined && (isAbsolute(String(value)) || String(value).includes('..') || String(value).includes('\\') || String(value).includes('\0'))) {
        throw new Error('smoke evidence path must be relative')
      }
    }
  }
  return { ...result, browserSha256: result.browserSha256.toLowerCase() }
}

export function listListeningPorts() {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
      return { ok: true, entries: output.split(/\r?\n/).filter((line) => /LISTENING/i.test(line)).sort(), error: null }
    }
    const output = execFileSync('sh', ['-c', "(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null)"], { encoding: 'utf8' })
    return { ok: true, entries: output.split(/\r?\n/).filter(Boolean).sort(), error: null }
  } catch (error) {
    return { ok: false, entries: [], error: `listening-port probe failed: ${error.message}` }
  }
}

export function processSnapshot() {
  try {
    if (process.platform === 'win32') {
      const lines = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/).filter(Boolean)
      const snapshot = new Set()
      for (const line of lines) {
        // /FO CSV has a stable image name and PID in its first two fields;
        // memory columns change constantly and must not create false positives.
        const fields = line.match(/^"((?:[^"]|"")*)","(\d+)"/)
        if (fields && fields[1].toLowerCase() !== 'tasklist.exe') snapshot.add(`${fields[1].replaceAll('""', '"').toLowerCase()}:${fields[2]}`)
      }
      return { ok: true, entries: snapshot, error: null }
    }
    const entries = new Set(execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map((line) => line.trim()).filter((line) => !/\b(?:ps|sh|netstat|ss)\b/.test(line)))
    return { ok: true, entries, error: null }
  } catch (error) {
    return { ok: false, entries: new Set(), error: `process probe failed: ${error.message}` }
  }
}

export function processName(snapshotEntry) {
  const value = String(snapshotEntry).trim()
  if (/^\d+\s+/.test(value)) return value.split(/\s+/)[1].toLowerCase()
  return value.split(':')[0].split(/[,\s]/)[0].toLowerCase()
}

export function findForbiddenExternalProcesses(entries) {
  const names = new Set(FORBIDDEN_EXTERNAL_PROCESS_NAMES)
  return [...entries].filter((entry) => names.has(processName(entry)))
}

function filterMeaningfulProcesses(entries) {
  return [...entries].filter((entry) => !PROCESS_SNAPSHOT_HELPERS.has(processName(entry)))
}

export function appendEvidenceRecord(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  mkdirSync(dirname(path), { recursive: true })
  const descriptor = openSync(path, 'wx')
  try {
    writeFileSync(descriptor, serialized)
  } finally {
    closeSync(descriptor)
  }
}

const appendJson = appendEvidenceRecord

function mimeType(path) {
  return MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream'
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Inspect a Playwright PNG screenshot without adding an image dependency. */
export function inspectPng(bytes) {
  const input = Buffer.from(bytes)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (input.length < 33 || !input.subarray(0, 8).equals(signature)) throw new Error('invalid PNG screenshot')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset)
    const type = input.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > input.length) throw new Error('truncated PNG chunk')
    if (type === 'IHDR') {
      width = input.readUInt32BE(dataStart)
      height = input.readUInt32BE(dataStart + 4)
      bitDepth = input[dataStart + 8]
      colorType = input[dataStart + 9]
      if (input[dataStart + 10] !== 0 || input[dataStart + 11] !== 0 || input[dataStart + 12] !== 0) throw new Error('unsupported PNG encoding')
    } else if (type === 'IDAT') idat.push(input.subarray(dataStart, dataEnd))
    else if (type === 'IEND') break
    offset = dataEnd + 4
  }
  if (!width || !height || bitDepth !== 8 || !idat.length) throw new Error('unsupported PNG screenshot format')
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType]
  if (!channels) throw new Error('unsupported PNG color type')
  const stride = width * channels
  const decoded = inflateSync(Buffer.concat(idat))
  if (decoded.length < (stride + 1) * height) throw new Error('truncated PNG pixel data')
  const pixels = Buffer.alloc(stride * height)
  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = decoded[sourceOffset++]
    const rowStart = y * stride
    const priorStart = (y - 1) * stride
    for (let x = 0; x < stride; x += 1) {
      const raw = decoded[sourceOffset++]
      const left = x >= channels ? pixels[rowStart + x - channels] : 0
      const up = y > 0 ? pixels[priorStart + x] : 0
      const upperLeft = y > 0 && x >= channels ? pixels[priorStart + x - channels] : 0
      let value
      if (filter === 0) value = raw
      else if (filter === 1) value = raw + left
      else if (filter === 2) value = raw + up
      else if (filter === 3) value = raw + Math.floor((left + up) / 2)
      else if (filter === 4) value = raw + paeth(left, up, upperLeft)
      else throw new Error(`unsupported PNG filter ${filter}`)
      pixels[rowStart + x] = value & 0xff
    }
  }
  let nonBlankPixels = 0
  for (let index = 0; index < pixels.length; index += channels) {
    const red = pixels[index]
    const green = channels >= 3 ? pixels[index + 1] : red
    const blue = channels >= 3 ? pixels[index + 2] : red
    const alpha = channels === 2 ? pixels[index + 1] : channels === 4 ? pixels[index + 3] : 255
    if (alpha > 0 && (red > 2 || green > 2 || blue > 2)) nonBlankPixels += 1
  }
  return { width, height, nonBlankPixels, nonBlank: nonBlankPixels > Math.max(8, width * height / 400) }
}

function routeAssets(route, policy, assets, violations) {
  const requestUrl = route.request().url()
  if (policy.classify(requestUrl) !== 'allow') {
    violations.network.push(requestUrl)
    return route.abort()
  }
  const pathname = new URL(requestUrl).pathname
  const asset = assets.get(pathname)
  if (!asset) {
    violations.network.push(requestUrl)
    return route.abort()
  }
  try {
    const body = asset.body ?? readFileSync(asset.filePath)
    return route.fulfill({
      status: 200,
      body,
      headers: { ...policy.responseHeaders, 'content-type': asset.mimeType || mimeType(pathname) },
    })
  } catch (error) {
    violations.routeErrors.push(`${pathname}: ${error.message}`)
    return route.abort()
  }
}

export function createCanaryHtml() {
  const prefix = '<!doctype html><meta charset="utf-8"><title>arcade smoke canary</title><script>window.__arcadeSmokeReady=true</script>'
  const size = Buffer.byteLength(prefix)
  if (size > CANARY_BYTE_LENGTH) throw new Error('canary HTML exceeds its 1 KiB contract')
  return `${prefix}${' '.repeat(CANARY_BYTE_LENGTH - size)}`
}

function defaultCanaryHtml() {
  return createCanaryHtml()
}

function runtimeAssetPath(caseId, category, index, fileName) {
  const safeName = String(fileName || `asset-${index}`).replace(/[^a-zA-Z0-9._-]/g, '_')
  return `/case/${caseId}/${category}/${String(index).padStart(3, '0')}-${safeName}`
}

function runtimeAsset(record, caseId, category, index, descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new TypeError(`${category}[${index}] must be an object`)
  const filePath = descriptor.filePath
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError(`${category}[${index}].filePath is required`)
  const absolutePath = resolve(filePath)
  assertRegularFile(absolutePath, `${category}[${index}]`)
  const bytes = readFileSync(absolutePath)
  const actualSha256 = sha256(bytes)
  if (descriptor.sha256 !== undefined && String(descriptor.sha256).toLowerCase() !== actualSha256) {
    throw new Error(`${category}[${index}] SHA-256 does not match its local bytes`)
  }
  const fileName = descriptor.fileName || descriptor.name
  if (typeof fileName !== 'string' || fileName.trim() === '') throw new TypeError(`${category}[${index}].fileName is required`)
  const path = runtimeAssetPath(caseId, category, index, fileName)
  return {
    path,
    filePath: absolutePath,
    mimeType: descriptor.mimeType,
    fileName,
    role: descriptor.role || null,
    size: bytes.length,
    sha256: actualSha256,
  }
}

/**
 * Convert a build-addressed local case into a virtual-origin manifest. Every
 * ROM/core/BIOS byte is explicitly routed; the generated HTML has no network
 * URL and can therefore run under the catch-all abort policy.
 */
export function buildRuntimeCase(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('runtime case is required')
  const caseId = safeId(String(input.caseId || input.candidateId || 'case'))
  requiredCaseHash(input.buildFingerprint, 'runtime case buildFingerprint')
  requiredCaseHash(input.coreArtifactFingerprint, 'runtime case coreArtifactFingerprint')
  const runtime = input.runtime
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime case requires runtime artifacts')
  if (!Array.isArray(runtime.archives) || runtime.archives.length === 0) throw new Error('runtime case requires at least one archive')
  if (typeof runtime.coreName !== 'string' || runtime.coreName.trim() === '') throw new Error('runtime case requires coreName')
  if (!runtime.coreJs || !runtime.coreWasm) throw new Error('runtime case requires exact core JS and WASM')
  const assets = []
  const nostalgistPath = runtime.nostalgistFilePath || join(REPO_ROOT, 'node_modules', 'nostalgist', 'dist', 'nostalgist.umd.js')
  assertRegularFile(nostalgistPath, 'Nostalgist UMD runtime')
  assets.push({
    path: `/case/${caseId}/runtime/nostalgist.umd.js`,
    filePath: resolve(nostalgistPath),
    mimeType: 'text/javascript; charset=utf-8',
  })
  const coreJs = runtimeAsset(input, caseId, 'core', 0, { ...runtime.coreJs, fileName: 'core.js' })
  const coreWasm = runtimeAsset(input, caseId, 'core', 1, { ...runtime.coreWasm, fileName: 'core.wasm', mimeType: 'application/wasm' })
  assets.push(coreJs, coreWasm)
  const archives = runtime.archives.map((archive, index) => runtimeAsset(input, caseId, 'rom', index, { ...archive, mimeType: 'application/zip' }))
  const parentIndex = archives.findIndex((archive) => archive.role === 'parent')
  const primaryIndex = archives.findIndex((archive) => archive.role === 'primary')
  if (primaryIndex < 0) throw new Error('runtime case requires a primary archive')
  const parentCandidateId = input.parentCandidateId
    ?? runtime.parentCandidateId
    ?? runtime.archives.find((archive) => archive.role === 'parent')?.candidateId
    ?? null
  if (parentIndex >= 0 && primaryIndex >= 0 && parentIndex > primaryIndex) throw new Error('split runtime archives must mount parent before primary')
  assets.push(...archives)
  const bios = (runtime.bios || []).map((item, index) => runtimeAsset(input, caseId, 'bios', index, item))
  assets.push(...bios)
  const fetchBlob = (path) => `fetch(${JSON.stringify(path)}).then((response) => { if (!response.ok) throw new Error('asset HTTP '+response.status); return response.blob(); })`
  const romLiteral = `[${archives.map((archive) => `{fileName:${JSON.stringify(archive.fileName)},fileContent:${fetchBlob(archive.path)}}`).join(',')}]`
  const biosLiteral = `[${bios.map((item) => `{fileName:${JSON.stringify(item.fileName)},fileContent:${fetchBlob(item.path)}}`).join(',')}]`
  const html = `<!doctype html><meta charset="utf-8"><title>arcade runtime smoke</title><canvas id="arcade-canvas" width="640" height="480"></canvas><script src="${assets[0].path}"></script><script>(async()=>{try{const N=window.Nostalgist&&window.Nostalgist.Nostalgist?window.Nostalgist.Nostalgist:window.Nostalgist;if(!N||typeof N.launch!=='function')throw new Error('Nostalgist runtime missing');const e=await N.launch({core:${JSON.stringify(runtime.coreName)},rom:${romLiteral},bios:${biosLiteral},element:document.querySelector('#arcade-canvas'),resolveCoreJs:()=>${fetchBlob(coreJs.path)},resolveCoreWasm:()=>${fetchBlob(coreWasm.path)}});window.__arcadeSmokeReady=true;window.__arcadeSmokeEmulator=e}catch(error){window.__arcadeSmokeError=String(error&&error.stack||error);console.error(error)}})()</script>`
  return {
    ...input,
    caseId,
    html,
    assets,
    requireCanvas: true,
    requireContent: true,
    runtimeMode: archives.some((archive) => archive.role === 'parent') ? 'split' : 'standalone',
    archiveLayout: input.archiveLayout ?? (archives.some((archive) => archive.role === 'parent') ? 'split' : 'standalone'),
    archiveSha256: input.archiveSha256 ?? archives[primaryIndex].sha256,
    parentArchiveSha256: input.parentArchiveSha256 ?? (parentIndex >= 0 ? archives[parentIndex].sha256 : null),
    parentCandidateId,
    coreArtifactId: input.coreArtifactId ?? runtime.coreArtifactId ?? null,
    expectedContentName: archives[primaryIndex].fileName.replace(/\.zip$/i, '').toLowerCase(),
  }
}

export function classifyContentStatus(reply) {
  const normalized = String(reply || '').trim().toLowerCase()
  if (!normalized) return { state: 'unavailable', ready: false }
  const state = normalized.replace(/^get_status\s+/, '').split(/\s+/)[0]
  const ready = new Set(['playing', 'paused', 'running']).has(state)
  return { state: state || 'unavailable', ready }
}

function contentNameFromStatus(reply) {
  const normalized = String(reply || '').trim().toLowerCase()
  const match = normalized.match(/\b(?:playing|paused|running)\s*,\s*([^,\s]+)/)
  return match ? match[1].replace(/\.zip$/, '') : null
}

async function probeRuntimeContent(page) {
  const reply = await page.evaluate(async () => {
    const module = window.__arcadeSmokeEmulator?.getEmulator?.()?.getEmscripten?.()?.Module
    if (typeof module?.EmscriptenSendCommand !== 'function' || typeof module?.EmscriptenReceiveCommandReply !== 'function') return ''
    module.EmscriptenSendCommand('GET_STATUS')
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const response = module.EmscriptenReceiveCommandReply()
      if (response) return response
    }
    return ''
  })
  return { reply, ...classifyContentStatus(reply) }
}

function listFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

function addCaseAsset(assets, path, asset) {
  const normalizedPath = normalizeAllowedPath(path)
  if (assets.has(normalizedPath)) throw new Error(`duplicate smoke asset path: ${normalizedPath}`)
  if (asset.filePath) {
    const absolute = resolve(asset.filePath)
    assertRegularFile(absolute, `smoke asset ${normalizedPath}`)
    if (asset.size !== undefined && statSync(absolute).size !== Number(asset.size)) {
      throw new Error(`smoke asset size mismatch: ${normalizedPath}`)
    }
    if (asset.sha256 !== undefined && sha256(readFileSync(absolute)) !== String(asset.sha256).toLowerCase()) {
      throw new Error(`smoke asset SHA-256 mismatch: ${normalizedPath}`)
    }
    assets.set(normalizedPath, { filePath: absolute, mimeType: asset.mimeType })
    return
  }
  if (asset.body !== undefined) {
    assets.set(normalizedPath, { body: Buffer.from(asset.body), mimeType: asset.mimeType })
    return
  }
  throw new Error(`smoke asset ${normalizedPath} has no filePath or body`)
}

let nextRunSequence = 0

async function openIsolatedContext({ browserFactory, sharedBrowser, profilePath, downloadsPath, executable }) {
  const options = {
    executablePath: executable.path,
    headless: true,
    acceptDownloads: SMOKE_CONTRACT.acceptDownloads,
    serviceWorkers: SMOKE_CONTRACT.serviceWorkers,
    downloadsPath,
    viewport: { width: 640, height: 480 },
  }
  if (typeof browserFactory.launchPersistentContext === 'function') {
    const context = await browserFactory.launchPersistentContext(profilePath, options)
    return { context, persistent: true }
  }
  if (!sharedBrowser) throw new Error('browser factory cannot create an isolated context')
  const context = await sharedBrowser.newContext(options)
  return { context, persistent: false }
}

async function runCase({ browserFactory, sharedBrowser, caseRecord, profileRoot, outputRoot, executable, runScope, attempt }) {
  const caseId = safeId(String(caseRecord.caseId || caseRecord.candidateId || 'case'))
  const isCanary = caseId === 'canary-1kib-no-rom' && !caseRecord.requireCanvas && !caseRecord.requireContent
  const buildFingerprint = isCanary
    ? sha256(Buffer.from(caseId))
    : requiredCaseHash(caseRecord.buildFingerprint, `${caseId}.buildFingerprint`)
  const coreArtifactFingerprint = isCanary
    ? sha256(Buffer.from(`${caseId}:core`))
    : requiredCaseHash(caseRecord.coreArtifactFingerprint, `${caseId}.coreArtifactFingerprint`)
  const profilePath = buildCaseProfilePath(profileRoot, caseId, `${runScope}-${attempt}`)
  const downloadsPath = join(profilePath, 'downloads')
  mkdirSync(downloadsPath, { recursive: true })
  const violations = { network: [], downloads: [], downloadFiles: [], serviceWorkers: [], routeErrors: [], consoleErrors: [] }
  const beforePortProbe = listListeningPorts()
  const beforeProcessProbe = processSnapshot()
  const beforePorts = beforePortProbe.entries
  const beforeProcesses = beforeProcessProbe.entries
  const probeErrors = [beforePortProbe.error, beforeProcessProbe.error].filter(Boolean)
  const assets = new Map()
  const htmlPath = `/case/${caseId}/index.html`
  addCaseAsset(assets, htmlPath, { body: caseRecord.html || defaultCanaryHtml(), mimeType: 'text/html; charset=utf-8' })
  for (const asset of caseRecord.assets || []) addCaseAsset(assets, asset.path, asset)
  const policy = createRoutePolicy({ origin: SMOKE_CONTRACT.origin, allowedPaths: assets.keys() })
  let context
  let page
  let result
  let contentStatus = null
  let frame = { captured: false }
  try {
    ({ context } = await openIsolatedContext({ browserFactory, sharedBrowser, profilePath, downloadsPath, executable }))
    await context.route('**/*', (route) => routeAssets(route, policy, assets, violations))
    context.on('requestfailed', (request) => {
      if (policy.classify(request.url()) !== 'allow') violations.network.push(request.url())
    })
    context.on('serviceworker', (worker) => violations.serviceWorkers.push(worker.url()))
    page = await context.newPage()
    page.on('download', (download) => violations.downloads.push(download.suggestedFilename()))
    page.on('console', (message) => { if (message.type() === 'error') violations.consoleErrors.push(message.text()) })
    page.on('pageerror', (error) => violations.consoleErrors.push(error.message))
    const timeout = Number(caseRecord.timeoutMs || 15000)
    await page.goto(`${SMOKE_CONTRACT.origin}${htmlPath}`, { waitUntil: 'domcontentloaded', timeout })
    await page.waitForFunction(() => window.__arcadeSmokeReady === true || Boolean(window.__arcadeSmokeError), { timeout })
    const pageError = await page.evaluate(() => window.__arcadeSmokeError || null)
    if (pageError) throw Object.assign(new Error(pageError), { failureCode: 'runtime-error' })
    if (caseRecord.requireContent) {
      contentStatus = await probeRuntimeContent(page)
      if (!contentStatus.ready) {
        throw Object.assign(new Error(`runtime content status is ${contentStatus.state}`), { failureCode: contentStatus.state === 'contentless' ? 'contentless' : 'content-status-unavailable' })
      }
      const reportedContentName = contentNameFromStatus(contentStatus.reply)
      if (!reportedContentName || (caseRecord.expectedContentName && reportedContentName !== caseRecord.expectedContentName.toLowerCase())) {
        throw Object.assign(new Error(`runtime content name mismatch: expected ${caseRecord.expectedContentName || 'a reported content name'}, got ${reportedContentName || 'none'}`), { failureCode: 'content-mismatch' })
      }
      contentStatus = { ...contentStatus, contentName: reportedContentName }
    }
    if (caseRecord.requireCanvas) {
      const framePath = join(profilePath, 'frame.png')
      const canvas = page.locator('canvas').first()
      const screenshot = await canvas.screenshot({ path: framePath })
      frame = { ...inspectPng(screenshot), captured: true }
      if (!frame.nonBlank) throw Object.assign(new Error('emulator frame is blank'), { failureCode: 'blank-frame' })
    }
    if (violations.network.length || violations.downloads.length || violations.serviceWorkers.length || violations.routeErrors.length) {
      throw Object.assign(new Error('smoke isolation policy violation'), { failureCode: 'isolation-violation' })
    }
    result = { result: 'passed', acceptance: 'pending', failureCode: null, frame, contentStatus }
  } catch (error) {
    result = {
      result: 'failed',
      acceptance: 'pending',
      failureCode: error.failureCode || (error.name === 'TimeoutError' ? 'timeout' : 'runtime-error'),
      error: error.message,
      frame,
      contentStatus,
    }
  } finally {
    if (page) await page.close().catch(() => {})
    if (context) await context.close().catch(() => {})
  }
  violations.downloadFiles = listFiles(downloadsPath).map((path) => path.slice(downloadsPath.length + 1).replaceAll('\\', '/'))
  const afterPortProbe = listListeningPorts()
  const afterProcessProbe = processSnapshot()
  const afterPorts = afterPortProbe.entries
  const afterProcesses = afterProcessProbe.entries
  probeErrors.push(afterPortProbe.error, afterProcessProbe.error)
  const uniqueProbeErrors = [...new Set(probeErrors.filter(Boolean))]
  const listenerPortsOpened = afterPorts.filter((entry) => !beforePorts.includes(entry))
  const unexpectedProcesses = filterMeaningfulProcesses([...afterProcesses].filter((entry) => !beforeProcesses.has(entry))).sort()
  const forbiddenExternalProcesses = findForbiddenExternalProcesses(unexpectedProcesses)
  if (uniqueProbeErrors.length) {
    result = {
      result: 'inconclusive', acceptance: 'pending', failureCode: 'isolation-probe-unavailable',
      error: uniqueProbeErrors.join('; '), frame, contentStatus,
    }
  } else if (result.result === 'passed' && (listenerPortsOpened.length || violations.downloadFiles.length || forbiddenExternalProcesses.length)) {
    result = {
      result: 'failed', acceptance: 'pending',
      failureCode: listenerPortsOpened.length ? 'listener-port-change' : violations.downloadFiles.length ? 'download-file-created' : 'external-process',
      error: 'smoke isolation postcondition failed',
    }
  }
  const identityMetadata = Object.fromEntries([
    'runtimeContractFingerprint', 'rawContentContractSha256', 'contentManifestSha256',
    'archiveSha256', 'archiveLayout', 'runtimeParentBuildFingerprint',
    'thumbnailSha256', 'coreArtifactId', 'parentArchiveSha256', 'parentCandidateId',
  ].filter((field) => Object.prototype.hasOwnProperty.call(caseRecord, field))
    .map((field) => [field, caseRecord[field]]))
  const runKey = hashCaseIdentity(caseRecord)
  const output = validateSmokeResult({
    kind: 'arcade-smoke-result-v1',
    runId: `${caseId}-${runKey.slice(0, 16)}-${attempt}-${Date.now()}-${process.pid}-${nextRunSequence++}`,
    attempt,
    runKey,
    candidateId: caseRecord.candidateId || caseId,
    logicalRomKey: caseRecord.logicalRomKey || caseRecord.candidateId || caseId,
    buildFingerprint,
    coreArtifactFingerprint,
    biosManifestSha256: caseRecord.biosManifestSha256 || null,
    ...identityMetadata,
    browserSha256: executable.sha256,
    harnessVersion: SMOKE_CONTRACT.harnessVersion,
    ...result,
    contract: SMOKE_CONTRACT,
    isolation: {
      networkRequestsAborted: [...new Set(violations.network)].sort(),
      downloads: [...new Set(violations.downloads)].sort(),
      downloadFiles: violations.downloadFiles,
      serviceWorkers: [...new Set(violations.serviceWorkers)].sort(),
      routeErrors: violations.routeErrors,
      listenerPortsBefore: beforePorts,
      listenerPortsAfter: afterPorts,
      listenerPortsOpened,
      unexpectedProcesses,
      forbiddenExternalProcesses,
      probeErrors: uniqueProbeErrors,
      consoleErrors: violations.consoleErrors,
    },
    evidence: {
      profile: relative(outputRoot, profilePath).replaceAll('\\', '/'),
      frame: frame.captured ? `${relative(outputRoot, profilePath).replaceAll('\\', '/')}/frame.png` : null,
    },
  })
  return output
}

export async function runSmoke({
  cases = [],
  outputRoot,
  profileRoot = null,
  executablePath = DEFAULT_HEADLESS_SHELL,
  browserFactory = chromium,
  canary = true,
  retryPolicy = {},
} = {}) {
  if (!outputRoot) throw new TypeError('outputRoot is required')
  if (!Array.isArray(cases)) throw new TypeError('cases must be an array')
  const output = assertEvidenceRootOutsideRepository(outputRoot, 'outputRoot')
  profileRoot = assertEvidenceRootOutsideRepository(profileRoot || join(output, 'profiles'), 'profileRoot')
  contained(output, profileRoot, 'profileRoot')
  mkdirSync(output, { recursive: true })
  const executable = resolveHeadlessShell({ executablePath })
  const policy = normalizeRetryPolicy(retryPolicy)
  const runScope = `${Date.now()}-${process.pid}-${nextRunSequence++}`
  let sharedBrowser = null
  if (typeof browserFactory.launchPersistentContext !== 'function') {
    sharedBrowser = await browserFactory.launch({ executablePath: executable.path, headless: true })
  }
  const results = []
  try {
    const rawCases = canary ? [{ caseId: 'canary-1kib-no-rom', candidateId: 'canary', html: defaultCanaryHtml() }, ...cases] : cases
    const runCases = rawCases.map((caseRecord) => (
      caseRecord?.runtime && (!caseRecord.html || !Array.isArray(caseRecord.assets))
        ? buildRuntimeCase(caseRecord)
        : caseRecord
    ))
    for (const caseRecord of runCases) {
      let attempt = 1
      while (true) {
        const result = await runCase({
          browserFactory,
          sharedBrowser,
          caseRecord,
          profileRoot,
          outputRoot: output,
          executable,
          runScope,
          attempt,
        })
        const path = join(output, 'results', `${result.runId}.json`)
        appendJson(path, result)
        results.push(result)
        if (!shouldRetrySmokeResult(result, attempt, policy)) break
        attempt += 1
      }
    }
  } finally {
    if (sharedBrowser) await sharedBrowser.close()
  }
  return { kind: 'arcade-smoke-run-v1', contract: SMOKE_CONTRACT, retryPolicy: policy, results }
}

function parseArgs(argv) {
  const options = { canary: true }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--no-canary') options.canary = false
    else if (value.startsWith('--')) {
      const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
      options[key] = next
      index += 1
    } else throw new Error(`unexpected argument: ${value}`)
  }
  if (!options.outputRoot) throw new Error('--output-root is required')
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const cases = options.caseManifest ? JSON.parse(readFileSync(resolve(options.caseManifest), 'utf8')) : []
  const result = await runSmoke({
    cases: Array.isArray(cases) ? cases : cases.cases,
    outputRoot: options.outputRoot,
    profileRoot: options.profileRoot,
    executablePath: options.executablePath,
    retryPolicy: options.maxAttempts ? { maxAttempts: Number(options.maxAttempts) } : {},
    canary: options.canary,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`run-smoke: ${error.message}\n`)
    process.exitCode = 2
  })
}
