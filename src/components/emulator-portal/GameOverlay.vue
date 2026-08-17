<template>
  <div class="player-bar">
    <button class="bar-btn" @click="$emit('back')" aria-label="返回">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      <span class="bar-btn-label">返回</span>
    </button>

    <button
      v-if="canUseArcadeControls"
      class="bar-btn"
      data-testid="coin-button"
      aria-label="投币"
      title="投币"
      :disabled="!arcadeControlsEnabled"
      @click="$emit('coin')"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.1 10.4A6 6 0 1 1 10.4 18"/><path d="M7 6h1v4"/><path d="m16.7 13.9.7.7-2.8 2.8"/></svg>
      <span class="bar-btn-label">投币</span>
    </button>
    <button
      v-if="canUseArcadeControls"
      class="bar-btn"
      data-testid="start-button"
      aria-label="开始"
      title="开始"
      :disabled="!arcadeControlsEnabled"
      @click="$emit('start')"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 4 13 8L7 20V4z"/></svg>
      <span class="bar-btn-label">开始</span>
    </button>

    <div class="bar-center">
      <span class="bar-badge" :style="{ background: platform.color }">{{ platform.label }}</span>
      <h2 class="bar-title">{{ title }}</h2>
      <span v-if="coreName" class="bar-core">{{ coreName }}</span>
      <span class="playing-led" title="游戏运行中">
        <span class="led-dot"></span>PLAYING
      </span>
    </div>

    <slot name="extras" />

    <button
      v-if="canToggleCrt"
      class="bar-btn bar-btn-crt"
      :class="{ active: crtEnabled }"
      data-testid="crt-toggle"
      aria-label="CRT 滤镜"
      :aria-pressed="crtEnabled"
      :title="crtEnabled ? '关闭 CRT 滤镜' : '开启 CRT 滤镜'"
      @click="$emit('toggle-crt')"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
      <span class="bar-btn-label">CRT</span>
    </button>
    <button v-if="canSave" class="bar-btn" @click="$emit('save-state')" aria-label="存档" title="快速存档">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    </button>
    <button v-if="canSave" class="bar-btn" @click="$emit('load-state')" aria-label="读档" title="读取存档">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
    </button>
    <button class="bar-btn bar-btn-keys" @click="$emit('keys')" aria-label="按键设置" title="按键设置">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h.01M12 14h.01M16 14h.01"/></svg>
    </button>
    <button v-if="canFullscreen" class="bar-btn bar-btn-accent" @click="$emit('fullscreen')" aria-label="全屏">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      <span class="bar-btn-label">全屏</span>
    </button>
  </div>
</template>

<script setup>
defineProps({
  title: String,
  platform: { type: Object, required: true },
  coreName: String,
  canSave: { type: Boolean, default: true },
  canUseArcadeControls: { type: Boolean, default: false },
  arcadeControlsEnabled: { type: Boolean, default: false },
  canToggleCrt: { type: Boolean, default: false },
  crtEnabled: { type: Boolean, default: false },
})
defineEmits(['back', 'fullscreen', 'keys', 'save-state', 'load-state', 'coin', 'start', 'toggle-crt'])

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const hasFs = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled)
const canFullscreen = hasFs && !isIOS
</script>

<style scoped>
/* Dark chrome bar — stays dark regardless of app theme (canvas is black). */
.player-bar {
  --b-bg:        rgba(18, 18, 20, 0.92);
  --b-border:    rgba(255, 255, 255, 0.06);
  --b-btn-bg:    rgba(255, 255, 255, 0.08);
  --b-btn-hover: rgba(255, 255, 255, 0.16);
  --b-text:      #F5F5F7;
  --b-muted:     rgba(235, 235, 245, 0.6);
  --b-tertiary:  rgba(235, 235, 245, 0.42);

  /* Always visible — takes its own row in the .player-page flex column, so
     the canvas below sizes itself to the remaining viewport. */
  flex-shrink: 0;

  display: flex;
  align-items: center;
  gap: 8px;
  padding:
    calc(10px + env(safe-area-inset-top))
    calc(14px + env(safe-area-inset-right))
    10px
    calc(14px + env(safe-area-inset-left));
  background: var(--b-bg);
  color: var(--b-text);
}

.bar-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  overflow: hidden;
  min-width: 0;
}
.bar-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  color: #fff;
  letter-spacing: 0.02em;
  line-height: 1.4;
}
.bar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--b-text);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.01em;
}
.bar-core {
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 11px;
  color: var(--b-tertiary);
  flex-shrink: 0;
}
/* "PLAYING" indicator — status green LED */
.playing-led {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.led-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--success);
  animation: led-pulse 1.6s ease-in-out infinite;
}
@keyframes led-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
@media (max-width: 640px) {
  .playing-led { display: none; }
}

.bar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 36px;
  min-height: 34px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--b-border);
  background: var(--b-btn-bg);
  color: var(--b-text);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.1s ease;
  flex-shrink: 0;
}
.bar-btn:hover {
  background: var(--b-btn-hover);
  border-color: rgba(255, 255, 255, 0.16);
  color: #fff;
}
.bar-btn:active { transform: scale(0.96); }
.bar-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
  transform: none;
}
.bar-btn-accent {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}
.bar-btn-accent:hover {
  background: color-mix(in srgb, var(--accent) 32%, transparent);
  color: #fff;
}
.bar-btn-crt.active {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
  border-color: color-mix(in srgb, var(--accent) 48%, transparent);
  color: #fff;
}
.bar-btn-crt.active:hover {
  background: color-mix(in srgb, var(--accent) 34%, transparent);
  color: #fff;
}

@media (max-width: 768px) {
  .bar-btn-label { display: none; }
  .bar-btn { padding: 6px; min-width: 36px; min-height: 36px; }
  .bar-title { font-size: 13px; }
  .bar-core { display: none; }
  .player-bar { padding: 8px 10px; }
}
@media (max-height: 500px) and (orientation: landscape) {
  .player-bar { padding: 4px 10px; }
  .bar-btn { min-height: 30px; min-width: 30px; padding: 3px 8px; }
  .bar-title { font-size: 12px; }
  .bar-badge, .bar-core { display: none; }
}
@media (max-width: 380px) {
  .player-bar {
    gap: 4px;
    padding: 6px 4px;
    padding-right: calc(4px + env(safe-area-inset-right));
    padding-left: calc(4px + env(safe-area-inset-left));
  }
  .bar-center { gap: 4px; }
  .bar-badge { display: none; }
  .bar-title { font-size: 12px; }
  .bar-btn { min-width: 30px; min-height: 34px; padding: 4px; }
}
</style>
