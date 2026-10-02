//! QQ 音乐: QQ/微信扫码登录(宿主受限, 见下) + 手动粘贴 Cookie + 搜索 + 取链(音质阶梯)。
//!
//! 从 Go 版逐函数移植, 对照表:
//!
//! | 本文件 | Go 对照 | 请求的域名(已在 manifest permissions.network 声明) |
//! |--------|---------|--------------------------------------------------|
//! | [`qr_create`] | `qqCreateQR` | 无(宿主剥离 set-cookie, 直接返回 [`QR_UNAVAILABLE`]) |
//! | [`qr_create_wx`] | `qqCreateWXQR` | `https://open.weixin.qq.com/connect/qrconnect` |
//! | [`qr_poll`] | `qqPollQR` / `qqPollWXQR` | 无(宿主剥离 set-cookie, 直接返回 [`QR_UNAVAILABLE`]) |
//! | [`save_cookie_string`] | —(替代扫码) | 无网络请求(写 KV [`COOKIE_KEY`]) |
//! | [`search`] | `qqSearch` | `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp` |
//! | [`song_url`] | `qqSongURL` | `https://u.y.qq.com/cgi-bin/musicu.fcg` |
//! | [`login_status`] | `qqCookieUin` + 会话存储 | 无网络请求(读 KV [`COOKIE_KEY`]) |
//!
//! 扫码不可用: 宿主 broker 删除外部响应的 `Set-Cookie`(`docs-ref/new-hostcall.md:220`),
//! 而 QQ 扫码的 `qrsig`(以及登录重定向链下发的 `skey`/`p_skey`/`uin`)只经
//! `Set-Cookie` 下发, 响应体里没有(实测 `ptqrshow` 只回 111x111 PNG)。因此
//! [`qr_create`] 与 QQ 分支的 [`qr_poll`] 直接返回 [`QR_UNAVAILABLE`], 登录改走
//! [`save_cookie_string`](手动粘贴浏览器 cookie); 网易云不受影响(unikey 在 JSON body 里)。
//!
//! 绿钻提示: `qqSongURL` 取不到任何链接时报 [`NO_LINK_ERROR`], 文案是
//! `所有音质均未获取到链接（需要绿钻且歌曲有对应音源）`;
//! sidecar(`app/fetch-worker.mjs:136`)的短文案 `QQ 所有音质均未取到链接（需要绿钻）`
//! 只是同一语义的另一个入口, 这里以 Go 版文案为准。
//! 音质阶梯对齐 sidecar `fetch-worker.mjs:106` 的 7 档 `QQ_LADDER`(含 `O801`/`ogg`),
//! 并按用户档位裁剪(见 [`quality_ladder`] / [`quality_start`]): `master`→全档、
//! `flac`→`F000` 起、`320`→`M800` 起、`128`→`M500` 起; 未知/空档位取全档。
//! sidecar 另有 `!isVip → [M800, M500]` 的会员裁剪, 本插件没有会员态数据源
//! (登录结果里拿不到绿钻标记), 故不移植, 只做档位裁剪。
//!
//! # 与 Go 版的已知差异
//!
//! - **微信扫码入口**: 分发层(`runtime.rs` 的 `qr-create`)只传 `source`, [`qr_create`]
//!   保持零参签名 → 只走 QQ 链路; 微信链路是 [`qr_create_wx`]。两条链路都因宿主剥离
//!   `Set-Cookie` 而无法完成, [`qr_poll`] 保留签名但直接返回 [`QR_UNAVAILABLE`]。
//! - **cookie 持久化**: Go 把 `sessions["qq"]` 放在状态文档里; 本插件按约定落在独立
//!   KV 键 [`COOKIE_KEY`] = `cookies.qq`(JSON 对象)。写入是**合并**(对齐
//!   `server.mjs` 的 `sessions.qq = { ...sessions.qq, ...jar }`), 而 Go
//!   `saveSessionCookies` 是整表覆盖。存储失败与 Go 一样**忽略**(`_ = wasmStoragePut`),
//!   登录结果不受影响。
//! - **cookie 顺序**: Go 的 `map` 遍历顺序随机, cookie 头里字段顺序不确定; 这里用
//!   `BTreeMap`(键升序), 每次请求形态稳定。
//! - **解析失败文案**: Go `encoding/json` 的报错文本无法逐字复刻,
//!   [`parse_search`] 用 serde 的文本拼在同一个 `搜索解析失败: ` 前缀后面。
//! - **越界防御**: `qqSongURL` 在响应条目多于音质阶梯时会 `ladder[i]` 越界 panic;
//!   这里跳过越界条目。
//! - **非 UTF-8 的转义**: Go 的 `url.ParseQuery` 只在 `%` 转义**非法**时报错, `%FF`
//!   这类"转义合法但字节不是 UTF-8"的段会原样保留(Go 字符串可含任意字节);
//!   [`query_unescape`] 要求解出来是合法 UTF-8, 这类段按转义失败跳过。
//!   扫码 key 的实际取值(qrsig / uuid / state)都是 ASCII, 不受影响。
//! - `host.call` 的 POST body: Go 用 `base64.StdEncoding`(带 padding), 与存储层
//!   的 RawStd 不同, 这里同样用 `STANDARD`(带 padding), 逐字节对齐。

use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::clock;
use crate::host::{self, HostCallRequest};
use crate::store;
use crate::util;

pub use crate::netease::SongUrl;

/// 取链结果(Go `qqSongURL` 的 `(url, ext, prefix, err)`; `SongUrl.level` 承载
/// QQ 的音质前缀 `AI00`/`Q001`/`F000`/`M800`…)。
pub type QqSongUrl = SongUrl;

/// Go `main.go:15` 的 `chromeUA`。
pub const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/// Go `qq.go:16` `qqQRShow`。
pub const QQ_QR_SHOW: &str = "https://ssl.ptlogin2.qq.com/ptqrshow";
/// Go `qq.go:17` `qqQRCheck`。
pub const QQ_QR_CHECK: &str = "https://ssl.ptlogin2.qq.com/ptqrlogin";
/// Go `qq.go:18` `qqWXConnect`。
pub const QQ_WX_CONNECT: &str = "https://open.weixin.qq.com/connect/qrconnect";
/// Go `qq.go:19` `qqWXCheck`。
pub const QQ_WX_CHECK: &str = "https://lp.open.weixin.qq.com/connect/l/qrconnect";
/// Go `qq.go:20` `qqWXAppID`。
pub const QQ_WX_APP_ID: &str = "wx48db31d50e334801";
/// Go `qq.go:21` `qqWXRedirect`。
pub const QQ_WX_REDIRECT: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/";
/// 登录/取链共用的 JSON 接口。
pub const QQ_MUSICU: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
/// 搜索接口(`qqSearch`)。
pub const QQ_SEARCH_API: &str = "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp";
/// 微信扫码登录页里的二维码图片前缀(`qqCreateWXQR` 的 `image_url`)。
pub const QQ_WX_QRCODE_IMG: &str = "https://open.weixin.qq.com/connect/qrcode/";

