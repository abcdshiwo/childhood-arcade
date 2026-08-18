import { ARCADE_TITLE_BY_KEY } from '../data/arcade-title-catalog.js'

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))]
}

export function arcadeTitleKey(rom = {}) {
  const core = text(rom.coreName || rom.core).toLocaleLowerCase()
  const setName = text(rom.setNameNormalized || rom.setName || rom.set).toLocaleLowerCase()
  return core && setName ? `${core}:${setName}` : null
}

export function getArcadeTitle(rom = {}) {
  const key = arcadeTitleKey(rom)
  const catalog = key ? ARCADE_TITLE_BY_KEY.get(key) : null
  const serverTitle = text(rom.title || rom.name)
  const originalTitle = text(rom.originalTitle)
  const titleZh = catalog?.titleZh || serverTitle || originalTitle || '未命名游戏'
  const titleEn = catalog?.titleEn || originalTitle || serverTitle
  const aliases = unique([
    ...(catalog?.aliases || []),
    serverTitle,
    originalTitle,
    rom.titleAlias,
  ])

  return {
    key,
    titleZh,
    titleEn,
    aliases,
    showEnglish: Boolean(titleEn && titleEn !== titleZh),
    familyRootSetName: catalog?.familyRootSetName || null,
    datParentSetName: catalog?.datParentSetName || rom.datParentSetName || null,
    relationKind: catalog?.relationKind || rom.variantKind || null,
  }
}

export function arcadeSearchText(rom = {}, additionalFields = []) {
  const localized = getArcadeTitle(rom)
  const platformFields = [
    rom.setName,
    rom.setNameNormalized,
    rom.versionLabel,
    rom.coreName,
    rom.coreVersion,
    rom.platform,
    rom.hardwareFamily,
    rom.variantKind,
    rom.datParentSetName,
    rom.familyRootSetName,
    rom.thumbnailSourceSetName,
    rom.originalTitle,
    rom.title,
    ...additionalFields,
  ]
  return unique([
    localized.titleZh,
    localized.titleEn,
    ...localized.aliases,
    ...platformFields,
    localized.relationKind === 'clone' || rom.parentRomId || rom.archiveLayout === 'split' ? 'clone' : '',
  ]).join(' ').toLocaleLowerCase()
}

export function arcadeAccessibleTitle(rom = {}) {
  const localized = getArcadeTitle(rom)
  const setName = text(rom.setName || rom.setNameNormalized)
  const names = localized.showEnglish
    ? `${localized.titleZh}（${localized.titleEn}）`
    : localized.titleZh
  return setName ? `${names}（${setName}）` : names
}

