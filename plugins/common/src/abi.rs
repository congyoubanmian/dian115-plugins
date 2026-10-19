//! `dian115:wasm@1` 的可移植 ABI 内核。
//!
//! 这里只有与平台无关的部分:
//! - [`MAX_REQUEST_BYTES`] 请求长度上限;
//! - [`alloc`] / [`handle`] / [`read`] —— 分配、分发 + 响应写回、读回;
//! - wasm32 上的 [`read_request`](从线性内存拷贝请求字节)。
//!
//! 真正的 `Global<T>` / `static RUNTIME` / `static ARENA` / `#[no_mangle]`
//! `dian115_alloc` / `dian115_handle` 留在各插件的 `src/abi.rs` shell 里 ——
//! 导出符号与线性内存地址换算属于插件的 ABI 面, 迁移到依赖 crate 反而会改变
//! wasm 导出/导入段的归属。
//!
//! native 集成测试(chase-rs `tests/abi_smoke.rs`)直接驱动这里的内核, 与 wasm
//! 上的导出函数走同一条代码路径(除了最后的 u32 地址换算)。

use crate::arena::Arena;
use crate::protocol::{self, ProtocolRuntime};

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
pub fn handle<R: ProtocolRuntime>(
    arena: &mut Arena,
    runtime: &mut R,
    request: &[u8],
) -> (usize, usize) {
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

/// 读出宿主写进 arena 的请求字节。
///
/// 与 Go 版一致: 按指针直接读, 再 `copy` 出来 —— 复制之后分发期间宿主回调
/// `dian115_alloc` 引起的 arena 增长/复用就不会动到正在处理的数据。
///
/// 只对长度做上限保护(宿主帧上限 16MiB), 不校验指针来历: 宿主的正常路径是
/// `dian115_alloc` → 写入 → `dian115_handle`, 但 ABI 没有强制这一点。
#[cfg(target_arch = "wasm32")]
pub fn read_request(ptr: u32, len: u32) -> Vec<u8> {
    let size = len as usize;
    if size == 0 || size > MAX_REQUEST_BYTES {
        // 长度字段不可信: 不读内存, 交给分发层按非法请求报 -32602
        return Vec::new();
    }
    unsafe { core::slice::from_raw_parts(ptr as *const u8, size) }.to_vec()
}
