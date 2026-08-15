import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const AUDITED_CORE_ARTIFACT_PATHS = new Set([
  'data/cores/fbalpha2012.js',
  'data/cores/fbalpha2012.wasm',
  'data/cores/fbalpha2012_cps1.js',
  'data/cores/fbalpha2012_cps1.wasm',
  'data/cores/fbalpha2012_cps2.js',
  'data/cores/fbalpha2012_cps2.wasm',
])

const FORBIDDEN_ROOTS = [
  '.qa-input/',
  '.superpowers/',
  'data/roms/',
  'data/saves/',
  'tools/arcade-import/work/',
  'tools/arcade-import/output/',
  'tools/arcade-import/batch-output/',
  'tools/arcade-import/evidence/',
  'tools/arcade-import/generated/',
  'tools/arcade-import/normalized/',
  'tools/arcade-import/quarantine/',
  'tools/arcade-import/source-extracts/',
  'tools/arcade-smoke/profiles/',
  'tools/arcade-smoke/results/',
  'tools/arcade-smoke/evidence/',
  'tools/arcade-smoke/screenshots/',
  'tools/arcade-smoke/downloads/',
]

const FORBIDDEN_PATH_SEGMENTS = new Set([
  'arcade-work',
  'batch-output',
  'downloads',
  'evidence',
  'generated-images',
  'normalized-roms',
  'profiles',
  'quarantine',
  'rom',
  'roms',
  'save',
  'save-states',
  'saves',
  'screenshots',
  'thumbnails',
  'validation-evidence',
])

const FORBIDDEN_EXTENSIONS = [
  ['source or ROM archive', /\.(?:7z|rar|zip|tar|tgz|tar\.gz)$/i],
  ['ROM or disc image', /\.(?:bin|ccd|chd|cue|fds|gb|gba|gbc|gen|gg|img|iso|mdx|nes|nrg|pbp|pce|rom|sfc|smc|sms)$/i],
  ['save or NVRAM sample', /\.(?:fs|nv|nvram|rtc|sav|srm|state\d*)$/i],
  ['generated image', /\.(?:bmp|gif|jpe?g|png|webp)$/i],
  ['batch executable', /\.bat$/i],
]

function normalizePath(path) {
  return path.replace(/^\.\//, '').replace(/^\/+/, '')
}

export function classifyArcadeStagedPath(inputPath) {
  if (inputPath.includes('\\')) {
    return 'ambiguous backslash path is forbidden; Git index paths must use forward slashes'
  }

  const path = normalizePath(inputPath)
  const lowerPath = path.toLowerCase()

  if (AUDITED_CORE_ARTIFACT_PATHS.has(path)) return null

  if (lowerPath.startsWith('data/cores/') && /\.(?:js|wasm)$/i.test(lowerPath)) {
    return 'unaudited core artifact; only the six hash-pinned FBA2012 files are allowlisted'
  }

  const forbiddenRoot = FORBIDDEN_ROOTS.find((root) => lowerPath.startsWith(root))
  if (forbiddenRoot) return `runtime or generated path is forbidden: ${forbiddenRoot}`

  const segments = lowerPath.split('/')
  const forbiddenSegment = segments.find((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))
  if (forbiddenSegment) return `runtime or generated path segment is forbidden: ${forbiddenSegment}`

  for (const [label, pattern] of FORBIDDEN_EXTENSIONS) {
    if (pattern.test(lowerPath)) return `${label} files must remain outside Git`
  }

  return null
}

export function findForbiddenArcadePaths(paths) {
  return paths.flatMap((inputPath) => {
    const reason = classifyArcadeStagedPath(inputPath)
    const path = inputPath.includes('\\') ? inputPath : normalizePath(inputPath)
    return reason ? [{ path, reason }] : []
  })
}

function stagedPaths() {
  const result = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git diff exited with status ${result.status}`)
  }
  return result.stdout.split('\0').filter(Boolean)
}

export function main() {
  let forbidden
  try {
    forbidden = findForbiddenArcadePaths(stagedPaths())
  } catch (error) {
    console.error(`Unable to inspect the Git index: ${error.message}`)
    process.exitCode = 2
    return
  }

  if (forbidden.length === 0) {
    console.log('Arcade staged-file guard passed.')
    return
  }

  console.error('Arcade staged-file guard rejected forbidden files:')
  for (const entry of forbidden) console.error(`- ${entry.path}: ${entry.reason}`)
  process.exitCode = 1
}

const invokedPath = process.argv[1]?.replaceAll('\\', '/')
if (invokedPath && invokedPath === fileURLToPath(import.meta.url).replaceAll('\\', '/')) main()
