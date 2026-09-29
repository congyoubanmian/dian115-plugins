//! CookieCloud 客户端(整份 `cookiecloud.go` 的移植): 拉取浏览器同步的加密 cookie 并解出
//! 豆瓣登录态。
//!
//! 协议: `GET {server}/get/{uuid}` → `{"encrypted": "...", "crypto_type": "..."}`
//! - `legacy`(默认): `"U2FsdGVkX1"` 开头(OpenSSL Salted) + EVP_BytesToKey(md5) AES-256-CBC
//! - `aes-128-cbc-fixed`: 裸 base64 密文, key = `md5(uuid-password)[:16]`, IV = 16 字节 0
//!
//! 两种模式的口令/密钥都是 `md5(uuid + "-" + password).hexdigest()` 的前 16 **个字符**
//! (注意: 是 hex 文本的前 16 字节, 不是摘要前 16 字节)。
//!
//! # 路 2(CookieCloud 与想看)的名下文件
//!
//! 本文件与 [`crate::wish`] 属于同一路: **并行阶段只填这两个文件里的函数体**。
//! 冻结文件(任何一路都不得修改): `lib.rs`、`runtime.rs`、`protocol.rs`、`host.rs`、
//! `store.rs`、`model.rs`、`raw.rs`、`util.rs`、`clock.rs`、`Cargo.toml`。
//! 另外两路的名下文件: 路 1 = `charts.rs` + `poster.rs`, 路 3 = `subscribe.rs`。
//!
//! # 已冻结的调用点
//!
//! - [`crate::wish::Runtime::douban_cookie`](`wish.go:67`) → [`Runtime::cookie_cloud_pull`]
//!   与 [`douban_cookie_from_cloud`]
//! - [`crate::wish::Runtime::action_cookie_cloud_test`](`wish.go:366`) → 同上两个
//! - 本文件内: `cookie_cloud_pull` → `cookie_cloud_decrypt` → `cc_key_material` /
//!   `evp_bytes_to_key` / `aes_cbc_decrypt`
//!
//! # 实现要点(照抄时对照)
//!
//! - 出站 GET 用 [`Runtime::http_get`](`main.go:565`): 它返回 Go 的 `(body, status, err)`
//!   三元组, `status == 200 && body 含 "Not Found"` 这种分支要用到 status。
//!   Go 里 `if err != nil` 在前, `status >= 400` 分支实际上到不了(出错时 status 也带着),
//!   照抄即可, 不要"顺手修"成不同的文案。
//! - 密文长度上限 [`MAX_COOKIE_CLOUD_BYTES`] 比的是 `encrypted` **字符串长度**
//!   (Go 的 `len(res.Encrypted)`), 不是解码后的字节数。
//! - 解密只在后台任务里跑: 117KB 信封在 wazero 解释器里 AES 要数秒, 前台 10s 预算扛不住。
//! - [`douban_cookie_from_cloud`] 的 cookie 顺序: Go 遍历 `map`(随机序)且"先见先得",
//!   这里用 [`BTreeMap`] 的字典序, 结果**确定**但可能与 Go 某次运行的顺序不同;
//!   豆瓣只要求 `dbcl2` 在场, 顺序无影响。多个域名里出现同名 cookie 时, Go 取随机
//!   那个, 这里取字典序最小的域名里的那个。
//! - `dbcl2` 的值可能带引号(`dbcl2="123:token"`), uid 是冒号前段**去掉引号**后的文本。

use std::collections::BTreeMap;

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, KeyIvInit};
use aes::{Aes128, Aes256};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use cbc::Decryptor;
use md5::{Digest, Md5};
use serde_json::Value;

use crate::protocol::OpError;
use crate::runtime::Runtime;
use crate::util;

/// 单元测试共用的假宿主(只在 `cargo test` 下编译, 见 `cc_test_support.rs`)。
#[cfg(test)]
#[path = "cc_test_support.rs"]
pub(crate) mod test_support;

