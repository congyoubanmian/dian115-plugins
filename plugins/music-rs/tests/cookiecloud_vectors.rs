//! CookieCloud 解密的**集成测试**(只走 crate 的公开 API + 夹具, 不依赖线上数据)。
//!
//! 从 `plugins/douban-rs/tests/cookiecloud_vectors.rs` 原样移植(0.3.4), 回归目标
//! 与那边一致 —— 加解密核心是同一套 `cookiecloud.go` 移植的逐函数拷贝:
//! - 密钥材料 = `md5(uuid + "-" + password)` 的十六进制前 16 个字符(不是摘要前 16 字节);
//! - `legacy` = OpenSSL `Salted__` 头 + `EVP_BytesToKey(md5, 1 轮)` AES-256-CBC + PKCS7;
//! - `aes-128-cbc-fixed` = AES-128-CBC, key = 密钥材料, IV = 16 字节 0;
//! - 错误文案与 Go 逐条一致(`未知密文格式` / `密文长度非法 (N)` /
//!   `填充校验失败（密钥不对或数据损坏）`)。
//!
//! 夹具 `tests/fixtures/cookiecloud_vectors.json` 与 douban-rs 是**同一份文件**
//! (逐字节拷贝, 明文里的 douban 域名条目只用于加解密回归, 不参与本插件的音乐域
//! 过滤 —— 域过滤/合并的用例在 `src/cookiecloud.rs` 的 `mod tests` 里, 那里才能装
//! 宿主替身)。夹具是**脱敏构造**的密文: 明文里的 cookie 与 uid 都是测试值
//! (`123456789` / `fake*`), legacy 密文由
//! `openssl enc -aes-256-cbc -md md5 -S <salt> -pass pass:<material>` 生成,
//! 固定 IV 密文由 `openssl enc -aes-128-cbc -K <material 的 hex> -iv 0…0` 生成
//! (生成命令记录在夹具 `note`), 不含任何真实凭据。
//!
//! 每条向量走三环: 用夹具记录的 key/iv **独立复算** → 公开 API **解密**逐字节等于明文 →
//! 用同一 key/iv **重新加密**逐字节等于夹具密文。任一环不符即失败 —— 这样"解密正确"与
//! "密文确实由该明文按该算法生成"两个方向都被钉住。

use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use aes::{Aes128, Aes256};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use cbc::Encryptor;
use md5::{Digest as _, Md5};
use plugin::cookiecloud::{aes_cbc_decrypt, cc_key_material, cookie_cloud_decrypt, evp_bytes_to_key};
use serde_json::Value;

/// 脱敏构造的解密回归向量。
const VECTORS: &[u8] = include_bytes!("fixtures/cookiecloud_vectors.json");

fn fixture() -> Value {
    serde_json::from_slice(VECTORS).expect("cookiecloud_vectors.json 必须是合法 JSON")
}

fn vectors(doc: &Value) -> &Vec<Value> {
    doc["vectors"].as_array().expect("vectors 必须是数组")
}

fn vector<'a>(doc: &'a Value, name: &str) -> &'a Value {
    vectors(doc)
        .iter()
        .find(|vector| vector["name"] == name)
        .unwrap_or_else(|| panic!("夹具里缺少向量 {name}"))
}

fn text<'a>(doc: &'a Value, key: &str) -> &'a str {
    doc[key].as_str().unwrap_or_else(|| panic!("夹具字段 {key} 必须是字符串"))
}

fn unhex(value: &str) -> Vec<u8> {
    hex::decode(value).expect("夹具里的 salt/key/iv 必须是十六进制")
}

