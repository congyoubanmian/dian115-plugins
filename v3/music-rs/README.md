# 音乐下载（dian115 插件 v3）

网易云 / QQ 音乐搜索、**网易云与 QQ 音乐双源扫码登录**（QQ 走官方二维码 + OAuth 授权换凭据）与手动粘贴 Cookie 回退、**两个来源的「我的歌单」**（我创建的 + 收藏的；QQ 另有「每日推荐」「我喜欢」）、按音质逐级取链；单曲与整张歌单入队后由后台任务自动推进：取链接 → **API 3.9 起 `save_to` 优先直写目标目录**（宿主不开放该能力时回落「插件暂存 → 定名 → move」，CD2 挂载由宿主自动分流）→ 失败通知带「重试」按钮。下载与入库前后落任务检查点，中断恢复先核对目标目录里的真实文件再判定；Telegram 机器人另有只读查询命令与每日下载日报（见「TG 命令与日报」）。

本插件是 `plugins/music-rs`（旧 schema 1，Rust WASM 0.3.19）的 **v3 迁移版**：Rust 业务逐函数移植为宿主内 ESM JavaScript（无 npm 依赖、无 Node 内置模块），WASM 基建（abi/arena/host/protocol/store 乐观锁幂等键/clock）由 v3 宿主能力取代。

## 功能

- **搜索**：网易云（`/api/cloudsearch/pc`，每页 30 条）/ QQ（`search_for_qq_cp`，每页 20 条），页面直连。
- **登录**：**网易云与 QQ 音乐两个来源的扫码都在本插件内实现**（网络层 `lib/music-api.js` + 纯逻辑 `lib/qq.js`），页面只渲染二维码与每 2 秒轮询一次；两源都保留手动粘贴 Cookie（白名单清洗 + 合并写入）作为回退；按宿主新规约插件不读取 CookieCloud。细节见「登录」一节。
- **取链**：网易云 eapi（AES-128-ECB + MD5，宿主 `ctx.crypto`）按 8 档音质阶梯逐级回退；QQ 按参考客户端 Lilt 的流程：先读歌曲详情拿 `media_mid`，登录态请求 `F000(flac) → M800(320k) → M500(128k)`，匿名只请求 `M500`；每档单独请求 vkey，相对 purl 用响应里的 `sip` 域名拼接（详见 `lib/qq.js` 注释）。
- **歌单**：**网易云与 QQ 音乐都支持「我的歌单」**（我创建的 + 收藏的）；歌单内分页浏览（每页 100 首）；整单分批入队（每批 5 页 × 100 首，`next_page` 续批游标，页面级失败不回滚已入队）。**QQ 另有两个特殊入口：「每日推荐」「我喜欢」**。详见「歌单」一节。
- **下载队列**（API 3.9：`save_to` 可直写用户目标目录，省一次跨盘拷贝；宿主不开放该能力时自动回落「插件暂存 → 定名 → move」）：KV 分片（`tasks.idx` + `task.<id>`），去重按 `source+song_id+quality`；定时任务（每 5 分钟）与页面手动「推进队列」走同一入口；`queued → downloading → copying → done/failed`，失败重试 ≤3 次后发通知（Telegram 按钮 `callback_data: retry:<短id>`，点击触发回调任务重新排队）。
- **同名预检与检查点**（1.3.0）：下载前与入库（move）前用 `files.exists` 预检目标目录，已有同名文件直接终态失败（错误写明路径），不进「move overwrite:false 撞墙 → 重试」循环；下载/入库前后各落一次任务检查点（before-download / after-download / before-move / after-move，含目标路径与 size/sha256），中断恢复 `recoverPump` 先用 `exists`/`stat` 核对目标目录里的真实文件再决定 complete / resume / attention——判 complete 时把 KV 队列里的在途任务一并收敛为 done，避免下一轮 pump 误报「目标已存在」。失败通知的 `dedupe_key` 收敛为只含任务 id（`dl-fail-<id>`），重试窗口内同键去重。
- **TG 命令与日报**（1.3.0）：`/music 队列|状态|帮助`、`/queue`、`/status` 只读查询（不入队、不重试、不删除），回复走来源渠道 `ctx.messaging.reply`，未授权 telegram.bot 时回退 `ctx.notify` 普通通知（dedupe_key 取 chat_id + message_id）；每天 08:30 的 `daily-report` 发一条下载日报（dedupe_key `music:daily-report:<日期>`，按天稳定）。详见下文。
- **任务运维**：重试、清空已完成、索引对账（孤儿分片挂回）。

