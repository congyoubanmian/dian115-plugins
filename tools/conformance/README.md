# 插件黑盒联调工具

这里的工具只依赖公开的插件协议与 JSON Schema，不导入、不编译、也不读取 DIAN115 主项目源码。第三方作者可以在任意平台用它们在构包前后做黑盒校验。原生进程运行时已经移除，WASM（`dian115:wasm@1`）是唯一受支持的插件运行时。

## 验证范围

`project-check.mjs` 会在构包前检查 Manifest、市场条目、权限格式、三项前端 singleton 依赖、Federation 入口，以及运行时入口：WASM magic、是否由 Go 标准编译器构建、是否链接了 `encoding/json`、以及 2 MiB 体积上限。它通过 `runtime-check.mjs` 读取公开 `manifest.schema.json`，核对 runtime 协议、字段、超时、内存和并发范围。前台 `timeout_ms` 上限为 120000 毫秒，不能使用后台预算或浏览器传输上限代替。工具只使用 Node.js 标准库，分发时保留相邻脚本及 schema：

```bash
node docs/plugin-platform/conformance/project-check.mjs \
  --manifest manifest.template.json \
  --market market-entry.template.json \
  --build-root build \
  --require-build
```

`openapi-check.mjs` 会核对公开 Host API 目录与全部 OpenAPI path operation，检查每项接口都有明确成功模型、400 错误体、写操作幂等键和可解析的组件引用：

```bash
node docs/plugin-platform/conformance/openapi-check.mjs
```

运行 `node --test docs/plugin-platform/conformance/runtime-check.test.mjs` 可验证 runtime 契约回归：非 WASM 的 `runtime.kind` 必须被拒绝，错误的协议字符串必须被拒绝，180000 毫秒的前台 action 必须被拒绝，120000 毫秒前台 action 与 300000 毫秒后台 job 的组合允许通过。`project-check.mjs` 同时检查五字段数值 cron，拒绝一分钟任务及小时边界处不足五分钟的间隔；`*/5 * * * *` 可用于最短周期任务。

`verify-public-surface.mjs` 检查 Git 跟踪文件里没有主项目源码、发布产物或已经废弃的插件契约，必须在任何公开提交前运行：

```bash
node docs/plugin-platform/conformance/verify-public-surface.mjs
```

WASM 模块的真实调用语义（Host Call、配额、取消、Telegram 事件和生命周期）由宿主内部的集成测试按 [WASM runtime v1](../wasm-runtime-v1.md) 的 reactor ABI 验证，公开工具不复制这部分私有实现。

## 使用完整示例

在 `docs/plugin-platform/examples/complete-plugin/` 中：

```bash
npm ci
npm run build
npm run check
node ../../conformance/project-check.mjs --manifest manifest.template.json --market market-entry.template.json --build-root build --require-build
```

WASM 构建与 CPU 架构无关，不需要 WSL、Linux CI 或同架构容器。`npm run build` 会把 Vue UI 和 WASM runtime 写入 `build/`；`project-check.mjs` 只校验包内声明的入口与构建产物是否一致。

## UI 联调

UI 使用宿主同一套 Vue 3、Naive UI 和 `@lucide/vue` singleton。示例的 `npm run dev` 提供本地 mock bridge，可验证组件 props、主题变量、图片、浏览器存储、弹窗和错误状态；正式包作为同源可信发布者代码加载，不附加 iframe sandbox 或额外 UI CSP。宿主会提供零外边距、全宽的 `html/body/#plugin-sandbox-root` 和 `border-box` 基线，插件不要依赖预览入口的固定 body 宽度。弹窗仍受浏览器用户手势规则约束，普通浏览器请求仍受 CORS 和混合内容规则约束。所有 bridge 值必须可由 `JSON.stringify`/`JSON.parse` 完整往返。

## 通过标准

- `project-check.mjs` 退出码为 `0`，Manifest 中的每项 Host API 都通过公开目录核对；
- WASM 入口包含标准 magic，并且声明了 `dian115:wasm@1` 协议；
- `.d115p` 由示例 `scripts/package.mjs` 生成并能通过包格式、完整性和签名校验；
- UI 暴露 Manifest 中声明的 Federation module，且所有静态资源进入签名包；
- `openapi-check.mjs` 和 `verify-public-surface.mjs` 都通过；
- Host API、网络路由、Telegram 注册和文件操作都与公开文档一致。

黑盒联调通过不等于插件获得了未声明权限；最终安装仍由宿主重新校验签名、Manifest、权限、WASM ABI、UI 和运行时状态。

安装包校验与运行响应校验必须分别执行。安装成功只说明包、权限和入口符合要求；发布前还应把真实模块的 state/action/job 返回值送入宿主验收，检查状态枚举、256 KiB 业务 JSON 上限以及 state 的版本/ETag。尤其要覆盖 action 返回 `ok`、job 返回 `succeeded` 的拒绝用例，并用大数据量检查分页是否完整。只在 mock bridge 中读取 `result.state`，或只检查调用没有 error，无法发现这些协议不兼容。
