//! CookieCloud 客户端: 从本机 CookieCloud 服务拉取浏览器同步的加密数据, 解出
//! 网易云 / QQ 音乐登录态(0.3.4)。
//!
//! 整体移植自 `plugins/douban-rs/src/cookiecloud.rs`(同一套 `cookiecloud.go` 移植),
//! 加解密核心逐函数对齐; 两处按本插件语境适配:
//!
//! - **HTTP 层**: douban-rs 走 `Runtime::http_get`(自带豆瓣 UA/Referer); 本插件没有
//!   这个助手, 改用 [`crate::host::call`] 直接发 GET(与 `netease::get_url` /
//!   `qq::search` 同一条宿主链路), 只带 `accept: application/json`。
//! - **域名过滤**: 豆瓣版收 `domain.contains("douban.com")` 的所有条目; 本插件只收
//!   网易云与 QQ 音乐的域(见 [`is_netease_cloud_domain`] / [`is_qq_cloud_domain`]`),
//!   且按各自白名单([`crate::netease::NETEASE_COOKIE_NAMES`] /
//!   [`crate::qq::QQ_COOKIE_NAMES`])过滤后合并进会话 KV。douban 的子串匹配会把
//!   `xmusic.163.com` 这类域误判进来, 这里改成**后缀精确匹配**(域 = 本体或以其结尾)。
//!
//! 协议(与 douban-rs 一致): `GET {server}/get/{uuid}` →
//! `{"encrypted": "...", "crypto_type": "..."}`,两种密文形态:
//! - `legacy`(默认): `"U2FsdGVkX1"` 开头(OpenSSL Salted) + EVP_BytesToKey(md5) AES-256-CBC
//! - `aes-128-cbc-fixed`: 裸 base64 密文, key = 密钥材料, IV = 16 字节 0
//!
//! 两种模式的密钥材料都是 `md5(uuid + "-" + password).hexdigest()` 的前 16 **个字符**
//! (hex 文本的前 16 个 ASCII 字节, 不是摘要的前 16 字节)。
//!
//! # 宿主键名校验(2026-09-30)
//!
//! 宿主递归拒绝 state/action 响应里键名含 "cookie" 子串的整个响应, 因此本模块对外
//! 结果只用 `netease` / `qq` / `matched_domains` / `saved` / `logged_in` 这些键,
//! 绝不回显任何凭据值; 文案(日志/bump 消息)里的 "CookieCloud" 字样不受影响 ——
//! 那是**值**, 不是键名。

use std::collections::BTreeMap;

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, KeyIvInit};
use aes::{Aes128, Aes256};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use cbc::Decryptor;
use md5::{Digest, Md5};
use serde_json::{json, Value};

use crate::host::{self, HostCallRequest};
use crate::protocol::OpError;
use crate::store;
use crate::util;

/// 密文长度上限(douban-rs `cookiecloud.rs` / Go `cookiecloud.go:22`): base64 文本
/// 512KB, 超过视为"未限域的全量同步", 直接指引用户改扩展配置。
pub const MAX_COOKIE_CLOUD_BYTES: usize = 512 << 10;

/// base64 解码: 与 Go `base64.StdEncoding.DecodeString` 一样容忍**缺失的 `=` 填充**
/// (douban-rs 同款两段式: 先按规范形态解, 失败再按不补 padding 的形态解)。
fn decode_ciphertext_base64(encrypted: &str) -> Result<Vec<u8>, OpError> {
    STANDARD
        .decode(encrypted)
        .or_else(|_| STANDARD_NO_PAD.decode(encrypted))
        .map_err(|err| OpError::new(format!("密文 base64 解码失败: {err}")))
}

/// `/get/{uuid}` 的响应(Go `cookiecloud.go:24` `cookieCloudResult`)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CookieCloudResult {
    pub encrypted: String,
    pub crypto_type: String,
}

/// 解密后的 CookieCloud 文档(Go `cookiecloud.go:60` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CookieCloudDoc {
    /// 域名 → cookie 集合(新版是 `[{name,value,...}]` 数组, 旧版是 `{name:value}` 对象,
    /// 两种都要能解 —— 所以是未定型的 [`Value`], 由提取函数判定)。
    pub cookie_data: BTreeMap<String, Value>,
}

/// 新版 CookieCloud 的单个 cookie 条目(Go `cookiecloud.go:142` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CcCookie {
    pub name: String,
    pub value: String,
}

