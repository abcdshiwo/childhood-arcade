import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  api: {
    romsPublic: vi.fn(),
    romFavorite: vi.fn(),
    romUnfavorite: vi.fn(),
  },
  auth: null,
  route: null,
  routerPush: vi.fn(),
  settings: null,
}))

vi.mock('vue-router', () => ({
  useRoute: () => harness.route,
  useRouter: () => ({ push: harness.routerPush }),
}))

vi.mock('../../src/api/client.js', () => ({ api: harness.api }))

vi.mock('../../src/composables/useAuth.js', () => ({
  useAuth: () => harness.auth,
}))

vi.mock('../../src/composables/useSettings.js', () => ({
  useSettings: () => ({ settings: harness.settings }),
}))

vi.mock('../../src/components/AppHeader.vue', () => ({
  default: { template: '<header class="app-header-stub" />' },
}))

import Gallery from '../../src/views/Gallery.vue'
import App from '../../src/App.vue'

const wrappers = []
const HASH = 'a'.repeat(64)

function makeRom(overrides = {}) {
  const id = overrides.id ?? 1
  const setName = overrides.setName ?? `set_${id}`
  return {
    id,
    title: `游戏 ${id}`,
    platform: 'arcade',
    hardwareFamily: null,
    setName,
    setNameNormalized: setName,
    variantKind: 'official',
    datParentSetName: null,
    parentRomId: null,
    versionLabel: 'Original',
    coreName: 'fbneo',
    coreVersion: '1.0.0',
    archiveLayout: 'standalone',
    thumbnailUrl: `/api/roms/${id}/thumbnail?v=${HASH}`,
    thumbnailMatchKind: 'exact',
    thumbnailSourceSetName: setName,
    isPublic: true,
    isFavorite: false,
    versionCount: 0,
    ...overrides,
  }
}

function galleryRows() {
  return [
    makeRom({
      id: 1,
      title: '拳皇 97',
      setName: 'kof97',
      hardwareFamily: 'Neo Geo MVS',
      versionLabel: 'Original',
      thumbnailMatchKind: 'exact',
      thumbnailSourceSetName: 'kof97',
    }),
    makeRom({
      id: 2,
      title: '合金弹头 Plus',
      setName: 'mslugps',
      hardwareFamily: 'Neo Geo MVS',
      variantKind: 'hack',
      versionLabel: 'Plus Edition',
      coreName: 'mame2003_plus',
      coreVersion: '62c7089',
      thumbnailMatchKind: 'alias',
      thumbnailSourceSetName: 'mslug',
      versionCount: 3,
    }),
    makeRom({
      id: 3,
      title: '街头霸王 II Bootleg',
      setName: 'sf2boot',
      variantKind: 'bootleg',
      versionLabel: 'Bootleg B',
      parentRomId: 1,
      datParentSetName: 'sf2',
      archiveLayout: 'split',
      thumbnailMatchKind: 'parent',
      thumbnailSourceSetName: 'sf2',
    }),
    makeRom({
      id: 4,
      title: '三国战纪 参考版',
      setName: 'kovref',
      variantKind: 'official',
      versionLabel: 'World',
      thumbnailMatchKind: 'source_reference',
      thumbnailSourceSetName: 'kov',
    }),
    makeRom({
      id: 5,
      title: '无截图游戏',
      setName: 'noimage',
      variantKind: null,
      versionLabel: null,
      thumbnailUrl: null,
      thumbnailMatchKind: null,
      thumbnailSourceSetName: null,
    }),
  ]
}

