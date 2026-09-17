import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WASI } from 'node:wasi'

const bytes = readFileSync(new URL('../build/runtime/plugin.wasm', import.meta.url))
const module = await WebAssembly.compile(bytes)
let value = null
let revision = 0
let failWrites = false
let notificationCalls = 0

async function worker() {
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {} })
  let instance
  let response
  const imports = {
    wasi_snapshot_preview1: wasi.wasiImport,
    dian115: {
      host_call(ptr, length) {
        const request = JSON.parse(Buffer.from(instance.exports.memory.buffer, ptr, length).toString()).params
        let status = 200
        let body = {}
        if (request.path === '/api/plugin-runtime/storage/state') {
          if (request.method === 'GET') {
            status = value === null ? 404 : 200
            body = { value }
          } else if (failWrites) {
            status = 503
          } else {
            value = JSON.parse(Buffer.from(request.body_base64, 'base64').toString()).value
            revision++
          }
        } else {
          notificationCalls++
          body = { errcode: 0 }
        }
        response = Buffer.from(JSON.stringify({ result: { status, headers: { etag: [`"pkv_${revision}"`] }, body_base64: Buffer.from(JSON.stringify(body)).toString('base64') } }))
        return response.length
      },
      host_read(ptr, length) {
        assert.ok(length >= response.length)
        new Uint8Array(instance.exports.memory.buffer, ptr, response.length).set(response)
        return response.length
      },
    },
  }
  instance = await WebAssembly.instantiate(module, imports)
  wasi.initialize(instance)
  const call = (message) => {
    const input = Buffer.from(JSON.stringify(message))
    const ptr = instance.exports.dian115_alloc(input.length)
    new Uint8Array(instance.exports.memory.buffer, ptr, input.length).set(input)
    const packed = instance.exports.dian115_handle(ptr, input.length)
    const outputPtr = Number(packed >> 32n)
    const length = Number(packed & 0xffffffffn)
    const result = JSON.parse(Buffer.from(instance.exports.memory.buffer, outputPtr, length).toString())
    assert.equal(result.error, undefined)
    return result.result
  }
  assert.equal(call({ method: 'runtime.initialize' }).ready, true)
  return (op, payload = {}) => call({ method: 'runtime.invoke', params: { envelope: { op, invocation_id: 'test', payload } } })
}

let invoke = await worker()
const hooks = [{ id: 'saved', name: 'fixture', platform: 'wecom', webhook: 'https://example.invalid/hook', enabled: true }]
assert.equal(invoke('action', { id: 'settings-update', input: { webhooks: hooks } }).status, 'succeeded')
const saved = invoke('state')
invoke = await worker()
assert.deepEqual(invoke('state').state.settings.webhooks, hooks)
assert.equal(invoke('state').etag, saved.etag)
assert.equal(invoke('action', { id: 'test', input: { platform: 'wecom', config_id: 'saved' } }).status, 'succeeded')
assert.equal(notificationCalls, 1)
failWrites = true
assert.equal(invoke('action', { id: 'settings-update', input: { webhooks: [] } }).status, 'failed')
assert.deepEqual(invoke('state').state.settings.webhooks, hooks)
assert.equal(invoke('action', { id: 'archive' }).status, 'failed')
assert.equal(invoke('state').state.history.length, 1)
failWrites = false
invoke = await worker()
assert.deepEqual(invoke('state').state.settings.webhooks, hooks)
assert.equal(invoke('state').state.history.length, 1)
console.log('WASM ABI regression passed: save, worker restart, mock notification, failed save/archive rollback')
