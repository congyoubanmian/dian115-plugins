# 辅种助手（reseed.puppy）

DIAN115 v3 插件（版本 **0.6.0**）。按 `pieces` 指纹跨站比对 PT 站点，可视化展示每个种子对应的 BT 软件与可辅种站点，支持自定义添加站点、多下载器管理、路径映射校验、单条/批量定向辅种。

## 核心能力

- **种子与辅种矩阵**：按 `pieces` 指纹聚合资源，一屏查看每个种子的大小、文件数、数据完整性、所属 BT 软件（qBittorrent / Transmission 名称、进度、保存路径）、已做种来源站点、匹配到的辅种站点及状态（可辅种 / 已做种 / 已推送 / 已存在 / 失败），支持卡片/表格视图切换、多维筛选、单条一键辅种与勾选批量辅种。
- **自定义站点管理**：内置 26 个常见 PT 站点预设，支持自由新增任意自定义站点、选择方言（自动识别 / NexusPHP `/api/pieces-hash` / NexusAPI `/nexusapi/pieces-hash` / FluxTorrent `/api/v1/crossseed/lookup` / 完全自定义）、自定义下载模板与 Tracker 域名别名、从宿主导入 PT 站点，并支持单站「测试接口」。
- **多 BT 下载器与路径映射**：支持同时添加任意多个 qBittorrent / Transmission 实例，每个实例独立管理地址、凭据、标签、暂停/跳过校验选项及「下载器路径 → DIAN115 宿主可读路径」映射，并支持一键「测试连接」与种子目录可读性探测。
- **严谨的安全与完整性保障**：
  - 纯 `Uint8Array` bencode 解析（零 Node `Buffer` 依赖，原生兼容 DIAN115 v3 后台运行时）。
  - 优先按路径映射后的真实数据目录逐文件核对大小；未配本地映射的远端下载器自动按下载器 100% 进度判定。
  - 查询响应拦截 HTTP 200 HTML 错页；下载 `.torrent` 后校验 bencode 合法性与 `pieces` 指纹一致性，防止误把网页或错误种子喂给下载器。
  - 缓存粒度为 `pieces:siteId:downloaderId`，支持同一份资源同时辅种到多个站点。

## v0.6.0 主要修复（相对 v0.5.0）

1. **修复 `lib/bencode.js` 运行时崩溃**：移除 Node `Buffer.isBuffer` 与 `Uint8Array.toString('latin1')` 误用，重写为纯 `Uint8Array` + `TextDecoder` 实现，实测无 `Buffer` 环境下 1441/1441 真实种子 100% 解析通过。
2. **修复 `jobs/reseed.js` 数据完整性目录与 `savePath` 错位**：不再用 `.torrent` 文件所在目录（`dirOf(torrentPath)`）充当媒体数据目录，改为先批量拉取下载器全量种子，经 `pathMaps` 映射到宿主目录核验，推送时始终使用下载器自身的 `savePath`。
3. **修复 `announceHost` 缺失与 `site.siteUrl.host` 错判**：完整解析 `announce` 与 `announce-list`，结合站点主域与 `trackerDomains` 精准区分同站已做种与跨站可辅种。
4. **修复聚合丢失多站同种信息**：按 `pieces` 指纹合并全部本地拷贝，保留所有已做种站点与多下载器关联。
5. **修复 FluxTorrent 下载缺少 `Authorization: Token` 头**：补齐 FluxTorrent 下载请求鉴权头。
6. **修复 `lib/downloaders/qbittorrent.js` 与 `transmission.js`**：统一登录与请求的独立 `session`、内网直连 `proxy:'direct'`、大小写不敏感解析 `Set-Cookie`、qB 5.x 同时传递 `stopped` 与 `paused`、TR 空地址校验与 UTF-8 安全 Basic Auth。
7. **全面重构前端 UI**：对齐 DIAN115 v3 插件设计体系（明暗主题自适应、Glassmorphic Hero 页头、Bento 指标瓦片、多维筛选矩阵、右侧滑出配置抽屉、实时任务进度轮询）。

## 关于审计报告

`audit.mjs` 检查结果：`critical 0 / high 2 / medium 1`，所有外链域名均已声明。2 个 high 均为 `lib/downloaders/qbittorrent.js` 调用用户自填 qBittorrent 的 `/api/v2/auth/login` WebUI 登录接口，属预期行为；凭据仅存在插件加密 KV，只发往用户自行填写的下载器地址。
