# DIAN115 v3 迁移说明（chase.rs / music.rs / douban.rs）

本目录是三个旧 schema 1（Rust → WASM）插件在 DIAN115 v3 可信扩展形态下的迁移产物：

| 插件 | v3 源码目录 | 版本 | 任务数 | 旧实现 |
| --- | --- | --- | --- | --- |
| 追剧管家 `chase.rs` | `v3/chase-rs/` | 0.1.9 | 4 | `plugins/chase-rs`（0.1.9） |
| 音乐下载 `music.rs` | `v3/music-rs/` | 1.0.0 | 2 + 1 event | `plugins/music-rs`（0.3.19） |
| 豆瓣中心 `douban.rs` | `v3/douban-rs/` | 1.0.0 | 16 | `plugins/douban-rs`（0.2.4） |

约定：宿主插件 API 为 **3.5**（三个 `plugin.json` 的 `requires.api` 均为 `"3.5"`）；后台是宿主内 ESM
JavaScript（无 `require`、无 Node 内置模块、无子进程），页面是 `ui/page.js` 导出的
`mount(el, ctx)`，UI 只用原生 JS + DOM，无 npm 依赖。旧的 `plugins/` 源码保持原样，未修改。

> **验证边界**：本机没有可用的 DIAN115 宿主（授权被锁）。已完成的是离线检查：`project-check`、
> `node --check`、`node --test`、`pack.mjs`、索引 JSON 校验。**安装、inspect/确认、定时任务、
> 站点登录、通知投递、CD2 入库都没有在真机宿主上验证**，详见文末[验证状态](#验证状态)。

## 目录与产物

```
v3/chase-rs/            v3 插件源码（plugin.json + jobs/ + lib/ + ui/ + tests/）
v3/music-rs/
v3/douban-rs/
v3-market-index.json    v3 市场索引（schema_version 3，三个插件，delivery=source）
scripts/v3-build.sh     一键 project-check → pack → sha256（幂等）
dist/                   构建产物 .dian115p（本地生成，不提交；现有 .gitignore 的 *.d115p 不匹配该后缀）
```

各插件目录的 `package.json` 只声明 `{"type":"module"}`，让该目录 `.js` 按 ESM 解析；没有任何依赖。

## 旧 → 新映射

旧形态以 `plugins/*/manifest.template.json`（schema 1）和 `plugins/*/src/*.rs` 为准，新形态以
`v3/*/plugin.json`、`v3/*/jobs/*.js`、`v3/*/ui/page.js` 为准。逐维度对应如下。

| 维度 | 旧（schema 1，WASM） | v3 |
| --- | --- | --- |
| 清单 | `manifest.template.json`：`schema_version: 1`、`compatibility.plugin_api: "^2.0"` | `plugin.json`：`schema_version: 3`、`requires.api: "3.5"` |
| 运行时 | `runtime.kind: "wasm"`、`entry: "runtime/plugin.wasm"`、`protocol: "dian115:wasm@1"`、`memory_mb` / `max_concurrency` / `restart_policy`；Rust 侧 `abi.rs` / `arena.rs` / `host.rs` / `protocol.rs` | **删除 `runtime` 段**。宿主按任务加载 `jobs/<id>.js` 的 ESM 入口；无常驻 VM，每次运行由 `run(ctx, input)` 进入，`recover(ctx, checkpoint)` 续跑；超时/并发由清单的 `timeout_seconds` / `allow_overlap` 描述 |
| 任务与调度 | 清单 `jobs[]` 只写 `id` + Rust `handler` 名（如 `alignHourly`）+ `default_schedule`；WASM 内自行分发 | 清单 `jobs[]` 写 `entry` / `handler` / `recover` / `default_schedule`（cron）或 `interval_seconds` / `timeout_seconds` / `queue`；页面动作是 `queue:false` 的短任务 |
| 事件 | `events: ["telegram.callback"]`（music-rs），WASM 内处理回调 | `events: [{event: "callback", job: "tg-callback"}]`：事件触发一个普通任务；music-rs 用它重排失败任务 |
| 权限声明 | `permissions.apis[]`（method/path/reason）+ `permissions.network[]`（origin/methods/proxy_mode/reason），安装时作为白名单 | **v3 清单没有 `permissions` 段**。代码里实际调用 `ctx.api` / `ctx.http` / `ctx.files` / `ctx.notify` / `ctx.storage`；宿主在安装/更新时静态扫描实际代码、运行时继续做权限检查（`v3-kit/docs/security.md`），拒绝即 403 或拒绝安装。`declared_usage` 如实写明接口、站点、文件、通知与风险，只作告知，不是白名单 |
| 宿主 API 调用 | WASM `host.rs` 拼 HTTP：`/api/plugin-runtime/storage/:key`、`/api/notifications/plugin`、`/api/plugin-host/files/*`、`/api/local-files/*` 等 | `ctx.api.get/post/patch`（业务接口）、`ctx.storage.get/set/remove`、`ctx.notify(...)`、`ctx.files.call(...)`、`ctx.http.request(...)`、`ctx.cookiecloud('read')`、`ctx.crypto` / `ctx.codec`、`ctx.tasks.run/get`（页面） |
| 存储与并发 | `GET/PUT /api/plugin-runtime/storage/:key` + ETag `If-Match` + WASM 内幂等键；状态文档常驻内存 | `ctx.storage` 的 `revision` / `expected_revision` CAS（后台 `set` 返回版本数字，页面返回 `{revision}`）；状态文档每次任务重新读取，不常驻。幂等键头不再发送（`ctx.api` 不暴露自定义头） |
| 下载与文件 | 宿主代下载 `/api/plugin-host/files/downloads` + 轮询 job；`/api/local-files/rename`、`/api/local-files/copy`；music-rs 另有 CD2 gRPC-Web 直送 | `ctx.http.request({save_to})` 流式下载到插件自有目录；`ctx.files.call({operation: 'rename' 或 'move' ...})` 由宿主带进度执行并自动分流 CD2 挂载路径；不再有插件内 CD2 客户端 |
| 通知 | `POST /api/notifications/plugin`（music-rs 的 `callback_data` 会被 400 拒） | `ctx.notify({title, body, buttons, dedupe_key, ...})`，原生支持按钮回调；返回逐渠道结果 |
| UI 入口 | `ui.mode: "federation"` + `ui.federation.entry: "frontend/dist/assets/remoteEntry.js"` + `module: "./AppPage"`（Vue 远程模块） | `ui.entry: "ui/page.js"`，`export async function mount(el, ctx)`；`menu` / `icon` 也在清单里 |
| UI ↔ 后台桥 | 旧前端通过 WASM 的 `state` / `action` op 回调（`invokeAction` → `RuntimeCallback`）取状态、发动作 | 页面直接 `ctx.storage.get('state')` / `ctx.settings.get()` 读，`ctx.tasks.run(job, business_key, input)` + `ctx.tasks.get(id)` 发动作并轮询；`ctx.http` 可在页面直接取图 |
| 设置 | 设置嵌在状态文档里，WASM 侧白名单合并 | 清单 `settings[]` 由宿主渲染表单并保存到 `settings` KV；`ctx.settings.get/set` 与后台共用；复杂配置仍留在状态文档 |
| CookieCloud | 插件自己配置地址/UUID/口令 + 插件内 AES-CBC 解密（`cookiecloud.rs`） | 主路径 `ctx.cookiecloud('read')`（宿主统一配置并解密）；douban.rs 保留用户显式填写自建服务时的旧协议链 |
| 交付 | schema 1 签名包（Ed25519，`publisher.key_id`，`*.d115p`） | `.dian115p` 源码 ZIP（`v3-kit/conformance/pack.mjs`），`delivery: "source"`；宿主安装时静态分析实际代码并让用户确认 token，加密交付是可选项，本仓库三个插件都没有用 |

更完整的平台规则见 `v3-kit/docs/developer-guide.md`（清单/任务/发布）、`package-format.md`
（`.dian115p`）、`market.md`（市场索引）与 `host-api-quick-reference.md`（`ctx` 能力）。

## 各插件 covered / gaps

### 追剧管家（`v3/chase-rs`，chase.rs 0.1.9）

**Covered（离线可验证）**

- 4 个任务：`align`（`0 * * * *`，整点对齐）、`align-now`、`refresh`、`probe-dump`，均带 `recover`。
- 判定层与旧 Rust 对应：只增 PATCH `total_episodes`、单轮条数/单条抬升上限、dry-run、四类互斥跳过文案；
  减方向只出建议，从不写。
- Emby 覆盖探测：实例选择、参数矩阵与指纹缓存、探测预算；TMDB 只取该季集数，不用整剧集数顶替。
- 订阅池读取（`media_type=tv`，≤4 页 × 500）、追剧日历、每日日报（`ctx.notify` + `dedupe_key`）。
- 状态文档：默认值/上限裁剪/256KB 逐级降级，`expected_revision` CAS；404 两次确认视为全新安装，
  其他读取失败不落盘。
- 清单 `settings[]` 覆盖旧页面 12 个用户配置项；页面用原生 JS 重写，保留指标瓦片、看板与移动端单栏。
- 117 个 `node --test` 用例通过。

**Gaps**

- `Idempotency-Key` 请求头不再携带（`ctx.api` 无自定义头）。生成逻辑与测试仍在 `lib/intents.js`，但不上线；
  幂等改由「只增」+ 宿主任务队列 `business_key` 保底。
- `align-now` / `refresh` 由旧版「只写内存」改为结束时落盘 —— v3 任务之间没有常驻内存，不落盘页面读不到结果。
- 旧版没有事件订阅，v3 也不声明 `events[]`；没有新增消息/回调能力。
- 每日报告的实际渠道取决于宿主通知配置；旧版经宿主通知端点投递，本次未在真机核对渠道与按钮渲染。

### 音乐下载（`v3/music-rs`，music.rs 1.0.0）

**Covered（离线可验证）**

- 搜索：网易云 `/api/cloudsearch/pc`、QQ `search_for_qq_cp`，页面直连。
- 登录：网易云扫码（unikey + 页面本地 QR 编码 + 轮询）、手动粘贴 Cookie（白名单清洗 + 合并）、
  CookieCloud 一键同步（宿主内置服务）。
- 取链：网易云 eapi（AES-128-ECB + MD5，走 `ctx.crypto`）8 档音质阶梯；QQ `master/flac/320/128`
  7 档阶梯。
- 歌单：全量索引 + 分页详情，整单分批入队（每批 5 页 × 100 首，`next_page` 续批）。
- 下载队列：KV 分片（`tasks.idx` + `task.<id>`），按 `source+song_id+quality` 去重；
  `queued → downloading → copying → done/failed`，失败重试 ≤3 次后通知；`*/5 * * * *` 的 `queue-pump`
  与页面手动推进共用入口。
- 入库：`ctx.http.request({save_to})` 下载到插件自有 `downloads/`，`ctx.files.call` rename/move 交给宿主
  复制进目标目录（CD2 挂载由宿主分流）。
- Telegram 失败通知带 `callback_data: retry:<短id>` 按钮；点击触发 `tg-callback` 事件任务重新排队。
- 页面四个分页 + 登录卡 + 最近动作；`ui/qr.js` 为旧 `frontend/src/qr.ts` 的移植。
- 98 个 `node --test` 用例；正常全过，但 `tests/pump.test.js:287` 的队首断言偶发失败（约 10%，见 Gaps）。

**Gaps**

- QQ 扫码登录不可用：宿主代理会剥离外部响应 `Set-Cookie`（旧版同样不可用），替代路径是手动粘贴 Cookie。
  微信/QQ 扫码链路的纯逻辑有测试，但没有可用的端到端登录。
- 旧版 CD2 直送（`cd2.rs` gRPC-Web）整套移除，改为宿主 `move` 自动分流；`cd2_url` / `token` /
  `dest_dir` / `local_folder` / `register_host` 五项设置不再存在。宿主若没有配对 CD2，入库按宿主本地目录处理。
- `staging_dir` 设置移除，暂存固定为插件自有 `downloads/`。
- 旧 `tasks` KV 数据不迁移：v3 安装与旧安装数据不通用（平台发布语义），升级视为新安装。
- 队列页没有「取消单条任务」入口（旧版也没有独立取消动作，只有重试/清空已完成/对账）。
- **单测偶发失败（未修复）**：`tests/pump.test.js:287`「pump respects max_active and the one-finalization
  gate」在 `tests/pump.test.js:297` 用「id 字典序最大」猜队首，前提是三条任务同一毫秒入队；跨毫秒时
  `sortIndex` 按 `updated_ms` 倒序，队首并不是 max(id)，断言 `summary.completed` 就会不符
  （实测 10 次运行失败 1 次，断言在 `tests/pump.test.js:302`）。这是测试假设问题，本轮没有改测试或
  实现，交给 music-rs 负责人决定是改成索引首条还是注入固定时钟。
- 真机上的扫码、eapi 取链、下载落盘、CD2 move 与通知按钮回调均未验证。

### 豆瓣中心（`v3/douban-rs`，douban.rs 1.0.0）

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
- CookieCloud：宿主内置服务为主，自建服务（地址/UUID/口令 + 旧解密链）与手动 Cookie 回退；45 分钟缓存。
- 16 个任务（定时刷新、想看同步、刷新、同步、订阅、海报、CookieCloud/通知自检、维护动作），
  均带 `recover`；页面用原生 JS 重写榜单/海报墙、观察队列/想看、历史日志、设置表单。
- 112 个 `node --test` 用例通过（fixtures 复用旧仓库脱敏样本）。

**Gaps**

- 旧 Vue 前端已删除，页面是原生 JS 重写：没有逐组件像素级对照；旧版的动画/过渡、拖拽排序、
  海报点击放大、历史/日志分页不在页面里（历史按 `max_history` 落盘裁剪，日志只留最近 40 条）。
- 没有「一键处理全部到期订阅」：后端没有独立 process-due 任务，页面只提供逐条 `subscribe-now`，
  批量到期由定时 `wish-sync` 处理。
- 通知按钮回调（旧版本就没有可用回调）未在页面阶段补上；`send-test` 只做通知自检。
- 自建 CookieCloud 的 AES 解密依赖 `ctx.crypto`，没有插件内 AES 兜底（刻意不做未经真机验证的密码学）；
  MD5/base64 的纯 JS 兜底有向量对拍。
- 幂等键头不再携带（`ctx.api` 限制），由宿主任务队列 + 订阅去重 + storage CAS 保底。
- 真机上的榜单抓取、豆瓣登录态、TMDB 匹配、订阅创建、海报 Referer 与通知均未验证。

### 三个插件的共同 gaps

- **没有真机宿主验证**：安装/inspect/确认 token、任务调度与 `recover`、`ctx.api` 实际响应、通知渠道、
  CD2、站点登录都只在代码与离线测试层面成立。
- `project-check.mjs` 只检查清单、入口与源码结构；它自己会打印「不证明安全或站点业务成功」，权限与业务
  仍由宿主在安装/运行时检查。
- 页面没有 DOM/浏览器测试：`mount(el, ctx)` 的渲染、事件绑定与清理只在代码层审查，未在宿主或
  jsdom 中跑过。
- 市场索引的 `source_url` 目前是 dist 相对路径占位（见下节），不满足官方 schema 的绝对 `http(s)` 要求。

## 构建与自测

所有命令都在仓库根执行（Node v24.18.0 / npm 11.16.0；本机无需 Rust 与 WASM）。

### 一键构建（幂等）

```sh
bash scripts/v3-build.sh
```

脚本对三个插件依次执行 `project-check` → `pack` → 打印 sha256。`pack.mjs` 固定文件顺序且不写时间戳，
同一份源码重复执行得到字节相同的包；已有包会被覆盖。产物：

```
dist/chase-rs-0.1.9.dian115p
dist/music-rs.dian115p
dist/douban-rs.dian115p
```

### 分步命令

```sh
# 1) 清单/入口/源码结构
node v3-kit/conformance/project-check.mjs v3/chase-rs
node v3-kit/conformance/project-check.mjs v3/music-rs
node v3-kit/conformance/project-check.mjs v3/douban-rs

# 2) 打包（输出必须在源码目录之外；后缀必须是 .dian115p）
node v3-kit/conformance/pack.mjs v3/chase-rs dist/chase-rs-0.1.9.dian115p
node v3-kit/conformance/pack.mjs v3/music-rs dist/music-rs.dian115p
node v3-kit/conformance/pack.mjs v3/douban-rs dist/douban-rs.dian115p

# 3) 纯逻辑单测（Node 24 下要传文件 glob，不能只传目录）
(cd v3/chase-rs  && node --test tests/*.test.mjs)   # 117 pass
(cd v3/music-rs  && node --test tests/*.test.js)    # 98 用例（偶发 1 fail，见 Gaps）
(cd v3/douban-rs && node --test tests/*.test.mjs)   # 112 pass

# 4) 语法检查
find v3/chase-rs v3/music-rs v3/douban-rs -name '*.js' -exec node --check {} +

# 5) 索引与脚本
node -e 'JSON.parse(require("fs").readFileSync("v3-market-index.json","utf8")); console.log("ok")'
bash -n scripts/v3-build.sh
```

注意：`node --test tests/`（只给目录）在 Node 24.18 会报 `Cannot find module .../tests`，不要用；
必须传文件 glob。

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
| `chase.rs` | 0.1.9 | source | `dist/chase-rs-0.1.9.dian115p` | `e3c4988d…8fb567` |
| `music.rs` | 1.0.0 | source | `dist/music-rs.dian115p` | `8d40b543…660594` |
| `douban.rs` | 1.0.0 | source | `dist/douban-rs.dian115p` | `6873ad42…4b008a` |

（表中的 sha256 为节选，完整 64 位值以 `v3-market-index.json` 为准。）

`declared_usage` 逐字取自各插件 `plugin.json`（接口、站点、文件、通知与风险说明），没有另行美化。
三个 v3 清单都没有 `permissions` 段，因此索引也省略可选的 `permissions` 字段；`source_url_note` 是
附加说明字段，官方 schema 未禁止附加属性。

**两个必须知道的偏差 / 限制**

1. **`source_url` 是 dist 相对路径占位。** 官方 v3 schema 的 `source_url` 要求 `format: uri` 且
   pattern `^https?://`；本仓库不托管对外下载，所以这里按任务要求写相对路径，并在每个条目附
   `source_url_note`。真正发布到市场前，必须把三处替换为可访问的 HTTPS 地址（例如 Release 附件），
   否则严格的 schema 校验会拒绝该索引。这是当前索引唯一不满足官方 schema 的地方。
2. **本仓库的 `tools/market-index.schema.json` 不是 v3 schema。** 它是旧的 v1「插件市场索引」：
   要求 `package_url`、`runtime.kind: "wasm"` / `protocol: "dian115:wasm@1"` 等字段，不能拿来校验本文件。
   `v3-kit/docs/` 也没有收录 v3 版 schema；本次按官方仓库的 `docs/plugin-platform/market-index.schema.json`
   核对字段（见[验证状态](#验证状态)）。

源码包由作者托管，不提交生成包到公共仓库（`v3-kit/docs/market.md`）。`dist/` 是本机构建产物，
当前整个目录尚未加入版本控制；注意现有 `.gitignore` 只写了 `*.d115p`，并不匹配 `.dian115p`，
提交前不要误把 `dist/` 里的包加进仓库。改源码后重新运行 `bash scripts/v3-build.sh`，用输出的
sha256 更新索引；索引不会自动跟着源码变。

## 验证状态

本次在仓库根实际执行过的检查（Node v24.18.0）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 三个插件结构检查 | `node v3-kit/conformance/project-check.mjs v3/<plugin>` | 3/3 通过：`chase.rs 0.1.9`、`music.rs 1.0.0`、`douban.rs 1.0.0` |
| 全部 JS 语法 | `find v3/... -name '*.js' -exec node --check {} +` | 通过：chase 16 / music 30 / douban 38 个文件 |
| 纯逻辑单测 | `(cd v3/<plugin> && node --test tests/*.test.*)` | chase 117 pass / douban 112 pass，0 fail；music 98 用例，10 次运行 9 次全过、1 次 1 fail（`tests/pump.test.js:287` 的队首假设，见 Gaps） |
| 打包 | `bash scripts/v3-build.sh`（连跑两次） | 两次 sha256 完全一致；产物 99152 / 109956 / 166058 字节 |
| 索引 JSON | `node -e 'JSON.parse(...)'` | 通过 |
| 索引字段与摘要 | 本地校验脚本（必填/id/sha256/delivery/homepage，sha256 对 dist 实算） | 通过；仅 `source_url` 相对路径为已知偏差 |
| 构建脚本语法 | `bash -n scripts/v3-build.sh` | 通过 |
| 真机安装/运行 | — | **未执行**（本机无可用 DIAN115 宿主，授权被锁） |

工具版本：Node v24.18.0、npm 11.16.0；未使用 Rust/WASM 工具链。

## GitHub Actions 发布

- 工作流：`.github/workflows/release-v3.yml`（手动触发见下，`v3-*` tag 触发已配置）
- 一键发布：`bash scripts/release-v3.sh v3-YYYY.MM.DD`（打标注 tag → 推送 → 对 tag ref 分发工作流）
- 说明：实测本仓库 deploy key 推送的 tag 未自动触发 `push.tags` 工作流（分支推送正常），因此脚本会显式 `gh workflow run --ref <tag>`；发布路径相同：构建 → 创建 Release（三包 + SHA256SUMS.txt + 更新后的市场索引）→ 回写 `v3-market-index.json` 到 main
- 仅验证打包（不发布）：`gh workflow run release-v3.yml --ref main`，产物在 run 的 artifact 里
