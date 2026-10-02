//! QQ 音乐模块的离线单元测试: 只碰纯函数与解析器, 不发网络请求。
//!
//! 期望值来源(全部在本次改动里复算过, 未运行任何网络调用):
//! - `hash33`: 按 Go `qqHash33`(`plugins/music-dl/runtime/qq.go:23`)的 `int` 回绕语义
//!   复算, 覆盖空串/ASCII/中文 rune/超长回绕(Go 64 位回绕与 Rust i32 回绕的低 31 位一致);
//! - 参数签名: 按 Go `url.Values.Encode`(键字节序排序 + `QueryEscape`)与
//!   `fmt.Sprintf("%.17f", ...)` 复算, 覆盖 create/poll/搜索/取链/微信换票的请求体;
//! - 解析器: 以真实响应形态的固定样本断言(样本形态取自 Go 侧正则与
//!   `plugins/music-dl/runtime/qq.go` 的字段名)。
//!
//! 依赖宿主的部分(网络与 KV)在 `cargo test` 下走 `abi_stub`, 一律失败 ——
//! 用例只断言"失败/降级"的形状, 不假装跑通。

use std::collections::BTreeMap;

use plugin::qq::{
    collect_set_cookies, cookie_header, extract_wx_uuid, guid_from_nanos, hash33, login_kind_of,
    normalize_cookies, parse_js_args, parse_query, parse_search, parse_set_cookie_line,
    parse_vkey_response, parse_wx_code, parse_wx_errcode, qq_status_of, qr_login_params,
    qr_show_params, qr_show_t, quality_ladder, quality_start, query_encode, query_escape,
    search_params, set_cookie_lines,
    song_url_request_body, uin_from_cookies, wx_check_params, wx_login_params, wx_login_payload,
    wx_status_of, LoginKind, COOKIE_KEY, NO_LINK_ERROR, QUALITY_LADDER, QQ_COOKIE_NAMES,
    QR_UNAVAILABLE,
};
use serde_json::Value;

// ─────────────────────────── qqHash33 ───────────────────────────

/// Go `qqHash33` 的已知向量: 手算 + 复算, 含长输入的 64 位回绕。
#[test]
fn hash33_matches_go_known_vectors() {
    assert_eq!(hash33(""), 0);
    assert_eq!(hash33("a"), 97);
    assert_eq!(hash33("abc"), 108966);
    assert_eq!(hash33("~"), 126);
    // Go `range` 按 rune: '测'=U+6D4B(27979), '试'=U+8BD5(35797)
    assert_eq!(hash33("测试"), 0 + 27979 * 33 + 35797);
    assert_eq!(hash33("测试"), 959104);
    // 真实 qrsig 形态(32 位十六进制)
    assert_eq!(hash33("0123456789abcdef0123456789abcdef"), 935578372);
    assert_eq!(hash33("qrsig_value_1234567890abc"), 1174617108);
    assert_eq!(hash33("@abcd#1234"), 1201473783);
    // poll 请求里 ptqrtoken 用的那组
    assert_eq!(hash33("AbCdEf123456"), 1510816170);
    // 100 个 'a': Go int64 早已回绕, 低 31 位必须仍然一致
    assert_eq!(hash33(&"a".repeat(100)), 76785828);
}

// ─────────────────────────── 编码器 ───────────────────────────

#[test]
fn query_escape_matches_go() {
    assert_eq!(query_escape(""), "");
    assert_eq!(query_escape("a b"), "a+b");
    assert_eq!(query_escape("周杰伦"), "%E5%91%A8%E6%9D%B0%E4%BC%A6");
    // Go 只放行 alnum 与 -_.~, 其余(含 !*'())按字节大写十六进制
    assert_eq!(query_escape("~-_.!*'()"), "~-_.%21%2A%27%28%29");
}

#[test]
fn query_encode_sorts_keys_bytewise() {
    assert_eq!(query_encode(&[("b", "2"), ("a", "1"), ("_", "0")]), "_=0&a=1&b=2");
    assert_eq!(query_encode(&[("k", "")]), "k=");
    assert_eq!(query_encode(&[]), "");
}

// ─────────────────────────── 请求参数签名 ───────────────────────────

