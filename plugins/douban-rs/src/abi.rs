//! dian115:wasm@1 ABI 导出层(wasm32 shell; 对照 Go `abi.go` + `abi_stub.go`)。
//!
//! 导出面(与 Go 完全一致):
//! - `dian115_alloc(size: u32) -> u32`        —— 从 arena 分配, 返回线性内存地址
//! - `dian115_handle(ptr: u32, len: u32) -> u64` —— 高 32 位响应地址 | 低 32 位响应长度
//! 导入面: `dian115` 模块的 `host_call` / `host_read`(见 [`crate::host`])。
//!
//! 本文件只在 wasm32 上编译(见 `lib.rs` 的 `cfg`): 分配/分发/响应写回的可移植内核
//! 在 `common::abi`, 这里只保留单线程全局状态与 `#[no_mangle]` 导出。

use core::cell::UnsafeCell;

use common::abi;

use crate::arena::Arena;
use crate::runtime::Runtime;

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
        Global {
            inner: UnsafeCell::new(value),
        }
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

/// 分发一次请求并把响应写回 arena 偏移 0(回收上一次调用的全部缓冲)。
fn handle_bytes(request: &[u8]) -> (usize, usize) {
    // 借用分开取: dispatch 期间宿主可能回调 dian115_alloc(它只借 ARENA)。
    with_runtime(|runtime| with_arena(|arena| abi::handle(arena, runtime, request)))
}

/// 从 arena 分配 `size` 字节; 失败(超上限/内存不足)返回 0。
///
/// 返回的地址在下一次 `dian115_handle` 收尾(响应写回)前一直有效。
#[no_mangle]
pub extern "C" fn dian115_alloc(size: u32) -> u32 {
    match with_arena(|arena| abi::alloc(arena, size)) {
        Some(offset) => arena_ptr(offset),
        None => 0,
    }
}

/// 处理一次宿主调用, 返回 `(响应地址 << 32) | 响应长度`(与 Go `abi.go:29` 一致)。
#[no_mangle]
pub extern "C" fn dian115_handle(ptr: u32, len: u32) -> u64 {
    let request = abi::read_request(ptr, len);
    let (offset, length) = handle_bytes(&request);
    (u64::from(arena_ptr(offset)) << 32) | length as u64
}
