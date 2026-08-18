# Arcade Title Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audited Chinese titles for all 656 arcade catalog entries while retaining exact English DAT names as searchable, semi-transparent subtitles.

**Architecture:** Keep database and import contracts unchanged. A generated, version-controlled static catalog is keyed by `coreName:setNameNormalized`; pure localization helpers resolve catalog entries with safe fallbacks, and Gallery/Player/Rooms consume those helpers. Contract tests pin coverage and exact English source text.

**Tech Stack:** Vue 3, Vite, Vitest, Node.js test runner, Playwright browser tests.

---

### Task 1: Frozen 656-entry localization catalog

**Files:**
- Create: `src/data/arcade-title-catalog.js`
- Create: `tools/arcade-import/generate-title-catalog.mjs`
- Create: `test/arcade-title-catalog.test.js`
- Read: `tools/arcade-import/contracts/candidates.json`
- Read: `tools/arcade-import/contracts/cores.json`

- [ ] **Step 1: Write the failing contract test**

Add a Node test that imports `ARCADE_TITLE_ROWS`, maps each candidate `coreArtifactId` through `cores.json` to derive `${coreName}:${setName}`, and asserts exactly 656 unique keys, exact equality between every catalog `titleEn` and candidate `title`, non-empty Chinese text for every row, preserved relationship metadata, and stable candidate/catalog SHA-256 constants.

```js
test('covers the frozen arcade contract with exact English source titles', () => {
  assert.equal(ARCADE_TITLE_ROWS.length, 656)
  assert.deepEqual([...catalogByKey.keys()].sort(), [...candidateByKey.keys()].sort())
  for (const [key, candidate] of candidateByKey) {
    const entry = catalogByKey.get(key)
    assert.equal(entry.titleEn, candidate.title)
    assert.match(entry.titleZh, /\S/u)
  }
})
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test test/arcade-title-catalog.test.js`

Expected: FAIL because `src/data/arcade-title-catalog.js` does not exist.

- [ ] **Step 3: Implement deterministic catalog generation**

Create a generator that reads the frozen candidates, resolves each source/set to a reviewed Chinese base-name table plus an explicit exception table, translates region/revision/bootleg/hack suffixes without dropping dates, and emits sorted rows with this exact shape:

```js
{
  key,
  coreName: coreByArtifactId.get(candidate.coreArtifactId).coreName,
  setName: candidate.setName,
  titleZh,
  titleEn: candidate.title,
  familyRootSetName,
  datParentSetName: candidate.datParentSetName,
  relationKind: candidate.relationKind,
  source: 'domestic-common-name+dat-qualifier',
  confidence: 'reviewed',
  aliases,
}
```

The generated module must export `ARCADE_TITLE_ROWS`, `ARCADE_TITLE_BY_KEY`, `ARCADE_TITLE_CANDIDATES_SHA256`, and `ARCADE_TITLE_CATALOG_SHA256`. Parent/family lookup is global by set name because 59 child/parent relationships cross core artifacts. Run the generator once and retain the generated module in version control.

- [ ] **Step 4: Run the contract test and confirm GREEN**

Run: `node --test test/arcade-title-catalog.test.js`

Expected: PASS, reporting one test with 656 covered entries.

- [ ] **Step 5: Commit the catalog unit**

```bash
git add src/data/arcade-title-catalog.js tools/arcade-import/generate-title-catalog.mjs test/arcade-title-catalog.test.js
git commit -m "feat: add audited arcade title catalog"
```

### Task 2: Shared title resolver and search text

**Files:**
- Create: `src/utils/arcadeTitles.js`
- Create: `test/arcade-titles.test.js`

- [ ] **Step 1: Write failing resolver tests**

Cover exact lookup, API core aliases if present, the existing `kof97oro` manually shortened title, unknown-ROM fallback, normalized aliases, bilingual accessible labels, and search text containing Chinese, exact English, legacy title, set, version, core and relation fields.

