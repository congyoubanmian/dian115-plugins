# DIAN115 插件仓库

DIAN115 的自定义插件市场仓库：插件源码（Rust WASM 运行时 + Vue 前端）、市场索引与自动发版流水线。

插件中心添加下面的仓库地址后，宿主读取 `main` 分支的 `plugin-market/index.json`：

```text
https://github.com/congyoubanmian/dian115-plugins
```

## 插件一览

| 插件 ID | 名称 | 干什么 | 备注 |
| --- | --- | --- | --- |
| `chase.rs` | 追剧管家 | 小时级对齐「订阅池剧集订阅」与「Emby 已有集数」：只增 PATCH `total_episodes`，产出追剧日历与每日一次的 Telegram 日报；已核实无缺口的条目 5 小时窗口内复用缓存，Emby 查询量压一个数量级 | 减方向只给建议，从不写 |
| `douban.rs` | 豆瓣中心 | 豆瓣榜单抓取 → 黑名单过滤 → 观察队列 → 聚合订阅；CookieCloud 同步浏览器登录态，自动追订「我的想看」 | 前端与 `plugins/douban-center` 共享 |
| `music.rs` | 音乐下载（Rust 版） | 网易云/QQ 扫码登录、搜索与音质自选取链；宿主代理下载（本地暂存 → CloudDrive2 入库），任务队列落 KV，支持 Telegram 按钮重试 | **无 sidecar**，取代 `music.dl` |
| `music.dl` | 音乐下载（旧版） | 网易云/QQ/酷狗扫码下载，依赖 `sidecars/music-agent` | 已被 `music.rs` 取代，仅为兼容保留 |

全部插件兼容 `dian115 >=3.8.51 <6.0.0`，界面遵循 [UI Federation v1](https://github.com/madbrolab/dian115/tree/main/docs/plugin-platform)：Vue3 + naive-ui + lucide 由宿主以 singleton 提供，配色全部走宿主 `--dian-*` 主题变量（深浅色自动跟随），1280 / 960 / 390 三档响应式。

## 仓库结构

```text
plugin-market/
├── index.json                  市场索引（发版由 CI 自动回写，勿手改）
└── icons/<插件id>.svg          插件图标
plugins/
├── chase-rs/                   追剧管家：Rust 运行时 + frontend/（Vue）
├── douban-rs/                  豆瓣中心 Rust 运行时（复用 douban-center 的前端产物）
├── douban-center/              豆瓣中心前端（Vue，独立构建）
├── music-rs/                   音乐下载 Rust 版：运行时 + frontend/（复用 music-dl 的 npm 依赖构建）
└── music-dl/                   音乐下载旧版（Go + 前端 + agent 调度），维护模式
sidecars/
└── music-agent/                仅旧版 music.dl 需要：流式下载 + CD2 写入
.github/workflows/              四个 release 流水线（按 tag 触发）
```

## 使用要点

### 豆瓣「我的想看」同步（可选，douban.rs）

1. 部署本机 CookieCloud：`docker run -d --name cookiecloud --restart unless-stopped -m 128m -p 8088:8088 -v /volume1/docker/cookiecloud/data:/data/api/data easychen/cookiecloud`
2. 浏览器装 CookieCloud 扩展，服务器填 `http://<NAS内网IP>:8088`，随机生成 UUID 和密钥，「需要同步的域名」强烈建议只填 `douban.com`
3. 豆瓣中心设置里填 UUID/密钥并开启同步；也可手填豆瓣 `dbcl2` cookie 兜底
4. 每轮榜单刷新顺带同步想看列表，新条目自动进聚合订阅

### 音乐下载（music.rs）

新版无需任何 sidecar：扫码（或粘贴 Cookie / CookieCloud）登录 → 搜索/选歌单 → 按音质档位入队 → 宿主代下载到暂存目录 → 复制进 CloudDrive2 音乐目录由 CD2 入库。下载目录与命名规则在插件设置里改。

仍在用旧版 `music.dl` 的，按 [`sidecars/music-agent/README.md`](sidecars/music-agent/README.md) 部署 agent（仅监听 `127.0.0.1:8791`，Cookie 只存部署机本地），然后迁移到 `music.rs` 即可退役。

## 插件开发

- **前端本地预览**：`plugins/chase-rs/frontend` 与 `plugins/douban-center` 直接 `npm ci && npm run dev`（内置预览桥与样例状态，无宿主也能跑）；`plugins/music-rs` 用 `node build-ui.mjs`（临时软链复用 `music-dl/node_modules`，结束自动清理），构建含 `vue-tsc` 类型检查。
- **契约**：前端与宿主只通过 `props.runtimeState`（状态文档）和 `props.api.invokeAction`（动作）通信，动作后必须 `await props.api.refresh()`；状态响应里不得出现 cookie/密码/token 类字段（宿主会拒收）。
- **WASM 测试**：Rust 侧 `cargo test` 在 `rust:1-slim`（或本仓库的 `dian-rust`）容器里跑，例如
  `docker run --rm -v "$PWD/plugins/chase-rs:/src" -w /src rust:1-slim cargo test`。

## 发版

推对应前缀的 tag 即触发 GitHub Actions：前端构建 → `rust:1-slim` 编译 WASM → 用 Secret `DIAN115_PLUGIN_SIGNING_KEY` 签名打包 → 建 Release 挂 `.d115p` → 市场索引回写 `main`（只覆盖本插件条目，带 5 次重试）。

| 插件 | tag 示例 |
| --- | --- |
| `chase.rs` | `chase-v0.1.8` |
| `douban.rs` | `rs-v0.2.4` |
| `music.rs` | `music-rs-v0.3.17` |
| `music.dl` | `music-dl-v0.2.2` |

规则：**tag 里的版本必须与 manifest 一致**；索引 `sha256` 由同一轮 CI 构建的 Release 附件计算，不要手填本地包哈希；多个插件并发发版安全（回写各自条目）。

## 安全与发布边界

仓库不提交（`.gitignore` 强制）：

- 插件签名私钥 `*.pem` / `*.key`（泄漏即可伪造发布者签名包）
- 用户 Cookie、`music-agent` 的 `data/`、`sessions.json`、`tasks.json`
- `node_modules/`、`build/`、`target/`、`frontend/dist/`、`releases/`
- `*.d115p` 插件包（只作为 Release 附件分发）

平台 Cookie 等同于登录凭据：怀疑泄漏时，去对应平台退出该设备并重新登录。

## 文档

- 追剧管家（chase-rs）：暂无独立 README，源码头部注释即设计说明
- [豆瓣中心 Rust 运行时](plugins/douban-rs/README.md) / [豆瓣中心前端](plugins/douban-center/README.md)
- [音乐下载 Rust 版](plugins/music-rs/README.md) / [旧版 music.dl](plugins/music-dl/README.md)
- [music-agent 配套服务](sidecars/music-agent/README.md)（仅旧版）
- [DIAN115 官方插件平台文档](https://github.com/madbrolab/dian115/tree/main/docs/plugin-platform)
