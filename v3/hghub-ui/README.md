# hghub-ui — 黄果短剧 DIAN115 插件前端（构建源）

本目录是 **v3 插件** `v3/huanggu-drama` 的 React 构建源。构建产物输出到 `../huanggu-drama/ui/`。
插件目录只发布三样东西（`plugin.json` / `icon.svg` / `ui/page.js`），**源码不进插件包**。

## 架构

- 上游交互与桌面客户端一致：全部请求收敛成 `POST {base}/api/edge/request` 信封
  （`Referer` + `Authorization: Bearer`），封面是 AES-128-CBC 密文，HLS 分片/key 带防盗链。
- 插件模式（`__PLUGIN_MODE__`，构建期恒为 true）没有 Tauri / 本地协议，改为：
  - `ctx.http.request`（宿主代发，无浏览器 CORS、可带 Referer/UA）发信封、拉封面/分片/key；
  - 封面：`WebCrypto` AES-128-CBC 页面内解密 → blob URL（LRU 240）；
  - HLS：hls.js 自定义 loader（`src/plugin/media.ts`）→ 分片/key 走宿主 HTTP；
  - 持久层：收藏/历史/搜索历史/设置/token 落 `ctx.storage`（加密 KV）；
  - 主题：初始取宿主 `ctx.theme`，宿主切换时跟随，设置里手动改过后不再跟随。

## 目录

```text
hghub-ui/
├── src/
│   ├── plugin-entry.tsx    宿主入口：导出 mount(el, ctx)（Vite lib 构建）
│   ├── main.tsx            dev 预览入口（无宿主，走 dev proxy）
│   ├── plugin/
│   │   ├── ctx.ts          DIAN115 ctx 桥：信封调用/线路/会话/解析工具
│   │   ├── media.ts        封面解密 + hls.js loader + 直连媒体 blob + 缓存
│   │   ├── storage.ts      KV 持久化（防抖保存）
│   │   └── preview.ts      dev 预览 mock ctx（localStorage + dev proxy）
│   ├── useCover.ts         useResolvedCover hook + 正文图片错误捕获
│   ├── env.ts              运行环境常量（避免 api/html 循环依赖）
│   └── …其余为上游 HGhub web 端源码（仅去掉 Tauri 桌面壳）
├── vite.config.ts          lib 构建 + dev proxy 中间件（/__hg/edge、/__hg/raw）
├── scripts/build-ui.mjs    构建自检
└── index.html              dev 预览页
```

## 常用命令

```sh
npm install
npm run dev        # 浏览器预览（上游经 dev proxy 转发，绕 CORS）
npm run build      # tsc 类型检查 + vite lib 构建 → ../huanggu-drama/ui/page.js
```

## 打包与安装（仓库级）

```sh
bash scripts/v3-build.sh            # 构建全部界面 → 官方审查(白名单已登记 huanggu-drama 误报) → project-check → pack
                                   # 产物 dist/hghub.dian115p，末尾打印 sha256
```

或只看本插件：`node scripts/v3-check-official.mjs huanggu-drama` + `node v3-kit/conformance/pack.mjs v3/huanggu-drama dist/huanggu-drama.dian115p`。
市场索引条目由 `v3-market-index.json`（同步到 `plugin-market/v3/index.json`）维护，发版见仓库 `scripts/release-v3.sh` / `release-v3-local.sh`（正式 protected-v4 包走编译 MCP）。

## 版本

- 插件版本只维护 `v3/huanggu-drama/plugin.json` 的 `version`；构建前把 `v3/hghub-ui/package.json`
  的 `version` 同步过去（`__APP_VERSION__` 由构建注入，设置页展示用）。
- 更新检查对比本仓库 `hghub-v*` 前缀 tag（`api.ts` 的 `checkUpdate`）。

## 已知边界（需在真实宿主验证）

- 本机无法直连上游站点，dev 预览只能验证 UI 渲染；真实接口链路（信封/封面解密/HLS 防盗链）
  需在能访问 huangguoai.com 的宿主上实测。
- 播放页全屏：宿主内容区若为 iframe(srcdoc)，`requestFullscreen` 可能被宿主限制，
  届时退化为页内沉浸播放（Feed 自带 `fs` 全屏态）。
- hls.js 已禁用 worker（srcdoc 内 blob worker 不可靠），分片拉取走宿主 HTTP 桥，
  单分片响应上限 64 MiB，对 720P 短剧足够。