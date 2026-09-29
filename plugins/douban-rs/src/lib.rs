//! DIAN115 插件运行时(`dian115:wasm@1`)的 Rust 实现 —— 从 Go 版
//! `plugins/douban-center/runtime` 逐文件移植。
//!
//! 已完成: **WASM ABI + JSON-RPC 协议层(框架)**、**宿主存储 KV 层**,
//! 以及**并行移植的契约冻结**(模块骨架 + action/job 全量接线)。
//!
//! | Rust 模块 | Go 对照 |
//! |-----------|---------|
//! | [`abi`] | `abi.go` / `abi_stub.go`(导出、内存、导入) |
//! | [`arena`] | `abi.go:16` 的 `make([]byte, size)` 替换(可重置, 不再泄漏) |
//! | [`host`] | `wasm.go:31` `wasmHostCall` |
//! | [`protocol`] | `wasm.go:74` `wasmDispatch` + `main.go:1469` handle / `main.go:1498` invoke |
//! | [`runtime`] | `main.go:193` `runtime` + `main.go:292` loadAll / `main.go:424` persistAll / `main.go:1614` action / `main.go:2007` job |
//! | [`store`] | `wasm.go:134` 起的存储适配(GET/PUT/ETag/信封解包/三态加载) |
//! | [`model`] | `main.go:231` `persistedState` 及其嵌套结构(json tag 对齐层) |
//! | [`charts`] | `main.go:509` 榜单抓取 + `main.go:1145` refreshNow + 黑名单过滤/入队 |
//! | [`poster`] | `main.go:770` moviePoster 系列 + `main.go:1819` getPoster + `main.go:2181` sniffImage |
//! | [`cookiecloud`] | `cookiecloud.go` 全文件(CookieCloud 拉取 + AES/MD5 解密) |
//! | [`wish`] | `wish.go` 全文件(想看同步、豆瓣 cookie 解析、cookie 缓存) |
//! | [`subscribe`] | `main.go:818` TMDB 匹配 + `main.go:1333` processDue + `main.go:1720` 订阅动作 |
//! | [`clock`] | `time.Now` / `time.Sleep` / `time.Parse(RFC3339)`(wasm32 上经宿主 WASI 取时钟) |
//! | [`raw`] | Go `encoding/json` 的结构体解码语义 |
//! | [`util`] | `wasm.go:244` `trunc` / `wasm.go:128` `mustJSON` 兜底 / `main.go:2085` stringVal |
//!
//! 内存策略: 宿主用 `dian115_alloc` 取缓冲, `dian115_handle` 收尾时把 arena 游标归零
//! 并把响应放在偏移 0 —— 单次调用的峰值之外的缓冲全部回收(见 [`arena`])。
//!
//! # 并行移植的分工(契约已冻结, 详见各模块头部)
//!
//! 三路工程师各自只填**自己文件里的函数体**, 不动接线:
//!
//! - 路 1(榜单与海报): [`charts`] + [`poster`]
//! - 路 2(CookieCloud 与想看): [`cookiecloud`] + [`wish`]
//! - 路 3(TMDB 匹配与聚合订阅): [`subscribe`]
//!
//! 接线(模块声明、action/job 分发表、共享辅助)已在本阶段一次性完成并冻结:
//! `lib.rs` / `runtime.rs` / `protocol.rs` / `host.rs` / `store.rs` / `model.rs` /
//! `raw.rs` / `util.rs` / `clock.rs` / `Cargo.toml` 在并行阶段**不得修改**。
//! 跨路调用点(如 `refresh_now` → `sync_wish_list`)已按最终签名挂好, 单路自测时
//! 不要依赖其他路的函数体(那是 `todo!()`, 会 panic); 跨路联调放到三路合并之后。

// ABI 导出层只在 wasm32 上有意义(u32 指针在 64 位主机上不成立):
// 本机 `cargo test` 只编译协议层与存储层, 与 Go 只在 wasip1 构建真实 ABI、
// 本机用 abi_stub.go 一致。
#[cfg(target_arch = "wasm32")]
pub mod abi;
pub mod arena;
pub mod charts;
pub mod clock;
pub mod cookiecloud;
pub mod host;
pub mod model;
pub mod poster;
pub mod protocol;
pub mod raw;
pub mod runtime;
pub mod store;
pub mod subscribe;
pub mod util;
pub mod wish;

#[cfg(test)]
pub(crate) mod testkit;

pub use arena::Arena;
pub use protocol::{dispatch, OpError};
pub use runtime::Runtime;

/// 脱敏后的真实样本(宿主 state 文档 / 豆瓣想看接口原文), 供各阶段做解码回归。
///
/// 脱敏规则: uid 一律替换为 `123456789`; CookieCloud 口令换成 `uuid-test`/`key-test`;
/// 真实豆瓣登录 cookie 整段丢弃。仓库里不允许出现任何密钥或口令。
#[cfg(test)]
pub mod fixtures {
    /// 宿主 `state` 键原文(70KB): 榜单快照、观察队列、想看列表与账号配置。
    pub const STATE: &[u8] = include_bytes!("../tests/fixtures/state_val.json");
    /// 豆瓣 `kind=mark&type=movie` 想看接口原文(3 条, 全是电影)。
    pub const WISH_MOVIE: &[u8] = include_bytes!("../tests/fixtures/wish_movie.json");
    /// 豆瓣 `kind=mark&type=tv` 想看接口原文(4 条: 混进了 1 条 book, `year` 是 null)。
    pub const WISH_TV: &[u8] = include_bytes!("../tests/fixtures/wish_tv.json");
}
