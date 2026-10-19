# 音乐下载（Rust 版） · DIAN115 插件

聚合网易云/QQ 音乐的搜索、登录与下载，SVIP 音质自选；下载产物先落到宿主本地暂存，
配置 CD2 令牌后由 CD2（CloudDrive2）直送 115 音乐目录自动入库。
登录：网易云走扫码（unikey 在响应体里）；QQ 因宿主 broker 剥离 `Set-Cookie`、扫码所需的
`qrsig` 拿不到，改为**手动粘贴浏览器 Cookie**（`qq-cookie-paste` action / `settings-update` 的
`qq_cookie` 字段）；两边也都可以用 CookieCloud 同步登录态（`cookiecloud-sync`）。
旧 Go 版（已从仓库移除）的 Rust 重写版本。基建（reactor ABI、协议层、KV 存储层）从
`plugins/douban-rs` 移植并剥离豆瓣业务。

- 当前清单版本：`0.3.19`
- 运行时：WASM（`dian115:wasm@1`），Rust `wasm32-unknown-unknown` + 手写 ABI（`src/abi.rs`）
- 目标内存：`memory_mb = 128`（Go 版 256MB → Rust 版 128MB，降内存是本次目标）

## 与旧 Go 版的关键架构差异

1. **无 sidecar**：旧版依赖本机 sidecar 服务（`http://127.0.0.1:8791`）做搜索/取链/下载；
   Rust 版把网易云 eapi 加密（AES-ECB + md5 + hex，依赖已备于 `Cargo.toml`）与 QQ 协议全部搬进
   wasm 插件内直连，manifest 不再声明 sidecar 进程，只声明音乐站点域名与两个本机服务
   （CookieCloud `127.0.0.1:8088`、CD2 `127.0.0.1:19798`）。
2. **宿主 broker 代下载 + 入库两段式**：wasm 拿到 CDN 直链后不自己搬字节。
   - 第一段：`POST /api/plugin-host/files/downloads` 让宿主把直链下载到本地暂存
     （返回 `job_ref`，插件用 `GET /api/plugin-host/jobs/:job_ref` 轮询）。
   - 暂存完成先 `POST /api/local-files/rename` 把 `<短id>.part` 定名为
     `"{singers} - {name}.{ext}"`，再走第二段入库：
     - **CD2 直送**（0.3.19，设置里填了 `cd2_token` 时）：暂存目录在 CD2 里注册成
       「本地文件夹」（`APIAddLocalFolder`，幂等），由 `CopyFile` 让 CD2 自己把文件上传到
       云盘目录（服务器侧异步任务），插件轮询 `GetCopyTasks` 直到完成。CD2 gRPC-Web 默认
       `http://127.0.0.1:19798`，全部经 `host.call` 转发；宿主 5.x 的「本地/CD2 严格隔离」
       只拦宿主自己的复制 API，这条路径不经过它。
     - **宿主直连复制**（未填令牌时的回退）：`POST /api/local-files/copy`；宿主 5.x 起该
       跨边界复制会被隔离策略 400 拒绝（见 `src/cd2.rs` 模块头）。
   - 无论走哪条路径，最终都由 CD2 负责刮削/入库。
3. **KV 任务队列（分片）**：`tasks.idx` 存紧凑索引（UI state 的唯一数据源，state 响应截取
   最近 200 条），`task.<id>` 存单条完整记录（来源/音质/`job_ref`/暂存路径/重试次数等，
   不存直链——取链当轮直接交给下载暂存阶段，重试会重新取链）。
   pump 一次只读在途任务的完整记录，
   每轮读取的索引随历史任务总数增长（一条约 200~300 字节，上千条仍在几十 KB 量级；
   0.3.12 起，为 128MB 上限把整条队列从单键拆开）；旧单键 `tasks`
   会在 pump 开头自动迁移。写入已存在的键时带 ETag `If-Match` 乐观锁，且每次写入使用
   唯一的 `Idempotency-Key`。
   `queue-pump` 定时任务（`*/5 * * * *`，`allow_overlap: false`）每 5 分钟推进一次状态机；
   每轮最多新开 1 首，`max_active` 默认 2、上限 16。插件内另有队列操作互斥（0.3.15）：
   cron 与手动 `pump`/入队撞车时，后来者直接返回 `skipped`，不排队等待。
4. **TG 回调重试**：Telegram 侧的下载回调由宿主投递成 `event` op（topic = `telegram.callback`），
   插件按 `retry:<短id>` 把失败任务重新排队（其他前缀返回 `handled:false`）；处理失败返回
   `accepted:false`，由宿主按重试策略再投递。0.3.19 另加 `task-adopt`，把宿主被杀后只留下
   `task.<id>` 分片、索引里缺失的孤儿任务重新挂回索引。

## 模块地图

