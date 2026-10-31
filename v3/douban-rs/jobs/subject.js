// 豆瓣条目详情 —— plugins/douban-rs/src/subject.rs 的移植（功能 1 匹配增强 + 功能 2 地区判定共用）。
//
// 字段路径全部来自真实响应取证（subject.rs 模块头的字段表）：
// id(string) / original_title / aka(string[]) / rating.value / year(string) / countries(string[]) / type。
// 返回 null 表示"没拿到"（HTTP 失败/解析失败/id 与请求不符/type 与路径不符）——
// 调用方都按"没有详情"降级，不区分原因。

import { pathEscape } from '../lib/text.js'
import { doubanGet } from './httpx.js'

/** 从豆瓣 ref 提取条目数字 id（`db:subj:36808876` / `36808876`；其余形态 → 空串）。 */
export function doubanSubjectId(doubanRef) {
  const text = String(doubanRef ?? '')
  const last = text.slice(text.lastIndexOf(':') + 1)
  if (last !== '' && /^[0-9]+$/.test(last)) return last
  return ''
}

/** 回退候选标题：original_title 在前、aka 跟上；去掉空串和重复项，保序。 */
export function fallbackTitles(detail) {
  const out = []
  const push = (candidate) => {
    if (candidate !== '' && !out.includes(candidate)) out.push(candidate)
  }
  push(String(detail?.original_title ?? ''))
  for (const aka of Array.isArray(detail?.aka) ? detail.aka : []) push(String(aka))
  return out
}

/** 把解析出的详情折成统一视图（fallback_titles 预计算，供匹配回退直接用）。 */
function toView(detail) {
  return {
    id: String(detail?.id ?? ''),
    original_title: String(detail?.original_title ?? ''),
    aka: Array.isArray(detail?.aka) ? detail.aka.map((item) => String(item)) : [],
    rating: typeof detail?.rating?.value === 'number' ? detail.rating.value : null,
    year: String(detail?.year ?? ''),
    countries: Array.isArray(detail?.countries) ? detail.countries.map((item) => String(item)) : null,
    type: String(detail?.type ?? ''),
    fallback_titles: null,
  }
}

/**
 * rexxar 条目详情（m.douban.com/rexxar/api/v2/{movie|tv}/<id>）。
 * kind 取 movie/tv（其它值按 movie 处理）；失败一律返回 null。
 */
export async function rexxarSubjectDetail(session, ctx, kind, subjectId) {
  const resolvedKind = kind === 'tv' ? 'tv' : 'movie'
  const url = `https://m.douban.com/rexxar/api/v2/${resolvedKind}/${pathEscape(subjectId)}`
  const got = await doubanGet(ctx, url, 'application/json, text/plain;q=0.9')
  if (got.error) return null
  let detail
  try {
    detail = JSON.parse(got.text)
  } catch {
    return null
  }
  if (!detail || typeof detail !== 'object') return null
  // 响应 id 与请求不符（错配条目/重定向说明页）按"没拿到"处理
  if (String(detail.id ?? '') !== String(subjectId)) return null
  // 响应 type 与请求路径不符同样按"没拿到"（正确性不单靠豆瓣 301 行为；
  // type 缺失/为空时不判错 —— 旧响应可能没有该字段，宁可放行给 id 校验兜底）
  const responseType = String(detail.type ?? '')
  if (responseType !== '' && responseType !== resolvedKind) return null
  const view = toView(detail)
  view.fallback_titles = fallbackTitles(detail)
  return view
}
