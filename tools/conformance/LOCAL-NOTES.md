# 本地使用说明(vendored)

`tools/conformance/` 下的脚本与 `tools/` 下的 `manifest.schema.json` / `market-index.schema.json` / `openapi-v1.yaml`
均原样取自官方仓库 madbrolab/dian115 的 `docs/plugin-platform/`
(main @ 3d237581, 2026-10-12), 不做任何修改; 官方更新时可整目录重新 vendor。

## 在本仓库的用法

三个 Rust 插件的 release workflow(chase-rs / douban-rs / music-rs)在签名打包前运行:

```bash
node tools/conformance/project-check.mjs \
  --manifest plugins/chase-rs/manifest.template.json \
  --market /tmp/market-entry.json \
  --build-root /tmp/conf-build --require-build
```

- `--market` 用临时文件: 模板 `market-entry.template.json` 的 version 字段不随发版维护,
  CI 按 `package.mjs` 的同款规则用 manifest 版本覆盖后再校验;
- `--build-root` 临时拼出包内布局(`runtime/plugin.wasm` + `frontend/dist/assets/remoteEntry.js`)。

本地已验证(2026-10-14): chase.rs@0.1.8 / douban.rs@0.2.4 / music.rs@0.3.17 全部 PASS,
Rust 产物不会触发脚本里的 Go 标准编译器检查(它只认 `go:buildid` + `runtime.gc` 双标记)。

## runtime 契约回归测试

`runtime-check.test.mjs` 同样原样取自官方 `docs/plugin-platform/conformance/`
(未做修改), 覆盖 `runtime-check.mjs` 的运行时字段校验与 job 调度最小间隔:

```bash
node --test tools/conformance/runtime-check.test.mjs
```

测试通过相对路径 `./runtime-check.mjs` 和 `../manifest.schema.json` 引用同目录脚本
与 `tools/manifest.schema.json`, 因此必须在仓库内原地运行, 不要单独拷贝测试文件。
CI 中由独立的 `runtime-contract` job 执行一次(不随 3 个插件的 matrix 重复)。
