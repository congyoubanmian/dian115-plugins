//! 本机 `cargo test` 用的宿主替身(只在 native 构建里编译)。
//!
//! 走的是**真实**的 `host::call` 路径: 请求信封编码、`host_read` 长度校验、响应信封解析
//! 全部照旧, 只把跨进程往返换成同线程闭包(与 douban-rs 的 `testkit::FakeHost` 同一思路)。
//! 替身提供三块能力:
//!
//! - **存储**: `GET/PUT /api/plugin-runtime/storage/<key>`, 带 `pkv_N` 乐观锁与宿主信封;
//! - **业务路由**: 按 `方法 路径` 注册任意 HTTP 状态与 body(订阅池/Emby/日历/通知);
//! - **观察窗**: 记录每一次请求, 供"PATCH 只增不减""align-now 的 host.call 上限"
//!   这类不变量断言使用。
//!
//! 替身是**线程本地**的: `cargo test` 并行跑用例, 每个用例在自己的线程里 install,
//! 退出时由 [`Guard`] 卸载, 不会串味。

#![cfg(not(target_arch = "wasm32"))]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use base64::Engine as _;

use crate::host::{self, HostCallRequest, HostCallResponse, HostError};

/// 一次 PUT 的可观察记录(ETag 与幂等键)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutRecord {
    pub key: String,
    pub if_match: String,
    pub idempotency_key: String,
    pub body: Vec<u8>,
}

#[derive(Default)]
struct Inner {
    /// 存储键 → 值。
    values: BTreeMap<String, Vec<u8>>,
    /// 存储键 → revision(`pkv_N` 里的 N)。
    revisions: BTreeMap<String, u64>,
    /// 业务路由: `"GET /api/x"` → (status, body)。
    routes: BTreeMap<String, (i32, Vec<u8>)>,
    /// 路由前缀(带查询串也能命中): `"GET /api/x"` → (status, body)。
    prefix_routes: Vec<(String, i32, Vec<u8>)>,
    requests: Vec<HostCallRequest>,
    puts: Vec<PutRecord>,
    /// 下一次 PUT 强制 412 并把 revision 推新(模拟并发写入)。
    concurrent_write: bool,
    /// 下一次 PUT 之后键被删除(412 重读失败)。
    concurrent_delete: bool,
    /// 强制 host.call 返回 Err(宿主不可用)。
    fail_all: bool,
    /// 强制存储 GET 返回的状态码(0 = 按值是否存在决定)。
    get_status: i32,
    /// 队列形式的状态码(逐个消费, 用完后回到默认行为)。
    get_status_queue: Vec<i32>,
}

/// 宿主替身(克隆共享同一份状态)。
#[derive(Clone, Default)]
pub struct FakeHost {
    inner: Rc<RefCell<Inner>>,
}

/// install 的作用域守卫: Drop 时卸载替身。
pub struct Guard {
    _private: (),
}

impl Drop for Guard {
    fn drop(&mut self) {
        host::testhost::clear();
    }
}

impl FakeHost {
    pub fn new() -> Self {
        FakeHost::default()
    }

    /// 安装到当前线程; 返回值必须活到用例结束。
    pub fn install(&self) -> Guard {
        let inner = Rc::clone(&self.inner);
        host::testhost::install(Box::new(move |request| {
            Self::handle(&inner, request)
        }));
        Guard { _private: () }
    }