/// QQ 会话 cookie 的持久化键(约定: `store` KV, 与 Go 的 `state.sessions["qq"]` 对应)。
pub const COOKIE_KEY: &str = "cookies.qq";

/// QQ 二维码有效期秒数(Go `qqCreateQR` 的 `expires_in`)。
pub const QQ_QR_TTL_SECS: i64 = 120;
/// 微信二维码有效期秒数(Go `qqCreateWXQR` 的 `expires_in`)。
pub const QQ_WX_QR_TTL_SECS: i64 = 300;

/// `qqGet` 只收这些名字的 Set-Cookie(Go `qq.go:68-71` 的白名单)。
pub const QQ_COOKIE_NAMES: [&str; 13] = [
    "qrsig",
    "uin",
    "skey",
    "p_skey",
    "ptui_loginuin",
    "luin",
    "qqmusic_key",
    "musickey",
    "wxuin",
    "wxunionid",
    "euin",
    "tmeLoginType",
    "qqmusic_u",
];

/// 音质阶梯(sidecar `fetch-worker.mjs:106` 的 `QQ_LADDER`): 母带 → … → 128k 的
/// **命中顺序**, 文件名 = `前缀 + mid + mid + "." + 扩展名`。
/// 比 Go `qq.go` 的 6 档多一档 `O801`/`ogg`(sidecar 有, Go 没有)。
pub const QUALITY_LADDER: [(&str, &str); 7] = [
    ("AI00", "flac"),
    ("Q001", "flac"),
    ("Q000", "flac"),
    ("F000", "flac"),
    ("O801", "ogg"),
    ("M800", "mp3"),
    ("M500", "mp3"),
];

/// 用户档位 → [`QUALITY_LADDER`] 的起点(sidecar `fetch-worker.mjs:109` 的
/// `{master:0, flac:3, 320:5, 128:6}`); 未知档位返回 `None`(用全档)。
pub fn quality_start(level: &str) -> Option<usize> {
    match level.trim() {
        "master" => Some(0),
        "flac" => Some(3),
        "320" => Some(5),
        "128" => Some(6),
        _ => None,
    }
}

/// 按用户档位裁剪后的取链阶梯(未知/空档位 → 完整阶梯, 对齐 sidecar 的 `quality` 缺省)。
pub fn quality_ladder(level: &str) -> &'static [(&'static str, &'static str)] {
    match quality_start(level) {
        Some(start) => &QUALITY_LADDER[start..],
        None => &QUALITY_LADDER[..],
    }
}

/// 所有音质都取不到链接时的报错(Go `qqSongURL` 原文, 含绿钻提示)。
pub const NO_LINK_ERROR: &str = "所有音质均未获取到链接（需要绿钻且歌曲有对应音源）";

/// QQ 扫码登录不可用时的报错(替代路径: 手动粘贴 Cookie, 见 [`save_cookie_string`])。
///
/// 宿主 broker 会删除外部响应的 `Set-Cookie`(及 `location`)——
/// `docs-ref/new-hostcall.md:220`(权威副本 `host-call-v2.md` §3 同条)明确这是
/// 确定性的安全行为。QQ `ptqrshow` 的 `qrsig` **只**出现在 `Set-Cookie` 里
/// (响应体是 PNG, 实测无 `qrsig`), `ptqrlogin` 的重定向链同样靠 `Set-Cookie`
/// 下发 `skey`/`p_skey`/`uin`。因此在宿主上 QQ 扫码无法开始/完成。
pub const QR_UNAVAILABLE: &str = "QQ 扫码登录受宿主 broker 限制暂不可用，请使用手动粘贴 Cookie";

/// 扫码链路的两种来源(Go 的 `qqPollQR` 与 `qqPollWXQR`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginKind {
    /// QQ 扫码(`ptqrlogin`)。
    Qq,
    /// 微信扫码(`l/qrconnect`)。
    Wx,
}

// ─────────────────────────── 纯函数: 编码与摘要 ───────────────────────────

/// Go `qqHash33`(`qq.go:23`): 33 进制滚动哈希, 取低 31 位。
///
/// Go 的 `h` 是 64 位 `int`, 长输入会回绕; 这里用 i32 回绕运算 ——
/// 加减/左移在 2^32 下的低 32 位与 Go 在 2^64 下的低 32 位逐位相同,
/// 最后同样 `& 0x7fffffff`, 所以任意长度输入的输出都与 Go 一致。
pub fn hash33(text: &str) -> i32 {
    let mut hash: i32 = 0;
    for ch in text.chars() {
        hash = hash.wrapping_add((hash << 5).wrapping_add(ch as i32));
    }
    hash & 0x7fff_ffff
}

/// Go `net/url` 的 `QueryEscape`: 非保留字符原样, 空格变 `+`, 其余按 UTF-8 字节
/// 逐字节 `%XX`(大写十六进制)。
pub fn query_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
    out
}

