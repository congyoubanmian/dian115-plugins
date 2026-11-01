# v3-ui —— 三个 v3 插件的 Vue 3 界面底座

这里是 `chase.rs` / `music.rs` / `douban.rs` 三个插件的 **Vue 3 页面源码**与**共享构建底座**。

## 目录

```
v3-ui/
  package.json           共享依赖（vue / naive-ui / @lucide/vue）与构建脚本
  package-lock.json      入库；npm ci 按它装，保证可重复
  tsconfig.json          vue-tsc 类型检查用的配置
  vite.base.config.mjs   三个插件共用的构建规则（输出路径 / 文件名 / 压缩 / 插件）
  vite.chase.config.mjs  ┐
  vite.music.config.mjs  ├ 每个插件一份薄配置，只写自己的名字
  vite.douban.config.mjs ┘
  plugins/
    scoped-style-guard.mjs  构建期强制 SFC 的 <style> 必须 scoped
    inline-css.mjs          把 CSS 内联进 page.js（宿主只加载 page.js）
  scripts/
    mini-dom.mjs        极简 DOM 垫片（只为离线冒烟，不追求通用）
    smoke-mount.mjs     把产物挂一次，验证 mount / 主题 / 清理
  src/
    shared/              三个插件共用的装配代码（ctx 注入、主题桥）
    chase-rs/            追剧管家页面（main.ts + AppPage.vue）
    music-rs/            音乐下载页面（登录卡支持网易云 / QQ 音乐两种扫码来源；歌单支持网易云与 QQ 音乐，QQ 另有「每日推荐」与「我喜欢」）
    douban-rs/           豆瓣中心页面
  legacy/                改写前的原生 JS 版页面（行为基准，只读）
```

## 构建

```sh
cd v3-ui
npm ci            # 按入库的 package-lock.json 安装，可重复
npm run build     # 依次构建 chase-rs / music-rs / douban-rs
```

或从仓库根一键构建（**CI 与发布流水线走这条**）：

```sh
bash scripts/v3-build-ui.sh
```

脚本按 **chase → music → douban** 的固定顺序构建，幂等（同一份源码重复构建得到同样的产物），
构建后自动跑三项自检：入口存在、`node --check` 语法检查、最小 DOM 冒烟挂载。

### 在哪个目录敲这条命令

`scripts/v3-build-ui.sh` 是**相对路径**，所以门禁/脚本的**工作目录**决定它解析到哪个文件。
本 workspace 里同一个相对路径出现过两种 cwd（`/home/momo/go` workspace 根与仓库根），
为免踩坑，两处都放了转发脚本，敲同一条命令都能跑：

| cwd | `bash scripts/v3-build-ui.sh` 解析到 |
| --- | --- |
| `/home/momo/go`（workspace 根） | `/home/momo/go/scripts/v3-build-ui.sh` → 转发到仓库根脚本 |
| 仓库根 `/home/momo/go/douban-center-wasm` | `scripts/v3-build-ui.sh` → **真脚本** |
| `v3-ui/`（包目录） | `v3-ui/scripts/v3-build-ui.sh` → 转发到仓库根脚本 |

真脚本内部用 `BASH_SOURCE` 推导仓库根，**自己被调用时的 cwd 无关**。

## 产物

产物直接落在插件目录里，和宿主按 `ui.entry = "ui/page.js"` 加载的路径一致：

```
v3/<plugin>/ui/page.js      ESM，导出 mount(el, ctx)
v3/<plugin>/ui/chunks/      动态 import 产生的分块（按需出现）
```

输出规则（`vite.base.config.mjs`）：

| 项 | 值 | 为什么 |
| --- | --- | --- |
| `entryFileNames` | `page.js` | 宿主只认这一个名字（`ui.entry`） |
| `chunkFileNames` | `chunks/[name]-[hash].js` | 动态 import 的分块，宿主按相对路径取 |
| `assetFileNames` | `[name][extname]` | 图片等资源平铺在 `ui/` 下 |
| `format` | `es` | 宿主直接 `import` 这个 ESM |
| `target` | `es2022` | 宿主是现代浏览器 |
| `external` | 无 | vue / naive-ui / @lucide/vue 全部打进产物 |
| `preserveEntrySignatures` | `strict` | 不加这条，vite 8 会把没人 `import` 的 `mount` 导出当死代码删掉，产物是空文件 |

### 样式为什么内联进 page.js

宿主只加载 `ui/page.js` 这一个 ESM，不会另外去取 `.css`。Vite 默认把 CSS 产成独立的
`style.css`，页面就会丢样式。所以 `plugins/inline-css.mjs` 在打包时把 CSS 文本塞进
`page.js`，模块被 import 时往 `document.head` 注入一个 `<style>`（固定 id 去重）。

