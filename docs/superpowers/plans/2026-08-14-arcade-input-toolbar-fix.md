# Arcade Input And Toolbar Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the in-game toolbar visible, provide browser-safe arcade defaults, and retain player-customizable keyboard and gamepad mappings.

**Architecture:** Keep the existing logical RetroPad mapping and WebRTC P1/P2 routing. Change only the shared default keyboard profile and arcade labels, then make the application own the Nostalgist canvas through its supported `element` option so the emulator cannot install a fixed full-page canvas over the toolbar. Custom mappings remain browser-local and override defaults.

**Tech Stack:** Vue 3, Nostalgist 0.21, RetroArch/FBNeo, Node.js 24 built-in test runner, Vite, systemd, SSH release deployment.

---

## File map

- Create `test/input-mapping.test.js`: regression coverage for default controls and arcade labels.
- Create `test/emulator-canvas.test.js`: regression coverage for application-owned canvas plumbing and the settings reload hint.
- Modify `src/composables/useInputMapping.js`: browser-safe shared defaults.
- Modify `src/constants/platforms.js`: show `投币` and `开始` for arcade system controls.
- Modify `src/composables/nostalgist.js`: build Nostalgist options with an optional application-owned canvas.
- Modify `src/composables/useEmulator.js`: create, mount, and pass the portal canvas before emulator preparation.
- Modify `src/components/emulator-portal/EmulatorPortal.vue`: constrain the canvas to the emulator frame.
- Modify `src/components/emulator-portal/GameOverlay.vue`: keep the keyboard-settings icon available on narrow screens.
- Modify `src/components/InputSettings.vue`: explain persistence and reload behavior.
- Modify `package.json`: add the Node test command.
- Modify `.github/workflows/ci.yml`: run regression tests before the production build.

### Task 1: Arcade default mapping and labels

**Files:**
- Create: `test/input-mapping.test.js`
- Modify: `src/composables/useInputMapping.js:25-32`
- Modify: `src/constants/platforms.js:208-213`
- Modify: `package.json:6-12`
- Modify: `.github/workflows/ci.yml:26-32`

- [ ] **Step 1: Write the failing mapping test**

```js
// test/input-mapping.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

import { useInputMapping } from '../src/composables/useInputMapping.js'
import { getPlatform } from '../src/constants/platforms.js'

test('arcade defaults use the agreed browser-safe keyboard layout', () => {
  const { mapping, retroarchConfig } = useInputMapping()

  assert.deepEqual(
    {
      up: mapping.value.keyboard.up,
      down: mapping.value.keyboard.down,
      left: mapping.value.keyboard.left,
      right: mapping.value.keyboard.right,
      gameA: mapping.value.keyboard.b,
      gameB: mapping.value.keyboard.a,
      gameC: mapping.value.keyboard.y,
      gameD: mapping.value.keyboard.x,
      coin: mapping.value.keyboard.select,
      start: mapping.value.keyboard.start,
    },
    {
      up: 'w', down: 's', left: 'a', right: 'd',
      gameA: 'j', gameB: 'k', gameC: 'u', gameD: 'i',
      coin: '1', start: 'enter',
    },
  )

  assert.equal(retroarchConfig.value.input_player1_select, '1')
  assert.equal(retroarchConfig.value.input_player1_start, 'enter')
  assert.equal(
    new Set(Object.values(mapping.value.keyboard)).size,
    Object.values(mapping.value.keyboard).length,
    'default physical keys must not collide',
  )
})

test('arcade settings name select and start as coin and start', () => {
  const labels = getPlatform('arcade').buttonLabels
  assert.equal(labels.select, '投币')
  assert.equal(labels.start, '开始')
})
```

- [ ] **Step 2: Run the test and confirm the RED state**

Run:

```bash
node --test test/input-mapping.test.js
```

Expected: FAIL showing current values such as `up`, `rshift`, or missing arcade `select/start` labels.

- [ ] **Step 3: Implement the minimal default mapping**

Replace `DEFAULT_KEYBOARD` in `src/composables/useInputMapping.js` with:

```js
const DEFAULT_KEYBOARD = {
  up: 'w', down: 's', left: 'a', right: 'd',
  a: 'k', b: 'j',
  x: 'i', y: 'u',
  l: 'q', r: 'e',
  l2: 'z', r2: 'c',
  start: 'enter', select: '1',
}
```

