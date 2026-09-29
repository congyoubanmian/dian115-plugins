//! dian115:wasm@1 ABI 导出层(对照 Go `abi.go` + `abi_stub.go`)。
//!
//! 导出面(与 Go 完全一致):
//! - `dian115_alloc(size: u32) -> u32`        —— 从 arena 分配, 返回线性内存地址
//! - `dian115_handle(ptr: u32, len: u32) -> u64` —— 高 32 位响应地址 | 低 32 位响应长度
//! 导入面: `dian115` 模块的 `host_call` / `host_read`(见 [`crate::host`])。
//!
//! 本文件只在 wasm32 上编译(见 `lib.rs` 的 `cfg`): u32 指针在 64 位主机上没有意义,
//! 协议层逻辑全部在 [`crate::protocol`] 里用原生 target 测 —— 与 Go 只在 wasip1 构建
//! 真实 ABI、本机用 `abi_stub.go` 的做法一致。
//!
//! 懒加载钩子: Go `wasm.go:67` 的 `ensureGuest`(第一次业务调用时通过 host.call 拉取
//! 状态文档)在 [`crate::protocol`] 的分发路径里 —— initialize 之后、解析业务参数之前,
//! 与 Go 的位置一致(握手期间禁止 host.call 重入, 见 `initialize_never_calls_host`)。

use core::cell::UnsafeCell;

use crate::arena::Arena;
use crate::protocol;
use crate::runtime::Runtime;

/// 请求字节上限: 宿主帧上限 16MiB(Go `main.go:22` 的 `frameSize`), 超过即视为非法请求。
/// 用它挡住"长度字段被写坏"导致的越界读。
const MAX_REQUEST_BYTES: usize = 16 << 20;

/// 单线程(wasm32)全局入口状态。
///
/// `rt` 与 `arena` 分开放在两个 cell 里, 因为宿主会在 `host_call` 内部回调
/// `dian115_alloc`: 那时分发仍在进行(持有 `&mut Runtime`), 只有分开取借用才不会
/// 在同一块内存上产生两个 `&mut`。
struct Global<T> {
    inner: UnsafeCell<T>,
}

// wasm32-unknown-unknown 是单线程目标: 入口只在 dian115_handle/dian115_alloc 里被调用。
unsafe impl<T> Sync for Global<T> {}

impl<T> Global<T> {
    const fn new(value: T) -> Self {
        Global { inner: UnsafeCell::new(value) }
    }

    #[inline]
    fn get(&self) -> *mut T {
        self.inner.get()
    }
}

static RUNTIME: Global<Runtime> = Global::new(Runtime::new());
static ARENA: Global<Arena> = Global::new(Arena::new());

fn with_runtime<R>(f: impl FnOnce(&mut Runtime) -> R) -> R {
    unsafe { f(&mut *RUNTIME.get()) }
}

fn with_arena<R>(f: impl FnOnce(&mut Arena) -> R) -> R {
    unsafe { f(&mut *ARENA.get()) }
}

/// 线性内存地址 = 缓冲基址 + 偏移(wasm32 上 usize 就是 u32)。
fn arena_ptr(offset: usize) -> u32 {
    with_arena(|arena| (arena.base() as usize + offset) as u32)
}

/// 读出宿主写进 arena 的请求字节。
///
/// 与 Go `abi.go:23-25` 一致: 按指针直接读, 再 `copy` 出来 —— 复制之后分发期间宿主回调
/// `dian115_alloc` 引起的 arena 增长/复用就不会动到正在处理的数据。
///
/// 只对长度做上限保护(宿主帧上限 16MiB), 不校验指针来历: 宿主的正常路径是
/// `dian115_alloc` → 写入 → `dian115_handle`, 但 ABI 没有强制这一点, Go 版也是照读不误,
/// 这里保持一致以免对宿主行为做多余假设。
fn read_request(ptr: u32, len: u32) -> Vec<u8> {
    let size = len as usize;
    if size == 0 || size > MAX_REQUEST_BYTES {
        // 长度字段不可信: 不读内存, 交给分发层按非法请求报 -32602
        return Vec::new();
    }
    unsafe { core::slice::from_raw_parts(ptr as *const u8, size) }.to_vec()
}

/// 分发一次请求并把响应写回 arena 偏移 0(回收上一次调用的全部缓冲)。
fn handle_bytes(request: &[u8]) -> (usize, usize) {
    let response = with_runtime(|runtime| protocol::dispatch(runtime, request));
    let published = with_arena(|arena| arena.publish(&response));
    match published {
        Some(slot) => slot,
        None => {
            // arena 顶到上限: 退化成固定的内部错误响应, 保证宿主总能读到合法 JSON
            let fallback = protocol::rpc_error(protocol::CODE_INTERNAL, "arena 容量不足, 响应未写出");
            with_arena(|arena| arena.publish(&fallback)).unwrap_or((0, 0))
        }
    }
}

/// 从 arena 分配 `size` 字节; 失败(超上限/内存不足)返回 0。
///
/// 返回的地址在下一次 `dian115_handle` 收尾(响应写回)前一直有效。
#[no_mangle]
pub extern "C" fn dian115_alloc(size: u32) -> u32 {
    match with_arena(|arena| arena.alloc(size as usize)) {
        Some(offset) => arena_ptr(offset),
        None => 0,
    }
}

/// 处理一次宿主调用, 返回 `(响应地址 << 32) | 响应长度`(与 Go `abi.go:29` 一致)。
#[no_mangle]
pub extern "C" fn dian115_handle(ptr: u32, len: u32) -> u64 {
    let request = read_request(ptr, len);
    let (offset, length) = handle_bytes(&request);
    (u64::from(arena_ptr(offset)) << 32) | length as u64
}
