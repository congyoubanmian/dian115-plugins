# 豆瓣中心（Rust 版）— v3 迁移版

旧 schema 1 WASM 插件（`plugins/douban-rs` 0.2.4，Rust 15,772 行 / 579 函数）的 v3 迁移版。
本目录包含后端（jobs + lib）与页面 `ui/page.js`（`v3-ui/src/douban-rs/` 的 Vue 3 构建产物，仓库根
`bash scripts/v3-build-ui.sh` 生成）；`plugin.json` 的 `ui.entry` / `menu` 已指向页面。

## 功能链（与旧实现的模块对应）

| v3 文件 | 旧 Rust 模块 | 职责 |
| --- | --- | --- |
| `lib/clock.js` | `clock.rs` | RFC3339 严格解析/格式化、月份、base36、会话幂等前缀、测试时钟钩子 |
| `lib/text.js` | `util.rs` + 各模块纯函数 | `trunc`/`go_lossy`（逐字节 U+FFFD）、`stringVal`、QueryEscape/PathEscape、`parseWant`、`sectionAfter`、`normalizeTitle`、`safeKey` |
| `lib/model.js` | `model.rs` | 状态文档契约（settings/snapshot/queue/history/logs/stats/blackstate/wish/wish_seen/wish_info/cookie/no_resub）、null↔nil 语义、严格解析（类型不符整份拒绝）、脱敏视图、绝对路径清洗 |
| `lib/settings.js` | `runtime.rs` settingsUpdate/normalize | 清单扁平设置 ↔ 运行时视图、榜单配置合并保存、upcoming 强制 coming_html |
| `lib/charts-parse.js` | `charts.rs` 纯函数 | 三种榜单来源的解析（正则逐条对齐 Go ASCII 类）、黑名单判定/入队、成本排序 |
| `lib/cookie.js` | `wish.rs` 纯函数 | 手动 cookie 解析（需含 dbcl2）、45min 缓存 TTL |
| `lib/base64.js` | 编解码 | base64 编解码（jobs 环境没有 Node 内置模块，自带实现） |
| `lib/subscribe-core.js` | `subscribe.rs` 纯函数 | TMDB 匹配置信度（0.7/0.4/0.25/0.05，阈值 0.5）、订阅请求体（v3 openapi PoolIntentCreateRequest）、宿主池解析与去重判定 |
| `lib/poster-core.js` | `poster.rs` 纯函数 | MIME 嗅探（PNG 只看 data[1..4] 的原样行为）、img1~img9 镜像候选、s_ratio→m_ratio 降级 |
| `lib/filter-core.js` | `filter.rs` 纯函数 | min_rating/min_year/regions 三段过滤（地区只在详情已取到时生效）、墓碑集常量与 `tmdb:<type>:<id>` 解析、历史合格判定、landed/caught_up 完成态 |
| `lib/wish-core.js` | `wish.rs` 纯函数 | 想看条目映射（只收 movie/tv，评分补提取 8.6/8.7/5.8 向量）、flexId（id 字符串/数字双形态）、分页 URL |
| `jobs/store.js` | `store.rs` | 三态加载（loaded/fresh/unavailable，404 两次确认）、CAS 写回（409/412 重读重试一次）、account/diag 键、4MiB 预算 |
| `jobs/httpx.js` | `runtime.rs` httpGet / `wish.rs` httpGetWithCookie | 桌面 UA + 豆瓣防盗链 Referer / iPhone UA + 想看 referer；Go `(body, status, err)` 三元组语义 |
| `jobs/runtime.js` | `runtime.rs` | Session（读盘三态 + 账号键覆盖 + load 面包屑 + 日志/历史/统计 + persist）、动作实现（observe-remove/blacklist/settings-update/archive/open-source/send-test/no-resub-clear）、墓碑守卫与判定 |
| `jobs/charts.js` | `charts.rs` | refreshNow 编排（防重入、成本排序、预算跳过、快照、过滤入队、deep 才跑订阅、想看同步、摘要文案逐字对齐） |
| `jobs/poster.js` | `poster.rs` | moviePoster（suggest 校验 id → rexxar 兜底）、get-poster（镜像回退、每候选 2 次、128KiB 上限；成功后落插件文件缓存 `posters/<sha256(poster_url)>.<ext>` 并回填 state 的 `poster_file`，超 64 张按 modified 淘汰最旧；files/crypto 不可用时降级返回 dataURL） |
| `jobs/cookie.js` | `wish.rs` | doubanCookie（只用手�� cookie，45min 缓存）、cookieCacheFresh |
| `jobs/subscribe-engine.js` | `subscribe.rs`/`subject.rs` | tmdbSearch、匹配回退（rexxar original_title→aka 重搜取最高置信）、processDue（守卫顺序：墓碑→过滤；needs_review 不留队列；attempt<3 保留）、doSubscribe（去重→创建→历史→统计）、subscribe/subscribe-now 两入口 |
| `jobs/subject.js` | `subject.rs` | rexxar 详情（id/type 双校验，字段路径按真实响应取证）、回退候选（原名→aka 去重保序）、doubanSubjectId |
| `jobs/wish.js` | `wish.rs` | syncWishList（movie+tv 去重、seen 先写再守卫、内联订阅 vs 入队、due_at 口径）、fetchWish 分页、actionWishSync、runWishSyncJob（想看+到期订阅+墓碑判定节流 6h） |
| `jobs/<id>.js`（16 个） | 旧 action/job 分发表 | 薄壳入口：`run`/`recover` + 进度上报 |
| `ui/page.js` | 旧 Vue `AppPage.vue`（已删除） | Vue 3 构建产物（源码 `v3-ui/src/douban-rs/`）：榜单/海报墙、观察队列与我的想看、历史日志、设置表单、手动刷新/同步/订阅/维护动作 |

