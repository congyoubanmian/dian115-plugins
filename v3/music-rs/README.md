# 音乐下载（dian115 插件 v3）

网易云 / QQ 音乐搜索、**网易云与 QQ 音乐双源扫码登录**（QQ 走官方二维码 + OAuth 授权换凭据）与手动粘贴 Cookie 回退、按音质逐级取链；单曲与整张歌单入队后由后台任务自动推进：取链接 → 下载到插件暂存目录 → 定名 → 移交宿主 move 进目标目录（CD2 挂载由宿主自动分流）→ 失败通知带「重试」按钮。

本插件是 `plugins/music-rs`（旧 schema 1，Rust WASM 0.3.19）的 **v3 迁移版**：Rust 业务逐函数移植为宿主内 ESM JavaScript（无 npm 依赖、无 Node 内置模块），WASM 基建（abi/arena/host/protocol/store 乐观锁幂等键/clock）由 v3 宿主能力取代。

## 功能

- **搜索**：网易云（`/api/cloudsearch/pc`，每页 30 条）/ QQ（`search_for_qq_cp`，每页 20 条），页面直连。
- **登录**：**网易云与 QQ 音乐两个来源的扫码都在本插件内实现**（网络层 `lib/music-api.js` + 纯逻辑 `lib/qq.js`），页面只渲染二维码与每 2 秒轮询一次；两源都保留手动粘贴 Cookie（白名单清洗 + 合并写入）与 CookieCloud 一键同步（v3 用宿主内置服务）作为回退。细节见「登录」一节。
- **取链**：网易云 eapi（AES-128-ECB + MD5，宿主 `ctx.crypto`）按 8 档音质阶梯逐级回退；QQ 按参考客户端 Lilt 的流程：先读歌曲详情拿 `media_mid`，登录态请求 `F000(flac) → M800(320k) → M500(128k)`，匿名只请求 `M500`；每档单独请求 vkey，相对 purl 用响应里的 `sip` 域名拼接（详见 `lib/qq.js` 注释）。
- **歌单**：我的歌单列表 + 分页浏览（1×v6 全量索引 + 每页 1×v3 详情切片）；整单分批入队（每批 5 页 × 100 首，`next_page` 续批游标，页面级失败不回滚已入队）。
- **下载队列**：KV 分片（`tasks.idx` + `task.<id>`），去重按 `source+song_id+quality`；定时任务（每 5 分钟）与页面手动「推进队列」走同一入口；`queued → downloading → copying → done/failed`，失败重试 ≤3 次后发通知（Telegram 按钮 `callback_data: retry:<短id>`，点击触发回调任务重新排队）。
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
   到插件 KV `cookies.qq`；`graph.qq.com` 的全局授权 Cookie 不写进 KV，随后清空宿主 session。

### 失败回退

扫码链路任何一步失败，页面都不假装成功：

- 二维码过期 / 返回的不是 PNG / 拿不到 `qrsig` → 明确报错提示刷新重试（页面可重新取码）；
- 扫码完成但没取到登录凭据 → 状态显示「扫码完成，未取得登录态」，提示改用手动粘贴；
- **手动粘贴 Cookie**（一直保留的通道）：浏览器登录后复制整行 Cookie 粘进登录卡，
  按白名单清洗后合并写入插件 KV（网易云必须有 `MUSIC_U`/`MUSIC_A`；QQ 必须有 `qqmusic_key`
  或可补齐的 `p_skey`/`skey`/`musickey`）；
- **CookieCloud 一键同步**：v3 用宿主内置服务 `ctx.cookiecloud('read')`（域：网易云 `music.163.com`、
  QQ `qq.com` 及其子域），按白名单提取后写入同一份 KV。

> 真机状态：以上两条登录链路在本机**只有离线单测覆盖**（本机没有可用的 dian115 宿主），
> 真机扫码（手机确认、OAuth 跳转、凭据落盘）未验证。

