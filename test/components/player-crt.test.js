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
  useWebRTC: () => harness.rtc,
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

function createSignal() {
  const handlers = new Map()
  const connected = ref(false)
  return {
    connected,
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    connect: vi.fn(() => {
      connected.value = true
      queueMicrotask(() => {
        handlers.get('welcome')?.({
          peerId: 'guest-1',
          isHost: false,
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
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
})

describe('Player arcade CRT behavior', () => {
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
})
