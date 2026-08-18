export function experimentalPublicationEnabled() {
  return process.env.ARCADE_EXPERIMENTAL_UNVERIFIED === '1'
}

export function publicationMode({ rom, build, hasBatchReference = false }) {
  if (!build) return null
  if (build.compatStatus === 'ready') return 'verified'
  if (
    experimentalPublicationEnabled() &&
    rom?.isPublic &&
    build.staticStatus === 'complete' &&
    build.compatStatus === 'unverified' &&
    hasBatchReference
  ) {
    return 'experimental'
  }
  return null
}
