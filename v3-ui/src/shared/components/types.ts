// 共享 UI 组件的公共类型。
//
// 形状取三个插件现有实现的并集，色调保留三个插件的旧取值作为别名，组件 props 与事件都向后兼容：
// - chase-rs `components/StatTile.vue`（tile: key/label/value/tone，外加 series/share/index）
// - douban-rs `components/StatTile.vue`（label/value/hint/icon/tone/loading）
// - music-rs `components/StatTiles.vue`（key/label/value/icon + live 语义）
//
// 这里只放“展示层”类型，不引用任何插件目录，保证 shared 不会把 chase/douban/music
// 的业务代码带进其他插件的产物。

import type { Component } from 'vue'

/**
 * 语义色调。同时接受三个插件里出现过的写法：
 * - chase: default / primary / success / warning / error
 * - douban: accent / ok / warn / error / muted / alt
 * - music: active / queued / done / failed（由 StatTileItem.tone + live 表达）
 */
export type UiTone =
  | 'default'
  | 'accent'
  | 'primary'
  | 'success'
  | 'ok'
  | 'warning'
  | 'warn'
  | 'error'
  | 'muted'
  | 'alt'

/** 占比环的数据：part / whole，例如已判定 / 订阅池。 */
export interface StatTileShare {
  part: number
  whole: number
  label: string
}

/**
 * 一张统计卡。StatTiles 的 items 使用这个形状；
 * StatTile 的 props 是它的平铺版，页面侧可以直接从现有 tiles 计算里展开传入。
 */
export interface StatTileItem {
  /** 稳定标识：用于 v-for key 和 StatTiles 的 select(key) 事件。 */
  key: string
  label: string
  /** 数字卡会做 0 → 终值的滚动；非纯数字字符串原样显示。 */
  value: number | string
  /** 卡片下方的补充说明（douban 使用）。 */
  hint?: string
  icon?: Component
  tone?: UiTone
  /** 数据尚未读回：卡片内部显示骨架占位。 */
  loading?: boolean
  /** 迷你折线数据（少于 2 个点不渲染）。 */
  series?: number[]
  seriesLabel?: string
  share?: StatTileShare
  /** 入场动画序号（chase bento 的 --i）。 */
  index?: number
  /** chase 的 tile-k-* / music 的 stat--* 兼容类名键；缺省回退到 key。 */
  tileKey?: string
  /** 渲染为 <button> 并 emit select。 */
  interactive?: boolean
  /** 音乐页的“进行中”状态：数字/图标着色（active 时图标旋转）。 */
  live?: boolean
  /** 可交互卡的读屏文案；缺省用 `${label} ${value}`。 */
  ariaLabel?: string
  /** 单卡皮肤覆盖；缺省跟随 StatTiles 的 variant。 */
  variant?: 'card' | 'bento' | 'stat'
}

/**
 * toast 的最小形状。三个插件的 ToastItem / Toast 都满足这个结构，
 * 页面可以直接把 store.toasts 传给共享 ToastHost。
 */
export interface ToastItemLike {
  id: number | string
  kind: 'success' | 'error' | 'warning' | 'info'
  message: string
}
