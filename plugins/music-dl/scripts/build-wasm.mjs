import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 构建 DIAN115 的 WASM 运行时插件。
// 需要 Go 1.22+（wasip1 支持）与 dian115:wasm@1 ABI:
// 产物是 reactor（导出 _initialize / dian115_alloc / dian115_handle / memory，不含 _start）。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'build', 'runtime', 'plugin.wasm')
mkdirSync(dirname(output), { recursive: true })

const result = spawnSync(
  'go',
  ['build', '-buildmode=c-shared', '-trimpath', '-ldflags=-s -w', '-o', output, './runtime'],
  {
    cwd: root,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'wasip1', GOARCH: 'wasm' },
    encoding: 'utf8',
    stdio: 'inherit',
  },
)

if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Go wasm build failed with exit code ${result.status}`)
process.stdout.write(`Built WASM runtime: ${output}\n`)
