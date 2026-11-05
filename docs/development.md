# 开发规范

DIAN115 v3 插件（schema 3，`protected-v4` 正式包）的技术栈与工程约束。
写代码前先读这份，别凭印象写 `ctx` 成员——宿主契约以官方插件平台文档为准。

## 技术栈（定死的部分，没得选）

| 层 | 技术 | 为什么 |
|---|---|---|
| **后台任务** | 纯 JavaScript（ESM，`.js`） | 宿主 QuickJS 沙箱：没有 DOM、没有 Node 内置模块、没有 `require`、没有 TS。一切能力走注入的 `ctx` |
| **页面 UI** | Vue 3 + TypeScript + vite | 宿主直接 `import` ESM 产物挂 `mount(el, ctx)`。`v3-ui/` 三个插件共用一套 vite 底座 |
| **测试** | `node --test`（`.mjs`） | 无框架。把能脱离宿主的决策逻辑抽成纯 JS（`lib/*.js`、`poster-chain.js` 这种），测试在 node 里直跑 |
| **打包 / 签发** | 仓库脚本 | `scripts/v3-build.sh`（可读调试包）+ `scripts/v3-compile.mjs`（编译 MCP 出 `protected-v4` 正式包） |

名字里的 `-rs` 是历史标记（「源自 Rust 版」移植），**代码本身是纯 JS/TS**，没有 `.rs`/`.wasm` 产物。

## 目录划分

```
v3/<plugin>/          后台插件源：plugin.json + jobs/*.js + lib/*.js + ui/page.js（vite 产物，入库）
v3-ui/src/<plugin>/   页面源码：Vue 3 + TS → vite 编译进上面的 ui/page.js
v3-ui/src/shared/     三个插件共用的类型/主题/挂载 helper
v3/tests/<plugin>/    node --test 用例（只测 lib/ 与纯 JS 决策逻辑）
v3-kit/               官方插件平台文档、schema、SDK 参考（写接口前先查）
docs/development.md   本文件
```

## 写插件的硬规则

1. **后台 `run(ctx, input)` 是唯一入口**：所有异步 `await`，不用 DOM / Node API / `require`；
2. **业务逻辑进 `lib/` 纯函数**：jobs 只做编排，`lib/` 不碰 `ctx`——这样才能被 `v3/tests/` 覆盖；
3. **数据只走 `ctx`**：页面不直接 fetch 外部站，出站一律 `ctx.http`（带 `ctx.signal`）；
4. **调宿主 API 前先查 `v3-kit/docs/openapi-v3.json`**：参数名/必填字段以 spec 为准——chase.rs 那个 `total_episodes` 400 就是凭印象写参数踩的；
5. **页面跟随宿主主题**：用 `--app-*` 变量 + `ctx.theme`，不自造颜色；`mount(el, ctx)` 必须返回清理函数；
6. **UI 产物入库**：`v3/<plugin>/ui/page.js` 是 vite 产物但要提交，发版闸门 `v3-verify-ui-artifacts.sh` 会比对源码与产物一致性；
7. **版本号**：改任何行为都要 bump `plugin.json` 的 `version` + 在 `v3/CHANGELOG.json` 写当期说明（只写当前版本，不累计历史）。

## 常用命令

```bash
# 全量测试（三个插件的 node --test）
bash scripts/v3-test.sh

# 重建 UI 产物（改完 v3-ui/src/ 必跑，不然产物与源码不一致）
bash scripts/v3-build-ui.sh

# 可读调试包 + 官方审查闸门（发版前置）
bash scripts/v3-build.sh

# 校验 UI 产物与入库版本一致（发版脚本内部也跑这道闸）
bash scripts/v3-verify-ui-artifacts.sh

# 编译 MCP：查环境 / 结构检查 / 出正式包（需 .env.local 里的 DIAN115_*）
node scripts/v3-compile.mjs env
node scripts/v3-compile.mjs check v3/douban-rs
node scripts/v3-compile.mjs compile v3/douban-rs --out dist

# 一键发版：测试 → 构建 → 审查 → 签正式包 → draft Release → 索引 → tag → 发布
bash scripts/release-v3-local.sh v3-YYYY.MM.DD
```

## 市场索引的口径

- **同 `id` 只留最新一条**（宿主「更新」入口会把同 id 的每条记录都列出来，多版本陈列等于满屏同名插件）；
- `changelog` 按条目 version **当期写**，不是累计历史；
- `permissions` / `declared_usage` / `name` / `description` 一律以 `plugin.json` 为准，索引由 `scripts/update-v3-index.mjs` 同步，不手改。

## 什么时候能/不能用别的技术

- **后台想用 Rust/WASM**：不行，QuickJS 沙箱只执行 JS，schema 1 的 WASM 线已废弃；
- **页面想换 React/Svelte**：技术上 vite 能出 ESM，但三件套全是 Vue，换框架=自己另起一套底座，不值；
- **工具链脚本**：随便，现在是 Node `.mjs` + bash，别引新框架。
