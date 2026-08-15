import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, test } from 'vitest'

describe('component harness canary', () => {
  test('mounts a Vue component in the configured DOM environment', () => {
    const Canary = defineComponent({
      name: 'ComponentHarnessCanary',
      setup: () => () => h('button', { type: 'button' }, 'component canary'),
    })

    const wrapper = mount(Canary)
    expect(wrapper.get('button').text()).toBe('component canary')
    expect(document.body).toBeDefined()
  })
})
