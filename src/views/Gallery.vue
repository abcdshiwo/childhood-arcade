<template>
  <main class="gallery-page">
    <div class="gallery-inner container">
      <header class="gallery-head">
        <div class="gallery-heading">
          <div class="gallery-kicker">
            <span class="status-led" aria-hidden="true"></span>
            ARCADE LIBRARY
          </div>
          <h1 class="page-title">游戏库</h1>
          <p class="gallery-count" aria-live="polite">
            <strong>{{ filtered.length }}</strong>
            <span>/ {{ total }} 个可玩版本</span>
          </p>
        </div>

        <div class="gallery-head-actions">
          <label class="search-box">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              v-model="query"
              type="search"
              placeholder="搜索标题、set、核心或版本"
              aria-label="搜索游戏"
            />
          </label>
          <router-link v-if="isAuthed" to="/my" class="library-action">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 3v12" />
              <path d="m7 8 5-5 5 5" />
              <path d="M5 15v4h14v-4" />
            </svg>
            上传 ROM
          </router-link>
          <router-link v-else to="/auth?mode=register" class="library-action">注册</router-link>
        </div>
      </header>

      <nav class="library-tabs" aria-label="平台筛选">
        <button
          type="button"
          class="library-tab"
          :class="{ active: activeTab === 'all' }"
          :aria-pressed="activeTab === 'all'"
          @click="activeTab = 'all'"
        >
          全部 <span>{{ total }}</span>
        </button>
        <button
          v-if="isAuthed"
          type="button"
          class="library-tab favorite-tab"
          :class="{ active: activeTab === 'favorites' }"
          :aria-pressed="activeTab === 'favorites'"
          :disabled="favoriteCount === 0"
          @click="activeTab = 'favorites'"
        >
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 17.3 5.82 21l1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.46 4.73L18.18 21z" />
          </svg>
          收藏 <span>{{ favoriteCount }}</span>
        </button>
        <button
          v-for="[key, group] in Object.entries(tabGroups)"
          :key="key"
          type="button"
          class="library-tab"
          :class="{ active: activeTab === key }"
          :aria-pressed="activeTab === key"
          :disabled="tabCount(key) === 0"
          @click="activeTab = key"
        >
          {{ group.label }} <span>{{ tabCount(key) }}</span>
        </button>
      </nav>

      <div class="filter-bar">
        <label class="filter-control">
          <span>核心</span>
          <select v-model="coreFilter" data-testid="core-filter" aria-label="核心筛选">
            <option value="all">全部核心</option>
            <option v-for="core in coreOptions" :key="core" :value="core">{{ core }}</option>
          </select>
        </label>
        <label class="filter-control">
          <span>版本类型</span>
          <select v-model="variantFilter" data-testid="variant-filter" aria-label="版本类型筛选">
            <option value="all">全部类型</option>
            <option value="official">官方</option>
            <option value="hack">HACK</option>
            <option value="bootleg">BOOTLEG</option>
            <option value="clone">CLONE</option>
          </select>
        </label>
        <button
          v-if="hasFilters"
          type="button"
          class="clear-filters"
          @click="clearFilters"
        >
          清除筛选
        </button>
      </div>

      <section v-if="loading" class="game-grid" aria-label="正在载入游戏">
        <article v-for="index in 12" :key="index" class="game-card game-card-skeleton">
          <div class="thumbnail-frame skeleton"></div>
          <div class="skeleton-lines">
            <span class="skeleton"></span>
            <span class="skeleton"></span>
            <span class="skeleton"></span>
          </div>
        </article>
      </section>

      <section v-else-if="!filtered.length" class="gallery-empty" aria-live="polite">
        <span class="empty-code">NO MATCH</span>
        <h2>{{ hasFilters ? '没有匹配的游戏' : '游戏库为空' }}</h2>
        <button v-if="hasFilters" type="button" class="clear-filters" @click="clearFilters">
          清除筛选
        </button>
      </section>

      <section v-else class="game-grid" aria-label="游戏列表">
        <article
          v-for="rom in filtered"
          :key="rom.id"
          class="game-card"
          role="link"
          tabindex="0"
          :data-rom-id="rom.id"
          :aria-label="cardAriaLabel(rom)"
          @click="play(rom)"
          @keydown="onCardKeydown($event, rom)"
        >
          <div class="thumbnail-frame">
            <img
              v-if="hasThumbnail(rom)"
              :src="rom.thumbnailUrl"
              :alt="thumbnailAlt(rom)"
              loading="lazy"
              decoding="async"
              @error="onThumbnailError(rom.id)"
            />
            <div v-else class="thumbnail-fallback" aria-hidden="true">
              <span>{{ titleInitial(titleFor(rom).titleZh) }}</span>
              <small>NO SIGNAL</small>
            </div>

            <span
              class="thumbnail-evidence"
              :class="thumbnailEvidenceClass(rom)"
            >
              {{ thumbnailEvidence(rom) }}
            </span>

            <button
              v-if="isAuthed"
              type="button"
              class="favorite-button"
              :class="{ active: rom.isFavorite }"
              :title="`${rom.isFavorite ? '取消收藏' : '收藏'} ${arcadeAccessibleTitle(rom, titleFor(rom))}`"
              :aria-label="rom.isFavorite ? `取消收藏 ${arcadeAccessibleTitle(rom, titleFor(rom))}` : `收藏 ${arcadeAccessibleTitle(rom, titleFor(rom))}`"
              :aria-pressed="Boolean(rom.isFavorite)"
              @click.stop="toggleFavorite(rom)"
              @keydown.stop
            >
              <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" :fill="rom.isFavorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
                <path d="M12 17.3 5.82 21l1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.46 4.73L18.18 21z" />
              </svg>
            </button>
          </div>

          <div class="game-card-body">
            <div class="game-card-heading">
              <h2 class="game-title">{{ titleFor(rom).titleZh }}</h2>
              <p v-if="titleFor(rom).showEnglish" class="game-title-en">{{ titleFor(rom).titleEn }}</p>
              <div v-if="variantBadges(rom).length" class="variant-badges" aria-label="版本标记">
                <span
                  v-for="badge in variantBadges(rom)"
                  :key="badge.key"
                  class="variant-badge"
                  :class="`variant-${badge.key}`"
                >
                  {{ badge.label }}
                </span>
              </div>
            </div>

            <dl class="game-metadata">
              <div>
                <dt>SET</dt>
                <dd class="game-set">{{ rom.setName || rom.setNameNormalized || '—' }}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd class="game-version">{{ rom.versionLabel || '未标注' }}</dd>
              </div>
              <div>
                <dt>核心</dt>
                <dd class="game-core">{{ coreDisplay(rom) }}</dd>
              </div>
              <div>
                <dt>硬件</dt>
                <dd class="game-hardware">{{ hardwareDisplay(rom) }}</dd>
              </div>
            </dl>
          </div>
        </article>
      </section>
    </div>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api/client.js'
