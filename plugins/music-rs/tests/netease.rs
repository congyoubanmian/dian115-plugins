//! 网易云模块的**集成测试**(只走 crate 公开 API + 独立复算的向量, 不联网)。
//!
//! 覆盖契约要求的三项: AES-ECB 已知向量、eapi params 构造、cookie 字符串解析;
//! 另加音质阶梯、表单编码、payload 字面量、`SongUrl` 形状等纯函数断言。
//!
//! # 向量来源(都不是从本实现反推的)
//!
//! - **AES-128-ECB**: 先用 FIPS-197 附录 C.1 的公开向量(key
//!   `000102…0e0f` / 明文 `001122…eeff` → 密文 `69c4…c55a`)钉住分组算法;
//!   再对 Rust 侧的真实输入用 `openssl enc -aes-128-ecb -K <hex>` 复算。
//! - **eapi params**: 用两条独立路径复算并比对一致后才写进断言 ——
//!   node `crypto`(md5 + `aes-128-ecb` + 按键排序的 `JSON.stringify`)与
//!   python `hashlib` + `openssl`(键序 `sort_keys=True`);
//!   两者与 Go `encoding/json`(map 按键排序)+ `neteaseEapiParams` 同构。
//! - **URL 表单编码**: python `urllib.parse.quote_plus`(unreserved 集与 Go
//!   `url.QueryEscape` 相同: `A-Za-z0-9-_.~` 原样, 空格转 `+`)复算。
//! - **cookie / IP 表 / 音质阶梯**: 直接对照 Go `netease.go` 与 sidecar
//!   `server.mjs` / `fetch-worker.mjs` 的源码逐行取值。
//!
//! 需要宿主替身的用例(真实 HTTP 往返、KV 读写)在 `src/netease.rs` 的
//! `mod tests` 与后续阶段; 本文件只钉纯函数。

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use plugin::netease::{
    aes_ecb_encrypt, cookie_header, eapi_params, eapi_path, form_encode, ip_headers, level_ladder,
    login_status, parse_cookie_string, query_escape, request_id, song_url_payload, SongUrl,
    CHROME_UA, COOKIE_BASE, DESKTOP_UA, EAPI_KEY, LEVELS, LEVELS_ASCENDING, SONG_URL_API,
};

/// 本地 hex 解码(不引依赖; 长度必须是偶数)。
fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "hex 长度必须是偶数: {text}");
    (0..text.len() / 2)
        .map(|index| {
            u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).expect("必须是合法 hex")
        })
        .collect()
}

/// 本地 hex 编码(小写)。
fn enc_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn jar(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
        .collect()
}

/// AES-128-ECB/PKCS#7: FIPS-197 已知向量 + `openssl` 复算值。
///
/// 明文 16 字节时 PKCS#7 会补满一整块(与 Go `pad = 16 - len%16` 一致), 所以整体
/// 32 字节: 前 16 字节 = FIPS-197 的标准密文, 后 16 字节 = 对 `0x10 * 16` 的加密。
#[test]
fn aes_ecb_matches_fips_197_known_vector() {
    let key = unhex("000102030405060708090a0b0c0d0e0f");
    let plain = unhex("00112233445566778899aabbccddeeff");
    let out = aes_ecb_encrypt(&plain, &key).unwrap();
    assert_eq!(enc_hex(&out[..16]), "69c4e0d86a7b0430d8cdb78070b4c55a", "FIPS-197 C.1");
    assert_eq!(
        enc_hex(&out),
        "69c4e0d86a7b0430d8cdb78070b4c55a954f64f2e4e86e9eee82d20216684899",
        "含 PKCS#7 补块的完整输出(openssl 复算)"
    );
}

/// eapi 密钥下的短输入/空输入: 与 `openssl enc -aes-128-ecb` 复算逐字节一致。
#[test]
fn aes_ecb_pads_like_go_netease() {
    assert_eq!(EAPI_KEY.len(), 16);
    assert_eq!(enc_hex(&aes_ecb_encrypt(b"netease", EAPI_KEY).unwrap()), "4f90efeea825c5fb3f159f0a56a45736");
    assert_eq!(enc_hex(&aes_ecb_encrypt(b"", EAPI_KEY).unwrap()), "6aa3b102fbe7296ab0db9ea5c46ad12b", "空输入补满一整块");
    // 16 字节输入同样补满一整块(PKCS#7 标准行为)
    assert_eq!(aes_ecb_encrypt(&[0u8; 16], EAPI_KEY).unwrap().len(), 32);
    // 非 16 字节密钥: Go 的 aes.NewCipher 会报错, 这里返回 Err(不 panic)
    assert!(aes_ecb_encrypt(b"x", b"short").is_err());
    assert!(aes_ecb_encrypt(b"x", &[0u8; 24]).is_err(), "本移植点只支持 16 字节常量密钥");
}

