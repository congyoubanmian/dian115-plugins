#!/usr/bin/env node
// Rust 版追剧管家的本地构建入口: 容器里编译 wasm32, 必要时构建前端, 然后打包签名。
//
//   node build.mjs                  # 容器构建 wasm → (缺前端产物时)构建前端 → 打包签名
//   node build.mjs --skip-wasm      # 只用现有 target/.../plugin.wasm 重新打包
//   node build.mjs --build-ui       # 强制重建前端产物
//   node build.mjs --generate-key   # 本地开发: 显式生成开发者私钥(参数透传给 package.mjs)
//
// 环境变量:
//   DIAN115_RUST_BUILD_IMAGE  构建镜像, 默认 dian-rust-builder(rust:1-slim + wasm32 target)
//   DIAN115_DOCKER            docker 可执行文件, 默认 docker
//   DIAN115_NPM               npm 可执行文件, 默认 npm
//   DIAN115_PLUGIN_SIGNING_KEY 签名私钥路径(package.mjs 读取; 未设置时回退到插件目录下的 pem,
//                              再没有则自动生成临时开发密钥用于本地干跑)
//
// 说明: wasm 一律在容器里构建(本机不装 Rust 工具链); 本脚本只负责"构建 + 打包"两件事,
// 构建与测试的门禁由外层脚本统一执行。前端产物由本插件自带的 frontend/(Vue+Federation) 产出。
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const frontendRoot = join(root, 'frontend')
const wasmPath = join(root, 'target', 'wasm32-unknown-unknown', 'release', 'plugin.wasm')
const uiAssetsRoot = join(frontendRoot, 'build', 'frontend', 'dist', 'assets')

const args = process.argv.slice(2)
const skipWasm = args.includes('--skip-wasm') || args.includes('--package-only')
const buildUi = args.includes('--build-ui')
const passthrough = args.filter((arg) => !['--skip-wasm', '--package-only', '--build-ui'].includes(arg))
const dockerBin = process.env.DIAN115_DOCKER || 'docker'
const npmBin = process.env.DIAN115_NPM || 'npm'
const buildImage = process.env.DIAN115_RUST_BUILD_IMAGE || 'dian-rust-builder'

function run(command, commandArgs, label, cwd) {
  process.stdout.write(`[build] ${label}: ${command} ${commandArgs.join(' ')}\n`)
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd })
  if (result.error) throw new Error(`${label} 无法执行: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} 失败(exit=${result.status})`)
}

if (!skipWasm) {
  // /src 即本插件目录 —— 与 dian-rust-builder 的约定一致; 镜像里已装 wasm32 target,
  // rust:1-slim 这类干净镜像则先补装 target(已装时 rustup 不会联网)。
  const containerScript = [
    'set -e',
    "rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown",
    'cargo build --release --target wasm32-unknown-unknown',
  ].join('\n')
  run(
    dockerBin,
    ['run', '--rm', '-v', `${root}:/src`, '-w', '/src', '-e', 'CARGO_TERM_COLOR=always', buildImage, 'sh', '-c', containerScript],
    `容器构建 wasm(${buildImage})`,
  )
} else {
  process.stdout.write('[build] 跳过 wasm 构建(--skip-wasm), 直接使用现有产物\n')
}

if (!existsSync(wasmPath)) {
  throw new Error(`缺少 ${wasmPath}; 先执行容器构建(不要带 --skip-wasm)`)
}
const wasm = statSync(wasmPath)
process.stdout.write(`[build] wasm 产物: ${wasmPath} (${(wasm.size / 1024).toFixed(1)} KB)\n`)

const uiReady = existsSync(join(uiAssetsRoot, 'remoteEntry.js'))
if (buildUi || !uiReady) {
  run(npmBin, ['ci'], '安装前端依赖', frontendRoot)
  run(npmBin, ['run', 'build:ui'], '构建前端产物', frontendRoot)
} else {
  process.stdout.write(`[build] 复用现有前端产物: ${uiAssetsRoot}\n`)
}
if (!existsSync(uiAssetsRoot)) {
  throw new Error(`缺少 ${uiAssetsRoot}; 在 frontend/ 执行 npm ci && npm run build:ui`)
}

run(process.execPath, [join(root, 'package.mjs'), ...passthrough], '打包并签名')
