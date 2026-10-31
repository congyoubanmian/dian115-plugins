// 设置模块测试 + 清单一致性（plugin.json settings 与 lib/settings.js 同源）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { FLAT_DEFAULTS, FLAT_KEYS, mergeFlat, normalizeFlat, toNested } from '../lib/settings.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'))

test('默认值与 model.rs 文档一致', () => {
  assert.deepEqual({ ...FLAT_DEFAULTS }, {
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
})

test('越界值夹取回硬上限（对照 Settings::clamp）', () => {
  const flat = normalizeFlat({
    max_patch_per_run: 200,
    max_raise_per_run: 0,
    catch_up_days: 900,
    emby_probe_budget: 9000,
    emby_proxy_id: -77,
    report_hour: 42,
    report_tz_offset_minutes: 10_000,
  })
  assert.equal(flat.max_patch_per_run, 20)
  assert.equal(flat.max_raise_per_run, 1)
  assert.equal(flat.catch_up_days, 30)
  assert.equal(flat.emby_probe_budget, 500)
  assert.equal(flat.emby_proxy_id, -1)
  assert.equal(flat.report_hour, 23)
  assert.equal(flat.report_tz_offset_minutes, 840)
})

test('缺键 / 类型不对的旧文档落回默认（auto_bump 缺键 = true）', () => {
  const flat = normalizeFlat({ enabled: false, auto_bump: null })
  assert.equal(flat.enabled, false)
  assert.equal(flat.auto_bump, true, 'null 视为 true（旧文档向后兼容）')
  assert.equal(normalizeFlat({ auto_bump: false }).auto_bump, false)
  assert.equal(normalizeFlat({ max_patch_per_run: '13' }).max_patch_per_run, 13, '数字串也收')
  assert.equal(normalizeFlat({ max_patch_per_run: 'nope' }).max_patch_per_run, 5, '解析不出落默认')
  assert.equal(normalizeFlat(null).enabled, true)
})

test('白名单逐键合并；auto_bump 非布尔显式报错', () => {
  const current = { emby_proxy_id: -1, max_raise_per_run: 20 }
  const { flat, changed } = mergeFlat(current, {
    max_patch_per_run: 99, catch_up_days: 3, report_enabled: true, report_hour: 7,
    emby_proxy_id: 3, unknown_key: 1, blacklist: ['x'],
  })
  assert.equal(flat.max_patch_per_run, 20, '越界值夹到硬上限')
  assert.equal(flat.catch_up_days, 3)
  assert.equal(flat.report_enabled, true)
  assert.equal(flat.report_hour, 7)
  assert.equal(flat.emby_proxy_id, 3)
  assert.equal(flat.max_raise_per_run, 20, '没提交的键保持原值')
  assert.ok(changed.includes('max_patch_per_run'))
  assert.ok(!changed.includes('max_raise_per_run'))

  assert.throws(() => mergeFlat(current, { auto_bump: 'yes' }), /auto_bump 必须是布尔值/)
  assert.equal(mergeFlat(current, { auto_bump: null }).changed.length, 0, 'null 当作未提供')
})

test('toNested 的形状（align/notify 逻辑消费的嵌套形状）', () => {
  const nested = toNested({ ...FLAT_DEFAULTS, report_enabled: true, report_hour: 7 })
  assert.equal(nested.enabled, true)
  assert.equal(nested.auto_bump, true)
  assert.equal(nested.emby_proxy_id, -1)
  assert.deepEqual(nested.report, { enabled: true, hour: 7, tz_offset_minutes: 480 })
  assert.ok(!('report_enabled' in nested))
})

test('plugin.json：v3 清单的基本约束', () => {
  assert.equal(MANIFEST.schema_version, 3)
  assert.equal(MANIFEST.id, 'chase.rs')
  assert.equal(MANIFEST.requires.api, '3.5')
  assert.match(MANIFEST.icon, /\.svg$/)
  assert.ok(MANIFEST.ui?.entry === 'ui/page.js')
  // 定时任务用 default_schedule；两个调度字段互斥
  const align = MANIFEST.jobs.find((job) => job.id === 'align')
  assert.equal(align.default_schedule, '0 * * * *', '保留旧 manifest 的整点 cron')
  assert.equal(align.interval_seconds, undefined)
  const ids = MANIFEST.jobs.map((job) => job.id)
  assert.equal(new Set(ids).size, ids.length, 'job id 不重复')
  for (const job of MANIFEST.jobs) {
    assert.ok(job.entry.startsWith('jobs/'), job.id)
    assert.ok(typeof job.title === 'string' && [...job.title].length <= 40, job.id)
    assert.ok(job.timeout_seconds > 0, job.id)
  }
  // 事件：旧运行时没有事件订阅，v3 也不虚构
  assert.equal(MANIFEST.events, undefined)
})

test('plugin.json 的 settings[] 与 FLAT_DEFAULTS 同源', () => {
  const keys = MANIFEST.settings.map((setting) => setting.key)
  assert.deepEqual([...keys].sort(), [...FLAT_KEYS].sort())
  for (const setting of MANIFEST.settings) {
    assert.ok(setting.label, setting.key)
    assert.ok(['boolean', 'number'].includes(setting.type), setting.key)
    assert.equal(
      setting.default,
      FLAT_DEFAULTS[setting.key],
      `${setting.key} 的清单默认值必须与代码默认一致`,
    )
  }
})

test('plugin.json 的 declared_usage 覆盖业务端点', () => {
  const apis = MANIFEST.declared_usage.apis.join('\n')
  for (const needle of [
    '/api/subscribe/pool/intents',
    '/api/plugin-host/emby/instances',
    '/api/plugin-host/emby/episodes',
    '/api/subscribe/air-calendar',
    '/api/tmdb/tv/',
  ]) {
    assert.ok(apis.includes(needle), needle)
  }
  assert.equal(MANIFEST.declared_usage.notifications, true)
})
