// 冒烟检查：把构建产物 v3/<plugin>/ui/page.js 在 Node 里用最小 DOM 垫片挂一次。
//
// 检查的是宿主真正会做的事（见 v3-kit/docs/ui-theme.md）：
// 1. import ESM 产物，拿到导出的 mount；
// 2. 造一个宿主 ctx（api/storage/settings/tasks/http/theme/signal）；
// 3. mount(el, ctx) 不抛错，页面上真的渲染出了内容；
// 4. 宿主切主题（ctx.theme.subscribe 回调）后，naive-ui 的主题变量跟着变；
// 5. mount 返回的清理函数可调用，调用后 DOM 被清空（app 被卸载）、主题退订。
//
// 用法：node v3-ui/scripts/smoke-mount.mjs [chase-rs|music-rs|douban-rs]

import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installMiniDom } from './mini-dom.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

const PLUGINS = ['chase-rs', 'music-rs', 'douban-rs']
const target = process.argv[2]
if (!PLUGINS.includes(target)) {
  console.error(`用法：node v3-ui/scripts/smoke-mount.mjs <${PLUGINS.join('|')}>`)
  process.exit(2)
}

/** 造一个够用的宿主 ctx：只实现页面真会调用的那几项。 */
function createHostContext(pluginId) {
  const themeListeners = new Set()
  const controller = new AbortController()
  return {
    id: pluginId,
    signal: controller.signal,
    theme: {
      mode: 'light',
      subscribe(fn) {
        themeListeners.add(fn)
        fn('light')
        return () => themeListeners.delete(fn)
      },
    },
    api: {
      async get() {
        return {}
      },
      async post() {
        return {}
      },
    },
    storage: {
      async get() {
        return null
      },
      async set() {
        return { revision: 1 }
      },
      async remove() {
        return {}
      },
      async list() {
        return []
      },
    },
    settings: {
      async get() {
        return {}
      },
      async set() {
        return { revision: 1 }
      },
    },
    tasks: {
      async run() {
        return { id: 'smoke' }
      },
      async list() {
        return []
      },
      async get() {
        return { id: 'smoke' }
      },
      async cancel() {
        return {}
      },
      async retry() {
        return { id: 'smoke' }
      },
    },
    http: {
      async request() {
        return { status: 200, body: '' }
      },
    },
    files: {
      async call() {
        return { task_id: 'smoke' }
      },
      async start() {
        return { task_id: 'smoke' }
      },
      downloadURL() {
        return 'https://localhost/smoke'
      },
      async upload() {
        return {}
      },
    },
    cd2: {
      async call() {
        return {}
      },
    },
    watch: {
      async list() {
        return []
      },
      async add() {
        return {}
      },
      async remove() {
        return {}
      },
    },
    notifications: {
      async send() {
        return {}
      },
      async channels() {
        return []
      },
    },
    async cookiecloud() {
      return {}
    },
    // 供测试驱动主题切换
    __themeListeners: themeListeners,
  }
}

/** 从渲染结果里找一个 naive-ui 组件，读它的 --n-color 主题变量。 */
function readThemeColor(container) {
  for (const node of container.querySelectorAll('.n-card, .n-tag, .n-button')) {
    const value = node.style.getPropertyValue('--n-color')
    if (value) return value
  }
  return ''
}

const document = installMiniDom()
const container = document.createElement('div')
document.body.appendChild(container)

const entry = resolve(root, 'v3', target, 'ui', 'page.js')
const mod = await import(pathToFileURL(entry).href)

if (typeof mod.mount !== 'function') {
  console.error(`✗ ${target}: 产物没有导出 mount`)
  process.exit(1)
}

const ctx = createHostContext(target)
let cleanup
try {
  cleanup = mod.mount(container, ctx)
} catch (error) {
  console.error(`✗ ${target}: mount 抛错：${error?.stack ?? error}`)
  process.exit(1)
}

// Vue 的渲染是异步的（微任务），等一拍再看 DOM。
await new Promise((r) => setTimeout(r, 50))

const html = container.innerHTML
if (!html || html.length < 20) {
  console.error(`✗ ${target}: mount 后容器没有渲染出内容（innerHTML 长度 ${html.length}）`)
  process.exit(1)
}

if (typeof cleanup !== 'function') {
  console.error(`✗ ${target}: mount 没有返回清理函数`)
  process.exit(1)
}

// 主题：宿主切到 dark 后，naive-ui 的主题变量要跟着变。
const lightColor = readThemeColor(container)
for (const fn of ctx.__themeListeners) fn('dark')
await new Promise((r) => setTimeout(r, 100))
const darkColor = readThemeColor(container)
if (!lightColor || !darkColor || lightColor === darkColor) {
  console.error(`✗ ${target}: 主题切换没生效（浅色 ${lightColor} → 深色 ${darkColor}）`)
  process.exit(1)
}

cleanup()
await new Promise((r) => setTimeout(r, 50))

if (container.innerHTML.length !== 0) {
  console.error(`✗ ${target}: 清理后容器仍有 ${container.innerHTML.length} 字节内容`)
  process.exit(1)
}
if (ctx.__themeListeners.size !== 0) {
  console.error(`✗ ${target}: 清理后主题订阅没有退订（还剩 ${ctx.__themeListeners.size} 个）`)
  process.exit(1)
}

console.log(
  `✓ ${target}: mount 成功，渲染 ${html.length} 字节；主题切换生效（${lightColor} → ${darkColor}）；` +
    '清理函数可调用，卸载后 DOM 清空且主题退订',
)
