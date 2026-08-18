import assert from 'node:assert/strict'
import test from 'node:test'

import {
  arcadeAccessibleTitle,
  arcadeSearchText,
  arcadeTitleKey,
  getArcadeTitle,
} from '../src/utils/arcadeTitles.js'

test('resolves a catalog title by the API core and normalized set', () => {
  const rom = {
    coreName: 'fbneo',
    setNameNormalized: 'KOF97',
    title: "The King of Fighters '97 (NGM-2320)",
  }

  assert.equal(arcadeTitleKey(rom), 'fbneo:kof97')
  const title = getArcadeTitle(rom)
  assert.match(title.titleZh, /拳皇/u)
  assert.equal(title.titleEn, "The King of Fighters '97 (NGM-2320)")
  assert.equal(title.showEnglish, true)
})

test('keeps the exact DAT title when the server has a legacy Chinese title', () => {
  const title = getArcadeTitle({
    coreName: 'fbneo',
    setName: 'kof97oro',
    title: '拳皇97风云再起',
  })

  assert.match(title.titleZh, /拳皇/u)
  assert.match(title.titleZh, /冲出江湖|Plus/u)
  assert.equal(title.titleEn, "The King of Fighters '97 Chongchu Jianghu Plus 2003 (bootleg, set 1)")
  assert.ok(title.aliases.includes('拳皇97风云再起'))
})

test('falls back safely for a ROM that is not in the static catalog', () => {
  const rom = { coreName: 'fbneo', setName: 'future-set', title: 'Future Test ROM' }
  const title = getArcadeTitle(rom)

  assert.equal(title.titleZh, 'Future Test ROM')
  assert.equal(title.titleEn, 'Future Test ROM')
  assert.equal(title.showEnglish, false)
  assert.equal(arcadeAccessibleTitle(rom), 'Future Test ROM（future-set）')
})

test('search text contains bilingual names, aliases and runtime metadata', () => {
  const rom = {
    coreName: 'fbneo',
    setNameNormalized: 'mslug4',
    title: 'Metal Slug 4 (NGM-2630)',
    versionLabel: 'Plus Edition',
    platform: 'arcade',
    variantKind: 'hack',
  }
  const text = arcadeSearchText(rom)

  assert.match(text, /合金弹头/u)
  assert.match(text, /metal slug 4/iu)
  assert.match(text, /mslug4/iu)
  assert.match(text, /plus edition/iu)
  assert.match(text, /hack/iu)
})

test('reuses a resolved title when a gallery row is searched repeatedly', () => {
  const rom = {
    coreName: 'fixture',
    setNameNormalized: 'future-set',
    title: 'legacy server title',
  }
  const resolved = getArcadeTitle({
    coreName: 'fbneo',
    setNameNormalized: 'kof97',
    title: "The King of Fighters '97 (NGM-2320)",
  })

  assert.match(arcadeSearchText(rom, [], resolved), /拳皇 97/u)
  assert.match(arcadeAccessibleTitle(rom, resolved), /The King of Fighters '97/u)
})