    fn handle(
        inner: &Rc<RefCell<Inner>>,
        request: &HostCallRequest,
    ) -> Result<HostCallResponse, HostError> {
        let mut state = inner.borrow_mut();
        state.requests.push(request.clone());
        if state.fail_all {
            return Err(HostError::new("host_call 返回长度 0"));
        }
        if request.path.starts_with("/api/plugin-runtime/storage/") {
            return Self::handle_storage(&mut state, request);
        }
        let key = format!("{} {}", request.method, request.path);
        if let Some((status, body)) = state.routes.get(&key).cloned() {
            return Ok(reply(status, &body));
        }
        let prefix = state
            .prefix_routes
            .iter()
            .find(|(prefix, _, _)| key.starts_with(prefix.as_str()))
            .cloned();
        if let Some((_, status, body)) = prefix {
            return Ok(reply(status, &body));
        }
        Ok(reply(404, br#"{"error":"no route"}"#))
    }

    fn handle_storage(
        state: &mut std::cell::RefMut<'_, Inner>,
        request: &HostCallRequest,
    ) -> Result<HostCallResponse, HostError> {
        let key = request
            .path
            .trim_start_matches("/api/plugin-runtime/storage/")
            .to_string();
        match request.method.as_str() {
            "GET" => {
                let forced = if let Some(status) = state.get_status_queue.first().copied() {
                    state.get_status_queue.remove(0);
                    status
                } else {
                    state.get_status
                };
                if forced != 0 && forced != 200 {
                    return Ok(reply(forced, b""));
                }
                match state.values.get(&key).cloned() {
                    Some(value) => {
                        let revision = *state.revisions.get(&key).unwrap_or(&0);
                        Ok(host_envelope(&key, &value, revision))
                    }
                    None => Ok(reply(404, br#"{"error":"not found"}"#)),
                }
            }
            "PUT" => {
                let if_match = request.headers.get("if-match").cloned().unwrap_or_default();
                let idempotency_key = request
                    .headers
                    .get("idempotency-key")
                    .cloned()
                    .unwrap_or_default();
                let body = decode(&request.body_base64);
                let inner_value = body
                    .strip_prefix(br#"{"value":"#)
                    .and_then(|rest| rest.strip_suffix(b"}"))
                    .unwrap_or(&body)
                    .to_vec();
                state.puts.push(PutRecord {
                    key: key.clone(),
                    if_match: if_match.clone(),
                    idempotency_key,
                    body: inner_value.clone(),
                });
                if state.concurrent_write {
                    state.concurrent_write = false;
                    let revision = state.revisions.entry(key.clone()).or_insert(0);
                    *revision += 1;
                    return Ok(reply(412, b""));
                }
                if state.concurrent_delete {
                    state.concurrent_delete = false;
                    state.values.remove(&key);
                    state.revisions.remove(&key);
                    return Ok(reply(412, b""));
                }
                let revision = *state.revisions.get(&key).unwrap_or(&0);
                if state.values.contains_key(&key) && if_match != format!("\"pkv_{revision}\"") {
                    return Ok(reply(412, b""));
                }
                state.values.insert(key.clone(), inner_value);
                let revision = state.revisions.entry(key.clone()).or_insert(0);
                *revision += 1;
                Ok(reply(200, b""))
            }
            _ => Ok(reply(405, b"")),
        }
    }

    // ── 布置 ──

    /// 注册一条业务路由(精确匹配 `方法 路径`)。
    pub fn json(&self, path: &str, status: i32, body: &[u8]) -> &Self {
        self.route("GET", path, status, body)
    }

    pub fn route(&self, method: &str, path: &str, status: i32, body: &[u8]) -> &Self {
        self.inner
            .borrow_mut()
            .routes
            .insert(format!("{method} {path}"), (status, body.to_vec()));
        self
    }

    /// 注册一条前缀路由(用于带查询串的路径)。
    ///
    /// `prefix` 允许两种写法: 只给路径(`"/api/x?"`, 内部补上方法)或已经带方法
    /// (`"GET /api/x?"`)。用例里两种都出现过, 这里统一成 `"<方法> <路径前缀>"`。
    pub fn route_prefix(&self, method: &str, prefix: &str, status: i32, body: &[u8]) -> &Self {
        let already_qualified =
            prefix.starts_with(method) && prefix.as_bytes().get(method.len()) == Some(&b' ');
        let full = if already_qualified {
            prefix.to_string()
        } else {
            format!("{method} {prefix}")
        };
        self.inner
            .borrow_mut()
            .prefix_routes
            .push((full, status, body.to_vec()));
        self
    }

    /// 直接布置存储键的值。
    pub fn set(&self, key: &str, value: &[u8]) -> &Self {
        let mut inner = self.inner.borrow_mut();
        inner.values.insert(key.to_string(), value.to_vec());
        inner.revisions.insert(key.to_string(), 1);
        self
    }

    pub fn concurrent_write_on_put(&self) -> &Self {
        self.inner.borrow_mut().concurrent_write = true;
        self
    }

    pub fn concurrent_delete_on_put(&self) -> &Self {
        self.inner.borrow_mut().concurrent_delete = true;
        self
    }

    pub fn fail_all(&self, fail: bool) -> &Self {
        self.inner.borrow_mut().fail_all = fail;
        self
    }

    pub fn get_status(&self, status: i32) -> &Self {
        self.inner.borrow_mut().get_status = status;
        self
    }

    pub fn push_get_status(&self, status: i32) -> &Self {
        self.inner.borrow_mut().get_status_queue.push(status);
        self
    }

    // ── 观察 ──

    pub fn requests(&self) -> Vec<HostCallRequest> {
        self.inner.borrow().requests.clone()
    }

    pub fn puts(&self) -> Vec<PutRecord> {
        self.inner.borrow().puts.clone()
    }

    pub fn value_of(&self, key: &str) -> Option<Vec<u8>> {
        self.inner.borrow().values.get(key).cloned()
    }

    /// 已记录的业务请求路径(排除存储读写)。
    pub fn business_paths(&self) -> Vec<String> {
        self.inner
            .borrow()
            .requests
            .iter()
            .filter(|request| !request.path.starts_with("/api/plugin-runtime/storage/"))
            .map(|request| format!("{} {}", request.method, request.path))
            .collect()
    }

    /// 已记录的 PATCH 请求。
    pub fn patches(&self) -> Vec<HostCallRequest> {
        self.inner
            .borrow()
            .requests
            .iter()
            .filter(|request| request.method == "PATCH")
            .cloned()
            .collect()
    }
}

/// 宿主存储响应信封(`{"data":{"key":..,"value":..,"revision":"pkv_N"},"meta":..}`)。
fn host_envelope(key: &str, value: &[u8], revision: u64) -> HostCallResponse {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(r#"{{"data":{{"key":"{key}","value":"#).as_bytes(),
    );
    body.extend_from_slice(value);
    body.extend_from_slice(
        format!(
            r#","revision":"pkv_{revision}","updated_at":"2026-10-01T00:00:00Z"}},"meta":{{"plugin_id":"chase.rs","installation_id":1}}}}"#
        )
        .as_bytes(),
    );
    let mut headers = BTreeMap::new();
    headers.insert("ETag".to_string(), vec![format!("\"pkv_{revision}\"")]);
    HostCallResponse {
        status: 200,
        headers,
        body_base64: base64::engine::general_purpose::STANDARD_NO_PAD.encode(&body),
    }
}

fn reply(status: i32, body: &[u8]) -> HostCallResponse {
    HostCallResponse {
        status,
        headers: BTreeMap::new(),
        body_base64: base64::engine::general_purpose::STANDARD_NO_PAD.encode(body),
    }
}

fn decode(body_base64: &str) -> Vec<u8> {
    if body_base64.is_empty() {
        return Vec::new();
    }
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(body_base64)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(body_base64))
        .unwrap_or_default()
}
