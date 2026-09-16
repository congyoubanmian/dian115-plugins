import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 简化版 conformance 检查：校验构建产物齐全、WASM 模块头、Manifest 可解析。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

function checkWasmModule(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('hex') !== '0061736d') {
    errors.push('runtime/plugin.wasm 不是 WASM 模块')
  }
}

const runtimePath = join(root, 'build', 'runtime', 'plugin.wasm')
const assetsRoot = join(root, 'build', 'frontend', 'dist', 'assets')
const manifestPath = join(root, 'manifest.template.json')

if (!existsSync(runtimePath)) errors.push('缺少 build/runtime/plugin.wasm（先运行 npm run build:wasm）')
else checkWasmModule(readFileSync(runtimePath))

if (!existsSync(join(assetsRoot, 'remoteEntry.js'))) errors.push('缺少 build/frontend/dist/assets/remoteEntry.js（先运行 npm run build:ui）')

if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!manifest.id || !manifest.runtime?.entry) errors.push('Manifest 缺少 id 或 runtime.entry')
  } catch {
    errors.push('manifest.template.json 不是合法 JSON')
  }
} else {
  errors.push('缺少 manifest.template.json')
}

if (errors.length) {
  for (const e of errors) console.error('✗', e)
  process.exit(1)
}
console.log('✓ 构建产物与 Manifest 检查通过')