测试夹具（`v3/tests/douban-rs/fixtures/`）原样复用旧仓库的脱敏真实样本：state_val / wish_movie / wish_tv /
subject_detail{,_tv} / chart_listcont2 / coming_showing_soon / search_subjects。

## 运行方式

```bash
node --test *.test.mjs               # 150 个用例（在 v3/tests/douban-rs/）
node --check <每个 .js>             # 语法
node v3-kit/conformance/project-check.mjs v3/douban-rs
node v3-kit/conformance/pack.mjs v3/douban-rs dist/douban-rs.dian115p
```

## 迁移差异（如实记录）

1. **无常驻 VM**：旧 WASM 的内存态 + `ensure_loaded` 单次加载改为每次 job `Session.open(ctx)`，
   落盘经 `expected_revision` CAS（旧 ETag/If-Match 由 v3 宿主收敛）。三态加载、404 两次确认、
   foreign 文档拒绝落盘、4MiB 预算、日志留尾 40 等安全语义全部保留。
2. **登录态**：按宿主新规约不再读取 CookieCloud；登录态只来自用户手动粘贴的豆瓣 Cookie（需含 `dbcl2`），解析结果进 45 分钟缓存（状态文档 `cookie` 字段）。
3. **幂等键**：`ctx.api` 不暴露自定义请求头，旧 `dc-sub-<invocation>-<tmdb_id>` /
   `dc-put-<key>-<nonce>-<n>` 幂等键不再携带；幂等由宿主任务队列 business_key +
   宿主侧 (tmdb_id, media_type) 去重 + storage CAS 保底。
4. **通知**：旧版宿主拒绝插件通知 payload（send-test 固定 skipped、notify_on_subscribe 是死开关）；
   v3 通知通道可用，两者恢复为真实现（ctx.notify，dedupe_key 防重）。
5. **设置**：扁平开关走清单 `settings`（宿主表单 + settings KV），榜单/黑名单等嵌套配置仍留
   状态文档；settings-update 同时写两处并作废 cookie 缓存（账号字段变化时）。
6. **调度**：定时刷新沿用 `0 */2 * * *`；定时订阅处理（旧 wish-sync job）按宿主建议改用
   `interval_seconds: 1800`（与旧 cron */30 * * * * 等价）。页面动作全部是 `queue:false` 的短任务。
