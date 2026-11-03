<script setup lang="ts">
// 登录卡：左 QR 白底卡 | 右 四步 stepper + 其他登录方式 + 音质档位。
//
// 扫码登录两个来源的二维码形态不一样：
// - 网易云：后端只给 unikey 与登录页 URL，页面用插件自带的纯前端编码器画成 SVG
//   （v3/music-rs/ui/qr.js，与原生版同一份实现）；
// - QQ 音乐：后端给的是官方 PNG 二维码（data URL），页面直接 <img> 渲染。
// 两个来源都是拿到二维码后每 2 秒轮询一次登录状态，页面文案只反映后端回的状态：
// 等待扫码 / 已扫码待确认 / 已过期 / 登录成功；手动粘贴 Cookie 始终保留为回退。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NTag } from 'naive-ui'
import { ClipboardPaste as ClipboardIcon, QrCode as QrCodeIcon } from '@lucide/vue'
import { ALL_QUALITIES, SOURCES, useMusicStore } from '../store'
import { encodeQr, qrSvgPath } from '../plugin-api'
import QualityTag from './QualityTag.vue'

const store = useMusicStore()
const { login, loginSource, qr, qrStatus, qrBusy, qrMessage, qrTitle, qrSub, settings, busy, cookieText, cookiePanelOpen } =
  store

/** QQ 的官方二维码图片（data URL）；网易云没有这个字段。 */
const qrImage = computed<string>(() => qr.value?.image ?? '')

/** 二维码 SVG（只有网易云用：内容为空或编码失败时给占位）。 */
const qrSvg = computed<{ path: string; viewBox: string; error: string }>(() => {
  if (qrImage.value) return { path: '', viewBox: '', error: '' }
  const content = qr.value?.content
  if (!content) return { path: '', viewBox: '', error: '' }
  try {
    const code = encodeQr(content, 'M')
    return { path: qrSvgPath(code), viewBox: `0 0 ${code.size + 8} ${code.size + 8}`, error: '' }
  } catch (error) {
    return { path: '', viewBox: '', error: String((error as { message?: string })?.message ?? error) }
  }
})

/** 剩余有效期（秒）——二维码区下面显示倒计时。
 *  now 每秒跳一次，只当「重算节拍」用；剩余时间按当下时刻算，
 *  免得节拍滞后 1 秒就把倒计时多显示一秒。 */
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
const qrRemaining = computed<number>(() => {
  const tick = now.value
  const expiresAt = qr.value?.expiresAt
  if (!expiresAt) return 0
  return Math.max(0, Math.ceil((expiresAt - Math.max(tick, Date.now())) / 1000))
})

onMounted(() => {
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
})

/** 四步 stepper 的状态（按真实扫码状态机点亮）。 */
const steps = computed(() => {
  const status = qrStatus.value
  const states = [
    status === '' ? (qrBusy.value ? 'active' : 'pending') : 'done',
    status === 'waiting'
      ? 'active'
      : ['scanned', 'success', 'no-login'].includes(status)
        ? 'done'
        : ['expired', 'failed'].includes(status)
          ? 'error'
          : 'pending',
    status === 'scanned' ? 'active' : ['success', 'no-login'].includes(status) ? 'done' : 'pending',
    status === 'success' ? 'done' : status === 'no-login' ? 'error' : 'pending',
  ]
  return ['生成二维码', '等待扫码', '手机确认', '登录成功'].map((label, index) => ({
    label,
    state: states[index],
  }))
})

/** 两个来源的登录态标签。 */
const loginTags = computed(() => [
  { key: 'netease', name: '网易云', info: login.netease },
  { key: 'qq', name: 'QQ音乐', info: login.qq },
])

const cookiePlaceholder = computed(
  () =>
    `浏览器登录 ${loginSource.value === 'qq' ? 'y.qq.com' : 'music.163.com'} 后，` +
    'F12 → Network → 任选一个请求 → 复制请求头里的 Cookie 整行粘贴到这里',
)
</script>

