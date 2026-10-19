//! CD2 (CloudDrive2) gRPC-Web 直送模块 (0.3.19)。
//!
//! # 背景
//!
//! 宿主 5.x 起 `POST /api/local-files/copy` 禁止本地目录与 CD2/AURA 挂载目录
//! **跨边界复制**(400「本地目录和 CD2/AURA 挂载目录必须严格隔离」, 参数校验层
//! 直接拒绝、零副作用; 审计显示 2026-10-05 之后所有本地→CD2 复制全部 400)。
//! 下载产物入库改走 CD2 自己的 API: 暂存目录在 CD2 里注册成「本地文件夹」
//! (`LocalFsAPI` 存储, 一次注册幂等), 之后由 `CopyFile` 让 CD2 自己读取本地
//! 文件并上传 115 —— 与宿主策略无关。
//!
//! # 协议
//!
//! CD2 在 `:19798` 上提供 gRPC-Web(HTTP/1.1): 请求体 = 5 字节帧头
//! (`0x00` + 4 字节大端长度) + protobuf 消息; 响应 = 若干数据帧 + trailer 帧
//! (`0x80` 开头, 文本 `grpc-status:`/`grpc-message:`); **空响应体时状态放在
//! HTTP 头里**(1.0.12 实测, UNIMPLEMENTED 走这条)。鉴权 = `authorization:
//! Bearer <API 令牌>`(CD2 界面「创建 API 令牌」, 文件操作 + 挂载管理权限)。
//!
//! 全部经 `host::call` 转发: 宿主对 http/https 目标**没有 origin 白名单**
//! (host-call-v2.md §3/§4, loopback 可达), 单次总超时 10 秒 —— 本模块只用
//! 毫秒级的无状态调用(CopyFile 服务器侧立即受理, 真实传输由 CD2 异步跑),
//! 长任务进度靠 [`Cd2::copy_task`] 轮询。

use std::collections::BTreeMap;

use crate::host::{self, HostCallRequest};

/// gRPC-Web 服务名前缀(方法名拼在后面)。
const SVC_PREFIX: &str = "/clouddrive.CloudDriveFileSrv/";
/// 冲突策略: Rename(1) —— 目标重名时改名为 `xxx (1).flac`, 绝不覆盖库里的文件。
pub const CONFLICT_RENAME: u32 = 1;
/// `CopyTask.status` 取值(clouddrive.proto)。
pub const TASK_COMPLETED: u64 = 3;
/// `CopyTask.status` 失败。
pub const TASK_FAILED: u64 = 4;
/// 单次直送的兜底期限: 提交后 30 分钟仍未完成即判失败(暂存文件保留)。
pub const DELIVERY_TIMEOUT_MS: u64 = 30 * 60 * 1000;

// ─────────────────────────── protobuf 极简编解码 ───────────────────────────

/// 编码 varint。
fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(10);
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

/// `field: len-delimited string`。
fn field_str(num: u32, text: &str) -> Vec<u8> {
    let mut out = varint(u64::from(num) << 3 | 2);
    out.extend_from_slice(&varint(text.len() as u64));
    out.extend_from_slice(text.as_bytes());
    out
}

/// `field: varint`。
fn field_var(num: u32, value: u64) -> Vec<u8> {
    let mut out = varint(u64::from(num) << 3);
    out.extend_from_slice(&varint(value));
    out
}

