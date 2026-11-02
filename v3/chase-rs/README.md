# 追剧管家（chase.rs）· dian115 v3 迁移版

自 `plugins/chase-rs`（schema 1，Rust WASM）迁移到 v3 可信扩展形态。业务语义与旧实现
逐条对应；结构性差异见下文[迁移差异](#迁移差异)。

## 自测

```bash
# 全部纯逻辑用例（判定层 / 解析器 / 日报 / 设置 / 状态文档）
cd v3/tests/chase-rs && node --test *.test.mjs

# 语法检查全部 JS
find v3/chase-rs -name '*.js' -not -path '*/node_modules/*' -exec node --check {} +

# 官方黑盒检查 + 打包（包必须在源码目录外）
node v3-kit/conformance/project-check.mjs v3/chase-rs
node v3-kit/conformance/pack.mjs v3/chase-rs dist/chase-rs-0.1.12.dian115p
```

`package.json` 只声明 `{"type":"module"}`：宿主 v3 直接 import ESM，本地
`node --check` / `node --test` 也按此把 `.js` 解析成 ESM。不含任何 npm 依赖。

## 布局

```
plugin.json          v3 清单（schema_version 3，requires.api 3.5）
icon.svg             复制自旧插件
lib/                 纯逻辑（无 IO，node --test 直接覆盖）
  loose.js           防御式 JSON：多候选字段名 / 松散取数 / UTF-8 截断 / 凭据键脱敏（raw.rs）
  clock.js           RFC3339 / 本地日 / 本地小时 / 日期归一（clock.rs）
  settings.js        扁平清单设置 ⇄ 运行时嵌套形状 + clamp（model.rs Settings）
  state.js           状态文档：默认值 / 上限裁剪 / 256KB 逐级降级 / TMDB 目标簿（model.rs）
  intents.js         订阅池解析 + PATCH body/幂等键（intents.rs）
  emby.js            实例解析 / 覆盖解析（区间契约）/ 参数矩阵（emby.rs）
  aircal.js          追剧日历解析 + 窗口（aircal.rs）
  align.js           判定层：只增 + 幅度上限 + 四类互斥跳过文案（align.rs）
  notify.js          日报文案 / 发送判定 / 宿主结论落账（notify.rs）
jobs/
  runtime.js         共享编排（storage 三态 + CAS 落盘 + 两条对齐路径 + refresh/probe-dump）
  align.js           整点对齐（default_schedule "0 * * * *"）+ recover
  align-now.js       立即对齐（queue:false，页面触发）+ recover
  refresh.js         只读刷新（queue:false）+ recover
  probe-dump.js      探测诊断（queue:false）+ recover
ui/page.js           原生 JS + DOM 重写的页面（mount(el, ctx)）
（测试在 v3/tests/chase-rs/，不进插件包）
```

## action/job 的映射

| 旧形态 | v3 形态 |
| --- | --- |
| job `align`（cron `0 * * * *`） | job `align`，`default_schedule: "0 * * * *"`，`timeout_seconds: 600`，任务队列可见 |
| action `refresh` | job `refresh`（`queue:false`），页面 `ctx.tasks.run` 触发 |
| action `align-now` | job `align-now`（`queue:false`），页面 `ctx.tasks.run` 触发 |
| action `settings-update` | 页面直接 `ctx.settings.get()/set()`（宿主 KV `settings` 键），白名单合并/夹取逻辑在 `lib/settings.js`，页面与后台共用 |
| action `probe-dump` | job `probe-dump`（`queue:false`） |

旧运行时没有事件订阅，v3 清单相应不声明 `events[]`（不虚构功能）。
`recover` 对四个任务统一语义：检查点 `completed` ⇒ complete，否则 resume
（补订只增、日报按 dedupe_key 去重、状态文档 CAS 落盘，重跑幂等）。

## 迁移差异（如实声明）

1. **align-now / refresh 由"只写内存"改为落盘。** 旧 WASM 运行时常驻内存，
   align-now 不落盘是为了守住 `1 + max_patch + 3` 的 host.call 预算，页面随后用
   `state` op 读内存里的结果。v3 每个任务都是独立加载的一次性运行，无常驻内存，
   不落盘页面就永远看不到结果 —— 因此这两条路径在结束时把状态文档写回插件 KV
   （存储读写是插件自有路由，不再有旧版 host.call 预算问题）。
2. **settings 迁到 ctx.settings。** 旧版把 settings 嵌在状态文档里白名单合并；
   v3 的设置由宿主保存在插件 KV 的 `settings` 键。按任务要求，清单 `settings[]`
   覆盖原 UI 的全部 12 个用户配置项（布尔/数值，默认值与 model.rs 一致）；
   页面内设置抽屉照旧存在，读写走 `ctx.settings.get()/set()`（与宿主卡片上的
   设置表单是同一份数据）。探测形状指纹（`settings.probe.*`）是运行时内部状态
   而非用户配置，保留在状态文档的 `probe` 键里。
3. **PATCH 幂等键头不再携带。** 旧 WASM host.call 支持 `Idempotency-Key` 头；
   v3 的 `ctx.api` 不暴露自定义头。补订本身"只增"（判定 + 发送层双保险），且
   v3 任务队列按 business_key 去重，同一抬升不会被重复提交两次。幂等键的生成
   逻辑保留在 `lib/intents.js`（`patchIdempotencyKey`）并测试覆盖，仅不再上线。
4. **日报通道去 `POST /api/notifications/plugin` 改 `ctx.notify`。** 宿主返回的
   `accepted/deduplicated/suppressed/suppression_reason` 与旧端点同语义，
   `dedupe_key: "chase-daily-<本地日期>"` 原样保留；落账逻辑（只有
   accepted/deduplicated 记 `last_sent_date`）不变。
5. **storage 三态映射。** 旧的"404 两次确认全新安装"对应 v3 的
   `GET /storage/{key}` 404 ⇒ fresh；其他读取失败重试 3 次后 ⇒ unavailable
   （绝不落盘，默认值不得覆盖用户配置）。ETag 乐观锁对应 KV 的
   `expected_revision` CAS（冲突重读版本同字节重放一次，同旧 put）。

## 端点

全部经 `ctx.api` 调宿主公开业务接口（v3 宿主接口速查均在列）：

- `GET /api/subscribe/pool/intents`（media_type=tv，≤4 页 × 500）
- `PATCH /api/subscribe/pool/intents/{id}/episodes`（只增 PATCH total_episodes）
- `GET /api/plugin-host/emby/instances`
- `GET /api/plugin-host/emby/episodes`（参数矩阵 V1→V2→V3→V5，指纹命中即停）
- `GET /api/subscribe/air-calendar`
- `GET /api/tmdb/tv/{id}?raw_episode_counts=true`（只取该季集数，绝不用整剧集数顶替）

## 验证口径

本机没有可用的 dian115 宿主（授权被锁）：已做的是 `node --check` 全部 JS、
`node --test` 跑纯逻辑用例、`project-check.mjs` 与 `pack.mjs`。真机安装、
整点任务与通知投递**未验证**，需要装进真实宿主后确认。