<template>
  <div class="login-grid">
    <!-- 左：二维码（QQ 官方 PNG 图 / 网易云本地编码 SVG） -->
    <div class="qr-pane">
      <div class="qr-frame" :class="`qr-frame--${qrStatus || 'idle'}`">
        <span v-for="corner in 4" :key="corner" class="qr-corner" aria-hidden="true" />
        <span v-if="qrStatus === 'waiting'" class="qr-pulse" aria-hidden="true" />
        <div class="qr-box">
          <img v-if="qrImage" class="qr-img" :src="qrImage" alt="扫码登录二维码" />
          <svg
            v-else-if="qrSvg.path"
            class="qr-svg"
            :viewBox="qrSvg.viewBox"
            shape-rendering="crispEdges"
            role="img"
            aria-label="扫码登录二维码"
          >
            <rect width="100%" height="100%" fill="#ffffff" />
            <g transform="translate(4 4)">
              <path :d="qrSvg.path" fill="#000000" />
            </g>
          </svg>
          <div v-else-if="qrSvg.error" class="qr-fallback qr-fallback--error">{{ qrSvg.error }}</div>
          <div v-else class="qr-fallback">
            <QrCodeIcon :size="28" aria-hidden="true" />
            <span>{{ qrBusy ? '生成中…' : '未生成' }}</span>
          </div>
          <span v-if="qrStatus === 'waiting'" class="qr-scan" aria-hidden="true" />
          <span v-if="qrStatus === 'scanned' || qrStatus === 'success'" class="qr-veil" aria-hidden="true">
            {{ qrStatus === 'success' ? '✓' : '✓ 已扫码' }}
          </span>
        </div>
      </div>
      <div class="qr-title" aria-live="polite">{{ qrTitle }}</div>
      <div class="qr-sub">{{ qrSub }}</div>
      <p v-if="qrMessage" class="hint">{{ qrMessage }}</p>
      <p v-if="qr" class="hint qr-meta">
        {{ store.sourceName(qr.source) }} · 剩余 {{ qrRemaining }} 秒 · 每 2 秒轮询一次
      </p>
    </div>

    <!-- 右：操作区 -->
    <div class="login-side">
      <div class="row">
        <span class="seg">
          <button
            v-for="item in SOURCES"
            :key="item.id"
            type="button"
            :class="{ on: loginSource === item.id }"
            @click="store.switchLoginSource(item.id as 'netease' | 'qq')"
          >
            {{ item.name }}
          </button>
        </span>
        <NButton size="small" type="primary" round :loading="qrBusy" @click="store.createQr(loginSource)">
          获取二维码
        </NButton>
        <NButton v-if="qr" size="small" secondary @click="store.resetQr()">关闭</NButton>
        <span class="spacer" />
        <span class="hint-inline">当前登录状态:</span>
        <NTag
          v-for="item in loginTags"
          :key="item.key"
          size="small"
          :bordered="false"
          :type="item.info.logged_in ? 'success' : 'default'"
        >
          {{ item.name }} {{ item.info.logged_in ? '已登录' : '未登录' }}
          <template v-if="item.info.logged_in && item.info.uin"> · uin {{ item.info.uin }}</template>
        </NTag>
      </div>

      <!-- 四步 stepper：按扫码状态机真实点亮 -->
      <div class="stepper">
        <div v-for="(step, index) in steps" :key="step.label" class="step" :class="step.state">
          <span class="step-dot">
            <template v-if="step.state === 'done'">✓</template>
            <template v-else-if="step.state === 'error'">!</template>
            <template v-else>{{ index + 1 }}</template>
          </span>
          <span class="step-label">{{ step.label }}</span>
        </div>
      </div>

      <div class="mini-title">其他登录方式</div>
      <div class="row">
        <NButton size="small" secondary @click="store.toggleCookiePanel()">
          <template #icon><ClipboardIcon :size="14" /></template>
          粘贴整行 Cookie
        </NButton>
        <span class="hint-inline">密钥与 Cookie 永不回显</span>
      </div>

      <div v-if="cookiePanelOpen" class="cookie-panel">
        <NInput
          v-model:value="cookieText"
          type="textarea"
          :rows="3"
          :placeholder="cookiePlaceholder"
          :input-props="{ 'aria-label': '粘贴整行 Cookie' }"
          class="cookie-input"
        />
        <div class="row">
          <NButton size="small" type="primary" :loading="busy === 'paste'" @click="store.pasteCookie()">
            保存 {{ store.sourceName(loginSource) }} Cookie
          </NButton>
          <span class="hint-inline">扫码没取到登录态时的回退：浏览器登录后复制整行 Cookie 粘贴</span>
        </div>
      </div>

      <div class="mini-title">音质档位</div>
      <div class="chips">
        <QualityTag v-for="value in ALL_QUALITIES" :key="value" :quality="value" :selected="value === settings.quality" />
      </div>
      <p class="hint">
        默认: {{ store.qualityLabel(settings.quality) }} · 可选档位随来源不同 · 未登录仅可浏览，登录后可入队下载
      </p>
      <p class="hint">下载与音质依赖对应平台会员：网易云 SVIP（母带/臻音）、QQ 绿钻（FLAC 及以上）。</p>
    </div>
  </div>
