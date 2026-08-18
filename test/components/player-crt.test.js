import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const storedValues = new Map()
  const storage = {
    get length() { return storedValues.size },
    clear: () => storedValues.clear(),
    getItem: (key) => storedValues.get(String(key)) ?? null,
    key: (index) => [...storedValues.keys()][index] ?? null,
    removeItem: (key) => storedValues.delete(String(key)),
    setItem: (key, value) => storedValues.set(String(key), String(value)),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  Object.defineProperty(document, 'fullscreenEnabled', {
    configurable: true,
    value: true,
  })

  return {
    api: {
      romsMine: vi.fn(),
      romsPublic: vi.fn(),
      romVersions: vi.fn(),
      roomJoin: vi.fn(),
      romBuild: vi.fn(),
      saveUpload: vi.fn(),
      saveLoad: vi.fn(),
    },
    auth: null,
    input: null,
    route: { query: {} },
    routerPush: vi.fn(),
    resolveBuildArtifacts: vi.fn(),
    emulatorInstances: [],
    signal: null,
    rtc: null,
    rtcOptions: null,
    storage,
  }
})

vi.mock('vue-router', () => ({
  useRoute: () => harness.route,
  useRouter: () => ({ push: harness.routerPush }),
}))

vi.mock('../../src/api/client.js', () => ({ api: harness.api }))

vi.mock('../../src/composables/useAuth.js', () => ({
  useAuth: () => harness.auth,
}))

vi.mock('../../src/composables/useInputMapping.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useInputMapping: () => harness.input,
}))

vi.mock('../../src/composables/nostalgist.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveBuildArtifacts: (...args) => harness.resolveBuildArtifacts(...args),
}))

vi.mock('../../src/composables/useGamepads.js', () => ({
  useGamepads: vi.fn(),
}))

vi.mock('../../src/composables/useRoomSignal.js', () => ({
  useRoomSignal: () => harness.signal,
}))

vi.mock('../../src/composables/useWebRTC.js', () => ({
  useWebRTC: (options) => {
    harness.rtcOptions = options
    return harness.rtc
  },
}))

vi.mock('../../src/composables/useEmulator.js', async () => {
  const { ref: vueRef } = await import('vue')

  return {
    useEmulator: () => {
      const wrapperRef = vueRef(null)
      const controls = {
        wrapperRef,
        boot: vi.fn(async () => {
          const canvas = document.createElement('canvas')
          canvas.className = 'portal-canvas'
          wrapperRef.value?.append(canvas)
        }),
        destroy: vi.fn(async () => {}),
        saveState: vi.fn(),
        loadState: vi.fn(),
        captureAudioStream: vi.fn(() => null),
        toggleFullscreen: vi.fn(),
        canvas: () => wrapperRef.value?.querySelector('.portal-canvas') || null,
      }
      harness.emulatorInstances.push(controls)
      return controls
    },
  }
})

import EmulatorPortal from '../../src/components/emulator-portal/EmulatorPortal.vue'
import Player from '../../src/views/Player.vue'

const CRT_STORAGE_KEY = 'player:crt:arcade'
const wrappers = []

function makeBuild(coreName) {
  return {
    id: 41,
    contentManifestSha256: 'manifest-sha256',
    archives: [{ fileName: 'game.zip', url: '/rom/game.zip' }],
    core: {
      name: coreName,
      version: '1.0.0',
      artifactFingerprint: `${coreName}-fingerprint`,
      jsUrl: `/cores/${coreName}.js`,
      wasmUrl: `/cores/${coreName}.wasm`,
      bios: [],
    },
  }
}

function makeRom(platform = 'arcade') {
  const coreName = platform === 'arcade' ? 'fbneo' : 'fceumm'
  return {
    id: 7,
    title: platform === 'arcade' ? '拳皇 97' : '超级马里奥',
    platform,
    parentRomId: null,
    versionLabel: null,
    activeBuild: makeBuild(coreName),
  }
}

function configureLocalRom(platform = 'arcade') {
  const rom = makeRom(platform)
  harness.api.romsMine.mockResolvedValue({ roms: [rom] })
  harness.api.romsPublic.mockResolvedValue({ roms: [] })
  harness.api.romVersions.mockResolvedValue({ versions: [rom] })
  harness.resolveBuildArtifacts.mockResolvedValue({
    rom: [{ fileName: 'game.zip', fileContent: new Uint8Array([1, 2, 3]) }],
    bios: [],
  })
}