/// 拉取 + 解密(douban-rs `Runtime::cookie_cloud_pull` 的移植)。
///
/// 错误文案与 douban-rs 逐条对齐:
/// - `CookieCloud 地址或 UUID 未配置`
/// - `CookieCloud 不可达: <err>`
/// - `CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）`(200 且 body 含 `Not Found`)
/// - `CookieCloud HTTP <status>: <body 前 200 字节>`
/// - `CookieCloud 响应异常（UUID 不存在或服务端版本过旧）`
/// - `同步数据过大(<x.x>MB, 上限 <n>KB)：请在浏览器 CookieCloud 扩展里把「需要同步的域名」设为 … 后重新同步`
/// - `CookieCloud 解密后解析失败: <err>`
///
/// 与 douban-rs 的差异(移植注记): 那边 4xx/5xx 由 `http_get` 先行转成
/// `不可达: HTTP <status>`, `CookieCloud HTTP <status>: <body>` 分支实际到不了;
/// 这里直接用 [`host::call`], 4xx/5xx 就地走信息量更大的 `CookieCloud HTTP <status>`
/// 分支(响应体常带 `invalid uuid` 之类的线索)。
///
/// `server` 会先 `trim` 并去掉结尾的 `/`; `uuid` 同样 `trim`。
pub fn cookie_cloud_pull(
    server: &str,
    uuid: &str,
    key: &str,
) -> Result<BTreeMap<String, Value>, OpError> {
    let server = server.trim().trim_end_matches('/');
    let uuid = uuid.trim();
    if server.is_empty() || uuid.is_empty() {
        return Err(OpError::new("CookieCloud 地址或 UUID 未配置"));
    }
    let url = format!("{}/get/{}", server, path_escape(uuid));
    let request = HostCallRequest::new("GET", &url).with_header("accept", "application/json");
    let response = host::call(&request)
        .map_err(|err| OpError::new(format!("CookieCloud 不可达: {}", err.message())))?;
    let body = store::decode_body(&response)
        .map_err(|err| OpError::new(format!("CookieCloud 不可达: {err}")))?;
    // Go: `status == 200 && strings.Contains(string(body), "Not Found")`
    if response.status == 200 && contains_bytes(&body, b"Not Found") {
        return Err(OpError::new("CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）"));
    }
    if response.status >= 400 {
        return Err(OpError::new(format!(
            "CookieCloud HTTP {}: {}",
            response.status,
            util::trunc(&body)
        )));
    }
    let result: CookieCloudResult = match serde_json::from_slice(&body) {
        Ok(result) => result,
        Err(_) => return Err(OpError::new("CookieCloud 响应异常（UUID 不存在或服务端版本过旧）")),
    };
    if result.encrypted.is_empty() {
        return Err(OpError::new("CookieCloud 响应异常（UUID 不存在或服务端版本过旧）"));
    }
    // 全量浏览器 cookie 的密文可达数 MB, 在 WASM 解释器里解密会撞前台 10 秒强杀线,
    // 因此按 Go 的口径比较 **encrypted 文本长度**, 超限直接指引限域, 不再解密。
    // (指引文案按本插件语境换成网易云/QQ 音乐的域。)
    if result.encrypted.len() > MAX_COOKIE_CLOUD_BYTES {
        return Err(OpError::new(format!(
            "同步数据过大({:.1}MB, 上限 {:.0}KB)：请在浏览器 CookieCloud 扩展里把「需要同步的域名」设为 music.163.com 与 y.qq.com 后重新同步",
            result.encrypted.len() as f64 / 1_048_576.0,
            MAX_COOKIE_CLOUD_BYTES as f64 / 1024.0
        )));
    }
    let plain = cookie_cloud_decrypt(&result.encrypted, &result.crypto_type, uuid, key)?;
    match serde_json::from_slice::<CookieCloudDoc>(&plain) {
        Ok(doc) => Ok(doc.cookie_data),
        Err(err) => Err(OpError::new(format!("CookieCloud 解密后解析失败: {err}"))),
    }
}

/// Go `cookiecloud.go:69` `ccKeyMaterial`: `md5(uuid + "-" + password)` 的 hex 文本前 16
/// 个 **ASCII 字节**(返回值直接当密钥材料用, 长度固定 16)。
pub fn cc_key_material(uuid: &str, password: &str) -> Vec<u8> {
    let mut hasher = Md5::new();
    hasher.update(uuid.as_bytes());
    hasher.update(b"-");
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    let hex_text = hex::encode(&digest[..]);
    hex_text.as_bytes()[..16].to_vec()
}

/// Go `cookiecloud.go:75` `cookieCloudDecrypt`: 按 `crypto_type` 走两条解密路径。
///
/// - `aes-128-cbc-fixed`: base64(Std; 也收缺 padding 的形态)解出密文,
///   key = 密钥材料, IV = 16 字节 0;
/// - 其他(legacy): 密文必须是 `Salted__` 开头的 OpenSSL 格式(长度 >= 32), salt = 第 8..16
///   字节, `evp_bytes_to_key` 出 key/iv, 密文是第 16 字节之后的部分。
///
/// 错误文案: `密文 base64 解码失败: <err>` / `未知密文格式` / 以及
/// [`aes_cbc_decrypt`] 的 `非法密钥长度 N` / `密文长度非法 (N)` /
/// `填充校验失败（密钥不对或数据损坏）`。
pub fn cookie_cloud_decrypt(
    encrypted: &str,
    crypto_type: &str,
    uuid: &str,
    password: &str,
) -> Result<Vec<u8>, OpError> {
    let material = cc_key_material(uuid, password);
    let raw = decode_ciphertext_base64(encrypted)?;
    if crypto_type == "aes-128-cbc-fixed" {
        return aes_cbc_decrypt(&raw, &material, &[0u8; 16]);
    }
    // legacy: OpenSSL Salted 格式
    if raw.len() < 32 || &raw[..8] != b"Salted__" {
        return Err(OpError::new("未知密文格式"));
    }
    let salt = &raw[8..16];
    let (key, iv) = evp_bytes_to_key(&material, salt);
    aes_cbc_decrypt(&raw[16..], &key, &iv)
}

