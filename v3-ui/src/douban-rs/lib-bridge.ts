// 页面复用后端的纯函数模块（v3/douban-rs/lib/*.js）。
//
// 为什么不复制一份到 v3-ui/：状态文档的解析口径（lib/model.js）与设置视图的拼装
// 口径（lib/settings.js）必须与 jobs 一致，否则页面显示的队列/榜单会和后端落盘的
// 对不上。原生 JS 版页面就是直接 import 这几个模块，Vue 版保持同一份来源。
//
// 这些模块是纯 JS、没有 .d.ts 声明，TS 会报 TS7016；用 @ts-ignore 跳过类型检查
// （运行时与构建都不受影响：vite 会把它们正常打进 page.js）。

// @ts-ignore -- 纯 JS 模块，没有类型声明
import * as model from '../../../v3/douban-rs/lib/model.js'
// @ts-ignore -- 纯 JS 模块，没有类型声明
import * as settingsLib from '../../../v3/douban-rs/lib/settings.js'
// @ts-ignore -- 纯 JS 模块，没有类型声明
import * as filterCore from '../../../v3/douban-rs/lib/filter-core.js'

import type { DocSettings, FlatSettings, SettingsView, StateDoc } from './types'

/** 状态文档严格解析：类型不符整份拒绝（返回 null）。 */
export const parseStateDoc = model.parseStateDoc as (raw: unknown) => StateDoc | null
/** 是不是本插件的状态文档（settings.lists 非空）。 */
export const isRecognizable = model.isRecognizable as (doc: unknown) => boolean
/** 状态文档里设置的脱敏视图（凭据不回显）。 */
export const sanitizeSettingsView = model.sanitizeSettingsView as (raw: unknown) => SettingsView
/** 默认设置（5 个默认榜单 + 观察期/自动订阅）。 */
export const defaultSettings = model.defaultSettings as () => DocSettings
/** 清单扁平设置 → 运行时视图（类型收敛 + 兜底）。 */
export const normalizeFlat = settingsLib.normalizeFlat as (raw: unknown) => FlatSettings
/** 清单扁平设置的默认值。 */
export const FLAT_DEFAULTS = settingsLib.FLAT_DEFAULTS as FlatSettings

/** 「该条目此前订阅过、现在已被你删除」确认文案。 */
export const NO_RESUB_CONFIRM_TEXT = filterCore.NO_RESUB_CONFIRM_TEXT as string
/** 队列状态：已被过滤器拦下。 */
export const FILTERED_QUEUE_STATE = filterCore.FILTERED_QUEUE_STATE as string
/** 队列状态：被「已删除不重订」墓碑拦下。 */
export const NO_RESUB_QUEUE_STATE = filterCore.NO_RESUB_QUEUE_STATE as string
