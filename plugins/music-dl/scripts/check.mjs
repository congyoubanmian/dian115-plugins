import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 简化版 conformance 检查：校验构建产物齐全、ELF 静态、Manifest 可解析。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []

function checkStaticELF(buffer) {
  if (buffer.length < 64 || buffer.subarray(0, 4).toString('hex') !== '7f454c46') {
    errors.push('runtime/plugin 不是 ELF 文件')
    return
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    errors.push('runtime/plugin 不是 64 位小端 ELF')
  }
  const programOffset = Number(buffer.readBigUInt64LE(32))
  const programEntrySize = buffer.readUInt16LE(54)
  const programCount = buffer.readUInt16LE(56)
  for (let index = 0; index < programCount; index += 1) {
    const offset = programOffset + (index * programEntrySize)
    if (buffer.readUInt32LE(offset) === 3) errors.push('runtime/plugin 含 PT_INTERP（动态链接）')
  }
}

const runtimePath = join(root, 'build', 'runtime', 'plugin')
const assetsRoot = join(root, 'build', 'frontend', 'dist', 'assets')
const manifestPath = join(root, 'manifest.template.json')

if (!existsSync(runtimePath)) errors.push('缺少 build/runtime/plugin（先运行 npm run build:runtime）')
else checkStaticELF(readFileSync(runtimePath))

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