7. **事件**：旧实现的事件入口只收下并忽略（`{"accepted":true}`），未依赖消息触发。
   1.2.0 起清单声明 `events: [{event:'message', job:'tg-command', commands:['refresh','wish'],
   channels:['telegram']}]` 与 `permissions: ["telegram.bot"]`：Telegram 里发 `/refresh`、`/wish`
   触发对应编排（复用 refresh-charts deep / wish-sync），回执走 `ctx.messaging.reply`——指令触发
   本身不需要授权（messaging.md 的 commands 规则），**回执需要用户在插件卡片上授权
   `telegram.bot`**，未授权时回执失败只记 warning、业务结果照常进任务记录。消息能力是宿主
   API 3.6 起，`requires.api` 相应提到 3.6。
8. **send-test / job 结果文案**：错误与摘要文案逐字对齐旧实现（含 `未知榜单来源 "x"` 的 Go %q、
   `TMDB 匹配置信不足 (0.42)` 两位小数、`本次已用 N 秒, 跳过剩余榜单` 等诊断路径）。

## 页面（`ui/page.js`）

`export async function mount(root, ctx)`，返回清理函数（断开 IntersectionObserver、清空海报缓存、
移除 DOM/样式）。数据与动作全部走 v3 页面 ctx：

- **读取**：`ctx.storage.get('state')`（用 `lib/model.js` 的 `parseStateDoc` / `isRecognizable` 做与 job
  相同的严格解析）+ `ctx.settings.get()`（`lib/settings.js` 的 `normalizeFlat` 兜底）。识别不了的
  state 文档只展示空状态并提示，不会写回。
- **动作**：`ctx.tasks.run(job, business_key, input)` + 轮询 `ctx.tasks.get(id)`；使用 `refresh`、
  `wish-sync-now`、`subscribe`、`subscribe-now`、`observe-remove`、`blacklist-add/remove`、
  `settings-update`、`archive`、`no-resub-clear`、`send-test`、`get-poster`。
- **海报**：取图优先级与降级链在 `v3-ui/src/douban-rs/poster-chain.js`（框架无关，页面与测试跑同一份实现）：
  ① 文件缓存快路径——state 条目已带 `poster_file`（后端 `get-poster` 回填的 `posters/<sha256>.<ext>` 相对路径）
  时用 `ctx.files.downloadURL` 拼同源地址，Range 探测可用直接进 `<img src>`；② 页面直连——豆瓣 CDN
  无 Referer 返回 418，用 `ctx.http.request` 带 `Referer: https://movie.douban.com/` 取
  `response_type:'base64'` 拼 data URL（>400KB 交后端）；③ 回退 `get-poster` job（镜像逐个回退 +
  128KiB 上限 + 写插件文件缓存）。后端文件缓存超 64 张按 modified 淘汰最旧；被淘汰路径的 404 由页面
  回退链兜底。页面内存缓存最多 160 张、只存 URL 字符串，IntersectionObserver 懒加载，并发 4。
- **设置**：表单从 `ctx.settings.get()` 渲染，保存经 `settings-update` job 同时写 settings KV 与状态
  文档（榜单 lists、账号字段、过滤器、保留条数）；黑名单增删走独立 job；凭据输入框不回显，留空
  表示保持原值，可显式勾选清除。
- **未做交互（gaps）**：旧 Vue 的动画/过渡、拖拽排序、通知按钮回调、历史/日志分页（页面展示
  state 存储里的全部：历史按 `max_history` 裁剪，日志落盘只留最近 40 条）；
  页面为 Vue 3 重写（`v3-ui/src/douban-rs/`），视觉与原版存在差异；海报点击放大已补（`PosterLightbox.vue`）。
  没有「一键处理全部到期订阅」——后端没有独立的 process-due job，页面只提供逐条 `subscribe-now`，
  批量到期由定时 `wish-sync` 处理。

## 未迁移 / 交给下一阶段

- 旧 Vue 前端源码已按用户要求删除，未做逐组件像素级对照；页面覆盖业务功能，不覆盖原版视觉细节。
- `dist/` 打包在页面完成后执行：`node v3-kit/conformance/pack.mjs v3/douban-rs dist/douban-rs.dian115p`。

