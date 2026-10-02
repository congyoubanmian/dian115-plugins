//! 网易云歌单链路的**集成测试**(只走 crate 公开 API, 不联网)。
//!
//! 覆盖:
//! - [`qualities_for_level`] 各分支 —— 升序表逐档命中(前 `maxIdx+1` 档反转)与
//!   未命中(空串/陌生档位/大小写不符)返回空表;
//! - 固定 JSON 夹具下的歌曲映射([`playlist_song_from_value`]) —— `singers` 的
//!   `ar`/`artists` 回退与 `/` 连接、`album`/`cover` 的 `al`/`album` 回退、
//!   `duration_ms` 的 `dt`→`duration` 回退、`max_level` 的
//!   `maxBrLevel`→`downloadMaxBrLevel` 回退与 `qualities` 推导。
//!
//! # 向量来源(不是从本实现反推的)
//!
//! sidecar `sidecars/music-agent/app/server.mjs` 的源码逐行取值:
//! `server.mjs:308`(`NETEASE_LEVEL_ORDER` 升序表)与 `server.mjs:331-345`
//! (歌曲映射的 `||`/`??` 回退链)。宿主网络与 KV 依赖真实环境, 不在集成测试覆盖内。
//!
//! 另注意: 宿主会拒绝含以 `/` 开头字符串的整个响应, 本文件夹具同时钉住
//! `singers`/`cover` 等字段的形态 —— 正常歌单数据不含路径型字段。

use plugin::netease::{playlist_song_from_value, qualities_for_level, LEVELS_ASCENDING};

/// 升序表逐档命中: 第 `index` 档命中 → 前 `index+1` 档反转(高在前)。
#[test]
fn qualities_for_level_hit_each_rung() {
    assert_eq!(
        LEVELS_ASCENDING.to_vec(),
        vec!["standard", "exhigh", "lossless", "hires", "sky", "jyeffect", "dolby", "jymaster"],
        "升序表 = sidecar server.mjs:308 的 NETEASE_LEVEL_ORDER"
    );
    for (index, level) in LEVELS_ASCENDING.iter().enumerate() {
        let expected: Vec<&str> = LEVELS_ASCENDING[..=index].iter().rev().copied().collect();
        assert_eq!(qualities_for_level(level), expected, "level={level}");
    }
    // 逐字钉几个具体档位(含最低/最高档)。
    assert_eq!(qualities_for_level("standard"), vec!["standard"]);
    assert_eq!(qualities_for_level("hires"), vec!["hires", "lossless", "exhigh", "standard"]);
    assert_eq!(
        qualities_for_level("lossless"),
        vec!["lossless", "exhigh", "standard"]
    );
    assert_eq!(
        qualities_for_level("jymaster"),
        vec![
            "jymaster",
            "dolby",
            "jyeffect",
            "sky",
            "hires",
            "lossless",
            "exhigh",
            "standard"
        ],
        "最高档命中 → 升序表整体反转"
    );
}

/// 未命中(含空串、陌生档位、大小写不符)返回空表 —— JS `indexOf` 的语义。
#[test]
fn qualities_for_level_miss_returns_empty() {
    assert!(qualities_for_level("").is_empty(), "空串未命中 → 空");
    assert!(qualities_for_level("bogus").is_empty());
    assert!(qualities_for_level("STANDARD").is_empty(), "indexOf 区分大小写");
    assert!(qualities_for_level("hires ").is_empty(), "不去空白");
    assert!(qualities_for_level("none").is_empty());
}

/// 固定夹具: v3 `song/detail` 单首歌的完整形态, 逐字段钉映射结果。
#[test]
fn playlist_song_maps_full_fixture() {
    let song = serde_json::json!({
        "id": 186016,
        "name": "晴天",
        "ar": [
            {"id": 6452, "name": "周杰伦"},
            {"id": 9999, "name": "Kay Tse"},
        ],
        "al": {"id": 19061, "name": "叶惠美", "picUrl": "https://p1.music.126.net/cover/19061.jpg"},
        "dt": 269413,
        "privilege": {"id": 186016, "maxBrLevel": "lossless", "downloadMaxBrLevel": "hires"},
    });
    let mapped = playlist_song_from_value(&song);
    assert_eq!(
        mapped,
        serde_json::json!({
            "id": "186016",
            "name": "晴天",
            "singers": "周杰伦/Kay Tse",
            "album": "叶惠美",
            "cover": "https://p1.music.126.net/cover/19061.jpg",
            "duration_ms": 269413,
            "source": "netease",
            "max_level": "lossless",
            "qualities": ["lossless", "exhigh", "standard"],
        })
    );
}

