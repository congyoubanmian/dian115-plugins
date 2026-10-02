//! 可重置的 bump arena —— 替代 PoC 的泄漏式分配(对照 Go `abi.go:16` 的 `make([]byte, size)`)。
//!
//! 宿主与插件的调用序列:
//! ```text
//! ptr = dian115_alloc(len)   // 宿主取请求缓冲并写入请求
//! ret = dian115_handle(ptr, len)
//! addr = ret >> 32; n = ret & 0xffff_ffff   // 宿主读响应 [addr, addr+n)
//! ```
//! 生命周期设计:
//! - `alloc` 只从游标往后分配, 不回收(PoC 是每次调用 `mem::forget`, 永不回收);
//! - `publish` 在每次 handle 收尾时把游标**归零**再把响应放在偏移 0 ——
//!   上一次调用的请求/中间缓冲/响应全部作废, 内存只保留"单次调用峰值", 后续调用复用;
//! - 底层缓冲只涨不缩(高水位复用), 因此连续调用不会像泄漏式实现那样逐次增长。
//!
//! 宿主可能在 `host_call` 里回调 `dian115_alloc`(实测 wazero 基准就是这么做的),
//! 所以请求缓冲在进分发前会被复制出来(与 Go `abi.go:24` 的 `copy(local, req)` 一致),
//! 之后 arena 的增长/复用不会影响正在处理的数据。
//!
//! 与 Go/PoC 的一处有意差异: 响应固定从偏移 0 写起, 上一次调用的缓冲(请求/中间/响应)
//! 在这一刻整块回收, 只留下本次响应。宿主必须为每次 `dian115_handle` 重新
//! `dian115_alloc` + 写请求 —— 实测宿主(wazero 基准)就是这么调用的;
//! 若宿主复用同一请求缓冲重试, 且本次响应比上一轮长, 那段请求内存可能已被响应覆盖。

/// 单次调用可用的 arena 字节上限。
///
/// 超过就拒绝分配(返回 0), 而不是把线性内存顶到宿主 memory_mb 限额上被 OOM 杀掉。
/// 参考量级: Go 版状态文档 70KB、单键持久化上限 4MiB、宿主帧上限 16MiB。
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

/// 按偏移分配的 arena(偏移在 `handle` 收尾时换算成线性内存地址)。
pub struct Arena {
    buf: Vec<u8>,
    cur: usize,
}

impl Arena {
    pub const fn new() -> Self {
        Arena { buf: Vec::new(), cur: 0 }
    }

    /// 从游标分配 `size` 字节, 返回缓冲内偏移; 超上限或内存不足返回 `None`。
    ///
    /// `size == 0` 也返回一个可写地址(真实现: Go 的 `&buf[0]` 在空切片上会 panic/trap,
    /// 这里给一个合法地址更安全)。
    pub fn alloc(&mut self, size: usize) -> Option<usize> {
        let end = self.cur.checked_add(size)?;
        if end > MAX_BYTES {
            return None;
        }
        if size == 0 {
            // 保证返回的偏移指向真实映射内存(缓冲为空时先落 1 字节)
            if self.buf.is_empty() {
                self.grow_to(1)?;
            }
            return Some(self.cur);
        }
        self.grow_to(end)?;
        let off = self.cur;
        self.cur = end;
        Some(off)
    }

    /// 回收本次调用的全部空间(游标归零), 容量留给后续调用复用。
    pub fn reset(&mut self) {
        self.cur = 0;
    }

    /// `handle` 收尾: 归零游标, 把响应放在偏移 0, 返回 `(偏移, 长度)`。
    ///
    /// 这是"每次 handle 调用后可回收"的落点: 上一次调用占用的请求/中间缓冲
    /// 在这一刻全部作废。
    pub fn publish(&mut self, data: &[u8]) -> Option<(usize, usize)> {
        self.reset();
        let off = self.alloc(data.len())?;
        if !self.write(off, data) {
            return None;
        }
        Some((off, data.len()))
    }

    /// 写入**已分配**区间(越界返回 false, 不 panic)。
    pub fn write(&mut self, off: usize, data: &[u8]) -> bool {
        let end = match off.checked_add(data.len()) {
            Some(end) => end,
            None => return false,
        };
        if end > self.cur || end > self.buf.len() {
            return false;
        }
        if let Some(slot) = self.buf.get_mut(off..end) {
            slot.copy_from_slice(data);
            true
        } else {
            false
        }
    }

    /// 读回已分配区间(测试与诊断用)。
    pub fn read(&self, off: usize, len: usize) -> Option<Vec<u8>> {
        let end = off.checked_add(len)?;
        if end > self.cur {
            return None;
        }
        self.buf.get(off..end).map(|s| s.to_vec())
    }

    /// 当前游标(= 本次调用已用字节数)。
    pub fn cursor(&self) -> usize {
        self.cur
    }

