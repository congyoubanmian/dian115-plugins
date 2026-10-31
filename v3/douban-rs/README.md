# 豆瓣中心（Rust 版）— v3 迁移版

旧 schema 1 WASM 插件（`plugins/douban-rs` 0.2.4，Rust 15,772 行 / 579 函数）的 v3 迁移版。
本目录包含后端（jobs + lib + tests）与页面 `ui/page.js`（原 Vue 前端源码已按用户要求删除，页面用
原生 JS + DOM 重写）；`plugin.json` 的 `ui.entry` / `menu` 已指向页面。

## 功能链（与旧实现的模块对应）

| v3 文件 | 旧 Rust 模块 | 职责 |
| --- | --- | --- |
| `lib/clock.js` | `clock.rs` | RFC3339 严格解析/格式化、月份、base36、会话幂等前缀、测试时钟钩子 |
| `lib/text.js` | `util.rs` + 各模块纯函数 | `trunc`/`go_lossy`（逐字节 U+FFFD）、`stringVal`、QueryEscape/PathEscape、`parseWant`、`sectionAfter`、`normalizeTitle`、`safeKey` |
| `lib/model.js` | `model.rs` | 状态文档契约（settings/snapshot/queue/history/logs/stats/blackstate/wish/wish_seen/wish_info/cookie/no_resub）、null↔nil 语义、严格解析（类型不符整份拒绝）、脱敏视图、绝对路径清洗 |
| `lib/settings.js` | `runtime.rs` settingsUpdate/normalize | 清单扁平设置 ↔ 运行时视图、榜单配置合并保存、upcoming 强制 coming_html |
| `lib/charts-parse.js` | `charts.rs` 纯函数 | 三种榜单来源的解析（正则逐条对齐 Go ASCII 类）、黑名单判定/入队、成本排序 |
| `lib/cookiecloud-core.js` | `cookiecloud.rs`/`wish.rs` 纯函数 | 自建 CookieCloud 的解密链（EVP_BytesToKey + AES-CBC/PKCS7，密钥材料 = md5 hex 前 16 字符）、豆瓣 cookie 提取（新旧两种文档形态 + v3 宿主快照）、手动 cookie 解析、45min 缓存 TTL |
| `lib/subscribe-core.js` | `subscribe.rs` 纯函数 | TMDB 匹配置信度（0.7/0.4/0.25/0.05，阈值 0.5）、订阅请求体（v3 openapi PoolIntentCreateRequest）、宿主池解析与去重判定 |
| `lib/poster-core.js` | `poster.rs` 纯函数 | MIME 嗅探（PNG 只看 data[1..4] 的原样行为）、img1~img9 镜像候选、s_ratio→m_ratio 降级 |
| `lib/filter-core.js` | `filter.rs` 纯函数 | min_rating/min_year/regions 三段过滤（地区只在详情已取到时生效）、墓碑集常量与 `tmdb:<type>:<id>` 解析、历史合格判定、landed/caught_up 完成态 |
| `lib/wish-core.js` | `wish.rs` 纯函数 | 想看条目映射（只收 movie/tv，评分补提取 8.6/8.7/5.8 向量）、flexId（id 字符串/数字双形态）、分页 URL |
| `jobs/store.js` | `store.rs` | 三态加载（loaded/fresh/unavailable，404 两次确认）、CAS 写回（409/412 重读重试一次）、account/diag 键、4MiB 预算 |
| `jobs/crypto.js` | cookiecloud 原语接线 | `ctx.crypto`/`ctx.codec` 适配器；MD5 纯 JS 兜底（向量对拍）；base64 自实现（宿主/测试行为一致） |
| `jobs/httpx.js` | `runtime.rs` httpGet / `wish.rs` httpGetWithCookie | 桌面 UA + 豆瓣防盗链 Referer / iPhone UA + 想看 referer；Go `(body, status, err)` 三元组语义 |
| `jobs/runtime.js` | `runtime.rs` | Session（读盘三态 + 账号键覆盖 + load 面包屑 + 日志/历史/统计 + persist）、动作实现（observe-remove/blacklist/settings-update/archive/open-source/send-test/no-resub-clear）、墓碑守卫与判定 |
| `jobs/charts.js` | `charts.rs` | refreshNow 编排（防重入、成本排序、预算跳过、快照、过滤入队、deep 才跑订阅、想看同步、摘要文案逐字对齐） |
| `jobs/poster.js` | `poster.rs` | moviePoster（suggest 校验 id → rexxar 兜底）、get-poster（内存缓存 64、镜像回退、每候选 2 次、128KiB 上限） |
| `jobs/cookiecloud.js` | `cookiecloud.rs`/`wish.rs` | doubanCookie（自建 → 宿主内置 → 手动 cookie，45min 缓存）、cookieCloudPull（Not Found/过大/异常文案逐字对齐）、cookiecloud-test |
| `jobs/subscribe-engine.js` | `subscribe.rs`/`subject.rs` | tmdbSearch、匹配回退（rexxar original_title→aka 重搜取最高置信）、processDue（守卫顺序：墓碑→过滤；needs_review 不留队列；attempt<3 保留）、doSubscribe（去重→创建→历史→统计）、subscribe/subscribe-now 两入口 |
| `jobs/subject.js` | `subject.rs` | rexxar 详情（id/type 双校验，字段路径按真实响应取证）、回退候选（原名→aka 去重保序）、doubanSubjectId |
| `jobs/wish.js` | `wish.rs` | syncWishList（movie+tv 去重、seen 先写再守卫、内联订阅 vs 入队、due_at 口径）、fetchWish 分页、actionWishSync、runWishSyncJob（想看+到期订阅+墓碑判定节流 6h） |
| `jobs/<id>.js`（16 个） | 旧 action/job 分发表 | 薄壳入口：`run`/`recover` + 进度上报 |
| `ui/page.js` | 旧 Vue `AppPage.vue`（已删除） | 原生 JS + DOM：榜单/海报墙、观察队列与我的想看、历史日志、设置表单、手动刷新/同步/订阅/维护动作 |