/// Go `url.Values.Encode`: 键按字节序排序, 值逐个 `QueryEscape`, 以 `&` 连接。
pub fn query_encode(pairs: &[(&str, &str)]) -> String {
    let mut sorted: Vec<&(&str, &str)> = pairs.iter().collect();
    sorted.sort_by(|left, right| left.0.cmp(right.0));
    sorted
        .into_iter()
        .map(|(key, value)| format!("{}={}", query_escape(key), query_escape(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Go `url.QueryUnescape` 的等价物: `+` → 空格, `%XX` → 字节; 非法转义/非 UTF-8 → `None`。
pub fn query_unescape(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' => {
                if index + 2 >= bytes.len() {
                    return None;
                }
                let high = (bytes[index + 1] as char).to_digit(16)?;
                let low = (bytes[index + 2] as char).to_digit(16)?;
                out.push(((high << 4) | low) as u8);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Go `url.ParseQuery` 的等价物(同名键取**第一个**值, 对齐 `Values.Get`)。
/// 与 Go 逐条对齐的容错: 含 `;` 的段跳过、空段跳过、转义失败的段跳过
/// (Go 记下错误后 `continue`, 继续解析其余段)。
pub fn parse_query(raw: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for pair in raw.split('&') {
        if pair.is_empty() || pair.contains(';') {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        let key = match query_unescape(key) {
            Some(key) => key,
            None => continue,
        };
        let value = match query_unescape(value) {
            Some(value) => value,
            None => continue,
        };
        values.entry(key).or_insert(value);
    }
    values
}

/// 扫码 key 指向哪条链路(Go 里由调用方选 `qqPollQR` / `qqPollWXQR`;
/// `server.mjs` 由 key 里的 `type === 'wx'` 判定)。
pub fn login_kind_of(key: &str) -> LoginKind {
    match parse_query(key).get("type").map(String::as_str) {
        Some("wx") => LoginKind::Wx,
        _ => LoginKind::Qq,
    }
}

// ─────────────────────────── 纯函数: 请求参数构造 ───────────────────────────

/// Go `fmt.Sprintf("%.17f", float64(time.Now().UnixNano())/1e18)`(`qqCreateQR` 的 `t`)。
pub fn qr_show_t(nanos: u64) -> String {
    format!("{:.17}", nanos as f64 / 1e18)
}

/// `qqCreateQR` 的 query(Go `url.Values.Encode` 排序结果)。
pub fn qr_show_params(nanos: u64) -> String {
    let t = qr_show_t(nanos);
    query_encode(&[
        ("appid", "716027609"),
        ("e", "2"),
        ("l", "M"),
        ("s", "3"),
        ("d", "72"),
        ("v", "4"),
        ("t", t.as_str()),
        ("daid", "383"),
        ("pt_3rd_aid", "100497308"),
    ])
}

/// `qqPollQR` 的 query(Go `url.Values.Encode` 排序结果)。
pub fn qr_login_params(qrsig: &str, now_ms: i64) -> String {
    let token = hash33(qrsig).to_string();
    let action = format!("0-0-{now_ms}");
    query_encode(&[
        ("u1", "https://graph.qq.com/oauth2.0/login_jump"),
        ("ptqrtoken", token.as_str()),
        ("ptredirect", "100"),
        ("h", "1"),
        ("t", "1"),
        ("g", "1"),
        ("from_ui", "1"),
        ("ptlang", "2052"),
        ("action", action.as_str()),
        ("js_ver", "21072115"),
        ("js_type", "1"),
        ("login_sig", ""),
        ("pt_uistyle", "40"),
        ("aid", "716027609"),
        ("daid", "383"),
        ("pt_3rd_aid", "100497308"),
        ("has_onekey", "1"),
        ("pttype", "1"),
        ("service", "ptqrlogin"),
        ("nodirect", "0"),
    ])
}

/// `qqCreateWXQR` 的登录页 query。
pub fn wx_login_params(state: &str) -> String {
    query_encode(&[
        ("appid", QQ_WX_APP_ID),
        ("redirect_uri", QQ_WX_REDIRECT),
        ("response_type", "code"),
        ("scope", "snsapi_login"),
        ("state", state),
        (
            "href",
            "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect",
        ),
    ])
}

/// `qqPollWXQR` 的轮询 query。
pub fn wx_check_params(uuid: &str, now_ms: i64) -> String {
    let now = now_ms.to_string();
    query_encode(&[("uuid", uuid), ("_", now.as_str())])
}

/// `qqSearch` 的 query(`w`/`format`/`p`/`n`, 每页 20 条)。
pub fn search_params(query: &str, page: u32) -> String {
    let page = page.to_string();
    query_encode(&[("w", query), ("format", "json"), ("p", page.as_str()), ("n", "20")])
}

/// `qqSongURL` 的 `guid`(Go `fmt.Sprintf("%d", time.Now().UnixNano()%1e10)`)。
pub fn guid_from_nanos(nanos: u64) -> String {
    (nanos % 10_000_000_000).to_string()
}

/// `qqSongURL` 的 POST body(Go `json.Marshal(map[string]any{...})`;
/// `encoding/json` 与 serde_json 都按**键排序**输出对象, 形态一致)。
/// `ladder` 由调用方按用户档位裁剪(见 [`quality_ladder`])。
pub fn song_url_request_body(
    mid: &str,
    uin: &str,
    guid: &str,
    ladder: &[(&str, &str)],
) -> Vec<u8> {
    let filenames: Vec<String> = ladder
        .iter()
        .map(|(code, ext)| format!("{code}{mid}{mid}.{ext}"))
        .collect();
    let request = json!({
        "comm": {"uin": uin, "format": "json", "ct": 20, "cv": 0},
        "req_1": {
            "module": "music.vkey.GetVkey",
            "method": "UrlGetVkey",
            "param": {
                "guid": guid,
                "songmid": [mid],
                "songtype": [0],
                "uin": uin,
                "loginflag": 1,
                "platform": "20",
                "filename": filenames,
            },
        },
    });
    serde_json::to_vec(&request).unwrap_or_default()
}

/// `qqPollWXQR` 用 `wx_code` 换 cookie 的 POST body(Go `json.Marshal`);
/// `tmeLoginType` 取 Go 版的 `"1"`(`server.mjs:210` 是 `'2'`, 以 Go 版为准)。
pub fn wx_login_payload(code: &str) -> Vec<u8> {
    let payload = json!({
        "comm": {
            "tmeAppID": "qqmusic",
            "tmeLoginType": "1",
            "g_tk": 5381,
            "platform": "yqq",
            "ct": 24,
            "cv": 0,
        },
        "req": {
            "module": "music.login.LoginServer",
            "method": "Login",
            "param": {"strAppid": QQ_WX_APP_ID, "code": code},
        },
    });
    serde_json::to_vec(&payload).unwrap_or_default()
}

// ─────────────────────────── 纯函数: 响应解析 ───────────────────────────

/// `qqPollQR` 的 `'([^']*)'`(`ptuiCB(...)` 的参数列表): 依次取出单引号内的内容,
/// 空串也算一个参数(与 Go 正则一致)。
pub fn parse_js_args(body: &str) -> Vec<String> {
    let bytes = body.as_bytes();
    let mut args = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\'' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end] != b'\'' {
            end += 1;
        }
        if end >= bytes.len() {
            // 没有配对的收尾引号: Go 的正则在这里不会产生匹配, 扫描结束
            break;
        }
        match body.get(start..end) {
            Some(text) => args.push(text.to_string()),
            None => break,
        }
        index = end + 1;
    }
    args
}

/// `qqPollQR` 的 `ptuiCB` 状态码 → 状态名(Go 的 `statusMap`)。
pub fn qq_status_of(code: &str) -> &'static str {
    match code {
        "0" => "success",
        "65" => "expired",
        "66" => "waiting",
        "67" => "scanned",
        _ => "failed",
    }
}

/// `qqPollWXQR` 的 `wx_errcode` 状态码 → 状态名(Go 的 `stMap`)。
pub fn wx_status_of(code: &str) -> &'static str {
    match code {
        "405" => "success",
        "408" => "waiting",
        "404" | "402" => "expired",
        _ => "failed",
    }
}

/// Go `\s`(RE2): `[ \t\n\f\r]`。
fn skip_ascii_space(text: &str) -> &str {
    text.trim_start_matches(|ch: char| matches!(ch, ' ' | '\t' | '\n' | '\x0c' | '\r'))
}

/// 从 `wx_errcode` 的第一次**可匹配**出现处取数字(Go 正则 `wx_errcode\s*=\s*'?([0-9]+)'?`
/// 会在首个不匹配的出现处继续向后搜索)。
pub fn parse_wx_errcode(body: &str) -> Option<String> {
    let marker = "wx_errcode";
    let mut from = 0;
    while let Some(offset) = body[from..].find(marker) {
        let start = from + offset + marker.len();
        let rest = skip_ascii_space(&body[start..]);
        if let Some(rest) = rest.strip_prefix('=') {
            let rest = skip_ascii_space(rest);
            let rest = rest.strip_prefix('\'').unwrap_or(rest);
            let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return Some(digits);
            }
        }
        from = start;
    }
    None
}

/// 从 `wx_code` 的第一次可匹配出现处取值(Go 正则 `wx_code\s*=\s*["']([^"']*)["']`;
/// 捕获可以为空串)。
pub fn parse_wx_code(body: &str) -> Option<String> {
    let marker = "wx_code";
    let mut from = 0;
    while let Some(offset) = body[from..].find(marker) {
        let start = from + offset + marker.len();
        let rest = skip_ascii_space(&body[start..]);
        if let Some(rest) = rest.strip_prefix('=') {
            let rest = skip_ascii_space(rest);
            let quoted = rest.strip_prefix('"').or_else(|| rest.strip_prefix('\''));
            if let Some(rest) = quoted {
                if let Some(end) = rest.find(|ch: char| ch == '"' || ch == '\'') {
                    return Some(rest[..end].to_string());
                }
            }
        }
        from = start;
    }
    None
}

/// `[A-Za-z0-9_-]`(Go 正则里的 uuid 字符集)。
fn is_uuid_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

/// 在 `marker` 之后取一段 `[A-Za-z0-9_-]`(至少一个字符); 首个不满足的出现处继续向后找。
fn capture_after_marker(text: &str, marker: &str) -> Option<String> {
    let mut from = 0;
    while let Some(offset) = text[from..].find(marker) {
        let start = from + offset + marker.len();
        let captured: String = text[start..].chars().take_while(|ch| is_uuid_char(*ch)).collect();
        if !captured.is_empty() {
            return Some(captured);
        }
        from = start;
    }
    None
}

/// `qqCreateWXQR` 的三条 uuid 正则, 按顺序取第一个命中的:
/// `connect/l/qrconnect?uuid=([A-Za-z0-9_-]+)` →
/// `window.QRLogin.uuid\s*=\s*"([^"]+)"` → `/connect/qrcode/([A-Za-z0-9_-]+)`。
pub fn extract_wx_uuid(html: &str) -> Option<String> {
    if let Some(uuid) = capture_after_marker(html, "connect/l/qrconnect?uuid=") {
        return Some(uuid);
    }
    if let Some(uuid) = qrlogin_uuid(html) {
        return Some(uuid);
    }
    capture_after_marker(html, "/connect/qrcode/")
}

/// 第二条正则 `window\.QRLogin\.uuid\s*=\s*"([^"]+)"`。
fn qrlogin_uuid(html: &str) -> Option<String> {
    let marker = "window.QRLogin.uuid";
    let mut from = 0;
    while let Some(offset) = html[from..].find(marker) {
        let start = from + offset + marker.len();
        let rest = skip_ascii_space(&html[start..]);
        if let Some(rest) = rest.strip_prefix('=') {
            let rest = skip_ascii_space(rest);
            if let Some(rest) = rest.strip_prefix('"') {
                if let Some(end) = rest.find('"') {
                    let uuid = &rest[..end];
                    if !uuid.is_empty() {
                        return Some(uuid.to_string());
                    }
                }
            }
        }
        from = start;
    }
    None
}

/// `qqSongURL` 的响应体 → `(url, ext, 音质前缀)`; 没有任何 `http` 开头的 `purl` 时
/// 报 [`NO_LINK_ERROR`], JSON 解析失败报 `QQ 取链解析失败`。
/// `ladder` 必须与请求体用的是同一条(索引对应请求里的 `filename` 顺序)。
pub fn parse_vkey_response(
    body: &[u8],
    ladder: &[(&str, &str)],
) -> Result<(String, String, String), String> {
    let parsed: VkeyRoot = serde_json::from_slice(body).map_err(|_| "QQ 取链解析失败".to_string())?;
    for (index, info) in parsed.req_1.data.midurlinfo.iter().enumerate() {
        if info.purl.starts_with("http") {
            // Go 这里是 ladder[i], 越界会 panic; 这里跳过越界条目
            if let Some((code, ext)) = ladder.get(index) {
                return Ok((info.purl.clone(), (*ext).to_string(), (*code).to_string()));
            }
        }
    }
    Err(NO_LINK_ERROR.to_string())
}

/// `qqSearch` 的响应体 → `{songs, page}`(Go 的匿名结构体 + 逐条映射)。
pub fn parse_search(body: &[u8], page: u32) -> Result<Value, String> {
    let parsed: SearchRoot =
        serde_json::from_slice(body).map_err(|err| format!("搜索解析失败: {err}"))?;
    let mut songs = Vec::new();
    for song in parsed.data.song.list {
        let artists: Vec<String> = song.singer.into_iter().map(|singer| singer.name).collect();
        let quality = if song.sizeflac > 0 {
            "flac"
        } else if song.size320 > 0 {
            "320"
        } else {
            "128"
        };
        songs.push(json!({
            "id": song.songmid,
            "name": song.songname,
            "singers": artists.join("/"),
            "album": song.albumname,
            "duration_s": song.interval,
            "source": "qq",
            "quality": quality,
        }));
    }
    Ok(json!({"songs": songs, "page": page}))
}

/// Go 结构体字段的零值语义: 缺失或 `null` → 零值, 类型不符 → 报错。
fn null_to_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Default, Deserialize)]
struct VkeyRoot {
    #[serde(default, deserialize_with = "null_to_default")]
    req_1: VkeyReq,
}