/// 与实现无关的 `EVP_BytesToKey(passphrase, salt, MD5, 1 轮)`:
/// `D_i = MD5(D_{i-1} || passphrase || salt)`, 前 32 字节是 key、后 16 字节是 IV。
fn evp_bytes_to_key_reference(passphrase: &[u8], salt: &[u8]) -> ([u8; 32], [u8; 16]) {
    let mut out: Vec<u8> = Vec::with_capacity(48);
    let mut previous: Vec<u8> = Vec::new();
    while out.len() < 48 {
        let mut hasher = Md5::new();
        hasher.update(&previous);
        hasher.update(passphrase);
        hasher.update(salt);
        previous = hasher.finalize().to_vec();
        out.extend_from_slice(&previous);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&out[..32]);
    let mut iv = [0u8; 16];
    iv.copy_from_slice(&out[32..]);
    (key, iv)
}

/// PKCS7 加密(`openssl enc` 的默认填充), 用来反向核对密文。
fn encrypt_pkcs7(key: &[u8], iv: &[u8], plain: &[u8], aes256: bool) -> Vec<u8> {
    let mut buffer = plain.to_vec();
    buffer.resize(plain.len() + 16, 0);
    let padded_len = if aes256 {
        let encryptor = Encryptor::<Aes256>::new_from_slices(key, iv).expect("32 字节 key");
        encryptor
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, plain.len())
            .expect("缓冲留足了一个块")
            .len()
    } else {
        let encryptor = Encryptor::<Aes128>::new_from_slices(key, iv).expect("16 字节 key");
        encryptor
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, plain.len())
            .expect("缓冲留足了一个块")
            .len()
    };
    buffer.truncate(padded_len);
    buffer
}

/// 密钥材料是 `md5(uuid + "-" + password)` 的 **hex 文本前 16 个 ASCII 字节**。
#[test]
fn key_material_is_the_first_16_hex_chars_of_md5() {
    let doc = fixture();
    let uuid = text(&doc, "uuid");
    let password = text(&doc, "password");

    let digest = Md5::digest(format!("{uuid}-{password}").as_bytes());
    let full_hex = hex::encode(digest);
    assert_eq!(full_hex.len(), 32, "md5 的 hex 文本固定 32 字符");
    let expected = &full_hex[..16];

    assert_eq!(expected, text(&doc, "material"), "夹具记录的密钥材料必须能独立复算出来");
    let material = cc_key_material(uuid, password);
    assert_eq!(material.len(), 16, "密钥材料固定 16 字节");
    assert_eq!(String::from_utf8(material).unwrap(), expected);
    // 反例: 材料是 hex 文本前 16 个 ASCII 字节, 不是摘要前 16 字节的 hex(那会是 32 字符)
    assert_ne!(hex::encode(&digest[..16]), expected);
}

