//! 薄封装: 生产代码在 `common::arena`, 本模块只做 re-export。
//!
//! 插件级测试保留在这里(依赖插件的 testkit / 前缀断言 / 业务语义)。

pub use common::arena::*;

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
        assert_eq!(a.cursor(), 12);
    }

    #[test]
    fn write_outside_allocation_is_rejected() {
        let mut a = Arena::new();
        assert_eq!(a.alloc(4), Some(0));
        assert!(!a.write(0, &[1, 2, 3, 4, 5]), "越过游标必须拒绝");
        assert!(!a.write(3, &[1, 2]), "跨越已分配尾部必须拒绝");
        assert_eq!(a.read(0, 8), None);
    }

    #[test]
    fn publish_reclaims_previous_call() {
        let mut a = Arena::new();
        assert_eq!(a.alloc(16), Some(0));
        assert!(a.write(0, &[7u8; 16]));
        assert_eq!(a.alloc(64), Some(16));
        assert_eq!(a.cursor(), 80);
        let resp = b"{\"result\":{}}";
        assert_eq!(a.publish(resp), Some((0, resp.len())));
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
        assert!(
            a.capacity() >= 1,
            "必须落在真实映射内存里, 不能返回悬空指针"
        );
    }

    #[test]
    fn refuses_allocations_beyond_limit() {
        let mut a = Arena::new();
        assert_eq!(a.alloc(MAX_ARENA_BYTES + 1), None);
        assert_eq!(a.cursor(), 0, "被拒的分配不能破坏游标");
        assert_eq!(a.capacity(), 0, "被拒的分配不能占内存");
        assert_eq!(a.alloc(16), Some(0));
        assert_eq!(a.alloc(MAX_ARENA_BYTES), None, "累计也不能越过上限");
    }
}
