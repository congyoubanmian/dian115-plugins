# DIAN115 插件仓库

这是 DIAN115 的自定义插件市场仓库，包含插件源码、市场索引，以及无法放入 WASM 插件的大文件处理 sidecar。

插件中心添加本仓库地址后，宿主会读取 `main` 分支的 `plugin-market/index.json`：

```text
https://github.com/congyoubanmian/dian115-plugins
```

## 仓库结构

```text
plugin-market/
├── index.json                       DIAN115 市场索引
└── icons/<插件id>.svg               插件图标
plugins/
├── douban-center/                   豆瓣中心 WASM 插件
├── music-dl/                        音乐下载 WASM 插件（UI + 调度）
└── notify-bot/                      通知机器人 WASM 插件（多平台 webhook）
sidecars/
└── music-agent/                     音乐下载配套服务（流式下载 + CD2 写入 + 通知代理中转）
```

## 收录内容

| 插件 ID | 名称 | 说明 | 额外组件 |
| --- | --- | --- | --- |
| `douban.center` | 豆瓣中心 | 豆瓣榜单、观察队列与聚合订阅 | 无 |
| `music.dl` | 音乐下载 | 网易云/QQ/酷狗扫码、搜索和下载 | **必须部署 `sidecars/music-agent`** |
| `notify.bot` | 通知机器人 | 企业微信/飞书/Server酱/QQ 多配置 webhook 推送 | 可选：`music-agent` 已部署时代理中转可用 |

## 音乐下载的部署顺序

1. 按 [`sidecars/music-agent/README.md`](sidecars/music-agent/README.md) 部署 `music-agent`
2. 验证 `curl http://127.0.0.1:8791/health`
3. 在 DIAN115 插件中心安装 `music.dl`
4. 扫码或粘贴 Cookie 登录，搜索并下载
5. 文件由 agent 写入 CloudDrive2 音乐挂载，再由 115 音乐中心建树/整理

`music-agent` 默认仅监听 `127.0.0.1:8791`，Cookie 只存于部署机本地的 `data/sessions.json`，不会打入插件包或提交到 GitHub。

## 通知机器人

`notify.bot` 是纯 WASM 插件，无需 sidecar 即可使用：

- 四个平台 Tab（企业微信 / 飞书 / Server酱 / QQ-Qmsg），每个平台可建多个配置，分别启用/停用
- 飞书自定义机器人支持签名 Secret（插件内计算 HMAC-SHA256）
- 每条配置可填代理地址：填写后请求经 `music-agent` 的 `/relay` 中转（仅放行通知域名），用代理出口发送，满足企业微信机器人固定出口 IP 的需求；不填则由宿主直连
- 支持向单个平台全部启用配置广播消息、单配置测试、发送历史与运行日志

若部署了 `music-agent`（音乐下载已部署则无需额外操作），代理中转自动可用。QQ 使用的 `qmsg.zber.com` 走海外 CDN，直连不通的网络请在该配置里填代理地址。

## 插件开发与发版

每个插件源码位于 `plugins/<目录>/`。以音乐下载为例：

```bash
cd plugins/music-dl
npm ci
npm run build
npm run package
```

GitHub Actions 按标签自动构建、签名、创建 Release 并回写市场索引：

```bash
# 豆瓣中心
git tag v0.2.9
git push origin v0.2.9

# 音乐下载
git tag music-dl-v0.1.8
git push origin music-dl-v0.1.8

# 通知机器人
git tag notify-bot-v0.1.0
git push origin notify-bot-v0.1.0
```

发布前必须保证标签与插件 Manifest 版本一致。索引中的 `sha256` 必须由同一轮 CI 构建出的 Release 附件计算，不能混用本地包哈希。

## 安全与发布边界

仓库不提交：

- 插件签名私钥 `*.pem` / `*.key`
- `music-agent` 的 `data/`、`sessions.json`、`tasks.json`
- 用户 Cookie、二维码临时状态和下载文件
- `node_modules/`、`build/`、`releases/`

平台 Cookie 等同于登录凭据。若怀疑泄漏，应在相应音乐平台退出设备并重新登录。

## 文档

- [豆瓣中心](plugins/douban-center/README.md)
- [音乐下载插件](plugins/music-dl/README.md)
- [通知机器人插件](plugins/notify-bot/README.md)
- [music-agent 配套服务](sidecars/music-agent/README.md)
- [DIAN115 官方插件平台](https://github.com/madbrolab/dian115/tree/main/docs/plugin-platform)
