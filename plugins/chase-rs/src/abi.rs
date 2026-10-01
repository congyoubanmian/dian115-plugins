//! `dian115:wasm@1` ABI 导出层(含 douban-rs 的 `abi.rs` 导出面, arena 见 [`crate::arena`])。
//!
//! 导出面(与宿主约定一致):
//! - `dian115_alloc(size: u32) -> u32`          —— 从 arena 分配, 返回线性内存地址
//! - `dian115_handle(ptr: u32, len: u32) -> u64` —— 高 32 位响应地址 | 低 32 位响应长度
//!
//! 导入面: `dian115` 模块的 `host_call` / `host_read`(见 [`crate::host`])。
//!
//! # 可移植内核 + wasm32 导出
//!
//! u32 指针只在 wasm32 上成立, 所以真正的 `#[no_mangle]` 导出函数是
//! `#[cfg(target_arch = "wasm32")]` 的; 但它们只是一层薄壳 —— 内存分配
//! ([`Arena`])、请求分发、响应回落(`publish` 到偏移 0)全部在 [`alloc`] / [`handle`]
//! 里, native 的集成测试跑的就是这两个函数(与 wasm 完全同一条代码路径)。
//!
//! 调用序列(宿主视角):
//! ```text
//! ptr = dian115_alloc(len)   // 宿主取请求缓冲并写入请求
//! ret = dian115_handle(ptr, len)
//! addr = ret >> 32; n = ret & 0xffff_ffff   // 宿主读响应 [addr, addr+n)
//! ```
//!
//! 宿主可能在 `host_call` 里回调 `dian115_alloc`, 所以请求字节在进分发前会被复制出来,
//! 之后 arena 的增长/复用不会影响正在处理的数据。

#[cfg(target_arch = "wasm32")]
use core::cell::UnsafeCell;

use crate::arena::Arena;
use crate::protocol;
use crate::runtime::Runtime;

/// 请求字节上限: 宿主帧上限 16MiB, 超过即视为非法请求。
/// 用它挡住"长度字段被写坏"导致的越界读。
pub const MAX_REQUEST_BYTES: usize = 16 << 20;

/// 从 arena 分配 `size` 字节, 返回缓冲内偏移; 失败(超上限/内存不足)返回 `None`。
///
/// 导出层把它换算成线性内存地址; native 测试直接拿偏移。
pub fn alloc(arena: &mut Arena, size: u32) -> Option<usize> {
    arena.alloc(size as usize)
}

/// 处理一次请求: 分发 + 把响应写回 arena 偏移 0, 返回 `(偏移, 长度)`。
///
/// 请求字节必须由调用方**复制**进来(导出层从线性内存拷, 测试直接传切片): 分发期间
/// 宿主可能回调 `dian115_alloc`, arena 的复用不会影响这次处理。
pub fn handle(arena: &mut Arena, runtime: &mut Runtime, request: &[u8]) -> (usize, usize) {
    let response = protocol::dispatch(runtime, request);
    match arena.publish(&response) {
        Some(slot) => slot,
        None => {
            // arena 顶到上限: 退化成固定的内部错误响应, 保证宿主总能读到合法 JSON
            let fallback =
                protocol::rpc_error(protocol::CODE_INTERNAL, "arena 容量不足, 响应未写出");
            arena.publish(&fallback).unwrap_or((0, 0))
        }
    }
}

/// 读回已发布区间(宿主读响应 / native 测试)。
pub fn read(arena: &Arena, off: usize, len: usize) -> Option<Vec<u8>> {
    arena.read(off, len)
}

// ─────────────────────────── wasm32 导出面 ───────────────────────────

/// 单线程(wasm32)全局入口状态。
///
/// `RUNTIME` 与 `ARENA` 分开放在两个 cell 里, 因为宿主会在 `host_call` 内部回调
/// `dian115_alloc`: 那时分发仍在进行(持有 `&mut Runtime`), 只有分开取借用才不会在
/// 同一块内存上产生两个 `&mut`。
#[cfg(target_arch = "wasm32")]
struct Global<T> {
    inner: UnsafeCell<T>,
}

// wasm32-unknown-unknown 是单线程目标: 入口只在 dian115_handle/dian115_alloc 里被调用。
#[cfg(target_arch = "wasm32")]
unsafe impl<T> Sync for Global<T> {}

#[cfg(target_arch = "wasm32")]
impl<T> Global<T> {
    const fn new(value: T) -> Self {
        Global { inner: UnsafeCell::new(value) }
    }

    #[inline]
    fn get(&self) -> *mut T {
        self.inner.get()
    }
}

