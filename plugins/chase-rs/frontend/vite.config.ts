import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'

// 宿主运行时支持这些 Federation singleton 标记, 但已发布的 TypeScript 声明里
// 还没暴露 `singleton`(与 example/vite.config.ts 同一处理)。
const hostSharedDependencies = {
  vue: { singleton: true, requiredVersion: false, generate: false },
  'naive-ui': { singleton: true, requiredVersion: false, generate: false },
  '@lucide/vue': { singleton: true, requiredVersion: false, generate: false },
} as any

export default defineConfig({
  plugins: [
    vue(),
    federation({
      // manifest.template.json 的 ui.federation.module = "./AppPage"
      name: 'chase_rs',
      filename: 'remoteEntry.js',
      exposes: {
        './AppPage': './src/AppPage.vue',
      },
      shared: hostSharedDependencies,
    }),
  ],
  build: {
    target: 'esnext',
    outDir: 'build/frontend/dist',
    assetsDir: 'assets',
    cssCodeSplit: true,
    emptyOutDir: true,
  },
})