/// Go `netease.go:120-131` 的 payload 字面量: 键序 = Go map 的排序键序,
/// `header` **故意不闭合**。
#[test]
fn song_url_payload_matches_go_literal() {
    // 0.3.9: 对齐 agent 验证形态 —— header 闭合、无 requestId; serde_json 按字典序
    // 序列化键(encodeType/header/ids/level), header 字符串内部保持 agent 的插入序。
    assert_eq!(
        song_url_payload("1234567", "lossless", 12_345_678).to_string(),
        r#"{"encodeType":"flac","header":"{\"os\":\"pc\",\"appver\":\"\",\"osver\":\"\",\"deviceId\":\"pyncm!\"}","ids":["1234567"],"level":"lossless"}"#
    );
}

/// eapi params 的完整向量(288 字节密文的 hex): 由 node 与 python+openssl 两条
/// 独立路径复算一致后固化。
#[test]
fn eapi_params_matches_independent_vector_lossless() {
    let payload = song_url_payload("1234567", "lossless", 12_345_678);
    assert_eq!(eapi_params(SONG_URL_API, &payload), "fa90b329e9614f79e79598f37dc2edb487f00d1bc4c9b24cd57e6c318b9073567565d994ef3a89f5356c243f90d8099d485db260fa577059c3e1cfbfb3b6e9c157e2dbb5c19220c20ee55de2b6b8e0c0da6346d00362771113455a98a163207c96112551674ef2aa3cf342cbd2c6898dc9d0cef9466d31342b8410534bd998db9f2aa4909c0280a8118ce0a66739f41bc797a6fe0b212d422c65ff9455a72495b5bb081ca938d77a54f3545cf154b30c98ec9e76c2d6875c725d5ae263a612d9de7805c0dfccb1f188670bb9f39a0f2c692e1d1edb8ff6147deaf8ce756a2acab87438d666951bf2416c46f70cc794e9");
}

/// 0.3.9 起 sky 不再带 `immerseType`(对齐 agent 形态), 与 lossless 仅 level 值不同。
#[test]
fn eapi_params_matches_independent_vector_sky() {
    let payload = song_url_payload("42", "sky", 99);
    assert_eq!(eapi_params(SONG_URL_API, &payload), "fa90b329e9614f79e79598f37dc2edb487f00d1bc4c9b24cd57e6c318b9073567565d994ef3a89f5356c243f90d8099d485db260fa577059c3e1cfbfb3b6e9c157e2dbb5c19220c20ee55de2b6b8e0c0da6346d00362771113455a98a163207c96112551674ef2aa3cf342cbd2c6898dc9d0cef9466d31342b8410534bd998db9f2aa4909c0280a8118ce0a66739f41b5830b791208a4f12ea2872c174fac2b850d41794fdba57c36ee78ee82ab0503741b06992913ecb850787550925a650ddb02165b196d2fcdeb7fc1ebdcb5ba63d77bfe2fbbcfc5958fe7c3665b4f3839a");
    assert_ne!(eapi_params(SONG_URL_API, &payload), eapi_params(SONG_URL_API, &song_url_payload("42", "hires", 99)));
}

/// `strings.Replace(apiURL, "/eapi/", "/api/", 1)`: 只换第一处 `/eapi/`。
#[test]
fn eapi_params_replaces_only_the_first_eapi_segment() {
    let payload = song_url_payload("1", "standard", 1);
    assert_eq!(
        eapi_params("https://interface3.music.163.com/eapi/song/enhance/player/url/v1", &payload),
        eapi_params("https://interface3.music.163.com/api/song/enhance/player/url/v1", &payload)
    );
    // 第二处 /eapi/ 保持原样: 直接断言归一化后的 path。
    // 不能拿 `eapi_params("https://x/api/a/eapi/b")` 当参照 —— 这个参照串自己也含
    // `/eapi/`, 会被同一条规则改写成 `https://x/api/a/api/b`, 断言对正确实现不成立
    // (只有"全量替换"的错误实现才过得去)。
    // 0.3.9: eapi_path 只取 pathname(去 scheme+host), 且第二处 /eapi/ 保持原样。
    assert_eq!(
        eapi_path("https://x/eapi/a/eapi/b"),
        "/api/a/eapi/b",
        "第二处 /eapi/ 必须保持原样"
    );
}