#[test]
fn qr_show_t_matches_go_percent_17f() {
    assert_eq!(qr_show_t(123_456_789), "0.00000000012345679");
    assert_eq!(qr_show_t(1_759_291_234_567_890_123), "1.75929123456789016");
}

/// `qqCreateQR` 的 query: Go `url.Values.Encode` 排序后的确定形态。
#[test]
fn qr_show_params_exact() {
    let params = qr_show_params(1_759_291_234_567_890_123);
    assert_eq!(
        params,
        "appid=716027609&d=72&daid=383&e=2&l=M&pt_3rd_aid=100497308&s=3&t=1.75929123456789016&v=4"
    );
}

/// `qqPollQR` 的 query: `ptqrtoken = qqHash33(qrsig)`, `action = 0-0-<ms>`。
#[test]
fn qr_login_params_exact() {
    let params = qr_login_params("AbCdEf123456", 1_759_291_234_567);
    assert_eq!(
        params,
        "action=0-0-1759291234567&aid=716027609&daid=383&from_ui=1&g=1&h=1&has_onekey=1&js_type=1&js_ver=21072115&login_sig=&nodirect=0&pt_3rd_aid=100497308&pt_uistyle=40&ptlang=2052&ptqrtoken=1510816170&ptredirect=100&pttype=1&service=ptqrlogin&t=1&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump"
    );
    // ptqrtoken 就是 hash33 的十进制文本
    assert!(params.contains(&format!("ptqrtoken={}", hash33("AbCdEf123456"))));
}

/// `qqCreateWXQR` / `qqPollWXQR` 的 query。
#[test]
fn wx_params_exact() {
    assert_eq!(
        wx_login_params("musicdl-1759291234567890123"),
        "appid=wx48db31d50e334801&href=https%3A%2F%2Fy.qq.com%2Fmediastyle%2Fmusic_v17%2Fsrc%2Fcss%2Fpopup_wechat.css%23wechat_redirect&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fwx_redirect.html%3Flogin_type%3D2%26surl%3Dhttps%3A%2F%2Fy.qq.com%2F&response_type=code&scope=snsapi_login&state=musicdl-1759291234567890123"
    );
    assert_eq!(wx_check_params("AbC-123_x", 1_759_291_234_567), "_=1759291234567&uuid=AbC-123_x");
}

/// `qqSearch` 的 query(每页 20 条; 中文按 UTF-8 百分号编码, 空格变 `+`)。
#[test]
fn search_params_exact() {
    assert_eq!(
        search_params("周杰伦 稻香", 2),
        "format=json&n=20&p=2&w=%E5%91%A8%E6%9D%B0%E4%BC%A6+%E7%A8%BB%E9%A6%99"
    );
    assert_eq!(search_params("", 1), "format=json&n=20&p=1&w=");
}

/// `qqSongURL` 的 guid 与 POST body(Go `json.Marshal` 的键排序形态)。
#[test]
fn song_url_request_body_exact() {
    assert_eq!(guid_from_nanos(1_759_291_234_567_890_123), "4567890123");
    let body = song_url_request_body("001Qu4I30eVFYb", "1234567890", "4567890123", &QUALITY_LADDER);
    assert_eq!(
        String::from_utf8(body).unwrap(),
        "{\"comm\":{\"ct\":20,\"cv\":0,\"format\":\"json\",\"uin\":\"1234567890\"},\"req_1\":{\"method\":\"UrlGetVkey\",\"module\":\"music.vkey.GetVkey\",\"param\":{\"filename\":[\"AI00001Qu4I30eVFYb001Qu4I30eVFYb.flac\",\"Q001001Qu4I30eVFYb001Qu4I30eVFYb.flac\",\"Q000001Qu4I30eVFYb001Qu4I30eVFYb.flac\",\"F000001Qu4I30eVFYb001Qu4I30eVFYb.flac\",\"O801001Qu4I30eVFYb001Qu4I30eVFYb.ogg\",\"M800001Qu4I30eVFYb001Qu4I30eVFYb.mp3\",\"M500001Qu4I30eVFYb001Qu4I30eVFYb.mp3\"],\"guid\":\"4567890123\",\"loginflag\":1,\"platform\":\"20\",\"songmid\":[\"001Qu4I30eVFYb\"],\"songtype\":[0],\"uin\":\"1234567890\"}}}"
    );
}