    /// 已承诺的容量(高水位, 复位后不释放, 供后续调用复用)。
    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// 缓冲起始地址(wasm32 下换算成线性内存地址)。
    pub fn base(&self) -> *const u8 {
        self.buf.as_ptr()
    }

    /// 只增不减地申请到 `total` 字节; 增长按 2 倍摊销, 复用后不再触发。
    fn grow_to(&mut self, total: usize) -> Option<()> {
        if total <= self.buf.len() {
            return Some(());
        }
        let target = total.max(self.buf.len().saturating_mul(2)).min(MAX_BYTES);
        let extra = target - self.buf.len();
        if self.buf.try_reserve_exact(extra).is_err() {
            return None;
        }
        self.buf.resize(target, 0);
        Some(())
    }
}

impl Default for Arena {
    fn default() -> Self {
        Arena::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alloc_is_sequential_and_writable() {
        let mut a = Arena::new();
        assert_eq!(a.alloc(8), Some(0));
        assert_eq!(a.cursor(), 8);
        assert!(a.write(0, &[1, 2, 3, 4, 5, 6, 7, 8]));
        assert_eq!(a.read(0, 8).unwrap(), vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(a.alloc(4), Some(8));
        assert!(a.write(8, &[9, 9, 9, 9]));
        assert_eq!(a.read(8, 4).unwrap(), vec![9, 9, 9, 9]);
        assert_eq!(a.cursor(), 12);
    }

    #[test]
    fn write_outside_allocation_is_rejected() {
        let mut a = Arena::new();
        assert_eq!(a.alloc(4), Some(0));
        assert!(!a.write(0, &[1, 2, 3, 4, 5]), "越过游标必须拒绝");
        assert!(!a.write(3, &[1, 2]), "跨越已分配尾部必须拒绝");
        assert_eq!(a.read(0, 8), None);
        assert_eq!(a.read(2, 2).unwrap(), vec![0, 0]);
    }

    #[test]
    fn publish_reclaims_previous_call() {
        let mut a = Arena::new();
        // 第一次调用: 请求 16 字节 + 中间缓冲 64 字节
        assert_eq!(a.alloc(16), Some(0));
        assert!(a.write(0, &[7u8; 16]));
        assert_eq!(a.alloc(64), Some(16));
        assert_eq!(a.cursor(), 80);
        // 收尾: 响应放下偏移 0, 游标回到响应长度
        let resp = b"{\"result\":{}}";
        assert_eq!(a.publish(resp), Some((0, resp.len())));
        assert_eq!(a.cursor(), resp.len());
        assert_eq!(a.read(0, resp.len()).unwrap(), resp.to_vec());
        // 上一次调用的中间缓冲不再可读(整块回收)
        assert_eq!(a.read(resp.len(), 1), None);
    }

    /// 关键回归: 复用同一个 arena 反复调用, 内存不许逐次增长(泄漏式实现会线性涨)。
    #[test]
    fn repeated_calls_do_not_grow_memory() {
        let mut a = Arena::new();
        let request = [0u8; 32];
        let response = vec![b'x'; 4096];
        for _ in 0..100 {
            let off = a.alloc(request.len()).unwrap();
            assert!(a.write(off, &request));
            let (off, len) = a.publish(&response).unwrap();
            assert_eq!((off, len), (0, response.len()));
            assert_eq!(a.read(0, len).unwrap(), response);
        }
        // 稳态容量 = 单次调用的峰值(请求 + 响应)加摊销余量, 与调用次数无关
        let peak = request.len() + response.len();
        let settled = a.capacity();
        assert!(
            settled >= peak && settled <= peak * 2,
            "容量应收敛到单次调用峰值附近, 实际 {settled}"
        );
        for _ in 0..100 {
            let _ = a.alloc(request.len()).unwrap();
            let _ = a.publish(&response).unwrap();
        }
        assert_eq!(a.capacity(), settled, "第二批调用不允许再增长");
        assert_eq!(a.cursor(), response.len());
    }

    #[test]
    fn zerolength_alloc_returns_usable_address() {
        let mut a = Arena::new();
        let off = a.alloc(0).unwrap();
        assert_eq!(off, 0);
        assert_eq!(a.cursor(), 0, "零长度分配不移动游标");
        assert!(a.capacity() >= 1, "必须落在真实映射内存里, 不能返回悬空指针");
    }

    #[test]
    fn refuses_allocations_beyond_limit() {
        let mut a = Arena::new();
        assert_eq!(a.alloc(MAX_BYTES + 1), None);
        assert_eq!(a.cursor(), 0, "被拒的分配不能破坏游标");
        assert_eq!(a.capacity(), 0, "被拒的分配不能占内存");
        assert_eq!(a.alloc(16), Some(0));
        assert_eq!(a.alloc(MAX_BYTES), None, "累计也不能越过上限");
    }
}