/// 密文长度上限(Go `cookiecloud.go:22` `maxCookieCloudBytes`): base64 文本 512KB,
/// 约对应几 MB 明文 cookie; 超过视为"未限域的全量同步", 直接指引用户改扩展配置。
pub const MAX_COOKIE_CLOUD_BYTES: usize = 512 << 10;

/// base64 解码: 与 Go `base64.StdEncoding.DecodeString` 一样容忍**缺失的 `=` 填充**
/// (Go 的 StdEncoding 解码器接受长度合法的无 padding 尾部), 因此先按规范形态解,
/// 失败再按不补 padding 的形态解 —— 两种输入都收。错误文案保持
/// `密文 base64 解码失败: <err>`。
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
    /// 两种都要能解 —— 所以这里是未定型的 [`Value`], 由 [`douban_cookie_from_cloud`] 判定)。
    pub cookie_data: BTreeMap<String, Value>,
}

/// 新版 CookieCloud 的单个 cookie 条目(Go `cookiecloud.go:142` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CcCookie {
    pub name: String,
    pub value: String,
}

impl Runtime {
    /// Go `cookiecloud.go:30` `cookieCloudPull`: 拉取 + 解密, 返回 `cookie_data` 域名表。
    ///
    /// 错误文案逐条对齐(它们会原样进 `WishInfo.last_error` 与 `cookiecloud-test` 的提示):
    /// - `CookieCloud 地址或 UUID 未配置`
    /// - `CookieCloud 不可达: <err>`
    /// - `CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）`(200 且 body 含 `Not Found`)
    /// - `CookieCloud HTTP <status>: <body 前 200 字节>`
    /// - `CookieCloud 响应异常（UUID 不存在或服务端版本过旧）`
    /// - `同步数据过大(<x.x>MB, 上限 <n>KB)：请在浏览器 CookieCloud 扩展里把「需要同步的域名」设为 douban.com 后重新同步`
    /// - `CookieCloud 解密后解析失败: <err>`
    ///
    /// `server` 会先 `trim` 并去掉结尾的 `/`; `uuid` 同样 `trim`。
    pub fn cookie_cloud_pull(
        &self,
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
        let got = self.http_get(&url, "application/json");
        if let Some(err) = got.error {
            return Err(OpError::new(format!("CookieCloud 不可达: {}", err.message())));
        }
        // Go: `status == 200 && strings.Contains(string(body), "Not Found")`
        if got.status == 200 && contains_bytes(&got.body, b"Not Found") {
            return Err(OpError::new("CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）"));
        }
        // Go 里这一支在 httpGet 之后不可达(err != nil 已经先返回); 照抄保留。
        if got.status >= 400 {
            return Err(OpError::new(format!(
                "CookieCloud HTTP {}: {}",
                got.status,
                util::trunc(&got.body)
            )));
        }
        let result: CookieCloudResult = match crate::model::decode(&got.body) {
            Some(result) => result,
            None => return Err(OpError::new("CookieCloud 响应异常（UUID 不存在或服务端版本过旧）")),
        };
        if result.encrypted.is_empty() {
            return Err(OpError::new("CookieCloud 响应异常（UUID 不存在或服务端版本过旧）"));
        }
        // 全量浏览器 cookie 的密文可达数 MB, 在 WASM 解释器里解密会撞前台 10 秒强杀线,
        // 因此按 Go 的口径比较 **encrypted 文本长度**, 超限直接指引限域, 不再解密。
        if result.encrypted.len() > MAX_COOKIE_CLOUD_BYTES {
            return Err(OpError::new(format!(
                "同步数据过大({:.1}MB, 上限 {:.0}KB)：请在浏览器 CookieCloud 扩展里把「需要同步的域名」设为 douban.com 后重新同步",
                result.encrypted.len() as f64 / 1_048_576.0,
                MAX_COOKIE_CLOUD_BYTES as f64 / 1024.0
            )));
        }
        let plain = cookie_cloud_decrypt(&result.encrypted, &result.crypto_type, uuid, key)?;
        match crate::model::decode::<CookieCloudDoc>(&plain) {
            Some(doc) => Ok(doc.cookie_data),
            None => Err(OpError::new(format!(
                "CookieCloud 解密后解析失败: {}",
                decode_error_text::<CookieCloudDoc>(&plain)
            ))),
        }
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
/// - `aes-128-cbc-fixed`: base64(Std; 与 Go 的 `base64.StdEncoding` 一样也收缺 padding
///   的形态)解出密文, key = 密钥材料, IV = 16 字节 0;
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
///
/// 用 `aes::{Aes128, Aes256}` + `cbc::Decryptor`, 都从 `aes::cipher` 取 trait:
/// `use aes::cipher::{BlockDecryptMut, KeyIvInit};`。
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
        let mut decryptor =
            Decryptor::<Aes128>::new_from_slices(key, iv).map_err(|_| invalid_length())?;
        decryptor
            .decrypt_padded_mut::<Pkcs7>(&mut buffer)
            .map_err(|_| pad_error())?
            .to_vec()
    } else {
        let mut decryptor =
            Decryptor::<Aes256>::new_from_slices(key, iv).map_err(|_| invalid_length())?;
        decryptor
            .decrypt_padded_mut::<Pkcs7>(&mut buffer)
            .map_err(|_| pad_error())?
            .to_vec()
    };
    Ok(plain)
}

