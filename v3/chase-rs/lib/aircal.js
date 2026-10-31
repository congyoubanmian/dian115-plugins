// 追剧日历（/api/subscribe/air-calendar）的解析 —— 对照 aircal.rs。
//
// 该端点没有参数声明也没有响应 schema：根可以是数组或对象；两种分组形态都要能收
// （扁平 items:[{date,...}] 与按天分组的 days:[{date,items:[...]}]）；日期一律按前
// 10 字符归一成 YYYY-MM-DD，解析不出日期的条目丢弃而不报错（但计入 items_seen）。

import { CALENDAR_DAYS_MAX, CALENDAR_ITEMS_MAX } from './state.js'
import { normalizeDate, parseDateDays } from './clock.js'
import { firstI64, firstOf, firstString, truncateUtf8 } from './loose.js'

export const PATH = '/api/subscribe/air-calendar'

const ROOT_KEYS = ['data', 'items', 'calendar', 'days', 'shows', 'episodes']
const GROUP_KEYS = ['items', 'episodes', 'shows', 'list', 'calendar']
const DATE_KEYS = ['air_date', 'airDate', 'date', 'first_air_date', 'premiere_date']
const TMDB_KEYS = ['tmdb_id', 'tmdbId', 'id']
const SEASON_KEYS = ['season', 'season_number']
const EPISODE_KEYS = ['episode', 'episode_number', 'index_number']
const TITLE_KEYS = ['title', 'name', 'series_name']
const TIME_KEYS = ['air_time', 'airtime', 'airTime', 'time']
/** 解析期保留的最大天数（状态文档只留 8 天，这里给窗口筛选留余量）。 */
const PARSE_DAYS_MAX = 64

/** 单条 → 日历条目；完全没有可用信息（无 id/集号/标题）时丢弃。 */
function parseItem(element) {
  if (!element || typeof element !== 'object' || Array.isArray(element)) return null
  const tmdbId = firstI64(element, TMDB_KEYS) ?? 0
  const season = firstI64(element, SEASON_KEYS) ?? 0
  const episode = firstI64(element, EPISODE_KEYS) ?? 0
  const title = firstString(element, TITLE_KEYS) ?? ''
  if (tmdbId === 0 && episode === 0 && title === '') return null
  const timeRaw = firstString(element, TIME_KEYS)
  return {
    tmdb_id: tmdbId,
    season: Math.max(0, season),
    episode: Math.max(0, episode),
    title: truncateUtf8(title, 160),
    time: timeRaw ? truncateUtf8(timeRaw.trim(), 40) : '',
  }
}

/** 定位根容器：返回 (元素数组, 命中的键名)。 */
function locateRoot(value) {
  if (Array.isArray(value)) return [value, 'array']
  if (!value || typeof value !== 'object') return null
  for (const key of ROOT_KEYS) {
    const candidate = value[key]
    if (candidate === undefined || candidate === null) continue
    if (Array.isArray(candidate)) return [candidate, key]
    if (key === 'data' && candidate && typeof candidate === 'object') {
      for (const deep of ROOT_KEYS) {
        if (deep === 'data') continue
        const inner = candidate[deep]
        if (Array.isArray(inner)) return [inner, `data.${deep}`]
      }
    }
  }
  return null
}

/**
 * 解析追剧日历。结构整体认不出（找不到候选容器）⇒ 抛 Error，由调用方记 debug 并降级
 * （日历只影响界面与日报段①，对齐照常）。空数组是合法的空日历。
 */
export function parse(value) {
  const located = locateRoot(value)
  if (!located) throw new Error('日历结构未识别: 未命中容器字段候选')
  const [elements, containerName] = located

  const grouped = new Map()
  let itemsSeen = 0
  let flatDateKey = ''
  let groupedForm = false

  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      // 裸数组里夹标量/字符串的噪声形态真实见过：解析不了，但算"收到过"。
      itemsSeen += 1
      continue
    }
    const dateText = firstString(element, DATE_KEYS)
    const date = dateText !== null ? normalizeDate(dateText) : null
    const group = firstOf(element, GROUP_KEYS)
    // 分组形态：这一天自带 date + 一个条目数组
    if (Array.isArray(group)) {
      groupedForm = true
      if (date === null) {
        itemsSeen += group.length
        continue
      }
      const bucket = grouped.get(date) ?? []
      for (const entry of group) {
        itemsSeen += 1
        const item = parseItem(entry)
        if (item) bucket.push(item)
      }
      grouped.set(date, bucket)
      continue
    }
    // 扁平形态：每条自带日期
    itemsSeen += 1
    if (flatDateKey === '') {
      const hit = DATE_KEYS.find((key) => element[key] !== undefined)
      if (hit) flatDateKey = hit
    }
    if (date === null) continue
    const item = parseItem(element)
    if (item) {
      const bucket = grouped.get(date) ?? []
      bucket.push(item)
      grouped.set(date, bucket)
    }
  }

  const days = [...grouped.entries()]
    .map(([date, items]) => {
      items.sort((left, right) =>
        left.season - right.season ||
        left.episode - right.episode ||
        (left.time < right.time ? -1 : left.time > right.time ? 1 : 0))
      if (items.length > CALENDAR_ITEMS_MAX) items.length = CALENDAR_ITEMS_MAX
      return { date, items }
    })
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))
  if (days.length > PARSE_DAYS_MAX) days.length = PARSE_DAYS_MAX

  const shape = `root=${containerName};grouped=${groupedForm ? 'yes' : 'no'};date=${flatDateKey === '' ? 'n/a' : flatDateKey}`
  return createAirCalendar({ days, shape, items_seen: itemsSeen })
}

/** 日历对象：window / itemsOn / isEmpty（对照 aircal.rs AirCalendar）。 */
export function createAirCalendar({ days, shape, items_seen = 0 }) {
  return {
    days,
    shape,
    items_seen,
    /** 截取 [from, from+days] 的窗口（状态文档最多留 8 天）；非法日期或空窗口返回空表。 */
    window(from, daysCount) {
      const start = parseDateDays(from)
      if (start === null) return []
      const end = start + Math.max(0, daysCount)
      return days
        .filter((day) => {
          const value = parseDateDays(day.date)
          return value !== null && value >= start && value <= end
        })
        .slice(0, CALENDAR_DAYS_MAX)
        .map((day) => ({ date: day.date, items: [...day.items] }))
    },
    /** 某一天的全部条目（日报段①用）。 */
    itemsOn(date) {
      const day = days.find((entry) => entry.date === date)
      return day ? [...day.items] : []
    },
    isEmpty() {
      return days.every((day) => day.items.length === 0)
    },
  }
}