async function mountGallery(rows = galleryRows(), { authed = true, guestPlayEnabled = true } = {}) {
  harness.auth = { isAuthed: ref(authed) }
  harness.settings = ref({ guestPlayEnabled })
  harness.api.romsPublic.mockResolvedValue({ roms: rows })
  const wrapper = mount(Gallery, {
    global: {
      stubs: { RouterLink: RouterLinkStub },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function card(wrapper, id) {
  return wrapper.get(`[data-rom-id="${id}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.route = reactive({ name: 'Gallery', meta: {} })
  harness.api.romFavorite.mockResolvedValue({ ok: true })
  harness.api.romUnfavorite.mockResolvedValue({ ok: true })
})

afterEach(() => {
  while (wrappers.length) wrappers.pop().unmount()
})

describe('CRT gallery', () => {
  test('scopes the arcade shell theme to the Gallery route', async () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          AppHeader: true,
          RouterView: true,
        },
      },
    })
    wrappers.push(wrapper)

    expect(wrapper.get('.app-shell').classes()).toContain('app-shell--gallery')
    harness.route.name = 'Rooms'
    await nextTick()
    expect(wrapper.get('.app-shell').classes()).not.toContain('app-shell--gallery')
  })

  test('renders every API variant as an independently playable metadata card', async () => {
    const wrapper = await mountGallery()

    expect(wrapper.findAll('.game-card')).toHaveLength(5)
    const hack = card(wrapper, 2)
    expect(hack.get('.game-title').text()).toBe('合金弹头 Plus')
    expect(hack.get('.game-set').text()).toContain('mslugps')
    expect(hack.get('.game-version').text()).toContain('Plus Edition')
    expect(hack.get('.game-core').text()).toContain('mame2003_plus')
    expect(hack.get('.game-core').text()).toContain('62c7089')
    expect(hack.get('.game-hardware').text()).toContain('Neo Geo MVS')
    expect(hack.get('.variant-badge').text()).toBe('HACK')

    const cloneBadges = card(wrapper, 3).findAll('.variant-badge').map((badge) => badge.text())
    expect(cloneBadges).toEqual(['BOOTLEG', 'CLONE'])

    const unclassified = card(wrapper, 5)
    expect(unclassified.get('.game-version').text()).toBe('未标注')
    expect(unclassified.get('.variant-badge').text()).toBe('未分类')

    await hack.trigger('click')
    expect(harness.routerPush).toHaveBeenCalledWith('/play/2')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  test('uses lazy stable image frames with truthful match labels and an error fallback', async () => {
    const wrapper = await mountGallery()
    const labels = new Map(wrapper.findAll('.game-card').map((item) => [
      Number(item.attributes('data-rom-id')),
      item.get('.thumbnail-evidence').text(),
    ]))

    expect(labels.get(1)).toBe('本作截图')
    expect(labels.get(2)).toBe('别名图')
    expect(labels.get(3)).toBe('参考图')
    expect(labels.get(4)).toBe('参考图')
    expect(labels.get(5)).toBe('暂无截图')

    const image = card(wrapper, 2).get('img')
    expect(image.attributes('loading')).toBe('lazy')
    expect(image.attributes('decoding')).toBe('async')
    expect(image.attributes('alt')).toContain('合金弹头 Plus')
    expect(image.attributes('alt')).toContain('mslugps')
    expect(card(wrapper, 2).get('.thumbnail-frame').classes()).toContain('thumbnail-frame')

    await image.trigger('error')
    await nextTick()
    expect(card(wrapper, 2).find('img').exists()).toBe(false)
    expect(card(wrapper, 2).get('.thumbnail-fallback').text()).toContain('合')
    expect(card(wrapper, 2).get('.thumbnail-evidence').text()).toBe('暂无截图')
  })

  test('searches all returned metadata and filters by core and variant type', async () => {
    const wrapper = await mountGallery()
    const search = wrapper.get('input[aria-label="搜索游戏"]')

    for (const term of ['合金弹头', 'mslugps', 'Plus Edition', 'mame2003_plus', 'hack']) {
      await search.setValue(term)
      expect(wrapper.findAll('.game-card')).toHaveLength(1)
      expect(wrapper.get('.game-card').attributes('data-rom-id')).toBe('2')
    }

    await search.setValue('Neo Geo MVS')
    expect(wrapper.findAll('.game-card').map((item) => item.attributes('data-rom-id'))).toEqual(['1', '2'])

    await search.setValue('arcade')
    expect(wrapper.findAll('.game-card')).toHaveLength(5)
    await search.setValue('')

    await wrapper.get('[data-testid="core-filter"]').setValue('mame2003_plus')
    expect(wrapper.findAll('.game-card')).toHaveLength(1)
    expect(wrapper.get('.game-card').attributes('data-rom-id')).toBe('2')

    await wrapper.get('[data-testid="core-filter"]').setValue('all')
    await wrapper.get('[data-testid="variant-filter"]').setValue('clone')
    expect(wrapper.findAll('.game-card')).toHaveLength(1)
    expect(wrapper.get('.game-card').attributes('data-rom-id')).toBe('3')
  })

  test('preserves guest and authenticated direct-play behavior', async () => {
    const guest = await mountGallery(galleryRows(), { authed: false, guestPlayEnabled: false })
    await card(guest, 1).trigger('click')
    expect(harness.routerPush).toHaveBeenLastCalledWith(
      `/auth?redirect=${encodeURIComponent('/play/1')}`,
    )

    const enabledGuest = await mountGallery(galleryRows(), { authed: false, guestPlayEnabled: true })
    await card(enabledGuest, 3).trigger('keydown', { key: 'Enter' })
    expect(harness.routerPush).toHaveBeenLastCalledWith('/play/3')

    const authed = await mountGallery(galleryRows(), { authed: true, guestPlayEnabled: false })
    await card(authed, 2).trigger('keydown', { key: ' ' })
    expect(harness.routerPush).toHaveBeenLastCalledWith('/play/2')
  })

  test('renders 512 variants without replacing cards or eager-loading images', async () => {
    const rows = Array.from({ length: 512 }, (_, index) => makeRom({
      id: index + 1,
      title: `批量游戏 ${index + 1}`,
      setName: `bulk_${index + 1}`,
    }))
    const wrapper = await mountGallery(rows)

    expect(wrapper.findAll('.game-card')).toHaveLength(512)
    expect(wrapper.findAll('img')).toHaveLength(512)
    expect(wrapper.findAll('img').every((image) => image.attributes('loading') === 'lazy')).toBe(true)
  })
})
