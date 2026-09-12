# 音乐下载 · DIAN115 插件

DIAN115 的多平台音乐搜索与下载界面，支持网易云、QQ 音乐和酷狗。插件本体是 `dian115:wasm@1`，**必须搭配仓库中的 [`sidecars/music-agent`](../../sidecars/music-agent/README.md) 使用**。

## 工作方式

- 插件：扫码/搜索/任务 UI、配置、调用调度
- `music-agent`：管理 Cookie、解析账号可用音质、流式下载
- CloudDrive2：将下载完成的文件同步到 115
- DIAN115 音乐中心：建树、刮削、整理和播放

```text
插件 → Host Broker → 127.0.0.1:8791 music-agent
                              ↓
             /CloudNAS/115open/音乐/音乐下载
                              ↓
                CloudDrive2 → 115 → 音乐中心
```

## 安装顺序

### 1. 先部署 music-agent

按照 [`sidecars/music-agent/README.md`](../../sidecars/music-agent/README.md) 操作：

```bash
cd sidecars/music-agent
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:8791/health
```

必须看到 `ok: true` 和 `mount_ok: true`。

### 2. 再安装插件

在 DIAN115 添加插件仓库：

```text
https://github.com/congyoubanmian/dian115-plugins
```

刷新后安装「音乐下载」。安装页会显示它需要访问本机 `127.0.0.1:8791`。

### 3. 登录平台

打开插件后选择平台并扫码：

- 网易云：网易云音乐 App 扫码
- QQ：QQ App 或微信扫码
- 酷狗：酷狗音乐 App 扫码

扫码受平台风控影响时，可在插件 Cookie 面板粘贴浏览器登录 Cookie。网易云关键字段为 `MUSIC_U`。

### 4. 搜索和下载

搜索歌曲，选择结果并提交下载。最高音质不可用时会按平台阶梯自动降级。任务完成后文件默认进入：

```text
115open/音乐/音乐下载/
```

## 故障排查

| 现象 | 排查 |
| --- | --- |
| `music-agent 不可达` | `docker ps`、`curl http://127.0.0.1:8791/health` |
| 二维码不显示 | 检查插件版本、agent 日志、`/qr/create` |
| 扫码无反应/8821 | 看 `docker logs -f music-agent`；网易风控时改用 Cookie 登录 |
| 搜索有结果但下载失败 | 查看插件任务列表和 `curl http://127.0.0.1:8791/tasks` |
| 下载完成但音乐中心看不到 | 确认文件在 `/CloudNAS/115open/音乐/音乐下载/`；音乐源覆盖 `/音乐`；重新建树或打开实时监控 |
| `runtime_unavailable` | 查看 DIAN115 `plugin_runtime_deliveries`/`plugin_logs`；避免在 WASM 动作内传输大文件 |

## 开发

```bash
npm ci
npm run build
npm run package
```

运行时只传递小型 JSON，音乐正文永远由 `music-agent` 流式下载。不要把平台 Cookie 放入源码、Manifest、`.d115p` 或市场索引。
