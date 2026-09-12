# music-agent

`music-agent` 是 DIAN115「音乐下载」插件的配套下载服务。插件负责界面和调度；本服务负责扫码登录、管理音乐平台 Cookie、解析用户账号可用音质、流式下载大文件，并将文件写入 CloudDrive2 的 115 挂载目录。

> 本服务不是独立的破解服务，不提供或绕过会员权益。可下载的音质完全取决于登录账号及歌曲本身拥有的版本。网易云使用账号 Cookie 调用官方客户端 EAPI；QQ、酷狗使用各自客户端协议。

## 为什么必须分离

DIAN115 的 WASM 插件不能直接写宿主文件，也不能通过 Host Call 搬运几十到几百 MB 的音频正文。把临时音乐直链交给 115 离线同样不可靠：QQ vkey、网易 CDN 链接可能受 Cookie、出口 IP、设备和有效期限制。

因此实际流程是：

```text
DIAN115 music.dl 插件
  └─ Host Broker → http://127.0.0.1:8791
       └─ music-agent 使用扫码得到的 Cookie 取官方临时链接
            └─ 同一台 NAS、同一会话流式下载
                 └─ 写入 /CloudNAS/115open/音乐/音乐下载/
                      └─ CloudDrive2 上传至 115
                           └─ DIAN115 音乐中心建树/刮削/整理
```

## 前置条件

1. DIAN115 容器使用 `network_mode: host`（现有安装默认如此）
2. NAS 已安装 Docker/Container Manager
3. CloudDrive2 已把 115 挂载到 NAS，例如：

   ```text
   /volume1/CloudNAS/115open/音乐
   ```

4. DIAN115 音乐中心的音乐源覆盖 `/音乐`，才能在后续建树时看到下载文件

## 群晖部署

```bash
git clone https://github.com/congyoubanmian/dian115-plugins.git
cd dian115-plugins/sidecars/music-agent
cp .env.example .env
```

按 NAS 实际路径编辑 `.env`：

```dotenv
CLOUDNAS_PATH=/volume1/CloudNAS
MUSIC_AGENT_DATA=./data
DOWNLOAD_PROXY=
```

启动：

```bash
docker compose up -d --build
```

验证：

```bash
curl http://127.0.0.1:8791/health
```

预期返回：

```json
{"ok":true,"logged_in":{},"tasks_active":0,"mount_ok":true}
```

- `ok: true`：服务工作正常
- `mount_ok: true`：容器能访问 CloudDrive2 音乐挂载
- 默认只监听 `127.0.0.1:8791`，局域网和互联网不能直接访问

## 安装 DIAN115 插件

在 DIAN115 插件中心添加市场仓库：

```text
https://github.com/congyoubanmian/dian115-plugins
```

刷新后安装 `music.dl`（音乐下载）。插件 Manifest 只声明直连本机 `http://127.0.0.1:8791`，由 DIAN115 Host Broker 代理调用。

## 登录

插件界面支持：

- 网易云音乐 App 扫码
- QQ App 扫码
- 微信扫码登录 QQ 音乐
- 酷狗音乐 App 扫码
- Cookie 手动粘贴（网易云关键字段是 `MUSIC_U`）

登录凭据只写到：

```text
< MUSIC_AGENT_DATA >/sessions.json
```

该目录已被 `.gitignore` 排除，不能放到 Web 站点目录，也不要分享或提交到 GitHub。

### 网易云扫码说明

网易扫码流程需要保持二维码会话的 `NMTID` Cookie；本服务已自动保存并用于轮询。扫码成功后会保存 `MUSIC_U` 等 Cookie。若网易返回 8821 风控，可使用插件里的 Cookie 登录面板，从已登录的 `music.163.com` 浏览器会话粘贴 Cookie。

## 下载与音质降级

选择最高质量时，歌曲没有该版本会自动向下尝试：

```text
网易云：超清母带 jymaster
      → 高清臻音 jyeffect
      → 沉浸环绕 sky
      → Hi-Res hires
      → 无损 lossless
      → 杜比 dolby
      → 极高 exhigh
      → 标准 standard

QQ 音乐：母带 AI00 → Atmos 5.1 Q001 → Atmos Q000
       → FLAC F000 → 320K M800 → 128K M500

酷狗：当前按 FLAC → 320K → 128K 的平台能力选择
```

下载完成的默认目录：

```text
/CloudNAS/115open/音乐/音乐下载/
```

任务状态可查看：

```bash
curl http://127.0.0.1:8791/tasks
```

## 常用管理命令

```bash
# 查看状态
docker compose ps
curl http://127.0.0.1:8791/health

# 查看日志
docker logs -f music-agent

# 更新
git pull
docker compose up -d --build

# 重启
docker compose restart

# 停止（保留 Cookie 和任务记录）
docker compose down

# 完全清除登录态（不可恢复）
docker compose down
rm -rf data/
```

## 数据与安全边界

- `sessions.json` 含平台登录凭据，权限等同于账号登录状态
- 默认仅监听 loopback；不要改成 `0.0.0.0` 后直接暴露公网
- 不要把 `data/`、`.env`、日志或二维码临时文件提交到仓库
- 插件仓库、GitHub Actions 和 `.d115p` 包中均不包含用户 Cookie
- 如果怀疑 Cookie 泄漏，应在对应音乐 App/网页退出设备并重新登录

## 当前 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 服务、挂载、登录和活跃任务状态 |
| GET | `/search?source=netease&query=...` | 搜索歌曲 |
| GET | `/qr/create?source=netease` | 生成二维码 |
| GET | `/qr/poll?source=netease&key=...` | 轮询扫码状态 |
| POST | `/session/save` | 保存手工粘贴的 Cookie |
| POST | `/download` | 创建本地下载任务 |
| GET | `/task?id=...` | 查询单个任务 |
| GET | `/tasks` | 查询最近任务 |

这些接口只供本机 DIAN115 插件使用，不应暴露给不可信客户端。
