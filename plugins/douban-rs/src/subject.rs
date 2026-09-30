//! 功能 1「TMDB 匹配增强」的名下文件 —— **本文件只属于功能 1 一路**。
//!
//! # 两路文件边界(冻结)
//!
//! | 路 | 名下文件(只在这里填函数体) | 共享文件上的接口 |
//! |----|---------------------------|------------------|
//! | 功能 1(TMDB 匹配增强) | [`crate::subject`](本文件) + `subscribe.rs` 的**匹配函数内部** | [`Runtime::rexxar_subject_detail`] |
//! | 功能 2/3(过滤器 + 墓碑集) | `filter.rs`(新增) + `wish.rs` + `AppPage.vue` | [`crate::filter::Runtime::can_subscribe`] / [`crate::filter::Runtime::no_resub_guard`] 等 |
//!
//! `subscribe.rs` 是两路唯一的共享文件, 但共享面被压到两条线:
//! - 功能 1 只动**匹配函数的函数体**(`subscribe_queue_item` / `subscribe_from_snapshot`
//!   里"tmdb_search → match_tmdb → 阈值判定"那段), 不改签名、不加参数;
//! - 功能 2/3 只在**订阅入口**加一道前置守卫(调 `can_subscribe` / `no_resub_guard`),
//!   也不改签名。
//! 两路都不会碰到对方的行 —— 合并时不需要解冲突。前端 `AppPage.vue` 的改动
//! (设置抽屉三个输入 + 想看区墓碑数与按钮)属于功能 2/3 一路, 本阶段（契约冻结）不动。
//!
//! # 真实响应取证(先 curl 再冻结, 不许猜字段名)
//!
//! 取命令(移动 UA + m 站 referer, 与 [`crate::poster::Runtime::rexxar_poster`] 同族):
//!
//! ```text
//! curl -s -H 'user-agent: Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X)
//!   AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' \
//!   -H 'referer: https://m.douban.com/' -H 'accept: application/json, text/plain;q=0.9' \
//!   'https://m.douban.com/rexxar/api/v2/movie/36808876'
//! ```
//!
//! 样本已截字段脱敏存入 `tests/fixtures/subject_detail.json`(movie/36808876)与
//! `tests/fixtures/subject_detail_tv.json`(tv/34862797), 经
//! [`crate::fixtures::SUBJECT_DETAIL_MOVIE`]/[`crate::fixtures::SUBJECT_DETAIL_TV`] 引用。
//!
//! **字段路径(全部来自上面那份真实响应, 逐个复核过)**:
//!
//! | 语义 | 字段路径 | 类型 | 实测 |
//! |------|----------|------|------|
//! | 豆瓣条目 id | `id` | string(`"36808876"`) | 与请求路径一致 |
//! | 原名 | `original_title` | string | movie/36808876 = `"The Odyssey"`; movie/35653205 = `""`; tv/34862797 = `"Leonardo"` |
//! | 又名表 | `aka` | string[] | movie/36808876 = `[]`; tv/34862797 = `["莱昂纳多","李奥纳多","列奥纳多·达·芬奇"]` |
//! | 评分 | `rating.value` | number(`0..10`) | movie/36808876 = `8.6`; 无评分时 `rating` 整体为 `null` |
//! | 评分人数 | `rating.count` | number | 同时存在 `rating.max`/`rating.star_count` |
//! | 年份 | `year` | string(`"2026"`, 不是数字) | `release_date` 是 **null**(movie 与 tv 都是), 别拿它取年份 |
//! | 地区 | `countries` | string[] | movie/36808876 = `["美国","加拿大",…]`; tv/34862797 = `["意大利","美国",…]` |
//! | 类型 | `type` / `subtype` | string(`movie` / `tv`) | 与路径里的类型一致 |
//!
//! 对"地区"的结论: **rexxar 详情确有一等公民的地区字段 `countries`**(string[]), 因此
//! 功能 2 的地区过滤不需要降级假设 —— 唯一的降级是"详情没取到时无法判定"(见
//! [`crate::filter::Runtime::can_subscribe`] 的 deviation 说明)。
//! 另注: `card_subtitle` 里也拼了年份/地区/类型, 那是展示串(格式会变), 不要解析它。
//!
//! # 实现说明(rs-0.2.0, 与骨架契约的两处出入, 均已在调用侧注明)
//!
//! 1. **出站请求**: 走 [`crate::runtime::Runtime::http_get`](浏览器 UA +
//!    `referer: https://movie.douban.com/`, 与 `poster.rs` 的 `rexxar_poster` 同一条辅助,
//!    accept 同为 `application/json, text/plain;q=0.9`); 实测桌面 UA 取 rexxar 详情
//!    同样 200(移动 UA 的取证命令见上)。失败一律返回 `None`, 不区分错误原因;
//!    解析用 [`crate::model::decode`](`rating: null` → `None`)。
//! 2. **kind 与签名**: 回退入口现已带 `kind` 参数(`match_tmdb_with_detail_fallback`
//!    的第三个参数, 评审修复: 固定空串时剧集条目一律走 `movie` 路径, 而 rexxar 对
//!    `movie/<剧id>` 实测回 301 → 详情恒为 `None`, 剧集全部享受不到回退)。调用方
//!    传 `QueueItem.media_type`(wish/榜单入队时已按条目/榜单类型填上)或快照订阅时
//!    按榜单配置的 `kind`; 取不到时仍传空串 → 按 `movie` 取(与旧行为一致)。
//!    响应侧除校验 `id` 外还校验 `type` 与路径一致, 正确性不单靠豆瓣的 301 行为。
//! 3. 其余照契约: 候选顺序 `original_title` → `aka`(去空去重, 保序); 每个候选一次
//!    `tmdb_search` + 一次 [`crate::subscribe::match_tmdb`] + 阈值判定, 取置信度最高者;
//!    全部失败时调用方保持直配结果(`needs_review` + `TMDB 匹配置信不足 ({:.2})`)。

