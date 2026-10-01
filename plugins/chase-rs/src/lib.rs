//! 追剧管家(`chase.rs`)—— DIAN115 插件, 实现 `dian115:wasm@1`。
//!
//! 订阅池的 `total_episodes_known` × Emby 已有集数的小时级**只增**对齐器:
//! 后台每小时读一遍 `pool/intents(tv)` 与 Emby 覆盖, 对可解析的条目 PATCH
//! `total_episodes`; 同时产出追剧日历与当天一次的 TG 日报。减方向只出建议, 从不写。
//!
//! # 模块地图
//!
//! | 文件 | 职责 | 对照 |
//! |------|------|------|
//! | [`arena`] | 可复位线性内存 arena(一次调用一块) | douban-rs `arena.rs` |
//! | [`abi`] | `dian115_alloc` / `dian115_handle` 导出 + 可移植内核 | douban-rs `abi.rs` |
//! | [`host`] | `host.call` 一次往返(请求编码 / 响应解析 / 本机替身) | douban-rs `host.rs` |
//! | [`store`] | 宿主存储 KV: 信封解包、ETag、If-Match 重试、`state` 单键 | douban-rs `store.rs` |
//! | [`protocol`] | JSON-RPC 分发(`initialize`/`state`/`action`/`job`/`shutdown`) | douban-rs `runtime.rs` 壳 |
//! | [`clock`] | WASI 墙钟 + 休眠 + 日历换算(本地日/小时) | douban-rs `clock.rs` |
//! | [`raw`] | Go `encoding/json` 三态语义 + 松散取值 + 脱敏/截断 | douban-rs `raw.rs` |
//! | [`model`] | 状态文档模型(逐键对应设计规格 `stateShape`) | — |
//! | [`runtime`] | 4 个 action + 小时 job 的编排与落地 | — |
//! | [`intents`] | 订阅池 `pool/intents` 的取数/解析/PATCH 组包 | — |
//! | [`emby`] | Emby 实例解析/选择 + `/emby/episodes` 覆盖探测 | — |
//! | [`aircal`] | 追剧日历 `/subscribe/air-calendar` 的解析 | — |
//! | [`align`] | 判定: 只增 + 幅度上限 + 减方向建议 | — |
//! | [`notify`] | TG 日报文本 + `notifications/plugin` 投递与去重 | — |
//! | [`testkit`] | 本机 `cargo test` 的宿主替身(native only) | douban-rs `testkit.rs` |
//!
//! # 构建产物
//!
//! `cargo build --release --target wasm32-unknown-unknown` 产出
//! `target/wasm32-unknown-unknown/release/plugin.wasm` —— `[lib] name = "plugin"`
//! 就是为了对齐宿主装载路径 `runtime/plugin.wasm`。
//!
//! # 防御式解析纪律(全仓一致)
//!
//! 任何外部结构都走: **信封解包 → 多候选字段名 → 松散类型**(数字或数字串都收);
//! 解析失败**绝不默认为零继续**, 而是把 ≤2048 字节原文写进 `state.debug` 并跳过该条
//! (该条零写入)。见 [`raw`] 与各业务模块的 `parse_*`。

pub mod abi;
pub mod aircal;
pub mod align;
pub mod arena;
pub mod clock;
pub mod emby;
pub mod host;
pub mod intents;
pub mod model;
pub mod notify;
pub mod protocol;
pub mod raw;
pub mod runtime;
pub mod store;

#[cfg(not(target_arch = "wasm32"))]
pub mod testkit;

pub use protocol::{dispatch, rpc_error, CODE_INTERNAL, CODE_INVALID_PARAMS, CODE_METHOD_NOT_FOUND};
pub use runtime::{OpError, Runtime};

/// 宿主 ABI 协议标识(`dian115:wasm@1`), 与 `runtime.initialize` 的响应一致。
pub const PROTOCOL: &str = "dian115:wasm@1";
