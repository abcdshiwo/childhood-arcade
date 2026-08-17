import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TEST_PATH = '/__gallery_test__'
const THUMBNAIL_PATH = '/__gallery_thumbnail__/'
const CARD_COUNT = 620
const IMAGE_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
)

function galleryTestPage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body>
    <div id="app"></div>
    <script type="module">
      import { createApp, h } from 'vue'
      import Gallery from '/src/views/Gallery.vue'
      import '/src/assets/global.css'

      const RouterLink = {
        props: ['to'],
        setup(props, { slots }) {
          return () => h('a', { href: typeof props.to === 'string' ? props.to : '#' }, slots.default?.())
        },
      }
      createApp({ render: () => h(Gallery) })
        .component('RouterLink', RouterLink)
        .mount('#app')
    </script>
  </body>
</html>`
}

function browserHarnessPlugin(requestedThumbnails) {
  const virtualModules = new Map([
    ['test:router', `
      export function useRouter() {
        return { push(path) { window.__galleryRoute = path } }
      }
    `],
    ['test:auth', `
      import { ref } from 'vue'
      const isAuthed = ref(false)
      export function useAuth() { return { isAuthed } }
    `],
    ['test:settings', `
      import { ref } from 'vue'
      const settings = ref({ guestPlayEnabled: true })
      export function useSettings() { return { settings } }
    `],
    ['test:api', `
      const hash = 'a'.repeat(64)
      const kinds = ['official', 'hack', 'bootleg']
      const matches = ['exact', 'alias', 'parent', 'source_reference']
      const roms = Array.from({ length: ${CARD_COUNT} }, (_, index) => {
        const id = index + 1
        const matchKind = matches[index % matches.length]
        const clone = id % 5 === 0
        return {
          id,
          title: id % 10 === 0
            ? '超级街机收藏版 游戏 ' + id + ' 长标题测试'
            : '街机游戏 ' + id,
          platform: 'arcade',
          hardwareFamily: id % 2 === 0 ? 'Neo Geo MVS' : 'CPS-2',
          setName: 'bulk_' + id,
          setNameNormalized: 'bulk_' + id,
          variantKind: kinds[index % kinds.length],
          datParentSetName: clone ? 'bulk_' + (id - 1) : null,
          parentRomId: clone ? id - 1 : null,
          versionLabel: clone ? 'Clone ' + id : 'Revision ' + id,
          coreName: id % 2 === 0 ? 'mame2003_plus' : 'fbneo',
          coreVersion: id % 2 === 0 ? '62c7089' : '1.0.0.03',
          archiveLayout: clone ? 'split' : 'standalone',
          thumbnailUrl: '${THUMBNAIL_PATH}' + id + '?v=' + hash,
          thumbnailMatchKind: matchKind,
          thumbnailSourceSetName: matchKind === 'exact' ? 'bulk_' + id : 'source_' + id,
          isPublic: true,
          isFavorite: false,
        }
      })
      export const api = {
        romsPublic: async () => ({ roms }),
        romFavorite: async () => ({ ok: true }),
        romUnfavorite: async () => ({ ok: true }),
      }
    `],
  ])

  return {
    name: 'gallery-browser-harness',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'vue-router') return '\0test:router'
      if (source.endsWith('/api/client.js')) return '\0test:api'
      if (source.endsWith('/composables/useAuth.js')) return '\0test:auth'
      if (source.endsWith('/composables/useSettings.js')) return '\0test:settings'
      return null
    },
    load(id) {
      if (!id.startsWith('\0')) return null
      return virtualModules.get(id.slice(1)) || null
    },
    configureServer(viteServer) {
      viteServer.middlewares.use((request, response, next) => {
        const url = new URL(request.url || '/', 'http://localhost')
        if (url.pathname.startsWith(THUMBNAIL_PATH)) {
          requestedThumbnails.add(Number(url.pathname.slice(THUMBNAIL_PATH.length)))
          response.statusCode = 200
          response.setHeader('Content-Type', 'image/gif')
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          response.end(IMAGE_BYTES)
          return
        }
        if (url.pathname !== TEST_PATH) return next()
        viteServer.transformIndexHtml(request.url || TEST_PATH, galleryTestPage()).then((html) => {
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(html)
        }, next)
      })
    },
  }
}

async function startTestServer() {
  const requestedThumbnails = new Set()
  const cacheDir = mkdtempSync(join(tmpdir(), 'gallery-vite-cache-'))
  const server = await createServer({
    root: PROJECT_ROOT,
    cacheDir,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [browserHarnessPlugin(requestedThumbnails)],
  })
  await server.listen()
  return {
    server,
    requestedThumbnails,
    async close() {
      await server.close()
      rmSync(cacheDir, { recursive: true, force: true })
    },
  }
}

async function openGallery(page, server) {
  const diagnostics = []
  page.on('console', (message) => diagnostics.push(`console.${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.stack || error.message}`))
  const url = new URL(TEST_PATH, server.resolvedUrls.local[0]).href
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  try {
    await page.locator('.game-card').first().waitFor({ timeout: 8000 })
  } catch (error) {
    const body = await page.locator('body').innerHTML().catch(() => '<body unavailable>')
    throw new Error(`${error.message}\n${diagnostics.join('\n')}\nbody: ${body}`)
  }
}

function seconds(value) {
  const first = value.split(',')[0].trim()
  if (first.endsWith('ms')) return Number.parseFloat(first) / 1000
  return Number.parseFloat(first) || 0
}

test('desktop renders 620 dense cards with stable lazy 4:3 screenshot frames', async (t) => {
  const { server, requestedThumbnails, close } = await startTestServer()
  t.after(close)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await openGallery(page, server)

  const cards = page.locator('.game-card')
  assert.equal(await cards.count(), CARD_COUNT)
  const imageAttributes = await page.locator('.game-card img').evaluateAll((images) => (
    images.map((image) => ({ loading: image.loading, decoding: image.decoding }))
  ))
  assert.equal(imageAttributes.length, CARD_COUNT)
  assert.ok(imageAttributes.every(({ loading, decoding }) => loading === 'lazy' && decoding === 'async'))

  const layout = await page.locator('.game-card').evaluateAll((elements) => {
    const firstTwenty = elements.slice(0, 20)
    const columns = new Set(firstTwenty.map((element) => Math.round(element.getBoundingClientRect().left)))
    return {
      columns: columns.size,
      frames: firstTwenty.map((element) => {
        const frame = element.querySelector('.thumbnail-frame')
        const image = frame.querySelector('img')
        const bounds = frame.getBoundingClientRect()
        return {
          width: bounds.width,
          height: bounds.height,
          aspectRatio: getComputedStyle(frame).aspectRatio,
          objectFit: getComputedStyle(image).objectFit,
        }
      }),
    }
  })
  assert.ok(layout.columns >= 5, `expected a dense desktop grid, got ${layout.columns} columns`)
  for (const frame of layout.frames) {
    assert.equal(frame.aspectRatio, '4 / 3')
    assert.ok(Math.abs((frame.width / frame.height) - (4 / 3)) < 0.02)
    assert.equal(frame.objectFit, 'contain')
  }

  await page.waitForTimeout(250)
  assert.ok(requestedThumbnails.size > 0)
  assert.ok(
    requestedThumbnails.size < CARD_COUNT,
    `native lazy loading fetched all ${CARD_COUNT} thumbnails immediately`,
  )
  if (process.env.GALLERY_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.GALLERY_SCREENSHOT_PATH })
  }
})

test('keyboard focus is visible, activates direct play, and reduced motion is respected', async (t) => {
  const { server, close } = await startTestServer()
  t.after(close)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openGallery(page, server)

  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab')
    if (await page.evaluate(() => document.activeElement?.classList.contains('game-card'))) break
  }
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('game-card')), true)

  const focusStyle = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement)
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
      transitionDuration: style.transitionDuration,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
    }
  })
  assert.ok(
    focusStyle.outlineStyle !== 'none' || focusStyle.boxShadow !== 'none',
    'focused cards need a visible focus treatment',
  )
  assert.ok(focusStyle.outlineWidth !== '0px' || focusStyle.boxShadow !== 'none')
  assert.ok(seconds(focusStyle.transitionDuration) <= 0.001)
  assert.equal(focusStyle.scrollBehavior, 'auto')

  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => window.__galleryRoute), '/play/1')

  await page.locator('.game-card[data-rom-id="2"]').focus()
  await page.keyboard.press('Space')
  assert.equal(await page.evaluate(() => window.__galleryRoute), '/play/2')
})

test('browser search and variant filters operate across the full 620-card data set', async (t) => {
  const { server, close } = await startTestServer()
  t.after(close)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await openGallery(page, server)

  const search = page.locator('input[aria-label="搜索游戏"]')
  const assertSearchCount = async (term, count) => {
    await search.fill(term)
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.game-card').length === expected,
      count,
    )
    assert.equal(await page.locator('.game-card').count(), count, `search: ${term}`)
  }

  await assertSearchCount('bulk_620', 1)
  assert.equal(await page.locator('.game-card').getAttribute('data-rom-id'), '620')
  await assertSearchCount('超级街机收藏版', 62)
  await assertSearchCount('Revision 619', 1)
  await assertSearchCount('mame2003_plus', 310)
  await assertSearchCount('Neo Geo MVS', 310)
  await assertSearchCount('arcade', CARD_COUNT)
  await assertSearchCount('hack', 207)

  await search.fill('')
  await page.waitForFunction((count) => document.querySelectorAll('.game-card').length === count, CARD_COUNT)
  await page.locator('[data-testid="core-filter"]').selectOption('mame2003_plus')
  await page.waitForFunction(() => document.querySelectorAll('.game-card').length === 310)
  assert.equal(await page.locator('.game-card').count(), 310)
  await page.locator('[data-testid="core-filter"]').selectOption('all')
  await page.waitForFunction((count) => document.querySelectorAll('.game-card').length === count, CARD_COUNT)
  await page.locator('[data-testid="variant-filter"]').selectOption('hack')
  await page.waitForFunction(() => document.querySelectorAll('.game-card').length === 207)
  assert.equal(await page.locator('.game-card').count(), 207)

  await page.locator('[data-testid="variant-filter"]').selectOption('clone')
  await page.waitForFunction(() => document.querySelectorAll('.game-card').length === 124)
  assert.equal(await page.locator('.game-card').count(), 124)
})

test('320px layout has one contained column without horizontal overflow or overlap', async (t) => {
  const { server, close } = await startTestServer()
  t.after(close)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 320, height: 780 } })
  await openGallery(page, server)

  const layout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.game-card')].slice(0, 20)
    const first = cards[0].getBoundingClientRect()
    const second = cards[1].getBoundingClientRect()
    const contained = cards.every((card) => {
      const cardBounds = card.getBoundingClientRect()
      return [...card.querySelectorAll('.game-title, .game-metadata, .thumbnail-frame')].every((child) => {
        const bounds = child.getBoundingClientRect()
        return bounds.left >= cardBounds.left - 0.5 && bounds.right <= cardBounds.right + 0.5
      })
    })
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cardWidth: first.width,
      oneColumn: Math.abs(first.left - second.left) < 1 && second.top >= first.bottom,
      contained,
      searchWidth: document.querySelector('.search-box').getBoundingClientRect().width,
      filterWidths: [...document.querySelectorAll('.filter-control')]
        .map((element) => element.getBoundingClientRect().width),
    }
  })

  assert.equal(layout.clientWidth, 320)
  assert.equal(layout.scrollWidth, layout.clientWidth)
  assert.equal(layout.oneColumn, true)
  assert.equal(layout.contained, true)
  assert.ok(layout.cardWidth <= 296)
  assert.ok(layout.searchWidth <= 296)
  assert.ok(layout.filterWidths.every((width) => width <= 296))
  if (process.env.GALLERY_MOBILE_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.GALLERY_MOBILE_SCREENSHOT_PATH })
  }
})
