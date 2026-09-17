<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'

const props = defineProps<{ api: { invokeAction(a: string, i?: any): Promise<any>; refresh(): Promise<any> }; runtimeState?: any }>()
const message = useMessage()

interface HookConfig {
  id: string
  name: string
  platform: string
  webhook: string
  secret: string
  proxy: string
  enabled: boolean
}

const state = computed<any>(() => props.runtimeState || {})
const status = computed(() => state.value?.status || '')
const lastMessage = computed(() => state.value?.last_message || '')
const history = computed<any[]>(() => state.value?.history || [])
const logs = computed<any[]>(() => state.value?.logs || [])

const platforms = [
  { id: 'wecom', name: '企业微信', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', hint: '群聊右键 → 添加群机器人 → 复制 Webhook 地址。若群机器人限制了出口 IP，可填代理地址经 music-agent 固定出口。' },
  { id: 'feishu', name: '飞书', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', hint: '群设置 → 群机器人 → 添加 Custom Bot。开启签名校验后需填 Secret，插件会自动计算签名。' },
  { id: 'serverchan', name: 'Server酱', placeholder: 'https://sctapi.ftqq.com/你的SendKey.send', hint: '在 sct.ftqq.com 复制 SendKey，拼成上面的发送地址即可。' },
  { id: 'qq', name: 'QQ', placeholder: 'https://qmsg.zber.com/send/你的key', hint: '使用 Qmsg 酱推送到 QQ：qmsg.zber.com 绑定 QQ 后复制发送地址。该域名走海外 CDN，直连不通时在配置里填代理地址，经 music-agent 中转发送。' },
]
const tab = ref('wecom')
const current = computed(() => platforms.find((p) => p.id === tab.value) || platforms[0])

const hooks = ref<HookConfig[]>([])
const savedSnapshot = ref('[]')
// 本地草稿与已保存配置不一致即为「脏」，用于避免状态刷新覆盖未保存的编辑
const isDirty = computed(() => JSON.stringify(hooks.value) !== savedSnapshot.value)
const saving = ref(false)
const testing = ref('')
const sending = ref(false)
const sendTitle = ref('')
const sendContent = ref('')

function syncFromState() {
  if (saving.value || isDirty.value) return // 保存期间或有未保存草稿时不覆盖
  const list = (state.value?.settings?.webhooks || []) as Partial<HookConfig>[]
  hooks.value = list.map((h) => ({
    id: h.id || '',
    name: h.name || '',
    platform: h.platform || '',
    webhook: h.webhook || '',
    secret: h.secret || '',
    proxy: h.proxy || '',
    enabled: h.enabled !== false,
  }))
  savedSnapshot.value = JSON.stringify(hooks.value)
}
watch(
  () => state.value?.settings?.webhooks,
  syncFromState,
  { immediate: true, deep: true },
)

function hooksFor(platform: string): HookConfig[] {
  return hooks.value.filter((h) => h.platform === platform)
}

function addHook() {
  hooks.value.push({
    id: 'cfg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: current.value.name + ' ' + (hooksFor(tab.value).length + 1),
    platform: tab.value,
    webhook: '',
    secret: '',
    proxy: '',
    enabled: true,
  })
}

function removeHook(h: HookConfig) {
  hooks.value = hooks.value.filter((x) => x.id !== h.id)
}

async function invoke(action: string, input: any = {}) {
  const r = await props.api.invokeAction(action, input)
  const inner = (r as any)?.result || r
  if (inner?.status === 'failed') throw new Error(inner.message || '操作失败')
  return inner
}

async function refreshState() {
  try {
    await props.api.refresh()
    syncFromState()
  } catch {}
}

async function save() {
  if (saving.value) return false
  saving.value = true
  try {
    const snapshot = JSON.stringify(hooks.value)
    const payload = JSON.parse(snapshot) // 快照提交：保存期间的继续编辑留在本地草稿
    await invoke('settings-update', { webhooks: payload })
    savedSnapshot.value = snapshot
    await refreshState()
    return true
  } catch (e: any) {
    message.error(e?.message || '保存失败')
    return false
  } finally {
    saving.value = false
  }
}

async function test(h: HookConfig) {
  testing.value = h.id
  try {
    if (!(await save())) return
    const r = await invoke('test', { platform: h.platform, config_id: h.id })
    message.success(r?.message || '测试消息已发送')
  } catch (e: any) {
    message.error(e?.message || '测试失败')
  } finally {
    testing.value = ''
  }
}

async function send() {
  if (saving.value) {
    message.warning('正在保存配置，请稍后再发送')
    return
  }
  if (isDirty.value) {
    message.warning('配置有未保存的修改，请先点「保存设置」再发送')
    return
  }
  if (!sendContent.value.trim()) {
    message.warning('请填写消息内容')
    return
  }
  sending.value = true
  try {
    const r = await invoke('send', { platform: tab.value, title: sendTitle.value, content: sendContent.value })
    message.success(r?.message || '已发送')
    sendTitle.value = ''
    sendContent.value = ''
    await refreshState()
  } catch (e: any) {
    message.error(e?.message || '发送失败')
    await refreshState()
  } finally {
    sending.value = false
  }
}

async function clearHistory() {
  try {
    await invoke('archive', {})
    await refreshState()
    message.success('已清空历史')
  } catch (e: any) {
    message.error(e?.message || '操作失败')
  }
}

function fmtAt(at: string): string {
  return String(at || '').replace('T', ' ').slice(5, 16)
}
</script>

<template>
  <main class="dian-plugin-page page">
    <header class="head">
      <div>
        <h2>通知机器人</h2>
        <p>企业微信 / 飞书 / Server酱 / QQ · 每个平台可配多个 Webhook，支持代理固定出口</p>
      </div>
      <n-tag v-if="status" :type="status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'default'" size="small">
        {{ lastMessage || status }}
      </n-tag>
    </header>

    <nav class="tabs">
      <button v-for="p in platforms" :key="p.id" class="tabbtn" :class="{ on: tab === p.id }" @click="tab = p.id">
        {{ p.name }}<span class="cnt">{{ hooksFor(p.id).filter((h) => h.enabled).length }}/{{ hooksFor(p.id).length }}</span>
      </button>
    </nav>

    <section class="card">
      <div class="row spread">
        <h3>{{ current.name }} 配置</h3>
        <div class="row">
          <n-button size="small" @click="addHook">添加配置</n-button>
          <n-button size="small" type="primary" :loading="saving" @click="save">保存设置</n-button>
        </div>
      </div>
      <p class="hint">{{ current.hint }}</p>

      <p v-if="!hooksFor(tab).length" class="hint">还没有配置，点「添加配置」创建一个。</p>

      <div v-for="h in hooksFor(tab)" :key="h.id" class="hook">
        <div class="row">
          <input v-model="h.name" class="input name" placeholder="配置名称" />
          <label class="switch"><input v-model="h.enabled" type="checkbox" /><span>{{ h.enabled ? '启用' : '停用' }}</span></label>
        </div>
        <div class="row">
          <input v-model="h.webhook" class="input" :placeholder="current.placeholder" />
        </div>
        <div class="row">
          <input v-if="tab === 'feishu'" v-model="h.secret" class="input" placeholder="签名 Secret（未开启签名校验可留空）" />
          <input v-model="h.proxy" class="input" placeholder="代理地址（可选，如 http://192.168.1.10:7890，经 music-agent 固定出口）" />
        </div>
        <div class="row">
          <n-button size="tiny" type="primary" :loading="testing === h.id" @click="test(h)">测试</n-button>
          <n-button size="tiny" type="warning" @click="removeHook(h)">删除</n-button>
        </div>
      </div>
    </section>

    <section class="card">
      <h3>发送消息 → {{ current.name }}（全部启用中的配置）</h3>
      <div class="row">
        <input v-model="sendTitle" class="input name" placeholder="标题（可选）" />
      </div>
      <textarea v-model="sendContent" class="area" rows="4" placeholder="消息内容（必填）"></textarea>
      <p v-if="isDirty" class="hint">配置有未保存的修改，发送前请先「保存设置」。</p>
      <div class="row">
        <n-button type="primary" size="small" :loading="sending" @click="send">发送</n-button>
      </div>
    </section>

    <section class="card">
      <div class="row spread">
        <h3>发送历史</h3>
        <n-button size="small" @click="clearHistory">清空</n-button>
      </div>
      <table v-if="history.length" class="tbl">
        <thead><tr><th>时间</th><th>平台</th><th>配置</th><th>动作</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="(h2, i) in history.slice(0, 30)" :key="i">
            <td class="dim">{{ fmtAt(h2.at) }}</td>
            <td>{{ h2.platform }}</td>
            <td class="dim">{{ h2.config || '-' }}</td>
            <td>{{ h2.action === 'test' ? '测试' : '发送' }}</td>
            <td><n-tag size="tiny" :type="h2.result === 'succeeded' ? 'success' : 'error'">{{ h2.result === 'succeeded' ? '成功' : '失败' }}</n-tag></td>
            <td class="dim msg">{{ h2.message }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">暂无发送历史</p>

      <details v-if="logs.length" class="logs">
        <summary>运行日志（{{ logs.length }}）</summary>
        <div class="loglist">
          <div v-for="(l, i) in logs.slice().reverse()" :key="i" class="logline" :class="l.level">
            <span class="dim">{{ fmtAt(l.at) }}</span> {{ l.message }}
          </div>
        </div>
      </details>
    </section>
  </main>
</template>

<script lang="ts">
import { NButton, NTag } from 'naive-ui'
export default { components: { NButton, NTag } }
</script>

<style scoped>
.page { display: grid; gap: var(--dian-space-4); }
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--dian-space-3); flex-wrap: wrap; }
h2 { margin: 0; font-size: 22px; color: var(--dian-text-primary); }
h3 { margin: 0; font-size: 15px; color: var(--dian-text-primary); }
p { margin: 4px 0; color: var(--dian-text-secondary); }
.card { border: 1px solid var(--dian-border); border-radius: var(--dian-radius-lg, 12px); background: var(--dian-surface-raised); padding: 14px; display: grid; gap: 8px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.spread { justify-content: space-between; }
.input { flex: 1; min-width: 200px; padding: 6px 10px; border: 1px solid var(--dian-border); border-radius: 8px; background: var(--dian-surface); color: var(--dian-text-primary); }
.input.name { flex: 0 1 220px; min-width: 140px; }
.area { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--dian-border); border-radius: 8px; background: var(--dian-surface); color: var(--dian-text-primary); font: inherit; resize: vertical; }
.switch { display: inline-flex; align-items: center; gap: 6px; color: var(--dian-text-secondary); font-size: 13px; cursor: pointer; }
.switch input { accent-color: var(--dian-primary); }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th, .tbl td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dian-divider); }
.msg { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim { color: var(--dian-text-muted); }
.hint { color: var(--dian-text-muted); font-size: 12px; }
.hook { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--dian-divider); border-radius: 10px; background: var(--dian-surface); }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabbtn { padding: 6px 14px; border: 1px solid var(--dian-border); border-radius: 999px; background: var(--dian-surface); color: var(--dian-text-secondary); cursor: pointer; font-size: 13px; }
.tabbtn.on { background: var(--dian-primary); border-color: var(--dian-primary); color: var(--dian-primary-contrast); }
.tabbtn .cnt { margin-left: 6px; font-size: 11px; opacity: 0.75; }
.logs { font-size: 12px; color: var(--dian-text-secondary); }
.logs summary { cursor: pointer; }
.loglist { max-height: 220px; overflow: auto; display: grid; gap: 2px; margin-top: 6px; font-family: var(--dian-font-mono, monospace); }
.logline.error { color: var(--dian-error); }
.logline.warn { color: var(--dian-warning); }
</style>