import { useAuth } from '../composables/useAuth.js'
import { useSettings } from '../composables/useSettings.js'
import { getPlatform, tabGroups } from '../constants/platforms.js'
import { arcadeAccessibleTitle, arcadeSearchText, getArcadeTitle } from '../utils/arcadeTitles.js'

const router = useRouter()
const { isAuthed } = useAuth()
const { settings } = useSettings()

const roms = ref([])
const localizedTitles = computed(() => {
  const cache = new WeakMap()
  for (const rom of roms.value) cache.set(rom, getArcadeTitle(rom))
  return cache
})
const loading = ref(true)
const query = ref('')
const activeTab = ref('all')
const coreFilter = ref('all')
const variantFilter = ref('all')
const failedThumbnailIds = ref(new Set())

const guestPlayEnabled = computed(() => (
  settings.value?.guestPlayEnabled === true || settings.value?.guestPlayEnabled === '1'
))
const total = computed(() => roms.value.length)
const favoriteCount = computed(() => roms.value.filter((rom) => rom.isFavorite).length)
const coreOptions = computed(() => (
  [...new Set(roms.value.map((rom) => rom.coreName).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
))
const hasFilters = computed(() => (
  Boolean(query.value.trim()) ||
  activeTab.value !== 'all' ||
  coreFilter.value !== 'all' ||
  variantFilter.value !== 'all'
))

onMounted(load)

async function load() {
  loading.value = true
  try {
    const response = await api.romsPublic()
    roms.value = Array.isArray(response?.roms) ? response.roms : []
  } catch {
    roms.value = []
  } finally {
    loading.value = false
  }
}

function tabCount(key) {
  const allowed = new Set(tabGroups[key]?.platforms || [])
  return roms.value.filter((rom) => allowed.has(rom.platform)).length
}

function isClone(rom) {
  return Boolean(rom.parentRomId || rom.datParentSetName || rom.archiveLayout === 'split')
}

function matchesVariant(rom, value) {
  if (value === 'all') return true
  if (value === 'clone') return isClone(rom)
  return rom.variantKind === value
}

function searchableText(rom) {
  const platform = getPlatform(rom.platform)
  return arcadeSearchText(rom, [
    platform.displayName,
    platform.shortLabel,
    platform.manufacturer,
    isClone(rom) ? 'clone' : null,
  ], titleFor(rom))
}

const filtered = computed(() => {
  let list = roms.value
  if (activeTab.value === 'favorites') {
    list = list.filter((rom) => rom.isFavorite)
  } else if (activeTab.value !== 'all') {
    const allowed = new Set(tabGroups[activeTab.value]?.platforms || [])
    list = list.filter((rom) => allowed.has(rom.platform))
  }
  if (coreFilter.value !== 'all') {
    list = list.filter((rom) => rom.coreName === coreFilter.value)
  }
  list = list.filter((rom) => matchesVariant(rom, variantFilter.value))

  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  if (normalizedQuery) {
    list = list.filter((rom) => searchableText(rom).includes(normalizedQuery))
  }
  return list
})

function clearFilters() {
  query.value = ''
  activeTab.value = 'all'
  coreFilter.value = 'all'
  variantFilter.value = 'all'
}

function variantBadges(rom) {
  const labels = {
    official: '官方',
    hack: 'HACK',
    bootleg: 'BOOTLEG',
  }
  const badges = rom.variantKind && labels[rom.variantKind]
    ? [{ key: rom.variantKind, label: labels[rom.variantKind] }]
    : [{ key: 'unknown', label: '未分类' }]
  if (isClone(rom)) badges.push({ key: 'clone', label: 'CLONE' })
  if (rom.publicationMode === 'experimental') badges.push({ key: 'experimental', label: '实验' })
  return badges
}

function hasThumbnail(rom) {
  return Boolean(rom.thumbnailUrl && !failedThumbnailIds.value.has(rom.id))
}

function onThumbnailError(id) {
  const next = new Set(failedThumbnailIds.value)
  next.add(id)
  failedThumbnailIds.value = next
}

function thumbnailEvidence(rom) {
  if (!hasThumbnail(rom)) return '暂无截图'
  if (rom.thumbnailMatchKind === 'exact') return '本作截图'
  if (rom.thumbnailMatchKind === 'alias') return '别名图'
  if (rom.thumbnailMatchKind === 'parent' || rom.thumbnailMatchKind === 'source_reference') {
    return '参考图'
  }
  if (rom.thumbnailMatchKind === 'placeholder') return '占位图'
  return '图片来源未知'
}

function thumbnailEvidenceClass(rom) {
  if (!hasThumbnail(rom)) return 'evidence-missing'
  if (rom.thumbnailMatchKind === 'parent' || rom.thumbnailMatchKind === 'source_reference') {
    return 'evidence-reference'
  }
  return `evidence-${rom.thumbnailMatchKind || 'unknown'}`
}

function thumbnailAlt(rom) {
  return `${arcadeAccessibleTitle(rom, titleFor(rom))} 游戏截图`
}

function titleInitial(title) {
  return String(title || '?').trim().slice(0, 1).toLocaleUpperCase() || '?'
}

function coreDisplay(rom) {
  return [rom.coreName, rom.coreVersion].filter(Boolean).join(' · ') || '—'
}

function hardwareDisplay(rom) {
  return rom.hardwareFamily || getPlatform(rom.platform).displayName || rom.platform || '—'
}

function cardAriaLabel(rom) {
  return `游玩 ${arcadeAccessibleTitle(rom, titleFor(rom))}，${rom.versionLabel || '未标注'}`
}

function titleFor(rom) {
  return localizedTitles.value.get(rom) || getArcadeTitle(rom)
}

async function toggleFavorite(rom) {
  const previous = Boolean(rom.isFavorite)
  rom.isFavorite = !previous
  try {
    if (previous) await api.romUnfavorite(rom.id)
    else await api.romFavorite(rom.id)
  } catch (error) {
    rom.isFavorite = previous
    window.alert(error?.message || '操作失败')
  }
}

function play(rom) {
  if (!isAuthed.value && !(guestPlayEnabled.value && rom.isPublic)) {
    router.push(`/auth?redirect=${encodeURIComponent(`/play/${rom.id}`)}`)
    return
  }
  router.push(`/play/${rom.id}`)
}

function onCardKeydown(event, rom) {
  if (event.target !== event.currentTarget) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  play(rom)
}
</script>

<style scoped>
.gallery-page {
  --arcade-black: #05080c;
  --arcade-panel: #0a1016;
  --arcade-raised: #101922;
  --arcade-line: #1c3038;
  --arcade-line-strong: #31505b;
  --arcade-text: #f1f8fa;
  --arcade-muted: #9aafb5;
  --arcade-dim: #687e85;
  --arcade-cyan: #21e6ff;
  --arcade-magenta: #ff3bbd;
  --arcade-amber: #ffc247;
  --arcade-green: #4dff88;
  position: relative;
  isolation: isolate;
  min-height: calc(100vh - var(--header-h));
  min-height: calc(100dvh - var(--header-h));
  overflow: hidden;
  color: var(--arcade-text);
  background: var(--arcade-black);
}

.gallery-page,
.gallery-page * {
  letter-spacing: 0;
}

.gallery-page::before {
  position: absolute;
  z-index: 0;
  inset: 0;
  content: '';
  pointer-events: none;
  opacity: 0.42;
  background-image:
    repeating-linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0.018) 0,
      rgba(255, 255, 255, 0.018) 1px,
      transparent 1px,
      transparent 4px
    ),
    linear-gradient(rgba(33, 230, 255, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(33, 230, 255, 0.03) 1px, transparent 1px);
  background-size: auto, 32px 32px, 32px 32px;
}

.gallery-inner {
  position: relative;
  z-index: 1;
  max-width: 1500px;
  padding-bottom: 64px;
}

.gallery-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 0 16px;
  border-bottom: 1px solid var(--arcade-line);
}

