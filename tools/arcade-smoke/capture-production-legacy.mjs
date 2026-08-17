#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const SHA256 = /^[0-9a-f]{64}$/i
const HOST = /^[a-z0-9_.:-]+$/i
const POSIX_ABSOLUTE = /^\/(?!\/)/
const UNSAFE_REMOTE = /[\0\r\n\t '"`;$|&<>*?{}!\\[\]]/

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`)
  return value.trim()
}

function requiredPort(value, field) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`${field} must be a TCP port`)
  return port
}

function safeHost(value, field) {
  const host = requiredString(value, field)
  if (!HOST.test(host) || UNSAFE_REMOTE.test(host)) throw new Error(`${field} contains unsafe characters`)
  return host
}

function physicalPath(value) {
  let current = resolve(value)
  const missing = []
  while (true) {
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (stat) {
      let physical = realpathSync(current)
      for (const part of missing) physical = join(physical, part)
      return resolve(physical)
    }
    const parent = dirname(current)
    if (parent === current) return current
    missing.unshift(basename(current))
    current = parent
  }
}

function isWithin(root, candidate) {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix)
}

function safePosixPath(value, field) {
  const path = requiredString(value, field)
  if (!POSIX_ABSOLUTE.test(path) || UNSAFE_REMOTE.test(path)) throw new Error(`${field} must be an absolute safe POSIX path`)
  const parts = path.split('/')
  if (parts.includes('..') || parts.slice(1).some((part) => part === '')) {
    // A repeated slash is ambiguous for a remote shell and is deliberately rejected.
    throw new Error(`${field} contains traversal or an empty path segment`)
  }
  return path
}

function safeRelativePath(value, field) {
  const path = requiredString(value, field).replaceAll('\\', '/')
  if (isAbsolute(path) || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${field} must be a safe relative path`)
  }
  return path
}

function contained(root, candidate, field) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  if (!isWithin(physicalPath(absoluteRoot), physicalPath(absoluteCandidate))) throw new Error(`${field} escapes outputRoot`)
  return absoluteCandidate
}

function externalOutputRoot(value) {
  const output = resolve(requiredString(value, 'outputRoot'))
  if (isWithin(physicalPath(REPO_ROOT), physicalPath(output))) {
    throw new Error('outputRoot must be outside the Git worktree')
  }
  return output
}

function defaultIdentityFile() {
  const profile = process.env.USERPROFILE || process.env.HOME || ''
  return profile ? join(profile, '.ssh', 'id_rsa') : '.ssh\\id_rsa'
}

function normalizeRemoteFile(entry, index, remoteDataRoot) {
  if (typeof entry !== 'string' && (!entry || typeof entry !== 'object')) {
    throw new TypeError(`remoteFiles[${index}] must be a path or object`)
  }
  const remotePath = safePosixPath(
    typeof entry === 'string' ? entry : entry.remotePath,
    `remoteFiles[${index}].remotePath`,
  )
  const rootPrefix = `${remoteDataRoot}/`
  if (!remotePath.startsWith(rootPrefix)) {
    throw new Error(`remoteFiles[${index}] is outside remoteDataRoot`)
  }
  const relativePath = typeof entry === 'object' && entry.relativePath
    ? safeRelativePath(entry.relativePath, `remoteFiles[${index}].relativePath`)
    : safeRelativePath(remotePath.slice(rootPrefix.length), `remoteFiles[${index}].relativePath`)
  return {
    remotePath,
    relativePath,
    sha256: typeof entry === 'object' && entry.sha256 !== undefined ? String(entry.sha256).toLowerCase() : null,
    size: typeof entry === 'object' && entry.size !== undefined ? Number(entry.size) : null,
  }
}