#[derive(Debug, Default, Deserialize)]
struct VkeyReq {
    #[serde(default, deserialize_with = "null_to_default")]
    data: VkeyData,
}

#[derive(Debug, Default, Deserialize)]
struct VkeyData {
    #[serde(default, deserialize_with = "null_to_default")]
    midurlinfo: Vec<VkeyInfo>,
}

#[derive(Debug, Default, Deserialize)]
struct VkeyInfo {
    #[serde(default, deserialize_with = "null_to_default")]
    purl: String,
    #[serde(default, deserialize_with = "null_to_default")]
    #[allow(dead_code)]
    vkey: String,
}

#[derive(Debug, Default, Deserialize)]
struct SearchRoot {
    #[serde(default, deserialize_with = "null_to_default")]
    data: SearchData,
}

#[derive(Debug, Default, Deserialize)]
struct SearchData {
    #[serde(default, deserialize_with = "null_to_default")]
    song: SearchSong,
}

#[derive(Debug, Default, Deserialize)]
struct SearchSong {
    #[serde(default, deserialize_with = "null_to_default")]
    list: Vec<SearchSongItem>,
}

#[derive(Debug, Default, Deserialize)]
struct SearchSongItem {
    /// Go 结构体里有 `songid`, 但搜索结果里不使用; 保留字段是为了对齐类型校验。
    #[serde(default, deserialize_with = "null_to_default")]
    #[allow(dead_code)]
    songid: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    songmid: String,
    #[serde(default, deserialize_with = "null_to_default")]
    songname: String,
    #[serde(default, deserialize_with = "null_to_default")]
    albumname: String,
    #[serde(default, deserialize_with = "null_to_default")]
    interval: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    sizeflac: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    size320: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    #[allow(dead_code)]
    size128: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    singer: Vec<SearchSinger>,
}

#[derive(Debug, Default, Deserialize)]
struct SearchSinger {
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
}

// ─────────────────────────── 纯函数: cookie 处理 ───────────────────────────