use crate::model::GoSlice;
use crate::runtime::Runtime;

/// rexxar 条目详情(功能 1/2 共用的字段子集)。
///
/// **只声明用得上的字段**: rexxar 的同一响应有 80+ 键(见 `tests/fixtures/subject_detail*.json`
/// 的截取说明), 全量建模只会把易变的展示字段(`card_subtitle`/`cover`/`trailers`…)
/// 引进解析路径。`#[serde(default)]` 保证缺字段/`null` 都退化成零值
/// (与 Go 的 `json.Unmarshal` 到结构体一致; 走 [`crate::model::decode`] 才有 null 语义)。
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct SubjectDetail {
    /// 豆瓣条目 id(`id` 是字符串, 实测 `"36808876"`)。
    pub id: String,
    /// 原名(`original_title`), 可能为空串。
    pub original_title: String,
    /// 又名表(`aka`), 可能是空数组。
    pub aka: GoSlice<String>,
    /// 评分(`rating.value`, `0..10`); 无评分时 rexxar 给 `rating: null` → 这里保持 `None`。
    pub rating: Option<Rating>,
    /// 年份(`year`, **字符串**: `"2026"`)。
    pub year: String,
    /// 国家/地区(`countries`, string[]); 无数据时为空表/缺失。
    pub countries: GoSlice<String>,
    /// `movie` | `tv`(`type`, 与 `subtype` 一致)。
    #[serde(rename = "type")]
    pub kind: String,
}

/// [`SubjectDetail::rating`] 的取值子集(实测键: `count`/`max`/`star_count`/`value`)。
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Rating {
    /// 评分人数(`rating.count`)。
    pub count: i64,
    /// 评分值(`rating.value`), `0..10`。
    pub value: f64,
}