## 旧版 → v3 的架构性差异（如实说明）

| 旧版（schema 1 WASM） | v3 | 原因 |
| --- | --- | --- |
| 宿主代下载两段式：`plugin-host/files/downloads` 提交 + 轮询 job | `ctx.http.request({save_to})` 同步流式下载到插件自有 `downloads/` | v3 文件模型 |
| 暂存目录设置 `staging_dir` | 固定插件自有目录 `downloads/` | v3 插件自有文件即暂存区（developer-guide §文件与 CD2） |
| `local-files/rename` + `local-files/copy`（宿主 5.x 禁跨边界复制 → 旧版被迫做 CD2 gRPC-Web 直送） | `ctx.files.call({operation:'rename'/'move'})`，宿主按 CD2 挂载前缀自动分流并报告字节进度 | v3 宿主文件操作打通本地/CD2 |
| CD2 直送设置五项（cd2_url/token/dest_dir/local_folder/register_host）与 cd2.rs gRPC-Web 客户端 | 移除（入库由宿主 move 完成） | 同上 |
| CookieCloud 自配地址/UUID/口令 + 插件内 AES 解密（cookiecloud.rs） | `ctx.cookiecloud('read')`（宿主统一配置的本地服务） | v3 内置；115 域按宿主策略不可读写 |
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
node --test tests/*.test.js               # 131 项单测（eapi/cookie/qq/queue/pump/QR 向量）
node v3-kit/conformance/project-check.mjs v3/music-rs
node v3-kit/conformance/pack.mjs v3/music-rs dist/music-rs.dian115p
```

131 项的分布（`node --test tests/<file>` 逐个文件跑出来的 `ℹ tests` 数）：
`qq` 31 / `music-api` 28 / `cookies` 13 / `settings-queue` 12 / `encoding` 11 / `tasks-core` 9 /
`netease` 8 / `eapi` 6 / `pump` 6 / `qr` 4 / `jobs` 2 / `kv-path` 1。

注意：本机没有可用的 dian115 宿主（授权锁定），以上为离线验证；真机安装行为（两条扫码链路、取链、下载、通知投递）未验证。

## 文件

```
plugin.json          清单（schema 3，requires.api 3.5，jobs ×2，events ×1）
lib/encoding.js      Go 编码语义（QueryEscape/Encode/ParseQuery/hash33/base36/短 id）
lib/eapi.js          网易云 eapi（明文装配；AES/MD5 由宿主 ctx.crypto 注入）+ 音质阶梯
lib/cookies.js       cookie 解析/白名单/合并/登录态 + CookieCloud 提取
lib/qq.js            QQ 纯逻辑（音质阶梯/取链参数/扫码授权链解析/重定向白名单/凭据校验）
lib/netease.js       网易云纯映射（搜索/歌单/详情）
lib/tasks-core.js    任务常量、命名、索引投影、回调提取
lib/settings.js      设置默认值/归一化/补丁合并
lib/queue-pages.js   整单入队分批状态机
lib/queue-store.js   KV 任务队列（CAS 去重入队/重试/对账/清理）
lib/kv.js            ctx.storage 适配（getMeta 带 revision、CAS 读改写）
lib/music-api.js     网络层（网易云/QQ 全部端点 + 两条扫码登录链路，页面与后台共用）
lib/pump.js          下载管线状态机
lib/logs.js          运行日志（滚动 40 条）
jobs/queue-pump.js   定时任务（*/5 * * * *）+ 手动快进入口
jobs/tg-callback.js  Telegram 重试回调（event=callback）
jobs/runtime.js      ctx → deps 装配（crypto 适配、状态文档组装）
ui/page.js           插件页面（原生 JS + DOM，四分页 + 登录卡 + 最近动作）
ui/qr.js             QR Model 2 编码器（Nayuki MIT 移植，供网易云扫码）
tests/               node:test 单测 ×131（向量来自旧 Rust 测试）
```
