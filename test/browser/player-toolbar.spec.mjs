import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TEST_PATH = '/__player-toolbar_test__'
const CONTROL_PATH = '/__player-toolbar_control__'

function toolbarTestPage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body>
    <div id="app"></div>
    <script type="module">
      import { createApp, h } from 'vue'
      import GameOverlay from '/src/components/emulator-portal/GameOverlay.vue'
      import '/src/assets/global.css'
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
      createApp({
        render() {
          return h(GameOverlay, {
            title: '拳皇 97',
            platform: { label: '街机', color: '#d97706' },
            coreName: 'FBNeo',
            canSave: true,
            canUseArcadeControls: true,
            canToggleCrt: true,
            crtEnabled: true,
          })
        },
      }).mount('#app')
    </script>
  </body>
</html>`
}

function playerTestPage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body>
    <div id="app"></div>
    <script type="module">
      import { createApp, h } from 'vue'
      import Player from '/src/views/Player.vue'
      import '/src/assets/global.css'
      const params = new URLSearchParams(location.search)
      window.__testRole = params.get('role') || 'solo'
      window.__keyEvents = []
      for (const type of ['keydown', 'keyup']) {
        window.addEventListener(type, (event) => {
          if (event.target !== window) return
          window.__keyEvents.push({ target: 'window', type, key: event.key, code: event.code, at: performance.now() })
        })
        document.addEventListener(type, (event) => {
          if (event.target !== document) return
          window.__keyEvents.push({ target: 'document', type, key: event.key, code: event.code, at: performance.now() })
        })
      }
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true })
      window.__playerApp = createApp({ render: () => h(Player, { id: '7' }) }).mount('#app')
    </script>
  </body>
</html>`
}

