#!/usr/bin/env node
// Rust 版音乐下载的本地构建入口: 容器里编译 wasm32, 然后打包签名。
//
//   node build.mjs                 # 容器构建 wasm → 打包签名
//   node build.mjs --skip-wasm     # 只用现有 target/.../plugin.wasm 重新打包
//   node build.mjs --generate-key  # 本地开发: 显式生成开发者私钥(参数透传给 package.mjs)
//
// 环境变量:
//   DIAN115_RUST_BUILD_IMAGE  构建镜像, 默认 dian-rust:wasm32(rust 工具链 + wasm32 target + 依赖缓存)
//   DIAN115_DOCKER            docker 可执行文件, 默认 docker
//   DIAN115_SUDO              docker 是否经 sudo 调用, 默认 "1"(本机 docker 需要 sudo); 设为 "0" 关闭
//   DIAN115_PLUGIN_SIGNING_KEY 签名私钥路径(package.mjs 读取; 未设置时回退到插件目录下的 pem)
//
// 说明: wasm 一律在容器里构建(本机不装 Rust 工具链); 本脚本只负责"构建 + 打包"两件事,
// 构建与测试的门禁由外层脚本统一执行。前端由本插件 frontend/ 产出(骨架期尚未构建)。
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const wasmPath = join(root, 'target', 'wasm32-unknown-unknown', 'release', 'plugin.wasm')
// 前端产物放本插件自己的 frontend/dist/assets —— 与 manifest.ui.federation.assets_root 一致,
// 不再复用 douban-center 的产物(那是 douban-rs 的做法, 本插件自带界面)。
const uiAssetsRoot = join(root, 'frontend', 'dist', 'assets')

const args = process.argv.slice(2)
const skipWasm = args.includes('--skip-wasm') || args.includes('--package-only')
const passthrough = args.filter((arg) => arg !== '--skip-wasm' && arg !== '--package-only')
const dockerBin = process.env.DIAN115_DOCKER || 'docker'
const buildImage = process.env.DIAN115_RUST_BUILD_IMAGE || 'dian-rust:wasm32'
// 本机 docker 需要 sudo; 有免 root docker 的环境设 DIAN115_SUDO=0。
const useSudo = (process.env.DIAN115_SUDO ?? '1') !== '0'

function run(command, commandArgs, label) {
  process.stdout.write(`[build] ${label}: ${command} ${commandArgs.join(' ')}\n`)
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' })
  if (result.error) throw new Error(`${label} 无法执行: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} 失败(exit=${result.status})`)
}

function runDocker(dockerArgs, label) {
  if (useSudo) run('sudo', [dockerBin, ...dockerArgs], label)
  else run(dockerBin, dockerArgs, label)
}

if (!skipWasm) {
  // /src 即本插件目录 —— 与 dian-rust:wasm32 镜像的约定一致; 镜像里已装 wasm32 target,
  // rust:1-slim 这类干净镜像则先补装 target(已装时 rustup 不会联网)。
  const containerScript = [
    'set -e',
    "rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown",
    'cargo build --release --target wasm32-unknown-unknown',
  ].join('\n')
  runDocker(
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

if (!existsSync(uiAssetsRoot)) {
  process.stdout.write(`[build] 警告: 未找到前端产物 ${uiAssetsRoot}\n`)
  process.stdout.write('[build] 前端由本插件 frontend/ 构建产出(npm ci && npm run build:ui); 缺它时 package.mjs 会拒绝打包\n')
}

run(process.execPath, [join(root, 'package.mjs'), ...passthrough], '打包并签名')
