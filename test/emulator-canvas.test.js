import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as emulatorModule from '../src/composables/useEmulator.js'
import * as nostalgistModule from '../src/composables/nostalgist.js'

function fakeCanvas() {
  const attributes = new Map()
  const classes = new Set()

  return {
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)) },
      contains(name) { return classes.has(name) },
    },
    getAttribute(name) { return attributes.get(name) ?? null },
    setAttribute(name, value) { attributes.set(name, String(value)) },
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