/// Go `cookiecloud.go:98` `evpBytesToKey`(OpenSSL 兼容 KDF, MD5 一轮):
/// `out = MD5(prev || passphrase || salt)` 反复追加到 48 字节, 前 32 字节是 key、
/// 后 16 字节是 IV。
pub fn evp_bytes_to_key(passphrase: &[u8], salt: &[u8]) -> ([u8; 32], [u8; 16]) {
    let mut out = [0u8; 48];
    let mut previous: Vec<u8> = Vec::new();
    let mut filled = 0usize;
    while filled < 48 {
        let mut hasher = Md5::new();
        hasher.update(&previous);
        hasher.update(passphrase);
        hasher.update(salt);
        let digest = hasher.finalize();
        previous = digest[..].to_vec();
        out[filled..filled + 16].copy_from_slice(&previous);
        filled += 16;
    }
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];
    key.copy_from_slice(&out[..32]);
    iv.copy_from_slice(&out[32..]);
    (key, iv)
}

/// Go `cookiecloud.go:112` `aesCBCDecrypt`: AES-CBC 解密 + PKCS7 去填充。
///
/// key 只接受 16/32 字节(与 Go 一致); 密文为空或不是块大小(16)的整数倍 → 报错;
/// 填充字节必须 1..=16 且全部等于填充长度, 否则报 `填充校验失败（密钥不对或数据损坏）`。
pub fn aes_cbc_decrypt(data: &[u8], key: &[u8], iv: &[u8]) -> Result<Vec<u8>, OpError> {
    if key.len() != 16 && key.len() != 32 {
        return Err(OpError::new(format!("非法密钥长度 {}", key.len())));
    }
    if data.is_empty() || data.len() % 16 != 0 {
        return Err(OpError::new(format!("密文长度非法 ({})", data.len())));
    }
    let mut buffer = data.to_vec();
    let invalid_length = || OpError::new(format!("非法密钥长度 {}", key.len()));
    let pad_error = || OpError::new("填充校验失败（密钥不对或数据损坏）");
    // IV 在本模块里恒为 16 字节(零 IV 或 EVP_BytesToKey 的产物), new_from_slices 只在
    // 密钥/IV 长度不符时失败 —— 密钥长度上面已检查, IV 不符属不可达分支。
    let plain: Vec<u8> = if key.len() == 16 {
        let decryptor =
            Decryptor::<Aes128>::new_from_slices(key, iv).map_err(|_| invalid_length())?;
        decryptor
            .decrypt_padded_mut::<Pkcs7>(&mut buffer)
            .map_err(|_| pad_error())?
            .to_vec()
    } else {
        let decryptor =
            Decryptor::<Aes256>::new_from_slices(key, iv).map_err(|_| invalid_length())?;
        decryptor
            .decrypt_padded_mut::<Pkcs7>(&mut buffer)
            .map_err(|_| pad_error())?
            .to_vec()
    };
    Ok(plain)
}

// ─────────────────────────── 域名过滤与提取 ───────────────────────────

/// CookieCloud 域名键归一化: 去首尾空白与开头的 `.`(`.qq.com` 的通配形态)、
/// 结尾的 `.`(FQDN 形态), 全部转成裸主机名再匹配。
fn normalize_domain(domain: &str) -> &str {
    domain.trim().trim_start_matches('.').trim_end_matches('.')
}

/// CookieCloud 的域名键是否属于网易云登录域: `music.163.com` 及其子域。
///
/// 后缀精确匹配(`interface.music.163.com` ✓、`xmusic.163.com` ✗ —— douban 版的
/// `contains` 会把后者误判进来, 这里收紧)。
pub fn is_netease_cloud_domain(domain: &str) -> bool {
    let host = normalize_domain(domain);
    host == "music.163.com" || host.ends_with(".music.163.com")
}

/// CookieCloud 的域名键是否属于 QQ 音乐登录域: `y.qq.com` / `music.qq.com` /
/// `.qq.com`(qq.com 全子域通配桶) 及其子域。
///
/// 三者的并集恰好是 `qq.com` 及其所有子域(`y.qq.com`/`music.qq.com` 本身与各自的
/// 子域都落在 `*.qq.com` 里), 所以这里按 `qq.com` 后缀一次判定。
pub fn is_qq_cloud_domain(domain: &str) -> bool {
    let host = normalize_domain(domain);
    host == "qq.com" || host.ends_with(".qq.com")
}

