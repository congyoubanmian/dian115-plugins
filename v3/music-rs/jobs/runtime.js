// 后台运行时装配 —— 把页面/后台各自的 ctx 装配成 lib 层期待的 deps。
//
// 页面 ctx 没有 crypto（页面不做取链）；后台 ctx 全量。后台 storage.set 返回版本数字、
// 页面返回 {revision}，但两者都接受 expected_revision，lib/kv.js 统一封装。

import { createKv } from '../lib/kv.js'
import { normalizeSettings } from '../lib/settings.js'
import { loadCookies } from '../lib/music-api.js'
import { neteaseLoginInfo, qqLoginInfo } from '../lib/cookies.js'
import { loadLogs } from '../lib/logs.js'
import { stateView } from '../lib/tasks-core.js'
import { loadIndex } from '../lib/queue-store.js'
import { nowRfc3339 } from '../lib/encoding.js'

/** 宿主 ctx.crypto → lib/eapi.js 期待的 {md5Hex, aesEcbEncryptHex}。 */
export function cryptoAdapter(crypto) {
  const bytesOf = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data)
  return {
    md5Hex: (text) => crypto.md5(text, 'hex'),
    aesEcbEncryptHex: (key, data) =>
      crypto.aesEncrypt({ mode: 'ecb', key, data: bytesOf(data), padding: 'pkcs7', output: 'hex' }),
  }
}

/** 装配 deps：{kv, http, crypto?, settings?, notify?}（按调用方能力裁剪）。 */
export function buildDeps(ctx) {
  const deps = {
    ctx,
    id: ctx.id,
    kv: createKv(ctx),
    http: ctx.http,
    notify: (options) => ctx.notify(options),
  }
  if (ctx.crypto) deps.crypto = cryptoAdapter(ctx.crypto)
  return deps
}

/** 读设置（KV settings 叠加代码内默认值；后台只有 settings.get）。 */
export async function readSettings(ctx) {
  try {
    return normalizeSettings((await ctx.settings.get()) ?? {})
  } catch {
    return normalizeSettings({})
  }
}

/** 组装 UI 状态文档（旧 runtime.rs state_doc 的 v3 形态）。
 *  页面每次实时读 KV 组装，不存在「落盘的状态文档」；这里给出组装器。 */
export async function buildStateDoc(deps) {
  const [settings, index, logs, neteaseJar, qqJar] = await Promise.all([
    readSettings(deps.ctx),
    loadIndex(deps.kv),
    loadLogs(deps.kv),
    loadCookies(deps.kv, 'netease'),
    loadCookies(deps.kv, 'qq'),
  ])
  const tasks = stateView(index)
  const pending = tasks.filter((t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'copying')
  return {
    status: pending.length > 0 ? 'active' : 'idle',
    last_message: '',
    schema: 3,
    settings,
    tasks,
    login: { netease: neteaseLoginInfo(neteaseJar), qq: qqLoginInfo(qqJar) },
    logs: logs.slice(-50),
    generated_at: nowRfc3339(),
  }
}
