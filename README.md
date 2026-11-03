# DIAN115 插件仓库（v3 插件平台）

DIAN115 自定义插件市场仓库：**当前只维护 v3（schema 3）插件**——宿主内 ESM 运行时 + 自打包 Vue 3 界面 + 编译 MCP 签发的 `protected-v4` 正式包。

宿主「插件中心 → 管理仓库」填下面这个地址（索引在 `main` 分支，随发版自动更新）：

```text
https://github.com/congyoubanmian/dian115-plugins
```

## 插件一览

| 插件 ID | 名称 | 干什么 | 版本 |
| --- | --- | --- | --- |
| `chase.rs` | 追剧管家 | 小时级对齐「订阅池剧集订阅」与「Emby 已有集数」：只增 PATCH `total_episodes`，产出追剧日历与每日一次的 Telegram 日报；已核实无缺口的条目 5 小时窗口内复用缓存，Emby 查询量压一个数量级；外部写操作前后存检查点，中断后按订阅池真实状态恢复，不重复 PATCH | 0.1.14 |
| `music.rs` | 音乐下载 | 网易云 / QQ 音乐扫码登录、搜索与歌单、按时下音质取链；宿主代下载（API 3.9 直写目标目录）并交 CloudDrive2 入库，任务队列落 KV，支持 Telegram 按钮重试；新增 TG 消息命令（/queue /status）、目标目录同名预检、下载 sha256 记录与每日 TG 日报 | 1.3.0 |
| `douban.rs` | 豆瓣中心 | 豆瓣榜单抓取 → 黑名单过滤 → 观察队列 → 聚合订阅；登录态用手动粘贴的浏览器 Cookie，自动追订「我的想看」；新增 TG 命令（/refresh /wish）与海报文件缓存（状态不再塞 base64，改走 downloadURL） | 1.2.0 |

三个插件都是**页面 + 后台任务**，页面自带设置面板（按宿主规范，有页面的插件不在清单里声明 `settings[]`），数据只走 `ctx.storage` / `ctx.api`，不读 CookieCloud、不向第三方上报。

## 仓库结构

```text
v3/                          v3 插件源码（每个插件：plugin.json + jobs/ + lib/ + ui/）
├── chase-rs/                 追剧管家
├── music-rs/                 音乐下载
├── douban-rs/                豆瓣中心
└── tests/<plugin>/           离线单测与夹具（在插件目录之外，不进 .dian115p 包）
v3-ui/                        三个插件的 Vue 3 界面源码、共享构建底座与构建脚本
  ├── src/<plugin>/           页面源码（Vue SFC + TS）
  ├── shared/                 主题/挂载等共享层
  ├── legacy/<plugin>/       改造前的原生 JS 页面（行为基准，构建脚本据此回滚）
  └── scripts/                构建与冒烟脚本
plugin-market/
├── v3/index.json             自托管市场索引（v3 schema 3）
└── icons/<插件id>.svg        插件图标
scripts/                      构建、审查、编译签发、发版与检查脚本
store-pr/                     商店 PR 素材（生成物，node scripts/v3-store-pr.mjs 重建）
notify-wecom-templates.json   宿主企业微信通知模板
wecom-cards/                  宿主企业微信卡片组素材
.github/workflows/            ci.yml（检查）+ release-v3.yml（检查 + 调试包 artifact）
```

> **旧的 schema 1（Rust → WASM）插件线已删除。** 宿主新规约要求新安装/更新使用 `protected-v4`
> 编译包，旧 `.d115p` 在新宿主上装不上也更新不了；那条线只剩「老用户已装插件继续兼容」的价值，
> 已不产出任何可被新宿主安装的产物，因此源码、发布工作流与 cargo CI 一并移除，历史仍可从
> git tag 找回。

## 安装与使用

- **市场源**：宿主「插件中心 → 管理仓库」填 `https://github.com/congyoubanmian/dian115-plugins`，用户主动刷新索引后选版本安装（正式包由宿主本地验签）。
- **手动安装**：从 Release 下载 `*.dian115p`，宿主「插件中心 → 从本地文件安装」。
- **本机调试包**：Release 上同时挂可读源码包（`.dian115p`），只用于本机调试，不能上架、不能覆盖正式安装。

### 豆瓣「我的想看」同步（douban.rs）

登录态只有一条来源（不读 CookieCloud）：

