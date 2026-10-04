//! 网易云音乐: 搜索 / eapi 取链 / 扫码登录。
//!
//! 移植来源两处:
//! - `plugins/music-dl/runtime/netease.go` —— 协议主体(eapi 加解密、搜索、
//!   取链、扫码 create/poll、cookie 读写);
//! - sidecar `sidecars/music-agent/app/server.mjs` + `fetch-worker.mjs` 的网易云
//!   部分 —— UA、随机国内 IP 头、音质阶梯与逐级回退顺序、cookie 合并保存。
//!
//! | 本文件 | Go 对照 | 请求的域名(已在 manifest permissions.network 声明) |
//! |--------|---------|--------------------------------------------------|
//! | [`qr_create`] | `netease.go:171` `neteaseQRCreate` | `https://interface.music.163.com/api/login/qrcode/unikey` |
//! | [`qr_poll`] | `netease.go:196` `neteaseQRPoll` | `https://interface.music.163.com/api/login/qrcode/client/login` |
//! | [`search`] | `netease.go:63` `neteaseSearch` | `https://music.163.com/api/cloudsearch/pc` |
//! | [`song_url`] | `netease.go:112` `neteaseSongURL` | `https://interface3.music.163.com/eapi/song/enhance/player/url/v1` |
//! | [`playlists`] | (Go 版无对应; sidecar `server.mjs:293` `neteasePlaylists`) | `https://music.163.com/api/user/playlist` |
//! | [`playlist_songs`] / [`PlaylistIndex`] | (Go 版无对应; sidecar `server.mjs:310` `neteasePlaylistSongs`) | `https://music.163.com/api/v6/playlist/detail` 与 `/api/v3/song/detail` |
//! | [`login_status`] | (Go 版直接读 `state.sessions["netease"]`) | 无网络请求 |
//!
//! # 协议细节的出处
//!
//! - **eapi 加密/参数**: Go `netease.go:18` `aesECBEncrypt` + `netease.go:31`
//!   `neteaseEapiParams` —— path 把**首个** `/eapi/` 换成 `/api/`, 摘要
//!   `md5("nobody" + path + "use" + json + "md5forencrypt")`, 明文
//!   `path-36cd479b6b5-<json>-36cd479b6b5-<md5>`, AES-128-ECB + PKCS#7 后 hex。
//!   JSON 的键序: Go 的 `encoding/json` 对 `map` 按键排序, serde_json 默认
//!   (`BTreeMap`) 同样按键排序 —— 这是 `params` 正确的前提。唯一的残余差异是 Go
//!   `json.Marshal` 会把字符串里的 `<`/`>`/`&` 转义成 `\u003c` 等, serde_json
//!   不转义; payload 里只有调用方给的 `song_id` 可能带这类字符。
//! - **eapi payload**: Go `netease.go:120-131`, 含那个**故意不闭合**的 `header`
//!   JSON(末尾只有 `requestId":"N"`, 没有右花括号)与纳秒后 8 位的 `requestId`;
//!   `sky` 档额外带 `immerseType: "c51"`。Go 里那个没被用到的 `payloadBase` 是死
//!   代码(`_ = payloadBase`), 不移植。
//! - **音质阶梯**: Go `main.go:21` 的 `neteaseLevels` 与 sidecar
//!   `fetch-worker.mjs:104` 逐字相同(由高到低 8 档); 升序表在 sidecar
//!   `server.mjs:308`(`NETEASE_LEVEL_ORDER`, 歌单详情用它算 `qualities`)。
//!   逐级回退见 [`level_ladder`]。
//! - **UA**: Go `main.go:15-16` 与 sidecar `server.mjs:18-20` 逐字相同
//!   ([`CHROME_UA`] / [`DESKTOP_UA`])。
//! - **随机国内 IP 头**: sidecar `server.mjs:79-89`(搜索与扫码请求带
//!   `x-real-ip`/`x-forwarded-for`, 缺失会被网易风控按 8821「请切换其他登录方式」
//!   拦截), 见 [`ip_headers`]。
//! - **cookie 头**: Go `netease.go:51` `neteaseCookieHeader` —— 固定前缀
//!   `os=pc; appver=; osver=; deviceId=pyncm!`, 再按存在与否追加 `MUSIC_U` /
//!   `__csrf_token`(其余 cookie 不回显)。
//! - **cookie 解析/保存**: 解析用 Go `netease.go:219` 的 `SplitN("=", 2)`(值里的
//!   `=` 保留), 保存按 sidecar `server.mjs:158` 的合并语义(`{...旧, ...新}`)。
//!   插件契约要求落 KV 键 [`COOKIE_KEY`](COOKIE_KEY)(`cookies.netease`), 而不是
//!   Go 版的 `state.sessions`。
//! - **请求头基线**: Go 的 `content-type`/`referer`/`user-agent`, 叠加 sidecar 的
//!   IP 头; 取链请求不带 IP 头(与 `fetch-worker.mjs:90-97` 一致, 只带 UA + cookie)。
//!
//! # 已知偏差(逐条说明)
//!
//! - **Set-Cookie 设备 cookie 没移植**: sidecar 在扫码 create 时记下 `NMTID` 并在
//!   poll 时回填(`server.mjs:117-137`); 宿主返回的响应会剥掉 `set-cookie`
//!   (`docs-ref/new-hostcall.md:220`), 插件拿不到这个值。poll 侧仍保留
//!   `set-cookie` 兜底解析(拿得到就用)。
//! - **随机数**: sidecar 用 `Math.random()`, 本 crate 没有 rand 依赖,
//!   改用墙钟纳秒 + 进程内计数器的 xorshift32(见 [`ip_headers`]); 只用于换 IP,
//!   不承担安全用途。
//! - **请求体 base64**: Go 的网易云请求用 `base64.StdEncoding`(带 padding; 存储层
//!   用的是 RawStdEncoding), 这里保持一致。
//! - **[`login_status`]**: Go 版没有对应函数(直接读 `state.sessions["netease"]`
//!   判空), 这里读同一个 KV 键返回 `{"logged_in", "has_music_u"}`。
//! - **错误文案**: Go 的 `json.Unmarshal` 错误文本换成 serde 的文本
//!   (`搜索解析失败: <serde 错误>`), 前缀与中文文案保持不变。
//! - **歌单链路的 cookie 头**: sidecar 回放整份 cookie jar(`cookieOf('netease')`),
//!   插件沿用 [`cookie_header`] 的固定前缀 + `MUSIC_U` + `__csrf_token`(与取链一致,
//!   宿主契约不回显其余 cookie); 歌单歌曲的 `id` 是字符串(sidecar 的 `String(t.id)`),
//!   `page_size` 字段名按本插件契约用下划线(sidecar 是 `pageSize`)。
//!
//! # 测试
//!
//! 不联网的纯函数向量测试在 `tests/netease.rs`(AES-ECB 已知向量、eapi params、
//! cookie 字符串解析、表单编码、音质阶梯); 歌单的 qualities 推导与歌曲映射在
//! `tests/netease_playlists.rs`([`qualities_for_level`] 各分支 + 固定 JSON 夹具)。

use std::collections::BTreeMap;
use std::sync::Mutex;

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockEncryptMut, KeyInit};
use aes::Aes128;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ecb::Encryptor;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::util;
use crate::clock;
use crate::host::{self, HostCallRequest, HostCallResponse};
use crate::store;

/// 空桩统一返回值。
///
/// 本模块已实现, 不再返回它; 常量保留是因为 [`crate::qq`] / [`crate::download`] /
/// [`crate::tasks`] 的空桩与 `lib.rs` 的接线测试仍以它为准。
pub const NOT_IMPLEMENTED: &str = "not implemented";

// ─────────────────────────── 常量 ───────────────────────────

