//! DIAN115 音乐下载插件(Rust 版)运行时 —— `dian115:wasm@1` reactor 骨架。
//!
//! 从 `plugins/douban-rs` 拷贝基建模块并剥离豆瓣业务, 只保留:
//!
//! | 模块 | 作用 |
//! |------|------|
//! | [`abi`] | wasm32 导出层(`dian115_alloc` / `dian115_handle`) |
//! | [`arena`] | 可重置的 bump arena(宿主取请求/读响应的线性内存) |
//! | [`host`] | `host.call` 一次性往返(信封编解码 + 错误语义) |
//! | [`protocol`] | JSON-RPC 分发: `runtime.initialize` / `runtime.invoke` |
//! | [`runtime`] | op 分发骨架(见下) + 状态文档加载/落盘 |
//! | [`store`] | KV 存储: ETag 乐观锁 + 幂等键 + 信封解包 |
//! | [`util`] | 错误文本截断/序列化兜底/宽松取值 |
//! | [`clock`] | 经宿主 WASI 取墙钟时间与休眠 |
//! | [`raw`] | Go `encoding/json` 结构体解码语义 |
//! | [`netease`] / [`qq`] | 网易云 / QQ 音乐: 搜索、取链、扫码登录 |
//! | [`download`] | 宿主代下载两段式管线(取链 → 暂存 → 轮询 → 定名 → 复制 → 通知) |
//! | [`tasks`] | KV 任务队列(KV `tasks`)+ Telegram 回调重试 |
//!
//! # op 分发骨架
//!
//! `runtime.initialize` → `{"result":{"ready":true,"protocol":"dian115:wasm@1"}}`;
//! 业务调用 `runtime.invoke` 的 envelope.op 支持四种:
//!
//! - `state` → [`Runtime::state`]: 状态文档 + `state_version`/`etag`(支持 `if_none_match`);
//! - `action` → [`Runtime::action`]: 用户动作(搜索/取链/扫码/下载, 见表);
//! - `job` → [`Runtime::job`]: 定时任务(`queue-pump`);
//! - `event` → [`Runtime::event`]: 事件; `telegram.callback` 走
//!   [`handle_telegram_callback`], 按 `retry:<短id>` 把失败任务重新排队。
//!
//! # 业务落点(宿主代下载版)
//!
//! 搜索/取链/扫码登录在 `netease` / `qq`(网络走宿主 Broker); 下载管线在
//! [`download`](取链 → 本地暂存 → 轮询宿主 job → 定名 → 复制入库 → 失败通知),
//! 任务队列与 Telegram 回调在 [`tasks`]。协议层与存储层的形状从 douban-rs 逐字移植,
//! 由各模块的单元测试守住。

// ABI 导出层只在 wasm32 上有意义(u32 指针在 64 位主机上不成立):
// 本机 `cargo test` 只编译协议层与存储层。
#[cfg(target_arch = "wasm32")]
pub mod abi;
pub mod arena;
pub mod clock;
pub mod download;
pub mod host;
pub mod netease;
pub mod protocol;
pub mod qq;
pub mod raw;
pub mod runtime;
pub mod store;
pub mod tasks;
pub mod util;

pub use arena::Arena;
pub use protocol::{dispatch, OpError};
pub use runtime::Runtime;

/// `runtime.invoke` 支持的全部 op(与 [`protocol::dispatch`] 的分发表一致)。
pub const SUPPORTED_OPS: [&str; 4] = ["state", "action", "job", "event"];

/// Telegram 回调事件的 topic 名。
pub const TELEGRAM_CALLBACK_TOPIC: &str = "telegram.callback";

/// `telegram.callback` 事件入口。
///
/// 宿主把 TG 侧的按钮/回复回调作为 `event` op 投递进来(见 [`Runtime::event`]),
/// 这里解析回调、按 `retry:<短id>` 把失败任务重新排队(见
/// [`tasks::on_telegram_callback`])。返回 `Err` 时由 runtime 映射成 `accepted:false`,
/// 宿主可再投递。
pub fn handle_telegram_callback(
    ids: &mut store::PutIds,
    data: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    tasks::on_telegram_callback(ids, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_ops_match_dispatch_table() {
        assert_eq!(SUPPORTED_OPS, ["state", "action", "job", "event"]);
        assert_eq!(TELEGRAM_CALLBACK_TOPIC, "telegram.callback");
    }

    #[test]
    fn telegram_callback_entry_is_wired_to_tasks() {
        let mut ids = store::PutIds::new();
        // 缺 callback.data → 失败(宿主可重投)。
        let err = handle_telegram_callback(&mut ids, &serde_json::json!({"message": {}})).unwrap_err();
        assert!(err.contains("缺少 callback.data"), "实际: {err}");
        // 不是本插件的按钮 → handled:false, 不算失败。
        let value =
            handle_telegram_callback(&mut ids, &serde_json::json!({"callback": {"data": "other"}}))
                .unwrap();
        assert_eq!(value["handled"], false);
    }
}