.gallery-heading { min-width: 0; }

.gallery-kicker {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
  color: var(--arcade-cyan);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
}

.status-led {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border: 1px solid #a8ffc4;
  border-radius: 50%;
  background: var(--arcade-green);
  box-shadow: 0 0 8px rgba(77, 255, 136, 0.65);
}

.page-title {
  margin: 0;
  color: var(--arcade-text);
  font-size: 28px;
  font-weight: 760;
  line-height: 1.15;
}

.gallery-count {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 5px 0 0;
  color: var(--arcade-dim);
  font-family: var(--font-mono);
  font-size: 11px;
}

.gallery-count strong {
  color: var(--arcade-amber);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.gallery-head-actions {
  display: flex;
  align-items: center;
  justify-content: end;
  gap: 10px;
  min-width: 0;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 9px;
  width: min(380px, 40vw);
  height: 38px;
  padding: 0 11px;
  color: var(--arcade-dim);
  background: #070c11;
  border: 1px solid var(--arcade-line-strong);
  border-radius: 4px;
  transition: border-color var(--t-fast), box-shadow var(--t-fast);
}

.search-box:focus-within {
  color: var(--arcade-cyan);
  border-color: var(--arcade-cyan);
  box-shadow: 0 0 0 3px rgba(33, 230, 255, 0.14);
}

.search-box input {
  width: 100%;
  min-width: 0;
  height: 100%;
  padding: 0;
  color: var(--arcade-text);
  background: transparent;
  border: 0;
  outline: 0;
  font-family: inherit;
  font-size: 13px;
}

.search-box input::placeholder { color: var(--arcade-dim); }

.library-action,
.clear-filters {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 12px;
  color: #191004;
  background: var(--arcade-amber);
  border: 1px solid #ffe09a;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 750;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--t-fast), box-shadow var(--t-fast), transform var(--t-fast);
}

.library-action:hover,
.clear-filters:hover {
  color: #191004;
  background: #ffd371;
  box-shadow: 0 0 18px rgba(255, 194, 71, 0.18);
}

.library-action:focus-visible,
.clear-filters:focus-visible {
  outline: 2px solid var(--arcade-cyan);
  outline-offset: 3px;
}

.library-tabs {
  display: flex;
  align-items: stretch;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--arcade-line);
  scrollbar-width: none;
}

