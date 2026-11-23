# AVDB Lite

X1080X 板块采集 + 文章浏览 + 一键 115 磁力离线。真实站点是 `1080xin.com` / `1080xin.vip`（`x1080x.com` 只是占位跳转页）。

## 采集范围与权限

只采集「無碼BT」「有碼BT」两个板块，**游客身份就能拿到下载地址**（实测 `authenticated=false`
时磁力链照常返回），所以插件不需要账号密码，也不需要站点登录。

「BT綜合區」那类帖子有 6 小时限时免费窗口，过期后要站点会员权益——插件不绕过站点的会员限制，
只会如实标「需会员」。

## 为什么要配 Docker

只剩一道门：过 Cloudflare（`cf_clearance` 绑定 IP + UA）。

| 站点要求 | 插件运行时能不能做 | 原因 |
| --- | --- | --- |
| 过 Cloudflare | ❌ | 宿主共享浏览器是无头 shell，签不出放行 Cookie |

插件运行时只有宿主给的共享无头浏览器（headless_shell，软件渲染），过不了盾。
所以做法是：**把 FlareSolverr 跑在同机的 Docker 里，插件只负责解析、展示和送 115**。

Docker 那侧只做一件事：**过盾**——`POST /v1 {cmd:"request.get"}` 拿回 `cf_clearance` 等 Cookie 与 User-Agent，
插件用普通 HTTP 复用这套 Cookie 抓列表和详情。

## Docker 部署（唯一的前置）

一个 FlareSolverr 容器就够（官方原版镜像直接可用）：

```bash
mkdir -p /srv/docker/flaresolverr && cd /srv/docker/flaresolverr
```

`/srv/docker/flaresolverr/compose.yaml`：

```yaml
services:
  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    restart: unless-stopped
    ports:
      - "127.0.0.1:8191:8191"
    environment:
      - LOG_LEVEL=info
      - TZ=Asia/Shanghai
```

```bash
cd /srv/docker/flaresolverr && docker compose up -d
curl -s http://127.0.0.1:8191/health      # {"status":"ok"}
```

插件页面「设置」区的「检查环境」按钮会探容器通不通，通了就能用。

### 可选：站点登录（一般用不上）

只有想看「BT綜合區」这类帖子的 6 小时限时窗口内容时才需要登录，而站点的登录接口
强制要 Turnstile token（token 只有在**登录表单被填写之后**才渲染，还必须由过了盾的真实浏览器签发），
宿主那个共享无头浏览器签不出来。真要用的话，在容器里多挂一个 `POST /login` 路由：

```bash
cd /srv/docker/flaresolverr
curl -sLO https://raw.githubusercontent.com/congyoubanmian/dian115-plugins/main/docker/avdb-lite/x1080x_login.py
curl -sLO https://raw.githubusercontent.com/congyoubanmian/dian115-plugins/main/docker/avdb-lite/entrypoint.sh
chmod +x entrypoint.sh
```

然后在 compose 里加上：

```yaml
    entrypoint: ["/app/entrypoint.sh"]
    volumes:
      - /srv/docker/flaresolverr/x1080x_login.py:/app/x1080x_login.py:ro
      - /srv/docker/flaresolverr/entrypoint.sh:/app/entrypoint.sh:ro
```

`entrypoint.sh` 把 `/app/flaresolverr.py` 复制到可写目录并注入一行注册代码再运行（镜像里的 `/app`
是只读的，不能就地改）；**没有挂 `x1080x_login.py` 时它会原样启动 FlareSolverr**，所以游客模式
用官方原版镜像就行。

### 网络要点

- **FlareSolverr 和 DIAN115 必须同一个出口 IP**：过盾 Cookie 绑定 IP + User-Agent，插件的 HTTP 请求固定 `proxy: direct`。
  容器之间走同一个 NAT 出口即可（桥接网络和 host 网络都满足）。
- **端口只绑本机**：`127.0.0.1:8191:8191`。DIAN115 用 host 网络，能直接访问宿主回环。
- 插件用固定的 FlareSolverr 会话名 `avdb-lite`：过盾 Cookie 与登录态留在同一个浏览器里，
  下一轮抓取直接复用（实测第二轮 20 秒、免挑战）。容器重启会重新过盾。

### 自检

插件页面「设置」区有「检查环境」按钮，会探两件事：容器通不通、`/login` 路由在不在，
直接告诉你是不是 Docker 那边没配好（省得对着「提交失败 400」猜）。

## 使用

1. 插件中心更新到最新版本
2. 打开侧栏「AVDB Lite」→ 设置：确认 FlareSolverr 地址（默认 `http://127.0.0.1:8191`）、
   点「检查环境」确认容器就绪、勾板块（两个都勾），需要的话填 115 保存目录与账号
3. 保存设置 → 立即抓取（后台任务，关掉网页照跑，进度在宿主任务队列里看）
4. 有磁力的卡片点「发送 115」，或在详情里逐条发送磁力/ED2K

## 已知限制

- 只采集「無碼BT」「有碼BT」两个板块——实测磁力链都在这两个板块，其它板块的帖子本身不带下载地址。
- 「BT綜合區」那类帖子受 6 小时限时窗口限制，过期后要站点会员权益，插件只标「需会员」。
- 115 提交结果只表示 115 已接受（`accepted`），实际进度在 115/宿主离线任务里看。

## 目录

```
plugin.json
lib/site.js             # 过盾、HTTP 取数、详情解析
jobs/crawl-x1080x.js    # 抓取：过盾 → HTTP 列表/详情
ui/page.js              # 页面
```

仓库里另有一份可选的 Docker 配件（不随插件包发布，游客模式用不到）：
`docker/avdb-lite/{x1080x_login.py,entrypoint.sh}`——给 FlareSolverr 挂 `POST /login` 路由用。

