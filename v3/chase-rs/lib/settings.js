// 用户设置 —— 扁平清单键（plugin.json settings[] / ctx.settings）⇄ 运行时嵌套形状。
//
// 旧实现把 settings 嵌在状态文档里（model.rs Settings + 白名单合并）；v3 的设置由
// 宿主保存在插件 KV 的 `settings` 键（ctx.settings.get/set），状态文档不再内嵌。
// 语义逐键对应 model.rs：
//   clamp: max_patch_per_run ∈ [1,20] / max_raise_per_run ∈ [1,100] /
//          catch_up_days ∈ [1,30] / emby_probe_budget ∈ [1,500] /
//          report.hour ∈ [0,23] / tz_offset_minutes ∈ [-840,840] / emby_proxy_id ≥ -1。
//   auto_bump 缺键/null 都视为 true（老文档向后兼容），非布尔值要显式报错。

import { looseI64 } from './loose.js'

/** 扁平设置键（与 plugin.json 的 settings[] 一一对应）。 */
export const FLAT_KEYS = [
  'enabled',
  'auto_bump',
  'dry_run',
  'write_episode_strings',
  'emby_proxy_id',
  'max_patch_per_run',
  'max_raise_per_run',
  'catch_up_days',
  'emby_probe_budget',
  'report_enabled',
  'report_hour',
  'report_tz_offset_minutes',
]

/** 扁平默认值（数值逐项对应 model.rs 的 Settings::default）。 */
export const FLAT_DEFAULTS = Object.freeze({
  enabled: true,
  auto_bump: true,
  dry_run: false,
  write_episode_strings: false,
  emby_proxy_id: -1,
  max_patch_per_run: 5,
  max_raise_per_run: 20,
  catch_up_days: 7,
  emby_probe_budget: 120,
  report_enabled: false,
  report_hour: 9,
  report_tz_offset_minutes: 480,
})

const BOOLEAN_KEYS = ['enabled', 'auto_bump', 'dry_run', 'write_episode_strings', 'report_enabled']
const NUMBER_KEYS = ['emby_proxy_id', 'max_patch_per_run', 'max_raise_per_run', 'catch_up_days', 'emby_probe_budget', 'report_hour', 'report_tz_offset_minutes']

const clampValue = {
  max_patch_per_run: (value) => Math.min(Math.max(value, 1), 20),
  max_raise_per_run: (value) => Math.min(Math.max(value, 1), 100),
  catch_up_days: (value) => Math.min(Math.max(value, 1), 30),
  emby_probe_budget: (value) => Math.min(Math.max(value, 1), 500),
  report_hour: (value) => Math.min(Math.max(value, 0), 23),
  report_tz_offset_minutes: (value) => Math.min(Math.max(value, -840), 840),
  emby_proxy_id: (value) => (value < -1 ? -1 : value),
}

/** 越界值夹取回硬上限（对照 model.rs Settings::clamp）。 */
export function clampFlat(flat) {
  for (const key of Object.keys(clampValue)) {
    flat[key] = clampValue[key](flat[key])
  }
  return flat
}

/**
 * 任意来源（清单默认叠加已保存值、旧文档）收敛成完整的扁平设置。
 * 布尔键：非布尔视为该键默认值；数字键：looseI64 失败时回落默认值。
 */
export function normalizeFlat(raw) {
  const flat = { ...FLAT_DEFAULTS }
  if (!raw || typeof raw !== 'object') return clampFlat(flat)
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') flat[key] = raw[key]
  }
  for (const key of NUMBER_KEYS) {
    const parsed = looseI64(raw[key])
    if (parsed !== null) flat[key] = parsed
  }
  return clampFlat(flat)
}

/**
 * 白名单逐键合并（绝不整块替换）。`auto_bump` 收到非布尔非 null 值时抛错
 * （与旧 settings-update 一致：不静默当成 false 或 true）。
 */
export function mergeFlat(current, input) {
  const flat = normalizeFlat(current)
  if (!input || typeof input !== 'object') return { flat, changed: [] }
  const changed = []
  const value = input.auto_bump
  if (value !== undefined && value !== null && typeof value !== 'boolean') {
    throw new Error('auto_bump 必须是布尔值(true/false)')
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === 'boolean' && input[key] !== flat[key]) {
      flat[key] = input[key]
      changed.push(key)
    }
  }
  for (const key of NUMBER_KEYS) {
    const parsed = looseI64(input[key])
    if (parsed !== null && parsed !== flat[key]) {
      flat[key] = parsed
      changed.push(key)
    }
  }
  return { flat: clampFlat(flat), changed }
}

/** 运行时嵌套形状（align/notify 逻辑使用，字段名与 model.rs Settings 一致）。 */
export function toNested(flat) {
  const settings = normalizeFlat(flat)
  return {
    enabled: settings.enabled,
    emby_proxy_id: settings.emby_proxy_id,
    max_patch_per_run: settings.max_patch_per_run,
    max_raise_per_run: settings.max_raise_per_run,
    catch_up_days: settings.catch_up_days,
    emby_probe_budget: settings.emby_probe_budget,
    auto_bump: settings.auto_bump,
    dry_run: settings.dry_run,
    write_episode_strings: settings.write_episode_strings,
    report: {
      enabled: settings.report_enabled,
      hour: settings.report_hour,
      tz_offset_minutes: settings.report_tz_offset_minutes,
    },
  }
}
