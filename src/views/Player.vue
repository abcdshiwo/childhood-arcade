<template>
  <div class="player-page">
    <GameOverlay
      v-if="rom || fatalError || isGuestMode"
      :title="displayName"
      :platform="platformInfo"
      :core-name="coreDisplayName[platformInfo.core] || platformInfo.core"
      :can-save="isAuthed && !isGuestMode"
      @back="goBack"
      @fullscreen="onFullscreen"
      @keys="showInput = true"
      @save-state="onSaveState"
      @load-state="onLoadState"
    >
      <template #extras>
        <!-- Version switcher: only when this game has multi-version siblings -->
        <div v-if="siblings.length > 1" class="ver-switch" @click.stop>
          <button class="ver-btn" @click="versionMenuOpen = !versionMenuOpen">
            <span class="ver-cur">{{ currentVersionLabel }}</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div v-if="versionMenuOpen" class="ver-menu">
            <button
              v-for="v in siblings"
              :key="v.id"
              class="ver-item"
              :class="{ active: v.id === romMeta?.id }"
              @click="switchVersion(v)"
            >{{ v.id === (romMeta?.parentRomId ?? romMeta?.id) ? '原版' : (v.versionLabel || '变体') }}</button>
          </div>
        </div>

        <button v-if="isRoomMode" class="room-chip" :class="{ active: showRoom }" @click="showRoom = !showRoom" title="房间">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          <span class="chip-count">{{ Object.keys(signalPeers).length }}</span>
        </button>
      </template>
    </GameOverlay>

    <div class="emu-area">
      <div class="emu-frame">
        <!-- Host / solo: real Nostalgist emulator.
             Only render when we KNOW we're solo or the host. If we're in a
             room but role is still unknown (welcome not arrived yet), show
             the waiting-guest view instead — starting the emulator for a
             future guest wastes cores + triggers an unmount race. -->
        <EmulatorPortal
          v-if="rom && biosReady && !authLoading && (!isRoomMode || isHostMode)"
          ref="portalRef"
          :core="platformInfo.core"
          :core-js-url="platformInfo.coreJsUrl"
          :core-wasm-url="platformInfo.coreWasmUrl"
          :rom="rom"
          :bios="bios"
          :retroarch-config="retroarchConfig"
          @booted="onBooted"
          @error="(err) => { fatalError = err?.message || '模拟器启动失败' }"
        />

        <!-- Guest (or role not yet determined in a room): remote video stream -->
        <div v-else-if="isRoomMode" class="guest-view">
          <video
            ref="remoteVideoRef"
            class="remote-video"
            autoplay
            playsinline
            muted
            @playing="onVideoPlaying"
          ></video>
          <!-- Waiting overlay: connecting / no stream yet -->
          <div v-if="!remoteStreamActive" class="guest-waiting">
            <div class="spinner"></div>
            <p>{{ signalMe ? '等待主机画面…' : '正在进入房间…' }}</p>
            <p class="muted">{{ connectionStatus }}</p>
          </div>
          <!-- Mute badge: auto-start is always muted to bypass browser autoplay
               policy; this chip lets the user opt in to audio with a tap. -->
          <button v-if="remoteStreamActive && isMuted" class="unmute-chip" @click="unmuteRemote">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6"/></svg>
            点击取消静音
          </button>
        </div>

        <div v-else-if="fatalError" class="emu-error">
          <div class="error-card">
            <p>{{ fatalError }}</p>
            <button class="btn btn-primary" @click="goBack">返回列表</button>
          </div>
        </div>

        <div v-else class="emu-loading">
          <div class="loading-stack">
            <div class="loading-glow"></div>
            <div class="spinner"></div>
          </div>
          <p class="emu-loading-title">
            <span class="dot" style="--i:0"></span><span class="dot" style="--i:1"></span><span class="dot" style="--i:2"></span>
            INSERT COIN
          </p>
          <p class="emu-loading-game">{{ displayName }}</p>
          <p class="emu-loading-sub">{{ loadingSub }}</p>
          <button v-if="loadingSlow" class="btn btn-sm emu-loading-retry" @click="reloadPage">长时间未加载，点此刷新</button>
        </div>
      </div>
    </div>

    <Transition name="hint">
      <div v-if="showRotateHint" class="rotate-hint" @click="showRotateHint = false">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/></svg>
        横屏体验更佳
      </div>
    </Transition>

    <Transition name="hint">
      <div v-if="toastText" class="toast">{{ toastText }}</div>
    </Transition>

    <!-- Virtual pad: host/solo on touch devices, or guest that's allowed to play -->
    <VirtualGamepad
      v-if="(rom && !isGuestMode) || (isGuestMode && canGuestPlay)"
      :platform="romMeta?.platform"
      :on-button="guestButtonInterceptor"
    />

    <RoomPanel
      v-if="isRoomMode"
      :open="showRoom"
      :code="roomCode"
      :connected="signalConnected"
      :is-host="isHostMode"
      :allow-play="canGuestPlay"
      :me-peer-id="signalMe?.peerId"
      :peers="signalPeers"
      :chat="signalChat"
      @close="showRoom = false"
      @send="(t) => signal?.sendChat(t)"
    />

    <InputSettings v-if="showInput" :platform="romMeta?.platform" @close="showInput = false" />
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick, reactive, shallowRef } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '../api/client.js'
import { getPlatformInfo } from '../data/config.js'
import {
  createArtifactGenerationGuard,
  resolveBuildArtifacts,
} from '../composables/nostalgist.js'
import { coreDisplayName } from '../constants/cores.js'
import {
  useInputMapping,
  buildPlayer2KeyMap,
  buildPlayer2RetroarchConfig,
  keyboardEventInit,
  normalizeKeyboardKey,
} from '../composables/useInputMapping.js'
import { useAuth } from '../composables/useAuth.js'
import { useRoomSignal } from '../composables/useRoomSignal.js'
import { useWebRTC } from '../composables/useWebRTC.js'
import { useGamepads } from '../composables/useGamepads.js'
import EmulatorPortal from '../components/emulator-portal/EmulatorPortal.vue'
import GameOverlay from '../components/emulator-portal/GameOverlay.vue'
import VirtualGamepad from '../components/emulator-portal/VirtualGamepad.vue'
import RoomPanel from '../components/emulator-portal/RoomPanel.vue'
import InputSettings from '../components/InputSettings.vue'

