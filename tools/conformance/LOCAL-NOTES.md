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

## music-dl 例外

`release-music-dl.yml` **不挂**此校验: 旧版运行时是 Go 标准编译器产物(3.4MiB, 超宿主
2MiB 预算), 必然 FAIL; 该插件已处于维护模式并被 music.rs 取代, 不再投入。