/// 每条向量: 独立复算 key/iv → 解密逐字节等于明文 → 再加密逐字节等于密文。
#[test]
fn every_vector_decrypts_and_reencrypts_byte_exact() {
    let doc = fixture();
    let uuid = text(&doc, "uuid");
    let password = text(&doc, "password");
    let material = cc_key_material(uuid, password);
    assert!(
        vectors(&doc).len() >= 5,
        "至少覆盖 legacy 的数组/对象/无豆瓣三种形态 + 固定 IV + 非 JSON 明文"
    );

    for vector in vectors(&doc) {
        let name = vector["name"].as_str().expect("向量必须有 name");
        let encrypted = vector["encrypted"].as_str().expect("向量必须有 encrypted");
        let plaintext = vector["plaintext"].as_str().expect("向量必须有 plaintext");
        let raw = STANDARD
            .decode(encrypted)
            .unwrap_or_else(|err| panic!("{name}: base64 解不开: {err}"));

        // ① 夹具记录的 key/iv 必须能由 material + salt 独立复算出来(openssl -P 的口径)
        let (key, iv, ciphertext, aes256) = match vector["salt_hex"].as_str() {
            Some(salt_hex) => {
                let salt = unhex(salt_hex);
                assert!(raw.len() >= 32, "{name}: legacy 密文至少 32 字节");
                assert_eq!(&raw[..8], b"Salted__", "{name}: legacy 密文必须带 OpenSSL Salted 头");
                assert_eq!(&raw[8..16], salt.as_slice(), "{name}: 头里的 salt 与夹具不一致");
                let (key, iv) = evp_bytes_to_key_reference(&material, &salt);
                (key.to_vec(), iv.to_vec(), raw[16..].to_vec(), true)
            }
            None => (material.clone(), vec![0u8; 16], raw.clone(), false),
        };
        assert_eq!(hex::encode(&key), text(vector, "key_hex"), "{name}: key 复算不一致");
        assert_eq!(hex::encode(&iv), text(vector, "iv_hex"), "{name}: iv 复算不一致");
        assert_eq!(ciphertext.len() % 16, 0, "{name}: 密文必须是块大小的整数倍");

        // ② 公开 API 解密 = 夹具明文(逐字节)
        let plain = cookie_cloud_decrypt(encrypted, vector["crypto_type"].as_str().unwrap(), uuid, password)
            .unwrap_or_else(|err| panic!("{name}: 解密失败: {}", err.message()));
        assert_eq!(plain, plaintext.as_bytes(), "{name}: 解密结果与夹具明文不一致");

        // ③ 公开 API 的 KDF 与独立实现逐字节一致
        if let Some(salt_hex) = vector["salt_hex"].as_str() {
            let (api_key, api_iv) = evp_bytes_to_key(&material, &unhex(salt_hex));
            assert_eq!(api_key.to_vec(), key, "{name}: evp_bytes_to_key 的 key 不一致");
            assert_eq!(api_iv.to_vec(), iv, "{name}: evp_bytes_to_key 的 iv 不一致");
        }

        // ④ 用同一 key/iv 重新加密 = 夹具密文 —— 证明密文确实是这段明文按该算法生成的
        let reencrypted = encrypt_pkcs7(&key, &iv, plaintext.as_bytes(), aes256);
        assert_eq!(reencrypted, ciphertext, "{name}: 再加密的密文与夹具不一致");
    }
}

/// `aes-128-cbc-fixed`: 没有 OpenSSL 头, key 就是密钥材料, IV 全零。
#[test]
fn fixed_iv_vector_uses_material_as_aes128_key_and_zero_iv() {
    let doc = fixture();
    let uuid = text(&doc, "uuid");
    let password = text(&doc, "password");
    let vector = vector(&doc, "aes_128_cbc_fixed");
    let encrypted = vector["encrypted"].as_str().unwrap();
    let raw = STANDARD.decode(encrypted).unwrap();
    assert!(!raw.starts_with(b"Salted__"), "固定 IV 模式不带 OpenSSL 头");
    assert!(vector["salt_hex"].is_null(), "固定 IV 向量不应记录 salt");

    let material = cc_key_material(uuid, password);
    assert_eq!(material.len(), 16, "固定 IV 模式用 AES-128");
    let expected = aes_cbc_decrypt(&raw, &material, &[0u8; 16]).expect("材料当 key、零 IV");
    assert_eq!(expected, vector["plaintext"].as_str().unwrap().as_bytes());
    assert_eq!(
        cookie_cloud_decrypt(encrypted, "aes-128-cbc-fixed", uuid, password).unwrap(),
        expected,
        "cookie_cloud_decrypt 的固定 IV 分支与手写调用必须一致"
    );

    // 非 `aes-128-cbc-fixed` 的 crypto_type 一律走 legacy 分支(Go 的 else),
    // 没有 Salted 头 → `未知密文格式`。
    let err = cookie_cloud_decrypt(encrypted, "aes-256-gcm", uuid, password).unwrap_err();
    assert_eq!(err.message(), "未知密文格式");
}