## 登录

网易云与 QQ 音乐**两个来源的扫码都在本插件内实现**（网络层 `lib/music-api.js`，纯逻辑 `lib/qq.js`），
页面（`v3-ui/src/music-rs`）只负责渲染二维码与每 2 秒轮询一次状态。宿主侧只提供 HTTP 与 Cookie 能力，
插件不依赖任何外部登录服务。

### 依赖宿主 session Cookie（`v3-kit/docs/network.md:15`）

登录链路上的**临时 Cookie 只留在宿主 session 里**：不进插件 KV、不进日志、不回显页面。
依据 `network.md:15`「自动处理重定向各跳 Set-Cookie；插件内不同 session 独立记忆登录态」——
重定向每一跳的 `Set-Cookie` 由宿主记进对应 session，插件按 session 把三条链路隔开：

| 链路 | session 名 | 临时 Cookie | 落盘情况 |
| --- | --- | --- | --- |
| 网易云扫码 | `netease` | unikey 会话（`MUSIC_U` / `MUSIC_A` 等） | 换到凭据后写插件 KV `cookies.netease` |
| QQ 扫码 | `qq` | `qrsig`、`graph.qq.com` 的 `p_uin` / `p_skey` / `pt_oauth_token` | **扫码链路不落盘**；登录成功后清空宿主 session |
| QQ 音乐换凭据 | `qq-musicu` | 无 | 独立 session，绝不带 `graph.qq.com` 的 Cookie |

- 读回用 `ctx.http.cookies({url, session})`（`v3-kit/docs/sdk/core-types.d.ts:15`）；
  清空用 `ctx.http.importCookies({session, cookies: [], replace: true})`——宿主没有单条删除 API，只能整段替换。
- 宿主 session 的 Cookie 跨重启保留（`network.md:15`），所以 QQ 的全局授权 Cookie 必须主动清；
  清不掉时**登录仍算成功**，但页面会额外收到一条 `warning`，提示用户手动清理浏览器里的 QQ 登录态。

### 网易云扫码

1. `POST https://interface.music.163.com/api/login/qrcode/unikey`（`type=3`）拿 `unikey`；页面把
   `https://music.163.com/login?codekey=<unikey>` 用插件自带的 QR 编码器（`ui/qr.js`，QR Model 2）画成 SVG；
2. 每 2 秒 `POST https://interface.music.163.com/api/login/qrcode/client/login` 轮询（`803` = 扫码成功）；
3. 登录 Cookie 取三个来源的并集：响应体 `cookie` 字段、宿主 session jar（`music.163.com` 与
   `interface.music.163.com` 各读一遍）、响应头 `Set-Cookie`；
4. 拿到 `MUSIC_U` / `MUSIC_A` 才写 KV（`cookies.netease`）；一个都没有就如实提示「扫码完成但没取得登录态」，
   **绝不写空表冒充登录成功**，落盘失败也直接报错（不报「登录成功」）。

### QQ 扫码

流程与参考实现（`internal/qqmusic/auth.go` 的 `QRKey` / `QRCheck` 与授权链、`auth_response.go` 的
`decodeQQLoginResponse`）一致，全部在插件内完成：

1. **取码**：`GET https://xui.ptlogin2.qq.com/ssl/ptqrshow` 拿**官方 PNG 二维码**
   （`response_type:'base64'`，并校验 PNG magic；不是 PNG 直接报错）。响应里的 `qrsig` 只留在宿主 session，
   页面拿到的是不透明随机 key——`qrsig` 不出现在返回值、日志和错误消息里。
2. **轮询**：`GET https://xui.ptlogin2.qq.com/ssl/ptqrlogin?ptqrtoken=hash33(qrsig)`，解析 `ptuiCB(...)`：
   `66` = 等待扫码 / `67` = 已扫码待手机确认 / `65` = 已过期 / `0` = 扫码成功。
   页面刷新后内存里的扫码会话表会丢，插件退回宿主 session 里仍在的 `qrsig`；仍取不到就提示刷新二维码。
