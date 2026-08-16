import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as emulatorModule from '../src/composables/useEmulator.js'
import * as nostalgistModule from '../src/composables/nostalgist.js'

function fakeCanvas() {
  const attributes = new Map()
  const classes = new Set()
  let connected = false
  let focusCalls = 0
  let removeCalls = 0

  return {
    style: {},
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)) },
      contains(name) { return classes.has(name) },
    },
    connect() { connected = true },
    focus() { focusCalls += 1 },
    get focusCalls() { return focusCalls },
    getAttribute(name) { return attributes.get(name) ?? null },
    get isConnected() { return connected },
    remove() {
      connected = false
      removeCalls += 1
    },
    get removeCalls() { return removeCalls },
    setAttribute(name, value) { attributes.set(name, String(value)) },
  }
}

function fakeDocument() {
  const canvases = []
  return {
    canvases,
    createElement(tagName) {
      assert.equal(tagName, 'canvas')
      const canvas = fakeCanvas()
      canvases.push(canvas)
      return canvas
    },
  }
}

function fakeWrapper() {
  return {
    children: [],
    append(element) {
      element.connect()
      if (!this.children.includes(element)) this.children.push(element)
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function fakeEmulator(canvas, start) {
  let exitCalls = 0
  return {
    get exitCalls() { return exitCalls },
    exit() {
      exitCalls += 1
      canvas.remove()
    },
    getCanvas() { return canvas },
    start,
  }
}

test('createPortalCanvas creates the application-owned emulator canvas', () => {
  assert.equal(typeof emulatorModule.createPortalCanvas, 'function')

  const canvas = fakeCanvas()
  const documentRef = {
    createElement(tagName) {
      assert.equal(tagName, 'canvas')
      return canvas
    },
  }

  assert.equal(emulatorModule.createPortalCanvas(documentRef), canvas)
  assert.equal(canvas.getAttribute('tabindex'), '-1')
  assert.equal(canvas.classList.contains('portal-canvas'), true)
})

test('normalizePortalCanvas clears Nostalgist full-screen inline layout', () => {
  assert.equal(typeof emulatorModule.normalizePortalCanvas, 'function')

  const canvas = fakeCanvas()
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '100%',
    height: '100%',
    zIndex: '1',
  })

  assert.equal(emulatorModule.normalizePortalCanvas(canvas), canvas)
  assert.equal(canvas.style.position, 'static')
  assert.equal(canvas.style.left, 'auto')
  assert.equal(canvas.style.top, 'auto')
  assert.equal(canvas.style.width, '100%')
  assert.equal(canvas.style.height, '100%')
  assert.equal(canvas.style.zIndex, 'auto')
})

test('buildEmulatorOptions retains emulator configuration and supplied canvas', () => {
  assert.equal(typeof nostalgistModule.buildEmulatorOptions, 'function')

  const canvas = fakeCanvas()
  const rom = { fileName: 'game.zip', fileContent: '/api/roms/1/file' }
  const options = nostalgistModule.buildEmulatorOptions({
    core: 'fbneo',
    rom,
    retroarchConfig: { input_player1_a: 'k' },
    element: canvas,
  })

  assert.equal(options.core, 'fbneo')
  assert.equal(options.rom, rom)
  assert.equal(options.element, canvas)
  assert.equal(options.retroarchConfig.input_player1_a, 'k')
  assert.equal(options.retroarchConfig.rewind_enable, true)
})

test('split Blob inputs have stable distinct keys so build switches reboot', () => {
  assert.equal(typeof nostalgistModule.runtimeRomKey, 'function')
  const first = [
    { fileName: 'parent.zip', fileContent: new Blob(['parent']) },
    { fileName: 'child.zip', fileContent: new Blob(['child-a']) },
  ]
  const second = [
    { fileName: 'parent.zip', fileContent: new Blob(['parent']) },
    { fileName: 'child.zip', fileContent: new Blob(['child-b']) },
  ]

  assert.equal(nostalgistModule.runtimeRomKey(first), nostalgistModule.runtimeRomKey(first))
  assert.notEqual(nostalgistModule.runtimeRomKey(first), nostalgistModule.runtimeRomKey(second))
})

test('artifact generation tokens reject stale async results', () => {
  assert.equal(typeof nostalgistModule.createArtifactGenerationGuard, 'function')
  const guard = nostalgistModule.createArtifactGenerationGuard()
  const first = guard.begin()
  const second = guard.begin()

  assert.equal(guard.isCurrent(first), false)
  assert.equal(guard.isCurrent(second), true)
  guard.invalidate()
  assert.equal(guard.isCurrent(second), false)
})

test('a rejected emulator start is exited and a later boot prepares a fresh instance', async () => {
  const documentRef = fakeDocument()
  const navigatorRef = {}
  const startError = new Error('start failed')
  const prepared = []

  async function prepare({ element }) {
    const emulator = fakeEmulator(
      element,
      prepared.length === 0
        ? async () => { throw startError }
        : async () => {},
    )
    prepared.push(emulator)
    return emulator
  }

  const controls = emulatorModule.useEmulator({
    documentRef,
    navigatorRef,
    prepare,
    registerBeforeUnmount: () => {},
  })
  controls.wrapperRef.value = fakeWrapper()

  await assert.rejects(
    controls.boot({ core: 'fbneo', rom: 'game.zip' }),
    (error) => error === startError,
  )
  assert.equal(controls.instance.value, null)
  assert.equal(controls.canvas(), null)
  assert.equal(prepared[0].exitCalls, 1)

  const second = await controls.boot({ core: 'fbneo', rom: 'game.zip' })
  assert.equal(prepared.length, 2)
  assert.equal(second, prepared[1])
  assert.equal(controls.instance.value, prepared[1])

  await controls.destroy()
})

test('destroying during start prevents stale boot work after cleanup', async () => {
  const documentRef = fakeDocument()
  const startEntered = deferred()
  const startGate = deferred()
  let wakeLockRequests = 0
  let emulator
  const navigatorRef = {
    wakeLock: {
      async request() {
        wakeLockRequests += 1
        return { async release() {} }
      },
    },
  }

  async function prepare({ element }) {
    emulator = fakeEmulator(element, async () => {
      startEntered.resolve()
      await startGate.promise
    })
    return emulator
  }

  const controls = emulatorModule.useEmulator({
    documentRef,
    navigatorRef,
    prepare,
    registerBeforeUnmount: () => {},
  })
  controls.wrapperRef.value = fakeWrapper()

  const bootPromise = controls.boot({ core: 'fbneo', rom: 'game.zip' })
  await startEntered.promise
  await controls.destroy()
  startGate.resolve()

  assert.equal(await bootPromise, null)
  assert.equal(documentRef.canvases[0].focusCalls, 0)
  assert.equal(wakeLockRequests, 0)
  assert.equal(emulator.exitCalls, 1)
  assert.equal(controls.instance.value, null)
  assert.equal(controls.canvas(), null)
  assert.equal(controls.error.value, null)
  assert.equal(controls.booting.value, false)
})

test('a wake lock resolved after destroy is released and the stale boot is cancelled', async () => {
  const documentRef = fakeDocument()
  const wakeRequestEntered = deferred()
  const wakeRequestGate = deferred()
  let releaseCalls = 0
  let emulator
  const navigatorRef = {
    wakeLock: {
      async request() {
        wakeRequestEntered.resolve()
        return wakeRequestGate.promise
      },
    },
  }

  async function prepare({ element }) {
    emulator = fakeEmulator(element, async () => {})
    return emulator
  }

  const controls = emulatorModule.useEmulator({
    documentRef,
    navigatorRef,
    prepare,
    registerBeforeUnmount: () => {},
  })
  controls.wrapperRef.value = fakeWrapper()

  const bootPromise = controls.boot({ core: 'fbneo', rom: 'game.zip' })
  await wakeRequestEntered.promise
  await controls.destroy()
  wakeRequestGate.resolve({
    async release() { releaseCalls += 1 },
  })

  assert.equal(await bootPromise, null)
  assert.equal(releaseCalls, 1)
  assert.equal(emulator.exitCalls, 1)
  assert.equal(controls.instance.value, null)
  assert.equal(controls.canvas(), null)
  assert.equal(controls.booting.value, false)

  await controls.destroy()
  assert.equal(releaseCalls, 1)
})

test('input settings explain that remapped controls apply after re-entering the game', async () => {
  const source = await readFile(
    new URL('../src/components/InputSettings.vue', import.meta.url),
    'utf8',
  )

  assert.match(source, /键位保存在当前浏览器，重新进入游戏后生效。/)
})

test('mobile toolbar does not hide the keyboard settings button', async () => {
  const source = await readFile(
    new URL('../src/components/emulator-portal/GameOverlay.vue', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(
    source,
    /\.bar-btn-keys\s*\{\s*display\s*:\s*none\s*;?\s*\}/,
  )
})

test('player waits for user-specific input mapping before mounting the emulator', async () => {
  const source = await readFile(
    new URL('../src/views/Player.vue', import.meta.url),
    'utf8',
  )

  assert.match(source, /rom && biosReady && !authLoading/)
  assert.match(source, /watch\(authLoading,[\s\S]*buildPlayer2KeyMap\(mapping\.value\.keyboard\)/)
})

test('Player and EmulatorPortal wire generation and Blob identity guards into runtime switching', async () => {
  const [player, portal] = await Promise.all([
    readFile(new URL('../src/views/Player.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/emulator-portal/EmulatorPortal.vue', import.meta.url), 'utf8'),
  ])

  assert.match(player, /createArtifactGenerationGuard/)
  assert.match(player, /isCurrent\(/)
  assert.match(portal, /runtimeRomKey\(props\.rom\)/)
})

test('MyRoms can unpublish a public build even after compatibility regresses', async () => {
  const source = await readFile(new URL('../src/views/MyRoms.vue', import.meta.url), 'utf8')
  assert.match(source, /:disabled="rom\.compatStatus !== 'ready' && !rom\.isPublic"/)
  assert.match(source, /if \(rom\.isPublic\) return '设为私密'/)
})

test('room Player boots only the room locked build and disables version switching', async () => {
  const source = await readFile(new URL('../src/views/Player.vue', import.meta.url), 'utf8')

  assert.match(source, /api\.roomJoin\(roomCode, pw\)/)
  assert.match(source, /api\.romBuild\(room\.romBuildId\)/)
  assert.match(source, /activeBuild:\s*locked\?\.build/)
  assert.match(source, /v-if="!isRoomMode && siblings\.length > 1"/)
  assert.match(source, /if \(isRoomMode\) return/)
})

test('save state client and Player scope cloud and local saves to the immutable build', async () => {
  const [player, client] = await Promise.all([
    readFile(new URL('../src/views/Player.vue', import.meta.url), 'utf8'),
    readFile(new URL('../src/api/client.js', import.meta.url), 'utf8'),
  ])

  assert.match(client, /saveLoad:\s*async \(romId, buildId, slot = 0\)/)
  assert.match(client, /buildId=\$\{encodeURIComponent\(buildId\)\}/)
  assert.match(client, /saveUpload:\s*async \(romId, buildId, blob, slot = 0\)/)
  assert.match(player, /state:\$\{build\.id\}:\$\{build\.core\.artifactFingerprint\}:\$\{build\.contentManifestSha256\}/)
  assert.match(player, /function legacySaveKey\(\)[\s\S]*state:\$\{platformInfo\.value\.core\}:\$\{romMeta\.value\.id\}/)
  assert.match(player, /legacySaveDecisionKey/)
  assert.match(player, /window\.confirm/)
})
