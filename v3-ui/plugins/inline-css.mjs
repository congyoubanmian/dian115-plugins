// 把构建出来的 CSS 内联进 ui/page.js。
//
// 宿主只按 ui.entry = "ui/page.js" 加载一个 ESM（见 v3-kit/docs/ui-theme.md），
// 不会另外去取 .css。Vite 默认把 CSS 产成独立资产（style.css），宿主不会加载它，
// 页面就丢样式。所以这里把 CSS 文本塞进 page.js：模块被 import 时往 document.head
// 注入一个 <style>（按插件 id 去重，同一插件反复挂载不会插重复标签；不同插件各用各的
// 标签，避免同时挂载多个插件页面时后加载的页面把先前的 CSS 覆盖掉），并删掉多余的 .css 文件。
//
// enforce: 'post' —— 必须晚于 vite:css-post 的 generateBundle，那里才把 CSS 资产放进 bundle。

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 注入到宿主页面的 <style> 标签 id（插件名参与 id，多个插件页面共存时互不覆盖）。 */
function styleTagId(plugin) {
  return `dian115-v3-ui-style-${String(plugin || 'ui').replace(/[^a-z0-9_-]/gi, '-')}`
}

export function inlineCss(plugin = 'ui') {
  const styleTagID = styleTagId(plugin)
  let outDir = ''

  return {
    name: 'v3-ui:inline-css',
    enforce: 'post',

    configResolved(config) {
      outDir = config.build.outDir
    },

    generateBundle(_options, bundle) {
      let css = ''
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !fileName.endsWith('.css')) continue
        css += typeof output.source === 'string'
          ? output.source
          : Buffer.from(output.source).toString('utf8')
        delete bundle[fileName]
      }
      if (!css) return

      const inject = [
        '',
        '// ── v3-ui：样式自包含（宿主只加载 ui/page.js，不会另外取 .css）────────',
        '(function () {',
        '  if (typeof document === "undefined") return;',
        `  var css = ${JSON.stringify(css)};`,
        '  if (!css) return;',
        '  var root = document.head || document.documentElement;',
        '  if (!root) return;',
        `  var tag = document.getElementById(${JSON.stringify(styleTagID)});`,
        '  if (!tag) {',
        '    tag = document.createElement("style");',
        `    tag.id = ${JSON.stringify(styleTagID)};`,
        '    tag.setAttribute("data-v3-ui", "");',
        '    root.appendChild(tag);',
        '  }',
        '  tag.textContent = css;',
        '})();',
        '',
      ].join('\n')

      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || !output.isEntry) continue
        output.code += inject
      }
    },

    /**
     * 清掉上一轮构建遗留的 .css（emptyOutDir=false，不会自动清）。
     */
    closeBundle() {
      if (!outDir || !existsSync(outDir)) return
      for (const name of readdirSync(outDir)) {
        if (name.endsWith('.css')) rmSync(join(outDir, name), { force: true })
      }
    },
  }
}
