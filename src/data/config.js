import { getPlatform } from '../constants/platforms.js'

// Runtime core and BIOS identity comes from the selected immutable build.
// The platform registry remains useful for labels and controls, but is not a
// source of executable artifact selection.
export function getPlatformInfo(value) {
  const metadata = value && typeof value === 'object' ? value : null
  const platformId = metadata?.platform || value
  const platform = getPlatform(platformId)
  const build = metadata?.activeBuild || metadata?.build || null
  const core = build?.core || null
  return {
    core: core?.name || metadata?.coreName || null,
    coreName: core?.name || metadata?.coreName || null,
    coreVersion: core?.version || metadata?.coreVersion || null,
    coreArtifactFingerprint: core?.artifactFingerprint || metadata?.coreArtifactFingerprint || null,
    coreJsUrl: core?.jsUrl || null,
    coreWasmUrl: core?.wasmUrl || null,
    coreDatUrl: core?.datUrl || null,
    label: platform.shortLabel,
    displayName: platform.displayName,
    color: platform.color,
    manufacturer: platform.manufacturer,
  }
}

export function getBiosUrls(value) {
  const metadata = value && typeof value === 'object' ? value : null
  const bios = metadata?.activeBuild?.core?.bios || metadata?.build?.core?.bios || []
  return bios.map((item) => ({
    fileName: item.fileName,
    fileContent: item.url || item.fileContent,
  }))
}
