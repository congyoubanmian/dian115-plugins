<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'

const props = defineProps<{ api: { invokeAction(a: string, i?: any): Promise<any>; refresh(): Promise<any> }; runtimeState?: any }>()
const message = useMessage()

const state = computed<any>(() => props.runtimeState || {})
const source = ref('netease')
const query = ref('')
const searching = ref(false)
const results = ref<any[]>([])
const taskPoll = ref<any>(null)
const tasks = ref<any[]>([])

const sources = [
  { id: 'netease', name: '网易云', qualities: ['jymaster', 'jyeffect', 'sky', 'hires', 'lossless', 'exhigh', 'standard'] },
  { id: 'qq', name: 'QQ音乐', qualities: ['flac', '320', '128'] },
  { id: 'kugou', name: '酷狗', qualities: ['flac', '320', '128'] },
]
const qualityLabels: Record<string, string> = { jymaster: '超清母带', jyeffect: '高清臻音', sky: '沉浸环绕', hires: 'Hi-Res', lossless: '无损', dolby: '杜比', exhigh: '极高', standard: '标准', flac: '无损 FLAC', 320: '320K', 128: '128K' }

const qr = ref<{ source: string; qr_dataurl: string; key: string } | null>(null)
const qrStatus = ref('')
const qrMessage = ref('')
const cookieInput = ref('')
const cookieSource = ref('netease')
const logins = ref<Record<string, boolean>>({})
const qrPolling = ref(false)

const settings = computed<any>(() => state.value?.settings || {})
const history = computed<any[]>(() => state.value?.history || [])

const logged = computed<Record<string, boolean>>(() => {
  // 登录态由 agent /session/status 判断; 简化: 通过 action 透传查询
  return (state.value?.logged || {})
})

async function invoke(action: string, input: any = {}) {
  const r = await props.api.invokeAction(action, input)
  const inner = (r as any)?.result || r  // 宿主 bridge 返回包装对象, 业务结果在 result 里
  if (inner?.status === 'failed') throw new Error(inner.message || '操作失败')
  return inner
}

async function doSearch() {
  if (!query.value.trim()) return
  searching.value = true
  try {
    const r = await invoke('search', { source: source.value, query: query.value, page: 1 })
    results.value = r?.songs || []
    if (!results.value.length) message.info('没有搜索到内容')
  } catch (e: any) {
    message.error(e?.message || '搜索失败')
  } finally {
    searching.value = false
  }
}

async function createQR(src: string) {
  qrStatus.value = ''
  try {
    const r = await invoke('agent-get', { path: `/qr/create?source=${src}` })
    const d = r.data || {}
    qr.value = { source: src, qr_dataurl: d.qr_dataurl, key: d.key }
    qrPolling.value = true
    pollQR(src, d.key)
  } catch (e: any) { message.error(e?.message || '二维码获取失败') }
}

let pollTimer: any = null
function pollQR(src: string, key: string) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    if (!qrPolling.value) return
    try {
      const r = await invoke('agent-get', { path: `/qr/poll?source=${src}&key=${encodeURIComponent(key)}` })
      const d = r.data || {}
      qrStatus.value = d.status || ''
      qrMessage.value = d.message || ''
      if (r.status === 'success') {
        qrPolling.value = false
        message.success('登录成功')
        qr.value = null
        return
      }
      if (r.status === 'expired') { qrPolling.value = false; qrStatus.value = 'expired'; message.warning('二维码已过期，请重新获取'); return }
    } catch {}
    pollQR(src, key)
  }, 2000)
}

async function saveCookie() {
  if (!cookieInput.value.trim()) return
  try {
    await invoke('agent-post', { path: '/session/save', payload: { source: cookieSource.value, cookies: parseCookie(cookieInput.value) } })
    message.success('Cookie 已保存')
    cookieInput.value = ''
    await checkLogin()
  } catch (e: any) { message.error(e?.message || '保存失败') }
}

function parseCookie(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

async function checkLogin() {
  try {
    const r = await invoke('agent-get', { path: '/session/status' })
    const d = (r.data || {}) as Record<string, any>
    logins.value = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'object' && v !== null && Object.keys(v).length > 0]))
  } catch {}
}

async function download(s: any) {
  try {
    await invoke('download', { source: s.source || source.value, id: s.id, hash: s.hash || '', name: s.name, singers: s.singers, quality: s.quality })
    message.success(`已提交下载: ${s.name}`)
    setTimeout(refreshTasks, 1500)
  } catch (e: any) { message.error(e?.message || '下载失败') }
}

async function refreshTasks() {
  try {
    const r = await invoke('agent-get', { path: '/tasks' })
    tasks.value = r?.data?.tasks || []
  } catch {}
}

onMounted(() => { refreshTasks(); checkLogin() })
</script>