.library-tabs::-webkit-scrollbar { display: none; }

.library-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 42px;
  padding: 0 13px;
  color: var(--arcade-muted);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.library-tab:hover:not(:disabled) { color: var(--arcade-text); }
.library-tab:disabled { color: #465860; cursor: not-allowed; }
.library-tab.active {
  color: var(--arcade-cyan);
  border-bottom-color: var(--arcade-cyan);
  text-shadow: 0 0 12px rgba(33, 230, 255, 0.28);
}
.library-tab:focus-visible {
  outline: 2px solid var(--arcade-cyan);
  outline-offset: -3px;
}
.library-tab span {
  min-width: 20px;
  padding: 1px 5px;
  color: var(--arcade-dim);
  background: var(--arcade-raised);
  border: 1px solid var(--arcade-line);
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.favorite-tab svg { color: var(--arcade-amber); }

.filter-bar {
  display: flex;
  align-items: end;
  gap: 10px;
  padding: 12px 0 16px;
}

.filter-control {
  display: grid;
  gap: 4px;
  min-width: 150px;
  color: var(--arcade-dim);
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
}

.filter-control select {
  width: 100%;
  height: 34px;
  padding: 0 28px 0 9px;
  overflow: hidden;
  color: var(--arcade-text);
  background: #080d12;
  border: 1px solid var(--arcade-line);
  border-radius: 4px;
  outline: 0;
  font-family: inherit;
  font-size: 12px;
  text-overflow: ellipsis;
}

.filter-control select:focus-visible {
  border-color: var(--arcade-cyan);
  box-shadow: 0 0 0 3px rgba(33, 230, 255, 0.14);
}

.clear-filters {
  min-height: 34px;
  color: var(--arcade-muted);
  background: transparent;
  border-color: var(--arcade-line-strong);
  font-weight: 650;
}

.clear-filters:hover {
  color: var(--arcade-text);
  background: var(--arcade-raised);
  box-shadow: none;
}

.game-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(205px, 1fr));
  gap: 14px;
  align-items: stretch;
}

