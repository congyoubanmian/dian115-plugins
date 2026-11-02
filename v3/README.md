# DIAN115 v3 迁移说明（chase.rs / music.rs / douban.rs）

本目录是三个旧 schema 1（Rust → WASM）插件在 DIAN115 v3 可信扩展形态下的迁移产物：

| 插件 | v3 源码目录 | 版本 | 任务数 | 旧实现 |
| --- | --- | --- | --- | --- |
| 追剧管家 `chase.rs` | `v3/chase-rs/` | 0.1.13 | 4 | 旧 schema 1 Rust 版 0.1.9（源码已删除） |
| 音乐下载 `music.rs` | `v3/music-rs/` | 1.2.1 | 2 + 1 event | 旧 schema 1 Rust 版 0.3.19（源码已删除） |
| 豆瓣中心 `douban.rs` | `v3/douban-rs/` | 1.1.4 | 16 | 旧 schema 1 Rust 版 0.2.4（源码已删除） |

约定：宿主插件 API 为 **3.5**（chase.rs / douban.rs 的 `requires.api` 为 `"3.5"`）；**music.rs 为 `"3.9"`**——
它要用 `save_to` 直写用户目标目录（省一次跨盘拷贝），宿主不开放该能力时自动回落「暂存 → 定名 → move」。后台是宿主内 ESM
JavaScript（无 `require`、无 Node 内置模块、无子进程），页面是 `ui/page.js` 导出的
`mount(el, ctx)`。页面已迁到 **Vue 3**（vue / naive-ui / lucide 全部自打包进 `ui/page.js`，
不依赖宿主共享单例）；界面源码与依赖在仓库根的 `v3-ui/`，见[「界面（Vue 3）」](#界面vue-3)。
旧的 schema 1（Rust → WASM）源码已随归档删除：新宿主只认 `protected-v4` 编译包，旧 `.d115p` 装不上也更新不了，历史仍可从 git tag 找回。

> **验证边界**：本机没有可用的 DIAN115 宿主（授权被锁）。已完成的是离线检查：`project-check`、
> `node --check`、`node --test`、`pack.mjs`、索引 JSON 校验。**安装、inspect/确认、定时任务、
> 站点登录、通知投递、CD2 入库都没有在真机宿主上验证**，详见文末[验证状态](#验证状态)。

## 目录与产物

```
v3/chase-rs/            v3 插件源码（plugin.json + jobs/ + lib/ + ui/；**测试不进插件目录**）
v3/tests/<plugin>/      各插件的离线单测与夹具（在插件目录之外，不进 .dian115p 包）
v3/music-rs/
v3/douban-rs/
v3-ui/                  三个插件的 Vue 3 界面源码 + 共享构建底座（依赖在 v3-ui/node_modules，不入库）
v3-market-index.json    v3 市场索引（schema_version 3，三个插件，delivery=source）
scripts/v3-build-ui.sh  一键构建 Vue 界面 → v3/<plugin>/ui/（幂等）
scripts/v3-build.sh     一键 构建界面 → project-check → pack → sha256（幂等）
dist/                   构建产物 .dian115p（本地生成，不提交；现有 .gitignore 的 *.d115p 不匹配该后缀）
```

各插件目录的 `package.json` 只声明 `{"type":"module"}`，让该目录 `.js` 按 ESM 解析；插件目录里
没有 npm 依赖——界面依赖都打在 `ui/page.js` 里（见「界面（Vue 3）」）。

## 旧 → 新映射

旧形态是 schema 1 的 Rust → WASM（`manifest.template.json` + `src/*.rs`），其源码已随归档删除
（历史可从 git tag 找回）；新形态以 `v3/*/plugin.json`、`v3/*/jobs/*.js`、`v3/*/ui/page.js` 为准。
下表保留为对照用的维度说明。

| 维度 | 旧（schema 1，WASM） | v3 |
| --- | --- | --- |
| 清单 | `manifest.template.json`：`schema_version: 1`、`compatibility.plugin_api: "^2.0"` | `plugin.json`：`schema_version: 3`、`requires.api: "3.5"`（music.rs 3.9） |
| 运行时 | `runtime.kind: "wasm"`、`entry: "runtime/plugin.wasm"`、`protocol: "dian115:wasm@1"`、`memory_mb` / `max_concurrency` / `restart_policy`；Rust 侧 `abi.rs` / `arena.rs` / `host.rs` / `protocol.rs` | **删除 `runtime` 段**。宿主按任务加载 `jobs/<id>.js` 的 ESM 入口；无常驻 VM，每次运行由 `run(ctx, input)` 进入，`recover(ctx, checkpoint)` 续跑；超时/并发由清单的 `timeout_seconds` / `allow_overlap` 描述 |
| 任务与调度 | 清单 `jobs[]` 只写 `id` + Rust `handler` 名（如 `alignHourly`）+ `default_schedule`；WASM 内自行分发 | 清单 `jobs[]` 写 `entry` / `handler` / `recover` / `default_schedule`（cron）或 `interval_seconds` / `timeout_seconds` / `queue`；页面动作是 `queue:false` 的短任务 |
| 事件 | `events: ["telegram.callback"]`（music-rs），WASM 内处理回调 | `events: [{event: "callback", job: "tg-callback"}]`：事件触发一个普通任务；music-rs 用它重排失败任务 |
| 权限声明 | `permissions.apis[]`（method/path/reason）+ `permissions.network[]`（origin/methods/proxy_mode/reason），安装时作为白名单 | **v3 清单没有 `permissions` 段**。代码里实际调用 `ctx.api` / `ctx.http` / `ctx.files` / `ctx.notify` / `ctx.storage`；宿主在安装/更新时静态扫描实际代码、运行时继续做权限检查（`v3-kit/docs/security.md`），拒绝即 403 或拒绝安装。`declared_usage` 如实写明接口、站点、文件、通知与风险，只作告知，不是白名单 |
| 宿主 API 调用 | WASM `host.rs` 拼 HTTP：`/api/plugin-runtime/storage/:key`、`/api/notifications/plugin`、`/api/plugin-host/files/*`、`/api/local-files/*` 等 | `ctx.api.get/post/patch`（业务接口）、`ctx.storage.get/set/remove`、`ctx.notify(...)`、`ctx.files.call(...)`、`ctx.http.request(...)`、`ctx.crypto` / `ctx.codec`、`ctx.tasks.run/get`（页面） |
| 存储与并发 | `GET/PUT /api/plugin-runtime/storage/:key` + ETag `If-Match` + WASM 内幂等键；状态文档常驻内存 | `ctx.storage` 的 `revision` / `expected_revision` CAS（后台 `set` 返回版本数字，页面返回 `{revision}`）；状态文档每次任务重新读取，不常驻。幂等键头不再发送（`ctx.api` 不暴露自定义头） |
| 下载与文件 | 宿主代下载 `/api/plugin-host/files/downloads` + 轮询 job；`/api/local-files/rename`、`/api/local-files/copy`；music-rs 另有 CD2 gRPC-Web 直送 | `ctx.http.request({save_to})` 流式下载到插件自有目录；`ctx.files.call({operation: 'rename' 或 'move' ...})` 由宿主带进度执行并自动分流 CD2 挂载路径；不再有插件内 CD2 客户端 |
| 通知 | `POST /api/notifications/plugin`（music-rs 的 `callback_data` 会被 400 拒） | `ctx.notify({title, body, buttons, dedupe_key, ...})`，原生支持按钮回调；返回逐渠道结果 |
| UI 入口 | `ui.mode: "federation"` + `ui.federation.entry: "frontend/dist/assets/remoteEntry.js"` + `module: "./AppPage"`（Vue 远程模块） | `ui.entry: "ui/page.js"`，`export async function mount(el, ctx)`；`menu` / `icon` 也在清单里 |
| UI ↔ 后台桥 | 旧前端通过 WASM 的 `state` / `action` op 回调（`invokeAction` → `RuntimeCallback`）取状态、发动作 | 页面直接 `ctx.storage.get('state')` / `ctx.settings.get()` 读，`ctx.tasks.run(job, business_key, input)` + `ctx.tasks.get(id)` 发动作并轮询；`ctx.http` 可在页面直接取图 |
| 设置 | 设置嵌在状态文档里，WASM 侧白名单合并 | **设置做在页面里**（有页面的插件不再声明清单 `settings[]`）；`ctx.settings.get/set` 与后台共用，宿主把值存 `settings` KV；代码侧 `FLAT_DEFAULTS` 兜底，复杂配置仍留在状态文档 |
| CookieCloud | 插件自己配置地址/UUID/口令 + 插件内 AES-CBC 解密（`cookiecloud.rs`） | **已下线**：宿主新规约禁止插件读 CookieCloud；douban.rs / music.rs 的登录态只来自扫码或用户手动粘贴 |
| 交付 | schema 1 签名包（Ed25519，`publisher.key_id`，`*.d115p`） | `.dian115p` 源码 ZIP（`v3-kit/conformance/pack.mjs`），`delivery: "source"`；宿主安装时静态分析实际代码并让用户确认 token，加密交付是可选项，本仓库三个插件都没有用 |

更完整的平台规则见 `v3-kit/docs/developer-guide.md`（清单/任务/发布）、`package-format.md`
（`.dian115p`）、`market.md`（市场索引）与 `host-api-quick-reference.md`（`ctx` 能力）。

## 各插件 covered / gaps

### 追剧管家（`v3/chase-rs`，chase.rs 0.1.13）

**Covered（离线可验证）**

- 4 个任务：`align`（`0 * * * *`，整点对齐）、`align-now`、`refresh`、`probe-dump`，均带 `recover`。
- 判定层与旧 Rust 对应：只增 PATCH `total_episodes`、单轮条数/单条抬升上限、dry-run、四类互斥跳过文案；
  减方向只出建议，从不写。
- Emby 覆盖探测：实例选择、参数矩阵与指纹缓存、探测预算；TMDB 只取该季集数，不用整剧集数顶替。
- 订阅池读取（`media_type=tv`，≤4 页 × 500）、追剧日历、每日日报（`ctx.notify` + `dedupe_key`）。
- 状态文档：默认值/上限裁剪/256KB 逐级降级，`expected_revision` CAS；404 两次确认视为全新安装，
  其他读取失败不落盘。
- 旧页面 12 个用户配置项现在都在页面设置抽屉里（清单不再声明 `settings[]`）；页面用 Vue 3 重写（源码 `v3-ui/src/chase-rs/`），
  保留指标瓦片（`StatTile.vue`）、看板（`AlignCard.vue`）与移动端单栏（`styles.css` 里
  `@media (max-width: 1000px)` 收成单列）。
- 117 个 `node --test` 用例通过。

**Gaps**

- `Idempotency-Key` 请求头不再携带（`ctx.api` 无自定义头）。生成逻辑与测试仍在 `lib/intents.js`，但不上线；
  幂等改由「只增」+ 宿主任务队列 `business_key` 保底。
- `align-now` / `refresh` 由旧版「只写内存」改为结束时落盘 —— v3 任务之间没有常驻内存，不落盘页面读不到结果。
- 旧版没有事件订阅，v3 也不声明 `events[]`；没有新增消息/回调能力。
- 每日报告的实际渠道取决于宿主通知配置；旧版经宿主通知端点投递，本次未在真机核对渠道与按钮渲染。

### 音乐下载（`v3/music-rs`，music.rs 1.2.1）

**Covered（离线可验证）**

- 搜索：网易云 `/api/cloudsearch/pc`、QQ `search_for_qq_cp`，页面直连。
- 登录：两个来源的扫码都在插件内实现 —— 网易云（unikey + 页面本地 QR 编码 + 轮询）、QQ 音乐
  （`xui.ptlogin2.qq.com` 官方 PNG 二维码 → `ptqrlogin` 轮询 → `check_sig` / `login_jump` / `authorize` →
  musicu `QQLogin` 换 `musicid`/`musickey`，重定向目标按 host+path 白名单校验）；登录链路的临时 Cookie
  只留在宿主 session（`network.md:15`），凭据只落插件 KV；另有手动粘贴 Cookie（白名单清洗 + 合并）与
  手动粘贴 Cookie 作回退（不读 CookieCloud）。
- 取链：网易云 eapi（AES-128-ECB + MD5，走 `ctx.crypto`）8 档音质阶梯；QQ `master/flac/320/128`
  7 档阶梯。
- 歌单：全量索引 + 分页详情，整单分批入队（每批 5 页 × 100 首，`next_page` 续批）。
- QQ 音乐歌单（musicu RPC）：我创建的 / 收藏的 / 每日推荐 / 我喜欢四个入口，曲目按
  `begin/num` 游标取；私密歌单公开接口回「成功但空壳」时改走自建接口；「我喜欢」跨页去重，
  重复页报「未能完整读取」；收藏歌单撞分页硬上限时返回已读到的部分 + 说明。缺账号标识
  （`encryptUin`，只有 QQLogin 响应里有）时如实提示「收藏读不到」，不装作「没有收藏」。
- 下载队列：KV 分片（`tasks.idx` + `task.<id>`），按 `source+song_id+quality` 去重；
  `queued → downloading → copying → done/failed`，失败重试 ≤3 次后通知；`*/5 * * * *` 的 `queue-pump`
  与页面手动推进共用入口。
- 入库：`ctx.http.request({save_to})` 下载到插件自有 `downloads/`，`ctx.files.call` rename/move 交给宿主
  复制进目标目录（CD2 挂载由宿主分流）。
- Telegram 失败通知带 `callback_data: retry:<短id>` 按钮；点击触发 `tg-callback` 事件任务重新排队。
- 页面四个分页 + 登录卡 + 最近动作；`ui/qr.js` 为旧 `frontend/src/qr.ts` 的移植。
- 171 个 `node --test` 用例；全过。
  本轮连跑 10 次未复现，断言前提未变）。

**Gaps**

- QQ 扫码登录**已可用**（1.0.2）：旧版「宿主代理剥离外部响应 `Set-Cookie` → 返回 `QR_UNAVAILABLE`」的限制在 v3 不成立
  —— 登录链路走宿主 session（宿主按 session 记 `Set-Cookie`，`network.md:15`），插件自己按 host+path 校验重定向白名单。
  剩下的 gap 是**真机端到端未验证**（本机没有可用的 dian115 宿主）：手机确认、OAuth 跳转、凭据落盘只有离线单测覆盖；
  扫码失败时的兜底仍是手动粘贴 Cookie。
- 旧版 CD2 直送（`cd2.rs` gRPC-Web）整套移除，改为宿主 `move` 自动分流；`cd2_url` / `token` /
  `dest_dir` / `local_folder` / `register_host` 五项设置不再存在。宿主若没有配对 CD2，入库按宿主本地目录处理。
- `staging_dir` 设置移除，暂存固定为插件自有 `downloads/`。
- 旧 `tasks` KV 数据不迁移：v3 安装与旧安装数据不通用（平台发布语义），升级视为新安装。
- 队列页没有「取消单条任务」入口（旧版也没有独立取消动作，只有重试/清空已完成/对账）。
- 真机上的扫码、eapi 取链、下载落盘、CD2 move 与通知按钮回调均未验证。

### 豆瓣中心（`v3/douban-rs`，douban.rs 1.1.4）

**Covered（离线可验证）**

- 榜单：三种来源解析、黑名单判定/入队、成本排序与预算跳过、快照与摘要文案。
- 观察队列：`observe_period_hours` 到期处理、`auto_subscribe`、黑名单增删、移出队列、墓碑集
  （`已删除不重订`）与 `no-resub-clear`。
- 想看同步：movie+tv 去重、seen 先写再守卫、内联订阅 vs 入队、分页拉取、6 小时墓碑节流。
- TMDB 匹配：置信度阈值 0.5；失配时用豆瓣详情（原名/又名）回退重搜取最高置信；创建宿主聚合订阅前
  去重（`tmdb_id + media_type`）。
- 过滤：`min_rating` / `min_year` / `regions`，无评分按低于阈值处理，地区只在详情已取到时生效。
- 海报：豆瓣 CDN 带 Referer 取图（页面 `ctx.http` base64）、img1~img9 镜像回退、`s_ratio → m_ratio` 降级、
  `get-poster` 任务与 64 张内存缓存。
- 登录态：只用手工粘贴的豆瓣 Cookie（需含 dbcl2），45 分钟缓存；不再读 CookieCloud。
- 15 个任务（定时刷新、想看同步、刷新、同步、订阅、海报、通知自检、维护动作），
  均带 `recover`；页面用 Vue 3 重写（源码 `v3-ui/src/douban-rs/`）：榜单/海报墙、观察队列/想看、
  历史日志、设置表单四个面板。
- 112 个 `node --test` 用例通过（fixtures 复用旧仓库脱敏样本）。

**Gaps**

- 页面已从旧 Vue 源码移植成 Vue 3（`v3-ui/src/douban-rs/`），**没有在浏览器里做过逐组件像素级对照**
  （只有最小 DOM 冒烟，见「界面（Vue 3）」）；旧版的拖拽排序、历史/日志分页仍不在页面里
  （历史按 `max_history` 落盘裁剪，日志只留最近 40 条）。海报点击放大已补上（`PosterLightbox.vue`）。
- 没有「一键处理全部到期订阅」：后端没有独立 process-due 任务，页面只提供逐条 `subscribe-now`，
  批量到期由定时 `wish-sync` 处理。
- 通知按钮回调（旧版本就没有可用回调）未在页面阶段补上；`send-test` 只做通知自检。
- 插件不再做任何 CookieCloud 解密（宿主新规约）：登录态只来自扫码或用户手动粘贴；
  MD5/base64 的纯 JS 兜底有向量对拍。
- 幂等键头不再携带（`ctx.api` 限制），由宿主任务队列 + 订阅去重 + storage CAS 保底。
- 真机上的榜单抓取、豆瓣登录态、TMDB 匹配、订阅创建、海报 Referer 与通知均未验证。

### 三个插件的共同 gaps

- **没有真机宿主验证**：安装/inspect/确认 token、任务调度与 `recover`、`ctx.api` 实际响应、通知渠道、
  CD2、站点登录都只在代码与离线测试层面成立。
- `project-check.mjs` 只检查清单、入口与源码结构；它自己会打印「不证明安全或站点业务成功」，权限与业务
  仍由宿主在安装/运行时检查。
- 页面没有浏览器级测试：只有最小 DOM 垫片的冒烟挂载（`v3-ui/scripts/smoke-mount.mjs`，验证
  `mount`、主题切换、清理函数），`mount(el, ctx)` 的完整渲染与事件绑定未在真浏览器或宿主里跑过。
- 市场索引的 `source_url` 指向本次 Release（`v3-2026.11.01-3`）的下载地址；`sha256` 由发布流水线
  按 `dist/` 实算并回写（与 Release 的 `SHA256SUMS.txt` 一致）。

## 界面（Vue 3）

三个插件的页面已迁到 Vue 3：源码在 `v3-ui/src/<plugin>/`，构建产物直接落在
`v3/<plugin>/ui/page.js`——也就是清单 `ui.entry` 指向的那个文件。宿主照旧
`import` 这个 ESM 并调用它导出的 `mount(el, ctx)`，契约没有变（见
`v3-kit/docs/ui-theme.md`）。

### 目录结构

```
v3-ui/                       共享依赖 + 三个插件的 Vue 源码
  src/shared/                ctx 注入、主题桥（三个插件共用）
  src/chase-rs/              追剧管家页面（main.ts + AppPage.vue）
  src/music-rs/              音乐下载页面
  src/douban-rs/             豆瓣中心页面
  legacy/                    改写前的原生 JS 版页面（行为基准，只读）
  plugins/                   构建期约束（scoped 样式守卫、CSS 内联）
  package-lock.json          入库；npm ci 按它装，保证可重复
v3/<plugin>/ui/page.js       构建产物（入库）
scripts/v3-build-ui.sh       构建界面（chase → music → douban，幂等）
scripts/v3-build.sh          构建界面 → project-check → pack → sha256
scripts/v3-verify-ui-artifacts.sh  比对入库产物与当前重建结果
scripts/v3-pack-check.mjs    查包：不能有 node_modules，清单入口要齐全
```

### 构建命令

```sh
cd v3-ui && npm ci           # 按入库的 package-lock.json 安装，可重复
bash scripts/v3-build-ui.sh  # 仓库根一键：chase → music → douban，幂等
(cd v3-ui && npm run typecheck)   # vue-tsc 类型检查
node v3-ui/scripts/smoke-mount.mjs chase-rs   # 最小 DOM 冒烟挂载
```

### 与旧 Federation 的差异

| 维度 | 旧 schema 1（Federation） | 现在（Vue 3 自打包 ESM） |
| --- | --- | --- |
| 加载方式 | 宿主加载 `remoteEntry.js`，再取远程模块 | 宿主直接 `import ui/page.js` |
| 依赖 | `hostSharedDependencies` 声明 vue/naive-ui/lucide 为宿主单例 | 全部打进 `page.js`，不依赖宿主共享单例 |
| 产物 | `frontend/dist/assets/remoteEntry.js` + `assets/` | `v3/<plugin>/ui/page.js`（+ `chunks/`） |
| 样式 | 由宿主的样式系统提供 | SFC 的 `<style scoped>`，构建时内联进 `page.js` |
| 数据通道 | `props.api` / `props.runtimeState` 桥接 | `ctx.api` / `ctx.storage` / `ctx.settings` / `ctx.tasks` / `ctx.http` 等 |

### mount(ctx) 契约

入口 `src/<plugin>/main.ts` 导出 `mount(el, ctx)`：把 `ctx` 注入组件树、交给
naive-ui 的 `n-config-provider`、挂载到宿主给的容器，并返回一个清理函数（退订主题 +
卸载 app）。宿主关闭页面时调用它。页面所有数据与能力只走 `ctx`，不直接 fetch 宿主接口。

### 主题与 CSS 变量

`ctx.theme.mode`（light/dark）经 `ctx.theme.subscribe(fn)` 桥接成响应式状态，驱动
naive-ui 的 `n-config-provider`；订阅在卸载时退订。颜色与排版用宿主 CSS 变量
（`--app-bg` / `--app-surface` / `--app-text` / `--app-text-secondary` / `--app-border` /
`--app-accent`）。所有 `<style>` 必须 `scoped`——构建期的守卫插件会直接报错挡住非 scoped
的样式，防止页面样式漏进宿主页面。

### 设置双入口

清单 `plugin.json` 不再声明 `settings[]`（设置做在页面里，宿主规范要求）；页面里用
`ctx.settings.get()` / `ctx.settings.set()` 读写**同一份**设置，两边看到的内容一致。

### 产物是否入库

`v3/<plugin>/ui/page.js` **入库**（若构建产生了 `chunks/` 也一并入库；当前三个插件都只有
`page.js`，外加 music-rs 的 `qr.js` 源码），`v3-ui/node_modules/` **不入库**。

原因（两条，都指向「必须入库」）：

1. 宿主按 `ui.entry` 加载该文件，`pack.mjs` 打包时直接把插件目录打成 `.dian115p`——
   产物必须在目录里，打包才不必先跑 Node 构建。
2. 产物入库，CI 才能做「重建结果 == 入库版本」的比对（见下节），否则无法验证
   宿主跑的和源码是一回事。

`node_modules/` 不入库：它是构建期依赖，只装在构建机上；`pack.mjs` 也会跳过 `node_modules`
目录，`scripts/v3-pack-check.mjs` 再查一遍包内容，双保险。`.gitignore` 里
`v3-ui/node_modules/`、`v3-ui/dist/`、`v3-ui/.vite/`、`*.tsbuildinfo` 都已排除；
`v3-ui/package-lock.json` 则**必须入库**——它是 `npm ci` 可重复安装的保证。

细节见 `v3-ui/README.md`。

### CI 校验方式

发布流水线 `.github/workflows/release-v3.yml` 的顺序是固定的：

| 步骤 | 命令 | 挡住的问题 |
| --- | --- | --- |
| 安装 UI 依赖 | `npm ci`（`v3-ui/`，按入库的 `package-lock.json`） | 依赖不锁死：CI 装的和本地装的不是一套，构建结果不可复现 |
| 构建 UI | `npm run build`（→ `v3/<plugin>/ui/`） | 产物缺失或与源码不同步 |
| 打包 | `bash scripts/v3-build.sh`（内部再跑一次界面构建，然后 project-check → pack） | 清单/入口不对、包结构不对 |
| 产物可复现 | `bash scripts/v3-verify-ui-artifacts.sh` | 重建结果与入库版本不一致（源码改了没重建，或构建不可重复） |
| 包内容 | `node scripts/v3-pack-check.mjs <包>` | 包里混进 `node_modules`、清单声明的入口缺失 |

其中「产物可复现」这一条比对的是**工作区与 git HEAD**：任何已暂存/未暂存/未跟踪/已删除的
界面产物差异都会让脚本报错退出。所以「改了 `v3-ui/src/` 却忘了重新构建并提交产物」在 CI 里
是过不去的。本地可以用同一条命令自查：

```sh
bash scripts/v3-build-ui.sh              # 重建
bash scripts/v3-verify-ui-artifacts.sh   # 与入库版本比对（不一致就报错）
```

界面构建本身是可重复的：同一份源码 + 同一份锁文件 → 同样的字节（实测见文末[验证状态](#验证状态)）。
`scripts/v3-build-ui.sh` 缺 `node_modules` 时会自己按锁文件跑一次 `npm ci`。

## 构建与自测

所有命令都在仓库根执行（Node v24.18.0 / npm 11.16.0；本机无需 Rust 与 WASM）。

### 一键构建（幂等）

```sh
bash scripts/v3-build-ui.sh   # 先构建 Vue 界面（chase → music → douban）
bash scripts/v3-build.sh      # 再 project-check → pack → 打印 sha256
```

`v3-build-ui.sh` 幂等（同一份源码重复构建得到同样的产物），构建后自动跑三项自检：
入口存在、`node --check` 语法检查、最小 DOM 冒烟挂载（验证 `mount`、主题切换、清理函数）。
缺 `v3-ui/node_modules` 时它会按入库的 `package-lock.json` 自己跑一次 `npm ci`。

`v3-build.sh` 的顺序是固定的：**先 `v3-build-ui.sh`（界面），再 project-check → pack**。
界面必须先于打包——`pack.mjs` 打的是插件目录，`ui/page.js` 就是宿主加载的入口，产物不在包里
装上去页面就起不来。打包后还会跑 `scripts/v3-pack-check.mjs` 查包（不能有 `node_modules`、
清单声明的入口必须齐全）。`pack.mjs` 固定文件顺序且不写时间戳，同一份源码重复执行得到字节
相同的包；已有包会被覆盖。产物：

```
dist/chase-rs-0.1.13.dian115p
dist/music-rs.dian115p
dist/douban-rs.dian115p
```

### 分步命令

```sh
# 1) 构建 Vue 界面（产物直接落在 v3/<plugin>/ui/page.js）
bash scripts/v3-build-ui.sh
(cd v3-ui && npm run typecheck)                    # vue-tsc 类型检查
node v3-ui/scripts/smoke-mount.mjs chase-rs       # 最小 DOM 冒烟挂载

# 2) 清单/入口/源码结构
node v3-kit/conformance/project-check.mjs v3/chase-rs
node v3-kit/conformance/project-check.mjs v3/music-rs
node v3-kit/conformance/project-check.mjs v3/douban-rs

# 3) 打包（输出必须在源码目录之外；后缀必须是 .dian115p）
node v3-kit/conformance/pack.mjs v3/chase-rs dist/chase-rs-0.1.13.dian115p
node v3-kit/conformance/pack.mjs v3/music-rs dist/music-rs.dian115p
node v3-kit/conformance/pack.mjs v3/douban-rs dist/douban-rs.dian115p
node scripts/v3-pack-check.mjs dist/chase-rs-0.1.13.dian115p v3/chase-rs   # 查包

# 4) 纯逻辑单测（Node 24 下要传文件 glob，不能只传目录）
(cd v3/tests/chase-rs  && node --test *.test.mjs)   # 119 pass
(cd v3/tests/music-rs  && node --test *.test.js)    # 171 用例
(cd v3/tests/douban-rs && node --test *.test.mjs)   # 100 pass

# 5) 语法检查
find v3/chase-rs v3/music-rs v3/douban-rs -name '*.js' -exec node --check {} +

# 6) 索引与脚本
node -e 'JSON.parse(require("fs").readFileSync("v3-market-index.json","utf8")); console.log("ok")'
bash -n scripts/v3-build.sh scripts/v3-build-ui.sh

# 7) 界面产物与入库版本是否一致（CI 跑的就是这条）
bash scripts/v3-verify-ui-artifacts.sh
```

注意：`node --test tests/`（只给目录）在 Node 24.18 会报 `Cannot find module .../tests`，不要用；
单测与夹具放在 `v3/tests/<plugin>/`（插件目录之外）：官方 `starter` 模板的插件目录也不含测试，
测试不进 `.dian115p` 包（避免审计把夹具里的向量当成可疑编码数据）；
必须传文件 glob。

## 正式发布：编译 MCP（protected-v4）

宿主 2026-11-02 起要求**正式安装/更新走「编译 MCP」签出的 `protected-v4` 包**；`check.mjs --pack`
产出的可读 `.dian115p` 只是**本机调试包**，不能上架、也不能覆盖同 ID 的正式安装。

签发链路（契约见 `v3-kit/docs/plugin-platform/examples/dian-plugin/references/compilation.md`）：

- 端点：`POST {DIAN115_URL}/api/openapi/v1/plugin-build/mcp`，请求头带**系统设置里的 OpenAPI Key**
  （`X-OpenAPI-Key` 或 `Authorization: Bearer`）；JSON-RPC 2.0 + Streamable HTTP，协议版本 `2025-06-18`。
- 工具：`dian115_build_environment`（环境/预算/账号/阻塞项）、`dian115_verify_build_account`（实时会员身份）、
  `dian115_check_plugin`（结构与受限调用检查，不出包）、`dian115_compile_plugin`（验会员 → 真实编译 → 加密 →
  本地签名 → 出 `package_base64`）。
- 成功判据：非错误结果 **且** `structuredContent.release_ready === true` **且** 有 `package_base64`
  **且** 解码后 SHA256 与返回值一致。
- 署名：正式包的开发者名 = 签名绑定的**会员昵称**（宿主覆盖源码自填 `author`），市场索引的 `author` 用同一昵称。

本仓库的接入：

| 脚本 | 作用 |
| --- | --- |
| `scripts/v3-compile.mjs` | 编译 MCP 客户端：`env` / `account` / `check <目录>` / `compile <目录>`；正式包与 `dist/official-packages.json` 清单 |
| `scripts/release-v3-local.sh` | 本地发版：构建 → 审查闸门 → 可读调试包 → 逐个插件签发正式包 → 更新市场索引 → 提交 → 打 tag → 上传 Release 资产 |
| `scripts/v3-dev-verify.mjs` | 用地址 + APIKEY 探测实例可达性与鉴权 |
| `scripts/v3-check-official.mjs` | 官方结构检查 + 恶意特征扫描；critical/high 必须在 `scripts/v3-audit-allowlist.json` 登记误报理由 |

凭据只走仓库根的 `.env.local`（已 gitignore）或 CI secret：`DIAN115_URL` / `DIAN115_API_KEY` /
`DIAN115_ACCOUNT_ID`（癫影账号 id，多账号时必填；**不是**会员 id，也不是 API Key）。

CI（`release-v3.yml`）只做检查与**可读调试包** artifact：编译 MCP 需要可达的实例与系统 Key，
CI 拿不到，正式发布因此在本地发版脚本里完成。

## 安装到 DIAN115（手动上传 .dian115p）

本机没有宿主，下面是按官方文档整理的操作路径，**未在真机执行**：

1. 生成包：`bash scripts/v3-build.sh`（或单独用 `pack.mjs`），确认包根目录直接包含 `plugin.json`。
2. 打开 DIAN115 插件中心，选择从本地文件安装/上传，选择 `.dian115p` 文件（`multipart` 的 `file` 字段）。
3. 宿主先 *inspect*：校验包结构，静态分析实际代码，展示接口/站点、作者声明与风险报告。
4. 用户确认信任后，用这次 inspect 返回的检查 token 确认安装；token 15 分钟失效。
5. 更新时走 inspect → update，插件 ID 必须一致；更新会先停止活跃任务与目录轮询，但保留数据。
   卸载会清空该插件自己的数据（`v3-kit/docs/developer-guide.md`「发布」、`storage-and-lifecycle.md`）。
6. 安装后页面是否出现在侧边栏由卡片上的「侧边栏」开关决定（默认不出现）；`menu` 只提供标题与排序。

也可以按 `market.md` 把源码目录或 HTTP(S) 交付地址交给插件中心检查，但三种方式都会重新静态分析实际代码，
不存在「市场/作者声明即白名单」。

## 市场索引（`v3-market-index.json`）

格式按官方 v3 索引 schema（`schema_version: 3`）：每个版本记录
`id` / `name` / `version` / `source_url` / `sha256` / `delivery`，可附 `author` / `description` /
`homepage` / `changelog` / `declared_usage`。官方 schema 位于
`docs/plugin-platform/market-index.schema.json`（`https://raw.githubusercontent.com/madbrolab/dian115/main/docs/plugin-platform/market-index.schema.json`），
规则见 `v3-kit/docs/market.md`。

三个条目：

| id | version | delivery | source_url | sha256 |
| --- | --- | --- | --- | --- |
| `chase.rs` | 0.1.13 | protected-v4 | 正式包 `chase.rs-<release_id>.dian115p` | 见 `v3-market-index.json` |
| `music.rs` | 1.2.1 | protected-v4 | 正式包 `music.rs-<release_id>.dian115p` | 见 `v3-market-index.json` |
| `douban.rs` | 1.1.4 | protected-v4 | 正式包 `douban.rs-<release_id>.dian115p` | 见 `v3-market-index.json` |

（正式包由宿主「编译 MCP」签发，`delivery` 是 `protected-v4`，`author` 是签名绑定的**会员昵称**；
`sha256` 与 `source_url` 由发布脚本按实际产物实算写入 `v3-market-index.json`。）

（表中的 sha256 为节选，完整 64 位值以 `v3-market-index.json` 为准；Release 资产与
`SHA256SUMS.txt` 是发布环境的实算值。本地构建的包逐文件内容一致，但 zip 压缩字节会随
Node/zlib 版本略有差异——本地 193844 / 284582 / 263162 字节——跨机器比对请以 Release 的
`SHA256SUMS.txt` 为准。）

`declared_usage` 逐字取自各插件 `plugin.json`（接口、站点、文件、通知与风险说明），没有另行美化。
三个 v3 清单都没有 `permissions` 段，因此索引也省略可选的 `permissions` 字段；`source_url_note` 是
附加说明字段，官方 schema 未禁止附加属性。

**发布后的索引**

`v3-market-index.json` 与 `plugin-market/v3/index.json` 由发布流水线在打 `v3-*` 标签时自动更新：
`source_url` 指向该 Release 的绝对下载地址，`sha256` 为 CI 实算值（与 Release 资产一致），满足官方
v3 索引 schema。仓库内旧 `plugin-market/index.json` 是 v1 格式，v3 宿主不要使用。
`dist/` 与 `*.dian115p` 按仓库约定不入库（插件包只作为 Release 附件分发）；`v3-kit/` 是官方工具
本地镜像（上游无 license），用 `bash scripts/fetch-v3-kit.sh` 重建。

## 验证状态

本次在仓库根实际执行过的检查（Node v24.18.0）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 三个插件结构检查 | `node v3-kit/conformance/project-check.mjs v3/<plugin>` | 3/3 通过：`chase.rs 0.1.13`、`music.rs 1.2.1`、`douban.rs 1.1.4` |
| 全部 JS 语法 | `find v3/... -name '*.js' -exec node --check {} +` | 通过：chase 16 / music 30 / douban 38 个文件 |
| 纯逻辑单测 | `(cd v3/tests/<plugin> && node --test *.test.*)` | chase 119 pass / music 170 pass / douban 100 pass，0 fail |
| 打包 | `bash scripts/v3-build.sh`（连跑两次） | 两次 sha256 完全一致；产物 193844 / 284582 / 263162 字节（界面换成 Vue 3 自打包后比原生 JS 版大；sha256 见表下） |
| 索引 JSON | `node -e 'JSON.parse(...)'` | 通过 |
| 索引字段与摘要 | 本地校验脚本（必填/id/sha256/delivery/homepage，sha256 对 dist 实算） | 通过；仅 `source_url` 相对路径为已知偏差 |
| 构建脚本语法 | `bash -n scripts/v3-build.sh` | 通过 |
| 真机安装/运行 | — | **未执行**（本机无可用 DIAN115 宿主，授权被锁） |

工具版本：Node v24.18.0、npm 11.16.0；未使用 Rust/WASM 工具链。

### 界面（Vue 3）这一轮补做的检查

界面迁到 Vue 3 之后、发布流水线接上之后，本轮实际跑过的检查：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 脚本语法 | `bash -n scripts/v3-build.sh scripts/v3-build-ui.sh` | 通过（另加 `bash -n scripts/v3-verify-ui-artifacts.sh`） |
| 三个插件结构检查 | `node v3-kit/conformance/project-check.mjs v3/<plugin>` | 3/3 通过：`chase.rs 0.1.13`、`music.rs 1.2.1`、`douban.rs 1.1.4` |
| 界面构建可重复 | `bash scripts/v3-build-ui.sh` 连跑两次，比对 sha256 | 两次产物字节相同（chase `897e1d4c…5937c8ad`、douban `fc90a3dd…1e967675`、music `574a6486…554628e2`） |
| 锁文件可复现 | 干净副本里 `rm -rf node_modules && npm ci` 后重建 | 与入库产物逐字节相同；本地多次打包 sha256 一致（跨环境的 zip 压缩字节会略差十余字节，以 Release 的 `SHA256SUMS.txt` 为准） |
| 一键构建幂等 | `bash scripts/v3-build.sh` 连跑两次 | 两次 sha256 完全一致（本地值；Release 实算值见市场索引）；产物 193844 / 284582 / 263162 字节 |
| 包内容检查 | `node scripts/v3-pack-check.mjs <包> <插件目录>` | 3/3 通过：30 / 34 / 62 个条目，无 node_modules，清单入口齐全；反向用例（塞 node_modules / 缺 ui.entry）都能报错 |
| 产物入库一致性 | `bash scripts/v3-verify-ui-artifacts.sh` | 通过（`v3-ui/` 源码与 `v3/<plugin>/ui/` 产物已同批入库，CI 发布前再校验一次） |
| 工作流 YAML | `python3 -c "import yaml; yaml.safe_load(...)"` | 解析通过，步骤顺序：安装依赖 → 构建 UI → 打包 → 产物可复现 → 查包 |

**没做的**：没有在浏览器里跑过这三个页面（只做了最小 DOM 冒烟 `v3-ui/scripts/smoke-mount.mjs`），
没有在真机宿主里装过；CI 工作流本身也没有在 GitHub 上实跑过（本机无 GitHub Actions 运行时），
上面这些命令都是本地等价执行的。

## GitHub Actions 发布

- 工作流：`.github/workflows/release-v3.yml`（手动触发见下，`v3-*` tag 触发已配置）
- 一键发布：`bash scripts/release-v3.sh v3-YYYY.MM.DD`（打标注 tag → 推送 → 对 tag ref 分发工作流）
- 说明：实测本仓库 deploy key 推送的 tag 未自动触发 `push.tags` 工作流（分支推送正常），因此脚本会显式 `gh workflow run --ref <tag>`；发布路径相同：构建 → 创建 Release（三包 + SHA256SUMS.txt + 更新后的市场索引）→ 回写 `v3-market-index.json` 到 main
- 仅验证打包（不发布）：`gh workflow run release-v3.yml --ref main`，产物在 run 的 artifact 里
- 工作流里的步骤（顺序固定）：`npm ci`（带 npm 缓存）→ `npm run build` 构建 UI →
  `bash scripts/v3-build.sh`（内部再构建界面 + project-check + pack）→
  `bash scripts/v3-verify-ui-artifacts.sh` 校验产物可复现 → `scripts/v3-pack-check.mjs` 查包。

## 作为自定义市场源使用

dian115 的「市场与仓库 → 管理仓库」填 **raw JSON 地址**（不是 GitHub 网页地址）：

```
https://raw.githubusercontent.com/congyoubanmian/dian115-plugins/main/plugin-market/v3/index.json
```

- v3 索引由发布流水线随 Release 自动更新（sha256 与 Release 资产一致）；
- 旧的 `plugin-market/index.json` 是 v1（旧 WASM 插件）格式，v3 宿主不要用它。