/// 搜索接口(Go `netease.go:70`)。
pub const SEARCH_URL: &str = "https://music.163.com/api/cloudsearch/pc";
/// 扫码取 unikey(Go `netease.go:175`)。
pub const QR_UNIKEY_URL: &str = "https://interface.music.163.com/api/login/qrcode/unikey";
/// 扫码轮询(Go `netease.go:201`)。
pub const QR_LOGIN_URL: &str = "https://interface.music.163.com/api/login/qrcode/client/login";
/// eapi 取链(Go `netease.go:133`)。
pub const SONG_URL_API: &str = "https://interface3.music.163.com/eapi/song/enhance/player/url/v1";
/// 登录账号查询(sidecar `server.mjs:282` `neteaseAccount`; 明文 API + cookie)。
pub const ACCOUNT_URL: &str = "https://music.163.com/api/nuser/account/get";
/// 用户歌单列表(sidecar `server.mjs:297` `neteasePlaylists`)。
pub const USER_PLAYLIST_URL: &str = "https://music.163.com/api/user/playlist";
/// 歌单详情(sidecar `server.mjs:312` `neteasePlaylistSongs`; `n=0` 拿全量 trackIds,
/// 不受 1000 截断)。
pub const PLAYLIST_DETAIL_URL: &str = "https://music.163.com/api/v6/playlist/detail";
/// 歌曲详情批量(sidecar `server.mjs:328` `neteasePlaylistSongs`; 每 200 个 id 一批)。
pub const SONG_DETAIL_URL: &str = "https://music.163.com/api/v3/song/detail";

/// 通用 UA(Go `main.go:15` `chromeUA` = sidecar `server.mjs:18` `UA`)。
pub const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
/// 扫码用桌面客户端 UA(Go `main.go:16` `neteaseDesktopUA` = sidecar `server.mjs:20` `NETEASE_QR_UA`)。
pub const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152";

/// 扫码登录页(Go `netease.go:192` 的 `qr_content` 前缀)。
pub const LOGIN_PAGE: &str = "https://music.163.com/login";

/// eapi 密钥(Go `netease.go:37`): 16 字节。
pub const EAPI_KEY: &[u8] = b"e82ckenh8dichen8";
/// eapi 明文里的固定分隔符(Go `netease.go:36` `-36cd479b6b5-`)。
const EAPI_SEPARATOR: &[u8] = b"-36cd479b6b5-";
/// eapi 请求的 Content-Type(Go `netease.go:139`)。
const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";

/// 搜索/常规接口的 Referer(Go `netease.go:71` = sidecar `server.mjs:97`)。
const MUSIC_REFERER: &str = "https://music.163.com/";
/// 扫码接口的 Referer(sidecar `server.mjs:114/133` 用 http 形态)。
const QR_REFERER: &str = "http://music.163.com/";

/// 会话 cookie 的 KV 键(本插件契约; Go 版存在 `state.sessions["netease"]`)。
pub const COOKIE_KEY: &str = "cookies.netease";
/// cookie 头固定前缀(Go `netease.go:53`; 与 eapi payload 的 header 同源)。
pub const COOKIE_BASE: &str = "os=pc; appver=; osver=; deviceId=pyncm!";

/// 音质阶梯, **由高到低**(Go `main.go:21` `neteaseLevels` = sidecar
/// `fetch-worker.mjs:104`); [`song_url`] 从命中档位向下逐级尝试。
pub static LEVELS: [&str; 8] = [
    "jymaster", "jyeffect", "sky", "hires", "lossless", "dolby", "exhigh", "standard",
];

/// 升序档位表(sidecar `server.mjs:308` `NETEASE_LEVEL_ORDER`; 歌单详情用它
/// `slice(0, maxIdx + 1).reverse()` 取候选)。
///
/// 注意它与 [`LEVELS`] **不互为反转**: sidecar 的两份来源对 `dolby` 的位次不同
/// (这里紧跟 `jyeffect`, [`LEVELS`] 里紧跟 `lossless`), 本移植照抄各自原样。
pub static LEVELS_ASCENDING: [&str; 8] = [
    "standard", "exhigh", "lossless", "hires", "sky", "jyeffect", "dolby", "jymaster",
];

/// 取链结果(Go `neteaseSongURL` 的 `(dlURL, ext, actual, size, err)` 返回元组)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SongUrl {
    /// 直链(Go `dlURL`)。
    pub url: String,
    /// 文件扩展名(Go `ext`: `flac` / `mp3`; 空时 Go 兜底 `flac`)。
    pub ext: String,
    /// 实际命中的音质档位(Go `actual`; SongUrl 里字段名按本插件契约为 `level`)。
    pub level: String,
    /// 文件字节数(Go `size`; 未知为 0)。
    pub size: i64,
}

impl SongUrl {
    /// 占位构造(字段全空), 供上层在拿不到直链时构造类型占位。
    pub fn placeholder() -> Self {
        SongUrl {
            url: String::new(),
            ext: String::new(),
            level: String::new(),
            size: 0,
        }
    }
}

// ─────────────────────────── eapi ───────────────────────────

/// AES-ECB 加密 + PKCS#7 填充(Go `netease.go:18` `aesECBEncrypt`)。
///
/// Go 的 `aes.NewCipher` 接受 16/24/32 字节密钥, 本移植点只用 16 字节常量密钥
/// [`EAPI_KEY`], 其余长度返回错误(不 panic)。
///
/// `data` 长度整除 16 时补满一整块(标准 PKCS#7, 与 Go 的手工 `pad = 16 - len%16` 一致)。
pub fn aes_ecb_encrypt(data: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Encryptor::<Aes128>::new_from_slice(key)
        .map_err(|_| "AES 密钥长度非法(仅支持 16 字节 AES-128)".to_string())?;
    // `encrypt_padded_mut` 要求缓冲区至少比明文多一个块; PKCS#7 最多补 16 字节。
    let mut buffer = vec![0u8; data.len() + 16];
    buffer[..data.len()].copy_from_slice(data);
    let out = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, data.len())
        .map_err(|_| "AES 填充失败".to_string())?;
    Ok(out.to_vec())
}

/// Go `netease.go:33` `strings.Replace(apiURL, "/eapi/", "/api/", 1)`: 只换第一处。
pub fn eapi_path(api_url: &str) -> String {
    // 0.3.9: 对齐 agent `fetch-worker.mjs:38` 的 `u.pathname.replace(...)` ——
    // 只取 pathname(去掉 scheme+host)再替换 /eapi/。Go 版在整条 URL 上替换,
    // digest 与密文里的 path 都带上了 "https://interface3.music.163.com",
    // 真机表现为 8 档全部 200 却取不到链接(从未在 broker 下验证过)。
    let pathname = match api_url.find("://") {
        Some(scheme_end) => match api_url[scheme_end + 3..].find('/') {
            Some(offset) => &api_url[scheme_end + 3 + offset..],
            None => "/",
        },
        None => api_url,
    };
    match pathname.find("/eapi/") {
        Some(index) => {
            let mut out = String::with_capacity(pathname.len());
            out.push_str(&pathname[..index]);
            out.push_str("/api/");
            out.push_str(&pathname[index + "/eapi/".len()..]);
            out
        }
        None => pathname.to_string(),
    }
}

/// eapi 请求参数(Go `netease.go:31` `neteaseEapiParams`): hex(AES-ECB(明文))。
///
/// 明文 = `path-36cd479b6b5-<payload 紧凑 JSON>-36cd479b6b5-<md5 hex>`,
/// 其中 `md5 = md5("nobody" + path + "use" + json + "md5forencrypt")`。
/// `path` 用 [`eapi_path`] 归一化。
pub fn eapi_params(api_url: &str, payload: &Value) -> String {
    let path = eapi_path(api_url);
    // Go `mustJSON`(wasm.go:121): 序列化失败回退到固定错误信封(对 Value 不可达)。
    let payload_json = serde_json::to_vec(payload).unwrap_or_else(|_| crate::util::ENCODE_FAILED.to_vec());

    let mut digest_input = Vec::with_capacity(32 + path.len() + payload_json.len());
    digest_input.extend_from_slice(b"nobody");
    digest_input.extend_from_slice(path.as_bytes());
    digest_input.extend_from_slice(b"use");
    digest_input.extend_from_slice(&payload_json);
    digest_input.extend_from_slice(b"md5forencrypt");
    let digest = hex::encode(Md5::digest(&digest_input));

    let mut text = Vec::with_capacity(path.len() + payload_json.len() + digest.len() + 32);
    text.extend_from_slice(path.as_bytes());
    text.extend_from_slice(EAPI_SEPARATOR);
    text.extend_from_slice(&payload_json);
    text.extend_from_slice(EAPI_SEPARATOR);
    text.extend_from_slice(digest.as_bytes());

    let encrypted = aes_ecb_encrypt(&text, EAPI_KEY).expect("EAPI_KEY 固定 16 字节");
    hex::encode(encrypted)
}

