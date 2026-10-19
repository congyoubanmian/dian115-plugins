//! `dian115:wasm@1` ABI 导出层(含 douban-rs 的导出面, arena 见 [`crate::arena`])。
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
//! ([`Arena`])、请求分发、响应回落(`publish` 到偏移 0)全部在
//! `common::abi` 的 [`alloc`] / [`handle`] 里, native 的集成测试跑的就是
//! 这两个函数(与 wasm 完全同一条代码路径)。
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

pub use common::abi::{alloc, handle, read, MAX_REQUEST_BYTES};

#[cfg(any(target_arch = "wasm32", test))]
use crate::arena::Arena;
#[cfg(any(target_arch = "wasm32", test))]
use crate::runtime::Runtime;
#[cfg(target_arch = "wasm32")]
use core::cell::UnsafeCell;

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
        Global {
            inner: UnsafeCell::new(value),
        }
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
    let request = common::abi::read_request(ptr, len);
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
        let (off, len) = handle(
            &mut arena,
            &mut runtime,
            br#"{"method":"runtime.initialize"}"#,
        );
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
