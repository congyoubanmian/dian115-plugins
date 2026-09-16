# 通知机器人（notify.bot）

DIAN115 WASM 插件：把消息推送到企业微信、飞书、Server酱、QQ。纯 WASM 运行时，全部网络请求经宿主 Broker 代理，不落盘任何敏感信息（只保存 webhook 配置与发送历史）。

## 功能

- **四平台 Tab**：企业微信 / 飞书 / Server酱 / QQ（Qmsg 酱），每个平台可建**多个配置**，独立启用/停用、命名、测试
- **广播发送**：发送消息时对该平台所有启用中的配置逐条推送，结果按配置汇总
- **飞书签名**：填写 Secret 后自动计算 `hmac-sha256` 签名（时间戳 + Secret）
- **代理中转**：每条配置可填代理地址（`http://ip:port`）。填写后经本机 `music-agent` sidecar 的 `/relay` 端点用代理出口发送，满足企业微信机器人**固定出口 IP** 的需求；不填则宿主直连
- **历史与日志**：发送历史（平台/配置/结果）与运行日志，可一键清空

## 平台接入方式

| 平台 | Webhook 地址 | 获取方式 |
| --- | --- | --- |
| 企业微信 | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...` | 群聊右键 → 添加群机器人 |
| 飞书 | `https://open.feishu.cn/open-apis/bot/v2/hook/...` | 群设置 → 群机器人 → Custom Bot |
| Server酱 | `https://sctapi.ftqq.com/<SendKey>.send` | [sct.ftqq.com](https://sct.ftqq.com) |
| QQ | `https://qmsg.zber.com/send/<key>` | [qmsg.zber.com](https://qmsg.zber.com) 绑定 QQ |

> QQ 的 `qmsg.zber.com` 走海外 CDN，部分网络直连不通，请在该配置里填代理地址（经 `music-agent` 中转）。

## 安装

DIAN115 插件中心 → 添加插件仓库 `https://github.com/congyoubanmian/dian115-plugins` → 安装「通知机器人」。

需要代理中转时，先部署 [`sidecars/music-agent`](../../sidecars/music-agent/README.md)（音乐下载插件用户已部署，无需重复操作）。

## 开发

```bash
cd plugins/notify-bot
npm ci
npm run build    # vue-tsc + vite + Go wasip1
npm run check    # 产物校验
npm run package  # 签名打包 releases/notify.bot-<version>.d115p
```

发版：提交后依次 `git push origin main`、`git tag notify-bot-v<version>`、`git push origin notify-bot-v<version>`，CI 自动构建签名发布并回写市场索引。

## 安全

- Webhook 地址（含 key）只保存在 DIAN115 插件存储中，不提交仓库、不打入插件包
- `/relay` 中转端点只监听 `127.0.0.1` 且只放行四个通知域名，不能被用作开放代理