The internal `b/a/y/x` order is deliberate: FBNeo exposes Neo Geo A/B/C/D through RetroPad B/A/Y/X.

Extend the arcade labels in `src/constants/platforms.js`:

```js
arcade: {
  a: 'B', b: 'A', x: 'D', y: 'C',
  l: 'E', r: 'F',
  select: '投币', start: '开始',
},
```

- [ ] **Step 4: Add the test command and CI gate**

Add this package script:

```json
"test": "node --test test/*.test.js"
```

Add this workflow step immediately before `Build frontend`:

```yaml
      - name: Run regression tests
        run: npm test
```

- [ ] **Step 5: Run the GREEN verification**

Run:

```bash
npm test
npm run build
npm audit --omit=dev
```

Expected: both mapping tests PASS, Vite build succeeds, production audit reports zero vulnerabilities.

- [ ] **Step 6: Commit the mapping change**

```bash
git add test/input-mapping.test.js src/composables/useInputMapping.js \
  src/constants/platforms.js package.json .github/workflows/ci.yml
git commit -m "fix: make arcade controls browser friendly"
```

### Task 2: Application-owned emulator canvas and visible settings

**Files:**
- Create: `test/emulator-canvas.test.js`
- Modify: `src/composables/nostalgist.js:28-69`
- Modify: `src/composables/useEmulator.js:18-63`
- Modify: `src/components/emulator-portal/EmulatorPortal.vue:81-89`
- Modify: `src/components/InputSettings.vue:40-50,166-182`

- [ ] **Step 1: Write the failing canvas test**

```js
// test/emulator-canvas.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as emulatorModule from '../src/composables/useEmulator.js'
import * as nostalgistModule from '../src/composables/nostalgist.js'

test('the application creates and passes its own emulator canvas', () => {
  assert.equal(typeof emulatorModule.createPortalCanvas, 'function')
  assert.equal(typeof nostalgistModule.buildEmulatorOptions, 'function')

  const classes = new Set()
  const canvas = {
    classList: { add: (name) => classes.add(name) },
    setAttribute(name, value) { this[name] = value },
  }
  const documentRef = {
    createElement(tag) {
      assert.equal(tag, 'canvas')
      return canvas
    },
  }

  const created = emulatorModule.createPortalCanvas(documentRef)
  assert.equal(created, canvas)
  assert.equal(canvas.tabindex, '-1')
  assert.equal(classes.has('portal-canvas'), true)

  const options = nostalgistModule.buildEmulatorOptions({
    core: 'fbneo',
    rom: 'mslug.zip',
    element: canvas,
    retroarchConfig: { input_player1_up: 'w' },
  })
  assert.equal(options.element, canvas)
  assert.equal(options.core, 'fbneo')
  assert.equal(options.retroarchConfig.input_player1_up, 'w')
})

test('the input panel explains when remapped controls take effect', () => {
  const source = readFileSync(
    new URL('../src/components/InputSettings.vue', import.meta.url),
    'utf8',
  )
  assert.match(source, /重新进入游戏后生效/)

  const overlaySource = readFileSync(
    new URL('../src/components/emulator-portal/GameOverlay.vue', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(overlaySource, /\.bar-btn-keys\s*\{\s*display:\s*none/)
})
```

- [ ] **Step 2: Run the test and confirm the RED state**

Run:

```bash
npm test
```

Expected: the mapping tests remain green; canvas tests FAIL because the helper exports and settings hint do not exist.

- [ ] **Step 3: Extract option construction and pass `element` to Nostalgist**

In `src/composables/nostalgist.js`, make option construction a pure exported function and keep `prepareEmulator` as the I/O boundary:

```js
export function buildEmulatorOptions({
  core,
  rom,
  romUrl,
  romFileName,
  bios = [],
  retroarchConfig = {},
  shader,
  element,
}) {
  const resolvedRom = rom !== undefined
    ? rom
    : (romFileName ? { fileName: romFileName, fileContent: romUrl } : romUrl)

  const options = {
    core,
    rom: resolvedRom,
    retroarchConfig: { ...DEFAULT_RETROARCH_CONFIG, ...retroarchConfig },
    resolveCoreJs: (c) => cachedFetch(`/api/cores/${c}.js`),
    resolveCoreWasm: (c) => cachedFetch(`/api/cores/${c}.wasm`),
  }
  if (bios?.length) options.bios = bios
  if (shader) options.shader = shader
  if (element) options.element = element
  return options
}

export async function prepareEmulator(options) {
  return Nostalgist.prepare(buildEmulatorOptions(options))
}
```

