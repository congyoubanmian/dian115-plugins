// 后台 ctx 只有 plugin.id（页面才有 ctx.id）：KV 路径必须两者都兼容。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createKv, pluginIdOf } from '../../music-rs/lib/kv.js'

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

test('键不存在时 getMeta 返回 revision 0：并发首次创建由 CAS 拦下后到者', async () => {
  const store = new Map()
  const ctx = {
    plugin: { id: 'music.rs' },
    api: {
      get: async (path) => {
        const key = decodeURIComponent(path.split('/').pop())
        const hit = store.get(key)
        if (!hit) throw Object.assign(new Error('not found'), { status: 404 })
        return hit
      },
    },
    storage: {
      async set(key, value, expected) {
        const current = store.get(key)?.revision ?? 0
        if (expected !== undefined && expected !== current) throw Object.assign(new Error('conflict'), { status: 409 })
        store.set(key, { value, revision: current + 1 })
        return { revision: current + 1 }
      },
    },
  }
  const kv = createKv(ctx)
  const a = await kv.getMeta('tasks.idx')
  const b = await kv.getMeta('tasks.idx')
  assert.equal(a.revision, 0)
  await kv.set('tasks.idx', ['a'], a.revision)
  await assert.rejects(kv.set('tasks.idx', ['b'], b.revision), /conflict/)
  assert.deepEqual(store.get('tasks.idx').value, ['a'])
})
