// tools/check-market-templates.mjs 的回归测试。
//
// 覆盖复核里指出的 false green：
//   * manifest 合法、市场 schema 非法的 permissions（host_access / optional / >128 apis）；
//   * 模板 version 不随发版维护（发布流程按 manifest.version 归一化）；
//   * package_url 指向旧版本包。
//
// 运行：node --test tools/check-market-templates.test.mjs

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { checkMarketTemplates } from './check-market-templates.mjs'

const toolsRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(toolsRoot)
const schemaPath = join(toolsRoot, 'market-index.schema.json')

const apiPermission = () => ({ method: 'GET', path: '/api/demo', reason: '读取演示数据' })

const manifestFor = (overrides = {}) => ({
  schema_version: 1,
  id: 'demo.plugin',
  name: '演示插件',
  version: '1.0.0',
  description: '演示插件',
  default_locale: 'zh-CN',
  publisher: { name: 'tester', key_id: 'ed25519:testtesttest' },
  compatibility: { dian115: '>=3.8.51 <6.0.0', plugin_api: '^2.0.0' },
  runtime: { kind: 'wasm', entry: 'runtime/plugin.wasm', protocol: 'dian115:wasm@1' },
  permissions: { apis: [apiPermission()] },
  ui: {
    mode: 'federation',
    federation: {
      entry: 'frontend/dist/assets/remoteEntry.js',
      assets_root: 'frontend/dist',
      module: './PluginApp',
    },
  },
  tags: ['demo'],
  ...overrides,
})

const marketFor = (overrides = {}) => ({
  id: 'demo.plugin',
  name: '演示插件',
  version: '1.0.0',
  description: '演示插件',
  author: 'tester',
  homepage: 'https://github.com/example/repo',
  package_url: 'https://github.com/example/repo/releases/download/demo-v1.0.0/demo.plugin-1.0.0.d115p',
  sha256: 'a'.repeat(64),
  runtime: {
    kind: 'wasm',
    protocol: 'dian115:wasm@1',
    autostart: true,
    trust_level: 'wasm-sandbox',
  },
  permissions: { apis: [apiPermission()] },
  tags: ['demo'],
  ...overrides,
})

const makeRepo = (t) => {
  // 在 tools/ 下建临时树：CI 与本地都保证仓库可写；/tmp 在部分环境有配额限制。
  const root = mkdtempSync(join(toolsRoot, '.tmp-market-templates-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'tools'), { recursive: true })
  copyFileSync(schemaPath, join(root, 'tools', 'market-index.schema.json'))
  return root
}

const writePlugin = (root, manifest, market) => {
  const pluginDir = join(root, 'plugins', 'demo')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'manifest.template.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (market !== undefined) {
    writeFileSync(join(pluginDir, 'market-entry.template.json'), `${JSON.stringify(market, null, 2)}\n`)
  }
}

const assertRejected = (result, needle) => {
  assert.notEqual(result.errors.length, 0, `应拒绝该模板，实际通过：${JSON.stringify(result.checkedPlugins)}`)
  assert.ok(
    result.errors.some((message) => message.includes(needle)),
    `错误中应包含 ${needle}：\n${result.errors.join('\n')}`,
  )
}

test('真实仓库的市场模板通过，并且 CLI 退出码为 0', () => {
  const result = checkMarketTemplates({ root: repoRoot })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.checkedPlugins, ['chase-rs', 'douban-rs', 'music-rs'])

  const cli = spawnSync(process.execPath, [join(toolsRoot, 'check-market-templates.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.equal(cli.status, 0, `${cli.stderr}${cli.stdout}`)
  assert.match(cli.stdout, /市场模板检查通过：3 个插件/)
})

test('拒绝 manifest 与 market 同时携带市场 schema 不允许的 host_access/optional', (t) => {
  const root = makeRepo(t)
  const manifest = manifestFor()
  manifest.permissions = { ...manifest.permissions, host_access: 'extended' }
  manifest.permissions.apis[0] = { ...manifest.permissions.apis[0], optional: true }
  const market = marketFor()
  market.permissions = {
    ...market.permissions,
    host_access: 'extended',
    apis: [{ ...apiPermission(), optional: true }],
  }
  writePlugin(root, manifest, market)

  const result = checkMarketTemplates({ root })
  assertRejected(result, 'host_access')
  assertRejected(result, 'optional')
})

test('CLI 对市场 schema 非法的权限退出 1（复核里的 false green 用例）', (t) => {
  const root = makeRepo(t)
  copyFileSync(join(toolsRoot, 'check-market-templates.mjs'), join(root, 'tools', 'check-market-templates.mjs'))
  const manifest = manifestFor()
  manifest.permissions = {
    ...manifest.permissions,
    host_access: 'extended',
    apis: [{ ...apiPermission(), optional: true }],
  }
  const market = marketFor()
  market.permissions = structuredClone(manifest.permissions)
  writePlugin(root, manifest, market)

  const cli = spawnSync(process.execPath, [join(root, 'tools', 'check-market-templates.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(cli.status, 1, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`)
  assert.match(cli.stderr, /host_access/)
  assert.match(cli.stderr, /optional/)
})

test('拒绝超过市场 schema 上限的 apis（128 条）', (t) => {
  const root = makeRepo(t)
  const apis = Array.from({ length: 129 }, (_, index) => ({
    method: 'GET',
    path: `/api/demo/${index}`,
    reason: '演示',
  }))
  const manifest = manifestFor({ permissions: { apis } })
  const market = marketFor({ permissions: { apis: structuredClone(apis) } })
  writePlugin(root, manifest, market)

  assertRejected(checkMarketTemplates({ root }), '最多 128 项')
})

test('模板 version 落后于 manifest 时按发版流程归一化，不报错但给出提示', (t) => {
  const root = makeRepo(t)
  const manifest = manifestFor({ version: '1.0.0' })
  const market = marketFor({ version: '0.9.0' })
  writePlugin(root, manifest, market)

  const result = checkMarketTemplates({ root })
  assert.deepEqual(result.errors, [])
  assert.ok(result.notes.some((note) => note.includes('0.9.0') && note.includes('1.0.0')), result.notes.join('\n'))
})

test('拒绝 package_url 指向旧版本包', (t) => {
  const root = makeRepo(t)
  const market = marketFor({
    package_url: 'https://github.com/example/repo/releases/download/demo-v0.9.0/demo.plugin-0.9.0.d115p',
  })
  writePlugin(root, manifestFor(), market)

  assertRejected(checkMarketTemplates({ root }), 'package_url')
})

test('拒绝缺少 market-entry.template.json 的插件', (t) => {
  const root = makeRepo(t)
  writePlugin(root, manifestFor(), undefined)

  assertRejected(checkMarketTemplates({ root }), '缺少同目录的 market-entry.template.json')
})