/// gRPC-Web 帧: `0x00` + 4 字节大端长度 + 消息。
fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(0);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// 顺序拼接若干字段块(protobuf 消息就是字段块的首尾相接)。
fn concat(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(Vec::len).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

/// 解析出的一个字段值。
enum FieldVal<'a> {
    Var(u64),
    Bytes(&'a [u8]),
}

/// 宽松的 protobuf 字段游标: 遇到损坏就停止(返回 None), 不 panic。
struct FieldIter<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> FieldIter<'a> {
    fn new(data: &'a [u8]) -> Self {
        FieldIter { data, pos: 0 }
    }

    fn read_varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        let mut shift = 0u32;
        loop {
            let byte = *self.data.get(self.pos)?;
            self.pos += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
    }

    fn next_field(&mut self) -> Option<(u32, FieldVal<'a>)> {
        let tag = self.read_varint()?;
        let num = (tag >> 3) as u32;
        if num == 0 {
            return None;
        }
        match tag & 7 {
            0 => Some((num, FieldVal::Var(self.read_varint()?))),
            2 => {
                let len = self.read_varint()? as usize;
                let end = self.pos.checked_add(len)?;
                let bytes = self.data.get(self.pos..end)?;
                self.pos = end;
                Some((num, FieldVal::Bytes(bytes)))
            }
            1 => {
                let end = self.pos.checked_add(8)?;
                self.data.get(self.pos..end)?;
                self.pos = end;
                Some((num, FieldVal::Var(0)))
            }
            5 => {
                let end = self.pos.checked_add(4)?;
                self.data.get(self.pos..end)?;
                self.pos = end;
                Some((num, FieldVal::Var(0)))
            }
            _ => None,
        }
    }
}