### 样式为什么必须 scoped

v3 页面是挂在宿主 DOM 里的，页面里的 `<style>` 会跟着进宿主页面。非 scoped 的选择器
（比如 `body { margin: 0 }`）会改坏宿主样式——这类问题在真机上只能靠肉眼发现。
`plugins/scoped-style-guard.mjs` 在构建期直接报错挡住。

## 页面契约

入口 `src/<plugin>/main.ts` 导出 `mount(el, ctx)`：

```ts
export function mount(el: HTMLElement, ctx: HostContext): () => void {
  return mountPlugin(el, ctx, AppPage)
}
```

- `el` 是宿主给的挂载容器，宿主保证它在插件区域内。
- `ctx` 是宿主上下文，**页面所有数据与能力都只能走它**：`ctx.api` / `ctx.storage` /
  `ctx.settings` / `ctx.tasks` / `ctx.http` / `ctx.notifications` / `ctx.cookiecloud` /
  `ctx.theme` / `ctx.signal`。不要直接 `fetch` 宿主业务接口。
- 返回的清理函数负责退订主题并卸载 app；宿主关闭页面时调用它。

`shared/mount.ts` 做了每个插件都要写的那一遍：把 ctx 注入组件树、把宿主主题接到
naive-ui 的 `n-config-provider`、保证 app 被卸载。插件页面只管内容。

### 主题

`ctx.theme.mode` 是 `light` / `dark`，`ctx.theme.subscribe(fn)` 立即回调当前值并返回
退订函数。`shared/theme.ts` 把它桥成 Vue 响应式状态，`shared/mount.ts` 据此给
naive-ui 的 `n-config-provider` 传 `darkTheme` / `null`，卸载时退订。

### 颜色与排版

页面继承宿主 CSS 变量，直接用即可，不要写死颜色：

`--app-bg` / `--app-surface` / `--app-text` / `--app-text-secondary` / `--app-border` / `--app-accent`

### 滚动

页面占满内容区并在插件区域内滚动：根元素 `height: 100%; overflow: auto`。
`position: sticky` 相对插件区域生效。

## 设置

清单 `plugin.json` 的 `settings[]` 保留（宿主在「管理」页渲染表单）。页面里用
`ctx.settings.get()` / `ctx.settings.set()` 读写同一份设置，不要另存一份，
免得两处不一致。

## 类型检查与冒烟

```sh
cd v3-ui
npm run typecheck                      # vue-tsc --noEmit
node scripts/smoke-mount.mjs chase-rs  # 挂一次，验证 mount / 主题 / 清理
```

冒烟用 `scripts/mini-dom.mjs`（自写的极简 DOM 垫片，约 400 行）——只实现 Vue 运行时与
naive-ui 挂载阶段用到的那些 DOM 操作，目的是在没有浏览器、也不引入 jsdom 依赖的前提下
离线验证产物。**它不是通用 DOM 实现**，别拿它跑别的。

## 产物是否入库

**入库**：`v3/<plugin>/ui/page.js` 与 `chunks/` 随仓库提交。理由：

1. 宿主按 `ui.entry` 直接加载这个文件，`scripts/v3-build.sh` 的打包步骤（`pack.mjs`）
   会把插件目录整个打成 `.dian115p`——产物必须已经在目录里，打包才不用先跑 Node 构建。
2. 发布流水线（`.github/workflows/release-v3.yml`）在 CI 上重建并比对产物与源码是否一致，
   不一致就报错。产物入库，CI 才能做这个比对。

**不入库**：`node_modules/`、vite 缓存。见仓库根 `.gitignore`。

## 依赖说明

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| vue | 3.5.44 | 页面框架（自打包进 page.js） |
| naive-ui | ^2.38 | 组件库（自打包） |
| @lucide/vue | ^1.61 | 图标（自打包） |
| vite | ^8.3 | 构建（vite 8 用 rolldown/oxc，不再自带 esbuild） |
| @vitejs/plugin-vue | ^6 | SFC 编译 |
| typescript | `npm:@typescript/typescript6@^6.0.2` | 类型检查 |
| vue-tsc | ^3.3.14 | `.vue` 的类型检查 |

关于 typescript 的别名：vue-tsc 需要 `typescript/lib/tsc`，而 typescript 7（原生编译器）
不再导出这个子路径，直接装会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。vue-tsc 自己支持把
`typescript` 别名到 `@typescript/typescript6`（内部再用 `@typescript/old` 拿真正的 tsc），
所以这里用别名装 TS 6——`npm run typecheck` 可正常跑通。