3. **授权链**：`check_sig` → `login_jump` → `authorize`
   - 每一跳的目标都做 **host + path 逐字**校验（`lib/qq.js` 的 `trustedLoginUrl`）：
     `check_sig` 只允许 `ssl.ptlogin2.graph.qq.com/check_sig`，`login_jump` 只允许 `graph.qq.com/oauth2.0/login_jump`，
     不合规**连请求都不发**；
   - 这几步用 `follow_redirects:false` 取原始 3xx，自己读 `Location` 校验后再显式 GET——
     让宿主自动跟随就等于先把白名单外的目标请求过了；
   - `graph.qq.com` 的 `p_uin` / `p_skey` / `pt_oauth_token` 要求 Cookie 的 `Domain` **精确等于**
     `graph.qq.com`（更宽的 `.qq.com` 不算这次的授权凭据），三个缺一就报错；
   - `authorize` 换 code 时校验回调 host/path（`y.qq.com/portal/wx_redirect.html`）、`code` 形态与
     `state` 是否与发出的一致，不一致就拒绝（不拿未校验的 code 去换凭据）。
4. **换 QQ 音乐凭据**：`POST https://u.y.qq.com/cgi-bin/musicu.fcg`，模块 `QQConnectLogin.LoginServer` /
   方法 `QQLogin`；校验 `code`、`musicid`（>0 的数字）、`musickey`（非空）、`loginType=2`
   （QQ 互联路径），拿到 **`musicid`（uin）与 `musickey`**。
5. **落盘**：只写 QQ 音乐自己的凭据（`uin` / `qqmusic_uin` / `qqmusic_key` / `qm_keyst` / `tmeLoginType`）
   与账号标识 **`encryptUin`**（`QQLogin` 响应里带回的账号 id；**收藏歌单 / 我喜欢接口的 `uin` 参数要用它**）
   到插件 KV `cookies.qq`；`graph.qq.com` 的全局授权 Cookie 不写进 KV，随后清空宿主 session。

### 失败回退

扫码链路任何一步失败，页面都不假装成功：

- 二维码过期 / 返回的不是 PNG / 拿不到 `qrsig` → 明确报错提示刷新重试（页面可重新取码）；
- 扫码完成但没取到登录凭据 → 状态显示「扫码完成，未取得登录态」，提示改用手动粘贴；
- **手动粘贴 Cookie**（一直保留的通道）：浏览器登录后复制整行 Cookie 粘进登录卡，
  按白名单清洗后合并写入插件 KV（网易云必须有 `MUSIC_U`/`MUSIC_A`；QQ 必须有 `qqmusic_key`
  或可补齐的 `p_skey`/`skey`/`musickey`）；
  注意：**手动粘贴拿不到 `encryptUin`**（它只在 `QQLogin` 响应里），
  所以这条通道下 QQ 的「收藏的歌单」与「我喜欢」读不到，只有「我创建的」能用 —— 要用这两个入口得扫码登录；
- 「我的歌单」这一条接口返回该账号的歌单列表（**创建的与收藏的在同一份列表里**，插件不分栏）；
- 页面每页 100 首（`lib/constants.js` 的 `PLAYLIST_PAGE_SIZE`），整单入队也按这个页大小翻。

### QQ 音乐

歌单类接口都是 `POST https://u.y.qq.com/cgi-bin/musicu.fcg` 的 JSON 信封 `{comm, req_0}`，
**登录态放在信封 `comm` 里**（`lib/qq.js:180` 的 `authenticatedComm`：`qq` = 账号 musicid、
`authst` = `qqmusic_key`、`tmeLoginType` = 登录类型），请求的 Cookie 头只带
`uin` / `qqmusic_uin` / `qm_keyst` / `qqmusic_key` 四个凭据字段
（`lib/cookies.js` 的 `QQ_COOKIE_HEADER_KEYS`）。

| 入口 | 模块 / 方法 | 参数要点 |
| --- | --- | --- |
| 我创建的 | `music.musicasset.PlaylistBaseRead` / `GetPlaylistByUin` | `uin` = 账号 musicid（去 `o` 前缀与前导零的规范形态） |
| 收藏的 | `music.musicasset.PlaylistFavRead` / `CgiGetPlaylistFavInfo` | `uin` = **`encryptUin`**、`offset` + `size`（100） |
| 每日推荐 | `music.srfDissInfo.aiDissInfo` / `uniform_get_Dissinfo` | `dirid=202`（**无游标**，整份取回后本地切片） |
| 我喜欢 | `music.srfDissInfo.DissInfo` / `CgiGetDiss` | `dirid=201`、`enc_host_uin` = **`encryptUin`**、`song_begin` + `song_num` |
| 普通歌单曲目 | `aiDissInfo/uniform_get_Dissinfo`（公开）或 `DissInfo/CgiGetDiss`（自建 / 私密） | `disstid` = 歌单 id |