.game-card {
  position: relative;
  min-width: 0;
  overflow: hidden;
  color: var(--arcade-text);
  background: var(--arcade-panel);
  border: 1px solid var(--arcade-line);
  border-radius: 6px;
  outline: 0;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
  cursor: pointer;
  contain: layout paint style;
  content-visibility: auto;
  contain-intrinsic-size: 0 330px;
  transition: transform var(--t-fast) var(--ease-out), border-color var(--t-fast), box-shadow var(--t-fast);
}

.game-card::after {
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  content: '';
  pointer-events: none;
  background: var(--arcade-cyan);
  opacity: 0.62;
}
.game-card:nth-child(3n)::after { background: var(--arcade-magenta); }
.game-card:nth-child(5n)::after { background: var(--arcade-amber); }

.game-card:hover {
  z-index: 1;
  border-color: var(--arcade-line-strong);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.32), 0 0 20px rgba(33, 230, 255, 0.06);
  transform: translateY(-2px);
}

.game-card:focus-visible {
  z-index: 2;
  border-color: var(--arcade-cyan);
  outline: 2px solid var(--arcade-cyan);
  outline-offset: 3px;
  box-shadow: 0 0 0 1px #05080c, 0 0 24px rgba(33, 230, 255, 0.22);
}

.thumbnail-frame {
  position: relative;
  display: grid;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  place-items: center;
  background: #020406;
  border-bottom: 1px solid var(--arcade-line);
}

