// User-customizable keyboard + gamepad mapping per virtual retropad button.
// Stored in localStorage, keyed by user id (guests share a single 'guest' slot).
// Drives VirtualGamepad/useGamepads dispatch and the InputSettings UI.

import { ref, computed, watch } from 'vue'
import { useAuth } from './useAuth.js'

export const BUTTON_DEFS = [
  { key: 'up',     label: '上',      group: 'dpad' },
  { key: 'down',   label: '下',      group: 'dpad' },
  { key: 'left',   label: '左',      group: 'dpad' },
  { key: 'right',  label: '右',      group: 'dpad' },
  { key: 'a',      label: 'A',       group: 'face' },
  { key: 'b',      label: 'B',       group: 'face' },
  { key: 'x',      label: 'X',       group: 'face' },
  { key: 'y',      label: 'Y',       group: 'face' },
  { key: 'l',      label: 'L',       group: 'shoulder' },
  { key: 'r',      label: 'R',       group: 'shoulder' },
  { key: 'l2',     label: 'L2',      group: 'shoulder' },
  { key: 'r2',     label: 'R2',      group: 'shoulder' },
  { key: 'start',  label: 'Start',   group: 'system' },
  { key: 'select', label: 'Select',  group: 'system' },
]

const DEFAULT_KEYBOARD = {
  up: 'w', down: 's', left: 'a', right: 'd',
  a: 'k', b: 'j',
  x: 'i', y: 'u',
  l: 'q', r: 'e',
  l2: 'z', r2: 'c',
  start: 'enter', select: 'num1',
}

// RetroArch names the top-row number keys num0..num9. Browser KeyboardEvent
// uses key="1" / code="Digit1", so keep the conversion in one place for
// physical keys, saved mappings, room guests, gamepads and the virtual pad.
export function normalizeKeyboardKey(rawKey, code = '', location = 0) {
  const key = String(rawKey ?? '')
  const eventCode = String(code ?? '')

  const digitCode = eventCode.match(/^Digit([0-9])$/)
  if (digitCode) return `num${digitCode[1]}`

  const keypadCode = eventCode.match(/^Numpad([0-9])$/)
  if (keypadCode) return `keypad${keypadCode[1]}`

  const numpadOperators = {
    NumpadMultiply: 'multiply',
    NumpadDivide: 'divide',
    NumpadAdd: 'add',
    NumpadSubtract: 'subtract',
  }
  if (numpadOperators[eventCode]) return numpadOperators[eventCode]

  if (key === ' ') return 'space'
  if (key === 'ArrowUp') return 'up'
  if (key === 'ArrowDown') return 'down'
  if (key === 'ArrowLeft') return 'left'
  if (key === 'ArrowRight') return 'right'
  if (key === 'Enter') return 'enter'
  if (key === 'Shift') return location === 2 ? 'rshift' : 'shift'

  const normalized = key.toLowerCase()
  if (/^[0-9]$/.test(normalized)) return `num${normalized}`
  return normalized
}

export function normalizeKeyboardMapping(keyboard = {}) {
  return Object.fromEntries(
    Object.entries(keyboard).map(([button, key]) => [button, normalizeKeyboardKey(key)]),
  )
}

export function keyboardKeyLabel(key) {
  const normalized = normalizeKeyboardKey(key)
  const digit = normalized.match(/^num([0-9])$/)
  if (digit) return digit[1]
  const keypad = normalized.match(/^keypad([0-9])$/)
  if (keypad) return `小键盘 ${keypad[1]}`
  return normalized
}

export function keyboardEventInit(key) {
  const normalized = normalizeKeyboardKey(key)
  const digit = normalized.match(/^num([0-9])$/)
  if (digit) {
    return {
      key: digit[1],
      code: `Digit${digit[1]}`,
      bubbles: true,
      cancelable: true,
      composed: true,
    }
  }

  const keypad = normalized.match(/^keypad([0-9])$/)
  if (keypad) {
    return {
      key: keypad[1],
      code: `Numpad${keypad[1]}`,
      location: 3,
      bubbles: true,
      cancelable: true,
      composed: true,
    }
  }

  const numpadOperators = {
    multiply: { key: '*', code: 'NumpadMultiply' },
    divide: { key: '/', code: 'NumpadDivide' },
    add: { key: '+', code: 'NumpadAdd' },
    subtract: { key: '-', code: 'NumpadSubtract' },
  }
  if (numpadOperators[normalized]) {
    return {
      ...numpadOperators[normalized],
      location: 3,
      bubbles: true,
      cancelable: true,
      composed: true,
    }
  }

  const domKey = {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    enter: 'Enter', space: ' ', shift: 'Shift', rshift: 'Shift',
    escape: 'Escape',
  }
  const domCode = {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    enter: 'Enter', space: 'Space', shift: 'ShiftLeft', rshift: 'ShiftRight',
    escape: 'Escape',
  }
  const functionKey = normalized.match(/^f([1-9]|1[0-5])$/)
  const eventKey = functionKey ? normalized.toUpperCase() : (domKey[normalized] || normalized)
  const eventCode = functionKey
    ? normalized.toUpperCase()
    : (domCode[normalized] || (/^[a-z]$/.test(normalized) ? `Key${normalized.toUpperCase()}` : normalized))
  const init = {
    key: eventKey,
    code: eventCode,
    bubbles: true,
    cancelable: true,
    composed: true,
  }
  if (normalized === 'rshift') init.location = 2
  return init
}