行为细节（都与参考实现 Lilt 的 `internal/qqmusic/library.go`、`catalog.go` 对齐）：

- **encryptUin 是账号标识，只有一个来源：扫码登录时 `QQLogin` 的响应**
  （`lib/music-api.js:714` 的 `persistQqCredential` 把它写进 `cookies.qq`）。
  收藏的歌单与「我喜欢」的 `uin` 参数都要它。**手动粘贴 Cookie 拿不到** →
  收藏与「我喜欢」读不到，页面显示「未取得账号标识」的提示，「我创建的」仍可读；
  换账号后旧 encryptUin 不再使用（记在 `encryptUinFor`，不属于当前账号就不取）。
- 收藏歌单按「本页实际条数」推进游标（不是 `size`），`offset` 硬上限 10000；
  撞上限时返回**已读到的部分 + 说明**，不假装读完了。
- 私密歌单用公开接口只会回「成功但空壳」（`songlist` 空但 `total_song_num > 0`）：
  这时改走带 `enc_host_uin` 的自建接口（`lib/music-api.js:1083`）。
- 「我喜欢」跨页按 mid 去重；某一页全是重复曲时如实报「未能完整读取」，不显示重复歌曲。
- 「每日推荐」接口没有游标，插件一次整份取回后按页切片（按账号缓存 5 分钟），翻页不重拉。
- QQ 曲目的 `song_id` 是 **mid**（字符串），与 QQ 取链（`qqSongUrl`）用的是同一个 id。
- 页面把「还没加载过」「读不到」「确实是空的」分成三种状态展示，不把失败说成空列表。

### 整单入队

两个来源同一条路径（`lib/queue-pages.js` 的 `queuePlaylistPages`）：每批 5 页 × 100 首，
`next_page` 作续批游标；**页面级失败不回滚已入队的歌**（单首入队失败只记账跳过）。
QQ 走 `qqPlaylistSongsPage`（游标 `begin = (page-1) × 100`），
网易云走 v6 全量索引 + v3 详情切片。

> 真机状态：本节用到的 musicu 接口与网易云歌单接口在本机**只有离线单测覆盖**
> （本机没有可用的 dian115 宿主，也没有真实账号），真实返回的字段形态、分页终止条件
> 与「空壳」判定未在真机上验证过。

## TG 命令与日报

### 只读查询命令（jobs/tg-command.js，清单 event=message）

| 命令 | 行为 |
| --- | --- |
| `/music 队列`（或 `/queue`） | 进行中 / 排队 / 最近失败三段视图（每段最多 8 条）+ 计数头 |
| `/music 状态`（或 `/status`） | 状态计数、今日完成/失败、目标目录与音质摘要、上次推进 |
| `/music 帮助`（或未识别输入） | 显示可用命令 |

- 命令面**只读**：不入队、不重试、不删除、不发任何下载请求；入队与重试仍在页面或失败通知的「重试」按钮里。
- **授权边界**（`v3-kit/docs/messaging.md`）：`commands` 触发本身不需要授权也能进任务，但**回复**
  走 `ctx.messaging.reply` 需要用户在插件卡片上授权 `telegram.bot`——未授权（或渠道异常）时回退
  `ctx.notify` 发普通通知，dedupe_key 用事件自带的 `chat_id + message_id`（稳定事实，同一条消息
  重复投递直接去重，不引入时间戳）。清单声明 `permissions: ["telegram.bot"]`。
- 回复文本只含任务名/歌手/状态/设置等用户自己的业务数据，不含 Cookie 与凭据；本 job 不读 `lib/cookies.js`。

### 每日下载日报（jobs/daily-report.js，每天 08:30）

- 读 KV 任务索引做统计：各状态计数 + 今日完成/失败清单（口径 = `startOfLocalDay`，与 `/music 状态` 一致），`ctx.notify` 发 TG（`channels: ['telegram']`，走用户的通知模板与静默时段）。
- `dedupe_key = music:daily-report:<YYYY-MM-DD>`：按天稳定，同一天重投/重跑同键同内容直接去重，不引入时间戳。
- notify 抛错（限流/全部渠道失败）不拖垮任务：吞错记进检查点与返回值 `notify_error`，当天不再自动重发。
- 任务不带 `recover`：唯一外部写是 notify 一次，投递未达任何渠道时同键重试安全；写前/写后各落一次检查点便于人工核对。