| 模块 | 职责 | 状态 |
|------|------|------|
| `src/abi.rs` | wasm32 导出层（`dian115_alloc` / `dian115_handle`） | 移植自 douban-rs，可用 |
| `src/arena.rs` | 可重置 bump arena（宿主请求/响应的线性内存） | 移植自 douban-rs，可用 |
| `src/host.rs` | `host.call` 一次性往返（信封编解码 + 错误语义） | 移植自 douban-rs，可用 |
| `src/protocol.rs` | JSON-RPC 分发：`runtime.initialize` / `runtime.invoke`（op=state/action/job/event） | 移植自 douban-rs，可用 |
| `src/store.rs` | KV 存储：ETag 乐观锁（412 重读重试）+ 幂等键 + 信封解包 | 移植自 douban-rs，可用 |
| `src/runtime.rs` | op 分发（state/action/job/event）+ 状态文档加载/落盘；action 表覆盖搜索/取链/歌单/登录/入队/设置/重试/清理/手动 pump，`queue-pump` job 与 Telegram 事件在此接线 | 已实现 |
| `src/netease.rs` | 网易云：搜索 / eapi 取链（8 档逐级回退）/ 扫码登录 / 歌单与歌曲详情 | 已实现 |
| `src/qq.rs` | QQ 音乐：搜索 / 音质阶梯取链（7 档）/ 手动粘贴 Cookie；扫码因宿主剥离 `Set-Cookie` 不可用（返回 `QR_UNAVAILABLE`） | 已实现 |
| `src/download.rs` | 下载编排：取链 → 宿主暂存 → 轮询 job → 定名 → CD2 直送（回退宿主复制）→ 失败通知；单曲入队与整单入队 | 已实现 |
| `src/tasks.rs` | KV 任务队列（`tasks.idx` + `task.<id>`，含旧 `tasks` 迁移）+ `queuePump` + Telegram 回调重试/索引对账 | 已实现 |
| `src/cd2.rs` | CloudDrive2 gRPC-Web 直送：`APIAddLocalFolder` / `CopyFile` / `GetCopyTasks`（0.3.19） | 已实现 |
| `src/cookiecloud.rs` | CookieCloud 同步登录（0.3.4）：拉取 → 解密 → 按域过滤合并网易云/QQ 登录态 | 已实现 |
| `src/util.rs` / `src/clock.rs` / `src/raw.rs` | 截断兜底 / WASI 墙钟与休眠 / Go JSON 解码语义 | 移植自 douban-rs，可用 |
| `frontend/` | Vue 3 + naive-ui 的 Federation 界面（`frontend/dist/assets/remoteEntry.js`） | 已实现，由 `build-ui.mjs` 构建 |
| `tests/` | 离线集成测试：网易云协议向量、QQ 解析器、歌单映射、CookieCloud 解密 | 已实现，`cargo test` 执行 |

源码各模块头部注释保留了逐函数的 Go/sidecar 对照与已知偏差说明，改协议前先读对应模块头。

## 构建

依赖：Node 20+、Docker（本机 docker 需要 sudo，脚本已默认带；免 sudo 环境设 `DIAN115_SUDO=0`）。

```bash
npm ci                      # 安装本插件依赖（package-lock.json 已入库）
node build-ui.mjs --check   # vue-tsc --noEmit 类型检查 + vite 构建 frontend/dist/assets
node build.mjs              # dian-rust:wasm32 容器里 cargo build → 打包签名
node build.mjs --skip-wasm  # 只用现有 target/.../plugin.wasm 重新打包
```

`build.mjs` 默认用 `dian-rust:wasm32` 镜像；可用 `DIAN115_RUST_BUILD_IMAGE=rust:1-slim` 切到
干净镜像（脚本会自动补装 `wasm32-unknown-unknown` target）。打包还需要
`frontend/dist/assets`（由 `build-ui.mjs` 产出）与 `frontend/icon.svg`（已就位）。签名私钥默认读
插件目录下的 `developer-ed25519-private.pem`（不进 git，也可用 `DIAN115_PLUGIN_SIGNING_KEY`
指向别的私钥）。

## 测试

测试在容器里跑（本机不装 Rust 工具链）；`abi` 仅在 wasm32 编译，`cargo test` 走本机目标即可：

```bash
sudo docker run --rm -v "$PWD":/src -w /src rust:1-slim cargo test

# 或使用本仓库已备好工具链的镜像
sudo docker run --rm -v "$PWD":/src -w /src dian-rust:wasm32 cargo test
```

覆盖各模块内的单元测试（宿主替身、KV 乐观锁、pump 内存上界等）以及 `tests/` 下的离线集成测试；
无需联网或真实宿主。

## 与宿主交互时的注意点（沿用 douban-rs 踩过的坑）

- **存储写入需要乐观锁**：`PUT /api/plugin-runtime/storage/:key` 对已存在的键要求
  `If-Match: <ETag>`（否则 412），且每次写入必须带全新幂等键（16~128 可打印 ASCII）。
  实现见 `src/store.rs`。
- **状态分键存放**：`state` 只存日志/状态/revision；设置存 `settings`；任务队列存
  `tasks.idx` + `task.<id>`。`state` 文档超过 4MiB 放弃落盘。
- **加载失败禁止落盘**：宿主重启风暴期间存储会瞬时 404/不可读，三态判定
  （loaded/fresh/unavailable）没确认之前绝不写，防止默认值覆盖用户数据。
- **state 响应禁止回显凭据**：宿主递归拒绝键名含 `cookie`/`token` 子串的整个响应；
  网易云 `MUSIC_U`、QQ `qqmusic_key` 等会话只存 KV，绝不进 state 响应。设置视图里
  CookieCloud 只给 `cc_key_ready`、CD2 令牌只给 `cd2_auth_ready` 布尔，不回显值。
- **前台动作约 60 秒会被强杀**（manifest `timeout_ms = 60000`）：下载进度轮询全部放在
  `queue-pump` 后台任务里，前台 action 只做入队与查询。
- **宿主 5.x 的跨边界复制限制**：本地目录 → CD2/AURA 挂载目录的 `/api/local-files/copy`
  会被 400 拒绝；生产环境应配置 CD2 API 令牌走 0.3.19 的直送路径。
- **`Set-Cookie` 被宿主 broker 剥离**：QQ 扫码拿不到 `qrsig`（因此改为手动粘贴 Cookie）；
  网易云的 unikey 在响应体里，扫码不受影响。
