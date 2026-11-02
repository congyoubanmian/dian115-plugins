// 后台 ctx 只有 plugin.id（页面才有 ctx.id）：存储路径必须两者都兼容。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRuntimeState, Session, pluginIdOf } from '../../chase-rs/jobs/runtime.js'

test('后台 ctx 用 plugin.id 拼存储路径', async () => {
  const paths = []
  const ctx = {
    plugin: { id: 'chase.rs' },
    api: { get: async (path) => { paths.push(path); return { value: null, revision: 0 } } },
  }
  const loaded = await loadRuntimeState(ctx)
  assert.equal(loaded.kind, 'fresh')
  assert.deepEqual(paths, ['/api/extensions/v3/chase.rs/storage/state'])
  assert.equal(pluginIdOf({ plugin: { id: 'chase.rs' } }), 'chase.rs')
  assert.equal(pluginIdOf({ id: 'chase.rs' }), 'chase.rs', '页面 ctx.id 仍然可用')
})

test('persist 用 plugin.id 写入状态', async () => {
  const puts = []
  const ctx = {
    plugin: { id: 'chase.rs' },
    api: { put: async (path, body) => { puts.push([path, body]); return { revision: 1 } } },
  }
  const session = new Session(ctx, { kind: 'fresh', doc: null, revision: 0 })
  const outcome = await session.persist()
  assert.equal(outcome.ok, true)
  assert.equal(puts.length, 1)
  assert.equal(puts[0][0], '/api/extensions/v3/chase.rs/storage/state')
  assert.equal(typeof puts[0][1].expected_revision, 'number')
})