/// 音质阶梯(Go `main.go:21` = sidecar `fetch-worker.mjs:104` / `server.mjs:308`)。
#[test]
fn level_ladder_follows_go_and_sidecar_order() {
    assert_eq!(LEVELS[0], "jymaster", "最高档");
    assert_eq!(LEVELS[7], "standard", "最低档");
    // 两张表各自逐字对源, 但它们**不互为反转**: 两份来源对 `dolby` 的位次不一致 ——
    // 升序表(`server.mjs:308`)里 dolby 紧跟 `jyeffect`, 降序表(`fetch-worker.mjs:104` /
    // Go `main.go:21`)里 dolby 紧跟 `lossless`。移植保持各自原样, 不要"修"成反转。
    assert_eq!(
        LEVELS.to_vec(),
        vec!["jymaster", "jyeffect", "sky", "hires", "lossless", "dolby", "exhigh", "standard"]
    );
    assert_eq!(
        LEVELS_ASCENDING.to_vec(),
        vec!["standard", "exhigh", "lossless", "hires", "sky", "jyeffect", "dolby", "jymaster"]
    );
    // 未命中(含空串)从最高档开始(Go `netease.go:113-119`)
    assert_eq!(level_ladder(""), &LEVELS[..]);
    assert_eq!(level_ladder("unknown"), &LEVELS[..]);
    assert_eq!(level_ladder("jymaster"), &LEVELS[..]);
    // 命中后只保留该档及其之下
    assert_eq!(
        level_ladder("lossless").to_vec(),
        vec!["lossless", "dolby", "exhigh", "standard"]
    );
    assert_eq!(level_ladder("standard").to_vec(), vec!["standard"]);
}

/// cookie 字符串解析 = Go `netease.go:219-224` 的 `SplitN("=", 2)` + `TrimSpace`。
#[test]
fn parse_cookie_string_matches_go_splitn() {
    let cookies = parse_cookie_string(
        "MUSIC_U=abc=def; __csrf_token=xyz; NMTID=; broken; =nokey; key=; a=b;c=d",
    );
    assert_eq!(cookies.get("MUSIC_U").map(String::as_str), Some("abc=def"), "值里的 = 保留");
    assert_eq!(cookies.get("__csrf_token").map(String::as_str), Some("xyz"));
    assert_eq!(cookies.get("NMTID").map(String::as_str), Some(""), "空值也算命中");
    assert_eq!(cookies.get("key").map(String::as_str), Some(""));
    assert_eq!(cookies.get("a").map(String::as_str), Some("b"));
    assert_eq!(cookies.get("c").map(String::as_str), Some("d"));
    assert!(!cookies.contains_key("broken"), "没有 = 的段忽略");
    assert!(!cookies.contains_key(""), "名字为空的段忽略");
    assert_eq!(cookies.len(), 6);

    // 去首尾空白(Go strings.TrimSpace), 键内部的空白原样保留
    let spaced = parse_cookie_string("  spaced = v  ");
    assert_eq!(spaced.get("spaced ").map(String::as_str), Some(" v"));

    // U+3000(全角空格)属 Unicode White_Space, Go strings.TrimSpace 同样裁掉
    let full_width = parse_cookie_string("\u{3000}MUSIC_U=x\u{3000}");
    assert_eq!(full_width.get("MUSIC_U").map(String::as_str), Some("x"));

    // 同名后者覆盖前者(Go map 语义; sidecar 的合并顺序同理)
    let duplicated = parse_cookie_string("k=1; k=2");
    assert_eq!(duplicated.get("k").map(String::as_str), Some("2"));

    assert!(parse_cookie_string("").is_empty());
    assert!(parse_cookie_string(";;;").is_empty());
}

/// cookie 头 = Go `netease.go:51-61` `neteaseCookieHeader`(只回显两个键)。
#[test]
fn cookie_header_matches_go() {
    assert_eq!(COOKIE_BASE, "os=pc; appver=; osver=; deviceId=pyncm!");
    assert_eq!(cookie_header(&BTreeMap::new()), COOKIE_BASE);
    assert_eq!(
        cookie_header(&jar(&[("MUSIC_U", "u1"), ("__csrf_token", "t2"), ("NMTID", "n3")])),
        "os=pc; appver=; osver=; deviceId=pyncm!; MUSIC_U=u1; __csrf_token=t2",
        "其余 cookie 不进请求头"
    );
    assert_eq!(
        cookie_header(&jar(&[("MUSIC_U", "")])),
        "os=pc; appver=; osver=; deviceId=pyncm!; MUSIC_U=",
        "键存在就回显(Go 的 map 命中判定, 不看值是否为空)"
    );
}

