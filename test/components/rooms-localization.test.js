import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  api: {
    roomsPublic: vi.fn(),
    roomsMine: vi.fn(),
  },
  isAuthed: { value: false },
  routerPush: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: harness.routerPush }),
}))

vi.mock('../../src/api/client.js', () => ({ api: harness.api }))

vi.mock('../../src/composables/useAuth.js', () => ({
  useAuth: () => ({ isAuthed: harness.isAuthed }),
}))

import Rooms from '../../src/views/Rooms.vue'

function room(overrides = {}) {
  return {
    id: 1,
    code: 'KOF97A',
    name: '周末开黑',
    isPublic: true,
    hostOnline: true,
    hasPassword: false,
    romId: 7,
    romTitle: "The King of Fighters '97 (NGM-2320)",
    romPlatform: 'arcade',
    romSetName: 'kof97',
    romVersionLabel: null,
    coreName: 'fbneo',
    hostUsername: 'arcader',
    ...overrides,
  }
}

function mountRooms() {
  return mount(Rooms, {
    global: {
      stubs: {
        'router-link': { template: '<a><slot /></a>' },
        CreateRoomDialog: true,
        JoinRoomDialog: true,
        EditRoomDialog: true,
      },
    },
  })
}

beforeEach(() => {
  harness.api.roomsPublic.mockReset()
  harness.api.roomsMine.mockReset()
  harness.routerPush.mockReset()
  harness.isAuthed.value = false
})

describe('Rooms bilingual arcade titles', () => {
  test('renders Chinese and exact English names under a room game title', async () => {
    harness.api.roomsPublic.mockResolvedValue({ rooms: [room()] })
    const wrapper = mountRooms()
    await flushPromises()

    expect(wrapper.get('.room-game-title').text()).toBe('拳皇 97（NGM-2320）')
    expect(wrapper.get('.room-game-title-en').text()).toBe("The King of Fighters '97 (NGM-2320)")
  })

  test('keeps an unknown room title as the only displayed name', async () => {
    harness.api.roomsPublic.mockResolvedValue({ rooms: [room({ id: 2, romTitle: '未来测试 ROM', romSetName: 'future-set', coreName: 'fbneo' })] })
    const wrapper = mountRooms()
    await flushPromises()

    expect(wrapper.get('.room-game-title').text()).toBe('未来测试 ROM')
    expect(wrapper.find('.room-game-title-en').exists()).toBe(false)
  })

  test('accepts normalized room metadata aliases when resolving a catalog title', async () => {
    harness.api.roomsPublic.mockResolvedValue({ rooms: [room({
      id: 3,
      romSetName: undefined,
      romSetNameNormalized: 'kof97',
      romOriginalTitle: "The King of Fighters '97 (NGM-2320)",
    })] })
    const wrapper = mountRooms()
    await flushPromises()

    expect(wrapper.get('.room-game-title').text()).toBe('拳皇 97（NGM-2320）')
    expect(wrapper.get('.room-game-title-en').text()).toContain("The King of Fighters '97")
  })
})
