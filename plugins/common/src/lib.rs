//! DIAN115 插件运行时公共底座(`dian115:wasm@1`)。
//!
//! 这里只放三个 Rust 插件(music-rs / chase-rs / douban-rs)真正共享的代码:
//! 线性内存 arena、宿主 `host.call` 通道、JSON-RPC 分发骨架、存储 KV 适配、
//! Go `encoding/json` 语义对齐层、时间与文本工具, 以及可移植的 ABI 内核。
//!
//! 各插件的 `src/<模块>.rs` 保留为薄封装(`pub use common::<模块>::*;`),
//! 插件特有的分叉放在 wrapper 里:
//!
//! - `store`: 每个插件定义自己的 [`store::IdPrefix`] marker + `PutIds` 类型别名;
//! - `protocol`: 每个插件为自身 `Runtime` 实现 [`protocol::ProtocolRuntime`];
//! - `abi`: wasm32 的 `Global`/导出函数留在插件 shell, 可移植内核在这里。
//!
//! `ext` feature 只由 chase-rs 启用, 提供该插件的业务 HTTP 层、宽松取数/脱敏
//! 与秒级日历函数; 关闭时这些代码不进入依赖图。
//!
//! # 测试钩子
//!
//! 本 crate 作为依赖编译时 `cfg(test)` 为 false, 所以所有测试替身/时钟钩子都按
//! `#[cfg(not(target_arch = "wasm32"))]` 编译并声明为 `pub`, 供插件的 `#[cfg(test)]`
//! 用例使用(详见 [`clock`] / [`host`])。

pub mod abi;
pub mod arena;
pub mod clock;
pub mod host;
pub mod protocol;
pub mod raw;
pub mod store;
pub mod util;