const props = defineProps({ id: String })
const router = useRouter()
const route = useRoute()
const { retroarchConfig: inputCfg, mapping } = useInputMapping()
const { isAuthed, loading: authLoading } = useAuth()
const player2KeyMap = shallowRef(buildPlayer2KeyMap(mapping.value.keyboard))

// -- State --
const portalRef = ref(null)
const remoteVideoRef = ref(null)
const showRotateHint = ref(false)
const showInput = ref(false)
const showRoom = ref(false)
const toastText = ref('')
const fatalError = ref(null)
const romMeta = ref(null)
const remoteStreamActive = ref(false)
const isMuted = ref(true)
const connectionStatus = ref('建立连接…')
const booted = ref(false)
const loadingSlow = ref(false)
let slowTimer = null

// Room mode
const roomCode = (route.query.room || '').toString().toUpperCase() || null
const isRoomMode = !!roomCode
let signal = null
const signalConnected = ref(false)
const signalMe = ref(null)
const signalPeers = reactive({})
const signalChat = ref([])
const roomInfo = ref(null)
const isHostMode = computed(() => isRoomMode && !!signalMe.value?.isHost)
const isGuestMode = computed(() => isRoomMode && signalMe.value && !signalMe.value.isHost)
const canGuestPlay = computed(() => roomInfo.value?.allowPlay !== false)

// WebRTC
let rtc = null

const siblings = ref([])        // all versions in the family (parent + children)
const versionMenuOpen = ref(false)

const rom = shallowRef(null)
const bios = shallowRef([])
const biosReady = ref(false)
const artifactGeneration = createArtifactGenerationGuard()

async function resolveRuntimeArtifacts() {
  const generation = artifactGeneration.begin()
  const build = romMeta.value?.activeBuild
  if (!build) {
    rom.value = null
    bios.value = []
    biosReady.value = false
    return
  }
  try {
    const runtime = await resolveBuildArtifacts(build)
    if (!artifactGeneration.isCurrent(generation)) return
    rom.value = runtime.rom.length === 1 ? runtime.rom[0] : runtime.rom
    bios.value = runtime.bios
    biosReady.value = true
  } catch (err) {
    if (!artifactGeneration.isCurrent(generation)) return
    fatalError.value = `下载 ROM 失败：${err.message}`
    biosReady.value = false
  }
}

