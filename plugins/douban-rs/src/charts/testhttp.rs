//! 路 1 的测试替身: 脚本化的出站 HTTP(仅 `cargo test`)。
//!
//! 走的是**真实**的 [`crate::host::call`] 路径(请求信封编码、响应解析、base64 解码全照旧),
//! 只把跨进程往返换成 `host::testhost` 里注册的同线程闭包 —— 与
//! [`crate::testkit::FakeHost`] 同一机制, 但那个替身只服务存储键, 这里服务豆瓣页面/接口。
//!
//! 用法: 按 URL 子串注册响应(先注册先匹配), `install()` 装上, 作用域结束自动摘掉。

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;

use crate::host::{testhost, HostCallRequest, HostCallResponse, HostError};

#[derive(Clone)]
struct Route {
    needle: String,
    status: i32,
    body: Vec<u8>,
}

type Callback = Box<dyn FnMut(&HostCallRequest)>;

#[derive(Default)]
struct Inner {
    routes: Vec<Route>,
    requests: Vec<HostCallRequest>,
    callback: Option<Callback>,
    fail: Option<String>,
}

/// 脚本化出站 HTTP 替身。
#[derive(Default)]
pub(crate) struct ScriptedHttp {
    inner: Rc<RefCell<Inner>>,
}

/// `install()` 的清理守卫: 离开作用域时摘掉本线程的 host.call 替身。
pub(crate) struct Guard;

impl Drop for Guard {
    fn drop(&mut self) {
        testhost::clear();
    }
}

impl ScriptedHttp {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 注册一条响应: 请求 path 含 `needle` 就返回 `status` + `body`(先注册先匹配)。
    pub(crate) fn route(&self, needle: &str, status: i32, body: Vec<u8>) {
        self.inner.borrow_mut().routes.push(Route {
            needle: needle.to_string(),
            status,
            body,
        });
    }

    /// 每个请求到达时的回调(测试里用来拨动假时钟)。
    pub(crate) fn on_request(&self, callback: impl FnMut(&HostCallRequest) + 'static) {
        self.inner.borrow_mut().callback = Some(Box::new(callback));
    }

    /// 所有出站请求直接失败(模拟宿主网络不可用)。
    pub(crate) fn fail_all(&self, message: &str) {
        self.inner.borrow_mut().fail = Some(message.to_string());
    }

    /// 装上本线程的 host.call 替身。
    pub(crate) fn install(&self) -> Guard {
        let inner = Rc::clone(&self.inner);
        testhost::install(Box::new(move |request: &HostCallRequest| handle(&inner, request)));
        Guard
    }

    /// 迄今为止收到的请求(按顺序)。
    pub(crate) fn requests(&self) -> Vec<HostCallRequest> {
        self.inner.borrow().requests.clone()
    }
}

fn handle(
    inner: &Rc<RefCell<Inner>>,
    request: &HostCallRequest,
) -> Result<HostCallResponse, HostError> {
    let mut state = inner.borrow_mut();
    state.requests.push(request.clone());
    if let Some(callback) = state.callback.as_mut() {
        callback(request);
    }
    if let Some(message) = &state.fail {
        return Err(HostError::new(message.clone()));
    }
    let matched = state
        .routes
        .iter()
        .find(|route| request.path.contains(&route.needle))
        .cloned();
    Ok(match matched {
        Some(route) => HostCallResponse {
            status: route.status,
            headers: BTreeMap::new(),
            body_base64: encode(&route.body),
        },
        // 未注册的 URL: 404 空体 —— 榜单抓取会得到 Go 那句 `HTTP 404`
        None => HostCallResponse {
            status: 404,
            headers: BTreeMap::new(),
            body_base64: String::new(),
        },
    })
}

/// 与宿主文档一致: 响应体是不补 padding 的 base64。
fn encode(body: &[u8]) -> String {
    if body.is_empty() {
        String::new()
    } else {
        STANDARD_NO_PAD.encode(body)
    }
}
