// 构建期守卫：v3 插件页面的 SFC 样式必须是 scoped。
//
// v3 页面由宿主直接 import ESM 挂载到宿主 DOM 里（见 v3-kit/docs/ui-theme.md），
// 页面里的 <style> 会跟着进宿主页面。非 scoped 的选择器会漏到宿主全局，
// 改坏宿主样式这类问题在真机上只能靠肉眼发现，所以挡在构建阶段。
//
// enforce: 'pre' —— 早于 @vitejs/plugin-vue 的 transform，看到的是 .vue 原始源码。

export function scopedStyleGuard() {
  return {
    name: 'v3-ui:scoped-style-guard',
    enforce: 'pre',

    transform(code, id) {
      const [file] = id.split('?')
      // 只看 .vue 主文件；?vue&type=style 之类的子请求跳过。
      if (!file.endsWith('.vue') || id.includes('?')) return null

      for (const [, attrs] of code.matchAll(/<style\b([^>]*)>/g)) {
        if (/\bscoped\b/.test(attrs) || /\bmodule\b/.test(attrs)) continue
        throw new Error(
          `[v3-ui] ${file} 的 <style> 必须是 scoped：v3 页面挂在宿主 DOM 里，` +
            '非 scoped 的样式会漏到宿主页面（宿主全局样式不允许被覆盖）。',
        )
      }
      return null
    },
  }
}
