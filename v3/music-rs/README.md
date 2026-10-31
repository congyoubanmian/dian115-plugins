# 音乐下载（dian115 插件 v3）

网易云 / QQ 音乐搜索、扫码与手动粘贴登录、按音质逐级取链；单曲与整张歌单入队后由后台任务自动推进：取链接 → 下载到插件暂存目录 → 定名 → 移交宿主 move 进目标目录（CD2 挂载由宿主自动分流）→ 失败通知带「重试」按钮。

本插件是 `plugins/music-rs`（旧 schema 1，Rust WASM 0.3.19）的 **v3 迁移版**：Rust 业务逐函数移植为宿主内 ESM JavaScript（无 npm 依赖、无 Node 内置模块），WASM 基建（abi/arena/host/protocol/store 乐观锁幂等键/clock）由 v3 宿主能力取代。

## 功能

- **搜索**：网易云（`/api/cloudsearch/pc`，每页 30 条）/ QQ（`search_for_qq_cp`，每页 20 条），页面直连。
- **登录**：网易云扫码（unikey + 前端本地 QR 编码渲染，每 2 秒轮询）；QQ 扫码因宿主代理剥离外部响应 `Set-Cookie` 不可用（与旧版一致），替代路径为手动粘贴 Cookie（白名单清洗 + 合并写入）；CookieCloud 一键同步（v3 用宿主内置服务）。
- **取链**：网易云 eapi（AES-128-ECB + MD5，宿主 `ctx.crypto`）按 8 档音质阶梯逐级回退；QQ 按 `master/flac/320/128` 裁剪 7 档阶梯。
- **歌单**：我的歌单列表 + 分页浏览（1×v6 全量索引 + 每页 1×v3 详情切片）；整单分批入队（每批 5 页 × 100 首，`next_page` 续批游标，页面级失败不回滚已入队）。
- **下载队列**：KV 分片（`tasks.idx` + `task.<id>`），去重按 `source+song_id+quality`；定时任务（每 5 分钟）与页面手动「推进队列」走同一入口；`queued → downloading → copying → done/failed`，失败重试 ≤3 次后发通知（Telegram 按钮 `callback_data: retry:<短id>`，点击触发回调任务重新排队）。
- **任务运维**：重试、清空已完成、索引对账（孤儿分片挂回）。

## 旧版 → v3 的架构性差异（如实说明）

| 旧版（schema 1 WASM） | v3 | 原因 |
| --- | --- | --- |
| 宿主代下载两段式：`plugin-host/files/downloads` 提交 + 轮询 job | `ctx.http.request({save_to})` 同步流式下载到插件自有 `downloads/` | v3 文件模型 |
| 暂存目录设置 `staging_dir` | 固定插件自有目录 `downloads/` | v3 插件自有文件即暂存区（developer-guide §文件与 CD2） |
| `local-files/rename` + `local-files/copy`（宿主 5.x 禁跨边界复制 → 旧版被迫做 CD2 gRPC-Web 直送） | `ctx.files.call({operation:'rename'/'move'})`，宿主按 CD2 挂载前缀自动分流并报告字节进度 | v3 宿主文件操作打通本地/CD2 |
| CD2 直送设置五项（cd2_url/token/dest_dir/local_folder/register_host）与 cd2.rs gRPC-Web 客户端 | 移除（入库由宿主 move 完成） | 同上 |
| CookieCloud 自配地址/UUID/口令 + 插件内 AES 解密（cookiecloud.rs） | `ctx.cookiecloud('read')`（宿主统一配置的本地服务） | v3 内置；115 域按宿主策略不可读写 |
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
node --test tests/*.test.js               # 98 项单测（eapi/cookie/qq/queue/pump/QR 向量）
node v3-kit/conformance/project-check.mjs v3/music-rs
node v3-kit/conformance/pack.mjs v3/music-rs dist/music-rs.dian115p
```

注意：本机没有可用的 dian115 宿主（授权锁定），以上为离线验证；真机安装行为（扫码、取链、下载、通知投递）未验证。

## 文件

```
plugin.json          清单（schema 3，requires.api 3.5，jobs ×2，events ×1）
lib/encoding.js      Go 编码语义（QueryEscape/Encode/ParseQuery/hash33/base36/短 id）
lib/eapi.js          网易云 eapi（明文装配；AES/MD5 由宿主 ctx.crypto 注入）+ 音质阶梯
lib/cookies.js       cookie 解析/白名单/合并/登录态 + CookieCloud 提取
lib/qq.js            QQ 纯逻辑（阶梯/参数构造/响应解析/微信扫码正则）
lib/netease.js       网易云纯映射（搜索/歌单/详情）
lib/tasks-core.js    任务常量、命名、索引投影、回调提取
lib/settings.js      设置默认值/归一化/补丁合并
lib/queue-pages.js   整单入队分批状态机
lib/queue-store.js   KV 任务队列（CAS 去重入队/重试/对账/清理）
lib/kv.js            ctx.storage 适配（getMeta 带 revision、CAS 读改写）
lib/music-api.js     网络层（网易云/QQ 全部端点，页面与后台共用）
lib/pump.js          下载管线状态机
lib/logs.js          运行日志（滚动 40 条）
jobs/queue-pump.js   定时任务（*/5 * * * *）+ 手动快进入口
jobs/tg-callback.js  Telegram 重试回调（event=callback）
jobs/runtime.js      ctx → deps 装配（crypto 适配、状态文档组装）
ui/page.js           插件页面（原生 JS + DOM，四分页 + 登录卡 + 最近动作）
ui/qr.js             QR Model 2 编码器（Nayuki MIT 移植，供网易云扫码）
tests/               node:test 单测 ×98（向量来自旧 Rust 测试）
```