## 旧版 → v3 的架构性差异（如实说明）

| 旧版（schema 1 WASM） | v3 | 原因 |
| --- | --- | --- |
| 宿主代下载两段式：`plugin-host/files/downloads` 提交 + 轮询 job | `ctx.http.request({save_to})` 同步流式下载到插件自有 `downloads/` | v3 文件模型 |
| 暂存目录设置 `staging_dir` | 固定插件自有目录 `downloads/` | v3 插件自有文件即暂存区（developer-guide §文件与 CD2） |
| `local-files/rename` + `local-files/copy`（宿主 5.x 禁跨边界复制 → 旧版被迫做 CD2 gRPC-Web 直送） | `ctx.files.call({operation:'rename'/'move'})`，宿主按 CD2 挂载前缀自动分流并报告字节进度 | v3 宿主文件操作打通本地/CD2 |
| CD2 直送设置五项（cd2_url/token/dest_dir/local_folder/register_host）与 cd2.rs gRPC-Web 客户端 | 移除（入库由宿主 move 完成） | 同上 |
| （旧）CookieCloud 自配地址/UUID/口令 + 插件内 AES 解密 | — | 宿主新规约下插件不读 CookieCloud，登录态只来自扫码或手动粘贴 |
| QQ 扫码登录直接返回 `QR_UNAVAILABLE`（旧宿主 broker 剥离外部响应的 `Set-Cookie`，`plugins/music-rs/src/qq.rs:156`） | **QQ 扫码可用**：登录链路走宿主 session（`network.md:15` 的 per-session Cookie 记账），插件自己按 host+path 校验重定向白名单 | v3 宿主按 session 记 `Set-Cookie` |
| KV ETag 乐观锁 + 16~128 字节幂等键（store.rs PutIds） | `ctx.storage` 的 `expected_revision` CAS | v3 KV 原生版本号 |
| wasm state/action 响应的绝对路径/键名过滤（sanitize_state/display_path） | 移除：v3 storage 为插件私有 JSON，不经该过滤 | 宿主行为差异 |
| 通知 `POST /api/notifications/plugin`（callback_data 被 400 拒，重试只在正文） | `ctx.notify` 原生支持 `buttons[[{callback_data}]]` | v3 通知契约 |
| `telegram.callback` wasm event op（宿主把返回值变 inline answer） | 清单 `events:[{event:'callback'}]` + 任务；确认改为一条通知 | v3 事件模型 |
| 状态文档随 state op 下发 | 页面实时读 KV 组装（`settings`/`tasks.idx`/`task.*`/`cookies.*`/`logs`/`state`） | v3 页面有 storage/http |
| 旧队列键 `tasks` 迁移（ensure_migrated） | 不迁移：v3 与旧安装数据不通用（developer-guide §发布「无旧协议兼容或旧安装迁移」） | 安装语义 |

另：`ui/qr.js` 逐行移植自旧 `frontend/src/qr.ts`（常量表已逐行核对一致）；`lib/` 的向量测试直接复用旧 Rust 测试的预期值（`plugins/music-rs/tests/*.rs`），未从实现反推。

## 自测

```sh
node --check lib/*.js jobs/*.js ui/*.js   # 语法
cd v3/tests/music-rs && node --test *.test.js   # 199 项单测（eapi/cookie/qq/queue/pump/QR 向量/recover/TG 命令/日报）
node v3-kit/conformance/project-check.mjs v3/music-rs
node v3-kit/conformance/pack.mjs v3/music-rs dist/music-rs.dian115p
```

199 项的分布（`node --test <file>` 逐个文件跑出来的 `ℹ tests` 数）：
`music-api` 54 / `qq` 46 / `recover` 15 / `cookies` 12 / `settings-queue` 12 / `encoding` 10 /
`pump` 10 / `tg-command` 10 / `netease` 8 / `eapi` 6 / `qr` 4 / `jobs` 2 / `kv-path` 1。

注意：本机没有可用的 dian115 宿主（授权锁定），以上为离线验证；真机安装行为（两条扫码链路、取链、下载、通知投递）未验证。

## 文件

