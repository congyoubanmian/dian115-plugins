import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'

// 宿主运行时支持这些 Federation singleton 标记, 但已发布的 TypeScript 声明里
// 还没暴露 `singleton`(与 music-dl / chase-rs / example 的 vite.config.ts 同一处理)。
//
// `generate: false` = 不自带副本, 由宿主提供(宿主已把 vue / naive-ui 注入 share scope)。
// 这里不声明 `@lucide/vue`: 本页不用图标库, 声明了反而多一个宿主依赖。
const hostSharedDependencies = {
  vue: { singleton: true, requiredVersion: false, generate: false },
  'naive-ui': { singleton: true, requiredVersion: false, generate: false },
} as any

// 构建入口固定在插件自己的 frontend/(而不是 process.cwd()):
// `build-ui.mjs` 在插件根目录用 music-dl 的 vite 跑 `--config frontend/vite.config.ts`,
// 不固定 root 的话 exposes 会按 cwd 解析, 产物也会落到别处。
const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: rootDir,
  plugins: [
    vue(),
    federation({
      // manifest.template.json 的 ui.federation.module = "./AppPage"
      name: 'music_rs',
      filename: 'remoteEntry.js',
      exposes: {
        './AppPage': './src/AppPage.vue',
      },
      shared: hostSharedDependencies,
    }),
  ],
  build: {
    target: 'esnext',
    // manifest.ui.federation.assets_root = frontend/dist/assets,
    // entry = frontend/dist/assets/remoteEntry.js(与 music-dl 的 outDir/assetsDir 组合一致)。
    outDir: 'dist',
    assetsDir: 'assets',
    cssCodeSplit: true,
    emptyOutDir: true,
  },
})
