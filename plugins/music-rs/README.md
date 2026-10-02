# 音乐下载（Rust 版） · DIAN115 插件

聚合网易云/QQ 音乐的搜索、登录与下载，SVIP 音质自选，下载完成后经 CD2 写入 115 音乐目录自动入库。
登录：网易云走扫码（unikey 在响应体里）；QQ 因宿主 broker 剥离 `Set-Cookie`、扫码所需的
`qrsig` 拿不到，改为**手动粘贴浏览器 Cookie**（`qq-cookie-paste` action / `settings-update` 的
`qq_cookie` 字段）。
Go 版 `plugins/music-dl` 的 Rust 重写骨架 —— 本阶段只交付**能编译的骨架**：业务函数全部是
空桩（`Err("not implemented")`，没有 `todo!()`/`unimplemented!()`），基建（reactor ABI、协议层、
KV 存储层）从 `plugins/douban-rs` 逐字移植并剥离豆瓣业务。

- 运行时：WASM（`dian115:wasm@1`），Rust `wasm32-unknown-unknown` + 手写 ABI（`src/abi.rs`）
- 目标内存：`memory_mb = 128`（Go 版 256MB → Rust 版 128MB，降内存是本次目标）

## 与 Go 版（music-dl）的关键架构差异

1. **无 sidecar**：Go 版依赖本机 `music-agent` 服务（`http://127.0.0.1:8791`）做搜索/取链/下载；
   Rust 版把网易云 eapi 加密（AES-ECB + md5 + hex，依赖已备于 `Cargo.toml`）与 QQ 协议全部搬进
   wasm 插件内直连，manifest 只声明音乐站点域名，不再有任何独立 agent 进程。
2. **宿主代下载两段式**：wasm 拿到 CDN 直链后不自己搬字节 ——
   第一段 `POST /api/plugin-host/files/downloads` 让宿主把直链下载到本地暂存（返回 `job_ref`，
   插件用 `GET /api/plugin-host/jobs/:job_ref` 轮询）；第二段 `POST /api/local-files/copy`
   把暂存文件复制进 CD2 挂载的音乐目录，由 CD2 负责刮削/入库。
3. **KV 任务队列**：下载任务（task id/来源/音质/直链/job_ref/重试次数）全部落
   `PUT /api/plugin-runtime/storage/state` 一个键（ETag `If-Match` 乐观锁 + 每次写入唯一的
   `Idempotency-Key`），`queue-pump` 定时任务（`*/5 * * * *`，禁止重叠）每 5 分钟推进一次队列状态机。
4. **TG 回调重试**：Telegram 侧的下载回调由宿主投递成 `event` op（topic = `telegram.callback`），
   插件据此更新任务状态或重试提交；处理失败返回 `accepted:false`，由宿主按重试策略再投递。

## 模块地图

| 模块 | 职责 | 状态 |
|------|------|------|
| `src/abi.rs` | wasm32 导出层（`dian115_alloc` / `dian115_handle`） | 移植自 douban-rs，可用 |
| `src/arena.rs` | 可重置 bump arena（宿主请求/响应的线性内存） | 移植自 douban-rs，可用 |
| `src/host.rs` | `host.call` 一次性往返（信封编解码 + 错误语义） | 移植自 douban-rs，可用 |
| `src/protocol.rs` | JSON-RPC 分发：`runtime.initialize` / `runtime.invoke`（op=state/action/job/event） | 移植自 douban-rs，可用 |
| `src/store.rs` | KV 存储：ETag 乐观锁（412 重读重试）+ 幂等键 + 信封解包 | 移植自 douban-rs，可用 |
| `src/runtime.rs` | op 分发骨架 + 状态文档（含 KV 任务队列）加载/落盘 | 骨架（接线已就位） |
| `src/netease.rs` | 网易云：搜索 / eapi 取链 / 扫码登录（`SongUrl{url,ext,level,size}`） | 空桩 |
| `src/qq.rs` | QQ 音乐：搜索 / 音质阶梯取链 / 手动粘贴 Cookie（扫码受宿主限制不可用） | 空桩 |
| `src/download.rs` | 下载编排：解析直链 → 宿主代下载两段式 | 空桩 |
| `src/tasks.rs` | KV 任务队列推进（`queuePump`）+ Telegram 回调 | 空桩 |
| `src/util.rs` / `src/clock.rs` / `src/raw.rs` | 截断兜底 / WASI 墙钟与休眠 / Go JSON 解码语义 | 移植自 douban-rs，可用 |
| `docs-ref/` | 宿主 openapi（openapi64.yaml）与新 host.call 协议说明（new-hostcall.md），供实现阶段参考 | 参考材料 |

## 构建

依赖：Node 20+、Docker（本机 docker 需要 sudo，脚本已默认带；免 sudo 环境设 `DIAN115_SUDO=0`）。

```bash
node build.mjs              # dian-rust:wasm32 容器里 cargo build → 打包签名
node build.mjs --skip-wasm  # 只用现有 target/.../plugin.wasm 重新打包
```

在容器里跑测试（本机不装 Rust 工具链）：

```bash
sudo docker run --rm -v "$PWD":/src -w /src dian-rust:wasm32 sh -c 'cargo test'
```

打包还需要 `frontend/dist/assets`（由本插件 `frontend/` 构建产出，骨架期尚未提供）与
`frontend/icon.svg`（已就位）。签名私钥默认读插件目录下的 `developer-ed25519-private.pem`
（从 `plugins/music-dl` 复制而来，与 Go 版同一发布身份；不进 git，也可用
`DIAN115_PLUGIN_SIGNING_KEY` 指向别的私钥）。

## 与宿主交互时的注意点（沿用 douban-rs 踩过的坑）

- **存储写入需要乐观锁**：`PUT /api/plugin-runtime/storage/:key` 对已存在的键要求
  `If-Match: <ETag>`（否则 412），且每次写入必须带全新幂等键（16~128 可打印 ASCII）。
  实现见 `src/store.rs`。
- **状态存单键**：任务队列 + 设置 + 日志全部序列化到 `state` 一个键，单键超过 4MiB 放弃落盘。
- **加载失败禁止落盘**：宿主重启风暴期间存储会瞬时 404/不可读，三态判定
  （loaded/fresh/unavailable）没确认之前绝不写，防止默认值覆盖用户数据。
- **state 响应禁止回显凭据**：宿主递归拒绝含 `cookie`/`_token`/`_secret` 类 key；
  网易云 `MUSIC_U`、QQ `qqmusic_key` 等会话只存 KV，绝不进 state 响应。
- **前台动作约 10 秒会被强杀**：下载进度轮询全部放在 `queue-pump` 后台任务里，
  前台 action 只做入队与查询。
