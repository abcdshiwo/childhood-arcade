import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'

import GameOverlay from '../../src/components/emulator-portal/GameOverlay.vue'

const arcade = { label: '街机', color: '#d97706' }

function mountOverlay(props = {}) {
  return mount(GameOverlay, {
    props: {
      title: '拳皇 97',
      platform: arcade,
      canToggleCrt: true,
      crtEnabled: false,
      ...props,
    },
  })
}

describe('GameOverlay CRT control', () => {
  test('exposes the current filter state and emits a toggle command', async () => {
    const wrapper = mountOverlay()
    const button = wrapper.get('[data-testid="crt-toggle"]')

    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.classes()).not.toContain('active')

    await button.trigger('click')
    expect(wrapper.emitted('toggle-crt')).toHaveLength(1)

    await wrapper.setProps({ crtEnabled: true })
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.classes()).toContain('active')
  })

  test('hides the filter control for non-arcade platforms', () => {
    const wrapper = mountOverlay({ canToggleCrt: false })
    expect(wrapper.find('[data-testid="crt-toggle"]').exists()).toBe(false)
  })
})
