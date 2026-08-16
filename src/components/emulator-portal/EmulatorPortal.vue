<template>
  <div class="portal crt-screen" ref="wrapperRef">
    <!-- Nostalgist's generated <canvas> is appended here on boot -->
  </div>
</template>

<script setup>
import { onMounted, watch } from 'vue'
import { useEmulator } from '../../composables/useEmulator.js'

const props = defineProps({
  core: { type: String, required: true },
  coreJsUrl: { type: String, default: '' },
  coreWasmUrl: { type: String, default: '' },
  // Either a single { fileName, fileContent } or an array of them — arcade
  // clones need their parent romset mounted alongside the clone in the VFS.
  rom: { type: [Object, Array], required: true },
  bios: { type: Array, default: () => [] },
  retroarchConfig: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['booted', 'error'])

const {
  wrapperRef,
  boot,
  saveState,
  loadState,
  canvas,
  captureAudioStream,
  toggleFullscreen,
  destroy,
} = useEmulator()

async function start() {
  try {
    await boot({
      core: props.core,
      coreJsUrl: props.coreJsUrl,
      coreWasmUrl: props.coreWasmUrl,
      rom: props.rom,
      bios: props.bios,
      retroarchConfig: props.retroarchConfig,
    })
    emit('booted')
  } catch (err) {
    console.error('[emulator] boot failed', err)
    emit('error', err)
  }
}

onMounted(() => start())

// Re-boot on ROM change. Compare by primary fileContent URL (first entry of
// an array or the single object) plus core name.
function romKey(r) {
  if (!r) return null
  if (Array.isArray(r)) return r.map((x) => x?.fileContent).join('|')
  return r.fileContent
}
watch(() => [romKey(props.rom), props.core, props.coreJsUrl, props.coreWasmUrl], async ([newKey, newCore, newJs, newWasm], [oldKey, oldCore, oldJs, oldWasm]) => {
  if (newKey === oldKey && newCore === oldCore && newJs === oldJs && newWasm === oldWasm) return
  await destroy()
  await start()
})

defineExpose({
  saveState,
  loadState,
  toggleFullscreen,
  captureAudioStream,
  get canvas() { return canvas() },
})
</script>

<style scoped>
.portal {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  position: relative;
}
/* Nostalgist's canvas is inserted via JS so the rule has to escape :deep() */
.portal :deep(.portal-canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  object-fit: contain !important;
  position: static !important;
  inset: auto !important;
  top: auto !important;
  right: auto !important;
  bottom: auto !important;
  left: auto !important;
  z-index: auto !important;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  background: #000;
  outline: none;
}
</style>
