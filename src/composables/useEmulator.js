// Vue lifecycle wrapper around Nostalgist. Uses the prepare/start two-phase
// pattern borrowed from retroassembly — we let Nostalgist own the canvas
// element (via getCanvas()) and mount it into our container once ready.

import { ref, shallowRef, onBeforeUnmount } from 'vue'
import { prepareEmulator } from './nostalgist.js'

// Some libretro cores probe `navigator.mediaDevices.getUserMedia` on boot,
// which pops an unwanted camera-permission prompt. We null it out during
// start() and restore immediately after — lifted from retroassembly.
const originalGetUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia
  ?.bind(globalThis.navigator.mediaDevices)

export function createPortalCanvas(documentRef = globalThis.document) {
  const canvas = documentRef.createElement('canvas')
  canvas.setAttribute('tabindex', '-1')
  canvas.classList.add('portal-canvas')
  return canvas
}

// Nostalgist currently writes a full-screen fixed layout directly onto the
// canvas, even when the caller supplies the element. Reset those inline
// values so the player portal — and its toolbar above it — owns the layout.
export function normalizePortalCanvas(canvas) {
  Object.assign(canvas.style, {
    display: 'block',
    position: 'static',
    inset: 'auto',
    top: 'auto',
    right: 'auto',
    bottom: 'auto',
    left: 'auto',
    width: '100%',
    height: '100%',
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    zIndex: 'auto',
  })
  return canvas
}