```js
const localized = getArcadeTitle({
  coreName: 'fbneo', setNameNormalized: 'kof97', title: "The King of Fighters '97",
})
assert.equal(localized.titleZh, '拳皇 97')
assert.equal(localized.titleEn, "The King of Fighters '97")
assert.match(arcadeSearchText(rom), /拳皇 97/u)
assert.match(arcadeSearchText(rom), /the king of fighters '97/u)
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `node --test test/arcade-titles.test.js`

Expected: FAIL because `src/utils/arcadeTitles.js` does not exist.

- [ ] **Step 3: Implement pure helpers**

Export `arcadeTitleKey(rom)`, `getArcadeTitle(rom)`, `arcadeSearchText(rom, additionalFields)`, and `arcadeAccessibleTitle(rom)`. Return exact catalog values when available; otherwise return a non-empty `rom.title` fallback and suppress a duplicate subtitle.

- [ ] **Step 4: Run resolver and catalog tests**

Run: `node --test test/arcade-title-catalog.test.js test/arcade-titles.test.js`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the helper unit**

```bash
git add src/utils/arcadeTitles.js test/arcade-titles.test.js
git commit -m "feat: resolve bilingual arcade titles"
```

### Task 3: Gallery bilingual rendering and search

**Files:**
- Modify: `src/views/Gallery.vue`
- Modify: `test/components/gallery.test.js`
- Modify: `test/browser/gallery.spec.mjs`

- [ ] **Step 1: Add failing component assertions**

Use a real catalog set (`kof97`) whose API `title` is English. Assert `.game-title` is `拳皇 97`, `.game-title-en` is the exact English title, English subtitle exists only when different, `opacity` is implemented through the class, and Chinese/English/alias/set searches each return the same card. Also assert alt, favorite aria label and card aria label contain both names.

- [ ] **Step 2: Run the component test and confirm RED**

Run: `npx vitest run test/components/gallery.test.js`

Expected: FAIL because the card still renders `rom.title` directly and has no `.game-title-en`.

- [ ] **Step 3: Wire Gallery to the resolver**

Import the shared helpers, localize API rows once after loading, render `localizedTitle.titleZh` and the conditional subtitle, use `arcadeSearchText`, and update thumbnail/favorite/card labels. Add constrained two-line CSS:

```css
.game-title-en {
  display: -webkit-box;
  min-height: 30px;
  margin: 3px 0 0;
  overflow: hidden;
  color: var(--arcade-muted);
  font-size: 10px;
  line-height: 1.45;
  opacity: 0.58;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
```

- [ ] **Step 4: Add and run browser layout coverage**

Extend the gallery browser fixture with a long exact English DAT title, then assert at desktop and 360px widths that the subtitle is visible, its box stays inside the card, and searching the English original leaves one result.

Run: `npm run test:browser -- test/browser/gallery.spec.mjs`

Expected: PASS with no overflow or console errors.

- [ ] **Step 5: Commit Gallery integration**

```bash
git add src/views/Gallery.vue test/components/gallery.test.js test/browser/gallery.spec.mjs
git commit -m "feat: show bilingual arcade titles in gallery"
```

### Task 4: Player and room title consumers

**Files:**
- Modify: `src/views/Player.vue`
- Modify: `src/views/Rooms.vue`
- Modify: `src/components/emulator-portal/GameOverlay.vue`
- Create: `test/components/rooms-localization.test.js`
- Modify: `test/components/player-crt.test.js`

- [ ] **Step 1: Write failing consumer tests**

Assert a player booted with `fbneo:kof97` sends `拳皇 97` as the overlay primary title with the exact English original as a secondary prop. Assert room rows whose API returns `romCoreName`, `romSetName`, and English `romTitle` render Chinese followed by the semi-transparent English original, while unknown rooms retain `romTitle`.

- [ ] **Step 2: Run the focused component tests and confirm RED**

Run: `npx vitest run test/components/player-crt.test.js test/components/rooms-localization.test.js`

Expected: FAIL because Player and Rooms currently consume raw server titles.

- [ ] **Step 3: Reuse the shared resolver**

Player creates a ROM-shaped title identity from its loaded metadata and passes primary/secondary names to `GameOverlay`. Rooms maps `romCoreName || coreName`, `romSetName`, and `romTitle` through the same resolver. Add a compact `.room-game-title-en` style with opacity `0.58`; do not change server payloads.

- [ ] **Step 4: Run the focused and full component suites**

Run: `npx vitest run test/components/player-crt.test.js test/components/rooms-localization.test.js test/components/gallery.test.js`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit shared consumers**

```bash
git add src/views/Player.vue src/views/Rooms.vue src/components/emulator-portal/GameOverlay.vue test/components/player-crt.test.js test/components/rooms-localization.test.js
git commit -m "feat: localize arcade titles across play and rooms"
```

### Task 5: Full verification and production release

**Files:**
- Modify only if verification exposes an in-scope localization defect.

- [ ] **Step 1: Verify generated data is reproducible**

Run the catalog generator and then `git diff --exit-code -- src/data/arcade-title-catalog.js`.

Expected: generator exits 0 and generated catalog has no diff.

- [ ] **Step 2: Run all automated tests and build**

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Expected: all commands exit 0. Existing unrelated smoke working-tree changes remain unstaged.

- [ ] **Step 3: Package and deploy atomically**

Create a high-compression archive containing tracked release files only, upload to `160.236.110.53:59222`, extract into a new `/srv/childhood-arcade/releases/<sha>` directory, reuse `/srv/childhood-arcade/shared`, install production dependencies if required, switch `/srv/childhood-arcade/current` atomically, and restart the existing systemd unit. Do not edit the Nginx site on `43.159.2.240` unless the existing proxy health check fails.

- [ ] **Step 4: Verify production**

Check the systemd unit and `/api/health`; use a browser at `https://arcade.abcds.de/` to verify Chinese and English searches, one long-title card, mobile layout, Player title and room title. Confirm browser console has no errors and the public API still returns 656 entries.

- [ ] **Step 5: Commit any verification-only fixes and record release SHA**

Do not commit the pre-existing smoke files. Report the deployed commit, release path, test totals, API count and browser checks.