/// `qqPollWXQR` 换票的 POST body。
#[test]
fn wx_login_payload_exact() {
    let payload = wx_login_payload("CODE-1");
    assert_eq!(
        String::from_utf8(payload).unwrap(),
        "{\"comm\":{\"ct\":24,\"cv\":0,\"g_tk\":5381,\"platform\":\"yqq\",\"tmeAppID\":\"qqmusic\",\"tmeLoginType\":\"1\"},\"req\":{\"method\":\"Login\",\"module\":\"music.login.LoginServer\",\"param\":{\"code\":\"CODE-1\",\"strAppid\":\"wx48db31d50e334801\"}}}"
    );
}

/// 音质阶梯: sidecar `fetch-worker.mjs:106` 的 7 档(母带 → 128k), 前缀决定扩展名。
#[test]
fn quality_ladder_matches_sidecar() {
    assert_eq!(
        QUALITY_LADDER,
        [
            ("AI00", "flac"),
            ("Q001", "flac"),
            ("Q000", "flac"),
            ("F000", "flac"),
            ("O801", "ogg"),
            ("M800", "mp3"),
            ("M500", "mp3"),
        ]
    );
}

/// 档位裁剪: sidecar `fetch-worker.mjs:109` 的 `{master:0, flac:3, 320:5, 128:6}`。
#[test]
fn quality_ladder_slices_by_level() {
    assert_eq!(quality_start("master"), Some(0));
    assert_eq!(quality_start("flac"), Some(3));
    assert_eq!(quality_start("320"), Some(5));
    assert_eq!(quality_start("128"), Some(6));
    assert_eq!(quality_start("bogus"), None);
    assert_eq!(quality_ladder("master"), &QUALITY_LADDER[..]);
    assert_eq!(quality_ladder("bogus"), &QUALITY_LADDER[..]);
    assert_eq!(quality_ladder(""), &QUALITY_LADDER[..]);
    assert_eq!(quality_ladder("flac"), &QUALITY_LADDER[3..]);
    assert_eq!(quality_ladder("320"), &QUALITY_LADDER[5..]);
    assert_eq!(quality_ladder("128"), &QUALITY_LADDER[6..]);
    assert_eq!(quality_ladder("128"), &[("M500", "mp3")]);
}

// ─────────────────────────── 响应解析器 ───────────────────────────

#[test]
fn parse_js_args_reads_ptuicb_arguments() {
    let body = "ptuiCB('0','0','https://graph.qq.com/oauth2.0/check_sig?uin=123&sig=abc','0','登录成功', '昵称')";
    assert_eq!(
        parse_js_args(body),
        vec![
            "0",
            "0",
            "https://graph.qq.com/oauth2.0/check_sig?uin=123&sig=abc",
            "0",
            "登录成功",
            "昵称",
        ]
    );
    // 空串也是合法参数
    assert_eq!(parse_js_args("ptuiCB('66','0','','0','','')"), vec!["66", "0", "", "0", "", ""]);
    // 没有配对的收尾引号: 最后一段不产生参数
    assert_eq!(parse_js_args("ptuiCB('0','0'"), vec!["0", "0"]);
    assert_eq!(parse_js_args("ptuiCB('0','0"), vec!["0"]);
    assert_eq!(parse_js_args("no quotes here"), Vec::<String>::new());
}

#[test]
fn status_maps_match_go() {
    assert_eq!(qq_status_of("0"), "success");
    assert_eq!(qq_status_of("65"), "expired");
    assert_eq!(qq_status_of("66"), "waiting");
    assert_eq!(qq_status_of("67"), "scanned");
    assert_eq!(qq_status_of("1"), "failed");
    assert_eq!(qq_status_of(""), "failed");

    assert_eq!(wx_status_of("405"), "success");
    assert_eq!(wx_status_of("408"), "waiting");
    assert_eq!(wx_status_of("404"), "expired");
    assert_eq!(wx_status_of("402"), "expired");
    assert_eq!(wx_status_of(""), "failed");
}