测试夹具（`tests/fixtures/`）原样复用旧仓库的脱敏真实样本：state_val / wish_movie / wish_tv /
subject_detail{,_tv} / chart_listcont2 / coming_showing_soon / search_subjects / cookiecloud_vectors。

## 运行方式

```bash
node --test tests/*.test.mjs        # 112 个用例
node --check <每个 .js>             # 语法
node v3-kit/conformance/project-check.mjs v3/douban-rs
```

## 迁移差异（如实记录）

1. **无常驻 VM**：旧 WASM 的内存态 + `ensure_loaded` 单次加载改为每次 job `Session.open(ctx)`，
   落盘经 `expected_revision` CAS（旧 ETag/If-Match 由 v3 宿主收敛）。三态加载、404 两次确认、
   foreign 文档拒绝落盘、4MiB 预算、日志留尾 40 等安全语义全部保留。
2. **CookieCloud**：v3 主路径是宿主内置 `ctx.cookiecloud('read')`（宿主负责解密与配置）；
   旧"自建服务器 + 插件内 AES 解密"整条链保留（settings 里显式填写地址/UUID/口令时启用），
   加解密原语用 `ctx.crypto`（AES 不做插件内兜底实现 —— 未经真机验证的密码学代码比明确报错危险，
   MD5/base64 的纯 JS 兜底已被向量对拍）。手动粘贴 cookie 回退原样保留。
3. **幂等键**：`ctx.api` 不暴露自定义请求头，旧 `dc-sub-<invocation>-<tmdb_id>` /
   `dc-put-<key>-<nonce>-<n>` 幂等键不再携带；幂等由宿主任务队列 business_key +
   宿主侧 (tmdb_id, media_type) 去重 + storage CAS 保底。
4. **通知**：旧版宿主拒绝插件通知 payload（send-test 固定 skipped、notify_on_subscribe 是死开关）；
   v3 通知通道可用，两者恢复为真实现（ctx.notify，dedupe_key 防重）。
5. **设置**：扁平开关走清单 `settings`（宿主表单 + settings KV），榜单/黑名单等嵌套配置仍留
   状态文档；settings-update 同时写两处并作废 cookie 缓存（账号字段变化时）。
6. **调度**：定时刷新沿用 `0 */2 * * *`；定时订阅处理（旧 wish-sync job）按宿主建议改用
   `interval_seconds: 1800`（与旧 cron */30 * * * * 等价）。页面动作全部是 `queue:false` 的短任务。
7. **事件**：旧实现的事件入口只收下并忽略（`{"accepted":true}`），未依赖消息触发，
   因此 v3 manifest 未声明 events；TG 回调按钮（v3 notify buttons）留给页面阶段按需加。
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
  `settings-update`、`archive`、`no-resub-clear`、`send-test`、`cookiecloud-test`、`get-poster`。
- **海报**：豆瓣 CDN 无 Referer 返回 418，页面用 `ctx.http.request` 带
  `Referer: https://movie.douban.com/` 取 `response_type:'base64'`；失败回退 `get-poster` job。
  页面内存缓存最多 160 张，IntersectionObserver 懒加载，并发 4。
- **设置**：表单从 `ctx.settings.get()` 渲染，保存经 `settings-update` job 同时写 settings KV 与状态
  文档（榜单 lists、账号字段、过滤器、保留条数）；黑名单增删走独立 job；凭据输入框不回显，留空
  表示保持原值，可显式勾选清除。
- **未做交互（gaps）**：旧 Vue 的动画/过渡、拖拽排序、通知按钮回调、历史/日志分页（页面展示
  state 存储里的全部：历史按 `max_history` 裁剪，日志落盘只留最近 40 条）、海报点击放大预览；
  页面为原生 JS 重写，视觉与原版存在差异。没有「一键处理全部到期订阅」——后端没有独立的
  process-due job，页面只提供逐条 `subscribe-now`，批量到期由定时 `wish-sync` 处理。

## 未迁移 / 交给下一阶段

- 旧 Vue 前端源码已按用户要求删除，未做逐组件像素级对照；页面覆盖业务功能，不覆盖原版视觉细节。
- `dist/` 打包在页面完成后执行：`node v3-kit/conformance/pack.mjs v3/douban-rs dist/douban-rs.dian115p`。
