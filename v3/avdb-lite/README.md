# AVDB Lite

X1080X 板块采集 + 文章浏览 + 一键 115 磁力离线。真实站点是 `1080xin.com` / `1080xin.vip`（`x1080x.com` 只是占位跳转页）。

## 过盾与登录

同 AVDB 的路线，不靠插件里的浏览器硬过 Cloudflare：

1. 用 FlareSolverr 过 Cloudflare，`cf_clearance` 等 Cookie 与 User-Agent 回存到插件 HTTP session
2. 列表、详情全部用普通 HTTP 请求复用这套 Cookie，不逐页开浏览器
3. 下载地址需要登录才可见，而站点的登录接口**强制要 Turnstile token**（缺了就是 `turnstile_required`），
   token 只有在登录表单被填写之后才渲染，还必须由能过 Cloudflare 的真实浏览器签发——
   宿主那个共享无头浏览器（headless_shell）签不出来

所以 FlareSolverr 里挂了一个 `POST /login` 路由（模块 `x1080x_login.py`，由 `entrypoint.sh` 注入）：
在**同一个会话浏览器**里过盾 → 填表 → 点验证框 → 拿 token → 提交登录 → 回首页换「列表用途」的通行凭据，
最后把 Cookie 与 User-Agent 一起返回。插件拿到后继续用普通 HTTP 取数。

> 站点的通行凭据按用途区分：登录页签发的那套调不了列表/详情接口（`browser_pass_required`），
> 所以登录成功后必须回首页重新签发。插件侧也会在凭据失效时自动重新登录一次。

## 前置

- FlareSolverr 一个实例，默认地址 `http://127.0.0.1:8191`，带 `POST /login` 路由，可在插件设置里改：

  ```yaml
  services:
    flaresolverr:
      image: ghcr.io/flaresolverr/flaresolverr:latest
      container_name: flaresolverr
      restart: unless-stopped
      ports:
        - "127.0.0.1:8191:8191"
      entrypoint: ["/app/entrypoint.sh"]
      volumes:
        - /srv/docker/flaresolverr/x1080x_login.py:/app/x1080x_login.py:ro
        - /srv/docker/flaresolverr/entrypoint.sh:/app/entrypoint.sh:ro
      environment:
        - LOG_LEVEL=info
        - TZ=Asia/Shanghai
  ```

- FlareSolverr 和 DIAN115 必须同一个出口 IP：过盾 Cookie 绑定 IP + User-Agent，所以插件的 HTTP 请求和浏览器都固定直连。
- 插件用固定的 FlareSolverr 会话名（`avdb-lite`）：过盾 Cookie 与登录态留在同一个浏览器里，
  下一轮抓取直接复用（实测第二轮 20 秒、免挑战）。会话过期或容器重启会重新过盾。

## 使用

1. 插件中心更新到 0.4.8，并在「权限与显示」里开启「浏览器控制」（只有退回共享浏览器那条路才用到）
2. 打开侧栏「AVDB Lite」→ 设置：确认 FlareSolverr 地址、勾选板块；需要看下载地址就填 X1080X 用户名/密码
3. 保存设置 → 登录 X1080X（可选，也可以直接抓取，抓到「需登录」的条目时会自动登录一次）→ 立即抓取
4. 有磁力的卡片点「发送 115」，或在详情里逐条发送磁力/ED2K

## 已知限制

- 游客身份只能看到标题、封面和元数据；正文里的下载地址是「加入 VIP 查看內容」，未登录的条目会标「需登录/VIP」。
- 账号本身需要有查看下载地址的权限，插件不绕过站点的会员限制。
- 115 提交结果只表示 115 已接受（`accepted`），实际进度在 115/宿主离线任务里看。

## 目录

```
plugin.json
lib/site.js             # 过盾、HTTP 取数、详情解析、登录（外部登录服务 + 共享浏览器退路）
jobs/crawl-x1080x.js    # 抓取：过盾 → HTTP 列表/详情 →（需要时）登录后重取
jobs/login-x1080x.js    # 单独登录
ui/page.js              # 页面
```
