import assert from 'node:assert/strict'
import test from 'node:test'

import {
  keyboardEventInit,
  keyboardKeyLabel,
  normalizeKeyboardKey,
  normalizeKeyboardMapping,
  useInputMapping,
} from '../src/composables/useInputMapping.js'
import { getPlatform } from '../src/constants/platforms.js'

test('default keyboard mapping uses browser-friendly arcade controls', () => {
  const { mapping } = useInputMapping()

  assert.deepEqual(mapping.value.keyboard, {
    up: 'w', down: 's', left: 'a', right: 'd',
    a: 'k', b: 'j', x: 'i', y: 'u',
    l: 'q', r: 'e', l2: 'z', r2: 'c',
    start: 'enter', select: 'num1',
  })
})

test('player 1 RetroArch config maps coin and start to shared arcade keys', () => {
  const { retroarchConfig } = useInputMapping()

  assert.equal(retroarchConfig.value.input_player1_select, 'num1')
  assert.equal(retroarchConfig.value.input_player1_start, 'enter')
})

test('top-row number keys use RetroArch num names but keep friendly labels', () => {
  assert.equal(normalizeKeyboardKey('1', 'Digit1'), 'num1')
  assert.equal(normalizeKeyboardKey('1'), 'num1')
  assert.equal(keyboardKeyLabel('num1'), '1')
})

test('old stored digit mappings migrate to RetroArch num names', () => {
  assert.deepEqual(
    normalizeKeyboardMapping({ select: '1', start: 'enter', a: 'j' }),
    { select: 'num1', start: 'enter', a: 'j' },
  )
})

test('synthetic num1 events look like a physical top-row 1 key', () => {
  assert.deepEqual(keyboardEventInit('num1'), {
    key: '1',
    code: 'Digit1',
    bubbles: true,
    cancelable: true,
    composed: true,
  })
})

test('default keyboard controls do not reuse physical keys', () => {
  const { mapping } = useInputMapping()
  const keys = Object.values(mapping.value.keyboard)

  assert.equal(new Set(keys).size, keys.length)
})

test('arcade labels identify coin and start buttons', () => {
  const labels = getPlatform('arcade').buttonLabels

  assert.equal(labels.select, '投币')
  assert.equal(labels.start, '开始')
})
