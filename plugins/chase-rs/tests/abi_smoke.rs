//! 最小集成测试(外部 crate 视角): `dian115:wasm@1` 的内存往返 + 四个 op 的线形状。
//!
//! 宿主装载 wasm 后按 `ptr = dian115_alloc(len)` → 写请求 → `dian115_handle(ptr,len)`
//! → 读 `[addr, addr+n)` 的顺序调用。native 上没有线性内存, 指针换算是 wasm32 专属的
//! 那两个导出函数, 所以这里驱动它们的内核 [`abi::alloc`] / [`abi::handle`]
//! (见 `src/abi.rs` 的模块头): 除了最后的 u32 地址换算, 与 wasm 上是同一条代码路径。
//!
//! 这一组用例**不装宿主替身**(`testkit` 在 crate 内, 本 crate 外不可见, 也不该可见):
//! 它验的是"宿主完全够不着"时插件仍然不 panic、仍然回合法 JSON —— 这正是本机
//! `host_call` 桩的行为(恒失败), 也是生产上宿主重启窗口里最糟的那条路径。

// `Arena` 走公开路径 `plugin::arena`(abi 里的那个是私有 use, crate 外看不见)。
use plugin::abi;
use plugin::arena::Arena;
use plugin::runtime::Runtime;

/// 模拟宿主的调用序列, 并在每次调用后校验响应落在偏移 0。
struct Guest {
    arena: Arena,
    runtime: Runtime,
}

impl Guest {
    fn new() -> Self {
        Guest { arena: Arena::new(), runtime: Runtime::new() }
    }

    /// 一次完整调用: alloc → 写入请求 → handle → 读回响应。
    fn call(&mut self, request: &[u8]) -> Vec<u8> {
        let len = request.len() as u32;
        let offset = abi::alloc(&mut self.arena, len).expect("请求缓冲必须分配成功");
        assert!(
            self.arena.capacity() >= offset + request.len(),
            "分配出的区间必须落在 arena 的映射内存里"
        );
        assert!(self.arena.write(offset, request), "请求必须能写进刚分配的区间");

        let (response_offset, response_len) =
            abi::handle(&mut self.arena, &mut self.runtime, request);
        assert_eq!(response_offset, 0, "响应固定从偏移 0 写起(上一次调用的缓冲整块回收)");
        abi::read(&self.arena, response_offset, response_len).expect("响应必须能从 arena 读回")
    }

    /// 读回响应的 JSON(顺便证明响应永远是合法 JSON)。
    fn call_json(&mut self, request: &[u8]) -> serde_json::Value {
        let response = self.call(request);
        serde_json::from_slice(&response).unwrap_or_else(|e| {
            panic!("响应必须是合法 JSON: {e}; 实际 {:?}", String::from_utf8_lossy(&response))
        })
    }
}

/// ABI 内存导出: `alloc` 出来的区间可写, 响应写回偏移 0 且长度与内容一致。
#[test]
fn abi_memory_round_trip_publishes_the_response_at_offset_zero() {
    let mut guest = Guest::new();
    let request = br#"{"method":"runtime.initialize"}"#;

    let offset = abi::alloc(&mut guest.arena, request.len() as u32).unwrap();
    assert_eq!(offset, 0, "首次分配从偏移 0 起");
    assert!(guest.arena.write(offset, request));
    assert_eq!(guest.arena.cursor(), request.len());

    let (response_offset, response_len) =
        abi::handle(&mut guest.arena, &mut guest.runtime, request);
    assert_eq!(response_offset, 0);
    assert_eq!(
        abi::read(&guest.arena, response_offset, response_len).unwrap(),
        br#"{"result":{"ready":true,"protocol":"dian115:wasm@1"}}"#.to_vec(),
        "initialize 的响应必须逐字节符合宿主约定"
    );
    // 上一次调用的中间缓冲不再可读: 游标已归零到本次响应长度
    assert_eq!(guest.arena.cursor(), response_len);
    assert_eq!(abi::read(&guest.arena, response_len, 1), None);
}

/// 反复调用不允许让 arena 逐次增长(响应写回时整块回收)。
#[test]
fn repeated_abi_calls_reuse_the_same_buffer() {
    let mut guest = Guest::new();
    let request =
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_1","payload":{}}}}"#;
    // 前几次调用会把高水位(响应 + 下一次请求)抬到位, 之后必须稳定
    for _ in 0..3 {
        let _ = guest.call(request);
    }
    let settled = guest.arena.capacity();
    for _ in 0..50 {
        let _ = guest.call(request);
    }
    assert_eq!(guest.arena.capacity(), settled, "稳态容量不该随调用次数增长");
}