/// Go `cookiecloud.go:140` `doubanCookieFromCloud`: 从 `cookie_data` 提取
/// `(cookie 头, uid, cookie 个数)`。
///
/// 只收域名里含 `douban.com` 的条目; 新版数组形态(`[{name,value}]`)与旧版对象形态
/// (`{name: value}`)都要认(先试数组, 解不出来再试对象)。没有 `dbcl2` 时返回
/// `("", "", jar 大小)` —— 调用方据此给出"浏览器需要登录 douban.com"的提示。
///
/// uid = `dbcl2` 冒号前段去掉引号; cookie 头是 `k=v` 用 `"; "` 连接。
pub fn douban_cookie_from_cloud(cookie_data: &BTreeMap<String, Value>) -> (String, String, usize) {
    let mut jar: BTreeMap<String, String> = BTreeMap::new();
    for (domain, raw) in cookie_data {
        if !domain.contains("douban.com") {
            continue;
        }
        // 新版: [{name, value, ...}] —— Go 是 `json.Unmarshal(raw, &list) == nil && list != nil`
        if let Ok(list) = serde_json::from_value::<Vec<CcCookie>>(raw.clone()) {
            for cookie in list {
                if !cookie.name.is_empty() && !cookie.value.is_empty() {
                    jar.entry(cookie.name).or_insert(cookie.value);
                }
            }
            continue;
        }
        // 旧版: {name: value}(Go 的 map 路径不过滤空值)
        if let Ok(map) = serde_json::from_value::<BTreeMap<String, String>>(raw.clone()) {
            for (name, value) in map {
                jar.entry(name).or_insert(value);
            }
        }
    }
    let dbcl2 = jar.get("dbcl2").cloned().unwrap_or_default();
    if dbcl2.is_empty() {
        return (String::new(), String::new(), jar.len());
    }
    // CookieCloud 保存的值可能带引号(dbcl2="123:token"), 拼 URL 前要去掉。
    let uid = dbcl2
        .splitn(2, ':')
        .next()
        .unwrap_or("")
        .trim_matches('"')
        .to_string();
    let mut parts: Vec<String> = Vec::with_capacity(jar.len());
    for (name, value) in &jar {
        parts.push(format!("{name}={value}"));
    }
    (parts.join("; "), uid, jar.len())
}

// ─────────────────────────── 内部辅助 ───────────────────────────

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

