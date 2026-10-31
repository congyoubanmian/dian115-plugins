// 宿主存储 KV 适配层 —— plugins/douban-rs/src/store.rs 的 v3 形态。
//
// 旧 WASM 时代的存储契约（GET 信封 + ETag/If-Match + base64 body + 三级信封解包）
// 由 v3 宿主收敛成：GET /api/extensions/v3/{id}/storage/{key} → {revision, value}、
// PUT {value, expected_revision?} → {revision}（openapi-v3.json 同名路由）。本模块保留
// 旧 store.rs 的三态加载（loaded / fresh / unavailable）与"404 两次确认才当全新安装"、
// "CAS 冲突重读重试一次"这些安全语义；键名沿用旧契约：state / account / diag。

import { parseStateDoc, parseAccountDoc, isRecognizable, MAX_PERSIST_BYTES } from '../lib/model.js'

/** 状态文档键（store.rs STATE_KEY）。 */
export const STATE_KEY = 'state'
/** 账号配置键（store.rs ACCOUNT_KEY）：只有 settings-update 写它，榜单刷新的落盘永不碰。 */
export const ACCOUNT_KEY = 'account'
/** 诊断面包屑键（store.rs DIAG_KEY）。 */
export const DIAG_KEY = 'diag'

function storagePath(ctx, key) {
  const id = ctx.id ?? ctx.plugin?.id ?? ''
  return `/api/extensions/v3/${encodeURIComponent(id)}/storage/${encodeURIComponent(key)}`
}

/** 统一的业务 API 调用收敛：非 2xx 抛错，这里转成 {ok, status, data, message}。 */
export async function tryApi(ctx, method, path, body) {
  try {
    const verb = method.toLowerCase()
    const data = body === undefined ? await ctx.api[verb](path) : await ctx.api[verb](path, body)
    return { ok: true, status: 200, data, message: '' }
  } catch (error) {
    return {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : 0,
      data: error?.data,
      message: error?.message || String(error),
    }
  }
}

function delay(ctx, ms) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 读取一个存储键 → {value, revision}；404 → {value: null, revision: 0, missing: true}；
 * 其他失败 → {error: message}。
 */
export async function readKey(ctx, key) {
  const result = await tryApi(ctx, 'GET', storagePath(ctx, key))
  if (result.ok) {
    const data = result.data
    if (data && typeof data === 'object' && 'value' in data) {
      return { value: data.value ?? null, revision: typeof data.revision === 'number' ? data.revision : 0 }
    }
    return { value: data ?? null, revision: 0 }
  }
  if (result.status === 404) return { value: null, revision: 0, missing: true }
  return { error: result.message }
}

/**
 * 写入一个存储键（CAS + 412/409 重读重试一次 —— store.rs put 的语义）。
 * expectedRevision 传 null 表示新建（expected_revision: 0）。
 */
export async function putKey(ctx, key, value, expectedRevision) {
  const path = storagePath(ctx, key)
  const expected = expectedRevision === null ? 0 : expectedRevision
  let result = await tryApi(ctx, 'PUT', path, { value, expected_revision: expected })
  if (result.ok) {
    return { ok: true, revision: typeof result.data?.revision === 'number' ? result.data.revision : expected + 1 }
  }
  if (result.status === 409 || result.status === 412) {
    const fresh = await readKey(ctx, key)
    if (!fresh.error) {
      const retryExpected = fresh.missing ? 0 : fresh.revision
      result = await tryApi(ctx, 'PUT', path, { value, expected_revision: retryExpected })
      if (result.ok) {
        return { ok: true, revision: typeof result.data?.revision === 'number' ? result.data.revision : retryExpected + 1 }
      }
    }
  }
  const detail = result.message ? `: ${result.message}` : ''
  return { ok: false, message: `storage PUT HTTP ${result.status}${detail}` }
}

/**
 * 读取状态并做 3 次重试（store.rs load_state_with_retry）：
 * - 读到能识别的状态文档 → {kind:'loaded', doc, revision}；
 * - 404 需间隔 300ms 两次确认（宿主重启风暴里存储会瞬时 404）→ {kind:'fresh'}；
 * - 其余失败 200ms 后重试，3 次都不行 → {kind:'unavailable'}；
 * - 读到了值但不是本插件的状态文档 → {kind:'foreign', doc:null}（禁止落盘）。
 */
export async function loadStateWithRetry(ctx) {
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await readKey(ctx, STATE_KEY)
    if (read.error) {
      lastError = read.error
      await delay(ctx, 200)
      continue
    }
    if (read.missing) {
      await delay(ctx, 300)
      const confirm = await readKey(ctx, STATE_KEY)
      if (confirm.missing) return { kind: 'fresh', doc: null, revision: 0 }
      if (confirm.error) {
        lastError = confirm.error
        await delay(ctx, 200)
        continue
      }
      // 瞬时 404 后恢复了：走 loaded/foreign 判定
      return classifyValue(confirm.value, confirm.revision)
    }
    return classifyValue(read.value, read.revision)
  }
  return { kind: 'unavailable', doc: null, revision: 0, message: lastError }
}

function classifyValue(value, revision) {
  if (value === null || value === undefined || value === '') {
    return { kind: 'fresh', doc: null, revision: 0 }
  }
  const doc = parseStateDoc(value)
  if (doc === null || !isRecognizable(doc)) {
    return { kind: 'foreign', doc: null, revision }
  }
  return { kind: 'loaded', doc, revision }
}

/** 落盘整份状态（runtime.rs persist_all 的写入段；4MiB 预算与日志裁剪在 Session 层）。 */
export async function persistState(ctx, doc, revision) {
  const result = await putKey(ctx, STATE_KEY, doc, revision)
  return result
}

/** 读账号键（runtime.rs load_account_overlay 的读取段）。 */
export async function loadAccount(ctx) {
  const read = await readKey(ctx, ACCOUNT_KEY)
  if (read.error || read.missing || read.value === null) return { account: null, bytes: 0 }
  return { account: parseAccountDoc(read.value), bytes: JSON.stringify(read.value ?? null).length }
}

/** 写账号键（runtime.rs save_account：只写账号字段）。 */
export async function saveAccount(ctx, accountFields) {
  const read = await readKey(ctx, ACCOUNT_KEY)
  const revision = read.error || read.missing ? null : read.revision
  return putKey(ctx, ACCOUNT_KEY, accountFields, revision)
}

/** 写诊断面包屑（runtime.rs trace_detail：单键覆盖写；失败不影响业务）。 */
export async function writeDiag(ctx, step, extra = {}) {
  const payload = { at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), step, ...extra }
  const read = await readKey(ctx, DIAG_KEY)
  const revision = read.error || read.missing ? null : read.revision
  const result = await putKey(ctx, DIAG_KEY, payload, revision)
  return result
}

/** 序列化 + 体积预算（runtime.rs persist_all：超 4MiB 放弃并返回原因）。 */
export function serializeStateBudgeted(doc) {
  let text = ''
  try {
    text = JSON.stringify(doc)
  } catch (error) {
    return { ok: false, message: `持久化失败: marshal:${error.message}` }
  }
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_PERSIST_BYTES) {
    return { ok: false, message: `持久化跳过: 状态过大 ${bytes.length}B`, oversized: true }
  }
  return { ok: true, value: JSON.parse(text), bytes: bytes.length }
}