/// Go `qqCookieUin`: `uin` 去掉一个 `o` 前缀、再去掉一个 `0` 前缀;
/// 键不存在返回 `"0"`, 键存在但为空返回空串(与 Go 的 `TrimPrefix` 链一致)。
pub fn uin_from_cookies(cookies: &BTreeMap<String, String>) -> String {
    match cookies.get("uin") {
        None => "0".to_string(),
        Some(uin) => {
            let uin = uin.strip_prefix('o').unwrap_or(uin);
            let uin = uin.strip_prefix('0').unwrap_or(uin);
            uin.to_string()
        }
    }
}

/// Go `qqCookieHeader` / `server.mjs:76` 的 `cookieOf`: `k=v` 以 `; ` 连接。
/// (Go 的 map 顺序随机; 这里按 `BTreeMap` 键升序, 是其中一个合法排列。)
pub fn cookie_header(cookies: &BTreeMap<String, String>) -> String {
    cookies
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// 响应头里所有 `set-cookie` 行(名字大小写不敏感, 保持宿主给出的顺序)。
pub fn set_cookie_lines(headers: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let mut lines = Vec::new();
    for (name, values) in headers {
        if name.eq_ignore_ascii_case("set-cookie") {
            lines.extend(values.iter().cloned());
        }
    }
    lines
}

/// 逐行解析 Set-Cookie(Go 的 `strings.Split(line, ", ")` + `SplitN(seg, "=", 2)`)。
///
/// - `allowed = Some(名单)`: `qqGet` 的白名单过滤(不在名单/`__Host-` 前缀 → 跳过);
/// - `allowed = None`: 重定向链与微信登录用的无过滤收集(照单全收)。
pub fn parse_set_cookie_line(
    line: &str,
    allowed: Option<&[&str]>,
    out: &mut BTreeMap<String, String>,
) {
    for segment in line.split(", ") {
        let (raw_name, raw_value) = match segment.split_once('=') {
            Some(pair) => pair,
            None => continue,
        };
        let name = raw_name.trim();
        if let Some(allowed) = allowed {
            if raw_name.starts_with("__Host-") || !allowed.contains(&name) {
                continue;
            }
        }
        let value = raw_value.split(';').next().unwrap_or("");
        out.insert(name.to_string(), value.to_string());
    }
}

/// 收集响应头里的 Set-Cookie(`allowed` 语义见 [`parse_set_cookie_line`])。
pub fn collect_set_cookies(
    headers: &BTreeMap<String, Vec<String>>,
    allowed: Option<&[&str]>,
) -> BTreeMap<String, String> {
    let mut cookies = BTreeMap::new();
    for line in set_cookie_lines(headers) {
        parse_set_cookie_line(&line, allowed, &mut cookies);
    }
    cookies
}

/// Go `qqPollQR` / `qqPollWXQR` 的 cookie 规范化: 补齐 `uin` 与 `qqmusic_key`。
pub fn normalize_cookies(jar: &mut BTreeMap<String, String>, kind: LoginKind) {
    let uin_missing = jar.get("uin").map_or(true, String::is_empty);
    if uin_missing {
        let candidates: &[&str] = match kind {
            LoginKind::Qq => &["ptui_loginuin", "luin", "wxuin"],
            LoginKind::Wx => &["wxuin"],
        };
        for name in candidates {
            match jar.get(*name) {
                Some(value) if !value.is_empty() => {
                    jar.insert("uin".to_string(), value.clone());
                    break;
                }
                _ => {}
            }
        }
    }
    let key_missing = jar.get("qqmusic_key").map_or(true, String::is_empty);
    if key_missing {
        for name in ["p_skey", "skey", "musickey"] {
            match jar.get(name) {
                Some(value) if !value.is_empty() => {
                    jar.insert("qqmusic_key".to_string(), value.clone());
                    break;
                }
                _ => {}
            }
        }
    }
}

// ─────────────────────────── 会话存储(KV `cookies.qq`) ───────────────────────────

/// 幂等键序列: 同一 worker 会话内每次写入取号, 保证键唯一。
static COOKIE_PUT_IDS: std::sync::Mutex<store::PutIds> =
    std::sync::Mutex::new(store::PutIds::new());

/// 读取已保存的 QQ cookie(宿主不可读/值损坏 → 空表, 对齐 Go 读状态失败即视为无会话)。
pub fn load_cookies() -> BTreeMap<String, String> {
    let (raw, ok) = store::get(COOKIE_KEY);
    if !ok || raw.is_empty() {
        return BTreeMap::new();
    }
    serde_json::from_slice(&raw).unwrap_or_default()
}

/// 合并写入 cookie(`server.mjs:274` 的 `{ ...sessions.qq, ...jar }` 语义)。
fn save_cookies(cookies: &BTreeMap<String, String>) -> Result<(), String> {
    let mut merged = load_cookies();
    for (name, value) in cookies {
        merged.insert(name.clone(), value.clone());
    }
    let data = serde_json::to_vec(&merged).map_err(|err| format!("cookie 序列化失败: {err}"))?;
    let mut ids = COOKIE_PUT_IDS
        .lock()
        .map_err(|_| "cookie 幂等键锁失效".to_string())?;
    store::put(&mut ids, COOKIE_KEY, &data).map_err(|err| err.to_string())
}

/// 公开的合并入口(CookieCloud 同步用, 0.3.4): 语义与 [`save_cookies`] 一致 ——
/// 已存字段保留、同名字段覆盖([`save_cookie_string`] 走的是"先清洗再合并"的
/// 完整链路, 而同步侧在 [`crate::cookiecloud`] 里已完成白名单过滤与
/// [`normalize_cookies`], 这里只负责落盘)。
pub fn merge_cookies(cookies: &BTreeMap<String, String>) -> Result<(), String> {
    save_cookies(cookies)
}

/// 把 cookie 头拼好: 已保存的会话 cookie + 调用方附加的 `extra`。
fn cookie_with_extra(extra: &str) -> String {
    let existing = cookie_header(&load_cookies());
    if extra.is_empty() {
        return existing;
    }
    if existing.is_empty() {
        return extra.to_string();
    }
    format!("{existing}; {extra}")
}

/// 手动粘贴的 QQ cookie 串 → 清洗 → 合并写入 KV [`COOKIE_KEY`]。
///
/// 宿主剥离 `Set-Cookie` 导致 QQ 扫码不可用(见 [`QR_UNAVAILABLE`]), 这是登录的
/// 替代路径: 用户从浏览器开发者工具复制 QQ 音乐域名下的 `Cookie` 头(形如
/// `uin=o123; qqmusic_key=@abc; p_skey=...`), 这里逐段解析。
///
/// - 只保留 [`QQ_COOKIE_NAMES`] 白名单里的 `name=value`(大小写敏感, 与
///   [`parse_set_cookie_line`] 的白名单一致); 其余段(如 `Path`/`Domain`/`expires`)
///   直接丢弃;
/// - 值保留第一个 `=` 之后的全部内容并去掉首尾空白;
/// - 缺少 `qqmusic_key`(且无法从 `p_skey`/`skey`/`musickey` 补齐)时视为无效 cookie。
pub fn save_cookie_string(raw: &str) -> Result<Value, String> {
    let mut jar = BTreeMap::new();
    for segment in raw.split(';') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let (name, value) = match segment.split_once('=') {
            Some(pair) => pair,
            None => continue,
        };
        let name = name.trim();
        if !QQ_COOKIE_NAMES.contains(&name) {
            continue;
        }
        jar.insert(name.to_string(), value.trim().to_string());
    }
    normalize_cookies(&mut jar, LoginKind::Qq);
    if jar.get("qqmusic_key").map_or(true, String::is_empty) {
        return Err(
            "粘贴的 cookie 缺少登录凭据（需要 qqmusic_key, 或可补齐的 p_skey/skey/musickey）"
                .to_string(),
        );
    }
    save_cookies(&jar)?;
    Ok(json!({
        "source": "qq",
        "logged_in": true,
        "saved": jar.len(),
        "uin": uin_from_cookies(&jar),
        "has_key": true,
    }))
}

