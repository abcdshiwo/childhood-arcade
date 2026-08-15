import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODES = ['node', 'component', 'browser']

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function portablePath(path) {
  return path.replaceAll('\\', '/')
}

export async function discoverTestFiles(mode, projectRoot = PROJECT_ROOT) {
  if (!MODES.includes(mode)) throw new Error(`Unknown test suite: ${mode}`)

  const testRoot = join(projectRoot, 'test')
  if (mode === 'node') {
    const entries = await readdir(testRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
      .map((entry) => portablePath(join(testRoot, entry.name)))
      .sort()
  }

  const suiteRoot = join(testRoot, mode === 'component' ? 'components' : 'browser')
  const suffix = mode === 'component' ? '.test.js' : '.spec.mjs'
  return (await walk(suiteRoot))
    .filter((path) => path.endsWith(suffix))
    .map(portablePath)
    .sort()
}

function runProcess(arguments_, projectRoot) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

export async function runSuite(mode, projectRoot = PROJECT_ROOT) {
  const files = await discoverTestFiles(mode, projectRoot)
  if (files.length === 0) throw new Error(`${mode} suite discovered zero tests`)

  if (mode === 'component') {
    return runProcess(
      [
        portablePath(join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs')),
        'run',
        '--config',
        portablePath(join(projectRoot, 'vitest.config.js')),
      ],
      projectRoot,
    )
  }

  return runProcess(['--test', ...files], projectRoot)
}

export async function main(requestedMode = process.argv[2]) {
  const modes = requestedMode ? [requestedMode] : MODES
  for (const mode of modes) {
    if (!MODES.includes(mode)) throw new Error(`Unknown test suite: ${mode}`)
    console.log(`\n=== ${mode} tests ===`)
    const status = await runSuite(mode)
    if (status !== 0) return status
  }
  return 0
}

const invokedPath = process.argv[1]?.replaceAll('\\', '/')
if (invokedPath && invokedPath === fileURLToPath(import.meta.url).replaceAll('\\', '/')) {
  main()
    .then((status) => {
      process.exitCode = status
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