// Guest spectators receive the game via WebRTC from the host and never need
// the ROM file locally — in room mode we defer the ROM fetch until the
// `welcome` frame confirms we're the host (signalMe arrives). This also keeps
// anonymous spectators from hitting the auth-gated build file endpoint.
watch([romMeta, signalMe], () => {
  artifactGeneration.invalidate()
  rom.value = null
  bios.value = []
  biosReady.value = false
  if (isRoomMode) {
    if (!signalMe.value) return
    if (!signalMe.value.isHost) return
  }
  resolveRuntimeArtifacts()
})
const platformInfo = computed(() => getPlatformInfo(romMeta.value))

// Human-readable loading hint — arcade takes much longer than NES/GBA
// because FBNeo ships a ~2 MB core plus up to 5 MB of BIOS files.
const loadingSub = computed(() => {
  const p = romMeta.value?.platform
  if (!p) return '正在获取游戏信息…'
  if (p === 'arcade') return '街机核心首次加载较慢（10-30 秒），请耐心等待'
  if (p === 'psx') return '核心较大，首次加载约需 10 秒'
  return '核心与 ROM 下载中…'
})

function onBooted() {
  booted.value = true
  loadingSlow.value = false
  if (slowTimer) { clearTimeout(slowTimer); slowTimer = null }
}
function reloadPage() { window.location.reload() }
const displayName = computed(() => romMeta.value?.title || (isGuestMode.value ? '连接中…' : '加载中…'))
watch(() => signalMe.value?.isHost, (isHost, wasHost) => {
  if (isHost && !wasHost) {
    player2KeyMap.value = buildPlayer2KeyMap(mapping.value.keyboard)
  }
}, { flush: 'sync' })
watch(authLoading, (loading) => {
  // A direct /play URL can mount Player before /api/auth/me resolves. Wait for
  // useInputMapping's user-specific localStorage refresh before freezing P2.
  if (!loading && !booted.value) {
    player2KeyMap.value = buildPlayer2KeyMap(mapping.value.keyboard)
  }
}, { flush: 'sync' })
// Merge P2 bindings when hosting netplay so guest input maps cleanly.
const retroarchConfig = computed(() => {
  const base = inputCfg.value || {}
  if (isRoomMode && signalMe.value?.isHost) {
    return { ...base, ...buildPlayer2RetroarchConfig(player2KeyMap.value) }
  }
  return base
})

// -- Load ROM meta --
async function loadMeta() {
  const id = Number(props.id)
  try {
    const [{ roms: mine }, { roms: pub }] = await Promise.all([
      api.romsMine().catch(() => ({ roms: [] })),
      api.romsPublic().catch(() => ({ roms: [] })),
    ])
    // /public only returns parents; fall back to the versions endpoint when
    // landing directly on a child id (version switcher / bookmark).
    let found = [...mine, ...pub].find((r) => r.id === id)
    if (!found) {
      try {
        const { versions } = await api.romVersions(id)
        found = versions.find((r) => r.id === id)
      } catch {}
    }
    if (isRoomMode) {
      const pw = sessionStorage.getItem(`room:${roomCode}:pw`) || ''
      try {
        const room = await api.roomJoin(roomCode, pw)
        roomInfo.value = room
        if (!found && room.romId === id) {
          found = { id: room.romId, title: room.romTitle, platform: room.romPlatform, fileName: '', isPublic: false }
        }
      } catch {}
    }
    if (!found) {
      fatalError.value = 'ROM 未找到或无权访问 (id=' + id + ')'
      return
    }
    romMeta.value = found
    // Load sibling versions for the top-bar switcher. Runtime dependencies are
    // already fixed by the active build returned above.
    try {
      const seedId = found.parentRomId || found.id
      const { versions } = await api.romVersions(seedId)
      siblings.value = versions || []
    } catch {
      siblings.value = [found]
    }
  } catch (err) {
    fatalError.value = err.message
  }
}

const currentVersionLabel = computed(() => {
  if (!romMeta.value) return ''
  if (!romMeta.value.parentRomId) return '原版'
  return romMeta.value.versionLabel || '变体'
})

function switchVersion(v) {
  versionMenuOpen.value = false
  if (!v || v.id === romMeta.value?.id) return
  const suffix = roomCode ? `?room=${roomCode}` : ''
  router.push(`/play/${v.id}${suffix}`)
}