/// 取链 payload(Go `netease.go:120-131`)。
///
/// 0.3.9: 对齐 music-agent `fetch-worker.mjs:85-88` 的**真机验证过**形态 ——
/// header 是闭合 JSON(`{"os":"pc","appver":"","osver":"","deviceId":"pyncm!"}`),
/// 无 requestId、无 immerseType。Go 版的"故意不闭合 + requestId"形态从未在
/// broker 下验证过, 真机表现为 8 档全 200 却全部取不到链接(疑似被风控)。
/// `request_id` 参数保留以稳定调用方签名, 不再进 payload。
pub fn song_url_payload(song_id: &str, level: &str, _request_id: u64) -> Value {
    // 字面量而非 json! 宏: 保住 agent 的字段插入序(os/appver/osver/deviceId),
    // json! 宏会按 serde_json 的 BTreeMap 字典序输出, 改变密文字节。
    let header = r#"{"os":"pc","appver":"","osver":"","deviceId":"pyncm!"}"#.to_string();
    json!({
        "ids": [song_id],
        "level": level,
        "encodeType": "flac",
        "header": header,
    })
}

/// Go `netease.go:127` 的 `time.Now().UnixNano() % 1e8`: 纳秒时间戳的后 8 位。
pub fn request_id(unix_nanos: u64) -> u64 {
    unix_nanos % 100_000_000
}

/// Go `netease.go:113-119`: 从 `level` 命中处向下逐级尝试; 未命中(含空串)从最高档开始。
pub fn level_ladder(level: &str) -> &'static [&'static str] {
    let start = LEVELS.iter().position(|candidate| *candidate == level).unwrap_or(0);
    &LEVELS[start..]
}

/// 歌单歌曲的候选音质(sidecar `server.mjs:340-341`)。
///
/// `max_level` 在升序表 [`LEVELS_ASCENDING`] 里的位次决定保留多少档:
/// `maxIdx = LEVELS_ASCENDING.indexOf(max_level)`, 命中时返回
/// `LEVELS_ASCENDING[0..=maxIdx]` 的反转(高在前), 未命中(含空串)返回空表。
/// 与 JS 的 `indexOf` 一样区分大小写; 注意取的是**升序表**而非 [`LEVELS`]
/// (两表对 `dolby` 的位次不同, 各自照抄来源)。
pub fn qualities_for_level(max_level: &str) -> Vec<&'static str> {
    let max_index = match LEVELS_ASCENDING.iter().position(|level| *level == max_level) {
        Some(index) => index,
        None => return Vec::new(),
    };
    let mut qualities: Vec<&'static str> = LEVELS_ASCENDING[..=max_index].to_vec();
    qualities.reverse();
    qualities
}

// ─────────────────────────── 表单编码 ───────────────────────────

/// Go `url.QueryEscape`: RFC 3986 unreserved(`A-Za-z0-9-_.~`)原样, 空格转 `+`,
/// 其余字节按 UTF-8 逐字节 `%XX`(大写十六进制)。
pub fn query_escape(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// Go `url.Values.Encode()`: 按键排序后 `k=v` 用 `&` 连接(键与值都做 [`query_escape`])。
pub fn form_encode(pairs: &[(&str, &str)]) -> String {
    let mut sorted: Vec<(&str, &str)> = pairs.to_vec();
    sorted.sort_by(|left, right| left.0.cmp(right.0));
    let mut out = String::new();
    for (key, value) in sorted {
        if !out.is_empty() {
            out.push('&');
        }
        out.push_str(&query_escape(key));
        out.push('=');
        out.push_str(&query_escape(value));
    }
    out
}

// ─────────────────────────── cookie ───────────────────────────

/// 按 Go `strings.TrimSpace` / `unicode.IsSpace` 去除首尾空白。
///
/// Rust 的 `char::is_whitespace`(`str::trim` 的判据)就是 Unicode `White_Space`
/// 属性, 与 Go 的 `unicode.IsSpace` 逐字符一致: 除 Latin-1 的
/// `\t \n \v \f \r 空格 U+0085 U+00A0` 外, U+1680、U+2000..U+200A、U+2028、
/// U+2029、U+202F、U+205F、U+3000(全角空格)都算空白。
fn go_trim_space(text: &str) -> &str {
    text.trim()
}

/// 解析 `name=value; name2=value2`(Go `netease.go:219-224` 的 `SplitN("=", 2)`)。
///
/// - 每个分号段先按 Go 语义去首尾空白;
/// - 没有 `=` 的段忽略; 名字为空的段忽略;
/// - 值里的 `=` 原样保留(`SplitN` 上限 2);
/// - 同名后者覆盖前者(map 语义), 与 Go/sidecar 一致。
pub fn parse_cookie_string(cookie: &str) -> BTreeMap<String, String> {
    let mut cookies = BTreeMap::new();
    for pair in cookie.split(';') {
        let pair = go_trim_space(pair);
        let (name, value) = match pair.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        if name.is_empty() {
            continue;
        }
        cookies.insert(name.to_string(), value.to_string());
    }
    cookies
}

/// 解析单条 `Set-Cookie` 行(sidecar `server.mjs:154-157`): 只取分号前的 `name=value`,
/// 名字去空白, 值原样(可含 `=`)。
pub fn parse_set_cookie(line: &str) -> Option<(String, String)> {
    let first = line.split(';').next().unwrap_or("");
    let (name, value) = first.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some((name.to_string(), value.to_string()))
}

/// Go `netease.go:51-61` `neteaseCookieHeader`: 固定前缀 + `MUSIC_U` + `__csrf_token`。
pub fn cookie_header(cookies: &BTreeMap<String, String>) -> String {
    let mut header = String::from(COOKIE_BASE);
    if let Some(music_u) = cookies.get("MUSIC_U") {
        header.push_str("; MUSIC_U=");
        header.push_str(music_u);
    }
    if let Some(csrf) = cookies.get("__csrf_token") {
        header.push_str("; __csrf_token=");
        header.push_str(csrf);
    }
    header
}

/// 从 KV 读会话 cookie(键 [`COOKIE_KEY`]); 缺失/损坏 → 空表。
pub fn load_cookies() -> BTreeMap<String, String> {
    let (raw, ok) = store::get(COOKIE_KEY);
    if !ok || raw.is_empty() {
        return BTreeMap::new();
    }
    serde_json::from_slice::<BTreeMap<String, String>>(&raw).unwrap_or_default()
}

/// cookie 落盘的幂等键序列(会话内跨多次写入保持递增, 避免宿主 24h 幂等记录撞键)。
fn put_ids() -> std::sync::MutexGuard<'static, store::PutIds> {
    static IDS: Mutex<store::PutIds> = Mutex::new(store::PutIds::new());
    IDS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 手动粘贴的 Cookie 头(`netease-cookie-paste` / `settings-update` 的 `netease_cookie`)。
///
/// 宿主 broker 剥离外部响应的 set-cookie(host-call-v2.md §3), 而扫码端点 803 的
/// body 通常不带 cookie —— 扫码在插件里拿不到登录态, 手动粘贴是可靠替代:
/// 浏览器登录 music.163.com 后复制 Cookie 头粘贴进来。逐对解析并只保留已知
/// 网易云 cookie 名; 至少要有 `MUSIC_U`(或 `MUSIC_A`)才视为有效登录态。
pub fn save_cookie_string(raw: &str) -> Result<Value, String> {
    let parsed = parse_cookie_string(raw);
    let mut jar = BTreeMap::new();
    for (name, value) in parsed {
        if NETEASE_COOKIE_NAMES.contains(&name.as_str()) && !value.is_empty() {
            jar.insert(name, value);
        }
    }
    let has_login = jar.get("MUSIC_U").map_or(false, |v| !v.is_empty())
        || jar.get("MUSIC_A").map_or(false, |v| !v.is_empty());
    if !has_login {
        return Err(
            "未找到 MUSIC_U(或 MUSIC_A); 请确认复制的是已登录 music.163.com 的 Cookie 头".to_string(),
        );
    }
    save_cookies(&jar)?;
    Ok(json!({"saved": jar.len(), "logged_in": true}))
}

/// 手动粘贴白名单: 已知的网易云 cookie 名。
pub const NETEASE_COOKIE_NAMES: [&str; 10] = [
    "MUSIC_U", "MUSIC_A", "MUSIC_A_T", "MUSIC_R_T", "MUSIC_SNS", "NMTID", "__csrf",
    "__csrf_token", "_ntes_nuid", "_ntes_nnid",
];

/// 合并写入会话 cookie(键 [`COOKIE_KEY`])。
///
/// 合并语义对齐 sidecar `server.mjs:158`(旧值保留、新值覆盖), 不是 Go
/// `saveSessionCookies` 的整表替换 —— 扫码回调只带回部分 cookie 时, 不能让已有
/// 的会话字段凭空消失。
pub fn save_cookies(cookies: &BTreeMap<String, String>) -> Result<(), String> {
    let mut merged = load_cookies();
    for (name, value) in cookies {
        merged.insert(name.clone(), value.clone());
    }
    let data = serde_json::to_vec(&merged).map_err(|err| format!("cookie 序列化失败: {err}"))?;
    let mut ids = put_ids();
    store::put(&mut ids, COOKIE_KEY, &data).map_err(|err| err.to_string())
}

// ─────────────────────────── 请求头 ───────────────────────────

/// sidecar `server.mjs:81` 的国内 IP 前缀表。
const CN_PREFIXES: [[u32; 2]; 9] = [
    [116, 255],
    [116, 228],
    [218, 192],
    [124, 0],
    [14, 132],
    [183, 14],
    [58, 14],
    [113, 116],
    [120, 230],
];

/// 无 rand 依赖的伪随机(xorshift32): 墙钟纳秒(宿主精度 1ms) + 进程内计数器做种子。
fn pseudo_random_u32() -> u32 {
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let tick = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut seed = (clock::now_unix_nanos() as u32) ^ tick.wrapping_mul(0x9E37_79B9);
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed
}

/// 随机国内 IP 头(sidecar `server.mjs:79-89`)。
///
/// 网易风控按 `X-Real-IP`/`X-Forwarded-For` 判定客户端位置, 缺失时报
/// 8821「请切换其他登录方式」(扫码授权阶段被拦)。前缀取自 sidecar 的 `CN_PREFIXES`,
/// 后两段随机 1..=254。
pub fn ip_headers() -> BTreeMap<String, String> {
    let value = pseudo_random_u32();
    let prefix = CN_PREFIXES[(value as usize) % CN_PREFIXES.len()];
    let third = (value >> 8) % 254 + 1;
    let fourth = (value >> 16) % 254 + 1;
    let ip = format!("{}.{}.{}.{}", prefix[0], prefix[1], third, fourth);
    let mut headers = BTreeMap::new();
    headers.insert("x-real-ip".to_string(), ip.clone());
    headers.insert("x-forwarded-for".to_string(), ip);
    headers
}

/// 出站请求的基线头(Go `netease.go` 各请求的 content-type + user-agent)。
fn base_headers(user_agent: &str) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), FORM_CONTENT_TYPE.to_string());
    headers.insert("user-agent".to_string(), user_agent.to_string());
    headers
}