- [ ] **Step 4: Create and mount the canvas before preparation**

Add this exported helper to `src/composables/useEmulator.js`:

```js
export function createPortalCanvas(documentRef = globalThis.document) {
  if (!documentRef?.createElement) throw new Error('document is unavailable')
  const canvas = documentRef.createElement('canvas')
  canvas.setAttribute('tabindex', '-1')
  canvas.classList.add('portal-canvas')
  return canvas
}
```

Inside `boot`, create and append the canvas before `prepareEmulator`, and pass it as `element`:

```js
let canvasElement = null

try {
  canvasElement = createPortalCanvas()
  wrapperRef.value.append(canvasElement)

  const emu = await prepareEmulator({
    core,
    rom: romInput,
    bios,
    retroarchConfig,
    shader,
    element: canvasElement,
  })

  if (!wrapperRef.value) {
    try { await emu.exit() } catch {}
    canvasElement.remove()
    return null
  }

  instance.value = emu
  const canvas = emu.getCanvas()
  currentCanvas = canvas
  if (!canvas.isConnected) wrapperRef.value.append(canvas)
} catch (err) {
  canvasElement?.remove?.()
  throw err
}
```

Integrate this structure into the existing `boot` try/catch/finally rather than nesting a second production try block. Declare `canvasElement` before the existing try, remove the old post-prepare `setAttribute`, `classList.add`, and unconditional `append` calls, and remove the created canvas in the existing catch before rethrowing.

- [ ] **Step 5: Constrain the canvas and add the settings hint**

Update `EmulatorPortal.vue`:

```css
.portal :deep(.portal-canvas) {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  position: static;
  inset: auto;
  z-index: auto;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  background: #000;
  outline: none;
}
```

Add this text above the footer in `InputSettings.vue`:

```vue
<p class="is-note">键位保存在当前浏览器，重新进入游戏后生效。</p>
```

Style it without changing panel layout:

```css
.is-note {
  margin: 0;
  padding: 8px 18px 0;
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
  line-height: 1.5;
}
```

In the `max-width: 768px` media query in `GameOverlay.vue`, remove only this rule so the icon remains available:

```css
.bar-btn-keys { display: none; }
```

- [ ] **Step 6: Run the GREEN verification**

Run:

```bash
npm test
npm run build
node --check server/index.js
git diff --check
```

Expected: all four tests PASS, Vite build succeeds, syntax check succeeds, and diff check is clean.

- [ ] **Step 7: Commit the canvas fix**

```bash
git add test/emulator-canvas.test.js src/composables/nostalgist.js \
  src/composables/useEmulator.js \
  src/components/emulator-portal/EmulatorPortal.vue \
  src/components/emulator-portal/GameOverlay.vue \
  src/components/InputSettings.vue
git commit -m "fix: keep emulator toolbar visible"
```

### Task 3: Release deployment and live acceptance

**Files:**
- No source changes expected.
- Create local temporary artifacts outside the repository: incremental Git bundle and built `dist` archive.
- Create immutable remote release: `/srv/childhood-arcade/releases/$releaseId`.

- [ ] **Step 1: Run the complete pre-deploy gate**

```powershell
npm test
npm run build
npm audit --omit=dev
node --check server/index.js
git diff --check
git status --short
```

Expected: all commands succeed and `git status --short` is empty.

- [ ] **Step 2: Build small deployment artifacts**

```powershell
$releaseId = (git rev-parse --short=12 HEAD).Trim()
$artifactDir = Join-Path $env:TEMP "childhood-arcade-$releaseId"
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
$gitBundle = Join-Path $artifactDir 'release.bundle'
$distBundle = Join-Path $artifactDir 'dist.tgz'
git bundle create $gitBundle HEAD ^a7076da1d48a
tar -C dist -czf $distBundle .
git bundle verify $gitBundle
```

Expected: bundle verification names `a7076da1d48a` as a prerequisite and both artifacts exist.

- [ ] **Step 3: Transfer through the existing administrator SSH path**