#[test]
fn parse_wx_errcode_handles_quotes_and_rescans() {
    assert_eq!(parse_wx_errcode("window.wx_errcode=405;window.wx_code='CODE-1';"), Some("405".to_string()));
    assert_eq!(parse_wx_errcode("wx_errcode = '408';"), Some("408".to_string()));
    // 第一处 `wx_errcode` 后不是 `=`: 正则继续向后找
    assert_eq!(parse_wx_errcode("wx_errcodeXX; wx_errcode=402;"), Some("402".to_string()));
    assert_eq!(parse_wx_errcode("hello"), None);
    assert_eq!(parse_wx_errcode("wx_errcode=abc"), None);
    assert_eq!(parse_wx_errcode("wx_errcode=''"), None);
}

#[test]
fn parse_wx_code_handles_both_quote_styles() {
    assert_eq!(parse_wx_code("wx_code='CODE-1';"), Some("CODE-1".to_string()));
    assert_eq!(parse_wx_code("wx_code = \"AB\";"), Some("AB".to_string()));
    // `([^"']*)` 允许空串
    assert_eq!(parse_wx_code("wx_code='';"), Some(String::new()));
    assert_eq!(parse_wx_code("wx_code = CODE"), None);
    assert_eq!(parse_wx_code("nope"), None);
    // 第一处不可匹配时继续向后找
    assert_eq!(parse_wx_code("wx_code=1; wx_code='Z'"), Some("Z".to_string()));
}

#[test]
fn extract_wx_uuid_tries_go_patterns_in_order() {
    let by_redirect = "<script>location.href='https://open.weixin.qq.com/connect/l/qrconnect?uuid=AbC-123_xyz&last=1'</script>";
    assert_eq!(extract_wx_uuid(by_redirect), Some("AbC-123_xyz".to_string()));

    let by_js = "<script>window.QRLogin.uuid = \"wxUuid_987-XY\";</script>";
    assert_eq!(extract_wx_uuid(by_js), Some("wxUuid_987-XY".to_string()));

    let by_img = "<img src=\"https://open.weixin.qq.com/connect/qrcode/0123456789abcdef\">";
    assert_eq!(extract_wx_uuid(by_img), Some("0123456789abcdef".to_string()));

    // 第一条正则优先
    let both = "<a href='/connect/qrcode/ZZZ'>connect/l/qrconnect?uuid=AAA</a>";
    assert_eq!(extract_wx_uuid(both), Some("AAA".to_string()));

    // 首次出现处取不到字符时继续向后
    let empty_then_real = "connect/l/qrconnect?uuid=&x=1 connect/l/qrconnect?uuid=BB";
    assert_eq!(extract_wx_uuid(empty_then_real), Some("BB".to_string()));

    assert_eq!(extract_wx_uuid("<html>no qr here</html>"), None);
}

#[test]
fn parse_query_matches_go_get_semantics() {
    assert_eq!(parse_query(""), BTreeMap::new());
    assert_eq!(
        parse_query("qrsig=AbCdEf123456"),
        BTreeMap::from([("qrsig".to_string(), "AbCdEf123456".to_string())])
    );
    assert_eq!(parse_query("flag"), BTreeMap::from([("flag".to_string(), String::new())]));
    // 同名键取第一个(`Values.Get`)
    assert_eq!(parse_query("dup=1&dup=2").get("dup"), Some(&"1".to_string()));
    // `+` 与 `%XX` 都要还原
    assert_eq!(parse_query("a=%E5%91%A8&b=x+y").get("a"), Some(&"周".to_string()));
    assert_eq!(parse_query("a=%E5%91%A8&b=x+y").get("b"), Some(&"x y".to_string()));
    // 非法转义: 该段跳过, 其余段继续解析(Go ParseQuery 记错后 `continue`)
    let after_bad = parse_query("ok=1&bad=%ZZ&after=2");
    assert_eq!(after_bad.len(), 2);
    assert_eq!(after_bad.get("ok"), Some(&"1".to_string()));
    assert_eq!(after_bad.get("after"), Some(&"2".to_string()));
    // 含 `;` 的段整体跳过(Go 的 invalid semicolon separator 分支)
    assert_eq!(parse_query("a=1;n=2&b=3").get("b"), Some(&"3".to_string()));
    assert_eq!(parse_query("a=1;n=2").get("a"), None);
}