/// `||` 回退链逐条对照 sidecar `server.mjs:331-345`:
/// `ar` 假值 → `artists`; `al` 假值 → `album`; `maxBrLevel` 空串 → `downloadMaxBrLevel`。
#[test]
fn playlist_song_falls_back_like_sidecar() {
    // ar/al 缺失 → artists/album; dt=0(JS 假值)→ duration; jymaster → 全阶梯。
    let song = serde_json::json!({
        "id": 42,
        "name": "回退",
        "artists": [{"name": "A"}, {"name": "B"}],
        "album": {"name": "B面", "picUrl": "https://p1.music.126.net/x/42.jpg"},
        "dt": 0,
        "duration": 1000,
        "privilege": {"maxBrLevel": "jymaster"},
    });
    let mapped = playlist_song_from_value(&song);
    assert_eq!(mapped["singers"], "A/B");
    assert_eq!(mapped["album"], "B面");
    assert_eq!(mapped["cover"], "https://p1.music.126.net/x/42.jpg");
    assert_eq!(mapped["duration_ms"], 1000, "dt=0 是 JS 假值, 回退 duration");
    assert_eq!(
        mapped["qualities"],
        serde_json::json!([
            "jymaster", "dolby", "jyeffect", "sky", "hires", "lossless", "exhigh", "standard"
        ])
    );

    // `ar`/`al` 显式 `null`(JS 假值)同样回退; maxBrLevel 空串回退 downloadMaxBrLevel。
    let song = serde_json::json!({
        "id": 43,
        "ar": null,
        "artists": [{"name": "C"}],
        "al": null,
        "album": {"name": "专辑43"},
        "privilege": {"maxBrLevel": "", "downloadMaxBrLevel": "hires"},
    });
    let mapped = playlist_song_from_value(&song);
    assert_eq!(mapped["singers"], "C");
    assert_eq!(mapped["album"], "专辑43");
    assert_eq!(mapped["cover"], "", "album.picUrl 缺失 → 空串");
    assert_eq!(mapped["duration_ms"], 0, "dt 与 duration 都缺失 → 0");
    assert_eq!(mapped["max_level"], "hires");
    assert_eq!(
        mapped["qualities"],
        serde_json::json!(["hires", "lossless", "exhigh", "standard"])
    );
}

/// 字段全缺的最小夹具: 全部落到零值/空表, `max_level` 未命中 → `qualities` 空。
#[test]
fn playlist_song_missing_fields_stays_quiet() {
    let mapped = playlist_song_from_value(&serde_json::json!({"id": 7}));
    assert_eq!(
        mapped,
        serde_json::json!({
            "id": "7",
            "name": "",
            "singers": "",
            "album": "",
            "cover": "",
            "duration_ms": 0,
            "source": "netease",
            "max_level": "",
            "qualities": [],
        })
    );
}

/// 宿主安全过滤会拒掉以 `/` 开头的字符串: 正常歌单数据的映射产物里不应出现这类值
/// (映射是逐字段透传, 不做路径改写 —— 与 sidecar 行为一致)。
#[test]
fn playlist_song_produces_no_path_like_strings() {
    let song = serde_json::json!({
        "id": 186016,
        "name": "歌名/带斜杠",
        "ar": [{"name": "歌手"}],
        "al": {"name": "专辑", "picUrl": "https://p1.music.126.net/cover/19061.jpg"},
        "dt": 1,
        "privilege": {"maxBrLevel": "standard"},
    });
    let mapped = playlist_song_from_value(&song);
    for (key, value) in mapped.as_object().expect("映射结果是对象") {
        if let Some(text) = value.as_str() {
            assert!(
                !(text.starts_with('/') && text.len() >= 2),
                "字段 {key} 以 / 开头, 宿主会拒整个响应: {text}"
            );
        }
    }
}