impl<'a> Iterator for FieldIter<'a> {
    type Item = (u32, FieldVal<'a>);

    fn next(&mut self) -> Option<(u32, FieldVal<'a>)> {
        self.next_field()
    }
}

/// 取第一个 `num` 字段的字符串(key 与 value 都按 UTF-8 宽松解码)。
fn str_field(data: &[u8], num: u32) -> Option<String> {
    for (field, value) in FieldIter::new(data) {
        if field == num {
            if let FieldVal::Bytes(bytes) = value {
                return Some(String::from_utf8_lossy(bytes).into_owned());
            }
        }
    }
    None
}

/// 取第一个 `num` 字段的 varint。
fn var_field(data: &[u8], num: u32) -> Option<u64> {
    for (field, value) in FieldIter::new(data) {
        if field == num {
            if let FieldVal::Var(value) = value {
                return Some(value);
            }
        }
    }
    None
}

/// 收集全部 `num` 字段的嵌套消息。
fn msg_fields(data: &[u8], num: u32) -> Vec<&[u8]> {
    let mut out = Vec::new();
    for (field, value) in FieldIter::new(data) {
        if field == num {
            if let FieldVal::Bytes(bytes) = value {
                out.push(bytes);
            }
        }
    }
    out
}

/// 在任意一层里找第一个能当字符串看的字段(错误文本提取用)。
fn first_string(data: &[u8]) -> Option<String> {
    for (_, value) in FieldIter::new(data) {
        if let FieldVal::Bytes(bytes) = value {
            if !bytes.is_empty() {
                let text = String::from_utf8_lossy(bytes).into_owned();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

/// gRPC 的 `%XX` 转义解码(grpc-message 是 percent-encoded)。
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ─────────────────────────── gRPC-Web 往返 ───────────────────────────

/// 一次 gRPC-Web 调用的解包结果。
#[derive(Debug, Clone, Default)]
pub struct Reply {
    /// 0 = OK; 5 = NOT_FOUND; 12 = UNIMPLEMENTED; 16 = UNAUTHENTICATED …
    pub status: u32,
    /// `grpc-message`(percent 解码后)。
    pub message: String,
    /// 数据帧拼接体(状态帧除外)。
    pub data: Vec<u8>,
}

/// 解包响应: body 里的数据帧 + trailer 帧; 空响应体时退回 HTTP 头。
fn parse_reply(body: &[u8], headers: &BTreeMap<String, Vec<String>>) -> Reply {
    let mut reply = Reply::default();
    let mut pos = 0usize;
    let mut trailer: Option<String> = None;
    while pos + 5 <= body.len() {
        let flag = body[pos];
        let len = u32::from_be_bytes([body[pos + 1], body[pos + 2], body[pos + 3], body[pos + 4]])
            as usize;
        let end = match pos.checked_add(5).and_then(|start| start.checked_add(len)) {
            Some(end) if end <= body.len() => end,
            _ => break,
        };
        let payload = &body[pos + 5..end];
        if flag & 0x80 != 0 {
            trailer = Some(String::from_utf8_lossy(payload).into_owned());
        } else if flag & 1 == 0 {
            reply.data.extend_from_slice(payload);
        }
        pos = end;
    }
    let status_line = if let Some(text) = trailer {
        Some(text)
    } else {
        // 空响应体: 状态在 HTTP 头里(CD2 1.0.12 实测)。
        headers
            .get("grpc-status")
            .and_then(|values| values.first())
            .map(|value| {
                let message = headers
                    .get("grpc-message")
                    .and_then(|values| values.first())
                    .cloned()
                    .unwrap_or_default();
                format!("grpc-status: {value}\r\ngrpc-message: {message}")
            })
    };
    if let Some(text) = status_line {
        for line in text.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("grpc-status:") {
                reply.status = value.trim().parse().unwrap_or(0);
            } else if let Some(value) = line.strip_prefix("grpc-message:") {
                if reply.message.is_empty() {
                    reply.message = percent_decode(value.trim());
                }
            }
        }
    }
    reply
}

/// CD2 客户端(无状态, 每次调用现场构造即可)。
#[derive(Debug, Clone)]
pub struct Cd2 {
    /// 形如 `http://127.0.0.1:19798`(尾部 `/` 容忍)。
    pub base: String,
    /// API 令牌(绝不出现在日志/state 里)。
    pub token: String,
}

/// CD2 上的一个存储(账号/本地文件夹; `GetAllCloudApis` 的一条)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Storage {
    /// 存储类型, 本地文件夹是 `LocalFsAPI`。
    pub kind: String,
    /// 命名空间根路径(如 `/dian115AI`、`/115open`)。
    pub path: String,
}

/// 复制任务的当前快照(`GetCopyTasks` 里匹配到的一条)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CopyTaskInfo {
    /// 任务起点(**纳秒**时间戳): CD2 的 `startTime` 是"秒 + 纳秒分数"两个字段,
    /// 这里合成一个可比较的整数, 供"只认比基线新的任务"的匹配用。
    pub start_time: u64,
    pub status: u64,
    pub total_bytes: u64,
    pub uploaded_bytes: u64,
    /// 失败时的错误文本(尽力提取)。
    pub error: Option<String>,
}

impl Cd2 {
    pub fn new(base: &str, token: &str) -> Cd2 {
        Cd2 {
            base: base.trim().trim_end_matches('/').to_string(),
            token: token.trim().to_string(),
        }
    }

    /// 底层往返: 返回解包结果(含非零 grpc 状态, 由调用方决定是否当错)。
    fn call_raw(&self, method: &str, payload: &[u8]) -> Result<Reply, String> {
        let url = format!("{}{}{}", self.base, SVC_PREFIX, method);
        let request = HostCallRequest::new("POST", url.clone())
            .with_header("content-type", "application/grpc-web+proto")
            .with_header("x-grpc-web", "1")
            .with_header("accept", "application/grpc-web+proto")
            .with_header("authorization", format!("Bearer {}", self.token))
            .with_body_base64(host::encode_body_base64(&frame(payload)));
        let response =
            host::call(&request).map_err(|err| format!("host.call POST {url}: {err}"))?;
        if !(200..300).contains(&response.status) {
            return Err(format!("host.call POST {url} HTTP {}", response.status));
        }
        let body = crate::store::decode_body(&response)
            .map_err(|err| format!("host.call POST {url} 响应解码失败: {err}"))?;
        Ok(parse_reply(&body, &response.headers))
    }

    /// 调用并要求 grpc-status 0; 非零状态与消息拼成错误文本。
    fn call(&self, method: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
        let reply = self.call_raw(method, payload)?;
        if reply.status != 0 {
            return Err(reply_error(method, &reply));
        }
        Ok(reply.data)
    }

    /// 列出全部存储(`GetAllCloudApis`), 用于确认本地文件夹已注册。
    pub fn list_storages(&self) -> Result<Vec<Storage>, String> {
        let data = self.call("GetAllCloudApis", b"")?;
        Ok(msg_fields(&data, 1)
            .into_iter()
            .filter_map(|entry| {
                Some(Storage {
                    kind: str_field(entry, 1)?,
                    path: str_field(entry, 10)?,
                })
            })
            .collect())
    }

    /// 命名空间里是否已有该路径的本地文件夹存储。
    pub fn local_folder_ready(&self, namespace: &str) -> Result<bool, String> {
        Ok(self
            .list_storages()?
            .iter()
            .any(|storage| storage.kind == "LocalFsAPI" && storage.path == namespace))
    }

    /// 把宿主路径注册成 CD2「本地文件夹」(`APIAddLocalFolder`; 重复注册幂等)。
    ///
    /// 注意路由名带 `API` 前缀 —— 旧的 `AddLocalFolder` 是 UNIMPLEMENTED(实测)。
    pub fn add_local_folder(&self, host_path: &str) -> Result<bool, String> {
        let data = self.call("APIAddLocalFolder", &field_str(1, host_path))?;
        Ok(var_field(&data, 1) == Some(1))
    }

    /// 按路径查文件(`FindFileByPath`), 返回大小字节; 不存在返回 `None`。
    pub fn find_file(&self, parent: &str, name: &str) -> Result<Option<u64>, String> {
        let payload = concat(&[field_str(1, parent), field_str(2, name)]);
        let reply = self.call_raw("FindFileByPath", &payload)?;
        match reply.status {
            0 => Ok(var_field(&reply.data, 4)),
            5 => Ok(None), // NOT_FOUND
            _ => Err(reply_error("FindFileByPath", &reply)),
        }
    }

    /// 提交复制(`CopyFile`; 本地文件夹 → 云盘目录 = 上传任务, 服务器侧立即受理)。
    pub fn copy_file(&self, src: &str, dest_dir: &str, conflict_policy: u32) -> Result<(), String> {
        let payload = concat(&[
            field_str(1, src),
            field_str(2, dest_dir),
            field_var(3, u64::from(conflict_policy)),
        ]);
        let data = self.call("CopyFile", &payload)?;
        if var_field(&data, 1) == Some(1) {
            return Ok(());
        }
        let detail = str_field(&data, 2).unwrap_or_default();
        Err(format!("CD2 CopyFile 未受理: {detail}"))
    }

    /// 查与 (src, dest) 匹配的最新复制任务。
    pub fn copy_task(&self, src: &str, dest_dir: &str) -> Result<Option<CopyTaskInfo>, String> {
        let data = self.call("GetCopyTasks", b"")?;
        let mut best: Option<(u64, CopyTaskInfo)> = None;
        for entry in msg_fields(&data, 1) {
            if str_field(entry, 3).as_deref() != Some(src)
                || str_field(entry, 4).as_deref() != Some(dest_dir)
            {
                continue;
            }
            let start_time = msg_fields(entry, 17)
                .first()
                .map(|time| {
                    let sec = var_field(time, 1).unwrap_or(0);
                    let nanos = var_field(time, 2).unwrap_or(0);
                    sec.saturating_mul(1_000_000_000).saturating_add(nanos)
                })
                .unwrap_or(0);
            let info = CopyTaskInfo {
                start_time,
                status: var_field(entry, 5).unwrap_or(0),
                total_bytes: var_field(entry, 12).unwrap_or(0),
                uploaded_bytes: var_field(entry, 13).unwrap_or(0),
                error: msg_fields(entry, 15).first().and_then(|e| first_string(e)),
            };
            if best.as_ref().is_none_or(|(time, _)| start_time >= *time) {
                best = Some((start_time, info));
            }
        }
        Ok(best.map(|(_, info)| info))
    }
}

/// 把非零 grpc 状态格式化成错误文本(消息截断, 避免巨型 base64 之类灌进日志)。
fn reply_error(method: &str, reply: &Reply) -> String {
    let message = crate::util::trunc(reply.message.as_bytes());
    if message.is_empty() {
        format!("CD2 {method} grpc-{}", reply.status)
    } else {
        format!("CD2 {method} grpc-{}: {message}", reply.status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{HostCallRequest, HostCallResponse, HostError};

    /// trailer 帧: `0x80` + 长度 + 文本。
    fn grpc_trailer(status: u32, message: &str) -> Vec<u8> {
        let text = format!("grpc-status: {status}\r\ngrpc-message: {message}\r\n");
        let mut out = vec![0x80];
        out.extend_from_slice(&(text.len() as u32).to_be_bytes());
        out.extend_from_slice(text.as_bytes());
        out
    }

    /// 完整的 grpc-web 响应体 = 数据帧(+trailer)。
    fn grpc_body(payload: &[u8]) -> Vec<u8> {
        let mut body = frame(payload);
        body.extend_from_slice(&grpc_trailer(0, ""));
        body
    }

    /// 嵌套消息字段(`field: message`)。
    fn field_msg(num: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = varint(u64::from(num) << 3 | 2);
        out.extend_from_slice(&varint(payload.len() as u64));
        out.extend_from_slice(payload);
        out
    }

    fn host_response(body: &[u8]) -> Result<HostCallResponse, HostError> {
        Ok(HostCallResponse {
            status: 200,
            headers: BTreeMap::new(),
            body_base64: crate::host::encode_body_base64(body),
        })
    }

    #[test]
    fn varint_roundtrip_and_frame_prefix() {
        assert_eq!(varint(0), vec![0]);
        assert_eq!(varint(127), vec![0x7f]);
        assert_eq!(varint(300), vec![0xac, 0x02]);
        let bytes = frame(b"abc");
        assert_eq!(&bytes[..5], &[0, 0, 0, 0, 3]);
        assert_eq!(&bytes[5..], b"abc");
    }

    #[test]
    fn parse_reply_reads_trailer_frame() {
        let body = grpc_body(&field_var(1, 1));
        let reply = parse_reply(&body, &BTreeMap::new());
        assert_eq!(reply.status, 0);
        assert_eq!(var_field(&reply.data, 1), Some(1));
    }

    #[test]
    fn parse_reply_falls_back_to_http_headers() {
        // 空响应体: CD2 1.0.12 把 grpc-status 放在 HTTP 头里(UNIMPLEMENTED 实测)。
        let mut headers = BTreeMap::new();
        headers.insert("grpc-status".to_string(), vec!["12".to_string()]);
        headers.insert(
            "grpc-message".to_string(),
            vec!["get%20subfiles%20of%20%22%2F%22%20error".to_string()],
        );
        let reply = parse_reply(&[], &headers);
        assert_eq!(reply.status, 12);
        assert_eq!(reply.message, "get subfiles of \"/\" error");
    }

    #[test]
    fn percent_decode_handles_invalid_sequences() {
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn find_file_maps_not_found_to_none() {
        crate::host::testhost::install(Box::new(|request: &HostCallRequest| {
            if request.path.ends_with("/FindFileByPath") {
                return host_response(&grpc_trailer(5, "not found"));
            }
            Err(HostError::new(format!("unexpected: {}", request.path)))
        }));
        let cd2 = Cd2::new("http://127.0.0.1:19798", "t");
        assert_eq!(cd2.find_file("/115open/音乐", "x.flac").unwrap(), None);
        crate::host::testhost::clear();
    }

    #[test]
    fn find_file_reads_size_field() {
        let payload = concat(&[field_str(2, "x.flac"), field_var(4, 123456)]);
        let body = grpc_body(&payload);
        crate::host::testhost::install(Box::new(move |request: &HostCallRequest| {
            if request.path.ends_with("/FindFileByPath") {
                return host_response(&body);
            }
            Err(HostError::new(format!("unexpected: {}", request.path)))
        }));
        let cd2 = Cd2::new("http://127.0.0.1:19798", "t");
        assert_eq!(
            cd2.find_file("/115open/音乐", "x.flac").unwrap(),
            Some(123456)
        );
        crate::host::testhost::clear();
    }

    #[test]
    fn copy_file_reports_failure_message() {
        let body = grpc_body(&concat(&[field_var(1, 0), field_str(2, "目标目录不存在")]));
        crate::host::testhost::install(Box::new(move |request: &HostCallRequest| {
            if request.path.ends_with("/CopyFile") {
                return host_response(&body);
            }
            Err(HostError::new(format!("unexpected: {}", request.path)))
        }));
        let cd2 = Cd2::new("http://127.0.0.1:19798", "t");
        let err = cd2
            .copy_file("/dian115AI/a.flac", "/115open/音乐", CONFLICT_RENAME)
            .unwrap_err();
        assert!(err.contains("目标目录不存在"), "{err}");
        crate::host::testhost::clear();
    }

    #[test]
    fn add_local_folder_accepts_duplicate_registration() {
        // success=true 的响应体只有一个 #1 varint 1。
        let body = grpc_body(&field_var(1, 1));
        crate::host::testhost::install(Box::new(move |request: &HostCallRequest| {
            if request.path.ends_with("/APIAddLocalFolder") {
                return host_response(&body);
            }
            Err(HostError::new(format!("unexpected: {}", request.path)))
        }));
        let cd2 = Cd2::new("http://127.0.0.1:19798", "t");
        assert!(cd2
            .add_local_folder("/volume1/docker/dian115/dian115AI")
            .unwrap());
        crate::host::testhost::clear();
    }

    #[test]
    fn list_storages_reads_kind_and_namespace_path() {
        let mut reply = Vec::new();
        for (kind, path) in [("LocalFsAPI", "/dian115AI"), ("115open", "/115open")] {
            let entry = concat(&[
                field_str(1, kind),
                field_str(2, "acct"),
                field_str(10, path),
            ]);
            reply.extend_from_slice(&field_msg(1, &entry));
        }
        let body = grpc_body(&reply);
        crate::host::testhost::install(Box::new(move |request: &HostCallRequest| {
            if request.path.ends_with("/GetAllCloudApis") {
                return host_response(&body);
            }
            Err(HostError::new(format!("unexpected: {}", request.path)))
        }));
        let cd2 = Cd2::new("http://127.0.0.1:19798", "t");
        let storages = cd2.list_storages().unwrap();
        assert_eq!(storages.len(), 2);
        assert!(cd2.local_folder_ready("/dian115AI").unwrap());
        assert!(!cd2.local_folder_ready("/nope").unwrap());
        crate::host::testhost::clear();
    }

    #[test]
    fn copy_task_picks_latest_matching_entry() {
        let build = |sec: u64, nanos: u64, status: u64, uploaded: u64| {
            let mut entry = field_str(3, "/dian115AI/a.flac");
            entry.extend_from_slice(&field_str(4, "/115open/音乐"));
            entry.extend_from_slice(&field_var(5, status));
            entry.extend_from_slice(&field_var(12, 100));
            entry.extend_from_slice(&field_var(13, uploaded));
            // startTime 是嵌套消息: #1 秒 + #2 纳秒分数(真机形态)。
            entry.extend_from_slice(&field_msg(
                17,
                &concat(&[field_var(1, sec), field_var(2, nanos)]),
            ));
            entry
        };
        // 两条同源任务: startTime 大的一条胜出(旧任务可能仍挂在列表里)。
        let mut reply = Vec::new();
        reply.extend_from_slice(&field_msg(1, &build(1000, 5, TASK_COMPLETED, 100)));
        reply.extend_from_slice(&field_msg(1, &build(2000, 7, 1, 40)));
        let body = grpc_body(&reply);
        crate::host::testhost::install(Box::new(move |request: &HostCallRequest| {
            if request.path.ends_with("/GetCopyTasks") {
                return host_response(&body);
            }
            Err(HostError::new(format!("unexpected: {}", request.path)))
        }));
        let cd2 = Cd2::new("http://127.0.0.1:19798", "t");
        let found = cd2
            .copy_task("/dian115AI/a.flac", "/115open/音乐")
            .unwrap()
            .expect("应匹配到任务");
        assert_eq!(found.status, 1);
        assert_eq!(found.uploaded_bytes, 40);
        assert_eq!(found.total_bytes, 100);
        assert_eq!(found.start_time, 2000 * 1_000_000_000 + 7);
        assert_eq!(
            cd2.copy_task("/dian115AI/none.flac", "/115open/音乐")
                .unwrap(),
            None
        );
        crate::host::testhost::clear();
    }
}
