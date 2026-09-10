# 豆瓣中心 · DIAN115 插件

周期抓取豆瓣榜单，经黑名单过滤与观察队列后自动创建 DIAN115 聚合订阅，并记录订阅历史与统计。

- 运行时：WASM（`dian115:wasm@1`，Go `wasip1` reactor），兼容无 seccomp 的内核（如群晖 DSM 4.4）
- 界面：Vue 3 Module Federation 页面，复用宿主的 Vue / Naive UI / lucide 单例

## 构建

依赖：Node 18+、Go 1.22+（构建 WASM 运行时）。

```bash
npm install
npm run build      # 构建前端 + WASM 运行时
npm run package    # 生成已签名的 releases/douban.center-<version>.d115p
```

- `npm run build:ui` 只构建前端 Federation 产物
- `npm run build:wasm` 只构建 `build/runtime/plugin.wasm`
- `npm run check` 校验产物与 manifest 基本一致性

打包需要发布者私钥 `developer-ed25519-private.pem`（首次可用
`npm run package -- --generate-key` 生成开发用密钥）。**该私钥不入库**。

## 安装

在 DIAN115 的插件中心本地导入 `releases/*.d115p`。

## 发布到插件市场

DIAN115 的自定义插件仓库会读取主分支的 `plugin-market/index.json`
（也可直接填 HTTPS 索引地址）。流程：

1. `npm run package` 生成 `releases/douban.center-<version>.d115p`
2. 在 GitHub 建 Release（标签建议 `v<version>`），把 `.d115p` 作为**附件**上传
   （不要把包提交进仓库；市场条目指向 Release 下载地址即可）
3. 生成市场索引：

   ```bash
   npm run market -- --repo=https://github.com/<owner>/<repo>
   ```

   会写入 `plugin-market/index.json`，其中 `package_url` 指向 Release 附件，
   `sha256`/`runtime`/`permissions` 直接取自签名包，保证与清单一致。
4. 提交并推送 `plugin-market/index.json`
5. 在 DIAN115 插件中心「添加插件仓库」填 `https://github.com/<owner>/<repo>`

## 目录

```
src/              前端页面（Federation 远程组件）
runtime/          Go WASM 运行时（ABI、业务逻辑、Host API 调用）
scripts/          构建与打包脚本
manifest.template.json   插件清单模板（打包时写入 key_id）
```

## 与宿主交互时的注意点

这些是在真实宿主上踩过的坑，改代码时留意：

- **存储写入需要乐观锁**：`PUT /api/plugin-runtime/storage/:key` 对已存在的键要求
  带 `If-Match: <ETag>`，否则返回 412。实现见 `runtime/wasm.go` 的 `wasmStoragePut`。
- **前台动作约 10 秒会被强杀**：宿主用 wazero 解释器执行 WASM，单次动作里串行外部
  请求的成本很高。刷新动作因此按成本排序、限制单次请求数，并有 6.5 秒预算保护
  （见 `runtime/main.go` 的 `refreshNow`）。
- **状态存单键**：全部状态序列化到 `state` 一个键，避免每次落盘多次往返。
- **豆瓣页面模板会变**：解析用字节定位 + 宽松正则，且在后台任务里才做逐条海报补全。
