# 豆瓣中心 · 共享前端

`douban.rs` 插件的 Vue 3 Module Federation 页面。原 Go 运行时（`runtime/`、`go.mod`、
`manifest.template.json`）已移除，运行时统一由 [`plugins/douban-rs/`](../douban-rs/) 的
Rust 实现承担；本目录只保留前端源码与构建配置，发布时由
`.github/workflows/release-douban-rs.yml` 复用（`npm run build:ui`）。

- 界面：Vue 3 Module Federation 页面，复用宿主的 Vue / Naive UI / lucide 单例
- 主题：颜色/间距/圆角全部走 `--dian-*` 主题变量，亮暗主题与窄屏折叠自动适配
- 交互：只走 `props.api` 的 getState / invokeAction / refresh 桥

## 本地开发

依赖：Node 18+。

```bash
npm install
npm run dev        # 独立预览（模拟宿主主题与桥）
npm run build:ui   # vue-tsc 类型检查 + vite 构建 Federation 产物
```

插件功能与发布流程见 [`plugins/douban-rs/`](../douban-rs/)。