function browserHarnessPlugin(controlMessages) {
  const virtualModules = new Map([
    ['test:router', `
      export function useRoute() {
        return { query: window.__testRole === 'solo' ? {} : { room: 'ROOM1' } }
      }
      export function useRouter() { return { push() {} } }
    `],
    ['test:api', `
      const build = {
        id: 41,
        contentManifestSha256: 'toolbar-test-manifest',
        archives: [{ fileName: 'game.zip', url: '/game.zip' }],
        core: {
          name: 'fbneo', version: '1.0.0', artifactFingerprint: 'toolbar-test-core',
          jsUrl: '/fbneo.js', wasmUrl: '/fbneo.wasm', bios: [],
        },
      }
      const rom = { id: 7, title: '拳皇 97', platform: 'arcade', activeBuild: build }
      export const api = {
        romsMine: async () => ({ roms: [rom] }),
        romsPublic: async () => ({ roms: [] }),
        romVersions: async () => ({ versions: [rom] }),
        roomJoin: async () => ({
          roomCode: 'ROOM1', romId: 7, romTitle: '拳皇 97', romPlatform: 'arcade',
          romSetName: 'kof97', romVersionLabel: null, romVariantKind: null,
          romBuildId: 41, coreName: 'fbneo', coreVersion: '1.0.0',
          coreArtifactFingerprint: 'toolbar-test-core', allowPlay: true,
        }),
        romBuild: async () => ({ build }),
        saveUpload: async () => ({}),
        saveLoad: async () => ({}),
      }
    `],
    ['test:auth', `
      import { ref } from 'vue'
      const user = ref(null)
      const isAuthed = ref(false)
      const loading = ref(false)
      export function useAuth() { return { user, isAuthed, loading } }
    `],
    ['test:nostalgist', `
      export function createArtifactGenerationGuard() {
        let generation = 0
        return {
          begin: () => ++generation,
          invalidate: () => { generation += 1 },
          isCurrent: (value) => value === generation,
        }
      }
      export async function resolveBuildArtifacts() {
        return { rom: [{ fileName: 'game.zip', fileContent: new Uint8Array([1]) }], bios: [] }
      }
    `],
    ['test:gamepads', `export function useGamepads() {}`],
    ['test:signal', `
      import { ref } from 'vue'
      export function useRoomSignal() {
        const handlers = new Map()
        const connected = ref(false)
        return {
          connected,
          on: (event, handler) => handlers.set(event, handler),
          connect() {
            connected.value = true
            queueMicrotask(() => handlers.get('welcome')?.({
              peerId: window.__testRole + '-peer',
              isHost: window.__testRole === 'host',
              peers: [],
              chat: [],
            }))
          },
          close() { connected.value = false },
          sendIce() {}, sendOffer() {}, sendAnswer() {}, sendChat() {},
        }
      }
    `],
    ['test:webrtc', `
      let sequence = 0
      export function useWebRTC(options) {
        let closed = false
        let pollTimer = null
        queueMicrotask(() => options.onStateChange?.('controls:open'))
        if (window.__testRole === 'host') {
          pollTimer = setInterval(async () => {
            if (closed) return
            const response = await fetch('${CONTROL_PATH}')
            for (const message of await response.json()) {
              options.onControlPulse?.(message, 'guest-peer')
            }
          }, 20)
        }
        return {
          async sendControlPulse(button) {
            const message = { type: 'control-pulse', id: 'browser-guest:' + (++sequence), button }
            await fetch('${CONTROL_PATH}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(message),
            })
            return true
          },
          sendData() {}, startCall() {}, closePeer() {},
          async handleOffer() {}, async handleAnswer() {}, async handleIce() {},
          close() {
            closed = true
            if (pollTimer) clearInterval(pollTimer)
          },
        }
      }
    `],
    ['test:emulator-portal', `
      import { defineComponent, h, onMounted } from 'vue'
      export default defineComponent({
        name: 'ToolbarTestEmulatorPortal',
        emits: ['booted', 'error'],
        setup(_props, { emit, expose }) {
          const canvas = document.createElement('canvas')
          expose({
            canvas,
            saveState: async () => null,
            loadState: async () => null,
            captureAudioStream: () => null,
          })
          onMounted(() => emit('booted'))
          return () => h('div', { class: 'toolbar-test-emulator' })
        },
      })
    `],
    ['test:empty-component', `export default { render() { return null } }`],
  ])

  return {
    name: 'player-toolbar-browser-harness',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'vue-router') return '\0test:router'
      if (source.endsWith('/api/client.js')) return '\0test:api'
      if (source.endsWith('/composables/useAuth.js') || source === './useAuth.js') return '\0test:auth'
      if (source.endsWith('/composables/nostalgist.js')) return '\0test:nostalgist'
      if (source.endsWith('/composables/useGamepads.js')) return '\0test:gamepads'
      if (source.endsWith('/composables/useRoomSignal.js')) return '\0test:signal'
      if (source.endsWith('/composables/useWebRTC.js')) return '\0test:webrtc'
      if (source.endsWith('/components/emulator-portal/EmulatorPortal.vue')) return '\0test:emulator-portal'
      if (
        source.endsWith('/components/emulator-portal/VirtualGamepad.vue')
        || source.endsWith('/components/emulator-portal/RoomPanel.vue')
        || source.endsWith('/components/InputSettings.vue')
      ) return '\0test:empty-component'
      return null
    },
    load(id) {
      if (!id.startsWith('\0')) return null
      return virtualModules.get(id.slice(1)) || null
    },
    configureServer(viteServer) {
      viteServer.middlewares.use((request, response, next) => {
        const url = new URL(request.url || '/', 'http://localhost')
        if (url.pathname === CONTROL_PATH) {
          response.setHeader('Content-Type', 'application/json')
          if (request.method === 'POST') {
            let body = ''
            request.on('data', (chunk) => { body += chunk })
            request.on('end', () => {
              controlMessages.push(JSON.parse(body))
              response.end('{}')
            })
            return
          }
          response.end(JSON.stringify(controlMessages.splice(0)))
          return
        }
        if (url.pathname !== TEST_PATH) return next()
        const html = url.searchParams.get('view') === 'player' ? playerTestPage() : toolbarTestPage()
        viteServer.transformIndexHtml(request.url || TEST_PATH, html).then((transformed) => {
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(transformed)
        }, next)
      })
    },
  }
}

async function startTestServer() {
  const controlMessages = []
  const server = await createServer({
    root: PROJECT_ROOT,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [browserHarnessPlugin(controlMessages)],
  })
  await server.listen()
  return server
}

async function openPlayer(page, server, role) {
  const testUrl = new URL(`${TEST_PATH}?view=player&role=${role}`, server.resolvedUrls.local[0]).href
  await page.goto(testUrl, { waitUntil: 'domcontentloaded' })
  await waitForVisible(page, '[data-testid="coin-button"]:not([disabled])')
}

