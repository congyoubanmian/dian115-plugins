// 后台 ctx 只有 plugin.id（页面才有 ctx.id）：KV 路径必须两者都兼容。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createKv, pluginIdOf } from '../lib/kv.js'

test('后台 ctx 用 plugin.id 拼 KV 路径', async () => {
  const paths = []
  const ctx = {
    plugin: { id: 'music.rs' },
    api: { get: async (path) => { paths.push(path); return { value: { a: 1 }, revision: 2 } } },
  }
  const kv = createKv(ctx)
  const meta = await kv.getMeta('state')
  assert.deepEqual(meta, { value: { a: 1 }, revision: 2 })
  assert.deepEqual(paths, ['/api/extensions/v3/music.rs/storage/state'])
  assert.equal(pluginIdOf({ plugin: { id: 'music.rs' } }), 'music.rs')
  assert.equal(pluginIdOf({ id: 'music.rs' }), 'music.rs', '页面 ctx.id 仍然可用')
  assert.throws(() => pluginIdOf({}), /缺少插件 ID/)
})
