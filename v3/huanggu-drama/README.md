# huanggu.drama — 黄果短剧（v3 插件）

黄果短剧浏览与播放：首页发现、搜索分类、榜单吃瓜、详情选集、评论收藏与观看记录。

- 纯 UI 插件（无后台 job）：页面 `ui/page.js` 导出 `mount(el, ctx)`，宿主直接 import ESM 挂载。
- 线路（数据源）：固定官方线路 + 国内备用线路（发布页 `rlhjeyuvw.cc` 三条）+ 用户自定义线路。
  自定义线路接受纯 HTTPS origin，可添加/检测/切换/删除，只存插件 KV；切换站点后登录凭据需重新登录。
- 上游交互与桌面客户端（HGhub）一致：全部请求收敛成 `POST {base}/api/edge/request` 信封
  （`Referer` + `Authorization: Bearer`），封面是 AES-128-CBC 密文，HLS 分片/key 带防盗链。
- 无 Tauri / 本地协议，改为：
  - `ctx.http.request`（宿主代发，无浏览器 CORS、可带 Referer/UA）发信封、拉封面/分片/key；
  - 封面：`WebCrypto` AES-128-CBC 页面内解密 → blob URL（LRU 240）；
  - HLS：hls.js 自定义 loader（`v3/hghub-ui/src/plugin/media.ts`）；
  - 持久层：收藏/历史/搜索历史/设置/token 落 `ctx.storage`（加密 KV）；
  - 主题：初始取宿主 `ctx.theme`，宿主切换时跟随，设置里手动改过后不再跟随。

## 构建

```sh
cd v3/hghub-ui
npm ci
npm run build        # → ../hghub/ui/page.js
```

仓库级一键构建（含官方审查闸门 + 打包 + sha256）：

```sh
bash scripts/v3-build.sh
```

## 验证边界

- 本机无法稳定直连上游站点，真实接口链路（信封/封面解密/HLS 防盗链）需在可访问
  huangguoai.com 的宿主上实测（与桌面客户端同机制的移植，风险点见 `v3/hghub-ui/README.md`）。
- 播放全屏：宿主内容区若为 iframe(srcdoc)，`requestFullscreen` 可能被宿主限制，
  已退化为页内沉浸播放（Feed 自带 `fs` 全屏态）。
- hls.js 已禁用 worker（srcdoc 内 blob worker 不可靠），分片走宿主 HTTP 桥。

界面源码、设计与实现说明见 [`v3/hghub-ui/README.md`](../hghub-ui/README.md)。