/// 解码失败时回显 serde 的错误文本(Go 那边是 `json.Unmarshal` 的 `%v`)。
fn decode_error_text<T: serde::de::DeserializeOwned>(raw: &[u8]) -> String {
    match serde_json::from_slice::<T>(raw) {
        Ok(_) => "类型不符".to_string(),
        Err(err) => err.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookiecloud::test_support::{Route, TestHost};

    /// 脱敏构造的解密回归向量(明文与凭据都是测试值, 见夹具里的 note)。
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

    #[test]
    fn key_material_is_the_first_16_hex_chars() {
        let doc = vector_doc();
        let material = cc_key_material(
            doc["uuid"].as_str().unwrap(),
            doc["password"].as_str().unwrap(),
        );
        assert_eq!(material.len(), 16, "密钥材料固定 16 字节");
        assert_eq!(String::from_utf8(material).unwrap(), doc["material"].as_str().unwrap());
    }

    /// 每个向量都必须能解密回夹具里记录的**逐字节**明文。
    #[test]
    fn decrypts_generated_vectors_byte_exact() {
        let doc = vector_doc();
        let uuid = doc["uuid"].as_str().unwrap();
        let password = doc["password"].as_str().unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 5, "至少覆盖 legacy 三种形态 + fixed + 非 JSON 明文");
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let plain = cookie_cloud_decrypt(
                vector["encrypted"].as_str().unwrap(),
                vector["crypto_type"].as_str().unwrap(),
                uuid,
                password,
            )
            .unwrap_or_else(|err| panic!("{name} 解密失败: {}", err.message()));
            assert_eq!(
                std::str::from_utf8(&plain).unwrap(),
                vector["plaintext"].as_str().unwrap(),
                "{name} 明文不一致"
            );
        }
    }

    /// EVP_BytesToKey 必须与 OpenSSL(md5, 1 轮)一致: 夹具里的 key/iv 由 `openssl enc -P` 给出。
    #[test]
    fn evp_bytes_to_key_matches_openssl() {
        let doc = vector_doc();
        let material = doc["material"].as_str().unwrap();
        for vector in doc["vectors"].as_array().unwrap() {
            let (key, iv) = match vector["salt_hex"].as_str() {
                Some(salt_hex) => {
                    let salt = hex::decode(salt_hex).expect("salt_hex 必须是十六进制");
                    let (key, iv) = evp_bytes_to_key(material.as_bytes(), &salt);
                    (key.to_vec(), iv.to_vec())
                }
                // aes-128-cbc-fixed: key = 密钥材料本身(16 字节), IV = 零
                None => (material.as_bytes().to_vec(), vec![0u8; 16]),
            };
            assert_eq!(hex::encode(&key), vector["key_hex"].as_str().unwrap());
            assert_eq!(hex::encode(&iv), vector["iv_hex"].as_str().unwrap());
        }
    }

    /// 口令不对 → 填充校验失败(夹具里的密文在 openssl 侧同样解垫失败, 是确定性的反例)。
    #[test]
    fn wrong_password_fails_padding_check() {
        let doc = vector_doc();
        let vector = vector(&doc, "legacy_modern_array");
        let err = cookie_cloud_decrypt(
            vector["encrypted"].as_str().unwrap(),
            "legacy",
            doc["uuid"].as_str().unwrap(),
            doc["wrong_password"].as_str().unwrap(),
        )
        .expect_err("错误口令必须解垫失败");
        assert_eq!(err.message(), "填充校验失败（密钥不对或数据损坏）");
    }

    #[test]
    fn tampered_ciphertext_fails_padding_check() {
        let doc = vector_doc();
        let uuid = doc["uuid"].as_str().unwrap();
        let password = doc["password"].as_str().unwrap();
        let err = cookie_cloud_decrypt(
            doc["tampered_legacy_b64"].as_str().unwrap(),
            "legacy",
            uuid,
            password,
        )
        .expect_err("篡改后的 Salted 密文必须解垫失败");
        assert_eq!(err.message(), "填充校验失败（密钥不对或数据损坏）");
        let err = cookie_cloud_decrypt(
            doc["tampered_fixed_b64"].as_str().unwrap(),
            "aes-128-cbc-fixed",
            uuid,
            password,
        )
        .expect_err("篡改后的固定 IV 密文必须解垫失败");
        assert_eq!(err.message(), "填充校验失败（密钥不对或数据损坏）");
    }

    #[test]
    fn format_and_length_guards_match_go_messages() {
        let doc = vector_doc();
        let uuid = doc["uuid"].as_str().unwrap();
        let password = doc["password"].as_str().unwrap();
        // 不是 Salted__ 开头(32 字节, 长度够)
        let err = cookie_cloud_decrypt(
            doc["unknown_format_b64"].as_str().unwrap(),
            "legacy",
            uuid,
            password,
        )
        .unwrap_err();
        assert_eq!(err.message(), "未知密文格式");
        // 长度 10: 不是块大小整数倍
        let err = cookie_cloud_decrypt(
            doc["nonblock_b64"].as_str().unwrap(),
            "aes-128-cbc-fixed",
            uuid,
            password,
        )
        .unwrap_err();
        assert_eq!(err.message(), "密文长度非法 (10)");
        // 空密文
        let err = cookie_cloud_decrypt("", "aes-128-cbc-fixed", uuid, password).unwrap_err();
        assert_eq!(err.message(), "密文长度非法 (0)");
        // 非法 base64
        let err = cookie_cloud_decrypt("!!!not-base64!!!", "legacy", uuid, password).unwrap_err();
        assert!(
            err.message().starts_with("密文 base64 解码失败: "),
            "实际: {}",
            err.message()
        );
        // legacy 太短(不足 32 字节)
        let err = cookie_cloud_decrypt("QUJD", "legacy", uuid, password).unwrap_err();
        assert_eq!(err.message(), "未知密文格式");
    }

    /// Go 的 `base64.StdEncoding` 解码容忍缺失的 `=` 填充, 这里也要收 ——
    /// 先按规范形态解, 失败再按无 padding 形态解, 两种输入结果必须一致。
    #[test]
    fn unpadded_base64_is_accepted_like_go() {
        let doc = vector_doc();
        let uuid = doc["uuid"].as_str().unwrap();
        let password = doc["password"].as_str().unwrap();
        let vector = vector(&doc, "legacy_modern_array");
        let padded = vector["encrypted"].as_str().unwrap();
        assert!(padded.ends_with("=="), "这条向量必须带 base64 padding: {padded}");
        let unpadded = padded.trim_end_matches('=');
        for input in [padded, unpadded] {
            let plain = cookie_cloud_decrypt(input, "legacy", uuid, password)
                .unwrap_or_else(|err| panic!("{input:.24}… 解密失败: {}", err.message()));
            assert_eq!(
                std::str::from_utf8(&plain).unwrap(),
                vector["plaintext"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn aes_cbc_decrypt_guards() {
        assert_eq!(
            aes_cbc_decrypt(&[0u8; 16], &[0u8; 20], &[0u8; 16]).unwrap_err().message(),
            "非法密钥长度 20"
        );
        assert_eq!(
            aes_cbc_decrypt(&[], &[0u8; 16], &[0u8; 16]).unwrap_err().message(),
            "密文长度非法 (0)"
        );
        assert_eq!(
            aes_cbc_decrypt(&[0u8; 15], &[0u8; 16], &[0u8; 16]).unwrap_err().message(),
            "密文长度非法 (15)"
        );
        // 全零密文/全零 key 解出来的末字节是 0x3a(非 1..16) → 填充校验失败
        assert_eq!(
            aes_cbc_decrypt(&[0u8; 16], &[0u8; 16], &[0u8; 16]).unwrap_err().message(),
            "填充校验失败（密钥不对或数据损坏）"
        );
    }

    #[test]
    fn pulls_and_decrypts_legacy_payload_from_fake_host() {
        let doc = vector_doc();
        let vector = vector(&doc, "legacy_modern_array");
        let body = serde_json::json!({
            "encrypted": vector["encrypted"],
            "crypto_type": "legacy",
        })
        .to_string();
        let host = TestHost::install(vec![Route::json(
            "GET",
            "http://127.0.0.1:8088/get/cc-test-uuid",
            &body,
        )]);
        let runtime = Runtime::new();
        // server 带首尾空白与结尾斜杠, uuid 带空白 —— 都要被 trim
        let data = runtime
            .cookie_cloud_pull("  http://127.0.0.1:8088/  ", "  cc-test-uuid  ", "cc-test-pass")
            .expect("必须能拉取并解密");
        assert_eq!(data.len(), 2, "douban.com 与 example.com 两个域名");
        assert!(data.contains_key("douban.com"));
        let (header, uid, count) = douban_cookie_from_cloud(&data);
        assert_eq!(uid, "123456789");
        assert_eq!(count, 5);
        assert!(header.contains("dbcl2=123456789:fakeTokenAbCdEf"), "实际: {header}");
        assert!(header.contains("ck=fakeCkValue"));

        let requests = host.requests();
        assert_eq!(requests.len(), 1, "只该发一次请求");
        assert_eq!(requests[0].path, "http://127.0.0.1:8088/get/cc-test-uuid");
        assert_eq!(
            requests[0].headers.get("accept").map(String::as_str),
            Some("application/json")
        );
    }

    /// uuid 里的特殊字符按 Go `url.PathEscape`(encodePathSegment)转义。
    #[test]
    fn pull_escapes_uuid_like_go_path_escape() {
        let host = TestHost::install(vec![Route::json("GET", "http://x/get/", "")]);
        let runtime = Runtime::new();
        let _ = runtime.cookie_cloud_pull("http://x", "cc test/中文", "k");
        assert_eq!(
            host.last_path("GET", "http://x/get/").as_deref(),
            Some("http://x/get/cc%20test%2F%E4%B8%AD%E6%96%87")
        );
    }

    #[test]
    fn pull_error_messages_match_go() {
        let runtime = Runtime::new();
        // ① 未配置
        assert_eq!(
            runtime.cookie_cloud_pull("", "u", "k").unwrap_err().message(),
            "CookieCloud 地址或 UUID 未配置"
        );
        assert_eq!(
            runtime.cookie_cloud_pull("http://x", "   ", "k").unwrap_err().message(),
            "CookieCloud 地址或 UUID 未配置"
        );

        // ② 200 且 body 含 "Not Found"
        let host = TestHost::install(vec![Route::new("GET", "http://x/get/u", 200, b"Not Found")]);
        assert_eq!(
            runtime.cookie_cloud_pull("http://x", "u", "k").unwrap_err().message(),
            "CookieCloud 无此 UUID 数据（浏览器扩展还没同步过）"
        );
        drop(host);

        // ③ host.call 失败
        let host = TestHost::install(vec![Route::fail("GET", "http://x/get/")]);
        assert_eq!(
            runtime.cookie_cloud_pull("http://x", "u", "k").unwrap_err().message(),
            "CookieCloud 不可达: host_call 返回长度 0"
        );
        drop(host);

        // ④ HTTP 4xx/5xx(Go 的 httpGet 也把它变成 error)
        let host = TestHost::install(vec![Route::new("GET", "http://x/get/", 500, b"boom")]);
        assert_eq!(
            runtime.cookie_cloud_pull("http://x", "u", "k").unwrap_err().message(),
            "CookieCloud 不可达: HTTP 500"
        );
        drop(host);

        // ⑤ 响应不是 JSON / encrypted 为空
        for body in ["<html>oops</html>", r#"{"encrypted":"","crypto_type":"legacy"}"#, "{}"] {
            let host = TestHost::install(vec![Route::json("GET", "http://x/get/", body)]);
            assert_eq!(
                runtime.cookie_cloud_pull("http://x", "u", "k").unwrap_err().message(),
                "CookieCloud 响应异常（UUID 不存在或服务端版本过旧）",
                "body={body}"
            );
            drop(host);
        }
    }

    #[test]
    fn pull_rejects_oversized_encrypted_payload() {
        let huge = format!(
            r#"{{"encrypted":"{}","crypto_type":"legacy"}}"#,
            "A".repeat(MAX_COOKIE_CLOUD_BYTES + 1)
        );
        let host = TestHost::install(vec![Route::json("GET", "http://x/get/", &huge)]);
        let runtime = Runtime::new();
        let err = runtime.cookie_cloud_pull("http://x", "u", "k").unwrap_err();
        assert!(
            err.message().starts_with("同步数据过大(0.5MB, 上限 512KB)："),
            "实际: {}",
            err.message()
        );
        assert!(err.message().contains("设为 douban.com"));
        drop(host);

        // 恰好等于上限时**不**拦截(Go 是 `>` 而不是 `>=`)
        let at_limit = format!(
            r#"{{"encrypted":"{}","crypto_type":"legacy"}}"#,
            "A".repeat(MAX_COOKIE_CLOUD_BYTES)
        );
        let host = TestHost::install(vec![Route::json("GET", "http://x/get/", &at_limit)]);
        let err = runtime.cookie_cloud_pull("http://x", "u", "k").unwrap_err();
        assert!(
            !err.message().starts_with("同步数据过大"),
            "上限内不该提示过大: {}",
            err.message()
        );
    }

    #[test]
    fn pull_reports_unparsable_plaintext() {
        let doc = vector_doc();
        let vector = vector(&doc, "legacy_non_json_plaintext");
        let body = serde_json::json!({"encrypted": vector["encrypted"], "crypto_type": "legacy"})
            .to_string();
        let host = TestHost::install(vec![Route::json("GET", "http://x/get/cc-test-uuid", &body)]);
        let runtime = Runtime::new();
        // 口令与 UUID 都要用夹具里的值: 密钥材料 = md5(uuid + "-" + password) 的 hex 前 16 位,
        // 传错 uuid 会先撞上"填充校验失败", 测不到"解密成功但明文不是 JSON"这条分支。
        let err = runtime
            .cookie_cloud_pull(
                "http://x",
                doc["uuid"].as_str().unwrap(),
                doc["password"].as_str().unwrap(),
            )
            .unwrap_err();
        assert!(
            err.message().starts_with("CookieCloud 解密后解析失败: "),
            "实际: {}",
            err.message()
        );
    }

    #[test]
    fn douban_cookie_from_cloud_reads_both_shapes() {
        let data: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "a.douban.com": [
                {"name": "dbcl2", "value": "\"123456789:tok\"", "domain": ".douban.com"},
                {"name": "ck", "value": "ckv"},
                {"name": "empty", "value": ""}
            ],
            "www.douban.com": {"dbcl2": "999:other", "bid": "bidv"},
            "other.com": {"dbcl2": "nope"}
        }))
        .expect("构造的 cookie_data 必须能解");

        let (header, uid, count) = douban_cookie_from_cloud(&data);
        // 域名按字典序: a.douban.com 先见, dbcl2 先见先得 → uid 来自 a.douban.com
        assert_eq!(uid, "123456789");
        assert_eq!(count, 3, "dbcl2/ck/bid; 空值条目被跳过, other.com 被忽略");
        assert_eq!(header, "bid=bidv; ck=ckv; dbcl2=\"123456789:tok\"");
    }

    #[test]
    fn douban_cookie_from_cloud_without_dbcl2() {
        let none_douban: BTreeMap<String, Value> = serde_json::from_value(
            serde_json::json!({"example.com": [{"name": "sid", "value": "x"}]}),
        )
        .unwrap();
        assert_eq!(douban_cookie_from_cloud(&none_douban), (String::new(), String::new(), 0));

        let no_dbcl2: BTreeMap<String, Value> = serde_json::from_value(
            serde_json::json!({"douban.com": [{"name": "ck", "value": "v"}]}),
        )
        .unwrap();
        assert_eq!(douban_cookie_from_cloud(&no_dbcl2), (String::new(), String::new(), 1));

        // 数组形态解不出来时回落到对象形态(Go 的两段式)
        let mixed: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "douban.com": [1, 2, 3]
        }))
        .unwrap();
        assert_eq!(douban_cookie_from_cloud(&mixed), (String::new(), String::new(), 0));
    }
}