// -- Save states (cloud if authed + rom in DB, else localStorage) --
const localKey = computed(() =>
  romMeta.value ? `state:${platformInfo.value.core}:${romMeta.value.id}` : null,
)

async function onSaveState() {
  if (isGuestMode.value) return showToast('客人模式不支持存档')
  try {
    const data = await portalRef.value?.saveState()
    if (!data) return showToast('存档失败')
    const blob = data instanceof Blob ? data : new Blob([data])
    if (isAuthed.value && romMeta.value) {
      try {
        await api.saveUpload(romMeta.value.id, blob)
        showToast('已存档（云端）')
        return
      } catch (err) {
        console.warn('[saves] cloud upload failed, falling back to local', err)
      }
    }
    if (localKey.value) {
      const buf = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
      localStorage.setItem(localKey.value, btoa(bin))
      showToast('已存档（本地）')
    }
  } catch (err) {
    console.warn('[saves] save failed', err)
    showToast('存档失败')
  }
}

async function onLoadState() {
  if (isGuestMode.value) return showToast('客人模式不支持读档')
  if (!romMeta.value) return
  try {
    if (isAuthed.value) {
      try {
        const blob = await api.saveLoad(romMeta.value.id)
        if (blob) {
          await portalRef.value?.loadState(blob)
          return showToast('已读档（云端）')
        }
      } catch { /* fall through */ }
    }
    if (localKey.value) {
      const raw = localStorage.getItem(localKey.value)
      if (!raw) return showToast('无存档')
      const bin = atob(raw)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      await portalRef.value?.loadState(new Blob([bytes]))
      showToast('已读档（本地）')
    } else {
      showToast('无存档')
    }
  } catch (err) {
    console.warn('[saves] load failed', err)
    showToast('读档失败')
  }
}

// -- Navigation / misc --
function goBack() {
  if (isRoomMode) {
    sessionStorage.removeItem(`room:${roomCode}:pw`)
    router.push('/rooms')
  } else {
    router.push('/')
  }
}
function onFullscreen() { portalRef.value?.toggleFullscreen() }
function showToast(text) {
  toastText.value = text
  setTimeout(() => { toastText.value = '' }, 1600)
}

function onKeyDown(e) {
  if (e.key === 'Escape' && !document.fullscreenElement) goBack()
}

// Fires when the remote video element actually has decoded frames on screen
// (not merely when tracks arrive). Using this instead of onRemoteStream avoids
// hiding the waiting overlay before any pixel has been drawn.
function onVideoPlaying() {
  remoteStreamActive.value = true
}

// Browser autoplay policy blocks playback with audio until a user gesture.
// We start muted + let the user tap this chip to enable sound.
async function unmuteRemote() {
  const v = remoteVideoRef.value
  if (!v) return
  try {
    v.muted = false
    await v.play()
    isMuted.value = false
  } catch (err) {
    console.warn('[webrtc] unmute failed:', err)
  }
}

// ============================================================
// Room mode — signaling + WebRTC
// ============================================================
const REVERSE_KEY_MAP = computed(() => {
  const cfg = mapping.value.keyboard || {}
  const m = {}
  for (const [btn, key] of Object.entries(cfg)) m[key] = btn
  return m
})