/// 首次 `dian115_handle` 时惰性构造。
///
/// 不能写成 `Global::new(Runtime::new())`: [`Runtime::new`] 内部走 `Default`/`StateDoc::new`,
/// 不是 `const fn`, 静态初始化器里调用会 E0015。`Option` 的空槽是 const 表达式,
/// 首次进入时 `get_or_insert_with` 顶上 —— wasm 单线程, 不存在竞争。
#[cfg(target_arch = "wasm32")]
static RUNTIME: Global<Option<Runtime>> = Global::new(None);
#[cfg(target_arch = "wasm32")]
static ARENA: Global<Arena> = Global::new(Arena::new());

/// 线性内存地址 = 缓冲基址 + 偏移(wasm32 上 usize 就是 u32)。
#[cfg(target_arch = "wasm32")]
fn arena_ptr(arena: &Arena, offset: usize) -> u32 {
    (arena.base() as usize + offset) as u32
}

/// 读出宿主写进 arena 的请求字节。
///
/// 与 Go `abi.go:23-25` 一致: 按指针直接读, 再 `copy` 出来 —— 复制之后分发期间宿主
/// 回调 `dian115_alloc` 引起的 arena 增长/复用就不会动到正在处理的数据。
///
/// 只对长度做上限保护(宿主帧上限 16MiB), 不校验指针来历: 宿主的正常路径是
/// `dian115_alloc` → 写入 → `dian115_handle`, 但 ABI 没有强制这一点, Go 版也是照读
/// 不误, 这里保持一致以免对宿主行为做多余假设。
#[cfg(target_arch = "wasm32")]
fn read_request(ptr: u32, len: u32) -> Vec<u8> {
    let size = len as usize;
    if size == 0 || size > MAX_REQUEST_BYTES {
        // 长度字段不可信: 不读内存, 交给分发层按非法请求报 -32602
        return Vec::new();
    }
    unsafe { core::slice::from_raw_parts(ptr as *const u8, size) }.to_vec()
}

/// 从 arena 分配 `size` 字节; 失败(超上限/内存不足)返回 0。
///
/// 返回的地址在下一次 `dian115_handle` 收尾(响应写回)前一直有效。
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn dian115_alloc(size: u32) -> u32 {
    // 借用取出来就还回去: 分配期间只借用 ARENA。
    let offset = {
        let arena = unsafe { &mut *ARENA.get() };
        alloc(arena, size)
    };
    match offset {
        Some(offset) => {
            let arena = unsafe { &*ARENA.get() };
            arena_ptr(arena, offset)
        }
        None => 0,
    }
}

/// 处理一次宿主调用, 返回 `(响应地址 << 32) | 响应长度`(与 Go `abi.go:29` 一致)。
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn dian115_handle(ptr: u32, len: u32) -> u64 {
    let request = read_request(ptr, len);
    // 借用分开取: dispatch 期间宿主可能回调 dian115_alloc(它只借 ARENA)。
    let (offset, length) = {
        // 惰性构造单例运行时(见 RUNTIME 的说明); 借用只在 handle 期间持有。
        let runtime = unsafe { &mut *RUNTIME.get() }.get_or_insert_with(Runtime::new);
        let arena = unsafe { &mut *ARENA.get() };
        handle(arena, runtime, &request)
    };
    let address = {
        let arena = unsafe { &*ARENA.get() };
        arena_ptr(arena, offset)
    };
    (u64::from(address) << 32) | u64::from(length as u32)
}

// 编译期形状断言: 导出符号必须与 ABI 约定一致(u32 指针 / u64 返回)。
// native 上没有这两个函数, 断言只在 wasm32 构建里生效。
#[cfg(target_arch = "wasm32")]
const _: extern "C" fn(u32) -> u32 = dian115_alloc;
#[cfg(target_arch = "wasm32")]
const _: extern "C" fn(u32, u32) -> u64 = dian115_handle;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_publishes_response_at_offset_zero() {
        let mut arena = Arena::new();
        let mut runtime = Runtime::new();
        let (off, len) = handle(&mut arena, &mut runtime, br#"{"method":"runtime.initialize"}"#);
        assert_eq!(off, 0);
        assert_eq!(
            read(&arena, off, len).unwrap(),
            br#"{"result":{"ready":true,"protocol":"dian115:wasm@1"}}"#.to_vec()
        );
    }

    #[test]
    fn alloc_delegates_to_arena() {
        let mut arena = Arena::new();
        assert_eq!(alloc(&mut arena, 8), Some(0));
        assert_eq!(arena.cursor(), 8);
        assert_eq!(alloc(&mut arena, u32::MAX), None);
    }
}