/// POST 表单请求(Go 的 `hostCall` + `base64.StdEncoding` 请求体)。
fn post_form(
    url: &str,
    headers: BTreeMap<String, String>,
    form: &str,
) -> Result<HostCallResponse, String> {
    let mut request =
        HostCallRequest::new("POST", url).with_body_base64(STANDARD.encode(form.as_bytes()));
    request.headers = headers;
    host::call(&request).map_err(|err| err.to_string())
}

/// 响应里所有 `set-cookie` 行的值(宿主当前会剥掉这个头, 拿到就用)。
fn set_cookie_lines(response: &HostCallResponse) -> Vec<String> {
    let mut lines = Vec::new();
    for (name, values) in &response.headers {
        if name.eq_ignore_ascii_case("set-cookie") {
            lines.extend(values.iter().cloned());
        }
    }
    lines
}

/// GET 请求(与 [`post_form`] 同一宿主链路; 无请求体, 序列化时按 omitempty 省略)。
fn get_url(url: &str, headers: BTreeMap<String, String>) -> Result<HostCallResponse, String> {
    let mut request = HostCallRequest::new("GET", url);
    request.headers = headers;
    host::call(&request).map_err(|err| err.to_string())
}

/// 歌单链路 GET 的请求头(sidecar `server.mjs:297-302/312-316`: referer + UA +
/// cookie + IP 头, **不带** content-type)。
fn playlist_headers() -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    headers.insert("referer".to_string(), MUSIC_REFERER.to_string());
    headers.insert("user-agent".to_string(), CHROME_UA.to_string());
    headers.insert("cookie".to_string(), cookie_header(&load_cookies()));
    headers.extend(ip_headers());
    headers
}

/// 歌单链路 POST 的请求头: 在 [`playlist_headers`] 上补 content-type
/// (sidecar `server.mjs:282-288/326-332` 的 POST 形态)。
fn playlist_form_headers() -> BTreeMap<String, String> {
    let mut headers = playlist_headers();
    headers.insert("content-type".to_string(), FORM_CONTENT_TYPE.to_string());
    headers
}

// ─────────────────────────── 响应结构 ───────────────────────────