function setupRoom() {
  const password = sessionStorage.getItem(`room:${roomCode}:pw`) || ''
  signal = useRoomSignal({ code: roomCode, password })

  rtc = useWebRTC({
    signal,
    onRemoteStream: (stream) => {
      // Attach + explicitly play. The element is `muted` in the template so
      // autoplay policy lets it start; isMuted flag drives the "tap to unmute"
      // chip. The `playing` DOM event is what actually flips remoteStreamActive
      // (see onVideoPlaying) — arriving of tracks alone doesn't mean we have
      // decoded frames yet.
      const v = remoteVideoRef.value
      if (!v) return
      v.srcObject = stream
      v.muted = true
      isMuted.value = true
      v.play().catch((err) => {
        // If even muted playback was blocked (rare), surface waiting state
        // so the user sees the spinner rather than a silent black box.
        console.warn('[webrtc] video.play() blocked:', err)
        remoteStreamActive.value = false
      })
    },
    onDataMessage: (data) => {
      // Host: re-dispatch guest button as the collision-free P2 key (if allowed)
      if (isHostMode.value && data?.type === 'input' && data.button) {
        if (!canGuestPlay.value) return
        dispatchP2Button(data.action, data.button)
      }
    },
    onStateChange: (s) => {
      if (s === 'connected' || s === 'dc:open') connectionStatus.value = '已连接'
      else if (s === 'connecting' || s === 'new') connectionStatus.value = '握手中…'
      else if (s === 'failed' || s === 'closed') connectionStatus.value = '连接断开'
    },
  })

  signal.on('welcome', (msg) => {
    signalMe.value = { peerId: msg.peerId, isHost: msg.isHost }
    for (const p of (msg.peers || [])) signalPeers[p.id] = p
    if (msg.chat) signalChat.value.push(...msg.chat)
    showRoom.value = true
    // Host reconnect case: refreshing the page leaves guests in the room but
    // their old WebRTC PeerConnections to our previous socket are dead. Invite
    // each known guest so they get a fresh offer.
    if (msg.isHost) {
      for (const p of (msg.peers || [])) {
        if (!p.isHost && p.id !== msg.peerId) hostInviteGuest(p.id)
      }
    }
  })
  signal.on('peer-joined', (msg) => {
    signalPeers[msg.peer.id] = msg.peer
    if (signalMe.value?.isHost && msg.peer && !msg.peer.isHost) {
      hostInviteGuest(msg.peer.id)
    }
  })
  signal.on('peer-left', (msg) => {
    delete signalPeers[msg.peerId]
    rtc?.closePeer(msg.peerId)
    // Clear the guest's video since the stream is dead either way.
    remoteStreamActive.value = false
    if (msg.wasHost && !signalMe.value?.isHost) {
      showToast(msg.reconnecting ? '主机重连中…' : '房主已离开')
      connectionStatus.value = msg.reconnecting ? '等待主机回来…' : '主机已离开'
    }
  })
  signal.on('chat', (msg) => {
    signalChat.value.push({ from: msg.from, fromName: msg.fromName, text: msg.text, at: msg.at })
  })
  signal.on('offer',  async (msg) => { await rtc.handleOffer(msg.from, msg.sdp) })
  signal.on('answer', async (msg) => { await rtc.handleAnswer(msg.from, msg.sdp) })
  signal.on('ice',    async (msg) => { await rtc.handleIce(msg.from, msg.candidate) })
  signal.on('room-closed', () => {
    toastText.value = '房间已关闭'
    setTimeout(() => router.push('/rooms'), 1500)
  })
  signal.on('error', (msg) => {
    fatalError.value = ({
      'netplay-disabled': '管理员已关闭对战功能',
      'room-not-found':   '房间不存在或已关闭',
      'bad-password':     '房间密码错误',
      'host-offline':     '房主不在线，请稍后再试',
    })[msg.reason] || ('信令错误：' + msg.reason)
  })
  signal.on('closed', () => { signalConnected.value = false })

  signal.connect()
  watch(signal.connected, (v) => { signalConnected.value = v })
}

// -- Host: capture canvas + audio, start an RTCPeerConnection to the guest --
async function hostInviteGuest(peerId) {
  await nextTick()
  const portal = portalRef.value
  if (!portal) {
    console.warn('[host] no portalRef, cannot invite', peerId)
    return
  }

  // Wait for the emulator canvas to exist + be producing frames.
  // FBNeo + neogeo BIOS can take 15 s on a cold CDN fetch — budget 20 s.
  let canvas = null
  for (let i = 0; i < 134 && !canvas; i++) {
    canvas = portal.canvas
    if (canvas?.captureStream) break
    canvas = null
    await new Promise((r) => setTimeout(r, 150))
  }
  if (!canvas) {
    console.warn('[host] canvas still not ready after 20s, giving up on', peerId)
    return
  }

  const stream = canvas.captureStream(60)

  try {
    const audioStream = portal.captureAudioStream?.()
    if (audioStream) {
      for (const t of audioStream.getAudioTracks()) stream.addTrack(t)
    }
  } catch (err) {
    console.warn('[host] audio capture failed, proceeding video-only', err)
  }

  rtc.startCall(peerId, stream)
}

// -- Host: convert guest-sent retropad button into the corresponding P2 key
function dispatchP2Button(action, button) {
  const mappedKey = player2KeyMap.value[button]
  if (!mappedKey) return
  const type = action === 'down' ? 'keydown' : 'keyup'
  try {
    const ev = new KeyboardEvent(type, keyboardEventInit(mappedKey))
    window.dispatchEvent(ev)
    document.dispatchEvent(ev)
  } catch {}
}

