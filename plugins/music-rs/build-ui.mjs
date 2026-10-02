#!/usr/bin/env node
// 本插件的 UI 构建入口 —— 复用 music-dl 已经装好的 node_modules, 不在本插件里再装一份依赖。
//
// 用法(在 plugins/music-rs 目录直接跑):
//
//   node build-ui.mjs            # 构建 frontend/ → frontend/dist/assets(含 remoteEntry.js)
//   node build-ui.mjs --check    # 先跑 vue-tsc --noEmit 再构建
//
// 产物落点与 manifest.ui.federation 一致:
//   entry       frontend/dist/assets/remoteEntry.js
//   assets_root frontend/dist/assets
// 正是 package.mjs 校验的位置(`uiAssetsRoot`)。
//
// 为什么要在构建期间放一个 frontend/node_modules 软链:
//   vite 加载 `--config frontend/vite.config.ts` 时会把配置里的裸导入
//   (vite / @vitejs/plugin-vue / @originjs/vite-plugin-federation)按"配置文件所在目录"
//   向上找 node_modules; 本插件目录里没有 node_modules, 找不到就直接报
//   "Failed to resolve ..."。软链指向 music-dl 的那份, 配置与源码的模块解析都能用同一套依赖。
//   构建结束(含异常/中断)会删掉这个软链, 所以 frontend/ 里不会留下 node_modules, 也不复制任何依赖。
import { existsSync, lstatSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const frontendDir = join(root, 'frontend')
const configPath = join(frontendDir, 'vite.config.ts')
const distAssets = join(frontendDir, 'dist', 'assets')
const linkPath = join(frontendDir, 'node_modules')

// 依赖来源: 同仓库的 music-dl 插件(可用 DIAN115_UI_DEPS 覆盖成别的 node_modules 目录)。
const depsDir = process.env.DIAN115_UI_DEPS || join(root, '..', 'music-dl', 'node_modules')
const viteBin = join(depsDir, 'vite', 'bin', 'vite.js')
const vueTscBin = join(depsDir, 'vue-tsc', 'bin', 'vue-tsc.js')

const withCheck = process.argv.slice(2).includes('--check')

function run(command, args, label, cwd) {
  process.stdout.write(`[build-ui] ${label}: ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, { stdio: 'inherit', cwd })
  if (result.error) throw new Error(`${label} 无法执行: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} 失败(exit=${result.status})`)
}

// ── 临时软链: frontend/node_modules → <depsDir> ──────────────────────────────

let createdLink = false

function isOurLink() {
  try {
    return lstatSync(linkPath).isSymbolicLink()
  } catch {
    return false
  }
}

function ensureDepsLink() {
  if (!existsSync(depsDir)) {
    throw new Error(`找不到依赖目录 ${depsDir}; 请确认 ${join(root, '..', 'music-dl')}/node_modules 存在, 或用 DIAN115_UI_DEPS 指定`)
  }
  if (!existsSync(viteBin)) throw new Error(`找不到 vite 可执行入口 ${viteBin}`)
  if (!existsSync(configPath)) throw new Error(`找不到 ${configPath}`)

  if (existsSync(linkPath) || isOurLink()) {
    if (isOurLink()) {
      // 上一次异常退出留下的软链: 清掉重建, 结束时会一并删除。
      rmSync(linkPath, { force: true })
    } else {
      process.stdout.write(`[build-ui] 复用已存在的 ${linkPath}(不创建也不删除)\n`)
      return
    }
  }
  symlinkSync(depsDir, linkPath, 'dir')
  createdLink = true
  process.stdout.write(`[build-ui] 临时软链 ${linkPath} -> ${depsDir}\n`)
}

function removeDepsLink() {
  if (!createdLink) return
  try {
    rmSync(linkPath, { force: true })
    createdLink = false
    process.stdout.write('[build-ui] 已移除临时软链 frontend/node_modules\n')
  } catch (error) {
    process.stderr.write(`[build-ui] 警告: 临时软链删除失败(${error.message}); 请手工删除 ${linkPath}\n`)
  }
}

process.on('exit', removeDepsLink)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    removeDepsLink()
    process.exit(1)
  })
}

// ── 构建 ────────────────────────────────────────────────────────────────────

try {
  ensureDepsLink()

  if (withCheck) {
    if (!existsSync(vueTscBin)) throw new Error(`--check 需要 ${vueTscBin}`)
    run(process.execPath, [vueTscBin, '--noEmit', '-p', join(frontendDir, 'tsconfig.json')], '类型检查(vue-tsc)', root)
  }

  // cwd 用 frontend/(= vite root): Federation 的 exposes 是相对路径 './src/AppPage.vue',
  // 由 rollup 按 process.cwd() 解析; 在插件根目录跑会解析成 <插件根>/src/AppPage.vue 而报
  // "Could not resolve entry module"。
  run(process.execPath, [viteBin, 'build', '--config', configPath], '构建前端(vite)', frontendDir)

  if (!existsSync(join(distAssets, 'remoteEntry.js'))) {
    throw new Error(`构建完成但没有 ${join(distAssets, 'remoteEntry.js')}; 检查 vite.config.ts 的 outDir/assetsDir`)
  }
  const files = readdirSync(distAssets)
    .map((name) => ({ name, size: statSync(join(distAssets, name)).size }))
    .sort((a, b) => a.name.localeCompare(b.name))
  process.stdout.write(`[build-ui] 产物 ${relative(root, distAssets)}/ (${files.length} 个文件):\n`)
  for (const file of files) {
    process.stdout.write(`[build-ui]   ${file.name}  ${(file.size / 1024).toFixed(1)} KB\n`)
  }
} finally {
  removeDepsLink()
}
