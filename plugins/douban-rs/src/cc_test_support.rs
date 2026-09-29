//! 路 2/路 3(CookieCloud、想看、TMDB/订阅)单元测试共用的假宿主。
//!
//! 只在 `cargo test` 下编译(由 `cookiecloud.rs` 的 `#[cfg(test)] mod test_support`
//! 声明)。它接管 [`crate::host::testhost`], 对 host.call 做最小路由:
//!
//! - **宿主存储**(`/api/plugin-runtime/storage/<key>`): `GET` 一律 404(= 全新安装,
//!   于是 `storage_ok = true`, 落盘路径可写), `PUT` 一律 200 带 ETag; 需要别的形态的
//!   用例可以自己注册更靠前的路由。
//! - **外部 HTTP**(豆瓣 / TMDB / 订阅池 / CookieCloud): 由用例按 `(method, path 前缀)`
//!   注册的 [`Route`] 决定; 没命中的一律 404 空体。
//!
//! 用例持有 [`TestHost`], 离开作用域自动摘掉替身 —— `cargo test` 复用线程,
//! 不摘会把替身泄漏给下一个用例。

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;

use crate::host::{testhost, HostCallRequest, HostCallResponse, HostError};

/// 一条应答规则: `method` 相同且 `path` 以 `prefix` 开头即命中。
#[derive(Debug, Clone)]
pub(crate) struct Route {
    pub method: String,
    pub prefix: String,
    /// HTTP 状态码; `host_error` 为真时忽略。
    pub status: i32,
    pub body: Vec<u8>,
    /// 命中后返回 `Err`(模拟 host.call 失败, 对应 Go 的 `wasmHostCall` 错误)。
    pub host_error: bool,
}

impl Route {
    /// 200 + 给定响应体。
    pub(crate) fn json(method: &str, prefix: &str, body: &str) -> Route {
        Route::new(method, prefix, 200, body.as_bytes())
    }

    /// 任意状态码 + 给定响应体。
    pub(crate) fn new(method: &str, prefix: &str, status: i32, body: &[u8]) -> Route {
        Route {
            method: method.to_string(),
            prefix: prefix.to_string(),
            status,
            body: body.to_vec(),
            host_error: false,
        }
    }

    /// host.call 直接失败。
    pub(crate) fn fail(method: &str, prefix: &str) -> Route {
        Route {
            method: method.to_string(),
            prefix: prefix.to_string(),
            status: 0,
            body: Vec::new(),
            host_error: true,
        }
    }
}

/// 假宿主句柄。
pub(crate) struct TestHost {
    requests: Rc<RefCell<Vec<HostCallRequest>>>,
}

impl TestHost {
    /// 装上假宿主; `routes` 按注册顺序取第一个命中的规则。
    pub(crate) fn install(routes: Vec<Route>) -> TestHost {
        let requests: Rc<RefCell<Vec<HostCallRequest>>> = Rc::new(RefCell::new(Vec::new()));
        let captured = Rc::clone(&requests);
        testhost::install(Box::new(move |request: &HostCallRequest| {
            captured.borrow_mut().push(request.clone());
            for route in &routes {
                if route.method == request.method && request.path.starts_with(route.prefix.as_str()) {
                    if route.host_error {
                        return Err(HostError::new("host_call 返回长度 0"));
                    }
                    return Ok(reply(route.status, &route.body));
                }
            }
            default_reply(request)
        }));
        TestHost { requests }
    }

    /// 到目前为止的 host.call 请求(按发生顺序)。
    pub(crate) fn requests(&self) -> Vec<HostCallRequest> {
        self.requests.borrow().clone()
    }

    /// 命中 `(method, path 前缀)` 的请求数。
    pub(crate) fn count(&self, method: &str, prefix: &str) -> usize {
        self.requests
            .borrow()
            .iter()
            .filter(|request| request.method == method && request.path.starts_with(prefix))
            .count()
    }

    /// 命中 `(method, path 前缀)` 的最后一条请求路径。
    pub(crate) fn last_path(&self, method: &str, prefix: &str) -> Option<String> {
        self.requests
            .borrow()
            .iter()
            .rev()
            .find(|request| request.method == method && request.path.starts_with(prefix))
            .map(|request| request.path.clone())
    }
}

impl Drop for TestHost {
    fn drop(&mut self) {
        testhost::clear();
    }
}

/// 宿主存储的默认应答: `GET` → 404(全新安装), `PUT` → 200 + 信封 + ETag。
fn default_reply(request: &HostCallRequest) -> Result<HostCallResponse, HostError> {
    if request.path.starts_with("/api/plugin-runtime/storage/") {
        let key = request.path.rsplit('/').next().unwrap_or("");
        return match request.method.as_str() {
            "GET" => Ok(reply(404, b"")),
            "PUT" => {
                let envelope = format!(
                    r#"{{"data":{{"key":"{key}","value":null,"revision":"pkv_1"}},"meta":{{"plugin_id":"douban.center"}}}}"#
                );
                let mut headers = BTreeMap::new();
                headers.insert("ETag".to_string(), vec!["\"pkv_1\"".to_string()]);
                headers.insert("content-type".to_string(), vec!["application/json".to_string()]);
                Ok(HostCallResponse {
                    status: 200,
                    headers,
                    body_base64: STANDARD_NO_PAD.encode(envelope.as_bytes()),
                })
            }
            _ => Ok(reply(405, b"method not allowed")),
        };
    }
    Ok(reply(404, b""))
}

/// 组装一条宿主响应(`body_base64` 用不补 padding 的形态, 与宿主文档一致)。
pub(crate) fn reply(status: i32, body: &[u8]) -> HostCallResponse {
    let mut headers = BTreeMap::new();
    if status < 400 {
        headers.insert("content-type".to_string(), vec!["application/json".to_string()]);
    }
    HostCallResponse {
        status,
        headers,
        body_base64: if body.is_empty() {
            String::new()
        } else {
            STANDARD_NO_PAD.encode(body)
        },
    }
}
