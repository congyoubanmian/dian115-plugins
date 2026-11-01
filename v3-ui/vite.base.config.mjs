// v3 插件界面的共享构建配置（三个插件各有一份薄配置 vite.<plugin>.config.mjs 调用这里）。
//
// 产物形态（宿主 v3 契约，见 v3-kit/docs/ui-theme.md）：
// - ui.entry 固定为 ui/page.js，宿主直接 import 这个 ESM 并调用它导出的 mount(el, ctx)；
// - 入口文件名固定 page.js：宿主只认这一个名字，不能带 hash；
// - 依赖全部打进产物（vue / naive-ui / @lucide/vue 自打包），不用 Module Federation、
//   也不依赖宿主共享单例——宿主加载页面时不保证提供这些库；
// - 不 external 任何依赖：页面在宿主里是普通浏览器 ESM，不能有裸 import。
//
// 构建目录说明：root 固定是 v3-ui/，outDir 用相对路径 ../v3/<plugin>/ui（相对 root），
// 也就是仓库根下的 v3/<plugin>/ui/。
//
// emptyOutDir:false —— 输出目录里还有别的源码文件（例如 music-rs 的 ui/qr.js），
// 不能被清空；重复构建由脚本保证幂等（见 scripts/v3-build-ui.sh）。

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { inlineCss } from './plugins/inline-css.mjs'
import { scopedStyleGuard } from './plugins/scoped-style-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 插件 ID（与 v3/<plugin>/ 目录名一致）。 */
export const PLUGINS = ['chase-rs', 'music-rs', 'douban-rs']

/**
 * 生成单个插件的 vite 配置。
 * @param {string} plugin 插件目录名（chase-rs / music-rs / douban-rs）
 */
export function createConfig(plugin) {
  if (!PLUGINS.includes(plugin)) {
    throw new Error(`未知插件: ${plugin}（可选: ${PLUGINS.join(', ')}）`)
  }
  return {
    // root = v3-ui/，于是 outDir 的 ../v3/<plugin>/ui 就是仓库根下的 v3/<plugin>/ui。
    root: here,
    plugins: [scopedStyleGuard(), vue(), inlineCss(plugin)],
    build: {
      outDir: `../v3/${plugin}/ui`,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      // 样式统一打成一个文件，再由 inline-css 插件塞进 page.js（宿主只加载 page.js，
      // 不会另外去取 .css；样式必须自包含在入口里）。
      cssCodeSplit: false,
      // vite 8 用 rolldown/oxc 压缩（默认就是 oxc）；不要再写 'esbuild'——
      // vite 8 不再自带 esbuild，会直接构建失败。
      minify: 'oxc',
      rollupOptions: {
        // vite 8 的非 lib 构建默认 preserveEntrySignatures:false，
        // 会把没人 import 的入口导出（mount）当死代码删掉 —— 产物就是一个空 page.js。
        // 宿主是 import 产物再调用 mount()，必须保留入口签名。
        preserveEntrySignatures: 'strict',
        input: resolve(here, 'src', plugin, 'main.ts'),
        output: {
          format: 'es',
          // 入口名固定：宿主按 ui.entry = "ui/page.js" 加载。
          entryFileNames: 'page.js',
          // 动态 import 产生的分块（宿主按相对路径取，与 page.js 同目录）。
          chunkFileNames: 'chunks/[name]-[hash].js',
          // 图片/字体等资源平铺在 ui/ 根下，名字不带目录。
          assetFileNames: '[name][extname]',
        },
      },
    },
  }
}