// ─────────────────────────── 网络: qqGet ───────────────────────────

/// Go `qqGet`: GET + 收集 Set-Cookie, 返回 `(status, body, cookies)`;
/// 网络失败(status 0)与 Go 一样带回空 body/空 cookie 表。
fn qq_get(api_url: &str, referer: &str, extra_cookie: &str) -> (i32, Vec<u8>, BTreeMap<String, String>) {
    let cookie = cookie_with_extra(extra_cookie);
    let request = HostCallRequest::new("GET", api_url)
        .with_header("user-agent", CHROME_UA)
        .with_header("referer", referer)
        .with_header("cookie", cookie);
    let response = match host::call(&request) {
        Ok(response) => response,
        Err(_) => return (0, Vec::new(), BTreeMap::new()),
    };
    let cookies = collect_set_cookies(&response.headers, Some(QQ_COOKIE_NAMES.as_slice()));
    let body = store::decode_body(&response).unwrap_or_default();
    (response.status, body, cookies)
}

// ─────────────────────────── 对外: 扫码 ───────────────────────────

/// QQ 扫码创建: 宿主 broker 会剥离 `Set-Cookie`(见 [`QR_UNAVAILABLE`]),
/// `ptqrshow` 的 `qrsig` 在插件侧永远拿不到, 因此接口保留但直接返回明确错误。
/// 登录改走 [`save_cookie_string`](手动粘贴浏览器 cookie)。
pub fn qr_create() -> Result<Value, String> {
    Err(QR_UNAVAILABLE.to_string())
}

/// 微信扫码创建(Go `qqCreateWXQR`): 返回 `{key, login_type, image_mode, image_url, expires_in}`。
///
/// 分发层(`qr-create`)的签名只带 `source`, 走不到这条链路, 因此单独导出。
pub fn qr_create_wx() -> Result<Value, String> {
    let state = format!("musicdl-{}", clock::now_unix_nanos());
    let params = wx_login_params(&state);
    let (status, body, _) =
        qq_get(&format!("{QQ_WX_CONNECT}?{params}"), "https://y.qq.com/", "");
    if status != 200 {
        return Err(format!("微信二维码获取失败: HTTP {status}"));
    }
    let html = util::go_lossy(&body);
    let uuid = match extract_wx_uuid(&html) {
        Some(uuid) => uuid,
        None => return Err("微信二维码 uuid 缺失".to_string()),
    };
    Ok(json!({
        "source": "qq",
        "login_type": "wx",
        "key": query_encode(&[
            ("type", "wx"),
            ("uuid", uuid.as_str()),
            ("state", state.as_str()),
        ]),
        "image_mode": "url",
        "image_url": format!("{QQ_WX_QRCODE_IMG}{uuid}"),
        "expires_in": QQ_WX_QR_TTL_SECS,
    }))
}

/// 扫码轮询(Go `qqPollQR` / `qqPollWXQR`): 接口保留, 但宿主剥离 `Set-Cookie`
/// 使两条链路都无法完成(见 [`QR_UNAVAILABLE`]), 因此直接返回明确错误。
///
/// 原 `qqPollQR` / `qqPollWXQR` 的重定向收 cookie 逻辑依赖 `Set-Cookie`/`location`,
/// 在宿主上必然拿不到值; 登录改走 [`save_cookie_string`]。
pub fn qr_poll(_key: &str) -> Result<Value, String> {
    Err(QR_UNAVAILABLE.to_string())
}

// ─────────────────────────── 对外: 搜索 / 取链 / 登录态 ───────────────────────────

/// 单曲搜索(Go `qqSearch`): `page` 从 1 起, 每页 20 条。
pub fn search(query: &str, page: u32) -> Result<Value, String> {
    let params = search_params(query, page);
    let request =
        HostCallRequest::new("GET", format!("{QQ_SEARCH_API}?{params}"))
            .with_header("user-agent", CHROME_UA)
            .with_header("referer", "https://y.qq.com/")
            .with_header("cookie", cookie_header(&load_cookies()));
    let response = host::call(&request).map_err(|err| err.to_string())?;
    let body = store::decode_body(&response).unwrap_or_default();
    parse_search(&body, page)
}

/// 按音质阶梯取链(Go `qqSongURL` 的流程 + sidecar 的档位裁剪): 从用户档位对应
/// 的阶梯起点开始, 逐级向下直到命中第一条 `http` 直链。
pub fn song_url(mid: &str, level: &str) -> Result<SongUrl, String> {
    let cookies = load_cookies();
    let uin = uin_from_cookies(&cookies);
    let guid = guid_from_nanos(clock::now_unix_nanos());
    let ladder = quality_ladder(level);
    let payload = song_url_request_body(mid, &uin, &guid, ladder);
    let request = HostCallRequest::new("POST", QQ_MUSICU)
        .with_header("content-type", "application/json")
        .with_header("user-agent", CHROME_UA)
        .with_header("referer", "https://y.qq.com/")
        .with_header("cookie", cookie_header(&cookies))
        .with_body_base64(BASE64_STANDARD.encode(&payload));
    let response = host::call(&request).map_err(|err| err.to_string())?;
    let body = store::decode_body(&response).unwrap_or_default();
    let (url, ext, level) = parse_vkey_response(&body, ladder)?;
    Ok(SongUrl {
        url,
        ext,
        level,
        size: 0,
    })
}

/// 登录态查询(Go 版从 `state.sessions["qq"]` 读 cookie 是否还在; 这里是 KV [`COOKIE_KEY`])。
///
/// `logged_in` 以"有 `qqmusic_key` 凭据"为准(手动粘贴的 cookie 若只有零散字段,
/// 不算登录成功); `uin` 供 UI 显示账号。
pub fn login_status() -> Result<Value, String> {
    let cookies = load_cookies();
    let has_key = cookies.get("qqmusic_key").map_or(false, |value| !value.is_empty());
    Ok(json!({
        "source": "qq",
        "logged_in": has_key,
        "has_key": has_key,
        "uin": uin_from_cookies(&cookies),
    }))
}