// -- Guest: forward keyboard events as button-name messages
function guestKeyHandler(e) {
  if (!rtc || !signalMe.value || signalMe.value.isHost) return
  if (!canGuestPlay.value) return
  const k = normalizeKeyboardKey(e.key, e.code, e.location)
  const button = REVERSE_KEY_MAP.value[k]
  if (!button) return
  e.preventDefault()
  rtc.sendData({ type: 'input', action: e.type === 'keydown' ? 'down' : 'up', button })
}

// Shared button-intercept for both VirtualGamepad and gamepad: returns true
// (=handled) if we're a room guest and we forward the input over the DC
// instead of letting it dispatch a local keyboard event.
function guestButtonInterceptor(action, button) {
  if (!isRoomMode) return false
  if (!signalMe.value || signalMe.value.isHost) return false
  if (!canGuestPlay.value) return true   // observer mode: swallow
  rtc?.sendData({ type: 'input', action, button })
  return true
}

useGamepads({ onButton: guestButtonInterceptor })

// Re-fetch when the route id changes (e.g. user picked a different version
// from the top-bar switcher — same component, same view, new rom id).
watch(() => props.id, (now, prev) => {
  if (!prev || now === prev) return
  player2KeyMap.value = buildPlayer2KeyMap(mapping.value.keyboard)
  romMeta.value = null
  siblings.value = []
  booted.value = false
  loadMeta()
})

onMounted(() => {
  if (window.innerWidth < 768 && window.innerHeight > window.innerWidth) {
    showRotateHint.value = true
    setTimeout(() => { showRotateHint.value = false }, 3500)
  }
  document.addEventListener('keydown', onKeyDown)
  loadMeta()
  // If the emulator still hasn't booted after 30 s, surface a "long load" hint
  // so the user knows they can refresh instead of staring at a spinner.
  slowTimer = setTimeout(() => { if (!booted.value) loadingSlow.value = true }, 30000)
  if (isRoomMode) {
    setupRoom()
    document.addEventListener('keydown', guestKeyHandler, true)
    document.addEventListener('keyup', guestKeyHandler, true)
  }
})

onBeforeUnmount(() => {
  artifactGeneration.invalidate()
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('keydown', guestKeyHandler, true)
  document.removeEventListener('keyup', guestKeyHandler, true)
  if (slowTimer) { clearTimeout(slowTimer); slowTimer = null }
  try { rtc?.close() } catch {}
  try { signal?.close() } catch {}
})
</script>

<style scoped>
.player-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  background: #000;
  position: relative;
  overflow: hidden;
  /* Kill iOS / WeChat long-press menus (复制/搜一搜/翻译 等) that steal
     pointer events mid-stroke and leave the stick/buttons in a stuck state. */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
.player-page :deep(.portal-canvas) {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
}
.emu-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
  min-height: 0;
  overflow: hidden;
}
.emu-frame { width: 100%; height: 100%; position: relative; overflow: hidden; }

.guest-view {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: #000;
}
.remote-video {
  max-width: 100%; max-height: 100%;
  background: #000;
  object-fit: contain;
}
.guest-waiting {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 12px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  backdrop-filter: blur(6px);
}
.guest-waiting p { margin: 0; font-size: 14px; }
.guest-waiting .muted { font-size: 11px; color: rgba(255,255,255,0.5); letter-spacing: 0.08em; }

/* Tap-to-unmute chip for guests — floats in bottom-right of video area */
.unmute-chip {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--r-sm);
  border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  background: rgba(8, 8, 12, 0.85);
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  z-index: 5;
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
}
.unmute-chip:hover { color: #fff; background: color-mix(in srgb, var(--accent) 35%, transparent); }

.emu-error, .emu-loading {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 10px;
  background:
    radial-gradient(ellipse at 50% 42%, color-mix(in srgb, var(--accent) 18%, transparent) 0%, rgba(0,0,0,0) 60%),
    #000;
  z-index: 10;
  padding: 24px;
  text-align: center;
}
/* Faint CRT scanlines on the loading screen — on-brand for an arcade loader. */
.emu-loading::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    180deg,
    rgba(255, 255, 255, 0) 0px,
    rgba(255, 255, 255, 0) 2px,
    rgba(255, 255, 255, 0.035) 2px,
    rgba(255, 255, 255, 0.035) 3px
  );
  pointer-events: none;
}

