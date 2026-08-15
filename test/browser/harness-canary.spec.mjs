import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
const { version } = require('playwright-core/package.json')

test('browser harness discovers the pinned Playwright core without launching a browser', () => {
  assert.equal(version, '1.58.2')
  assert.equal(typeof chromium.launch, 'function')
})
