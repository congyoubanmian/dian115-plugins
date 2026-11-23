# AVDB Lite

X1080X 板块采集 + 文章浏览 + 一键 115 磁力离线。真实站点是 `1080xin.com` / `1080xin.vip`（`x1080x.com` 只是占位跳转页）。

## 过盾方式

同 AVDB 的路线，不靠插件里的浏览器硬过 Cloudflare：

1. 用 FlareSolverr 过 Cloudflare（宿主 `ctx.http.render`），`cf_clearance` 等 Cookie 与 User-Agent 回存到插件 HTTP session
2. 列表、详情全部用普通 HTTP 请求复用这套 Cookie，不逐页开浏览器
3. 下载地址需要登录才可见：填了账号时，抓取会用宿主共享浏览器（注入过盾 Cookie）走站点真实登录表单，再重取受登录限制条目的详情

## 前置

- FlareSolverr 一个实例，默认地址 `http://127.0.0.1:8191`，可在插件设置里改：

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

- FlareSolverr 和 DIAN115 必须同一个出口 IP：过盾 Cookie 绑定 IP + User-Agent，所以插件的 HTTP 请求和共享浏览器都固定直连。

## 使用

1. 插件中心更新到 0.4.0，并在「权限与显示」里开启「浏览器控制」（只有登录会用到）
2. 打开侧栏「AVDB Lite」→ 设置：确认 FlareSolverr 地址、勾选板块；需要看下载地址就填 X1080X 用户名/密码
3. 保存设置 → 立即抓取
4. 有磁力的卡片点「发送 115」，或在详情里逐条发送磁力/ED2K

## 已知限制

- 游客身份只能看到标题、封面和元数据；正文里的下载地址是「加入 VIP 查看內容」，未登录的条目会标「需登录/VIP」。
- 登录这一步依赖共享浏览器（无头 Chromium）在带上过盾 Cookie 后不再被 Cloudflare 拦截，这一点需要实际运行验证；登录失败时任务日志会写明页面标题和内容。
- 账号本身需要有查看下载地址的权限，插件不绕过站点的会员限制。
- 115 提交结果只表示 115 已接受（`accepted`），实际进度在 115/宿主离线任务里看。

## 目录

```
plugin.json
lib/site.js             # 过盾、HTTP 取数、详情解析、浏览器登录桥接
jobs/crawl-x1080x.js    # 抓取：过盾 → HTTP 列表/详情 →（需要时）浏览器登录后重取
jobs/login-x1080x.js    # 单独登录
ui/page.js              # 页面
```