#[test]
fn login_kind_dispatch_is_key_based() {
    assert_eq!(login_kind_of("qrsig=abc"), LoginKind::Qq);
    assert_eq!(login_kind_of("state=s&type=wx&uuid=u"), LoginKind::Wx);
    assert_eq!(login_kind_of("type=qq&uuid=u"), LoginKind::Qq);
    assert_eq!(login_kind_of(""), LoginKind::Qq);
}

#[test]
fn parse_vkey_response_picks_first_http_purl_with_ladder_index() {
    let body = br#"{"req_1":{"data":{"midurlinfo":[
        {"purl":"","vkey":"v0"},
        {"purl":"http://dl.stream.qqmusic.qq.com/Q001x.flac?vkey=1","vkey":"v1"},
        {"purl":"http://dl.stream.qqmusic.qq.com/M800x.mp3?vkey=2","vkey":"v2"}
    ]}}}"#;
    assert_eq!(
        parse_vkey_response(body, &QUALITY_LADDER),
        Ok((
            "http://dl.stream.qqmusic.qq.com/Q001x.flac?vkey=1".to_string(),
            "flac".to_string(),
            "Q001".to_string(),
        ))
    );

    // 全部为空 → Go 原文报错(含绿钻提示)
    let none = br#"{"req_1":{"data":{"midurlinfo":[{"purl":"","vkey":""}]}}}"#;
    assert_eq!(parse_vkey_response(none, &QUALITY_LADDER), Err(NO_LINK_ERROR.to_string()));

    // `null` 按 Go 的零值处理(不报解析错误), 只是取不到链接
    let null_purl = br#"{"req_1":{"data":{"midurlinfo":[{"purl":null,"vkey":null}]}}}"#;
    assert_eq!(parse_vkey_response(null_purl, &QUALITY_LADDER), Err(NO_LINK_ERROR.to_string()));

    // 结构缺失同样是零值
    assert_eq!(parse_vkey_response(b"{}", &QUALITY_LADDER), Err(NO_LINK_ERROR.to_string()));

    // 非法 JSON → Go 的 "QQ 取链解析失败"
    assert_eq!(
        parse_vkey_response(b"not json", &QUALITY_LADDER),
        Err("QQ 取链解析失败".to_string())
    );

    // 索引按传入的阶梯(裁剪后)取扩展名/前缀
    let sliced = br#"{"req_1":{"data":{"midurlinfo":[{"purl":"http://x/M800.mp3"},{"purl":""}]}}}"#;
    assert_eq!(
        parse_vkey_response(sliced, quality_ladder("320")),
        Ok(("http://x/M800.mp3".to_string(), "mp3".to_string(), "M800".to_string()))
    );
}

#[test]
fn parse_search_maps_go_struct_fields() {
    let body = r#"{"data":{"song":{"list":[
        {"songid":1,"songmid":"mid1","songname":"歌1","albumname":"专辑","interval":241,
         "sizeflac":1024,"size320":512,"size128":128,"singer":[{"name":"A"},{"name":"B"}]},
        {"songid":2,"songmid":"mid2","songname":"歌2","albumname":"","interval":0,
         "sizeflac":0,"size320":512,"size128":128,"singer":[]},
        {"songid":3,"songmid":"mid3","songname":"歌3","albumname":"","interval":0,
         "sizeflac":0,"size320":0,"size128":128,"singer":[{"name":"C"}]}
    ]}}}"#.as_bytes();
    let parsed = parse_search(body, 2).unwrap();
    assert_eq!(parsed["page"], 2);
    let songs = parsed["songs"].as_array().unwrap();
    assert_eq!(songs.len(), 3);
    assert_eq!(songs[0]["id"], "mid1");
    assert_eq!(songs[0]["name"], "歌1");
    assert_eq!(songs[0]["singers"], "A/B");
    assert_eq!(songs[0]["album"], "专辑");
    assert_eq!(songs[0]["duration_s"], 241);
    assert_eq!(songs[0]["source"], "qq");
    assert_eq!(songs[0]["quality"], "flac");
    assert_eq!(songs[1]["quality"], "320");
    assert_eq!(songs[1]["singers"], "");
    assert_eq!(songs[2]["quality"], "128");
    assert_eq!(songs[2]["singers"], "C");

    // 字段缺失/null 都是零值(Go 结构体语义)
    let sparse = br#"{"data":{"song":{"list":[{"songmid":null,"sizeflac":null,"singer":null}]}}}"#;
    let parsed = parse_search(sparse, 1).unwrap();
    assert_eq!(parsed["songs"][0]["id"], "");
    assert_eq!(parsed["songs"][0]["quality"], "128");
    assert_eq!(parsed["songs"][0]["singers"], "");
    assert_eq!(parse_search(b"{}", 1).unwrap()["songs"].as_array().unwrap().len(), 0);

    // 解析失败带上 Go 的前缀
    let err = parse_search(b"not json", 1).unwrap_err();
    assert!(err.starts_with("搜索解析失败: "), "实际: {err}");
    // 类型不符也要报错(Go: cannot unmarshal string into int64)
    let mismatch = br#"{"data":{"song":{"list":[{"sizeflac":"x"}]}}}"#;
    let err = parse_search(mismatch, 1).unwrap_err();
    assert!(err.starts_with("搜索解析失败: "), "实际: {err}");
}