/// 从解密出的 `cookie_data` 里提取指定域 + 白名单的 cookie(新版数组 / 旧版对象两种
/// 形态都认, 提取逻辑对齐 douban-rs `douban_cookie_from_cloud` 的逐域两段式)。
///
/// - 域名按 BTreeMap 字典序遍历, 同名 cookie 先见先得(结果确定);
/// - 数组形态要 `name`/`value` 都非空; 旧版对象形态与 douban 版的差异: 空值一律跳过,
///   避免用空串覆盖已存的登录字段;
/// - 名字必须在 `whitelist` 里(与各侧手动粘贴的清洗口径一致)。
pub fn extract_cookies_from_cloud(
    cookie_data: &BTreeMap<String, Value>,
    domain_match: fn(&str) -> bool,
    whitelist: &[&str],
) -> BTreeMap<String, String> {
    let mut jar: BTreeMap<String, String> = BTreeMap::new();
    for (domain, raw) in cookie_data {
        if !domain_match(domain) {
            continue;
        }
        // 新版: [{name, value, ...}]
        if let Ok(list) = serde_json::from_value::<Vec<CcCookie>>(raw.clone()) {
            for cookie in list {
                if !cookie.name.is_empty()
                    && !cookie.value.is_empty()
                    && whitelist.contains(&cookie.name.as_str())
                {
                    jar.entry(cookie.name).or_insert(cookie.value);
                }
            }
            continue;
        }
        // 旧版: {name: value}
        if let Ok(map) = serde_json::from_value::<BTreeMap<String, String>>(raw.clone()) {
            for (name, value) in map {
                if !value.is_empty() && whitelist.contains(&name.as_str()) {
                    jar.entry(name).or_insert(value);
                }
            }
        }
    }
    jar
}

/// action `cookiecloud-sync`(无入参): 拉取 → 解密 → 按域提取 → 合并进两侧会话 KV。
///
/// 返回(键名全部避开宿主 2026-09-30 的 "cookie" 子串校验, 也不回显任何凭据值):
/// `{"netease": {"saved": n, "logged_in": bool}, "qq": {"saved": n, "logged_in": bool},
///   "matched_domains": n}`
///
/// - `saved`: 各侧白名单过滤后合并写入的条数(QQ 侧与 [`crate::qq::save_cookie_string`]
///   同款: 含 `normalize_cookies` 补齐的 `uin`/`qqmusic_key`);
/// - `logged_in`: **合并后**从会话 KV 复核的登录态(网易云看 `MUSIC_U`/`MUSIC_A`,
///   QQ 看 `qqmusic_key`, 与各自 `login_status` 的判据一致);
/// - `matched_domains`: `cookie_data` 里命中任一侧域名过滤的域名个数。
pub fn action_cookiecloud_sync() -> Result<Value, String> {
    let settings = crate::download::load_settings();
    let data = cookie_cloud_pull(
        &settings.cookiecloud_url,
        &settings.cookiecloud_uuid,
        &settings.cookiecloud_key,
    )
    .map_err(|err| err.message().to_string())?;

    let matched_domains = data
        .keys()
        .filter(|domain| is_netease_cloud_domain(domain) || is_qq_cloud_domain(domain))
        .count();

    let netease_jar = extract_cookies_from_cloud(
        &data,
        is_netease_cloud_domain,
        &crate::netease::NETEASE_COOKIE_NAMES,
    );
    crate::netease::save_cookies(&netease_jar)
        .map_err(|err| format!("网易云登录态写入失败: {err}"))?;

    // QQ 侧与手动粘贴同一条清洗链: 白名单已在提取时过滤, 这里补齐 uin/qqmusic_key
    // 再合并(提取出的 qqmusic_key 缺失时可由 p_skey/skey/musickey 补上)。
    let mut qq_jar =
        extract_cookies_from_cloud(&data, is_qq_cloud_domain, &crate::qq::QQ_COOKIE_NAMES);
    crate::qq::normalize_cookies(&mut qq_jar, crate::qq::LoginKind::Qq);
    crate::qq::merge_cookies(&qq_jar).map_err(|err| format!("QQ 登录态写入失败: {err}"))?;

    // 合并后从 KV 复核登录态(云里没带的字段不抹掉已存的登录态)。
    let netease_cookies = crate::netease::load_cookies();
    let netease_logged_in = netease_cookies.get("MUSIC_U").map_or(false, |v| !v.is_empty())
        || netease_cookies.get("MUSIC_A").map_or(false, |v| !v.is_empty());
    let qq_logged_in = crate::qq::load_cookies()
        .get("qqmusic_key")
        .map_or(false, |v| !v.is_empty());

    Ok(json!({
        "netease": {"saved": netease_jar.len(), "logged_in": netease_logged_in},
        "qq": {"saved": qq_jar.len(), "logged_in": qq_logged_in},
        "matched_domains": matched_domains,
    }))
}