## TG 指令（jobs/tg-command.js，1.2.0）

清单 `events[]` 声明 `{event:'message', commands:['refresh','wish'], channels:['telegram']}`（限 Telegram，
企业微信侧同文本不分发）。宿主把命中的消息投影投给 `tg-command`：

| 指令 | 编排 | 回执 |
| --- | --- | --- |
| `/refresh`（含 `/refresh@bot名`，大小写不敏感） | `refreshNow(deep)`：抓榜 → 黑名单入队 → 到期订阅 → 想看同步 → 落盘 | 开始与结束各一条 `ctx.messaging.reply` |
| `/wish` | `runWishSyncJob`：想看同步 → 到期订阅 → 墓碑判定 → 落盘 | 结束回执带 `wish_info.last_status` 的真实结果（成功条数/新增/失败原因） |

- **授权边界**（`v3-kit/docs/messaging.md`）：`commands` 触发本身不需要授权；**回执**走
  `ctx.messaging.reply` 需要用户在插件卡片上授权 `telegram.bot`（清单已声明 `permissions`）。未授权时
  回执失败只记 warning，业务结果照常执行并进任务记录。消息能力是宿主 API 3.6 起，`requires.api` 为 3.6。
- 恢复：`recover` 复用 `recoverSubscribe(batch)`——先查宿主订阅池真实状态再决定 complete / resume / attention。
- 回执与日志只带业务摘要，绝不含 Cookie 等凭据。

## 版本记录

### 1.2.0

- **外部写检查点与真实状态恢复**：创建聚合订阅前后各落一次任务检查点（before/after-create-intent，
  含 tmdb_id + media_type）；`recoverSubscribe` 按检查点先查宿主订阅池里该 `(tmdb_id, media_type)` 的
  真实状态——已确认建了才 `complete`、确认没建才 `resume`、自称成功却查不到或查池失败 `attention`；
  批量入口（想看同步 / 榜单刷新 / TG 指令）命中时返回 `resume` 让批次继续，已建那条由宿主去重跳过。
- **TG 指令 /refresh、/wish**（jobs/tg-command.js）：见上节；`requires.api` 3.5 → 3.6（ctx.messaging），
  清单新增 `permissions: ["telegram.bot"]`。
- **海报文件缓存**：`get-poster` 成功后把海报落插件自有 `posters/<sha256(poster_url)>.<ext>`（同一 URL
  永远同路径，重写幂等），超 64 张按 modified 淘汰最旧（只删 posters/ 内），路径回填 state 的
  `poster_file` 字段（绝不存 base64）；页面取图链改为「文件缓存快路径 → 页面直连 → get-poster 回退」
  （`v3-ui/src/douban-rs/poster-chain.js`，页面与测试同一份实现），内存只存 URL 字符串。
- 测试 117 → 150 项：新增 `recover.test.mjs`（12）、`manifest.test.mjs`（2）、`poster-chain.test.mjs`（6）、
  `jobs-flow` +11、`poster-core` +2（清单/检查点/海报链/TG 回执覆盖），全过。
- 合并修正：1.2.0 的 subscribe-engine 改动曾基于 1.1.5 之前的版本，丢了 1.1.5 的查重分页失败即放弃、
  TMDB 排除 person 偏向豆瓣类型、待确认留队 + 失败退避重试（`settleUnsubscribed`）、按条目+结果+订阅 ID 的
  通知去重键，并导致 `jobs-flow` / `recover` 两个测试文件整份加载失败；已按 1.1.5 口径恢复，检查点与恢复逻辑保留。
  恢复判定 `queryPoolIntent` 也改为按 media_type 分页读完订阅池（截断且未命中按读不到 → attention）。
- 页面海报内存缓存改为 LRU，并与响应式状态表一起封顶 160 条（之前状态表无上限、会一直攥着 data: 字符串）；
  `<img>` 出错先丢缓存重取一次；页面关闭（ctx.signal）后不再发起新的取图请求；设置页新增「Telegram 指令」说明卡片。
- TG 回执按 Telegram 4096 字上限截断。
