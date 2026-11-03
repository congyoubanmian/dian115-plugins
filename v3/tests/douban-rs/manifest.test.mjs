// 清单一致性测试：TG 指令事件限 telegram 渠道 + requires.api 版本随能力声明。
//
// - messaging.md：`channels` 把 message 事件限制到指定渠道，省略则全渠道分发；
//   本插件的 /refresh、/wish 回执走 ctx.messaging.reply（需要来源渠道对应权限，
//   即 telegram.bot），企业微信侧触发只会静默无回执 → 必须显式限 channels。
// - api-reference.md：ctx.messaging 是宿主插件 API 3.6 起的消息渠道能力，
//   requires.api 随能力提版（仓库惯例：music-rs 直写能力提 3.9）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'douban-rs')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'))

test('TG 指令事件限 channels:["telegram"]，企业微信侧不触发 /refresh、/wish', () => {
  const event = MANIFEST.events.find((entry) => entry.event === 'message' && entry.job === 'tg-command')
  assert.ok(event, 'tg-command 的 message 事件必须声明')
  assert.deepEqual(event.channels, ['telegram'])
  assert.deepEqual(event.commands, ['refresh', 'wish'])
})

test('requires.api ≥ 3.6：TG 回执用 ctx.messaging（API 3.6 起提供）', () => {
  const [maj, min] = String(MANIFEST.requires.api).split('.').map(Number)
  assert.ok(maj > 3 || (maj === 3 && min >= 6), `requires.api=${MANIFEST.requires.api} 应 ≥ 3.6`)
})