// ─────────────────────────── 内部辅助(douban-rs 同款) ───────────────────────────

/// Go `url.PathEscape`(encodePathSegment 模式): 未保留字符原样, 其余 `%XX` 大写。
fn path_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~')
            || matches!(byte, b'$' | b'&' | b'+' | b':' | b'=' | b'@');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 字节子串查找(Go `strings.Contains(string(body), ...)` 在字节上的等价物)。
fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack.windows(needle.len()).any(|window| window == needle)
}

// ─────────────────────────── 测试 ───────────────────────────

/// 需要宿主替身的用例(拉取 `/get/{uuid}`、全流程合并)在这里装替身;
/// 纯加解密向量在 `tests/cookiecloud_vectors.rs`(只走公开 API, 不需要宿主)。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock;
    use crate::host::{HostCallResponse, HostError};
    use aes::cipher::BlockEncryptMut;
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    /// 脱敏构造的解密回归向量(与 `tests/` 的夹具同一份)。
    const VECTORS: &[u8] = include_bytes!("../tests/fixtures/cookiecloud_vectors.json");

    fn vector_doc() -> Value {
        serde_json::from_slice(VECTORS).expect("cookiecloud_vectors.json 必须是合法 JSON")
    }

    fn vector<'a>(doc: &'a Value, name: &str) -> &'a Value {
        doc["vectors"]
            .as_array()
            .expect("vectors 必须是数组")
            .iter()
            .find(|vector| vector["name"] == name)
            .unwrap_or_else(|| panic!("夹具里缺少向量 {name}"))
    }

    /// PKCS7 加密(与集成测试同款): 用独立复算的 key/iv 生成 OpenSSL 形态的密文,
    /// 用于构造假的 `/get/` 响应(明文按测试需要定制, 不含真实凭据)。
    fn encrypt_pkcs7(key: &[u8], iv: &[u8], plain: &[u8]) -> Vec<u8> {
        let mut buffer = plain.to_vec();
        buffer.resize(plain.len() + 16, 0);
        let padded_len = if key.len() == 32 {
            let encryptor = cbc::Encryptor::<Aes256>::new_from_slices(key, iv).unwrap();
            encryptor.encrypt_padded_mut::<Pkcs7>(&mut buffer, plain.len()).unwrap().len()
        } else {
            let encryptor = cbc::Encryptor::<Aes128>::new_from_slices(key, iv).unwrap();
            encryptor.encrypt_padded_mut::<Pkcs7>(&mut buffer, plain.len()).unwrap().len()
        };
        buffer.truncate(padded_len);
        buffer
    }

    /// 用夹具凭据(uuid/password)按 legacy 形态加密任意明文 → `/get/` 响应 JSON。
    fn legacy_envelope(uuid: &str, password: &str, plaintext: &str) -> String {
        let material = cc_key_material(uuid, password);
        let salt: [u8; 8] = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
        let (key, iv) = evp_bytes_to_key(&material, &salt);
        let mut raw = b"Salted__".to_vec();
        raw.extend_from_slice(&salt);
        raw.extend_from_slice(&encrypt_pkcs7(&key, &iv, plaintext.as_bytes()));
        let encrypted = STANDARD.encode(&raw);
        serde_json::json!({"encrypted": encrypted, "crypto_type": "legacy"}).to_string()
    }

    /// 假宿主: `/get/{uuid}` 路由 + KV(`settings` / `cookies.netease` / `cookies.qq`)。
    #[derive(Debug, Default)]
    struct FakeCloudHost {
        kv: HashMap<String, (Vec<u8>, u64)>,
        gets: Vec<(String, String)>,
        get_body: Vec<u8>,
        get_status: i32,
        fail_get: bool,
    }

    fn json_response(status: i32, body: &[u8]) -> Result<HostCallResponse, HostError> {
        Ok(HostCallResponse {
            status,
            headers: Default::default(),
            body_base64: STANDARD_NO_PAD.encode(body),
        })
    }

    fn etag_headers(revision: u64) -> std::collections::BTreeMap<String, Vec<String>> {
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("ETag".to_string(), vec![format!("\"pkv_{revision}\"")]);
        headers
    }

    fn kv_response(
        state: &mut FakeCloudHost,
        request: &HostCallRequest,
        key: &str,
    ) -> Result<HostCallResponse, HostError> {
        match request.method.as_str() {
            "GET" => match state.kv.get(key).cloned() {
                Some((value, revision)) => Ok(HostCallResponse {
                    status: 200,
                    headers: etag_headers(revision),
                    body_base64: STANDARD_NO_PAD.encode(&value),
                }),
                None => Ok(HostCallResponse { status: 404, ..HostCallResponse::default() }),
            },
            "PUT" => {
                let idem = request.headers.get("idempotency-key").cloned().unwrap_or_default();
                if !(16..=128).contains(&idem.len())
                    || !idem.bytes().all(|byte| byte.is_ascii_graphic())
                {
                    return json_response(400, br#"{"error":"bad idempotency key"}"#);
                }
                let raw = STANDARD_NO_PAD
                    .decode(&request.body_base64)
                    .unwrap_or_default();
                let parsed: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
                let value = serde_json::to_vec(&parsed["value"]).unwrap_or_default();
                let current = state.kv.get(key).cloned();
                if let Some(if_match) = request.headers.get("if-match") {
                    let matches = match &current {
                        Some((_, revision)) => if_match == &format!("\"pkv_{revision}\""),
                        None => false,
                    };
                    if !matches {
                        return Ok(HostCallResponse { status: 412, ..HostCallResponse::default() });
                    }
                }
                let revision = current.map(|(_, revision)| revision).unwrap_or(0) + 1;
                state.kv.insert(key.to_string(), (value, revision));
                Ok(HostCallResponse {
                    status: 200,
                    headers: etag_headers(revision),
                    ..HostCallResponse::default()
                })
            }
            other => Err(HostError::new(format!("unexpected KV method: {other}"))),
        }
    }

    /// 装假宿主; 返回共享状态句柄(测试里塞 KV / 配置 `/get/` 响应)。
    fn install_cloud_host() -> Rc<RefCell<FakeCloudHost>> {
        let state = Rc::new(RefCell::new(FakeCloudHost {
            get_status: 200,
            ..FakeCloudHost::default()
        }));
        let shared = state.clone();
        crate::host::testhost::install(Box::new(move |request: &HostCallRequest| {
            let method = request.method.clone();
            let path = request.path.clone();
            let mut state = shared.borrow_mut();
            if path.starts_with("/api/plugin-runtime/storage/") {
                return kv_response(&mut state, request, &path["/api/plugin-runtime/storage/".len()..]);
            }
            if method == "GET" && path.starts_with("http://127.0.0.1:8088/get/") {
                state.gets.push((method, path));
                if state.fail_get {
                    return Err(HostError::new("host_call 返回长度 0"));
                }
                return json_response(state.get_status, &state.get_body);
            }
            Err(HostError::new(format!("unexpected host call: {method} {path}")))
        }));
        state
    }

    /// 预置设置(插件 KV `settings` 键): 指向夹具凭据。
    fn seed_settings(state: &mut FakeCloudHost, uuid: &str, password: &str) {
        let settings = serde_json::json!({
            "staging_dir": crate::download::DEFAULT_MUSIC_DIR,
            "target_dir": crate::download::DEFAULT_MUSIC_DIR,
            "quality": crate::download::DEFAULT_QUALITY,
            "max_active": crate::download::DEFAULT_MAX_ACTIVE,
            "notify_on_fail": true,
            "cookiecloud_url": "http://127.0.0.1:8088/",
            "cookiecloud_uuid": uuid,
            "cookiecloud_key": password,
        });
        state.kv.insert(
            crate::download::SETTINGS_KEY.to_string(),
            (serde_json::to_vec(&settings).unwrap(), 1),
        );
    }

    /// 递归断言: 响应树里任何键名都不含 "cookie" 子串(宿主 2026-09-30 规则)。
    fn assert_no_cookie_keys(value: &Value, path: &str) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    assert!(
                        !key.to_lowercase().contains("cookie"),
                        "响应键名含 cookie 子串: {path}.{key}"
                    );
                    assert_no_cookie_keys(inner, &format!("{path}.{key}"));
                }
            }
            Value::Array(items) => {
                for (index, inner) in items.iter().enumerate() {
                    assert_no_cookie_keys(inner, &format!("{path}[{index}]"));
                }
            }
            _ => {}
        }
    }

    /// 全流程: 拉取 → 解密 → 域过滤 → 合并 KV。云里的明文含网易云/QQ/豆瓣三种域
    /// (豆瓣域必须被忽略), 新旧两种条目形态都覆盖。
    #[test]
    fn sync_pulls_decrypts_and_merges_music_domains() {
        let doc = vector_doc();
        let uuid = doc["uuid"].as_str().unwrap();
        let password = doc["password"].as_str().unwrap();
        let plaintext = serde_json::json!({
            "cookie_data": {
                "music.163.com": [
                    {"name": "MUSIC_U", "value": "fake-music-u-token"},
                    {"name": "__csrf_token", "value": "fake-csrf"},
                    {"name": "NMTID", "value": "fake-nmtid"},
                    {"name": "OTHER", "value": "not-whitelisted"}
                ],
                ".music.163.com": [
                    {"name": "MUSIC_U", "value": "should-not-override-first"}
                ],
                "y.qq.com": {"uin": "o123456789", "qqmusic_key": "fake-qm-key", "junk": "x"},
                ".qq.com": [{"name": "p_skey", "value": "fake-pskey"}],
                "douban.com": [{"name": "dbcl2", "value": "123:tok"}],
                "example.com": {"sid": "fake-sid"}
            }
        })
        .to_string();
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), uuid, password);
        fake.borrow_mut().get_body = legacy_envelope(uuid, password, &plaintext).into_bytes();

        let outcome = action_cookiecloud_sync().expect("同步必须成功");

        assert_no_cookie_keys(&outcome, "$");
        assert_eq!(outcome["netease"]["saved"], 3, "MUSIC_U/__csrf_token/NMTID: {outcome}");
        assert_eq!(outcome["netease"]["logged_in"], true, "MUSIC_U 已入库");
        assert_eq!(outcome["qq"]["saved"], 3, "uin/qqmusic_key/p_skey: {outcome}");
        assert_eq!(outcome["qq"]["logged_in"], true, "qqmusic_key 已入库");
        assert_eq!(
            outcome["matched_domains"], 4,
            "music.163.com/.music.163.com/y.qq.com/.qq.com"
        );

        // 同名 cookie 先见先得: BTreeMap 字典序 '.'(0x2e) < 'm'(0x6d),
        // ".music.163.com" 先于 "music.163.com" 遍历。
        let netease = crate::netease::load_cookies();
        assert_eq!(
            netease.get("MUSIC_U").map(String::as_str),
            Some("should-not-override-first")
        );
        assert_eq!(netease.get("__csrf_token").map(String::as_str), Some("fake-csrf"));
        assert_eq!(netease.get("NMTID").map(String::as_str), Some("fake-nmtid"));
        assert!(!netease.contains_key("OTHER"), "白名单外的名字不得入库");
        assert!(!netease.contains_key("dbcl2"), "豆瓣域必须被忽略");
        let qq = crate::qq::load_cookies();
        assert_eq!(qq.get("qqmusic_key").map(String::as_str), Some("fake-qm-key"));
        assert_eq!(qq.get("uin").map(String::as_str), Some("o123456789"));
        assert_eq!(qq.get("p_skey").map(String::as_str), Some("fake-pskey"));
        assert!(!qq.contains_key("junk"), "白名单外的名字不得入库");

        assert_eq!(fake.borrow().gets.len(), 1, "只发一次拉取请求");
        let (method, path) = fake.borrow().gets[0].clone();
        assert_eq!(method, "GET");
        assert_eq!(path, "http://127.0.0.1:8088/get/cc-test-uuid", "server 尾部 / 与 uuid trim");
    }

    /// 云里没有音乐域时: saved 全 0、matched_domains 全 0、无登录态(KV 空)。
    #[test]
    fn sync_without_music_domains_reports_zero_saved() {
        let doc = vector_doc();
        let uuid = doc["uuid"].as_str().unwrap();
        let password = doc["password"].as_str().unwrap();
        // 夹具向量 legacy_modern_array 的明文只有 douban.com/example.com —— 直接复用。
        let vector = vector(&doc, "legacy_modern_array");
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), uuid, password);
        let body = serde_json::json!({
            "encrypted": vector["encrypted"],
            "crypto_type": "legacy",
        })
        .to_string();
        fake.borrow_mut().get_body = body.into_bytes();

        let outcome = action_cookiecloud_sync().expect("同步必须成功");
        assert_no_cookie_keys(&outcome, "$");
        assert_eq!(outcome["netease"]["saved"], 0);
        assert_eq!(outcome["qq"]["saved"], 0);
        assert_eq!(outcome["matched_domains"], 0);
        assert_eq!(outcome["netease"]["logged_in"], false, "KV 里没有会话");
    }

    /// settings 未配置 UUID → 未配置错误(KV 空, 走默认 URL + 空 UUID)。
    #[test]
    fn sync_without_uuid_reports_unconfigured() {
        install_cloud_host();
        let err = action_cookiecloud_sync().unwrap_err();
        assert_eq!(err, "CookieCloud 地址或 UUID 未配置");
    }

    /// 云端 404 语义: 200 + "Not Found" → 扩展还没同步过。
    #[test]
    fn sync_reports_not_found_like_reference() {
        let doc = vector_doc();
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), doc["uuid"].as_str().unwrap(), doc["password"].as_str().unwrap());
        fake.borrow_mut().get_body = b"Not Found".to_vec();
        let err = action_cookiecloud_sync().unwrap_err();
        assert_eq!(err, "CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）");
    }

    /// 4xx/5xx: 本插件直接走 `CookieCloud HTTP <status>: <body>` 分支(见模块头注记)。
    #[test]
    fn sync_reports_http_error_with_body() {
        let doc = vector_doc();
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), doc["uuid"].as_str().unwrap(), doc["password"].as_str().unwrap());
        fake.borrow_mut().get_status = 500;
        fake.borrow_mut().get_body = b"boom".to_vec();
        let err = action_cookiecloud_sync().unwrap_err();
        assert_eq!(err, "CookieCloud HTTP 500: boom");
    }

    /// 传输失败(替身报错)→ `CookieCloud 不可达`。
    #[test]
    fn sync_reports_unreachable_on_transport_error() {
        let doc = vector_doc();
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), doc["uuid"].as_str().unwrap(), doc["password"].as_str().unwrap());
        fake.borrow_mut().fail_get = true;
        let err = action_cookiecloud_sync().unwrap_err();
        assert_eq!(err, "CookieCloud 不可达: host_call 返回长度 0");
    }

    /// 解密成功但明文不是 JSON → `CookieCloud 解密后解析失败`。
    #[test]
    fn sync_reports_unparsable_plaintext() {
        let doc = vector_doc();
        let uuid = doc["uuid"].as_str().unwrap();
        let password = doc["password"].as_str().unwrap();
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), uuid, password);
        fake.borrow_mut().get_body = legacy_envelope(uuid, password, "this is not json at all: 不是 JSON")
            .into_bytes();
        let err = action_cookiecloud_sync().unwrap_err();
        assert!(err.starts_with("CookieCloud 解密后解析失败: "), "实际: {err}");
    }

    /// 超大密文按 `encrypted` 文本长度拦截(与 douban-rs 同口径, 指引文案换成音乐域)。
    #[test]
    fn sync_rejects_oversized_encrypted_payload() {
        let doc = vector_doc();
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), doc["uuid"].as_str().unwrap(), doc["password"].as_str().unwrap());
        let huge = format!(
            r#"{{"encrypted":"{}","crypto_type":"legacy"}}"#,
            "A".repeat(MAX_COOKIE_CLOUD_BYTES + 1)
        );
        fake.borrow_mut().get_body = huge.into_bytes();
        let err = action_cookiecloud_sync().unwrap_err();
        assert!(
            err.starts_with("同步数据过大(0.5MB, 上限 512KB)："),
            "实际: {err}"
        );
        assert!(err.contains("music.163.com"), "指引文案指向音乐域: {err}");
    }

    /// 域名匹配的边界: 本体/子域/通配点前缀/FQDN 尾点 ✓, 前缀混淆 ✗。
    #[test]
    fn domain_matchers_reject_lookalikes() {
        for domain in [
            "music.163.com",
            "  music.163.com  ",
            ".music.163.com",
            "interface.music.163.com",
            "music.163.com.",
        ] {
            assert!(is_netease_cloud_domain(domain), "{domain} 必须命中网易云域");
        }
        for domain in ["xmusic.163.com", "163.com", "music.163.cn", "evil.com/music.163.com"] {
            assert!(!is_netease_cloud_domain(domain), "{domain} 不得命中网易云域");
        }
        for domain in [
            "qq.com",
            ".qq.com",
            "y.qq.com",
            "music.qq.com",
            "u.y.qq.com",
            "c.y.qq.com",
            ".y.qq.com",
        ] {
            assert!(is_qq_cloud_domain(domain), "{domain} 必须命中 QQ 域");
        }
        for domain in ["qq.cn", "yqq.com", "music.qq.com.evil.com", "weixin.qq.comx"] {
            assert!(!is_qq_cloud_domain(domain), "{domain} 不得命中 QQ 域");
        }
    }

    /// 篡改密文/错误口令在同步链路里同样失败(填充校验)。
    #[test]
    fn sync_propagates_decrypt_failures() {
        let doc = vector_doc();
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), doc["uuid"].as_str().unwrap(), doc["password"].as_str().unwrap());
        let body = serde_json::json!({
            "encrypted": doc["tampered_legacy_b64"],
            "crypto_type": "legacy",
        })
        .to_string();
        fake.borrow_mut().get_body = body.into_bytes();
        let err = action_cookiecloud_sync().unwrap_err();
        assert_eq!(err, "填充校验失败（密钥不对或数据损坏）");
        drop(fake);

        // 非 legacy 也非 fixed 的 crypto_type → legacy 分支 → 未知密文格式
        let fake = install_cloud_host();
        seed_settings(&mut fake.borrow_mut(), doc["uuid"].as_str().unwrap(), doc["password"].as_str().unwrap());
        let body = serde_json::json!({
            "encrypted": "QUJD",
            "crypto_type": "aes-256-gcm",
        })
        .to_string();
        fake.borrow_mut().get_body = body.into_bytes();
        assert_eq!(action_cookiecloud_sync().unwrap_err(), "未知密文格式");
    }

    /// 时钟兜底引用(与 download.rs 测试同一约定; 本模块的幂等键由 netease/qq 侧生成)。
    #[test]
    fn clock_is_available_for_kv_writes() {
        clock::testhooks::set_now(Some(1_790_676_009_000_000_000));
        assert!(clock::now_unix_nanos() > 0);
        clock::testhooks::set_now(None);
    }
}