/// Go `url.QueryEscape` 的字符集(空格转 `+`, `~` 不转义, `*`/`+` 都转义)。
#[test]
fn query_escape_matches_go() {
    assert_eq!(query_escape(""), "");
    assert_eq!(query_escape("a b"), "a+b");
    assert_eq!(query_escape("~-_.*+"), "~-_.%2A%2B");
    assert_eq!(query_escape("a&b=c"), "a%26b%3Dc");
    assert_eq!(query_escape("晴天"), "%E6%99%B4%E5%A4%A9");
}

/// Go `url.Values.Encode()`: 按键排序 + `k=v` 转义连接。
#[test]
fn form_encode_sorts_keys_and_escapes() {
    assert_eq!(form_encode(&[]), "");
    assert_eq!(form_encode(&[("type", "3")]), "type=3");
    assert_eq!(
        form_encode(&[("s", "晴天 & 周杰伦"), ("type", "1"), ("limit", "30"), ("offset", "30")]),
        "limit=30&offset=30&s=%E6%99%B4%E5%A4%A9+%26+%E5%91%A8%E6%9D%B0%E4%BC%A6&type=1"
    );
    assert_eq!(
        form_encode(&[("key", "a b~c*d+e/f?g=h"), ("type", "3")]),
        "key=a+b~c%2Ad%2Be%2Ff%3Fg%3Dh&type=3"
    );
}

/// `SongUrl` 的 serde 形状 = 本插件契约(`url`/`ext`/`level`/`size`)。
#[test]
fn song_url_shape_matches_contract() {
    let song = SongUrl {
        url: "https://cdn.example/song.flac".to_string(),
        ext: "flac".to_string(),
        level: "lossless".to_string(),
        size: 4321,
    };
    let value = serde_json::to_value(&song).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "url": "https://cdn.example/song.flac",
            "ext": "flac",
            "level": "lossless",
            "size": 4321,
        })
    );
    let back: SongUrl = serde_json::from_value(value).unwrap();
    assert_eq!(back, song);
    assert_eq!(
        SongUrl::placeholder(),
        SongUrl { url: String::new(), ext: String::new(), level: String::new(), size: 0 }
    );
}

/// sidecar `server.mjs:79-89`: 两个头同值、小写名、国内前缀、后两段 1..=254。
#[test]
fn ip_headers_match_sidecar_ranges() {
    // sidecar `server.mjs:81` 的 CN_PREFIXES 原表(测试里独立重抄一份)
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
    let mut seen = BTreeSet::new();
    for _ in 0..5 {
        let headers = ip_headers();
        assert_eq!(headers.len(), 2);
        assert_eq!(headers.keys().cloned().collect::<Vec<String>>(), vec!["x-forwarded-for", "x-real-ip"]);
        let real = headers.get("x-real-ip").expect("必须有 x-real-ip").clone();
        assert_eq!(headers.get("x-forwarded-for"), Some(&real), "两个头同值");
        let octets: Vec<u32> = real.split('.').map(|part| part.parse().expect("十进制段")).collect();
        assert_eq!(octets.len(), 4, "IPv4 点分四段: {real}");
        assert!(CN_PREFIXES.contains(&[octets[0], octets[1]]), "前缀必须来自 sidecar 的表: {real}");
        assert!((1..=254).contains(&octets[2]), "第三段 1..=254: {real}");
        assert!((1..=254).contains(&octets[3]), "第四段 1..=254: {real}");
        seen.insert(real);
    }
    assert!(!seen.is_empty());
}

/// UA 常量必须与 Go/sidecar 的字面量逐字一致。
#[test]
fn user_agents_match_go_and_sidecar() {
    assert_eq!(
        CHROME_UA,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
    );
    assert_eq!(
        DESKTOP_UA,
        "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152"
    );
    assert_eq!(EAPI_KEY, b"e82ckenh8dichen8");
}

/// Go `netease.go:127` 的 `UnixNano() % 1e8`。
#[test]
fn request_id_keeps_last_eight_digits() {
    assert_eq!(request_id(0), 0);
    assert_eq!(request_id(99_999_999), 99_999_999);
    assert_eq!(request_id(100_000_001), 1);
    assert_eq!(request_id(1_790_676_009_123_456_789), 23_456_789);
}

/// 本机没有宿主替身: 存储读失败 → 空表 → `logged_in: false`(不 panic, 不回显凭据)。
#[test]
fn login_status_reports_logged_out_without_stored_cookies() {
    let value = login_status().unwrap();
    assert_eq!(value["logged_in"], false);
    assert_eq!(value["has_music_u"], false);
    assert!(value.get("MUSIC_U").is_none(), "响应里不允许出现 cookie 值");
}