/// 响应字段一律用 `Option<T>` + `#[serde(default)]`, 对齐 Go 结构体解码:
/// 缺失与 `null` → 零值不报错, 类型不符 → 报错。
#[derive(Debug, Default, Deserialize)]
struct QrCreateResponse {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    unikey: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct QrPollResponse {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    cookie: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    result: Option<SearchResult>,
    /// Go 解出了 `code` 但没用; 保留以便类型不符时同样报错(`netease.go:92`)。
    #[serde(default)]
    #[allow(dead_code)]
    code: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct SearchResult {
    #[serde(default)]
    songs: Option<Vec<SearchSong>>,
    #[serde(default, rename = "songCount")]
    song_count: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SearchSong {
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    name: Option<String>,
    /// `ar`: 歌手数组; `null`/缺失 → 空数组。
    #[serde(default)]
    ar: Option<Vec<SearchArtist>>,
    /// `al`: 专辑; `null`/缺失 → 空对象。
    #[serde(default)]
    al: Option<SearchAlbum>,
    /// `dt`: 时长(毫秒)。
    #[serde(default)]
    dt: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SearchArtist {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SearchAlbum {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "picUrl")]
    pic_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SongUrlResponse {
    #[serde(default)]
    data: Option<Vec<SongUrlItem>>,
    /// Go 解出了 `code` 但没用; 保留以便类型不符时同样报错(`netease.go:156`)。
    #[serde(default)]
    #[allow(dead_code)]
    code: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct SongUrlItem {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    level: Option<String>,
    /// 文件类型(Go 的 `Type string` 字段, json tag 是 `type`); `type` 是 Rust
    /// 关键字, 所以改名字段 + `rename`。
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    size: Option<i64>,
}

/// 歌单链路的响应字段同样 `Option` + `#[serde(default)]`; `nuser/account/get` 与
/// `/api/v6/playlist/detail` 在未登录/参数非法时返回不带业务字段的 `{"code":...}`,
/// 解出来按零值走"未登录/空歌单"分支(sidecar 的 `j?.profile?.userId` 可选链语义)。
#[derive(Debug, Default, Deserialize)]
struct AccountResponse {
    #[serde(default)]
    profile: Option<AccountProfile>,
}

#[derive(Debug, Default, Deserialize)]
struct AccountProfile {
    #[serde(default, rename = "userId")]
    user_id: Option<i64>,
    #[serde(default)]
    nickname: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UserPlaylistResponse {
    /// `j?.playlist || []`: 缺失/`null` → 空列表。
    #[serde(default)]
    playlist: Option<Vec<UserPlaylist>>,
}

#[derive(Debug, Default, Deserialize)]
struct UserPlaylist {
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "coverImgUrl")]
    cover_img_url: Option<String>,
    #[serde(default, rename = "trackCount")]
    track_count: Option<i64>,
    #[serde(default)]
    creator: Option<UserPlaylistCreator>,
}

#[derive(Debug, Default, Deserialize)]
struct UserPlaylistCreator {
    #[serde(default)]
    nickname: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PlaylistDetailResponse {
    /// sidecar 的 `j?.playlist || j?.result || {}`: v6 响应可能落在任一字段。
    #[serde(default)]
    playlist: Option<PlaylistInfo>,
    #[serde(default)]
    result: Option<PlaylistInfo>,
}

#[derive(Debug, Default, Deserialize)]
struct PlaylistInfo {
    #[serde(default)]
    name: Option<String>,
    /// `pl.trackCount ?? ids.length`: `??` 只认 null/undefined, 0 也是值。
    #[serde(default, rename = "trackCount")]
    track_count: Option<i64>,
    #[serde(default, rename = "trackIds")]
    track_ids: Option<Vec<PlaylistTrackId>>,
}

#[derive(Debug, Default, Deserialize)]
struct PlaylistTrackId {
    #[serde(default)]
    id: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct SongDetailResponse {
    /// 每首歌整体留作 [`Value`], 由 [`playlist_song_from_value`] 纯函数映射
    /// (便于固定夹具测试)。
    #[serde(default)]
    songs: Option<Vec<Value>>,
}

// ─────────────────────────── 入口 ───────────────────────────

/// 扫码创建(Go `netease.go:171` `neteaseQRCreate`): 返回 `{key, qr_content}`。
///
/// `qr_content` 是登录页 URL(sidecar 那边是渲染好的 `qr_dataurl`; wasm 里没有
/// 二维码渲染依赖, 前端自己画)。
pub fn qr_create() -> Result<Value, String> {
    let form = form_encode(&[("type", "3")]);
    let mut headers = base_headers(DESKTOP_UA);
    headers.insert("referer".to_string(), QR_REFERER.to_string());
    headers.extend(ip_headers());
    let response = post_form(QR_UNIKEY_URL, headers, &form)?;
    let body = store::decode_body(&response).unwrap_or_default();
    // Go `netease.go:187`: 解包失败 / `code != 200` / `unikey` 为空 → 同一个错误。
    let out: QrCreateResponse = serde_json::from_slice(&body).unwrap_or_default();
    let unikey = out.unikey.unwrap_or_default();
    if out.code != Some(200) || unikey.is_empty() {
        return Err("获取二维码失败".to_string());
    }
    Ok(json!({
        "key": unikey,
        "qr_content": format!("{LOGIN_PAGE}?codekey={}", query_escape(&unikey)),
    }))
}

/// 扫码轮询(Go `netease.go:196` `neteaseQRPoll`): 返回
/// `{status, message, code, logged_in?}`(803 时带 `logged_in: true` 并落 cookie)。
pub fn qr_poll(key: &str) -> Result<Value, String> {
    let form = form_encode(&[("key", key), ("type", "3")]);
    let mut headers = base_headers(DESKTOP_UA);
    headers.insert("referer".to_string(), QR_REFERER.to_string());
    headers.extend(ip_headers());
    let response = post_form(QR_LOGIN_URL, headers, &form)?;
    let body = store::decode_body(&response).unwrap_or_default();
    // Go `netease.go:214` 忽略解包错误 → 零值结构体(code=0, status="")。
    let out: QrPollResponse = serde_json::from_slice(&body).unwrap_or_default();
    let code = out.code.unwrap_or_default();
    let status = match code {
        800 => "expired",
        801 => "waiting",
        802 => "scanned",
        803 => "success",
        _ => "",
    };
    let mut result = json!({
        "status": status,
        "message": out.message.clone().unwrap_or_default(),
        "code": code,
    });
    if code == 803 {
        // cookie 在 body 和 Set-Cookie 都可能有(sidecar `server.mjs:149-157`)。
        let mut cookies = parse_cookie_string(out.cookie.as_deref().unwrap_or(""));
        for line in set_cookie_lines(&response) {
            if let Some((name, value)) = parse_set_cookie(&line) {
                cookies.insert(name, value);
            }
        }
        let has_login = cookies.get("MUSIC_U").map_or(false, |v| !v.is_empty())
            || cookies.get("MUSIC_A").map_or(false, |v| !v.is_empty());
        if has_login {
            // Go `netease.go:225` 忽略落盘错误(登录态以 KV 为准, 失败不改变本次结果)。
            let _ = save_cookies(&cookies);
            result["logged_in"] = Value::Bool(true);
        } else {
            // 宿主 broker 剥离 set-cookie, 该端点 803 的 body 又通常不带 cookie:
            // 扫码成功但登录态拿不到。绝不静默保存空表冒充登录成功。
            result["logged_in"] = Value::Bool(false);
            result["message"] = Value::String(
                "扫码成功，但宿主代理剥离了登录 Cookie，无法自动保存登录态。请在浏览器登录 \
                 music.163.com 后复制 Cookie 头，用登录卡的「手动粘贴 Cookie」完成登录。"
                    .to_string(),
            );
        }
    }
    Ok(result)
}

/// 单曲搜索(Go `netease.go:63` `neteaseSearch`): `page` 从 1 起, 每页 30 条。
///
/// 返回 `{songs, total, page}`; 歌曲字段与 Go 的 `map[string]any` 一致
/// (`id` 是数字, 不是 sidecar 的字符串)。
pub fn search(query: &str, page: u32) -> Result<Value, String> {
    // Go `netease.go:68`: offset = (page-1)*30(page 从 1 起)。
    // 用 i64 保留 page=0 时的负数偏移, 与 Go 的 int 运算一致。
    let offset_text = ((i64::from(page) - 1) * 30).to_string();
    let form = form_encode(&[
        ("s", query),
        ("type", "1"),
        ("limit", "30"),
        ("offset", offset_text.as_str()),
    ]);
    let mut headers = base_headers(CHROME_UA);
    headers.insert("referer".to_string(), MUSIC_REFERER.to_string());
    headers.extend(ip_headers());
    let response = post_form(SEARCH_URL, headers, &form)?;
    let body = store::decode_body(&response).unwrap_or_default();
    let parsed: SearchResponse =
        serde_json::from_slice(&body).map_err(|err| format!("搜索解析失败: {err}"))?;

    let result = parsed.result.unwrap_or_default();
    let songs: Vec<Value> = result
        .songs
        .unwrap_or_default()
        .iter()
        .map(|song| {
            let album = song.al.clone().unwrap_or_default();
            let singers = song
                .ar
                .clone()
                .unwrap_or_default()
                .iter()
                .map(|artist| artist.name.clone().unwrap_or_default())
                .collect::<Vec<String>>()
                .join("/");
            json!({
                "id": song.id.unwrap_or_default(),
                "name": song.name.clone().unwrap_or_default(),
                "singers": singers,
                "album": album.name.unwrap_or_default(),
                "cover": album.pic_url.unwrap_or_default(),
                "duration_ms": song.dt.unwrap_or_default(),
                "source": "netease",
            })
        })
        .collect();
    Ok(json!({
        "songs": songs,
        "total": result.song_count.unwrap_or_default(),
        "page": page,
    }))
}

/// 按音质向下逐级取链(Go `netease.go:112` `neteaseSongURL`)。
///
/// `level` 命中 [`LEVELS`] 就从那一档开始, 未命中(含空串)从最高档 `jymaster` 开始;
/// 每档发一次 eapi 请求, 解包失败 / `data` 为空 / 直链不以 `http` 开头都继续下一档;
/// 网络错误立即返回(与 Go 一致)。`level` 字段回显响应里的 `data[0].level`(Go
/// 的 `actual`), `ext` 为空时兜底 `flac`。
pub fn song_url(song_id: &str, level: &str) -> Result<SongUrl, String> {
    let mut headers = base_headers(CHROME_UA);
    headers.insert("cookie".to_string(), cookie_header(&load_cookies()));

    // 只留**最后那档的截断尾巴**(<= `util::TRUNC_LIMIT` 字节), 不留整份响应体:
    // 阶梯最多 8 档, 留全文等于把 8 份响应体依次钉在本轮峰值上, 而错误文案只需要
    // 200 字节的尾巴。`body` 与本变量因此不再是"整份 + 一份克隆"的双份驻留。
    let mut last_tail = String::new();
    for current in level_ladder(level) {
        let payload = song_url_payload(song_id, current, request_id(clock::now_unix_nanos()));
        let params = eapi_params(SONG_URL_API, &payload);
        let form = form_encode(&[("params", params.as_str())]);
        let response = post_form(SONG_URL_API, headers.clone(), &form)?;
        let body = store::decode_body(&response).unwrap_or_default();
        last_tail = util::trunc(&body);
        // `body`/`response`/`form`/`params`/`payload` 全部在本轮迭代结束即释放,
        // 下一档从头再来 —— 单曲取链工作集不随档位数累加。
        let out: SongUrlResponse = match serde_json::from_slice(&body) {
            Ok(out) => out,
            // Go `netease.go:158`: 解不出来就试下一档。
            Err(_) => continue,
        };
        let item = match out.data.unwrap_or_default().into_iter().next() {
            Some(item) => item,
            None => continue,
        };
        let url = item.url.unwrap_or_default();
        if !url.starts_with("http") {
            continue;
        }
        let ext = item.kind.unwrap_or_default();
        let ext = if ext.is_empty() { "flac".to_string() } else { ext };
        return Ok(SongUrl {
            url,
            ext,
            level: item.level.unwrap_or_default(),
            size: item.size.unwrap_or_default(),
        });
    }
    Err(format!(
        "所有音质均未获取到链接（需要 SVIP 且歌曲有对应音源）; 最后响应: {last_tail}"
    ))
}

/// 登录态查询: 从 KV 读会话 cookie 是否还在(Go 版从 `state.sessions["netease"]` 读)。
///
/// 不回显任何 cookie 值(宿主禁止凭据出现在响应里)。
pub fn login_status() -> Result<Value, String> {
    let cookies = load_cookies();
    Ok(json!({
        "logged_in": !cookies.is_empty(),
        "has_music_u": cookies.contains_key("MUSIC_U"),
    }))
}

// ─────────────────────────── 歌单 ───────────────────────────

/// 登录账号(sidecar `server.mjs:281-291` `neteaseAccount`): POST 空 body 拿
/// `profile.userId`。返回 `(uid, nickname)`; uid 缺失(未登录/登录态失效)报
/// "未登录或登录态失效"(sidecar 的 `if (!uid)` 分支)。
fn netease_account() -> Result<(i64, String), String> {
    let response = post_form(ACCOUNT_URL, playlist_form_headers(), "")?;
    let body = store::decode_body(&response).unwrap_or_default();
    let parsed: AccountResponse =
        serde_json::from_slice(&body).map_err(|err| format!("账号解析失败: {err}"))?;
    let profile = parsed.profile.unwrap_or_default();
    let user_id = profile.user_id.unwrap_or_default();
    if user_id == 0 {
        return Err("未登录或登录态失效".to_string());
    }
    Ok((user_id, profile.nickname.unwrap_or_default()))
}

/// 我的歌单列表(sidecar `server.mjs:293-307` `neteasePlaylists`)。
///
/// 先 [`netease_account`] 拿 uid, 再从 offset 0 起按 100 一页翻 `user/playlist`
/// (上限 2000, 不足 100 条提前停)。返回 `{playlists, count}`; `id` 是字符串
/// (sidecar 的 `String(p.id)`), `creator` 取歌单创建者昵称, 缺失时回退登录昵称。
pub fn playlists() -> Result<Value, String> {
    let (uid, nickname) = netease_account()?;
    let mut out: Vec<Value> = Vec::new();
    let mut offset: u64 = 0;
    while offset < 2000 {
        let url =
            format!("{USER_PLAYLIST_URL}?uid={uid}&limit=100&offset={offset}&includeVideo=true");
        let response = get_url(&url, playlist_headers())?;
        let body = store::decode_body(&response).unwrap_or_default();
        let parsed: UserPlaylistResponse =
            serde_json::from_slice(&body).map_err(|err| format!("歌单解析失败: {err}"))?;
        let list = parsed.playlist.unwrap_or_default();
        let fetched = list.len();
        for item in &list {
            // `p.creator?.nickname || nickname`: 空串/缺失都回退登录昵称。
            let creator = item
                .creator
                .as_ref()
                .and_then(|creator| creator.nickname.as_deref())
                .filter(|creator| !creator.is_empty())
                .unwrap_or(nickname.as_str());
            out.push(json!({
                "id": item.id.map(|value| value.to_string()).unwrap_or_default(),
                "name": item.name.clone().unwrap_or_default(),
                "cover": item.cover_img_url.clone().unwrap_or_default(),
                "count": item.track_count.unwrap_or_default(),
                "creator": creator,
            }));
        }
        if fetched < 100 {
            break;
        }
        offset += 100;
    }
    let count = out.len();
    Ok(json!({ "playlists": out, "count": count }))
}

/// 歌单索引(带缓存形态, 0.3.15): **一次** GET v6 `playlist/detail?n=0` 拿全量
/// `trackIds` + `trackCount` + `name`, 之后各页纯本地切片([`PlaylistIndex::songs`]),
/// 每片只 POST 当页的 v3 `song/detail` 换详情。
///
/// 整单入队([`crate::download::playlist_queue_all`])持有一个索引翻多页: 网络从
/// N×(v6 全量 + v3) 降为 1×v6 + N×v3, 全量 `trackIds` 的解析分配从 N 次降为 1 次
/// (页面内存探针因此只反映当页 v3 详情的分配)。
#[derive(Debug, Clone, Default)]
pub struct PlaylistIndex {
    name: String,
    total: i64,
    ids: Vec<i64>,
}

impl PlaylistIndex {
    /// 拉取索引: 一次 v6 `playlist/detail?n=0`。
    ///
    /// 解析失败文案与旧的 [`playlist_songs`] 单页形态逐字一致
    /// (`歌单详情解析失败: <serde 错误>`), 行为不变。
    pub fn fetch(id: &str) -> Result<PlaylistIndex, String> {
        let url = format!("{PLAYLIST_DETAIL_URL}?id={}&n=0", query_escape(id));
        let response = get_url(&url, playlist_headers())?;
        let body = store::decode_body(&response).unwrap_or_default();
        let parsed: PlaylistDetailResponse =
            serde_json::from_slice(&body).map_err(|err| format!("歌单详情解析失败: {err}"))?;
        let info = parsed.playlist.or(parsed.result).unwrap_or_default();
        let ids: Vec<i64> = info
            .track_ids
            .unwrap_or_default()
            .iter()
            .filter_map(|track| track.id)
            .collect();
        // `pl.trackCount ?? ids.length`(`??` 只认 null/undefined, 0 也是值)。
        let total = info.track_count.unwrap_or(ids.len() as i64);
        Ok(PlaylistIndex { name: info.name.unwrap_or_default(), total, ids })
    }

    /// 整单曲目数(`trackCount`, 缺失时回退 `trackIds` 长度)。
    pub fn total(&self) -> i64 {
        self.total
    }

    /// 歌单名(v6 响应缺失时为空串)。
    pub fn name(&self) -> &str {
        &self.name
    }

    /// 当页歌曲: 本地切片 `ids[(page-1)*page_size .. +page_size]`(`page` 从 1 起),
    /// 再每 200 个 id 一批 POST v3 `song/detail`。返回与单页形态相同的
    /// `{name, total, page, page_size, songs}`。
    pub fn songs(&self, page: u32, page_size: u32) -> Result<Value, String> {
        // `ids.slice(start, start + pageSize)`, `start = (page - 1) * pageSize`;
        // 起点为负(JS 会落到空页)或越界都按空页处理。
        let start = i64::from(page).saturating_sub(1).saturating_mul(i64::from(page_size));
        if start < 0 {
            return Ok(playlist_page(&self.name, self.total, page, page_size, Vec::new()));
        }
        let start = (start as usize).min(self.ids.len());
        let end = start.saturating_add(page_size as usize).min(self.ids.len());
        let page_ids = &self.ids[start..end];
        if page_ids.is_empty() {
            return Ok(playlist_page(&self.name, self.total, page, page_size, Vec::new()));
        }

        let mut tracks: Vec<Value> = Vec::new();
        for chunk in page_ids.chunks(200) {
            // `c=[{"id":..},..]&ids=[..,..]`(sidecar `server.mjs:326-333`)。
            let c = serde_json::to_string(
                &chunk.iter().map(|value| json!({ "id": value })).collect::<Vec<_>>(),
            )
            .unwrap_or_default();
            let ids_text = chunk.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
            let form = format!("c={}&ids=[{}]", query_escape(&c), ids_text);
            let response = post_form(SONG_DETAIL_URL, playlist_form_headers(), &form)?;
            let body = store::decode_body(&response).unwrap_or_default();
            let parsed: SongDetailResponse =
                serde_json::from_slice(&body).map_err(|err| format!("歌曲详情解析失败: {err}"))?;
            tracks.extend(parsed.songs.unwrap_or_default());
        }

        let songs: Vec<Value> = tracks.iter().map(playlist_song_from_value).collect();
        Ok(playlist_page(&self.name, self.total, page, page_size, songs))
    }
}

/// 歌单的歌曲页(sidecar `server.mjs:310-349` `neteasePlaylistSongs`)。
///
/// 对外行为与 0.3.14 逐字不变: 一次 GET v6 `playlist/detail?n=0` 拿全量
/// `trackIds` + `trackCount` + `name`, 按 `page`/`page_size` 切片(`page` 从 1 起),
/// 每 200 个 id 一批 POST v3 `song/detail`。返回 `{name, total, page, page_size, songs}`。
///
/// 0.3.15 起复用 [`PlaylistIndex`] 的带缓存形态(与整单入队同一条切片/映射路径),
/// UI 分页浏览每次调用仍是 1×v6 + 当页 v3 —— 请求次数与响应形状都不变。
pub fn playlist_songs(id: &str, page: u32, page_size: u32) -> Result<Value, String> {
    PlaylistIndex::fetch(id)?.songs(page, page_size)
}

/// 歌曲页的返回形状(`page_size` 按本插件契约用下划线, sidecar 是 `pageSize`)。
fn playlist_page(name: &str, total: i64, page: u32, page_size: u32, songs: Vec<Value>) -> Value {
    json!({
        "name": name,
        "total": total,
        "page": page,
        "page_size": page_size,
        "songs": songs,
    })
}

/// sidecar `server.mjs:331-345` 的歌曲映射: 把 v3 `song/detail` 的一首歌转成
/// 插件契约形状。纯函数, 供 [`playlist_songs`] 与固定夹具测试(`tests/netease_playlists.rs`)共用。
///
/// JS 语义逐条对照(`||` 对空串/0 也回退, `??` 只对 null/undefined):
/// - `id` = `String(t.id)`;
/// - `singers` = `t.ar`(假值时回退 `t.artists`)逐个 `name` 用 `/` 连接;
/// - `album`/`cover` = `(t.al || t.album)` 的 `name`/`picUrl`;
/// - `duration_ms` = `t.dt`(0/缺失回退 `t.duration`);
/// - `max_level` = `privilege.maxBrLevel || privilege.downloadMaxBrLevel || ''`;
/// - `qualities` = [`qualities_for_level`](`max_level`)。
pub fn playlist_song_from_value(song: &Value) -> Value {
    let artists = array_field(song, "ar").or_else(|| array_field(song, "artists"));
    let singers = artists
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist.get("name").and_then(Value::as_str))
                .collect::<Vec<&str>>()
                .join("/")
        })
        .unwrap_or_default();
    // `(t.al || t.album)`: al 是对象(含空对象)就用 al, 否则 album。
    let album = object_field(song, "al").or_else(|| object_field(song, "album"));
    let album_name = album.and_then(|album| truthy_string(album, "name")).unwrap_or_default();
    let cover = album.and_then(|album| truthy_string(album, "picUrl")).unwrap_or_default();
    // `t.dt || t.duration || 0`: dt 为 0 时回退 duration。
    let duration_ms = number_field(song, "dt")
        .filter(|value| *value != 0)
        .or_else(|| number_field(song, "duration"))
        .unwrap_or(0);
    // `priv.maxBrLevel || priv.downloadMaxBrLevel || ''`。
    let privilege = object_field(song, "privilege");
    let max_level = privilege
        .and_then(|privilege| truthy_string(privilege, "maxBrLevel"))
        .or_else(|| privilege.and_then(|privilege| truthy_string(privilege, "downloadMaxBrLevel")))
        .unwrap_or_default()
        .to_string();
    let id = match song.get("id") {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    };
    json!({
        "id": id,
        "name": song.get("name").and_then(Value::as_str).unwrap_or_default(),
        "singers": singers,
        "album": album_name,
        "cover": cover,
        "duration_ms": duration_ms,
        "source": "netease",
        "max_level": max_level,
        "qualities": qualities_for_level(&max_level),
    })
}

/// JS `x.y || fallback` 的对象语义: 只有对象(含空对象)算真值, `null`/缺失/其他类型都算未命中。
fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Map<String, Value>> {
    match value.get(key) {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// JS `x.y || fallback` 的数组语义: 只有数组(含空数组)算真值。
fn array_field<'a>(value: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    match value.get(key) {
        Some(Value::Array(items)) => Some(items),
        _ => None,
    }
}

/// JS 字符串 `a || b`: 空串/缺失/非字符串都算未命中。
fn truthy_string<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    match map.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text),
        _ => None,
    }
}