impl SubjectDetail {
    /// 回退检索的候选标题: `original_title` 在前, 其后是目前已冻结的 `aka`。
    ///
    /// 纯函数(可直接单测): 去掉**空串和重复项**, 保留原顺序。
    ///
    /// (地区白名单的比对不在这里 —— 那是功能 2 的判定, 见
    /// [`crate::filter::regions_match`]; 本文件只负责把 `countries` 原样带出来。)
    pub fn fallback_titles(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        fn push(out: &mut Vec<String>, candidate: &str) {
            if !candidate.is_empty() && !out.iter().any(|existing| existing == candidate) {
                out.push(candidate.to_string());
            }
        }
        push(&mut out, &self.original_title);
        for aka in self.aka.iter().flatten() {
            push(&mut out, aka);
        }
        out
    }
}

/// 从豆瓣 ref 提取条目数字 id(契约认可的两种形态: `db:subj:36808876` / `36808876`)。
///
/// 取最后一个 `:` 之后的末段, 且必须非空、全为 ASCII 数字; 其余形态(URL 等)
/// 一律返回空串, 调用方按"取不到 id"降级(不发起 rexxar 请求)。
pub fn douban_subject_id(douban_ref: &str) -> String {
    let last = douban_ref.rsplit(':').next().unwrap_or("");
    if !last.is_empty() && last.bytes().all(|byte| byte.is_ascii_digit()) {
        last.to_string()
    } else {
        String::new()
    }
}

/// [`Runtime::rexxar_subject_detail`] 用的路径段转义 —— 与 [`crate::poster`] 的
/// `path_escape` 同一套规则(Go `net/url.PathEscape` 的 `encodePathSegment` 模式:
/// 放行 `A-Za-z0-9-_.~` 与 `$&+:;=?@`, 其余 `%XX`)。poster.rs 那份是私有函数,
/// 这里按契约"同等规则"复制; 条目 id 是纯数字, 实际是恒等映射。
fn rexxar_path_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'$'
            | b'&'
            | b'+'
            | b':'
            | b'='
            | b'@' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