/// 宿主硬限制: 初始化握手期间不允许任何 host.call(否则宿主拒绝重入)。
#[test]
fn initialize_never_calls_host() {
    let before = plugin::host::observed_calls();
    let mut guest = Guest::new();
    for request in [
        r#"{"method":"runtime.initialize"}"#,
        r#"{"method":"runtime.initialize","params":{"protocol":"dian115:wasm@1"}}"#,
        r#"{"method":"runtime.initialize","params":{"unexpected":true}}"#,
    ] {
        let out = guest.call_json(request.as_bytes());
        assert_eq!(out["result"]["protocol"], "dian115:wasm@1", "请求: {request}");
    }
    assert_eq!(plugin::host::observed_calls(), before, "initialize 期间发生了 host.call");
}

/// `state` op 的线形状: `{state_version, etag, state}`, 且 payload 非法才走 -32602。
#[test]
fn state_op_returns_a_versioned_document() {
    let mut guest = Guest::new();
    let out = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_1","payload":{}}}}"#,
    );
    assert_eq!(out["result"]["state_version"], "state-v0", "实际: {out}");
    assert_eq!(out["result"]["etag"], "\"state-v0\"");
    assert_eq!(out["result"]["state"]["schema_version"], 1);
    assert!(out["result"]["state"]["settings"].is_object());
    assert!(out.get("error").is_none());

    // if_none_match 命中 → 304 形态(不重发文档)
    let out = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_2","payload":{"if_none_match":"\"state-v0\""}}}}"#,
    );
    assert_eq!(out["result"]["not_modified"], true, "实际: {out}");

    // payload 不是对象 → -32602
    let out = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_3","payload":"nope"}}}"#,
    );
    assert_eq!(out["error"]["code"], -32602, "实际: {out}");
}

/// 业务失败的形状: 未知 action 是**正常 result** 里的失败, 不是 JSON-RPC error。
#[test]
fn unknown_action_is_a_normal_result() {
    let mut guest = Guest::new();
    let unknown = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"action","payload":{"id":"teleport","input":{}}}}}"#,
    );
    assert_eq!(unknown["result"]["status"], "failed", "实际: {unknown}");
    assert_eq!(unknown["result"]["code"], "unknown_action");
    assert!(unknown.get("error").is_none());

    // 未声明的 job 同样是正常 result 里的 skipped
    let unknown = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"job","payload":{"id":"nope"}}}}"#,
    );
    assert_eq!(unknown["result"]["status"], "skipped");
    assert!(unknown.get("error").is_none());
}

/// shutdown 的线形状: 顶层 stopping(不包 result)。
#[test]
fn shutdown_stops_at_the_top_level() {
    let mut guest = Guest::new();
    let shutdown = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"shutdown","invocation_id":"inv_3"}}}"#,
    );
    assert_eq!(shutdown, serde_json::json!({"stopping": true}));
}

/// 与本机宿主(没有真实 `dian115` 导入)的约定: 存储不可读时业务照常返回, 不 panic。
///
/// 这也是"存储不可用 ⇒ 只读、绝不落盘"的端到端证据: `storage_ok()` 必须保持 false。
#[test]
fn business_paths_survive_an_unreachable_host_store() {
    let mut guest = Guest::new();

    // 先看基线状态: 版本 0、没有业务数据、没有运行记录
    let out = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_0","payload":{}}}}"#,
    );
    assert_eq!(out["result"]["state_version"], "state-v0", "实际: {out}");
    assert_eq!(out["result"]["state"]["align"]["items"], serde_json::json!([]));

    // refresh: 订阅池读不到 → accepted + 一句可读的原因(不是 error)
    let out = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"action","invocation_id":"inv_1","payload":{"id":"refresh","input":{}}}}}"#,
    );
    assert_eq!(out["result"]["status"], "accepted", "实际: {out}");
    assert!(
        out["result"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("订阅池"),
        "实际: {out}"
    );

    // 状态文档里留下了失败现场(内存态; 刷新不动 revision, 因为它是只读动作)
    let state = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"state","invocation_id":"inv_2","payload":{}}}}"#,
    );
    assert!(
        state["result"]["state"]["debug"]["last_errors"]
            .as_array()
            .map(|errors| !errors.is_empty())
            .unwrap_or(false),
        "实际: {state}"
    );
    assert_eq!(state["result"]["state_version"], "state-v0", "刷新只读, 不动 revision");

    // align-now: 拿不到订阅池 → 正常 result 里的 failed, 且没有 PATCH
    let out = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"action","invocation_id":"inv_3","payload":{"id":"align-now","input":{}}}}}"#,
    );
    assert_eq!(out["result"]["status"], "failed", "实际: {out}");

    // job: 宿主存储不可读 ⇒ 整轮跳过, 且明确不落盘
    let out = guest.call_json(
        br#"{"method":"runtime.invoke","params":{"envelope":{"op":"job","invocation_id":"inv_4","payload":{"id":"align"}}}}"#,
    );
    assert_eq!(out["result"]["status"], "skipped", "实际: {out}");
    assert!(!guest.runtime.storage_ok(), "宿主不可读时不允许标记存储可用");
}