1. 打开豆瓣中心 → 设置 → 「登录态」→ 粘贴浏览器里的豆瓣 Cookie（整段 cookie 头，或仅 `dbcl2=xxx`）
2. 保存后点「刷新榜单」；想看同步需要 Cookie 里有 `dbcl2`

### 音乐下载（music.rs）

扫码（或粘贴 Cookie）登录 → 搜索/选歌单 → 按音质入队 → 宿主代下载并交 CloudDrive2 入库。下载目录与命名规则在插件设置里改。

## 开发

- **规范来源**：官方插件平台文档（`dian115` 仓库 `docs/plugin-platform/`）。写接口前查文档，别凭印象写 ctx 成员。
- **页面契约**：`mount(el, ctx)` 返回清理函数；数据只走 ctx；跟随宿主主题（`--app-*` 变量 + `ctx.theme`）；表单要有标签；异步请求传 `ctx.signal`。
- **后台**：`run(ctx, input)` 是入口，所有异步都要 await；没有 DOM / Node 内置模块 / `require`。
- **任务**：写 `title`（队列显示「插件名：标题」），批量任务上报 `total/done/failed`。
- **数据**：放 `ctx.storage`；账号密码放设置，不进源码/日志/报告；只申请用到的 `permissions`。
- **只申请用到的能力**：能用 HTTP 或 WebSocket 就不要申请 `network.tcp`。

### 本地门禁（与 CI 同一套）

```sh
bash scripts/v3-test.sh                 # 三个插件的离线单测（v3/tests/<plugin>）
bash scripts/v3-build.sh                # 构建 UI + 官方审查闸门 + project-check + pack + 查包
node scripts/v3-check-official.mjs      # 只跑结构检查 + 恶意特征扫描
bash scripts/v3-verify-ui-artifacts.sh  # 入库产物 == 重建产物
node scripts/v3-secret-scan.mjs         # 跟踪文件里不得有开发者凭据
```

审查闸门用的就是宿主官方 `audit.mjs`：critical/high 必须在 `scripts/v3-audit-allowlist.json` 里逐条登记误报理由，未登记直接失败——不允许「绕过闸门」。

## 发版（编译 MCP → protected-v4）

正式包由宿主**编译 MCP** 签发，CI 拿不到凭据，所以发版在本地做：

```sh
cp .env.example .env.local      # 填 DIAN115_URL / DIAN115_API_KEY / DIAN115_ACCOUNT_ID
vim .env.local                   # key 取宿主「系统设置」里的 OpenAPI Key
bash scripts/release-v3-local.sh v3-2026.11.02-5
```

流程：构建 + 审查闸门 → 可读调试包 → 逐插件 `dian115_compile_plugin` 签发正式包（`release_ready: true` 且 `package_base64` 的 SHA256 自校验通过才算数）→ 市场索引（`delivery: protected-v4`、`author` = 签名绑定的会员昵称）→ 提交 → 打 tag → 上传 Release 资产。

**商店提交**：`node scripts/v3-store-pr.mjs` 生成 `store-pr/`（索引条目 + 图标，不含包/密钥/源码），用官方 `market-check.mjs` 校验后提 PR。

## 开发者凭据与安全

- 凭据只放仓库根 `.env.local`（已 gitignore，权限 600）或 CI secret；**不要提交、不要贴进聊天**。
- **CI 不接触签名密钥**：正式包在本地签发；CI 只跑检查与可读调试包。
- `node scripts/v3-secret-scan.mjs` 是提交前的保险丝：比对 `.env.local` 里的真实值是否出现在跟踪文件里，并扫常见硬编码凭据形态。
- 仓库强制忽略：插件签名私钥（`*.pem` / `*.key`）、用户 Cookie、`data/`、`sessions.json`、`node_modules/`、`target/`、`dist/`、`v3-kit/`（宿主套件镜像）、`*.dian115p`、`v3-ui/node_modules/`。
- **例外：`v3/<plugin>/ui/page.js` 必须入库**——宿主按清单 `ui.entry` 直接加载它；`v3-ui/package-lock.json` 也必须入库（`npm ci` 可重复安装的保证）。
- 怀疑泄漏就去对应平台退出该设备并重新登录（平台 Cookie 等同登录凭据）。

## 文档

- [v3 迁移说明、界面（Vue 3）、构建与验证状态](v3/README.md)
- [v3-ui 界面源码与构建底座](v3-ui/README.md)
- [离线单测说明](v3/tests/README.md)
- [DIAN115 官方插件平台文档](https://github.com/madbrolab/dian115/tree/main/docs/plugin-platform)