</template>

<style scoped>
.login-grid {
  display: grid;
  grid-template-columns: 270px minmax(0, 1fr);
  gap: 24px;
}

@container page (max-width: 719.98px) {
  .login-grid {
    grid-template-columns: 1fr;
  }
}

.qr-pane {
  display: grid;
  gap: 8px;
  justify-items: center;
  align-content: start;
  padding: 18px 12px 14px;
  border-radius: 16px;
  text-align: center;
  background:
    radial-gradient(90% 70% at 50% 0%, color-mix(in srgb, var(--mx-accent, #2080f0) 16%, transparent), transparent 70%),
    color-mix(in srgb, var(--app-bg, transparent) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--app-border, #e0e4ea) 70%, transparent);
}

/* 二维码外框：四角取景框 + 等待扫码时的呼吸光圈 */
.qr-frame {
  --tone: var(--mx-accent, var(--app-accent, #2080f0));
  position: relative;
  padding: 10px;
}

.qr-frame--success,
.qr-frame--scanned {
  --tone: var(--mx-ok, #18a058);
}

.qr-frame--expired,
.qr-frame--failed,
.qr-frame--no-login {
  --tone: var(--mx-err, #d03050);
}

.qr-corner {
  position: absolute;
  width: 22px;
  height: 22px;
  border: 3px solid var(--tone);
  opacity: 0.85;
  transition: border-color 0.3s ease;
}

.qr-corner:nth-child(1) {
  top: 0;
  left: 0;
  border-right: none;
  border-bottom: none;
  border-radius: 10px 0 0 0;
}

.qr-corner:nth-child(2) {
  top: 0;
  right: 0;
  border-left: none;
  border-bottom: none;
  border-radius: 0 10px 0 0;
}

.qr-corner:nth-child(3) {
  bottom: 0;
  left: 0;
  border-right: none;
  border-top: none;
  border-radius: 0 0 0 10px;
}

.qr-corner:nth-child(4) {
  bottom: 0;
  right: 0;
  border-left: none;
  border-top: none;
  border-radius: 0 0 10px 0;
}

.qr-pulse {
  position: absolute;
  inset: 10px;
  border-radius: 12px;
  pointer-events: none;
  animation: qr-pulse 2s ease-out infinite;
}

.qr-box {
  position: relative;
  width: 220px;
  height: 220px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid var(--app-border, #e0e4ea);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  box-shadow: 0 10px 30px -18px color-mix(in srgb, var(--app-text, #000) 60%, transparent);
}

.qr-frame--expired .qr-box > :not(.qr-veil) {
  opacity: 0.25;
  filter: grayscale(1);
}

.qr-svg {
  width: 100%;
  height: 100%;
}

.qr-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* QQ 官方二维码原图很小（72px），放大时保持方块边缘不糊。 */
  image-rendering: pixelated;
}

/* 扫描线：细而半透明，不挡二维码识别 */
.qr-scan {
  position: absolute;
  left: 6%;
  right: 6%;
  top: 0;
  height: 2px;
  border-radius: 2px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--tone), transparent);
  box-shadow: 0 0 12px 2px color-mix(in srgb, var(--tone) 45%, transparent);
  opacity: 0.55;
  animation: qr-scan 2.4s ease-in-out infinite;
}

.qr-veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 700;
  color: var(--mx-ok, #18a058);
  background: color-mix(in srgb, #fff 78%, transparent);
  backdrop-filter: blur(2px);
  animation: qr-veil 0.3s ease-out;
}

.qr-fallback {
  display: grid;
  justify-items: center;
  gap: 6px;
  /* 二维码底板固定白色，这里的字也固定深色才看得清 */
  color: #5f6670;
  font-size: 12px;
  padding: 12px;
  text-align: center;
}

.qr-fallback--error {
  color: #c02848;
}

.qr-title {
  font-size: 15px;
  font-weight: 700;
}

.qr-sub {
  font-size: 12px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
}

.qr-meta {
  font-variant-numeric: tabular-nums;
}

.login-side {
  display: grid;
  gap: 14px;
  align-content: start;
  min-width: 0;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.hint {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
  margin: 0;
  line-height: 1.6;
}

.hint-inline {
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
  font-size: 12px;
}

.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--app-border, #e0e4ea);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-bg, transparent) 60%, transparent);
}

.seg button {
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--app-text-secondary, inherit);
  padding: 4px 14px;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.seg button.on {
  background: var(--mx-accent, var(--app-accent, #2080f0));
  color: #fff;
  box-shadow: 0 4px 12px -6px var(--mx-accent, #2080f0);
}

.seg button:focus-visible {
  outline: 2px solid var(--mx-accent, #2080f0);
  outline-offset: 1px;
}

/* 四步 stepper：圆点 + 连接线，按状态着色 */
.stepper {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  padding: 4px 0;
}

@container page (max-width: 479.98px) {
  .stepper {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: 10px;
  }

  .step:nth-child(2)::after {
    display: none;
  }
}

.step {
  --tone: var(--app-text-secondary, #8a919c);
  position: relative;
  display: grid;
  justify-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.45));
}

.step:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 11px;
  left: calc(50% + 16px);
  right: calc(-50% + 16px);
  height: 2px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--tone) 35%, var(--app-border, #e0e4ea));
}

.step-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--tone) 60%, transparent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--tone);
  background: var(--app-surface, #fff);
  transition:
    background-color 0.3s ease,
    border-color 0.3s ease;
}

.step.active {
  --tone: var(--mx-accent, #2080f0);
  color: var(--tone);
  font-weight: 600;
}

.step.active .step-dot {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone) 18%, transparent);
  animation: step-ping 1.8s ease-in-out infinite;
}

.step.done {
  --tone: var(--mx-ok, #18a058);
  color: var(--tone);
}

.step.error {
  --tone: var(--mx-err, #d03050);
  color: var(--tone);
}

.step.done .step-dot,
.step.error .step-dot {
  background: var(--tone);
  border-color: var(--tone);
  color: #fff;
}

.mini-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--app-text-secondary, rgba(0, 0, 0, 0.6));
}

.cookie-panel {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px dashed color-mix(in srgb, var(--mx-accent, #2080f0) 40%, var(--app-border, #e0e4ea));
  border-radius: 12px;
  background: color-mix(in srgb, var(--mx-accent, #2080f0) 4%, transparent);
}

.cookie-input {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

@keyframes qr-scan {
  0%,
  100% {
    transform: translateY(8px);
  }
  50% {
    transform: translateY(210px);
  }
}

@keyframes qr-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone) 45%, transparent);
  }
  100% {
    box-shadow: 0 0 0 14px transparent;
  }
}

@keyframes qr-veil {
  from {
    opacity: 0;
  }
}

@keyframes step-ping {
  50% {
    box-shadow: 0 0 0 7px color-mix(in srgb, var(--tone) 8%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .qr-scan,
  .qr-pulse,
  .qr-veil,
  .step.active .step-dot {
    animation: none;
  }

  .qr-scan {
    top: 50%;
  }

  .qr-corner,
  .seg button,
  .step-dot {
    transition: none;
  }
}
</style>