async function waitForVisible(page, selector) {
  const diagnostics = []
  page.on('console', (message) => diagnostics.push(`console.${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.stack || error.message}`))
  try {
    await page.locator(selector).waitFor({ timeout: 5000 })
  } catch (error) {
    const body = await page.locator('body').innerHTML().catch(() => '<body unavailable>')
    throw new Error(`${error.message}\n${diagnostics.join('\n')}\nbody: ${body}`)
  }
}

async function pulseEvents(page, code) {
  await page.waitForFunction((expectedCode) => (
    window.__keyEvents.filter((event) => event.code === expectedCode).length >= 4
  ), code, { timeout: 5000 })
  return page.evaluate((expectedCode) => (
    window.__keyEvents.filter((event) => event.code === expectedCode)
  ), code)
}

function assertPulse(events, { key, code }) {
  assert.deepEqual(events.map(({ target, type, key: eventKey, code: eventCode }) => ({
    target, type, key: eventKey, code: eventCode,
  })), [
    { target: 'window', type: 'keydown', key, code },
    { target: 'document', type: 'keydown', key, code },
    { target: 'window', type: 'keyup', key, code },
    { target: 'document', type: 'keyup', key, code },
  ])
  const windowEvents = events.filter(({ target }) => target === 'window')
  const documentEvents = events.filter(({ target }) => target === 'document')
  assert.ok(windowEvents[1].at - windowEvents[0].at >= 140, 'window pulse released too early')
  assert.ok(documentEvents[1].at - documentEvents[0].at >= 140, 'document pulse released too early')
}

test('320px arcade toolbar keeps all eight controls inside its rendered bounds', async (t) => {
  const server = await startTestServer()
  t.after(() => server.close())
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } })

  const testUrl = new URL(TEST_PATH, server.resolvedUrls.local[0]).href
  await page.goto(testUrl, { waitUntil: 'domcontentloaded' })
  const toolbar = page.locator('.player-bar')
  await waitForVisible(page, '.player-bar')

  const labels = await toolbar.locator('button').evaluateAll((buttons) => (
    buttons.map((button) => button.getAttribute('aria-label'))
  ))
  assert.deepEqual(labels, ['返回', '投币', '开始', 'CRT 滤镜', '存档', '读档', '按键设置', '全屏'])

  const layout = await toolbar.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: bounds.left,
      right: bounds.right,
      controls: [...element.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect()
        return { label: button.getAttribute('aria-label'), left: rect.left, right: rect.right }
      }),
    }
  })

  assert.equal(layout.clientWidth, 320)
  assert.equal(layout.scrollWidth, layout.clientWidth)
  for (const control of layout.controls) {
    assert.ok(control.left >= layout.left, `${control.label} starts outside the toolbar`)
    assert.ok(control.right <= layout.right, `${control.label} ends outside the toolbar`)
  }
})

test('real Chromium solo toolbar dispatches boot-frozen 150ms coin and start pulses globally', async (t) => {
  const server = await startTestServer()
  t.after(() => server.close())
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } })
  await openPlayer(page, server, 'solo')

  await page.locator('[data-testid="coin-button"]').click()
  assertPulse(await pulseEvents(page, 'Digit1'), { key: '1', code: 'Digit1' })

  await page.evaluate(() => { window.__keyEvents.length = 0 })
  await page.locator('[data-testid="start-button"]').click()
  assertPulse(await pulseEvents(page, 'Enter'), { key: 'Enter', code: 'Enter' })
})

test('real Chromium guest toolbar sends P2 pulses to a separate host context only', async (t) => {
  const server = await startTestServer()
  t.after(() => server.close())
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const hostContext = await browser.newContext({ viewport: { width: 1024, height: 720 } })
  const guestContext = await browser.newContext({ viewport: { width: 1024, height: 720 } })
  t.after(() => Promise.all([hostContext.close(), guestContext.close()]))
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  await Promise.all([
    openPlayer(host, server, 'host'),
    openPlayer(guest, server, 'guest'),
  ])

  await guest.locator('[data-testid="coin-button"]').click()
  assertPulse(await pulseEvents(host, 'NumpadDivide'), { key: '/', code: 'NumpadDivide' })
  assert.deepEqual(await guest.evaluate(() => window.__keyEvents), [])

  await host.evaluate(() => { window.__keyEvents.length = 0 })
  await guest.locator('[data-testid="start-button"]').click()
  assertPulse(await pulseEvents(host, 'NumpadMultiply'), { key: '*', code: 'NumpadMultiply' })
  assert.deepEqual(await guest.evaluate(() => window.__keyEvents), [])
})