.thumbnail-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #020406;
}

.thumbnail-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 7px;
  color: var(--arcade-cyan);
  background-color: #070c11;
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent 5px,
    rgba(33, 230, 255, 0.055) 5px,
    rgba(33, 230, 255, 0.055) 6px
  );
  text-align: center;
}
.thumbnail-fallback span {
  font-family: var(--font-mono);
  font-size: 34px;
  font-weight: 800;
  line-height: 1;
  text-shadow: 0 0 14px rgba(33, 230, 255, 0.32);
}
.thumbnail-fallback small {
  color: var(--arcade-dim);
  font-family: var(--font-mono);
  font-size: 8px;
}

.thumbnail-evidence {
  position: absolute;
  z-index: 2;
  bottom: 7px;
  left: 7px;
  max-width: calc(100% - 50px);
  padding: 3px 6px;
  overflow: hidden;
  color: var(--arcade-green);
  background: rgba(2, 4, 6, 0.9);
  border: 1px solid rgba(77, 255, 136, 0.5);
  border-radius: 2px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.evidence-alias { color: var(--arcade-cyan); border-color: rgba(33, 230, 255, 0.52); }
.evidence-reference { color: var(--arcade-amber); border-color: rgba(255, 194, 71, 0.58); }
.evidence-placeholder,
.evidence-missing,
.evidence-unknown { color: var(--arcade-muted); border-color: rgba(154, 175, 181, 0.4); }

.favorite-button {
  position: absolute;
  z-index: 3;
  top: 8px;
  right: 8px;
  display: inline-grid;
  width: 31px;
  height: 31px;
  padding: 0;
  color: #d4e1e4;
  background: rgba(2, 4, 6, 0.88);
  border: 1px solid var(--arcade-line-strong);
  border-radius: 4px;
  place-items: center;
  cursor: pointer;
  transition: color var(--t-fast), border-color var(--t-fast), background var(--t-fast);
}
.favorite-button:hover,
.favorite-button:focus-visible {
  color: var(--arcade-amber);
  background: #10171d;
  border-color: var(--arcade-amber);
  outline: 0;
}
.favorite-button:focus-visible { box-shadow: 0 0 0 3px rgba(255, 194, 71, 0.2); }
.favorite-button.active { color: var(--arcade-amber); border-color: rgba(255, 194, 71, 0.7); }

.game-card-body {
  display: grid;
  gap: 11px;
  min-width: 0;
  padding: 11px 12px 12px;
}

.game-card-heading {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.game-title {
  display: -webkit-box;
  min-height: 38px;
  margin: 0;
  overflow: hidden;
  color: var(--arcade-text);
  font-size: 14px;
  font-weight: 720;
  line-height: 1.35;
  text-overflow: ellipsis;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.game-title-en {
  display: -webkit-box;
  min-height: 30px;
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--arcade-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.45;
  opacity: 0.58;
  text-overflow: ellipsis;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.variant-badges {
  display: flex;
  min-height: 19px;
  gap: 5px;
  overflow: hidden;
}

.variant-badge {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  color: var(--arcade-green);
  background: rgba(77, 255, 136, 0.07);
  border: 1px solid rgba(77, 255, 136, 0.3);
  border-radius: 2px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 800;
  white-space: nowrap;
}
.variant-hack { color: var(--arcade-magenta); background: rgba(255, 59, 189, 0.07); border-color: rgba(255, 59, 189, 0.38); }
.variant-bootleg { color: var(--arcade-amber); background: rgba(255, 194, 71, 0.07); border-color: rgba(255, 194, 71, 0.38); }
.variant-clone { color: var(--arcade-cyan); background: rgba(33, 230, 255, 0.07); border-color: rgba(33, 230, 255, 0.35); }
.variant-unknown { color: var(--arcade-muted); background: rgba(154, 175, 181, 0.06); border-color: rgba(154, 175, 181, 0.3); }
.variant-experimental { color: var(--arcade-amber); background: rgba(255, 194, 71, 0.07); border-color: rgba(255, 194, 71, 0.38); }

.game-metadata {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px 10px;
  min-width: 0;
  margin: 0;
  padding-top: 10px;
  border-top: 1px solid var(--arcade-line);
}
.game-metadata div { min-width: 0; }
.game-metadata dt {
  margin: 0 0 2px;
  color: var(--arcade-dim);
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 700;
  text-transform: uppercase;
}
.game-metadata dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--arcade-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-set { color: var(--arcade-cyan) !important; }

.game-card-skeleton { cursor: default; }
.game-card-skeleton::after { display: none; }
.game-card-skeleton .thumbnail-frame { border-radius: 0; }
.skeleton-lines {
  display: grid;
  gap: 8px;
  padding: 13px 12px 16px;
}
.skeleton-lines span { display: block; height: 10px; }
.skeleton-lines span:nth-child(1) { width: 78%; }
.skeleton-lines span:nth-child(2) { width: 52%; }
.skeleton-lines span:nth-child(3) { width: 66%; }

.gallery-empty {
  display: grid;
  min-height: 260px;
  place-content: center;
  justify-items: center;
  gap: 9px;
  border-top: 1px solid var(--arcade-line);
  border-bottom: 1px solid var(--arcade-line);
  text-align: center;
}
.gallery-empty h2 { margin: 0; font-size: 16px; }
.empty-code { color: var(--arcade-magenta); font-family: var(--font-mono); font-size: 10px; font-weight: 800; }

@media (max-width: 900px) {
  .gallery-head { align-items: stretch; flex-direction: column; gap: 14px; }
  .gallery-head-actions { justify-content: stretch; }
  .search-box { width: 100%; }
}

@media (max-width: 600px) {
  .gallery-inner { padding: 0 12px 48px; }
  .gallery-head { padding-top: 18px; }
  .page-title { font-size: 24px; }
  .gallery-head-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }
  .search-box { grid-column: 1 / -1; max-width: none; }
  .library-tab { height: 40px; padding: 0 11px; }
  .filter-bar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
  .filter-control { min-width: 0; }
  .clear-filters { grid-column: 1 / -1; width: max-content; }
  .game-grid { grid-template-columns: 1fr; gap: 12px; }
  .game-card { contain-intrinsic-size: 0 420px; }
}

@media (prefers-reduced-motion: reduce) {
  .game-card,
  .library-action,
  .clear-filters { transition: none; }
  .game-card:hover { transform: none; }
}
</style>