// ─────────────────────────── cookie 处理 ───────────────────────────

#[test]
fn uin_extraction_matches_go_trim_prefix_chain() {
    assert_eq!(uin_from_cookies(&BTreeMap::new()), "0", "键不存在 → \"0\"");
    assert_eq!(
        uin_from_cookies(&BTreeMap::from([("uin".to_string(), "o0123456".to_string())])),
        "123456"
    );
    assert_eq!(
        uin_from_cookies(&BTreeMap::from([("uin".to_string(), "123".to_string())])),
        "123"
    );
    // 只去一层前缀, 与 strings.TrimPrefix 相同
    assert_eq!(uin_from_cookies(&BTreeMap::from([("uin".to_string(), "00".to_string())])), "0");
    assert_eq!(uin_from_cookies(&BTreeMap::from([("uin".to_string(), "o0o1".to_string())])), "o1");
    // 键存在但为空: Go 返回 ""(不是 "0")
    assert_eq!(uin_from_cookies(&BTreeMap::from([("uin".to_string(), String::new())])), "");
    assert_eq!(uin_from_cookies(&BTreeMap::from([("uin".to_string(), "o".to_string())])), "");
}

#[test]
fn cookie_header_joins_sorted_pairs() {
    let jar = BTreeMap::from([
        ("uin".to_string(), "1".to_string()),
        ("qqmusic_key".to_string(), "k".to_string()),
        ("skey".to_string(), "s".to_string()),
    ]);
    assert_eq!(cookie_header(&jar), "qqmusic_key=k; skey=s; uin=1");
    assert_eq!(cookie_header(&BTreeMap::new()), "");
}

#[test]
fn set_cookie_filtering_matches_qq_get_whitelist() {
    let mut jar = BTreeMap::new();
    parse_set_cookie_line(
        "qrsig=abc123; Path=/; HttpOnly",
        Some(QQ_COOKIE_NAMES.as_slice()),
        &mut jar,
    );
    assert_eq!(jar.get("qrsig"), Some(&"abc123".to_string()));

    // 白名单外的名字被丢弃
    let mut filtered = BTreeMap::new();
    parse_set_cookie_line("foo=bar; Path=/", Some(QQ_COOKIE_NAMES.as_slice()), &mut filtered);
    parse_set_cookie_line("__Host-x=1", Some(QQ_COOKIE_NAMES.as_slice()), &mut filtered);
    assert!(filtered.is_empty());

    // Expires 里的 ", " 会被 Go 的 Split(", ") 切开, 但不影响第一个键值
    let mut expires = BTreeMap::new();
    parse_set_cookie_line(
        "uin=o123; expires=Thu, 01 Jan 2026 00:00:00 GMT; path=/",
        Some(QQ_COOKIE_NAMES.as_slice()),
        &mut expires,
    );
    assert_eq!(expires.get("uin"), Some(&"o123".to_string()));

    // 重定向链/微信登录: 无过滤, 一个头行里的多段都收
    let mut open = BTreeMap::new();
    parse_set_cookie_line("skey=S1; Path=/, p_skey=P1; Domain=qq.com", None, &mut open);
    assert_eq!(open.get("skey"), Some(&"S1".to_string()));
    assert_eq!(open.get("p_skey"), Some(&"P1".to_string()));
}