impl Runtime {
    /// rexxar 条目详情(`m.douban.com/rexxar/api/v2/{movie|tv}/<id>`)。
    ///
    /// 返回 `None` 表示"没拿到"(HTTP 失败/解析失败/响应里 `id` 与请求不符/响应里
    /// `type` 与请求路径不符)—— 调用方(功能 1 的匹配回退 / 功能 2 的地区判定)都按
    /// "没有详情"降级, 不区分原因。
    ///
    /// `kind` 取 `"movie"` / `"tv"`(其它值按 `movie` 处理); `subject_id` 用
    /// [`crate::poster`] 的 `path_escape` 同等规则拼接。请求走
    /// [`crate::runtime::Runtime::http_get`] —— 与 `poster.rs` 的 `rexxar_poster`
    /// 同一条出站通道(浏览器 UA + `referer: https://movie.douban.com/`)。
    pub fn rexxar_subject_detail(&self, kind: &str, subject_id: &str) -> Option<SubjectDetail> {
        let kind = if kind == "tv" { "tv" } else { "movie" };
        let url = format!(
            "https://m.douban.com/rexxar/api/v2/{}/{}",
            kind,
            rexxar_path_escape(subject_id)
        );
        let got = self.http_get(&url, "application/json, text/plain;q=0.9");
        if got.error.is_some() {
            return None;
        }
        let detail = crate::model::decode::<SubjectDetail>(&got.body)?;
        // 响应里的 id 与请求不符(错配条目/重定向说明页)也按"没拿到"处理
        if detail.id != subject_id {
            return None;
        }
        // 响应里的 type 与请求路径不符同样按"没拿到"处理: 正确性不单靠"豆瓣对
        // movie/<剧id> 回 301"这一行为, 响应本身必须自证类型(`type` 缺失/为空时
        // 不判错 —— 旧响应可能没有该字段, 宁可放行给 id 校验兜底)。
        if !detail.kind.is_empty() && detail.kind != kind {
            return None;
        }
        Some(detail)
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cookiecloud::test_support::{Route, TestHost};

    fn detail_from_fixture(raw: &[u8]) -> SubjectDetail {
        crate::model::decode::<SubjectDetail>(raw).expect("夹具必须能解出 SubjectDetail")
    }

    /// 候选顺序照契约: original_title 在前, aka 按原顺序跟上; 空串/重复项去掉。
    #[test]
    fn fallback_titles_orders_dedups_and_drops_empty() {
        // tv 夹具: original_title 非空 + aka 三条(真实样本)
        let tv = detail_from_fixture(crate::fixtures::SUBJECT_DETAIL_TV);
        assert_eq!(
            tv.fallback_titles(),
            vec![
                "Leonardo".to_string(),
                "莱昂纳多".to_string(),
                "李奥纳多".to_string(),
                "列奥纳多·达·芬奇".to_string(),
            ]
        );

        // movie 夹具: original_title 非空, aka 空数组 → 只有原名
        let movie = detail_from_fixture(crate::fixtures::SUBJECT_DETAIL_MOVIE);
        assert_eq!(movie.fallback_titles(), vec!["The Odyssey".to_string()]);

        // 人工样本: 空串与重复项去掉, 顺序保持
        let mut custom = SubjectDetail::default();
        custom.original_title = "Same".to_string();
        custom.aka = Some(vec![
            "Same".to_string(),
            String::new(),
            "Other".to_string(),
            "Same".to_string(),
        ]);
        assert_eq!(
            custom.fallback_titles(),
            vec!["Same".to_string(), "Other".to_string()]
        );

        // 全空 → 没有可用候选
        assert!(SubjectDetail::default().fallback_titles().is_empty());
    }

    #[test]
    fn douban_subject_id_accepts_both_contract_shapes() {
        assert_eq!(douban_subject_id("36808876"), "36808876");
        assert_eq!(douban_subject_id("db:subj:36808876"), "36808876");
        assert_eq!(douban_subject_id("db:subj:"), "");
        assert_eq!(douban_subject_id(""), "");
        assert_eq!(douban_subject_id(":"), "");
        // URL 形态不在契约里(末段带 `/`, 不是纯数字) → 取不到
        assert_eq!(
            douban_subject_id("https://movie.douban.com/subject/36808876/"),
            ""
        );
    }

    /// 取数 + 解析 + 请求形态(与 poster.rs 的 rexxar_poster 同族)一次覆盖。
    #[test]
    fn rexxar_subject_detail_fetches_parses_and_validates_id() {
        let body = std::str::from_utf8(crate::fixtures::SUBJECT_DETAIL_TV).unwrap();
        let host = TestHost::install(vec![Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/tv/34862797",
            body,
        )]);
        let runtime = Runtime::new();

        let detail = runtime
            .rexxar_subject_detail("tv", "34862797")
            .expect("tv 形态应取到详情");
        assert_eq!(detail.id, "34862797");
        assert_eq!(detail.original_title, "Leonardo");
        assert_eq!(detail.year, "2021");
        assert_eq!(detail.rating.as_ref().unwrap().value, 7.8);
        assert_eq!(
            detail
                .countries
                .as_deref()
                .unwrap_or_default()
                .first()
                .map(String::as_str),
            Some("意大利")
        );

        // 请求形态: 完整 URL + 浏览器 UA + movie referer + 与 rexxar_poster 一致的 accept
        let request = host.requests().pop().unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.path,
            "https://m.douban.com/rexxar/api/v2/tv/34862797"
        );
        assert_eq!(
            request.headers.get("user-agent").map(String::as_str),
            Some(crate::runtime::BROWSER_USER_AGENT)
        );
        assert_eq!(
            request.headers.get("referer").map(String::as_str),
            Some("https://movie.douban.com/")
        );
        assert_eq!(
            request.headers.get("accept").map(String::as_str),
            Some("application/json, text/plain;q=0.9")
        );
        drop(host);

