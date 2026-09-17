import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'

// Exercise the actual setup script with Vue reactivity; no DOM/test-runner dependency.
const { descriptor } = parse(readFileSync(new URL('./AppPage.vue', import.meta.url), 'utf8'))
const script = descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
const { outputText } = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
const setup = new Function('computed', 'ref', 'watch', 'defineProps', 'useMessage',
  outputText + '\nreturn { hooks, isDirty, history, save, test, send, clearHistory, sendContent, addHook, removeHook }')
const clone = (v) => JSON.parse(JSON.stringify(v))
const hook = () => ({ id: 'one', name: 'Saved', platform: 'wecom', webhook: 'https://example.invalid', secret: '', proxy: '', enabled: true })
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function harness(t, initial = { settings: { webhooks: [hook()] } }) {
  const calls = []
  const warnings = []
  let stored = clone(initial)
  const api = {
    async invokeAction(action, input) {
      calls.push({ action, input })
      if (action === 'settings-update') stored.settings.webhooks = clone(input.webhooks)
      return { status: 'succeeded' }
    },
    async refresh() {
      props.runtimeState = clone(stored)
      await nextTick()
      return props.runtimeState
    },
  }
  const props = reactive({ api, runtimeState: initial })
  const scope = effectScope()
  t.after(() => scope.stop())
  const page = scope.run(() => setup(computed, ref, watch, () => props,
    () => ({ warning: (s) => warnings.push(s), error() {}, success() {} })))
  return { page, props, calls, warnings, api }
}

test('late and nested props hydrate clean drafts but preserve early edits', async (t) => {
  const { page, props } = harness(t, {})
  props.runtimeState.settings = { webhooks: [hook()] }
  await nextTick()
  assert.equal(page.hooks.value[0].name, 'Saved')
  props.runtimeState.settings.webhooks[0].name = 'Updated'
  await nextTick()
  assert.equal(page.hooks.value[0].name, 'Updated')
  page.hooks.value[0].name = 'Draft'
  props.runtimeState = { settings: { webhooks: [hook()] } }
  await nextTick()
  assert.equal(page.hooks.value[0].name, 'Draft')
  const early = harness(t, {})
  early.page.addHook()
  const id = early.page.hooks.value[0].id
  early.props.runtimeState = { settings: { webhooks: [hook()] } }
  await nextTick()
  assert.equal(early.page.hooks.value[0].id, id)
})

test('archive refresh preserves edits, additions and deletions; dirty send never autosaves', async (t) => {
  const { page, calls, warnings } = harness(t)
  page.removeHook(page.hooks.value[0])
  page.addHook()
  page.hooks.value[0].name = 'New draft'
  const draft = clone(page.hooks.value)
  await page.clearHistory()
  assert.deepEqual(clone(page.hooks.value), draft)
  page.sendContent.value = 'message'
  await page.send()
  assert.deepEqual(calls.map((c) => c.action), ['archive'])
  assert.match(warnings[0], /未保存/)
  assert.equal(page.sendContent.value, 'message')
})

test('save snapshots payload and preserves edits during both action and refresh awaits', async (t) => {
  const { page, api } = harness(t)
  const action = deferred()
  const refresh = deferred()
  let payload
  api.invokeAction = async (_, input) => { payload = input.webhooks; await action.promise }
  api.refresh = async () => { await refresh.promise }
  page.hooks.value[0].name = 'Submitted'
  const saving = page.save()
  page.hooks.value[0].name = 'Edited during save'
  assert.equal(payload[0].name, 'Submitted')
  assert.equal(await page.save(), false)
  action.resolve()
  await nextTick()
  page.hooks.value[0].proxy = 'draft proxy'
  refresh.resolve()
  assert.equal(await saving, true)
  assert.equal(page.hooks.value[0].name, 'Edited during save')
  assert.equal(page.hooks.value[0].proxy, 'draft proxy')
  assert.equal(page.isDirty.value, true)
  api.invokeAction = async () => { throw new Error('save failed') }
  assert.equal(await page.save(), false)
  assert.equal(page.isDirty.value, true)
})

test('send refresh preserves edits made in flight; test saves before testing', async (t) => {
  const { page, api, calls } = harness(t)
  const sent = deferred()
  const invoke = api.invokeAction
  api.invokeAction = async (action, input) => {
    const result = await invoke(action, input)
    if (action === 'send') await sent.promise
    return result
  }
  page.sendContent.value = 'message'
  const sending = page.send()
  page.hooks.value[0].name = 'Edited while sending'
  sent.resolve()
  await sending
  assert.equal(page.hooks.value[0].name, 'Edited while sending')
  await page.test(page.hooks.value[0])
  assert.deepEqual(calls.map((c) => c.action), ['send', 'settings-update', 'test'])
  assert.equal(page.isDirty.value, false)
  api.invokeAction = async (action) => {
    assert.equal(action, 'settings-update')
    throw new Error('save failed')
  }
  await page.test(page.hooks.value[0])
})