export function useEmulator({
  documentRef = globalThis.document,
  navigatorRef = globalThis.navigator,
  prepare = prepareEmulator,
  registerBeforeUnmount = onBeforeUnmount,
} = {}) {
  // Where Nostalgist's generated canvas gets inserted.
  const wrapperRef = ref(null)
  const booting = ref(false)
  const error = ref(null)
  const instance = shallowRef(null)

  // Cached for WebRTC's canvas.captureStream() call later
  let currentCanvas = null
  let wakeLock = null
  let lifecycleEpoch = 0
  let activeBoots = 0

  async function cleanupBoot(emu, canvasElement, emulatorCanvas = null, exitEmulator = true) {
    if (instance.value === emu) instance.value = null
    if (currentCanvas === emulatorCanvas || currentCanvas === canvasElement) currentCanvas = null
    if (exitEmulator) {
      try { await emu?.exit?.() } catch {}
    }
    emulatorCanvas?.remove?.()
    if (canvasElement !== emulatorCanvas) canvasElement?.remove?.()
  }

  async function boot({ core, rom, romUrl, romFileName, bios = [], retroarchConfig = {}, shader }) {
    if (!wrapperRef.value) throw new Error('wrapper not mounted')
    if (instance.value) return instance.value
    activeBoots += 1
    booting.value = true
    error.value = null
    const bootEpoch = lifecycleEpoch
    let canvasElement = null
    let emulatorCanvas = null
    let emu = null
    try {
      // Accept either a unified `rom` (object | array | url) or the legacy
      // romUrl/romFileName pair. Normalising here keeps callers flexible.
      const romInput = rom !== undefined
        ? rom
        : (romFileName ? { fileName: romFileName, fileContent: romUrl } : romUrl)
      canvasElement = createPortalCanvas(documentRef)
      wrapperRef.value.append(canvasElement)
      emu = await prepare({
        core,
        rom: romInput,
        bios,
        retroarchConfig,
        shader,
        element: canvasElement,
      })

      // Re-check mount: prepareEmulator is async (seconds), the component may
      // have been torn down while we waited (e.g. guest role arrived and the
      // v-if flipped). Bail cleanly instead of crashing on a null wrapper.
      if (bootEpoch !== lifecycleEpoch || !wrapperRef.value) {
        await cleanupBoot(emu, canvasElement)
        return null
      }
      instance.value = emu

      emulatorCanvas = normalizePortalCanvas(emu.getCanvas())
      currentCanvas = emulatorCanvas
      if (!emulatorCanvas.isConnected) wrapperRef.value.append(emulatorCanvas)

      try { navigatorRef.mediaDevices.getUserMedia = null } catch {}
      try { await emu.start() }
      finally { try { navigatorRef.mediaDevices.getUserMedia = originalGetUserMedia } catch {} }

      // Keep the portal layout authoritative if a core/startup hook writes
      // Nostalgist's defaults again while the emulator is starting.
      normalizePortalCanvas(emulatorCanvas)

      // destroy() invalidates the epoch before releasing the old instance. If
      // navigation/unmount happened while start() was pending, the stale boot
      // must not refocus the page or acquire a fresh wake lock afterwards.
      if (
        bootEpoch !== lifecycleEpoch
        || !wrapperRef.value
        || instance.value !== emu
      ) {
        await cleanupBoot(
          emu,
          canvasElement,
          emulatorCanvas,
          instance.value === emu,
        )
        return null
      }

      emulatorCanvas.focus({ preventScroll: true })

      let acquiredWakeLock = null
      try { acquiredWakeLock = await navigatorRef?.wakeLock?.request('screen') } catch {}

      // A wake-lock request can remain pending after navigation. Never attach
      // a late lock (or report a successful boot) once destroy() invalidated
      // this lifecycle epoch.
      if (
        bootEpoch !== lifecycleEpoch
        || !wrapperRef.value
        || instance.value !== emu
      ) {
        try { await acquiredWakeLock?.release?.() } catch {}
        await cleanupBoot(
          emu,
          canvasElement,
          emulatorCanvas,
          instance.value === emu,
        )
        return null
      }
      wakeLock = acquiredWakeLock

      return emu
    } catch (err) {
      const staleBoot = bootEpoch !== lifecycleEpoch || !wrapperRef.value
        || (emu !== null && instance.value !== emu)
      await cleanupBoot(
        emu,
        canvasElement,
        emulatorCanvas,
        !staleBoot,
      )
      if (staleBoot) return null
      error.value = err
      throw err
    } finally {
      activeBoots = Math.max(0, activeBoots - 1)
      booting.value = activeBoots > 0
    }
  }

  async function saveState() {
    if (!instance.value) return null
    const { state } = await instance.value.saveState()
    return state
  }

  async function loadState(blobOrArrayBuffer) {
    if (!instance.value) return
    await instance.value.loadState(blobOrArrayBuffer)
  }

  function canvas() { return currentCanvas }

  // Tap into Nostalgist's internal AudioContext via MediaStreamDestination so
  // the host-mode WebRTC path can forward audio to the guest. Returns null
  // when we can't wire it up (caller falls back to video-only).
  function captureAudioStream() {
    const inst = instance.value
    if (!inst) return null
    const emuModule = inst?.getEmscripten?.()?.Module
    const ctx = emuModule?.audioContext || emuModule?.AL?.currentCtx?.audioCtx
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null
    try {
      const dest = ctx.createMediaStreamDestination()
      if (emuModule?.SDL2?.audio?.scriptProcessorNode) {
        emuModule.SDL2.audio.scriptProcessorNode.connect(dest)
      } else if (emuModule?.AL?.alcDevice?.script) {
        emuModule.AL.alcDevice.script.connect(dest)
      } else {
        return null
      }
      return dest.stream
    } catch {
      return null
    }
  }

  async function toggleFullscreen() {
    const el = wrapperRef.value
    if (!el) return
    if (documentRef.fullscreenElement) {
      await documentRef.exitFullscreen?.()
    } else {
      await el.requestFullscreen?.()
    }
  }

  async function destroy() {
    lifecycleEpoch += 1
    const inst = instance.value
    instance.value = null
    currentCanvas = null
    try { await wakeLock?.release() } catch {}
    wakeLock = null
    if (!inst) return
    try { await inst.exit() } catch {}
  }

  registerBeforeUnmount(() => { destroy() })

  return {
    wrapperRef,
    booting,
    error,
    instance,
    boot,
    saveState,
    loadState,
    canvas,
    captureAudioStream,
    toggleFullscreen,
    destroy,
  }
}