        // kind 空串/未知 → 按 movie 取
        let movie_body = std::str::from_utf8(crate::fixtures::SUBJECT_DETAIL_MOVIE).unwrap();
        let host = TestHost::install(vec![Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/movie/36808876",
            movie_body,
        )]);
        let runtime = Runtime::new();
        let detail = runtime
            .rexxar_subject_detail("", "36808876")
            .expect("kind 空串按 movie");
        assert_eq!(detail.original_title, "The Odyssey");
        assert!(
            detail.aka.as_ref().unwrap().is_empty(),
            "movie 夹具的 aka 是空数组"
        );
        assert_eq!(
            runtime
                .rexxar_subject_detail("综艺", "36808876")
                .expect("未知 kind 也按 movie")
                .id,
            "36808876"
        );
        drop(host);

        // 评分整体为 null → rating 保持 None(id 之外的字段全零值)
        let host = TestHost::install(vec![Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/movie/5",
            r#"{"id":"5","original_title":"X","aka":[],"rating":null}"#,
        )]);
        let runtime = Runtime::new();
        let detail = runtime.rexxar_subject_detail("movie", "5").unwrap();
        assert_eq!(detail.rating, None);
    }

    /// `None` 的四种来源: HTTP 404 / host.call 失败 / 不是 JSON / id 与请求不符。
    #[test]
    fn rexxar_subject_detail_degrades_to_none_on_any_failure() {
        // 404(未注册路由走 TestHost 默认)
        let host = TestHost::install(vec![]);
        let runtime = Runtime::new();
        assert_eq!(runtime.rexxar_subject_detail("movie", "1"), None);
        drop(host);

        // host.call 直接失败
        let host = TestHost::install(vec![Route::fail(
            "GET",
            "https://m.douban.com/rexxar/api/v2/movie/1",
        )]);
        let runtime = Runtime::new();
        assert_eq!(runtime.rexxar_subject_detail("movie", "1"), None);
        drop(host);

        // 响应不是 JSON
        let host = TestHost::install(vec![Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/movie/1",
            "not json",
        )]);
        let runtime = Runtime::new();
        assert_eq!(runtime.rexxar_subject_detail("movie", "1"), None);
        drop(host);

        // 响应 id 与请求不符
        let host = TestHost::install(vec![Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/movie/1",
            r#"{"id":"2","original_title":"别的条目"}"#,
        )]);
        let runtime = Runtime::new();
        assert_eq!(runtime.rexxar_subject_detail("movie", "1"), None);
        assert_eq!(
            runtime.rexxar_subject_detail("movie", "2"),
            None,
            "请求 id=1 永远取不到"
        );
    }

    /// 响应 `type` 与请求路径不符 → `None`(评审修复: 正确性不单靠豆瓣对
    /// `movie/<剧id>` 回 301 的行为); 响应缺 `type` 字段不判错(id 校验兜底)。
    #[test]
    fn rexxar_subject_detail_rejects_type_mismatch() {
        // 请求 movie 路径, 响应却是 tv 条目(错配/异常代理)
        let host = TestHost::install(vec![Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/movie/1",
            r#"{"id":"1","original_title":"X","aka":[],"type":"tv"}"#,
        )]);
        let runtime = Runtime::new();
        assert_eq!(runtime.rexxar_subject_detail("movie", "1"), None);
        drop(host);

        // 缺 type 字段(serde default 空串)→ 不判错
        let host = TestHost::install(vec![Route::json(
            "GET",
            "https://m.douban.com/rexxar/api/v2/movie/1",
            r#"{"id":"1","original_title":"X","aka":[]}"#,
        )]);
        let runtime = Runtime::new();
        assert!(runtime.rexxar_subject_detail("movie", "1").is_some());
    }
}