// Player-2 retropad buttons map to dedicated numpad keys. RetroArch's web
// input driver supports these DOM codes, and the synthetic keys never collide
// with P1's browser-friendly defaults.
export const P2_KEY_MAP = {
  up: 'keypad8', down: 'keypad2', left: 'keypad4', right: 'keypad6',
  a: 'keypad1', b: 'keypad3',
  x: 'keypad7', y: 'keypad9',
  l: 'keypad0', r: 'keypad5',
  start: 'multiply', select: 'divide',
}

// RetroArch config fragment for P2 using the F-key bindings above.
export function buildPlayer2RetroarchConfig() {
  const cfg = {}
  for (const [btn, key] of Object.entries(P2_KEY_MAP)) {
    cfg[`input_player2_${btn}`] = key
  }
  return cfg
}

// numeric values are W3C Gamepad button indexes (Xbox layout).
const DEFAULT_GAMEPAD = {
  a: 1, b: 0, x: 3, y: 2,
  l: 4, r: 5, l2: 6, r2: 7,
  select: 8, start: 9,
  up: 12, down: 13, left: 14, right: 15,
}

function storageKey(userId) { return `input-mapping:${userId || 'guest'}` }

function loadMapping(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}
function saveMapping(userId, mapping) {
  localStorage.setItem(storageKey(userId), JSON.stringify(mapping))
}

const mapping = ref({ keyboard: { ...DEFAULT_KEYBOARD }, gamepad: { ...DEFAULT_GAMEPAD } })
let loaded = false

function refreshForUser(userId) {
  const stored = loadMapping(userId)
  mapping.value = {
    keyboard: normalizeKeyboardMapping({ ...DEFAULT_KEYBOARD, ...(stored?.keyboard || {}) }),
    gamepad:  { ...DEFAULT_GAMEPAD,  ...(stored?.gamepad  || {}) },
  }
}

export function useInputMapping() {
  const { user } = useAuth()

  if (!loaded) {
    loaded = true
    refreshForUser(user.value?.id)
    watch(() => user.value?.id, (id) => refreshForUser(id))
  }

  function setKeyboard(btn, key) {
    mapping.value = {
      ...mapping.value,
      keyboard: { ...mapping.value.keyboard, [btn]: normalizeKeyboardKey(key) },
    }
    saveMapping(user.value?.id, mapping.value)
  }
  function setGamepad(btn, idx) {
    mapping.value = { ...mapping.value, gamepad: { ...mapping.value.gamepad, [btn]: idx } }
    saveMapping(user.value?.id, mapping.value)
  }
  function resetKeyboard() {
    mapping.value = { ...mapping.value, keyboard: { ...DEFAULT_KEYBOARD } }
    saveMapping(user.value?.id, mapping.value)
  }
  function resetGamepad() {
    mapping.value = { ...mapping.value, gamepad: { ...DEFAULT_GAMEPAD } }
    saveMapping(user.value?.id, mapping.value)
  }

  // Retroarch-style input config for player 1 derived from the current mapping.
  const retroarchConfig = computed(() => {
    const cfg = {}
    for (const { key } of BUTTON_DEFS) {
      cfg[`input_player1_${key}`] = mapping.value.keyboard[key] || 'nul'
      const gp = mapping.value.gamepad[key]
      if (typeof gp === 'number') cfg[`input_player1_${key}_btn`] = gp
    }
    return cfg
  })

  return {
    mapping: computed(() => mapping.value),
    retroarchConfig,
    setKeyboard, setGamepad,
    resetKeyboard, resetGamepad,
  }
}