<template>
  <main class="dian-plugin-page page">
    <header class="head">
      <div>
        <h2>音乐下载</h2>
        <p>网易云 / QQ / 酷狗 · 下载后写入 115 音乐目录自动入库</p>
      </div>
      <n-button size="small" @click="refreshTasks">刷新任务</n-button>
    </header>

    <section class="card">
      <h3>扫码登录</h3>
      <div class="row">
        <n-button v-for="s in sources" :key="s.id" size="small" :type="source === s.id ? 'primary' : 'default'" @click="source = s.id; qr = null">{{ s.name }}</n-button>
        <n-button v-if="source === 'qq'" size="small" @click="createQR('qq') === undefined ? createQR('qq') : createQR('qq')">微信码</n-button>
        <n-button size="small" @click="createQR(source)">获取二维码</n-button>
      </div>
      <div v-if="qr" class="qr">
        <img :src="qr.qr_dataurl" alt="二维码" width="220" />
        <p v-if="qrStatus === 'scanned'">✓ 已扫码，请在手机上确认</p>
        <p v-else-if="qrStatus === 'waiting'">等待扫码…（用对应音乐 App 的扫一扫）</p>
        <p v-else-if="qrStatus === 'expired'">二维码已过期，请重新获取</p>
        <p v-else>正在生成二维码…</p>
      </div>
      <p class="hint">下载与音质依赖对应平台会员：网易云 SVIP（母带）、QQ 绿钻（FLAC）、酷狗 VIP。</p>

      <n-divider style="margin: 6px 0" />
      <h4 class="sub">Cookie 登录（网易云扫码已被官方风控停用，推荐用此方式）</h4>
      <div class="row">
        <select v-model="cookieSource" class="sel">
          <option value="netease">网易云</option>
          <option value="qq">QQ音乐</option>
          <option value="kugou">酷狗</option>
        </select>
        <input v-model="cookieInput" class="input" placeholder="粘贴浏览器 Cookie（如 MUSIC_U=xxx; 或整条 cookie）" />
        <n-button size="small" type="primary" @click="saveCookie">保存</n-button>
        <n-button size="small" @click="checkLogin">检查登录</n-button>
      </div>
      <p class="hint">
        获取方式：浏览器登录 music.163.com → F12 → Network → 任意请求的 Cookie 头，复制整段粘贴过来（关键字段 <code>MUSIC_U</code>）。
      </p>
      <p class="hint">
        当前登录状态：
        <n-tag v-for="(v, k) in logins" :key="k" size="small" :type="v ? 'success' : 'default'" style="margin-right:6px">
          {{ k }} {{ v ? '已登录' : '未登录' }}
        </n-tag>
      </p>
    </section>

    <section class="card">
      <h3>搜索</h3>
      <div class="row">
        <input v-model="query" class="input" placeholder="歌名 歌手" @keydown.enter="doSearch" />
        <n-button type="primary" size="small" :loading="searching" @click="doSearch">搜索</n-button>
      </div>
      <table v-if="results.length" class="tbl">
        <thead><tr><th>歌曲</th><th>歌手</th><th>专辑</th><th>音质</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in results" :key="s.id">
            <td>{{ s.name }}</td>
            <td>{{ s.singers }}</td>
            <td class="dim">{{ s.album }}</td>
            <td><n-tag size="small">{{ qualityLabels[s.quality] || s.quality || '自动' }}</n-tag></td>
            <td><n-button size="tiny" type="primary" @click="download(s)">下载</n-button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h3>下载任务</h3>
      <table v-if="tasks.length" class="tbl">
        <tbody>
          <tr v-for="t in tasks" :key="t.id">
            <td>{{ t.singers }} - {{ t.name }}</td>
            <td>{{ t.status === 'downloading' ? `下载中 ${t.progress}%` : t.status === 'done' ? '✓ 已完成' : '✗ ' + (t.message || '失败') }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">暂无任务</p>
    </section>

    <section class="card">
      <h3>历史</h3>
      <table v-if="history.length" class="tbl">
        <tbody>
          <tr v-for="(h, i) in history.slice(0, 20)" :key="i">
            <td>{{ h.song }}</td><td class="dim">{{ h.quality }}</td><td class="dim">{{ h.result }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">暂无历史</p>
    </section>
  </main>
</template>

<script lang="ts">
import { NButton, NDivider, NTag } from 'naive-ui'
export default { components: { NButton, NDivider, NTag } }
</script>

<style scoped>
.page { display: grid; gap: var(--dian-space-4); }
.head { display: flex; justify-content: space-between; align-items: center; }
h2 { margin: 0; font-size: 22px; color: var(--dian-text-primary); }
h3 { margin: 0 0 8px; font-size: 15px; color: var(--dian-text-primary); }
p { margin: 4px 0; color: var(--dian-text-secondary); }
.card { border: 1px solid var(--dian-border); border-radius: var(--dian-radius-lg, 12px); background: var(--dian-surface-raised); padding: 14px; display: grid; gap: 8px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.input { flex: 1; min-width: 200px; padding: 6px 10px; border: 1px solid var(--dian-border); border-radius: 8px; background: var(--dian-surface); color: var(--dian-text-primary); }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dian-divider); }
.dim { color: var(--dian-text-muted); }
.hint { color: var(--dian-text-muted); font-size: 12px; }
.sub { margin: 4px 0; font-size: 14px; color: var(--dian-text-primary); }
.sel { padding: 6px 8px; border: 1px solid var(--dian-border); border-radius: 8px; background: var(--dian-surface); color: var(--dian-text-primary); }
.qr { display: grid; justify-items: center; gap: 4px; }
</style>