/** Normalize and validate a read-only production capture request. */
export function validateCaptureRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('capture request must be an object')
  const remoteDataRoot = safePosixPath(input.remoteDataRoot, 'remoteDataRoot')
  const request = {
    host: safeHost(input.host, 'host'),
    port: requiredPort(input.port ?? 22, 'port'),
    user: safeHost(input.user ?? 'root', 'user'),
    jumpHost: safeHost(input.jumpHost, 'jumpHost'),
    jumpPort: requiredPort(input.jumpPort ?? input.port ?? 22, 'jumpPort'),
    jumpUser: safeHost(input.jumpUser ?? input.user ?? 'root', 'jumpUser'),
    remoteDb: safePosixPath(input.remoteDb, 'remoteDb'),
    remoteDataRoot,
    outputRoot: externalOutputRoot(input.outputRoot),
    identityFile: resolve(requiredString(input.identityFile ?? defaultIdentityFile(), 'identityFile')),
    sqliteBinary: safeHost(input.sqliteBinary ?? 'sqlite3', 'sqliteBinary'),
    backupName: safeRelativePath(input.backupName ?? 'production-online-backup.sqlite', 'backupName'),
    remoteBackupPath: input.remoteBackupPath
      ? safePosixPath(input.remoteBackupPath, 'remoteBackupPath')
      : null,
    remoteFiles: Array.isArray(input.remoteFiles)
      ? input.remoteFiles.map((entry, index) => normalizeRemoteFile(entry, index, remoteDataRoot))
      : [],
    expectedFiles: Array.isArray(input.expectedFiles) ? input.expectedFiles.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new TypeError(`expectedFiles[${index}] must be an object`)
      const relativePath = safeRelativePath(entry.relativePath, `expectedFiles[${index}].relativePath`)
      if (!SHA256.test(String(entry.sha256 || ''))) throw new TypeError(`expectedFiles[${index}].sha256 must be a SHA-256`)
      const size = Number(entry.size)
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError(`expectedFiles[${index}].size must be a non-negative integer`)
      return { relativePath, sha256: String(entry.sha256).toLowerCase(), size }
    }) : [],
  }
  if (request.remoteFiles.some((entry) => entry.sha256 !== null && !SHA256.test(entry.sha256))) {
    throw new TypeError('remote file SHA-256 must be a 64-character hex string')
  }
  if (request.remoteFiles.some((entry) => entry.size !== null && (!Number.isSafeInteger(entry.size) || entry.size < 0))) {
    throw new TypeError('remote file size must be a non-negative safe integer')
  }
  if (new Set(request.remoteFiles.map((entry) => entry.relativePath)).size !== request.remoteFiles.length) {
    throw new Error('remoteFiles contains duplicate relative paths')
  }
  if (new Set(request.expectedFiles.map((entry) => entry.relativePath)).size !== request.expectedFiles.length) {
    throw new Error('expectedFiles contains duplicate relative paths')
  }
  return Object.freeze(request)
}

function sshJump(request) {
  return `${request.jumpUser}@${request.jumpHost}:${request.jumpPort}`
}

function scpBaseArgs(request) {
  return [
    'scp.exe',
    '-O', // Force legacy SCP protocol; SFTP mode can silently change path semantics.
    '-J', sshJump(request),
    '-P', String(request.port),
    '-i', request.identityFile,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
  ]
}

function remoteSpec(request, remotePath = request.remoteDb) {
  return `${request.user}@${request.host}:${remotePath}`
}

function resolvedRemoteBackupPath(request) {
  return request.remoteBackupPath || `/tmp/arcade-capture-${process.pid}.sqlite`
}

/** Build the exact argv used for the database snapshot copy. */
export function buildCaptureCommand(input, { remotePath, destinationPath } = {}) {
  const request = validateCaptureRequest(input)
  const source = remoteSpec(request, safePosixPath(remotePath ?? request.remoteDb, 'remotePath'))
  const destination = contained(request.outputRoot, destinationPath || join(request.outputRoot, request.backupName), 'capture destination')
  return [...scpBaseArgs(request), source, destination]
}

/** Build a remote sqlite online-backup invocation without a shell string. */
export function buildRemoteBackupCommand(input, { remoteBackupPath } = {}) {
  const request = validateCaptureRequest(input)
  const target = remoteBackupPath ?? resolvedRemoteBackupPath(request)
  const safeTarget = safePosixPath(target, 'remoteBackupPath')
  const sql = `.backup '${safeTarget}'`
  return [
    'ssh.exe', '-J', sshJump(request), '-p', String(request.port), '-i', request.identityFile,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    `${request.user}@${request.host}`, request.sqliteBinary, request.remoteDb, sql,
  ]
}

/** Build the cleanup command for the temporary remote SQLite snapshot. */
export function buildRemoteCleanupCommand(input, { remoteBackupPath } = {}) {
  const request = validateCaptureRequest(input)
  const safeTarget = safePosixPath(remoteBackupPath ?? resolvedRemoteBackupPath(request), 'remoteBackupPath')
  return [
    'ssh.exe', '-J', sshJump(request), '-p', String(request.port), '-i', request.identityFile,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    `${request.user}@${request.host}`, 'rm', '--', safeTarget,
  ]
}