/// 与 Go `base64.StdEncoding` 一致: 缺 `=` 填充的密文也要能解。
#[test]
fn unpadded_base64_ciphertext_is_accepted_like_go() {
    let doc = fixture();
    let vector = vector(&doc, "legacy_modern_array");
    let padded = vector["encrypted"].as_str().unwrap();
    assert!(padded.ends_with("=="), "这条向量本该是补 padding 的形态");
    let unpadded = padded.trim_end_matches('=');
    let plain = cookie_cloud_decrypt(
        unpadded,
        "legacy",
        text(&doc, "uuid"),
        text(&doc, "password"),
    )
    .expect("Go 的 StdEncoding 收无 padding 输入");
    assert_eq!(plain, vector["plaintext"].as_str().unwrap().as_bytes());
}

/// 错误分支的文案必须与 Go 的 `fmt.Errorf` 逐字一致。
#[test]
fn error_branches_match_go_messages() {
    let doc = fixture();
    let uuid = text(&doc, "uuid");
    let password = text(&doc, "password");
    let legacy = vector(&doc, "legacy_modern_array")["encrypted"].as_str().unwrap();

    // 口令不对 → 填充校验失败(解垫失败)
    let err = cookie_cloud_decrypt(legacy, "legacy", uuid, text(&doc, "wrong_password")).unwrap_err();
    assert_eq!(err.message(), "填充校验失败（密钥不对或数据损坏）");

    // 篡改密文 → 同样解垫失败(两种模式各一条)
    for (key, crypto_type) in [
        ("tampered_legacy_b64", "legacy"),
        ("tampered_fixed_b64", "aes-128-cbc-fixed"),
    ] {
        let err = cookie_cloud_decrypt(text(&doc, key), crypto_type, uuid, password).unwrap_err();
        assert_eq!(err.message(), "填充校验失败（密钥不对或数据损坏）", "{key}");
    }

    // 长度够但不是 Salted 头
    let err = cookie_cloud_decrypt(text(&doc, "unknown_format_b64"), "legacy", uuid, password).unwrap_err();
    assert_eq!(err.message(), "未知密文格式");
    // 不是块大小整数倍 / 空密文
    let err = cookie_cloud_decrypt(text(&doc, "nonblock_b64"), "aes-128-cbc-fixed", uuid, password).unwrap_err();
    assert_eq!(err.message(), "密文长度非法 (10)");
    let err = cookie_cloud_decrypt("", "aes-128-cbc-fixed", uuid, password).unwrap_err();
    assert_eq!(err.message(), "密文长度非法 (0)");
    // legacy 太短(不足 32 字节)
    let err = cookie_cloud_decrypt("QUJD", "legacy", uuid, password).unwrap_err();
    assert_eq!(err.message(), "未知密文格式");
    // 非法 base64
    let err = cookie_cloud_decrypt("!!!not-base64!!!", "legacy", uuid, password).unwrap_err();
    assert!(err.message().starts_with("密文 base64 解码失败: "), "实际: {}", err.message());

    // 公开的 AES-CBC 守卫: 密钥长度只收 16/32
    assert_eq!(
        aes_cbc_decrypt(&[0u8; 16], &[0u8; 20], &[0u8; 16]).unwrap_err().message(),
        "非法密钥长度 20"
    );
    // 全零密文/全零 key 解出来的末字节是 0x3a(非 1..=16) → 填充校验失败
    assert_eq!(
        aes_cbc_decrypt(&[0u8; 16], &[0u8; 16], &[0u8; 16]).unwrap_err().message(),
        "填充校验失败（密钥不对或数据损坏）"
    );
}