function configureGuestRoom() {
  harness.route.query = { room: 'CRT1' }
  harness.api.roomJoin.mockResolvedValue({
    roomCode: 'CRT1',
    romId: 7,
    romTitle: '拳皇 97',
    romPlatform: 'arcade',
    romSetName: 'kof97',
    romVersionLabel: null,
    romVariantKind: null,
    romBuildId: 41,
    coreName: 'fbneo',
    coreVersion: '1.0.0',
    coreArtifactFingerprint: 'fbneo-fingerprint',
    allowPlay: true,
  })
  harness.api.romBuild.mockRejectedValue(new Error('guest does not download ROM data'))
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function createSignal(isHost = false) {
  const handlers = new Map()
  const connected = ref(false)
  return {
    connected,
    emit: (event, payload) => handlers.get(event)?.(payload),
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    connect: vi.fn(() => {
      connected.value = true
      queueMicrotask(() => {
        handlers.get('welcome')?.({
          peerId: isHost ? 'host-1' : 'guest-1',
          isHost,
          peers: [],
          chat: [],
        })
      })
    }),
    sendChat: vi.fn(),
    close: vi.fn(),
  }
}

function createRtc() {
  return {
    sendData: vi.fn(),
    sendControlPulse: vi.fn(async () => true),
    startCall: vi.fn(),
    closePeer: vi.fn(),
    close: vi.fn(),
    handleOffer: vi.fn(async () => {}),
    handleAnswer: vi.fn(async () => {}),
    handleIce: vi.fn(async () => {}),
  }
}

function mountPlayer() {
  const wrapper = mount(Player, {
    props: { id: '7' },
    global: {
      stubs: {
        VirtualGamepad: true,
        RoomPanel: true,
        InputSettings: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

async function settlePlayer() {
  for (let pass = 0; pass < 4; pass += 1) {
    await flushPromises()
    await nextTick()
  }
}

function uniqueDispatchedEvents(dispatchSpy, code) {
  return [...new Set(dispatchSpy.mock.calls.map(([event]) => event))]
    .filter((event) => !code || event.code === code)
}

beforeEach(() => {
  harness.storage.clear()
  harness.route.query = {}
  harness.routerPush.mockReset()
  harness.resolveBuildArtifacts.mockReset()
  harness.emulatorInstances.length = 0
  for (const method of Object.values(harness.api)) method.mockReset()
  harness.auth = { isAuthed: ref(false), loading: ref(false) }
  harness.input = {
    retroarchConfig: ref({}),
    mapping: ref({ keyboard: {}, gamepad: {} }),
  }
  harness.signal = createSignal()
  harness.rtc = createRtc()
  harness.rtcOptions = null
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Player arcade CRT behavior', () => {
  test('shows the catalog Chinese title and exact English title in the player toolbar', async () => {
    const rom = makeRom()
    rom.title = "The King of Fighters '97 (NGM-2320)"
    rom.coreName = 'fbneo'
    rom.setName = 'kof97'
    rom.setNameNormalized = 'kof97'
    harness.api.romsMine.mockResolvedValue({ roms: [rom] })
    harness.api.romsPublic.mockResolvedValue({ roms: [] })
    harness.api.romVersions.mockResolvedValue({ versions: [rom] })
    harness.resolveBuildArtifacts.mockResolvedValue({
      rom: [{ fileName: 'game.zip', fileContent: new Uint8Array([1, 2, 3]) }],
      bios: [],
    })

    const wrapper = mountPlayer()
    await settlePlayer()

    expect(wrapper.get('.bar-title').text()).toBe('拳皇 97（NGM-2320）')
    expect(wrapper.get('.bar-title-en').text()).toBe("The King of Fighters '97 (NGM-2320)")
  })

  test('keeps the toolbar mounted while metadata is loading and after a load error', async () => {
    const mine = deferred()
    harness.api.romsMine.mockReturnValue(mine.promise)
    harness.api.romsPublic.mockResolvedValue({ roms: [] })
    const wrapper = mountPlayer()

    expect(wrapper.get('.player-bar').exists()).toBe(true)
    expect(wrapper.get('.emu-loading').exists()).toBe(true)

    mine.resolve({ roms: [] })
    await settlePlayer()

    expect(wrapper.get('.player-bar').exists()).toBe(true)
    expect(wrapper.get('.emu-error').exists()).toBe(true)
  })

  test('disables arcade controls during core load and guest reconnect without unmounting the toolbar', async () => {
    const runtime = deferred()
    configureLocalRom()
    harness.resolveBuildArtifacts.mockReturnValue(runtime.promise)
    const local = mountPlayer()
    await settlePlayer()

    expect(local.get('.player-bar').exists()).toBe(true)
    expect(local.get('[data-testid="coin-button"]').attributes('disabled')).toBeDefined()
    runtime.resolve({
      rom: [{ fileName: 'game.zip', fileContent: new Uint8Array([1, 2, 3]) }],
      bios: [],
    })
    await settlePlayer()
    expect(local.get('[data-testid="coin-button"]').attributes('disabled')).toBeUndefined()
    local.unmount()

    configureGuestRoom()
    const guest = mountPlayer()
    await settlePlayer()
    const coin = guest.get('[data-testid="coin-button"]')
    expect(coin.attributes('disabled')).toBeDefined()

    harness.rtcOptions.onStateChange('controls:open')
    await nextTick()
    expect(coin.attributes('disabled')).toBeUndefined()

    harness.rtcOptions.onStateChange('controls:close')
    await nextTick()
    expect(guest.get('.player-bar').exists()).toBe(true)
    expect(coin.attributes('disabled')).toBeDefined()
  })

  test('fullscreen targets the player container so the mounted toolbar is included', async () => {
    configureLocalRom()
    const wrapper = mountPlayer()
    await settlePlayer()
    const requestFullscreen = vi.fn(async () => {})
    wrapper.element.requestFullscreen = requestFullscreen

    await wrapper.get('[aria-label="全屏"]').trigger('click')

    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.player-bar').exists()).toBe(true)
    expect(harness.emulatorInstances[0].toggleFullscreen).not.toHaveBeenCalled()
  })

  test('top-bar controls hold the boot-frozen P1 mapping for 150ms on window and document', async () => {
    vi.useFakeTimers()
    configureLocalRom()
    harness.input.mapping.value.keyboard = { select: 'num1', start: 'enter' }
    const wrapper = mountPlayer()
    await settlePlayer()
    harness.input.mapping.value.keyboard = { select: 'num2', start: 'space' }
    const windowDispatch = vi.spyOn(window, 'dispatchEvent')
    const documentDispatch = vi.spyOn(document, 'dispatchEvent')

    await wrapper.get('[data-testid="coin-button"]').trigger('click')
    await wrapper.get('[data-testid="coin-button"]').trigger('click')

    expect(windowDispatch).toHaveBeenCalledTimes(1)
    expect(uniqueDispatchedEvents(documentDispatch, 'Digit1')).toHaveLength(1)
    expect(windowDispatch.mock.calls[0][0]).toMatchObject({ type: 'keydown', key: '1', code: 'Digit1' })
    expect(uniqueDispatchedEvents(documentDispatch, 'Digit1')[0]).toMatchObject({ type: 'keydown', key: '1', code: 'Digit1' })

    await vi.advanceTimersByTimeAsync(149)
    expect(windowDispatch).toHaveBeenCalledTimes(1)
    expect(uniqueDispatchedEvents(documentDispatch, 'Digit1')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(windowDispatch).toHaveBeenCalledTimes(2)
    expect(uniqueDispatchedEvents(documentDispatch, 'Digit1')).toHaveLength(2)
    expect(windowDispatch.mock.calls[1][0]).toMatchObject({ type: 'keyup', key: '1', code: 'Digit1' })
    expect(uniqueDispatchedEvents(documentDispatch, 'Digit1')[1]).toMatchObject({ type: 'keyup', key: '1', code: 'Digit1' })
  })

  test('unmount releases an in-flight local pulse exactly once', async () => {
    vi.useFakeTimers()
    configureLocalRom()
    harness.input.mapping.value.keyboard = { select: 'num1', start: 'enter' }
    const wrapper = mountPlayer()
    await settlePlayer()
    const documentDispatch = vi.spyOn(document, 'dispatchEvent')
    const expectedEvents = () => uniqueDispatchedEvents(documentDispatch, 'Enter')

    await wrapper.get('[data-testid="start-button"]').trigger('click')
    expect(expectedEvents().map((event) => event.type)).toEqual(['keydown'])
    wrapper.unmount()
    expect(expectedEvents().map((event) => event.type)).toEqual(['keydown', 'keyup'])

    await vi.advanceTimersByTimeAsync(200)
    expect(expectedEvents().map((event) => event.type)).toEqual(['keydown', 'keyup'])
  })

  test('guest toolbar pulses use only the reliable controls channel', async () => {
    configureGuestRoom()
    const wrapper = mountPlayer()
    await settlePlayer()
    harness.rtcOptions.onStateChange('controls:open')
    await nextTick()
    const windowDispatch = vi.spyOn(window, 'dispatchEvent')
    const documentDispatch = vi.spyOn(document, 'dispatchEvent')

    await wrapper.get('[data-testid="coin-button"]').trigger('click')
    await flushPromises()

    expect(harness.rtc.sendControlPulse).toHaveBeenCalledWith('select')
    expect(harness.rtc.sendData).not.toHaveBeenCalled()
    expect(windowDispatch).not.toHaveBeenCalled()
    expect(documentDispatch).not.toHaveBeenCalled()
  })

  test('host executes a guest pulse once with its boot-frozen P2 mapping for 150ms', async () => {
    vi.useFakeTimers()
    configureGuestRoom()
    const build = makeBuild('fbneo')
    harness.api.romBuild.mockResolvedValue({ build })
    harness.resolveBuildArtifacts.mockResolvedValue({
      rom: [{ fileName: 'game.zip', fileContent: new Uint8Array([1, 2, 3]) }],
      bios: [],
    })
    harness.signal = createSignal(true)
    harness.input.mapping.value.keyboard = { select: 'num1', start: 'enter' }
    mountPlayer()
    await settlePlayer()
    harness.input.mapping.value.keyboard = { select: 'num2', start: 'space' }
    const documentDispatch = vi.spyOn(document, 'dispatchEvent')

    harness.rtcOptions.onControlPulse({ type: 'control-pulse', id: 'guest:1', button: 'select' }, 'guest-1')
    expect(uniqueDispatchedEvents(documentDispatch, 'NumpadDivide')[0]).toMatchObject({ type: 'keydown', key: '/', code: 'NumpadDivide' })
    await vi.advanceTimersByTimeAsync(149)
    expect(uniqueDispatchedEvents(documentDispatch, 'NumpadDivide')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(uniqueDispatchedEvents(documentDispatch, 'NumpadDivide')[1]).toMatchObject({ type: 'keyup', key: '/', code: 'NumpadDivide' })
  })

  test('host releases an in-flight P2 pulse when the controls channel disconnects', async () => {
    vi.useFakeTimers()
    configureGuestRoom()
    const build = makeBuild('fbneo')
    harness.api.romBuild.mockResolvedValue({ build })
    harness.resolveBuildArtifacts.mockResolvedValue({
      rom: [{ fileName: 'game.zip', fileContent: new Uint8Array([1, 2, 3]) }],
      bios: [],
    })
    harness.signal = createSignal(true)
    harness.input.mapping.value.keyboard = { select: 'num1', start: 'enter' }
    mountPlayer()
    await settlePlayer()
    const documentDispatch = vi.spyOn(document, 'dispatchEvent')

    harness.rtcOptions.onControlPulse({ type: 'control-pulse', id: 'guest:2', button: 'start' }, 'guest-1')
    expect(uniqueDispatchedEvents(documentDispatch, 'NumpadMultiply')[0]).toMatchObject({ type: 'keydown', key: '*', code: 'NumpadMultiply' })

    harness.rtcOptions.onStateChange('controls:close')
    expect(uniqueDispatchedEvents(documentDispatch, 'NumpadMultiply')[1]).toMatchObject({ type: 'keyup', key: '*', code: 'NumpadMultiply' })
    await vi.advanceTimersByTimeAsync(200)
    expect(uniqueDispatchedEvents(documentDispatch, 'NumpadMultiply')).toHaveLength(2)
  })

  test('defaults off and toggles the local canvas without remounting or rebooting EmulatorPortal', async () => {
    configureLocalRom()
    const wrapper = mountPlayer()
    await settlePlayer()

    const button = wrapper.get('[data-testid="crt-toggle"]')
    const portalBefore = wrapper.getComponent(EmulatorPortal)
    const portalElement = portalBefore.element
    const emulator = harness.emulatorInstances[0]

    expect(button.attributes('aria-pressed')).toBe('false')
    expect(portalBefore.classes()).not.toContain('crt-enabled')
    expect(localStorage.getItem(CRT_STORAGE_KEY)).toBeNull()
    expect(emulator.boot).toHaveBeenCalledTimes(1)

    await button.trigger('click')
    await nextTick()

    const portalAfter = wrapper.getComponent(EmulatorPortal)
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(portalAfter.classes()).toContain('crt-enabled')
    expect(localStorage.getItem(CRT_STORAGE_KEY)).toBe('1')
    expect(portalAfter.element).toBe(portalElement)
    expect(harness.emulatorInstances).toHaveLength(1)
    expect(emulator.boot).toHaveBeenCalledTimes(1)
    expect(emulator.destroy).not.toHaveBeenCalled()
  })

  test('restores the saved arcade preference before presenting the player controls', async () => {
    localStorage.setItem(CRT_STORAGE_KEY, '1')
    configureLocalRom()
    const wrapper = mountPlayer()
    await settlePlayer()

    expect(wrapper.get('[data-testid="crt-toggle"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.getComponent(EmulatorPortal).classes()).toContain('crt-enabled')
  })

  test('keeps the CRT control and display class out of non-arcade gameplay', async () => {
    localStorage.setItem(CRT_STORAGE_KEY, '1')
    configureLocalRom('nes')
    const wrapper = mountPlayer()
    await settlePlayer()

    expect(wrapper.find('[data-testid="crt-toggle"]').exists()).toBe(false)
    expect(wrapper.getComponent(EmulatorPortal).classes()).not.toContain('crt-enabled')
  })

  test('toggles the guest video presentation locally without sending a room message', async () => {
    configureGuestRoom()
    const wrapper = mountPlayer()
    await settlePlayer()

    const button = wrapper.get('[data-testid="crt-toggle"]')
    expect(wrapper.get('.remote-video').exists()).toBe(true)
    expect(wrapper.get('.guest-view').classes()).not.toContain('crt-enabled')

    await button.trigger('click')
    await nextTick()

    expect(wrapper.get('.guest-view').classes()).toContain('crt-enabled')
    expect(localStorage.getItem(CRT_STORAGE_KEY)).toBe('1')
    expect(harness.rtc.sendData).not.toHaveBeenCalled()
  })

  test('keeps a fast guest stream covered until delayed arcade metadata restores the saved filter', async () => {
    localStorage.setItem(CRT_STORAGE_KEY, '1')
    const joined = deferred()
    configureGuestRoom()
    harness.api.roomJoin.mockReturnValue(joined.promise)
    const wrapper = mountPlayer()
    await settlePlayer()

    const video = wrapper.get('.remote-video')
    await video.trigger('playing')
    await nextTick()

    expect(wrapper.find('.guest-waiting').exists()).toBe(true)
    expect(video.classes()).not.toContain('stream-visible')

    joined.resolve({
      roomCode: 'CRT1',
      romId: 7,
      romTitle: '拳皇 97',
      romPlatform: 'arcade',
      romSetName: 'kof97',
      romVersionLabel: null,
      romVariantKind: null,
      romBuildId: 41,
      coreName: 'fbneo',
      coreVersion: '1.0.0',
      coreArtifactFingerprint: 'fbneo-fingerprint',
      allowPlay: true,
    })
    await settlePlayer()

    expect(wrapper.get('.guest-view').classes()).toContain('crt-enabled')
    expect(video.classes()).toContain('stream-visible')
    expect(wrapper.find('.guest-waiting').exists()).toBe(false)
  })
})