```powershell
$key = 'C:\Users\Administrator\.ssh\id_rsa'
$remoteStage = "/srv/childhood-arcade/imports/release-$releaseId"
ssh -i $key -p 59222 root@160.236.110.53 "install -d -m 0700 $remoteStage"
scp -i $key -P 59222 $gitBundle root@160.236.110.53:"$remoteStage/release.bundle"
scp -i $key -P 59222 $distBundle root@160.236.110.53:"$remoteStage/dist.tgz"
```

Expected: both transfers complete without changing the active release.

- [ ] **Step 4: Assemble and validate the immutable release**

Run one reviewed remote script that:

```bash
set -euo pipefail
release_id="$1"
stage="/srv/childhood-arcade/imports/release-$release_id"
release="/srv/childhood-arcade/releases/$release_id"
export PATH=/srv/childhood-arcade/runtime/node-v24/bin:/usr/bin:/bin
test ! -e "$release"
git clone --no-checkout /srv/childhood-arcade/current "$release"
git -C "$release" fetch "$stage/release.bundle" HEAD
git -C "$release" checkout --detach FETCH_HEAD
cp -a /srv/childhood-arcade/current/node_modules "$release/node_modules"
mkdir "$release/dist"
tar -xzf "$stage/dist.tgz" -C "$release/dist"
cd "$release"
npm test
npm audit --omit=dev
node --check server/index.js
chown -R root:root "$release"
chmod -R a-w "$release"
```

Expected: the new release validates while `/srv/childhood-arcade/current` still points to the previous release.

- [ ] **Step 5: Switch atomically with rollback**

The remote script must record the current resolved release, atomically replace the symlink, restart only `childhood-arcade.service`, and restore the previous symlink if health fails:

```bash
previous="$(readlink -f /srv/childhood-arcade/current)"
ln -s "/srv/childhood-arcade/releases/$release_id" /srv/childhood-arcade/current.next
mv -Tf /srv/childhood-arcade/current.next /srv/childhood-arcade/current
systemctl restart childhood-arcade.service
if ! curl --noproxy '*' -fsS http://127.0.0.1:19097/api/health; then
  ln -s "$previous" /srv/childhood-arcade/current.rollback
  mv -Tf /srv/childhood-arcade/current.rollback /srv/childhood-arcade/current
  systemctl restart childhood-arcade.service
  curl --noproxy '*' -fsS http://127.0.0.1:19097/api/health
  exit 1
fi
```

Expected: health returns `{"ok":true}` and no Nginx, tunnel, Minecraft, or MCSManager service is touched.

- [ ] **Step 6: Run live browser acceptance**

Using a disposable normal user that is deleted after testing:

1. Open `https://arcade.abcds.de/play/7`.
2. Wait for `PLAYING`, then wait another five seconds.
3. Assert the toolbar and `按键设置` button remain visible.
4. Open the settings panel and confirm the labels `投币` and `开始`, plus W/S/A/D, J/K/U/I, `1`, and Enter.
5. Close the panel, click the canvas, press `1`, and verify the credit counter increments.
6. Press Enter and verify Metal Slug 5 enters the game/tutorial.
7. Confirm browser error logs remain empty.
8. Delete the exact disposable user and its cascaded session rows; assert it owns no ROMs before deletion.

- [ ] **Step 7: Run final infrastructure checks**

Verify:

```bash
systemctl is-active childhood-arcade.service childhood-arcade-healthcheck.timer
systemctl is-enabled childhood-arcade.service childhood-arcade-healthcheck.timer
systemctl show childhood-arcade.service -p NRestarts --value
curl --noproxy '*' -fsS http://127.0.0.1:19097/api/health
```

Also verify from the public endpoint:

- `https://arcade.abcds.de/api/health` returns `ok: true`.
- `/api/roms/public` still returns exactly seven public ROMs.
- SQLite `PRAGMA integrity_check` returns `ok`.
- The existing Neo Geo BIOS SHA-256 remains `bf05cc848e403f8ae457bfe26faa8135cf4725cfff956fa030f5c0a00a26adcc`.

- [ ] **Step 8: Record the deployment result**

If all gates pass, keep the previous immutable release for rollback and report the new release commit, live input verification, service status, and the unchanged seven-ROM catalog. Do not delete the previous release or persistent database backup.
