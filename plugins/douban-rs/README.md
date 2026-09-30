# 豆瓣中心（Rust 版） · DIAN115 插件

周期抓取豆瓣榜单，经黑名单过滤与观察队列后自动创建 DIAN115 聚合订阅，并记录订阅历史与统计。
Go 版运行时的重写：模块 4.35MB → 1.55MB，宿主常驻内存 240MB → 115MB（wazero 解释器税随模块体积线性下降）。

- 运行时：WASM（`dian115:wasm@1`），Rust `wasm32-unknown-unknown` + 手写 ABI（`src/abi.rs`）
- 界面：复用 [`plugins/douban-center/`](../douban-center/) 的 Vue 3 Federation 页面
- 功能：榜单抓取 / 黑名单 / 观察队列 / 聚合订阅（TMDB 回退匹配）/ 订阅过滤器 /
  已删除不重订（墓碑）/ CookieCloud 同步「我的想看」/ Telegram 通知

## 构建

依赖：Node 20+、Rust（`rust:1-slim` 即可，含 `wasm32-unknown-unknown` target）。

```bash
cargo test
cargo build --release --target wasm32-unknown-unknown
```

前端产物在 `plugins/douban-center` 里 `npm run build:ui` 生成，打包脚本
（`build.mjs` / `package.mjs` / `build-market-index.mjs`）把两者合成 `.d115p`。

## 发布

推 `rs-v<版本>` 标签触发 `.github/workflows/release-douban-rs.yml`：
编译 WASM → 复用 douban-center 前端 → 签名打包 → 建 Release → 索引回写 main。

## 与宿主交互时的注意点

这些是在真实宿主上踩过的坑（Go 版时代攒下、Rust 版同样适用），改代码时留意：

- **存储写入需要乐观锁**：`PUT /api/plugin-runtime/storage/:key` 对已存在的键要求
  带 `If-Match: <ETag>`，否则返回 412。实现见 `src/store.rs`。
- **前台动作约 10 秒会被强杀**：宿主用 wazero 解释器执行 WASM，单次动作里串行外部
  请求的成本很高。刷新动作按成本排序、限制单次请求数并做预算保护；订阅批量这类
  慢操作全部挪到后台 wish-sync 任务里做。
- **状态存单键**：全部状态序列化到 `state` 一个键，避免每次落盘多次往返。
- **state 响应禁止回显凭据**：宿主递归拒绝任何含 `cookie`、`password`、`_token`、
  `_secret` 等关键字的 key；凭据只存内部结构，对 UI 输出 `cc_*` 视图字段
  （`cc_url`/`cc_uuid` 回填 + `cc_key_set` 布尔），保存时空值=保持原值。
- **豆瓣页面模板会变**：解析用字节定位 + 宽松正则，逐条海报补全只在后台任务里做。