/** Return all commands and their local destinations; dry-run callers can inspect this plan. */
export function buildCapturePlan(input) {
  const request = validateCaptureRequest(input)
  const remoteBackupPath = resolvedRemoteBackupPath(request)
  const dbDestination = join(request.outputRoot, request.backupName)
  const commands = [
    { kind: 'online-backup', argv: buildRemoteBackupCommand(request, { remoteBackupPath }) },
    { kind: 'database', argv: buildCaptureCommand(request, { remotePath: remoteBackupPath, destinationPath: dbDestination }), destination: dbDestination },
  ]
  for (const file of request.remoteFiles) {
    const destination = contained(request.outputRoot, join(request.outputRoot, file.relativePath), 'asset destination')
    commands.push({
      kind: 'asset',
      argv: buildCaptureCommand(request, { remotePath: file.remotePath, destinationPath: destination }),
      destination,
      relativePath: file.relativePath,
    })
  }
  if (request.remoteBackupPath === null) {
    commands.push({ kind: 'cleanup', argv: buildRemoteCleanupCommand(request, { remoteBackupPath }) })
  }
  return Object.freeze({ request, commands: Object.freeze(commands) })
}

export function sha256File(path) {
  const bytes = readFileSync(path)
  return createHash('sha256').update(bytes).digest('hex')
}

function expectedCaptureFiles(request) {
  const expected = new Map(request.expectedFiles.map((entry) => [entry.relativePath, entry]))
  for (const file of request.remoteFiles) {
    const existing = expected.get(file.relativePath)
    const hasSize = file.size !== null
    const hasSha256 = file.sha256 !== null
    if (!hasSize || !hasSha256) {
      if (!existing) {
        throw new Error(`remote file ${file.relativePath} requires size and SHA-256 metadata or an expectedFiles entry`)
      }
      continue
    }
    const entry = { relativePath: file.relativePath, size: file.size, sha256: file.sha256 }
    if (existing && (existing.size !== entry.size || existing.sha256 !== entry.sha256)) {
      throw new Error(`remote file ${file.relativePath} conflicts with expectedFiles fingerprint`)
    }
    expected.set(file.relativePath, entry)
  }
  return [...expected.values()]
}

export function verifyCapturedFiles(request, entries = expectedCaptureFiles(request)) {
  const verified = []
  for (const entry of entries) {
    const target = contained(request.outputRoot, join(request.outputRoot, entry.relativePath), 'captured file')
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`captured file is missing: ${entry.relativePath}`)
    const actualSize = statSync(target).size
    const actualSha256 = sha256File(target)
    if (actualSize !== entry.size || actualSha256 !== entry.sha256.toLowerCase()) {
      throw new Error(`captured file fingerprint mismatch: ${entry.relativePath}`)
    }
    verified.push({ ...entry, absolutePath: target, actualSize, actualSha256 })
  }
  return verified
}

/**
 * Execute a capture only when apply=true. The default is a read-only plan, so
 * accidentally running this module cannot mutate production or overwrite local evidence.
 */
export function captureProductionLegacy(input, {
  apply = false,
  runner = (file, args) => execFileSync(file, args.slice(1), { stdio: 'inherit', windowsHide: true }),
} = {}) {
  const request = validateCaptureRequest(input)
  const plan = buildCapturePlan(request)
  if (!apply) return { applied: false, plan, verified: [] }
  const expectedFiles = expectedCaptureFiles(request)
  mkdirSync(request.outputRoot, { recursive: true })
  for (const command of plan.commands) {
    if (command.destination && existsSync(command.destination)) {
      throw new Error(`capture destination already exists: ${command.destination}`)
    }
  }
  const cleanup = plan.commands.find((command) => command.kind === 'cleanup')
  const captureCommands = plan.commands.filter((command) => command.kind !== 'cleanup')
  let failure = null
  let verified = []
  try {
    for (const command of captureCommands) {
      if (command.destination) mkdirSync(resolve(command.destination, '..'), { recursive: true })
      const [file] = command.argv
      runner(file, command.argv)
    }
    verified = verifyCapturedFiles(request, expectedFiles)
  } catch (error) {
    failure = error
  }
  if (cleanup) {
    try {
      const [file] = cleanup.argv
      runner(file, cleanup.argv)
    } catch (error) {
      if (!failure) failure = error
    }
  }
  if (failure) throw failure
  return { applied: true, plan, verified }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`)
    if (value === '--apply') {
      options.apply = true
      continue
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`)
    options[key] = next
    index += 1
  }
  for (const key of ['host', 'jumpHost', 'remoteDb', 'remoteDataRoot', 'outputRoot']) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const request = validateCaptureRequest(options)
  const result = captureProductionLegacy(request, { apply: options.apply === true })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`capture-production-legacy: ${error.message}\n`)
    process.exitCode = 2
  }
}