/// JS 数值 `a || b`: 缺失/非数值算未命中(0 的回退由调用方按 `||` 语义处理)。
fn number_field(value: &Value, key: &str) -> Option<i64> {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_i64(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn go_trim_space_matches_go_unicode_isspace() {
        assert_eq!(go_trim_space("  a b  "), "a b");
        assert_eq!(go_trim_space("\t\n a \r\n"), "a");
        assert_eq!(go_trim_space("\u{85}a\u{a0}"), "a", "Go unicode.IsSpace 认 NEL/NBSP");
        assert_eq!(
            go_trim_space("\u{3000}a\u{3000}"),
            "a",
            "U+3000 是 Unicode White_Space, Go unicode.IsSpace 同样为 true"
        );
        assert_eq!(
            go_trim_space("\u{2003}a\u{2029}"),
            "a",
            "EM SPACE / LINE SEPARATOR 也在 White_Space 里"
        );
        assert_eq!(
            go_trim_space("\u{200b}a\u{200b}"),
            "\u{200b}a\u{200b}",
            "零宽空格 U+200B 不是 White_Space, 不能被裁掉"
        );
    }

    #[test]
    fn eapi_path_replaces_first_segment_only() {
        // 0.3.9: 只取 pathname(agent 语义), 不再保留 scheme+host。
        assert_eq!(eapi_path("https://x/eapi/a"), "/api/a");
        assert_eq!(eapi_path("https://x/eapi/a/eapi/b"), "/api/a/eapi/b");
        assert_eq!(eapi_path("https://x/api/a"), "/api/a");
        assert_eq!(eapi_path("/eapi/a"), "/api/a");
        assert_eq!(eapi_path(""), "");
    }

    #[test]
    fn parse_set_cookie_takes_first_pair() {
        assert_eq!(
            parse_set_cookie("MUSIC_U=abc; Path=/; HttpOnly"),
            Some(("MUSIC_U".to_string(), "abc".to_string()))
        );
        assert_eq!(
            parse_set_cookie("__csrf_token=a=b; Path=/"),
            Some(("__csrf_token".to_string(), "a=b".to_string()))
        );
        assert_eq!(parse_set_cookie(" no-equals "), None);
        assert_eq!(parse_set_cookie("=v"), None);
    }

    /// 未命中阶梯(含空串)必须从最高档开始(Go `netease.go:113-119`)。
    #[test]
    fn level_ladder_defaults_to_highest() {
        assert_eq!(level_ladder(""), &LEVELS[..]);
        assert_eq!(level_ladder("bogus"), &LEVELS[..]);
        assert_eq!(level_ladder("hires"), &LEVELS[3..]);
        assert_eq!(level_ladder("standard"), &LEVELS[7..]);
    }

    #[test]
    fn request_id_keeps_last_eight_digits() {
        assert_eq!(request_id(1_790_676_009_123_456_789), 23_456_789);
        assert_eq!(request_id(0), 0);
        assert_eq!(request_id(99_999_999), 99_999_999);
        assert_eq!(request_id(100_000_001), 1);
    }

    // ─────────────── 歌单索引(带缓存形态, 0.3.15) ───────────────

    /// 歌单假宿主: 统计 v6/v3 请求; v6 回 `0..track_count-1` 的全量 trackIds,
    /// v3 按请求表单里的 `ids=[..]` 回对应歌曲 —— 便于直接断言每页切片。
    #[derive(Debug, Default)]
    struct PlaylistHost {
        v6_calls: usize,
        v3_ids: Vec<Vec<i64>>,
    }

    fn fake_json(body: &[u8]) -> Result<HostCallResponse, crate::host::HostError> {
        Ok(HostCallResponse {
            status: 200,
            headers: BTreeMap::new(),
            body_base64: base64::engine::general_purpose::STANDARD_NO_PAD.encode(body),
        })
    }

    /// 请求体 base64: 生产 POST 用带 padding 的 StdEncoding, 两种都容错解码。
    fn request_bytes(request: &HostCallRequest) -> Vec<u8> {
        use base64::Engine as _;
        STANDARD
            .decode(&request.body_base64)
            .or_else(|_| {
                base64::engine::general_purpose::STANDARD_NO_PAD.decode(&request.body_base64)
            })
            .unwrap_or_default()
    }

    /// 从 v3 请求表单 `c=..&ids=[1,2,..]` 里取出当页 id 列表。
    fn form_ids(form: &str) -> Vec<i64> {
        form.split("&ids=[")
            .nth(1)
            .unwrap_or("")
            .split(']')
            .next()
            .unwrap_or("")
            .split(',')
            .filter_map(|text| text.trim().parse::<i64>().ok())
            .collect()
    }

    fn install_playlist_host(track_count: usize) -> Rc<RefCell<PlaylistHost>> {
        let state = Rc::new(RefCell::new(PlaylistHost::default()));
        let shared = state.clone();
        host::testhost::install(Box::new(move |request: &HostCallRequest| {
            let mut state = shared.borrow_mut();
            // 歌单请求头先读 KV 里的 cookie: 未登录 → 404(空 jar)。
            if request.path.starts_with("/api/plugin-runtime/storage/") {
                return Ok(HostCallResponse { status: 404, ..HostCallResponse::default() });
            }
            if request.method == "GET" && request.path.starts_with(PLAYLIST_DETAIL_URL) {
                state.v6_calls += 1;
                let ids: Vec<Value> = (0..track_count).map(|id| json!({ "id": id })).collect();
                let body = serde_json::to_vec(&json!({
                    "playlist": {"name": "大歌单", "trackCount": track_count, "trackIds": ids},
                }))
                .unwrap();
                return fake_json(&body);
            }
            if request.method == "POST" && request.path == SONG_DETAIL_URL {
                let form = String::from_utf8_lossy(&request_bytes(request)).to_string();
                let ids = form_ids(&form);
                state.v3_ids.push(ids.clone());
                let songs: Vec<Value> = ids
                    .iter()
                    .map(|id| json!({"id": id, "name": format!("歌{id}")}))
                    .collect();
                return fake_json(&serde_json::to_vec(&json!({ "songs": songs })).unwrap());
            }
            Err(crate::host::HostError::new(format!(
                "unexpected host call: {} {}",
                request.method, request.path
            )))
        }));
        state
    }

    /// 0.3.15 的核心指标: 1000 首/页 100, v6 全量索引只请求 **1 次**, 各页纯本地
    /// 切片, 第 10 页取 900..999, 每页各 1 次 v3 详情。
    #[test]
    fn playlist_index_fetches_v6_once_and_slices_each_page_locally() {
        let host = install_playlist_host(1000);
        let index = PlaylistIndex::fetch("42").unwrap();
        assert_eq!(index.name(), "大歌单");
        assert_eq!(index.total(), 1000);

        for page in 1..=10u32 {
            let value = index.songs(page, 100).unwrap();
            assert_eq!(value["page"], page);
            assert_eq!(value["page_size"], 100);
            assert_eq!(value["total"], 1000);
            assert_eq!(value["songs"].as_array().unwrap().len(), 100, "第 {page} 页 100 首");
        }

        // 越界页与 page=0(起点为负 → JS 空页)都不发 v3。
        assert!(index.songs(11, 100).unwrap()["songs"].as_array().unwrap().is_empty());
        assert!(index.songs(0, 100).unwrap()["songs"].as_array().unwrap().is_empty());

        let state = host.borrow();
        assert_eq!(state.v6_calls, 1, "v6 全量索引整批只请求一次");
        assert_eq!(state.v3_ids.len(), 10, "v3 每页一次(空页不发)");
        assert_eq!(state.v3_ids[0], (0..100).collect::<Vec<i64>>());
        assert_eq!(state.v3_ids[9], (900..1000).collect::<Vec<i64>>(), "第 10 页取 900..999");
    }

    /// `playlist-songs`(UI 分页浏览)复用同一形态: 一次调用仍是 1×v6 + 当页 v3,
    /// 响应形状与 0.3.14 逐字一致(第 10 页 → id 900..999)。
    #[test]
    fn playlist_songs_single_page_reuses_index_form() {
        let host = install_playlist_host(1000);
        let value = playlist_songs("42", 10, 100).unwrap();
        assert_eq!(value["name"], "大歌单");
        assert_eq!(value["total"], 1000);
        assert_eq!(value["page"], 10);
        assert_eq!(value["page_size"], 100);
        let songs = value["songs"].as_array().unwrap();
        assert_eq!(songs.len(), 100);
        assert_eq!(songs[0]["id"], "900");
        assert_eq!(songs[99]["id"], "999");

        let state = host.borrow();
        assert_eq!(state.v6_calls, 1);
        assert_eq!(state.v3_ids, vec![(900..1000).collect::<Vec<i64>>()]);
    }
}