/// 夹具本身必须保持脱敏: 口令是测试值, 出现的 `dbcl2` 值只能是测试 uid。
#[test]
fn fixture_stays_sanitized() {
    let doc = fixture();
    assert_eq!(text(&doc, "uuid"), "cc-test-uuid");
    assert_eq!(text(&doc, "password"), "cc-test-pass");
    assert_eq!(text(&doc, "material"), "3da15fcde08ae670");

    let mut seen_dbcl2 = 0;
    for vector in vectors(&doc) {
        let name = vector["name"].as_str().unwrap();
        let Some(plaintext) = vector["plaintext"].as_str() else { continue };
        // 兼容两种形态: 新版数组里是 `"dbcl2","value":"123456789:tok"`,
        // 旧版对象里是 `"dbcl2":"\"123456789:tok\""`(值本身带转义引号)。
        if let Some(after) = plaintext.split("dbcl2").nth(1) {
            let uid: String = after
                .chars()
                .skip_while(|ch| !ch.is_ascii_digit())
                .take_while(|ch| ch.is_ascii_digit())
                .collect();
            assert_eq!(uid, "123456789", "{name}: dbcl2 的 uid 必须是脱敏值");
            seen_dbcl2 += 1;
        }
    }
    assert!(seen_dbcl2 >= 2, "至少两条向量的明文里带 dbcl2 登录态");
}

/// 本插件(0.3.4)的音乐域过滤: 提取是**纯函数**(不需要宿主), 用夹具明文同款的
/// `cookie_data` 结构钉住两侧的域匹配与白名单过滤; 合并/登录态的用例在
/// `src/cookiecloud.rs`(需要 KV 宿主替身)。
#[test]
fn music_domain_extraction_filters_by_whitelist() {
    use std::collections::BTreeMap;

    use plugin::cookiecloud::{
        extract_cookies_from_cloud, is_netease_cloud_domain, is_qq_cloud_domain,
    };
    use plugin::netease::NETEASE_COOKIE_NAMES;
    use plugin::qq::QQ_COOKIE_NAMES;

    let cookie_data: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
        "music.163.com": [
            {"name": "MUSIC_U", "value": "fake-u"},
            {"name": "junk", "value": "x"},
            {"name": "NMTID", "value": "fake-nmtid"}
        ],
        "interface3.music.163.com": [{"name": "MUSIC_U", "value": "second-seen"}],
        "y.qq.com": {"uin": "o123", "qqmusic_key": "fake-qk"},
        ".qq.com": [{"name": "p_skey", "value": "fake-ps"}],
        "douban.com": [{"name": "dbcl2", "value": "123:tok"}],
        "163.com": {"MUSIC_U": "apex-not-matched"}
    }))
    .expect("构造的 cookie_data 必须能解");

    let netease = extract_cookies_from_cloud(&cookie_data, is_netease_cloud_domain, &NETEASE_COOKIE_NAMES);
    // 同名 cookie 先见先得(douban-rs `douban_cookie_from_cloud` 的语义): 域名按
    // BTreeMap 字典序遍历, "interface3.music.163.com" < "music.163.com"('i' < 'm'),
    // 所以子域条目反而先见。
    assert_eq!(
        netease.get("MUSIC_U").map(String::as_str),
        Some("second-seen"),
        "字典序靠前的 interface3.music.163.com 先见先得"
    );
    assert_eq!(netease.get("NMTID").map(String::as_str), Some("fake-nmtid"));
    assert!(!netease.contains_key("junk"), "白名单外不得入库");
    assert_eq!(netease.len(), 2);

    let qq = extract_cookies_from_cloud(&cookie_data, is_qq_cloud_domain, &QQ_COOKIE_NAMES);
    assert_eq!(qq.get("uin").map(String::as_str), Some("o123"));
    assert_eq!(qq.get("qqmusic_key").map(String::as_str), Some("fake-qk"));
    assert_eq!(qq.get("p_skey").map(String::as_str), Some("fake-ps"));
    assert_eq!(qq.len(), 3);

    // 豆瓣域两侧都不要; 163.com 裸域不属于 music.163.com 的子域。
    assert!(!is_netease_cloud_domain("douban.com"));
    assert!(!is_qq_cloud_domain("douban.com"));
    assert!(!is_netease_cloud_domain("163.com"));
}