.loading-stack { position: relative; width: 40px; height: 40px; margin-bottom: 4px; }
.loading-glow {
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 55%, transparent) 0%, transparent 65%);
  filter: blur(6px);
  animation: glow-pulse 1.8s ease-in-out infinite;
}
@keyframes glow-pulse {
  0%, 100% { opacity: 0.5; transform: scale(0.92); }
  50%      { opacity: 1;   transform: scale(1.1);  }
}

.emu-loading-title {
  margin: 0;
  color: #F5F5F7;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.22em;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-variant-numeric: tabular-nums;
  animation: coin-blink 1.6s ease-in-out infinite;
}
@keyframes coin-blink {
  0%, 50%, 100% { opacity: 1; }
  60%, 90%      { opacity: 0.45; }
}
.emu-loading-title .dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: #818CF8;
  box-shadow: 0 0 6px var(--accent);
  animation: dot-bounce 1.2s ease-in-out infinite;
  animation-delay: calc(var(--i) * 140ms);
}
@keyframes dot-bounce {
  0%, 80%, 100% { transform: scale(0.4); opacity: 0.4; }
  40%           { transform: scale(1);   opacity: 1;   }
}

.emu-loading-game {
  margin: 0;
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.emu-loading-sub {
  margin: 0;
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  max-width: 300px;
  line-height: 1.55;
  letter-spacing: 0.01em;
}
.emu-loading-retry {
  margin-top: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #F5F5F7;
  border-color: rgba(255, 255, 255, 0.18);
  position: relative; z-index: 1;
}
.emu-loading-retry:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.error-card {
  text-align: center;
  padding: 28px 36px;
  border-radius: 16px;
  background: #141416;
  border: 1px solid rgba(255,255,255,0.08);
  max-width: 320px;
  color: #fff;
}
.error-card p { color: rgba(255,255,255,0.75); font-size: 14px; margin: 0 0 16px; line-height: 1.5; }

.spinner {
  position: relative;
  width: 40px; height: 40px;
  border-radius: 50%;
  border: 2.5px solid rgba(255, 255, 255, 0.08);
  border-top-color: #818CF8;
  border-right-color: color-mix(in srgb, var(--accent) 50%, transparent);
  animation: spin 0.9s cubic-bezier(0.55, 0.15, 0.45, 0.85) infinite;
  z-index: 1;
}
@keyframes spin { to { transform: rotate(360deg); } }

.room-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 36px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.06);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}

.ver-switch { position: relative; }
.ver-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.14s ease;
}
.ver-btn:hover { background: rgba(255,255,255,0.14); }
.ver-cur { color: rgba(255,255,255,0.9); }
.ver-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 140px;
  padding: 6px;
  background: rgba(22, 22, 24, 0.96);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  z-index: 40;
}
.ver-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: rgba(255,255,255,0.85);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.ver-item:hover { background: rgba(255,255,255,0.08); color: #fff; }
.ver-item.active { background: color-mix(in srgb, var(--accent) 30%, transparent); color: #fff; }
.room-chip:hover { background: rgba(255,255,255,0.12); }
.room-chip.active { background: color-mix(in srgb, var(--accent) 30%, transparent); color: #fff; border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
.chip-count {
  background: rgba(0,0,0,0.3);
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}

.rotate-hint, .toast {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  padding: 9px 16px;
  border-radius: 999px;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  background: rgba(20, 20, 22, 0.85);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.08);
  z-index: 100;
}
.rotate-hint { bottom: 90px; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.rotate-hint svg { animation: rotPhone 1.8s ease-in-out infinite; }
@keyframes rotPhone {
  0%, 100% { transform: rotate(0); }
  50%      { transform: rotate(90deg); }
}
.toast { bottom: 60px; }

.hint-enter-active, .hint-leave-active {
  transition: opacity 0.25s var(--ease-out), transform 0.25s var(--ease-out);
}
.hint-enter-from, .hint-leave-to {
  opacity: 0; transform: translateX(-50%) translateY(12px);
}

@media (min-width: 769px) {
  .emu-area { padding: 16px 24px; }
  .emu-frame {
    max-width: 1100px;
    max-height: calc(100vh - 32px);
    margin: 0 auto;
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
    overflow: hidden;
  }
}
</style>