```
plugin.json          清单（schema 3，requires.api 3.9，jobs ×4，events ×2；设置做在页面里，不声明 settings[]）
lib/encoding.js      Go 编码语义（QueryEscape/Encode/ParseQuery/hash33/base36/短 id）
lib/eapi.js          网易云 eapi（明文装配；AES/MD5 由宿主 ctx.crypto 注入）+ 音质阶梯
lib/cookies.js       cookie 解析/白名单/合并/登录态（QQ 出网只带 4 个凭据字段）
lib/qq.js            QQ 纯逻辑（音质阶梯/取链参数/扫码授权链解析/重定向白名单/凭据校验 + 歌单/每日推荐/我喜欢的参数与响应解析）
lib/netease.js       网易云纯映射（搜索/歌单/详情）
lib/tasks-core.js    任务常量、命名、索引投影、回调提取
lib/settings.js      设置默认值/归一化/补丁合并
lib/queue-pages.js   整单入队分批状态机
lib/queue-store.js   KV 任务队列（CAS 去重入队/重试/对账/清理）
lib/kv.js            ctx.storage 适配（getMeta 带 revision、CAS 读改写）
lib/music-api.js     网络层（网易云/QQ 全部端点 + 两条扫码登录链路 + QQ 歌单/每日推荐/我喜欢四个 musicu 接口，页面与后台共用）
lib/pump.js          下载管线状态机（同名预检 + 下载/入库前后检查点 + recoverPump 按真实文件判定三态）
lib/task.js          task.update / task.checkpoint / task.log 吞错包装（进度与检查点失败不拖垮业务）
lib/logs.js          运行日志（滚动 40 条）
jobs/queue-pump.js   定时任务（*/5 * * * *）+ 手动快进入口 + recover（attention 收敛为 resume）
jobs/tg-callback.js  Telegram 重试回调（event=callback）
jobs/tg-command.js   Telegram 只读查询命令（/music /queue /status；回复走来源渠道，未授权回退 notify）
jobs/daily-report.js 每日下载日报（08:30；dedupe_key 按天；notify 抛错不拖垮任务）
jobs/runtime.js      ctx → deps 装配（crypto 适配、状态文档组装）
ui/page.js           插件页面（Vue 3 构建产物 ESM：搜索 / 我的歌单 / 任务 / 设置四分页 + 登录卡 + 最近动作）
ui/qr.js             QR Model 2 编码器（Nayuki MIT 移植，供网易云扫码）
（测试在 v3/tests/music-rs/，不进插件包）node:test 单测 ×199（向量来自旧 Rust 测试）
```

## 版本记录

### 1.3.0

- **直写目标目录成为首选路径**（requires.api 3.5 → 3.9）：API 3.9 的 `save_to` 直接把直链下载写进
  用户目标目录（含 CD2 挂载路径），省一次跨盘拷贝；宿主不开放该能力时回落原有「插件暂存 → 定名 → move」。
  直写成功时把宿主算好的 `size`/`sha256` 记进任务（`task.done` 可追溯，索引条目不投影这两项）。
- **同名预检**：下载前、入库 move 前、copying 残留重排前都查一次 `files.exists`，目标已有同名文件
  直接终态失败（错误写明路径），不再进「overwrite:false 撞墙 → 重试到 3 次」的循环。
- **外部写检查点与真实状态恢复**：下载/入库前后各落任务检查点；新增 `recoverPump`——先用
  `exists`/`stat` 核对目标目录与暂存目录里的真实文件再决定 complete / resume / attention；判 complete
  时把 KV 队列在途任务收敛为 done（`settleTaskDone`），下一轮 pump 不会把已落盘文件误报「目标已存在」。
  `queue-pump` 入口把 attention 收敛为 resume（周期任务无人值守，pump 本身幂等兜底）。
- **TG 只读查询命令**（jobs/tg-command.js，event=message）：`/music 队列|状态|帮助`、`/queue`、`/status`；
  回复走 `ctx.messaging.reply`（需授权 telegram.bot），未授权/失败回退 `ctx.notify`（dedupe_key =
  chat_id + message_id）。命令只读，不触发下载/删除。
- **每日下载日报**（jobs/daily-report.js，08:30）：各状态计数 + 今日完成/失败清单；dedupe_key
  `music:daily-report:<日期>` 按天稳定；notify 抛错不拖垮任务。
- 失败通知 `dedupe_key` 收敛为 `dl-fail-<任务id>`（旧键带 retry_round/attempts，每轮失败换新键导致去重永不生效）。
- 新增测试：`recover.test.js`（15 项，检查点三态与 `settleTaskDone`）、`tg-command.test.js`（10 项）、`pump` +3 项（同名预检/检查点/直写 size/sha256）；171 → 199 项全过。