// 需要宿主替身的流程用例放在这里(与 douban-rs 同一约定: `host::testhost` 是
// pub(crate), 集成测试装不了替身); 不联网的纯函数向量在 `tests/qq.rs`。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock;
    use crate::host::{HostCallResponse, HostError};
    use std::cell::RefCell;
    use std::rc::Rc;

    /// 固定时钟: 2026-07-29 前后的一个纳秒时间戳(毫秒 = 1790676009123)。
    const NOW_NANOS: u64 = 1_790_676_009_123_456_789;

    struct FixedNow;
    fn fix_now() -> FixedNow {
        clock::testhooks::set_now(Some(NOW_NANOS));
        FixedNow
    }
    impl Drop for FixedNow {
        fn drop(&mut self) {
            clock::testhooks::set_now(None);
        }
    }

    /// 宿主替身: 测试结束(含 panic)时自动卸载, 不污染同线程的后续用例。
    struct StubGuard;
    fn install_stub(
        handler: impl FnMut(&HostCallRequest) -> Result<HostCallResponse, HostError> + 'static,
    ) -> StubGuard {
        crate::host::testhost::install(Box::new(handler));
        StubGuard
    }
    impl Drop for StubGuard {
        fn drop(&mut self) {
            crate::host::testhost::clear();
        }
    }

    fn response(status: i32, headers: &[(&str, &[&str])], body: &[u8]) -> HostCallResponse {
        let mut map = BTreeMap::new();
        for (name, values) in headers {
            map.insert(
                name.to_string(),
                values.iter().map(|value| value.to_string()).collect(),
            );
        }
        HostCallResponse { status, headers: map, body_base64: host::encode_body_base64(body) }
    }

    /// 存储请求的默认回复: 读 404(无会话), 写 200。
    fn storage_reply(method: &str) -> HostCallResponse {
        if method == "PUT" {
            response(200, &[], b"")
        } else {
            response(404, &[], b"")
        }
    }

    /// 请求记录: `METHOD path cookie=<值|-> body=<body_base64>`。
    fn call_log(sink: &Rc<RefCell<Vec<String>>>, request: &HostCallRequest) {
        sink.borrow_mut().push(format!(
            "{} {} cookie={} body={}",
            request.method,
            request.path,
            request.headers.get("cookie").map(String::as_str).unwrap_or("-"),
            request.body_base64
        ));
    }

    // ─────────────────── 扫码创建 ───────────────────

    /// 宿主剥离 Set-Cookie → qrsig 拿不到, `qr_create` 不发请求, 直接返回明确错误。
    #[test]
    fn qr_create_reports_host_limit_without_network() {
        let calls: Rc<RefCell<Vec<String>>> = Default::default();
        let sink = calls.clone();
        let _stub = install_stub(move |request| {
            call_log(&sink, request);
            Ok(storage_reply(request.method.as_str()))
        });
        assert_eq!(qr_create().unwrap_err(), QR_UNAVAILABLE);
        assert!(calls.borrow().is_empty(), "不应发起任何宿主调用");
    }

    #[test]
    fn qr_create_reports_http_and_missing_qrsig() {
        let _now = fix_now();
        // qr_create 已不联网; 该用例保留用于守住"扫码不可用"的错误文案。
        assert_eq!(qr_create().unwrap_err(), QR_UNAVAILABLE);
    }

    #[test]
    fn qr_create_wx_extracts_uuid_or_reports_failure() {
        let _stub = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(
                200,
                &[],
                br#"<script src="https://open.weixin.qq.com/connect/l/qrconnect?uuid=Ab12Cd3E-"></script>"#,
            ))
        });
        let _now = fix_now();
        let value = qr_create_wx().unwrap();
        assert_eq!(value["source"], "qq");
        assert_eq!(value["login_type"], "wx");
        // key 与 Go url.Values.Encode 同形: 键排序
        assert_eq!(value["key"], "state=musicdl-1790676009123456789&type=wx&uuid=Ab12Cd3E-");
        assert_eq!(value["image_mode"], "url");
        assert_eq!(value["image_url"], "https://open.weixin.qq.com/connect/qrcode/Ab12Cd3E-");
        assert_eq!(value["expires_in"], 300);

        let _stub2 = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(200, &[], b"<html>no uuid here</html>"))
        });
        assert_eq!(qr_create_wx().unwrap_err(), "微信二维码 uuid 缺失");

        let _stub3 = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(500, &[], b""))
        });
        assert_eq!(qr_create_wx().unwrap_err(), "微信二维码获取失败: HTTP 500");
    }

    // ─────────────────── 扫码轮询(宿主受限, 恒返回明确错误) ───────────────────

    #[test]
    fn qr_poll_reports_host_limit() {
        assert_eq!(qr_poll("").unwrap_err(), QR_UNAVAILABLE);
        assert_eq!(qr_poll("other=1").unwrap_err(), QR_UNAVAILABLE);
        assert_eq!(qr_poll("qrsig=Ab12Cd3-").unwrap_err(), QR_UNAVAILABLE);
        assert_eq!(qr_poll("type=wx&uuid=WxUuId-1").unwrap_err(), QR_UNAVAILABLE);
    }

    // ─────────────────── 搜索 ───────────────────

    #[test]
    fn search_maps_songs_like_go() {
        let _stub = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(response(
                    200,
                    &[],
                    br#"{"data":{"key":"cookies.qq","value":{"uin":"o0012345678","qqmusic_key":"@K"},"revision":"pkv_1"}}"#,
                ));
            }
            assert_eq!(
                request.path,
                format!("{QQ_SEARCH_API}?format=json&n=20&p=1&w=%E6%99%B4%E5%A4%A9")
            );
            assert_eq!(
                request.headers.get("cookie").map(String::as_str),
                Some("qqmusic_key=@K; uin=o0012345678")
            );
            Ok(response(
                200,
                &[],
                r#"{"code":0,"data":{"song":{"list":[{"songid":4830702,"songmid":"003aAYrm3GE0Xg","songname":"晴天","albumname":"叶惠美","interval":269,"sizeflac":0,"size320":9434136,"size128":4307652,"singer":[{"name":"周杰伦"},{"name":"杨瑞代"}]}]}}}"#
                    .as_bytes(),
            ))
        });
        let value = search("晴天", 1).unwrap();
        assert_eq!(value["page"], 1);
        assert_eq!(value["songs"][0]["id"], "003aAYrm3GE0Xg");
        assert_eq!(value["songs"][0]["name"], "晴天");
        assert_eq!(value["songs"][0]["singers"], "周杰伦/杨瑞代");
        assert_eq!(value["songs"][0]["album"], "叶惠美");
        assert_eq!(value["songs"][0]["duration_s"], 269);
        assert_eq!(value["songs"][0]["source"], "qq");
        assert_eq!(value["songs"][0]["quality"], "320");
    }

    #[test]
    fn search_reports_parse_and_network_failures() {
        let _stub = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(200, &[], b"not json"))
        });
        let err = search("晴天", 1).unwrap_err();
        assert!(err.starts_with("搜索解析失败: "), "实际: {err}");

        let _stub2 = install_stub(|_request| Err(HostError::new("host_call 返回长度 0")));
        assert_eq!(search("晴天", 1).unwrap_err(), "host_call 返回长度 0");
    }

    // ─────────────────── 取链 ───────────────────

    #[test]
    fn song_url_posts_ladder_and_picks_first_http() {
        const MID: &str = "003aAYrm3GE0Xg";
        let calls: Rc<RefCell<Vec<String>>> = Default::default();
        let sink = calls.clone();
        let _stub = install_stub(move |request| {
            call_log(&sink, request);
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(
                200,
                &[],
                br#"{"req_1":{"data":{"midurlinfo":[{"purl":""},{"purl":""},{"purl":""},{"purl":"https://dl.stream.qqmusic.qq.com/F000003aAYrm3GE0Xg003aAYrm3GE0Xg.flac?vkey=1"}]}}}"#,
            ))
        });
        let _now = fix_now();
        let song = song_url(MID, "").unwrap();
        assert_eq!(
            song.url,
            "https://dl.stream.qqmusic.qq.com/F000003aAYrm3GE0Xg003aAYrm3GE0Xg.flac?vkey=1"
        );
        assert_eq!(song.ext, "flac");
        assert_eq!(song.level, "F000");
        assert_eq!(song.size, 0);

        // 请求体: uin 缺省 "0", guid = UnixNano % 1e10, 文件名 = 前缀+mid+mid+扩展名
        let calls = calls.borrow();
        let posted = calls
            .iter()
            .find(|call| call.starts_with(&format!("POST {QQ_MUSICU}")))
            .expect("必须有取链 POST");
        let posted_body = posted.rsplit("body=").next().unwrap_or("");
        let decoded = BASE64_STANDARD.decode(posted_body.as_bytes()).unwrap();
        assert_eq!(decoded, song_url_request_body(MID, "0", "9123456789", quality_ladder("")));
    }

    #[test]
    fn song_url_reports_green_diamond_and_parse_failures() {
        let _now = fix_now();
        let _stub = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(
                200,
                &[],
                br#"{"req_1":{"data":{"midurlinfo":[{"purl":""},{"purl":""},{"purl":""},{"purl":""},{"purl":""},{"purl":""}]}}}"#,
            ))
        });
        assert_eq!(
            song_url("003aAYrm3GE0Xg", "").unwrap_err(),
            "所有音质均未获取到链接（需要绿钻且歌曲有对应音源）"
        );

        let _stub2 = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(200, &[], b"<html>502</html>"))
        });
        assert_eq!(song_url("003aAYrm3GE0Xg", "").unwrap_err(), "QQ 取链解析失败");
    }

    /// 用户档位参与取链: `320` 只请求 `M800`/`M500` 两档, 命中即报 `M800`。
    #[test]
    fn song_url_honors_requested_quality() {
        const MID: &str = "003aAYrm3GE0Xg";
        let calls: Rc<RefCell<Vec<String>>> = Default::default();
        let sink = calls.clone();
        let _stub = install_stub(move |request| {
            call_log(&sink, request);
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            // 只有请求阶梯的第 0 条(M800)有直链
            Ok(response(
                200,
                &[],
                br#"{"req_1":{"data":{"midurlinfo":[{"purl":"https://dl.stream.qqmusic.qq.com/M800003aAYrm3GE0Xg003aAYrm3GE0Xg.mp3?vkey=1"},{"purl":""}]}}}"#,
            ))
        });
        let _now = fix_now();
        let song = song_url(MID, "320").unwrap();
        assert_eq!(song.level, "M800");
        assert_eq!(song.ext, "mp3");

        let calls = calls.borrow();
        let posted = calls
            .iter()
            .find(|call| call.starts_with(&format!("POST {QQ_MUSICU}")))
            .expect("必须有取链 POST");
        let posted_body = posted.rsplit("body=").next().unwrap_or("");
        let decoded = BASE64_STANDARD.decode(posted_body.as_bytes()).unwrap();
        // 请求体只含 M800/M500 两条 filename
        assert_eq!(decoded, song_url_request_body(MID, "0", "9123456789", quality_ladder("320")));
        let text = String::from_utf8(decoded).unwrap();
        assert!(text.contains("M800003aAYrm3GE0Xg003aAYrm3GE0Xg.mp3"));
        assert!(text.contains("M500003aAYrm3GE0Xg003aAYrm3GE0Xg.mp3"));
        assert!(!text.contains("AI00"));
        assert!(!text.contains("O801"));
    }

    // ─────────────────── 登录态 ───────────────────

    #[test]
    fn login_status_reads_kv() {
        let _stub = install_stub(|request| {
            if request.path != "/api/plugin-runtime/storage/cookies.qq" {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(
                200,
                &[],
                br#"{"data":{"key":"cookies.qq","value":{"uin":"o0012345678","qqmusic_key":"@K"},"revision":"pkv_2"}}"#,
            ))
        });
        let value = login_status().unwrap();
        assert_eq!(value["logged_in"], true);
        assert_eq!(value["source"], "qq");
        // 夹具 uin=o0012345678 经 Go 的 TrimPrefix 链(o → 一层 0)得到 012345678
        assert_eq!(value["uin"], "012345678");

        let _stub2 = install_stub(|_request| Ok(response(404, &[], b"")));
        assert_eq!(login_status().unwrap()["logged_in"], false);
    }

    // ─────────────────── 手动粘贴 Cookie(扫码不可用的替代路径) ───────────────────

    #[test]
    fn save_cookie_string_cleans_whitelists_and_persists() {
        let calls: Rc<RefCell<Vec<String>>> = Default::default();
        let sink = calls.clone();
        let _stub = install_stub(move |request| {
            call_log(&sink, request);
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(500, &[], b""))
        });
        // 混杂浏览器 Cookie 头: 白名单外的段(Path/Domain/其它域 cookie)被丢弃,
        // uin 去掉 o 前缀, qqmusic_key 原样保留。
        let info = save_cookie_string(
            "other=x; uin=o0012345678; qqmusic_key=@K; Path=/; Domain=y.qq.com; skey=@S",
        )
        .unwrap();
        assert_eq!(info["source"], "qq");
        assert_eq!(info["logged_in"], true);
        assert_eq!(info["uin"], "012345678");
        assert_eq!(info["has_key"], true);

        let calls = calls.borrow();
        let put = calls
            .iter()
            .find(|call| call.starts_with("PUT /api/plugin-runtime/storage/cookies.qq"))
            .expect("必须落 KV");
        let body = put.rsplit("body=").next().unwrap_or("");
        assert_eq!(
            body,
            host::encode_body_base64(
                br#"{"value":{"qqmusic_key":"@K","skey":"@S","uin":"o0012345678"}}"#
            )
        );
    }

    #[test]
    fn save_cookie_string_fills_key_and_rejects_useless_input() {
        // 没有 qqmusic_key, 但能从 p_skey 补齐; 无 uin 时从 ptui_loginuin 补齐。
        let _stub = install_stub(|request| {
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(storage_reply(request.method.as_str()));
            }
            Ok(response(500, &[], b""))
        });
        let info = save_cookie_string("ptui_loginuin=123456789; p_skey=@PS").unwrap();
        assert_eq!(info["has_key"], true);
        assert_eq!(info["uin"], "123456789");

        // 完全没有可用凭据 → 明确报错, 不写 KV。
        assert!(save_cookie_string("Path=/; Domain=y.qq.com").is_err());
        assert!(save_cookie_string("").is_err());
    }
}