#[test]
fn set_cookie_headers_are_case_insensitive() {
    let mut headers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    headers.insert(
        "Set-Cookie".to_string(),
        vec!["qrsig=abc; Path=/".to_string(), "uin=o1; Path=/".to_string()],
    );
    headers.insert("set-cookie".to_string(), vec!["skey=S; Path=/".to_string()]);
    let lines = set_cookie_lines(&headers);
    assert_eq!(lines.len(), 3);
    let filtered = collect_set_cookies(&headers, Some(QQ_COOKIE_NAMES.as_slice()));
    assert_eq!(filtered.get("qrsig"), Some(&"abc".to_string()));
    assert_eq!(filtered.get("uin"), Some(&"o1".to_string()));
    assert_eq!(filtered.get("skey"), Some(&"S".to_string()));
}

#[test]
fn normalize_cookies_fills_uin_and_music_key() {
    // QQ 链路: uin ← ptui_loginuin/luin/wxuin, qqmusic_key ← p_skey/skey/musickey
    let mut qq = BTreeMap::from([
        ("ptui_loginuin".to_string(), "o123".to_string()),
        ("p_skey".to_string(), "PS".to_string()),
    ]);
    normalize_cookies(&mut qq, LoginKind::Qq);
    assert_eq!(qq.get("uin"), Some(&"o123".to_string()), "照抄不做 trim");
    assert_eq!(qq.get("qqmusic_key"), Some(&"PS".to_string()));

    // 微信链路只认 wxuin
    let mut wx = BTreeMap::from([("wxuin".to_string(), "77".to_string())]);
    normalize_cookies(&mut wx, LoginKind::Wx);
    assert_eq!(wx.get("uin"), Some(&"77".to_string()));
    let mut wx_other = BTreeMap::from([("ptui_loginuin".to_string(), "x".to_string())]);
    normalize_cookies(&mut wx_other, LoginKind::Wx);
    assert_eq!(wx_other.get("uin"), None);

    // 已有值不覆盖
    let mut keep = BTreeMap::from([
        ("uin".to_string(), "keep".to_string()),
        ("qqmusic_key".to_string(), "keepk".to_string()),
        ("p_skey".to_string(), "PS".to_string()),
        ("wxuin".to_string(), "9".to_string()),
    ]);
    normalize_cookies(&mut keep, LoginKind::Qq);
    assert_eq!(keep.get("uin"), Some(&"keep".to_string()));
    assert_eq!(keep.get("qqmusic_key"), Some(&"keepk".to_string()));

    // 空串视为缺失, 顺序 p_skey → skey → musickey
    let mut fallback = BTreeMap::from([
        ("uin".to_string(), String::new()),
        ("luin".to_string(), "L".to_string()),
        ("skey".to_string(), "S".to_string()),
        ("musickey".to_string(), "M".to_string()),
    ]);
    normalize_cookies(&mut fallback, LoginKind::Qq);
    assert_eq!(fallback.get("uin"), Some(&"L".to_string()));
    assert_eq!(fallback.get("qqmusic_key"), Some(&"S".to_string()));
}

// ─────────────────────────── 无宿主时的降级形态 ───────────────────────────

/// `cargo test` 下宿主调用必然失败(`abi_stub` 返回 0): 入口要么在本地参数校验处
/// 报错, 要么把宿主错误如实带出来 —— 不允许 panic, 也不允许假装成功。
#[test]
fn entry_points_degrade_without_host() {
    assert_eq!(plugin::qq::qr_poll("nope").unwrap_err(), QR_UNAVAILABLE);
    assert_eq!(plugin::qq::qr_poll("type=wx").unwrap_err(), QR_UNAVAILABLE);
    assert_eq!(plugin::qq::qr_poll("qrsig=abc").unwrap_err(), QR_UNAVAILABLE);

    let status = plugin::qq::login_status().unwrap();
    assert_eq!(status["logged_in"], Value::Bool(false));
    assert_eq!(status["source"], "qq");
    assert_eq!(status["uin"], "0");

    assert!(plugin::qq::search("x", 1).is_err());
    assert!(plugin::qq::song_url("mid", "").is_err());
    assert!(plugin::qq::qr_create().is_err());
    assert!(plugin::qq::qr_create_wx().is_err());
    assert_eq!(COOKIE_KEY, "cookies.qq");
}
