//! 榜单抓取 + 刷新编排(Go `main.go:513` 起的正则与抓取段 + `main.go:1145` `refreshNow` +
//! `main.go:1264` `filterAndEnqueue` + `main.go:1292` `checkItem`)。
//!
//! # 路 1(榜单与海报)的名下文件
//!
//! 本文件与 [`crate::poster`] 属于同一路: **并行阶段只填这两个文件里的函数体**。
//! 冻结文件(任何一路都不得修改): `lib.rs`、`runtime.rs`、`protocol.rs`、`host.rs`、
//! `store.rs`、`model.rs`、`raw.rs`、`util.rs`、`clock.rs`、`Cargo.toml`。
//! 另外两路的名下文件: 路 2 = `cookiecloud.rs` + `wish.rs`, 路 3 = `subscribe.rs`。
//!
//! # 已冻结的调用点(本路内部)
//!
//! - [`Runtime::fetch_list`](`main.go:552`) → 按 `cfg.source` 分派到
//!   [`Runtime::fetch_subjects_json`](`main.go:589`)/[`Runtime::fetch_coming`](`main.go:629`)/
//!   [`Runtime::fetch_chart`](`main.go:711`); 未知来源报 `未知榜单来源 "x"`
//! - [`Runtime::fetch_chart`] 在 `deep_refresh` 时对前 [`POSTER_LOOKUP_LIMIT`] 条调用
//!   [`crate::poster::Runtime::movie_poster`](`main.go:749`)
//! - [`Runtime::refresh_now`] 尾部依次调用
//!   [`crate::wish::Runtime::sync_wish_list`](`main.go:1257`)与
//!   [`crate::subscribe::Runtime::process_due`](`main.go:1240`)(后者只在 `deep_refresh` 时)
//! - [`Runtime::filter_and_enqueue`] → [`Runtime::check_item`](`main.go:1292`)
//!
//! 跨路调用点在别的路合并进主线之前是 `todo!()`(运行会 panic): 本路自测请只测
//! 不跨路的入口(抓取解析、黑名单过滤), 端到端刷新留到三路合并后。
//!
//! # 与 Go 的实现差异(照抄时对照)
//!
//! - **计时**: Go 用 `time.Since(started)`; `wasm32-unknown-unknown` 上
//!   `std::time::Instant::now()` 会 panic, 一律用 [`crate::clock::now_unix_nanos`]
//!   取前后差值(单位纳秒)。预算常量见 [`ACTION_BUDGET_MS`]/[`JOB_BUDGET_MS`]。
//! - **锁与克隆**: Go 的 `cloneSettings` 只是"解锁后再用"的手段; 这里没有锁,
//!   直接 `self.settings.clone()`。但 `state` 响应里的空→`null` 语义在
//!   `runtime.rs::state_doc` 里已有专门处理, 不要在这里重造。
//! - **Go 的 19 条 `regexp.MustCompile` 全部 1:1 移植**: 有调用点的 9 条在主区块
//!   (下方 `re_want` … `re_space`), 另外 9 条(`reLi`/`reSubj`/`reRate`/`reTitle`/
//!   `reListCont`/`reShowingSoon`/`reRow`/`reRowSubj`/`reImg`)在 Go 里定义后从未被
//!   调用, 逐条放在子模块 [`go_unused_regex`] 里(附捕获组对拍用例, LTO 会把它们
//!   整段丢掉)。`extractPoster`(`main.go:675`, 只有 `reImg` 这一处被它用)是三行
//!   胶水且没有调用方, 不移植。
//! - **HTML 段落定位**: Go 的 `sectionAfter`(`main.go:692`)是在大页面上做字节查找,
//!   别用惰性正则整页匹配(wazero 下太贵), 语义按 [`section_after`] 的函数文档实现。
//! - **JSON 解码**: 用 [`crate::model::decode`] 而不是裸 `serde_json::from_slice`,
//!   它才带 Go 的"`null` → 零值, 类型不符 → 报错"语义。
//! - [`Runtime::filter_and_enqueue`] 取 `&Snapshot`: 调用方把快照放局部变量,
//!   先 filter 再 `self.snapshot = snapshot`(Go 在 filter 之前写 `r.snapshot`, 但
//!   filter 不读 `r.snapshot`, 顺序调换无副作用) —— 否则同时借 `self.snapshot` 与 `&mut self`。
//!
//! # 本阶段(路 1)落地清单
//!
//! - 正则: Go 的 `\d` / `\s` 是 **ASCII** 类, Rust regex 默认是 Unicode 类
//!   (会吃下阿拉伯-印度数字、全角空格等), 因此逐条写成 `[0-9]` / `[\t\n\f\r ]`
//!   的等价形式; `(?s)` 内联标志 Rust 同样支持。`\s` 在 Go 里不含 `\v`(0x0B),
//!   显式类里也没有。没有调用点的 9 条在子模块 [`go_unused_regex`] 里同样逐条对齐
//!   (Go 的 19 条 `MustCompile` 一条不落)。
//! - `url.QueryEscape` / `url.PathEscape` 手写在 [`query_escape`](`main.go:590`)与
//!   [`crate::poster`] 里(依赖表里没有 `url` crate), 行为按 Go 的
//!   `shouldEscape` 逐条对齐。
//! - 抓取循环抽成 `fetch_enabled_lists`(私有方法, 不跨模块), 便于单测预算行为;
//!   Go 的 `refreshNow` 里"按成本排序 + 超预算跳过剩余榜单"一段逐句照搬。
//! - 已知且刻意的差异见文件末尾 `mod tests` 前的注释(最近 `recent` 顺序、
//!   平手榜单键序、`hotness` 在 wasm32 上的 int 宽度)。
//!
//! # 与 Go 的差异清单(本文件相关)
//!
//! 1. **正则的 ASCII 类**: Go 的 `\d`/`\s` 只匹配 ASCII, Rust regex 默认的
//!    `\d`/`\s` 是 Unicode 类。这里把两处都写成显式 ASCII 类(`[0-9]`、
//!    `[\t\n\f\r ]`, 后者正是 Go `\s` 的定义, 不含 `\v`), 行为与 Go 一致;
//!    `.`/`[^x]`/惰性量词/`(?s)` 两边同义。
//! 2. **`hotness` 的整数宽度**: Go 在 wasip1 上 `int` 是 32 位, `parseWant` 的
//!    `strconv.Atoi` 对超过 `MaxInt32` 的"想看"数会失败并回落到 0; 这里
//!    [`ChartItem::hotness`] 是 i64(冻结模型), 保留真实数值。真实页面量级远小于
//!    2^31, 实际不会触发。
//! 3. **`BlackState::recent` 的顺序**: Go 遍历 `map[string]string` 是随机序,
//!    这里按标题字典序; 截断到 20 条的语义相同, 只是同一批命中里的先后不同。
//! 4. **同成本榜单的抓取顺序**: Go 先收集随机序再 `SliceStable`, 平手时顺序随机;
//!    这里 BTreeMap 天然字典序, 平手确定(如 `cn_wom`/`global_wom`/`hot` 同为
//!    `subjects_json` 时按该序抓)。取舍是"决定论"优先, 不影响成本排序本身。
//! 5. **JSON 解析失败的错误文案**: Go 直接回显 `encoding/json` 的原文
//!    (`invalid character ...`); 这里给 `响应解析失败: <serde 文案>` 或
//!    `响应解析失败: 类型不符`。行为(报错而不是静默空结果)一致, 文案不同。
//! 6. **HTML 的字节→字符串**: Go 用 `string(body)` 原样保留非法 UTF-8 字节;
//!    这里走 [`crate::util::go_lossy`](逐字节 U+FFFD), 合法 UTF-8 时完全一致。
//! 7. **`未知榜单来源 %q`**: 实现了引号/反斜杠/C0 控制字符的转义, 未实现 Go 对
//!    不可打印 Unicode 的 `\uXXXX` 写法(只影响诊断文案)。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use crate::clock;
use crate::model::{BlackHit, ChartItem, ListConfig, QueueItem, Settings, Snapshot};
use crate::protocol::OpError;
use crate::runtime::{list_upcoming, Runtime};
use crate::util;

/// 每次刷新最多为多少条口碑榜条目补海报(Go `main.go:32` `posterLookupLimit`)。
pub const POSTER_LOOKUP_LIMIT: usize = 8;
/// 前台动作预算(Go `main.go:34` `actionBudget`): 宿主约 10 秒强杀 worker, 提前收尾。
pub const ACTION_BUDGET_MS: u64 = 6_500;
/// 后台任务预算(Go `main.go:35` `jobBudget`)。
pub const JOB_BUDGET_MS: u64 = 8 * 60 * 1_000;

/// `j/search_subjects` 的响应(Go `main.go:597` 的匿名结构)。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SubjectsJson {
    pub subjects: Vec<SubjectEntry>,
}

/// `j/search_subjects` 的单条(Go `main.go:598` 的匿名结构)。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SubjectEntry {
    pub id: String,
    pub title: String,
    pub rate: String,
    pub cover: String,
    pub url: String,
}

// ---------------------------------------------------------------------------
// 正则(Go `main.go:513` 起的 `re*`)
//
// `posterHostRe`(Go `main.go:1838`, getPoster 的函数内正则)在
// [`crate::poster`] 里定义, 因为只有那里用得上。
// ---------------------------------------------------------------------------

/// 惰性编译一个全局正则(Go 的 `regexp.MustCompile` + 包级变量)。
macro_rules! static_regex {
    ($name:ident, $pattern:expr) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            CELL.get_or_init(|| Regex::new($pattern).expect("榜单正则编译失败"))
        }
    };
}

/// Go `main.go:516` `reWant`: `([\d,]+)\s*人?\s*想看`。
static_regex!(re_want, r"([0-9,]+)[\t\n\f\r ]*人?[\t\n\f\r ]*想看");
/// Go `main.go:520` `reLiClear`: `(?s)<li class="clearfix">(.*?)</li>`。
static_regex!(re_li_clear, r#"(?s)<li class="clearfix">(.*?)</li>"#);
/// Go `main.go:521` `reNo`: `class="no">\s*(\d+)`。
static_regex!(re_no, r#"class="no">[\t\n\f\r ]*([0-9]+)"#);
/// Go `main.go:523` `reName`: `<a[^>]*href="https://movie\.douban\.com/subject/(\d+)/"[^>]*>\s*([^<]+)`。
static_regex!(
    re_name,
    r#"<a[^>]*href="https://movie\.douban\.com/subject/([0-9]+)/"[^>]*>[\t\n\f\r ]*([^<]+)"#
);
/// Go `main.go:525` `reItemMod`: `(?s)<div class="item mod[^"]*">.*?</div>\s*</div>`。
static_regex!(
    re_item_mod,
    r#"(?s)<div class="item mod[^"]*">.*?</div>[\t\n\f\r ]*</div>"#
);
/// Go `main.go:526` `reItemSubj`: `<h3>\s*<a[^>]*href="https://movie\.douban\.com/subject/(\d+)/"[^>]*>\s*([^<]+)`。
static_regex!(
    re_item_subj,
    r#"<h3>[\t\n\f\r ]*<a[^>]*href="https://movie\.douban\.com/subject/([0-9]+)/"[^>]*>[\t\n\f\r ]*([^<]+)"#
);
/// Go `main.go:527` `reItemImg`: `<img[^>]+src="([^"]+)"`。
static_regex!(re_item_img, r#"<img[^>]+src="([^"]+)""#);
/// Go `main.go:639`/`721` 的局部 `space`: `\s+`(标题里的连续空白压成一个空格)。
static_regex!(re_space, r"[\t\n\f\r ]+");

/// Go 里定义后从未被调用的 9 条正则(`main.go:514`/`515`/`517`/`518`/`519`/`524`/
/// `626`/`627`/`673`): 与 Go 的 19 条 `regexp.MustCompile` 一一对齐, 但没有调用点,
/// 单独放在子模块里, 见 [`go_unused_regex`] 的模块文档。
mod go_unused_regex;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/// Go `main.go:530` `parseWant`: 从"1,234 人想看"里取数字, 没有就是 `0`。
///
/// 逐句对齐: `FindStringSubmatch` 无匹配 → 0; 命中则去掉千分位逗号后 `strconv.Atoi`,
/// 转换失败(理论上只在 32 位 `int` 溢出时发生)同样得 0。
pub fn parse_want(text: &str) -> i64 {
    let Some(captures) = re_want().captures(text) else {
        return 0;
    };
    let digits = captures.get(1).map(|m| m.as_str()).unwrap_or("");
    digits.replace(',', "").parse::<i64>().unwrap_or(0)
}

/// Go `main.go:540` `sourceCost`: 抓取成本排序用(`subjects_json` 1 < `chart_html` 2
/// < `coming_html` 3 < 其他 4), 便宜的 JSON 榜单先抓。
pub fn source_cost(source: &str) -> i32 {
    match source {
        "subjects_json" => 1,
        "chart_html" => 2,
        "coming_html" => 3,
        _ => 4,
    }
}

/// Go `main.go:692` `sectionAfter`: 用字节查找截出目标段落, 取代大页面上的惰性正则。
///
/// 语义逐条对齐:
/// - 找不到 `anchor` → 原样返回整份 `html`;
/// - 否则从锚点起到结尾, `open_tag` 非空且能找到就再往后截到它, `close_tag` 非空
///   且能找到就截到它之前;
/// - 返回的是 `html` 的切片(不复制)。
pub fn section_after<'a>(html: &'a str, anchor: &str, open_tag: &str, close_tag: &str) -> &'a str {
    let Some(anchor_at) = html.find(anchor) else {
        return html;
    };
    let mut segment = &html[anchor_at..];
    if !open_tag.is_empty() {
        if let Some(open_at) = segment.find(open_tag) {
            segment = &segment[open_at..];
        }
    }
    if !close_tag.is_empty() {
        if let Some(close_at) = segment.find(close_tag) {
            segment = &segment[..close_at];
        }
    }
    segment
}

/// Go `net/url.QueryEscape`(`main.go:590` 拼 `j/search_subjects` 的查询串)。
///
/// Go 的 `shouldEscape(c, encodeQueryComponent)`: 只放行 `A-Za-z0-9-_.~`,
/// 空格变成 `+`, 其余字节一律 `%XX`(逐字节, 不按字符)。
pub(crate) fn query_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Go `fmt.Sprintf("%q", s)` 的最小等价物(错误文案 `未知榜单来源 "x"`)。
///
/// 只处理引号、反斜杠与 C0 控制字符; Go 对不可打印 Unicode 会写 `\uXXXX`,
/// 这里保留原字符 —— 只影响那句诊断文案的细枝末节。
fn go_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// `strings.TrimSpace(space.ReplaceAllString(title, " "))`(Go `main.go:651`/`736`)。
fn collapse_space(text: &str) -> String {
    re_space().replace_all(text, " ").into_owned()
}

/// Go `json.Unmarshal(body, &x)` 的落地: 类型不符/语法错误 → `None`。
///
/// 走 [`crate::model::decode`](先直解, 失败再剥 `null` 重解), 因此
/// `"subjects": null` 与 Go 一样落到零值而不是报错。
fn decode_json<T: DeserializeOwned>(body: &[u8]) -> Result<T, OpError> {
    match crate::model::decode::<T>(body) {
        Some(value) => Ok(value),
        None => {
            let detail = serde_json::from_slice::<serde_json::Value>(body)
                .err()
                .map(|err| err.to_string())
                .unwrap_or_else(|| "类型不符".to_string());
            Err(OpError::new(format!("响应解析失败: {detail}")))
        }
    }
}

/// 已启用的榜单键, 按 `source_cost` 稳定排序(Go `main.go:1177` 的收集 + `sort.SliceStable`)。
///
/// Go 遍历 `map` 是随机序、`SliceStable` 只保证同成本内部保持那个随机序;
/// 这里 BTreeMap 天然按键序, 于是平手时顺序确定(见模块差异清单)。
fn ordered_enabled_keys(settings: &Settings) -> Vec<String> {
    let mut keys: Vec<(String, i32)> = match &settings.lists {
        Some(lists) => lists
            .iter()
            .filter(|(_, config)| config.enabled)
            .map(|(key, config)| (key.clone(), source_cost(&config.source)))
            .collect(),
        None => Vec::new(),
    };
    // `sort_by_key` 是稳定排序, 与 Go 的 `SliceStable` 一致。
    keys.sort_by_key(|(_, cost)| *cost);
    keys.into_iter().map(|(key, _)| key).collect()
}

/// 从 `started` 到现在的毫秒数(Go `time.Since(started)`)。
fn elapsed_ms(started_nanos: u64) -> u64 {
    clock::now_unix_nanos().saturating_sub(started_nanos) / 1_000_000
}

/// 一次榜单抓取的结果(Go `main.go:1170` 的 `listResult`)。
struct ListResult {
    key: String,
    items: Result<Vec<ChartItem>, OpError>,
}

impl Runtime {
    /// Go `main.go:1188` 的预算选择: 前台动作 ~6.5s, 后台任务 8 分钟。
    fn refresh_budget_ms(&self) -> u64 {
        if self.deep_refresh {
            JOB_BUDGET_MS
        } else {
            ACTION_BUDGET_MS
        }
    }

    /// Go `main.go:552` `fetchList`: 按 `cfg.source` 分派, 未知来源报
    /// `未知榜单来源 "<source>"`(注意 Go 的 `%q` 会带引号)。
    pub fn fetch_list(&self, key: &str, cfg: &ListConfig) -> Result<Vec<ChartItem>, OpError> {
        // Go 收了 key 但只用于日志(在 refreshNow 里), 这里同样不使用。
        let _ = key;
        match cfg.source.as_str() {
            "subjects_json" => self.fetch_subjects_json(cfg),
            "coming_html" => self.fetch_coming(cfg.limit),
            "chart_html" => self.fetch_chart(cfg.limit),
            other => Err(OpError::new(format!("未知榜单来源 {}", go_quote(other)))),
        }
    }

    /// Go `main.go:589` `fetchSubjectsJSON`: `j/search_subjects` + `SubjectsJson`。
    /// 标题 trim 后为空跳过; `douban_ref` 拼 `db:subj:<id>`。
    pub fn fetch_subjects_json(&self, cfg: &ListConfig) -> Result<Vec<ChartItem>, OpError> {
        let url = format!(
            "https://movie.douban.com/j/search_subjects?type={}&tag={}&sort={}&page_limit={}&page_start=0",
            query_escape(&cfg.kind),
            query_escape(&cfg.tag),
            query_escape(&cfg.sort),
            cfg.limit
        );
        let (body, _status) = self
            .http_get(&url, "application/json, text/plain;q=0.9")
            .into_result()?;
        let parsed: SubjectsJson = decode_json(&body)?;
        let mut items = Vec::with_capacity(parsed.subjects.len());
        for subject in parsed.subjects {
            let title = subject.title.trim().to_string();
            if title.is_empty() {
                continue;
            }
            items.push(ChartItem {
                douban_ref: format!("db:subj:{}", subject.id),
                title,
                rate: subject.rate,
                poster_url: subject.cover,
                url: subject.url,
                ..ChartItem::default()
            });
        }
        Ok(items)
    }

    /// Go `main.go:629` `fetchComing`: `/cinema/later/` 页面(豆瓣已把 `/later/` 301 到它,
    /// 直接请求新地址以免依赖宿主是否跟随重定向)。`#showing-soon` 里每个
    /// `<div class="item mod...">` 一条, 标题里的连续空白压成一个空格, 取 `hotness`。
    pub fn fetch_coming(&self, limit: i64) -> Result<Vec<ChartItem>, OpError> {
        let (body, _status) = self
            .http_get(
                "https://movie.douban.com/cinema/later/",
                "text/html,application/xhtml+xml;q=0.9",
            )
            .into_result()?;
        // Go: `string(body)` —— 合法 UTF-8 时两者等价; 非法序列按 crate 惯例
        // 逐字节替换成 U+FFFD(`util::go_lossy`), 与 Go 侧 JSON 输出后的观感一致。
        let html = util::go_lossy(&body);

        // 即将上映在 #showing-soon 内, 每个 <div class="item mod..."> 一条: 海报 + 片名 + 日期/类型/想看
        let mut items: Vec<ChartItem> = Vec::new(); // Go: `items := []ChartItem{}`(空数组而非 null)
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let segment = section_after(&html, "id=\"showing-soon\"", "", "");
        for block in re_item_mod().find_iter(segment).map(|m| m.as_str()) {
            let Some(captures) = re_item_subj().captures(block) else {
                continue;
            };
            let Some(id) = captures.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            let title = collapse_space(captures.get(2).map(|m| m.as_str()).unwrap_or(""))
                .trim()
                .to_string();
            if title.is_empty() {
                continue;
            }
            let mut poster = String::new();
            if let Some(image) = re_item_img().captures(block) {
                let src = image.get(1).map(|m| m.as_str()).unwrap_or("");
                if src.starts_with("http") {
                    poster = src.to_string();
                }
            }
            items.push(ChartItem {
                douban_ref: format!("db:subj:{id}"),
                title,
                hotness: parse_want(block),
                poster_url: poster,
                url: format!("https://movie.douban.com/subject/{id}/"),
                ..ChartItem::default()
            });
            if items.len() as i64 >= limit {
                break;
            }
        }
        Ok(items)
    }

    /// Go `main.go:711` `fetchChart`: `/chart` 页面的 `#listCont2` 一周口碑榜。
    /// 页面不含海报: 仅当 `self.deep_refresh` 且已收条目数 < [`POSTER_LOOKUP_LIMIT`]
    /// 时逐条调 [`crate::poster::Runtime::movie_poster`] 补, 其余交给前端按需取图。
    pub fn fetch_chart(&self, limit: i64) -> Result<Vec<ChartItem>, OpError> {
        let (body, _status) = self
            .http_get(
                "https://movie.douban.com/chart",
                "text/html,application/xhtml+xml;q=0.9",
            )
            .into_result()?;
        let html = util::go_lossy(&body);

        // 一周口碑榜位于 <ul id="listCont2">, 每行 <li class="clearfix">: 排名 + 片名链接 + 排名变化。
        // 该页写法是 <ul class="content" id="listCont2">, `<ul` 在锚点之前, 只能从锚点往后截到 </ul>。
        let mut items: Vec<ChartItem> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let segment = section_after(&html, "id=\"listCont2\"", "", "</ul>");
        for row in re_li_clear().find_iter(segment).map(|m| m.as_str()) {
            let Some(captures) = re_name().captures(row) else {
                continue;
            };
            let Some(id) = captures.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            let title = collapse_space(captures.get(2).map(|m| m.as_str()).unwrap_or(""))
                .trim()
                .to_string();
            if title.is_empty() {
                continue;
            }
            let mut rank = String::new();
            if let Some(rank_match) = re_no().captures(row) {
                rank = rank_match
                    .get(1)
                    .map(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            // 口碑榜 HTML 不带海报, 只能按标题逐条问豆瓣; 前台动作只有 ~10 秒预算,
            // 逐条补海报要多次外部请求, 因此只放在后台任务里做, 且只补前若干条。
            let mut poster = String::new();
            if self.deep_refresh && items.len() < POSTER_LOOKUP_LIMIT {
                poster = self.movie_poster(&title, &id);
            }
            items.push(ChartItem {
                douban_ref: format!("db:subj:{id}"),
                title,
                rank,
                rate: String::new(),
                hotness: parse_want(row),
                poster_url: poster,
                url: format!("https://movie.douban.com/subject/{id}/"),
                year: String::new(),
            });
            if items.len() as i64 >= limit {
                break;
            }
        }
        Ok(items)
    }

    /// Go `main.go:1177` 起的抓取循环: 按成本排序串行抓取 + 超预算跳过剩余榜单。
    ///
    /// 从 [`Runtime::refresh_now`] 里抽出来只为单测预算行为, 语义逐句照搬
    /// (含两条日志文案与 `used > budget` 的比较方向)。
    fn fetch_enabled_lists(&mut self, settings: &Settings, budget_ms: u64) -> Vec<ListResult> {
        let keys = ordered_enabled_keys(settings);
        let started = clock::now_unix_nanos(); // Go: `started := time.Now()`
        let mut results: Vec<ListResult> = Vec::new();
        for key in keys {
            let config = settings
                .lists
                .as_ref()
                .and_then(|lists| lists.get(&key))
                .cloned()
                .unwrap_or_default();
            let used = elapsed_ms(started);
            if used > budget_ms {
                self.log(
                    "warning",
                    &format!(
                        "本次已用 {} 秒, 跳过剩余榜单(下轮自动刷新会补齐)",
                        used / 1_000
                    ),
                );
                break;
            }
            self.log(
                "info",
                &format!("开始抓取榜单 {} source={}", key, config.source),
            );
            let outcome = self.fetch_list(&key, &config);
            match &outcome {
                Err(err) => self.log("warning", &format!("榜单 {key} 抓取失败: {err}")),
                Ok(items) => self.log("info", &format!("榜单 {} 抓到 {} 条", key, items.len())),
            }
            results.push(ListResult {
                key,
                items: outcome,
            });
        }
        results
    }

    /// Go `main.go:1145` `refreshNow`: 一次完整刷新。
    ///
    /// 顺序与 Go 一致(每步都有 diag 面包屑):
    /// 1. `refreshing` 防重入, 重入时报 `榜单刷新正在进行中`;
    /// 2. `trace("refresh:start")`, 按 `source_cost` 稳定排序启用榜单, 逐榜抓取并
    ///    记录日志(`开始抓取榜单 <key> source=<src>` / `榜单 <key> 抓到 N 条` /
    ///    失败 warning), 超预算时 `本次已用 N 秒, 跳过剩余榜单(下轮自动刷新会补齐)`;
    /// 3. `trace("lists:done")`, 组装 [`Snapshot`](失败榜单不进快照, 摘要里列 `失败榜：`),
    ///    写 `self.snapshot` 与 `self.last_run`;
    /// 4. [`Runtime::filter_and_enqueue`];
    /// 5. 仅当 `deep_refresh` 时 [`crate::subscribe::Runtime::process_due`](前台 ~10s
    ///    预算塞不下单次 5s+ 的聚合订阅), 摘要按 `deep_refresh` 追加
    ///    `；订阅由后台任务处理`;
    /// 6. [`crate::wish::Runtime::sync_wish_list`](第二参数传 `self.deep_refresh`);
    /// 7. `bump("succeeded", 摘要)` + `persist_all()`。
    ///
    /// 预算是 `self.deep_refresh ? [`JOB_BUDGET_MS`] : [`ACTION_BUDGET_MS`]`。
    pub fn refresh_now(&mut self, invocation_id: &str) -> Result<(), OpError> {
        if self.refreshing {
            return Err(OpError::new("榜单刷新正在进行中"));
        }
        self.refreshing = true;

        // Go `cloneSettings`: 没有锁, 快照式克隆一次, 后续步骤都用这份。
        let settings = self.settings.clone();
        // 面包屑: 宿主若在某次 host.call 期间直接终止 worker(无 panic 输出),
        // 也能从 plugin_kv.diag 看出最后成功的一步。
        self.trace("refresh:start");
        let deep = self.deep_refresh;

        // 1. 串行抓取各榜单(wasm 单线程, 不做并发)
        let budget = self.refresh_budget_ms();
        let results = self.fetch_enabled_lists(&settings, budget);
        self.trace("lists:done");

        let mut snapshot = Snapshot {
            fetched_at: clock::now_rfc3339(),
            lists: Some(BTreeMap::new()), // Go: `Lists: map[string][]ChartItem{}`
        };
        let mut failures: Vec<String> = Vec::new();
        for result in results {
            match result.items {
                Ok(items) => {
                    if let Some(lists) = snapshot.lists.as_mut() {
                        lists.insert(result.key, Some(items));
                    }
                }
                Err(err) => {
                    failures.push(format!("{}: {}", result.key, err));
                    self.log("warning", &format!("榜单 {} 抓取失败: {}", result.key, err));
                }
            }
        }

        // Go 在这里就写 r.snapshot; filterAndEnqueue 不读 r.snapshot, 先 filter 再赋值,
        // 免得同时借 `self.snapshot` 与 `&mut self`(见模块头差异清单)。
        self.filter_and_enqueue(&snapshot, &settings);
        self.last_run = snapshot.fetched_at.clone();
        self.snapshot = snapshot;

        // 3. 处理到期观察条目 -> 订阅。单次聚合订阅宿主侧要 5s+, 前台 ~10s 预算塞不下,
        //    只在后台任务做(Go `main.go:1239`)。
        let (mut subscribed, mut needs_review) = (0i64, 0i64);
        let mut err_msg = String::new();
        if deep {
            let (subscribed_count, review_count, message) =
                self.process_due(invocation_id, &settings);
            subscribed = subscribed_count;
            needs_review = review_count;
            err_msg = message;
        }

        let list_count = self.snapshot.lists.as_ref().map_or(0, |lists| lists.len());
        let mut summary = format!(
            "榜单刷新完成：{list_count} 榜，新增订阅 {subscribed}，待人工确认 {needs_review}"
        );
        if !deep {
            summary.push_str("；订阅由后台任务处理");
        }
        if !failures.is_empty() {
            summary.push_str("；失败榜：");
            summary.push_str(&failures.join("；"));
        }
        if !err_msg.is_empty() {
            summary.push('；');
            summary.push_str(&err_msg);
        }
        self.log("info", &summary);

        // 4. 同步「我的想看」(仅配置了 CookieCloud/手动 cookie 且开启时)。
        //    同样受前台预算约束: 前台只入队, 订阅在后台(第二参数 = deep_refresh)。
        self.sync_wish_list(invocation_id, deep);

        self.bump("succeeded", &summary);
        self.persist_all();
        self.refreshing = false; // Go 用 defer 保证复位
        Ok(())
    }

    /// Go `main.go:1264` `filterAndEnqueue`: 黑名单命中统计 + 榜单条目入观察队列。
    ///
    /// 注意 Go 的遍历顺序(会影响 [`crate::model::BlackState::recent`] 的顺序):
    /// 先 `upcoming`, 再其余榜单键。命中时把 `title -> keyword` 记账,
    /// 最后 `hits += 命中条数`、逐条前插 `recent` 并截到 20 条。
    pub fn filter_and_enqueue(&mut self, snapshot: &Snapshot, settings: &Settings) {
        let blacklist: &[String] = settings.blacklist.as_deref().unwrap_or(&[]);
        let mut hits: BTreeMap<String, String> = BTreeMap::new(); // title -> keyword
        let lists = snapshot.lists.as_ref();
        if let Some(items) = lists
            .and_then(|lists| lists.get(list_upcoming()))
            .and_then(|items| items.as_ref())
        {
            for item in items {
                self.check_item(item, list_upcoming(), blacklist, &mut hits);
            }
        }
        if let Some(lists) = lists {
            for (key, items) in lists {
                if key.as_str() == list_upcoming() {
                    continue;
                }
                if let Some(items) = items {
                    for item in items {
                        self.check_item(item, key, blacklist, &mut hits);
                    }
                }
            }
        }
        if !hits.is_empty() {
            self.black_state.hits += hits.len() as i64;
            let now = clock::now_rfc3339();
            let recent = self.black_state.recent.get_or_insert_with(Vec::new);
            for (title, keyword) in &hits {
                // Go: `Recent = append([]BlackHit{...}, Recent...)` —— 前插
                recent.insert(
                    0,
                    BlackHit {
                        title: title.clone(),
                        keyword: keyword.clone(),
                        at: now.clone(),
                    },
                );
                if recent.len() > 20 {
                    recent.truncate(20);
                }
            }
        }
    }

    /// Go `main.go:1292` `checkItem`: 单条的黑名单判定与入队。
    ///
    /// 跳过条件(顺序与 Go 一致): 命中黑名单关键词(记进 `hits` 并 return) →
    /// 历史上已成功订阅过同 ref → 已在观察队列里。通过后按
    /// `observe_period_hours`(<=0 时按 24)算 `due_at`, 以 `observing` 入队。
    pub fn check_item(
        &mut self,
        item: &ChartItem,
        list: &str,
        blacklist: &[String],
        hits: &mut BTreeMap<String, String>,
    ) {
        // 黑名单
        for keyword in blacklist {
            if !keyword.is_empty() && item.title.contains(keyword.as_str()) {
                hits.insert(item.title.clone(), keyword.clone());
                return;
            }
        }
        // 已订阅(历史成功)或已在队列 -> 跳过
        if let Some(history) = &self.history {
            for entry in history {
                if entry.douban_ref == item.douban_ref
                    && entry.result == "succeeded"
                    && entry.action == "subscribe"
                {
                    return;
                }
            }
        }
        if let Some(queued) = &self.queue.items {
            for existing in queued {
                if existing.douban_ref == item.douban_ref {
                    // 已存在: 仅刷新热度, 不重复入队(Go 的注释如此, 代码只 return)
                    return;
                }
            }
        }
        let mut period = self.settings.observe_period_hours;
        if period <= 0 {
            period = 24;
        }
        let now_nanos = clock::now_unix_nanos();
        let due_nanos = now_nanos.saturating_add(
            (period as u64).saturating_mul(3_600_000_000_000), // Go: period * time.Hour
        );
        let queue = self.queue.items.get_or_insert_with(Vec::new);
        // [功能2/3] 入队时带上过滤判定要用的评分: `item.rate` 解析不出(口碑榜/即将上映榜
        // 实测大量空串, 见 `crate::filter` 的 deviations 第 3 条)→ 0 = 未知, 到期处理时
        // `min_rating > 0` 会按"无评分"拦; `year` 本就在 [`QueueItem`] 上(但
        // `ChartItem::year` 对这两个榜单实测同样常为空)。
        // [功能1] `media_type` 取该榜单配置的 `kind`(movie/tv): 到期订阅的 rexxar
        // 详情回退要按它走对应路径(配置缺失/为空 → 空串, 按 movie 取, 与旧行为一致)。
        let media_type = self
            .settings
            .lists
            .as_ref()
            .and_then(|lists| lists.get(list))
            .map(|config| config.kind.clone())
            .unwrap_or_default();
        queue.push(QueueItem {
            douban_ref: item.douban_ref.clone(),
            title: item.title.clone(),
            list: list.to_string(),
            poster_url: item.poster_url.clone(),
            url: item.url.clone(),
            media_type,
            year: item.year.clone(),
            rating: crate::filter::parse_rate(&item.rate).unwrap_or(0.0),
            entered_at: clock::now_rfc3339(),
            due_at: clock::rfc3339(due_nanos),
            state: "observing".to_string(),
            ..QueueItem::default()
        });
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

/// 本路测试用的脚本化出站 HTTP 替身(仅 `cargo test`, 非 wasm 目标)。
#[cfg(test)]
pub(crate) mod testhttp;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::charts::testhttp::{Guard, ScriptedHttp};
    use crate::model::PersistedState;
    use crate::runtime::BROWSER_USER_AGENT;

    /// 本路新增夹具: 真实页面摘录(见 `tests/fixtures/` 与 `tests/fixtures/README.md`)。
    /// 抓取时间 2026-09-29; 页面本身不含任何 uid/凭据。
    const CHART_HTML: &[u8] = include_bytes!("../tests/fixtures/chart_listcont2.html");
    const COMING_HTML: &[u8] = include_bytes!("../tests/fixtures/coming_showing_soon.html");
    const SUBJECTS_JSON: &[u8] = include_bytes!("../tests/fixtures/search_subjects.json");

    /// 夹具时间常量: `2026-09-29T10:00:09Z`(`clock.rs` 的 `FIXED_NOW`)。
    const FIXED_NOW: u64 = 1_790_676_009_000_000_000;

    /// 固定时钟的用例守卫(离开作用域恢复真实时钟)。
    struct FixedClock;

    impl FixedClock {
        fn at(nanos: u64) -> Self {
            clock::testhooks::set_now(Some(nanos));
            FixedClock
        }
    }

    impl Drop for FixedClock {
        fn drop(&mut self) {
            clock::testhooks::set_now(None);
        }
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    // ─────────────────────────── 纯函数 ───────────────────────────

    /// 对拍 Go `reWant = ([\d,]+)\s*人?\s*想看` 的捕获组与 `strconv.Atoi` 语义。
    #[test]
    fn parse_want_matches_go_capture_group() {
        // 真实页面原文: `<li class="dt last"><span class="">15177人想看</span></li>`
        assert_eq!(parse_want("<span class=\"\">15177人想看</span>"), 15177);
        // 千分位逗号与空白: Go 的 `([\d,]+)\s*人?\s*想看`
        assert_eq!(parse_want("1,234 人想看"), 1234);
        assert_eq!(parse_want("已有 12,345 人 想看"), 12345);
        assert_eq!(parse_want("12,345,678人想看"), 12345678);
        // 没有数字 → 无匹配 → 0
        assert_eq!(parse_want("人想看"), 0);
        assert_eq!(parse_want(""), 0);
        // 必须有"想看"两字连续出现(Go 的 `人?` 只允许一个可选"人")
        assert_eq!(parse_want("123人想 看"), 0);
        // 贪婪匹配: 取最长的数字串
        assert_eq!(parse_want("7 10人想看"), 10);
        // 已知差异: Go 在 wasm32(wasip1)上 `int` 是 32 位, `Atoi` 溢出会得 0;
        // 这里 `ChartItem.hotness` 是 i64(冻结模型), 保留真实数值。
        assert_eq!(parse_want("3000000000人想看"), 3_000_000_000);
    }

    #[test]
    fn source_cost_matches_go_switch() {
        assert_eq!(source_cost("subjects_json"), 1);
        assert_eq!(source_cost("chart_html"), 2);
        assert_eq!(source_cost("coming_html"), 3);
        assert_eq!(source_cost(""), 4);
        assert_eq!(source_cost("unknown"), 4);
    }

    #[test]
    fn section_after_matches_go_semantics() {
        let html = "AAA id=\"x\" bbb OPEN ccc CLOSE ddd";
        // 找不到锚点 → 原样返回整份
        assert_eq!(section_after(html, "id=\"y\"", "", ""), html);
        // open/close 都为空 → 从锚点到结尾
        assert_eq!(
            section_after(html, "id=\"x\"", "", ""),
            "id=\"x\" bbb OPEN ccc CLOSE ddd"
        );
        // open 截取(从锚点之后找, 找不到就保持不动)
        assert_eq!(
            section_after(html, "id=\"x\"", "OPEN", ""),
            "OPEN ccc CLOSE ddd"
        );
        assert_eq!(
            section_after(html, "id=\"x\"", "NOPE", ""),
            "id=\"x\" bbb OPEN ccc CLOSE ddd"
        );
        // close 截取
        assert_eq!(
            section_after(html, "id=\"x\"", "", "CLOSE"),
            "id=\"x\" bbb OPEN ccc "
        );
        assert_eq!(
            section_after(html, "id=\"x\"", "NOPE", "NOPE"),
            "id=\"x\" bbb OPEN ccc CLOSE ddd"
        );
        // 锚点在 open/close 之后: open 找不到 → 不动; close 找不到 → 不动
        assert_eq!(section_after(html, "ddd", "OPEN", "CLOSE"), "ddd");
        // 锚点就在 close 片段里
        assert_eq!(section_after(html, "CLOSE", "", "CLOSE"), "");
        // 空锚点: Go 的 strings.Index 返回 0
        assert_eq!(section_after(html, "", "", ""), html);
    }

    /// 真实 chart 页: `section_after` 必须从锚点截到 `</ul>`。
    #[test]
    fn section_after_on_real_chart_page() {
        let html = text(CHART_HTML);
        let segment = section_after(&html, "id=\"listCont2\"", "", "</ul>");
        assert!(
            segment.starts_with("id=\"listCont2\">"),
            "实际: {}",
            segment.chars().take(40).collect::<String>()
        );
        assert_eq!(segment.find("</ul>"), None, "段落应截到 </ul> 之前");
        assert_eq!(segment.matches("<li class=\"clearfix\">").count(), 10);
    }

    #[test]
    fn query_escape_matches_go_query_escape() {
        // Go: url.QueryEscape("热门") == "%E7%83%AD%E9%97%A8"
        assert_eq!(query_escape("热门"), "%E7%83%AD%E9%97%A8");
        // Go: url.QueryEscape("国产剧") == "%E5%9B%BD%E4%BA%A7%E5%89%A7"
        assert_eq!(query_escape("国产剧"), "%E5%9B%BD%E4%BA%A7%E5%89%A7");
        assert_eq!(query_escape("movie"), "movie");
        assert_eq!(query_escape("a b"), "a+b");
        assert_eq!(query_escape("-_.~"), "-_.~");
        assert_eq!(query_escape("a/b&c=d"), "a%2Fb%26c%3Dd");
        assert_eq!(query_escape(""), "");
    }

    // ─────────────────────────── subjects_json ───────────────────────────

    #[test]
    fn fetch_subjects_json_parses_real_response() {
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 200, SUBJECTS_JSON.to_vec());
        let _guard: Guard = stub.install();

        let runtime = Runtime::new();
        let config = ListConfig {
            source: "subjects_json".into(),
            kind: "movie".into(),
            tag: "热门".into(),
            sort: "recommend".into(),
            limit: 30,
            enabled: true,
        };
        let items = runtime.fetch_subjects_json(&config).expect("抓取成功");

        assert_eq!(items.len(), 6);
        assert_eq!(items[0].douban_ref, "db:subj:36850814");
        assert_eq!(items[0].title, "年会不能停！2");
        assert_eq!(items[0].rate, "6.6");
        assert_eq!(
            items[0].poster_url,
            "https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2934583425.jpg"
        );
        assert_eq!(items[0].url, "https://movie.douban.com/subject/36850814/");
        // Go 不填 rank/year/hotness
        assert_eq!(items[0].rank, "");
        assert_eq!(items[0].year, "");
        assert_eq!(items[0].hotness, 0);
        assert_eq!(items[5].douban_ref, "db:subj:35322132");
        assert_eq!(items[5].title, "罗斯");

        // 请求形态: URL 逐段按 Go 的 QueryEscape 编码, accept 与 UA/referer 由 http_get 附带
        let requests = stub.requests();
        let request = &requests[0];
        assert_eq!(
            request.path,
            "https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&sort=recommend&page_limit=30&page_start=0"
        );
        assert_eq!(
            request.headers.get("accept").map(String::as_str),
            Some("application/json, text/plain;q=0.9")
        );
        assert_eq!(
            request.headers.get("user-agent").map(String::as_str),
            Some(BROWSER_USER_AGENT)
        );
        assert_eq!(
            request.headers.get("referer").map(String::as_str),
            Some("https://movie.douban.com/")
        );
    }

    #[test]
    fn fetch_subjects_json_skips_blank_titles_and_tolerates_nulls() {
        let body = r#"{"subjects":[{"id":"1","title":"   ","rate":"8.8","cover":"c","url":"u"},
                                {"id":"2","title":"  空 白 外 侧  ","rate":"","cover":"","url":""}],
                        "extra":null}"#
            .as_bytes();
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 200, body.to_vec());
        let _guard = stub.install();

        let runtime = Runtime::new();
        let config = ListConfig {
            source: "subjects_json".into(),
            kind: "movie".into(),
            tag: "热门".into(),
            ..ListConfig::default()
        };
        let items = runtime.fetch_subjects_json(&config).expect("抓取成功");
        assert_eq!(items.len(), 1, "标题全空白的条目要跳过");
        assert_eq!(items[0].douban_ref, "db:subj:2");
        assert_eq!(items[0].title, "空 白 外 侧");

        // `"subjects": null` → Go 解成 nil slice → 空结果而非报错
        let stub2 = ScriptedHttp::new();
        stub2.route("/j/search_subjects", 200, br#"{"subjects":null}"#.to_vec());
        let _guard2 = stub2.install();
        assert!(runtime
            .fetch_subjects_json(&config)
            .expect("null 也要能解")
            .is_empty());
    }

    #[test]
    fn fetch_subjects_json_reports_http_and_parse_errors() {
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 503, Vec::new());
        let _guard = stub.install();
        let runtime = Runtime::new();
        let config = ListConfig {
            source: "subjects_json".into(),
            ..ListConfig::default()
        };
        assert_eq!(
            runtime
                .fetch_subjects_json(&config)
                .unwrap_err()
                .to_string(),
            "HTTP 503"
        );

        let stub2 = ScriptedHttp::new();
        stub2.route("/j/search_subjects", 200, b"<html>not json</html>".to_vec());
        let _guard2 = stub2.install();
        let err = runtime
            .fetch_subjects_json(&config)
            .unwrap_err()
            .to_string();
        assert!(err.starts_with("响应解析失败: "), "实际: {err}");
    }

    // ─────────────────────────── coming_html ───────────────────────────

    /// 对拍 Go `reItemMod` / `reItemSubj` / `reItemImg` / `reWant` 与
    /// `TrimSpace(space.ReplaceAllString(...))`(期望值 = 把与 Go 逐字相同的模式
    /// 在另一份独立实现上跑同一份夹具所得的捕获组)。
    #[test]
    fn fetch_coming_parses_real_page() {
        let stub = ScriptedHttp::new();
        stub.route(
            "https://movie.douban.com/cinema/later/",
            200,
            COMING_HTML.to_vec(),
        );
        let _guard = stub.install();

        let runtime = Runtime::new();
        let items = runtime.fetch_coming(20).expect("抓取成功");
        assert_eq!(items.len(), 6);
        assert_eq!(items[0].douban_ref, "db:subj:36828393");
        assert_eq!(items[0].title, "野兽之心");
        assert_eq!(items[0].hotness, 15177);
        assert_eq!(
            items[0].poster_url,
            "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2935475988.jpg"
        );
        assert_eq!(items[0].url, "https://movie.douban.com/subject/36828393/");
        assert_eq!(items[0].rate, "");
        assert_eq!(items[0].rank, "");

        // 标题里的 U+200E(LEFT-TO-RIGHT MARK)不是空白: Go 的 `\s` 与 Rust 的
        // ASCII 空白类都不吃它, TrimSpace 也不吃 → 原样保留
        assert_eq!(items[1].douban_ref, "db:subj:37247814");
        assert_eq!(items[1].title, "神探之痕迹\u{200e}");
        assert_eq!(items[1].hotness, 6352);
        assert_eq!(
            items[1].poster_url,
            "https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2935867001.jpg"
        );

        assert_eq!(items[5].title, "小猪佩奇·完美假期");
        assert_eq!(items[5].hotness, 520);
        assert_eq!(items[5].douban_ref, "db:subj:36964833");

        // 只发一次请求(HTML 页面), 且带防盗链头
        assert_eq!(stub.requests().len(), 1);
        assert_eq!(
            stub.requests()[0]
                .headers
                .get("referer")
                .map(String::as_str),
            Some("https://movie.douban.com/")
        );
        assert_eq!(
            stub.requests()[0].headers.get("accept").map(String::as_str),
            Some("text/html,application/xhtml+xml;q=0.9")
        );
    }

    #[test]
    fn fetch_coming_respects_limit_and_dedup() {
        let stub = ScriptedHttp::new();
        stub.route("/cinema/later/", 200, COMING_HTML.to_vec());
        let _guard = stub.install();
        let runtime = Runtime::new();
        assert_eq!(runtime.fetch_coming(2).expect("抓取成功").len(), 2);
        assert_eq!(
            runtime.fetch_coming(0).expect("抓取成功").len(),
            1,
            "Go 是 append 后再比 len >= limit"
        );
        assert_eq!(
            runtime.fetch_coming(-1).expect("抓取成功").len(),
            1,
            "负数 limit 不能 panic"
        );

        // 重复 id 只留一条(Go 的 seen 去重); 手工最小片段(标签形态照抄真实页面的
        // 每个 item 都是 `<div class="item mod...">…</div></div>`)。
        let duplicated = r#"<html><body>
            <div id="showing-soon">
              <div class="item mod "><h3><a href="https://movie.douban.com/subject/111/" class="">甲</a></h3>
                <span class="">7人想看</span></div></div>
              <div class="item mod odd"><h3><a href="https://movie.douban.com/subject/111/" class="">甲(重复)</a></h3></div></div>
              <div class="item mod "><h3><a href="https://movie.douban.com/subject/222/" class="">乙</a></h3></div></div>
            </div></body></html>"#
            .as_bytes();
        let stub2 = ScriptedHttp::new();
        stub2.route("/cinema/later/", 200, duplicated.to_vec());
        let _guard2 = stub2.install();
        let items = runtime.fetch_coming(20).expect("抓取成功");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].douban_ref, "db:subj:111");
        assert_eq!(items[0].hotness, 7);
        assert_eq!(items[1].douban_ref, "db:subj:222");
    }

    #[test]
    fn fetch_coming_without_anchor_matches_go() {
        // Go: 找不到 `id="showing-soon"` 时 sectionAfter 返回整份 html, 于是整页找 item
        let page = r#"<html><body>
            <div class="item mod "><h3><a href="https://movie.douban.com/subject/333/">丙</a></h3>
              <img src="https://img3.doubanio.com/x.jpg" /></div></div>
            </body></html>"#
            .as_bytes();
        let stub = ScriptedHttp::new();
        stub.route("/cinema/later/", 200, page.to_vec());
        let _guard = stub.install();
        let items = Runtime::new().fetch_coming(20).expect("抓取成功");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].douban_ref, "db:subj:333");
        assert_eq!(items[0].poster_url, "https://img3.doubanio.com/x.jpg");
        assert_eq!(items[0].hotness, 0);
    }

    // ─────────────────────────── chart_html ───────────────────────────

    /// 对拍 Go `reLiClear` / `reName` / `reNo`(期望值 = 把与 Go 逐字相同的模式
    /// 在另一份独立实现上跑同一份夹具所得的捕获组)。
    #[test]
    fn fetch_chart_parses_real_page_without_poster_lookup() {
        let stub = ScriptedHttp::new();
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        let _guard = stub.install();

        let runtime = Runtime::new(); // deep_refresh = false
        let items = runtime.fetch_chart(20).expect("抓取成功");
        assert_eq!(items.len(), 10);
        assert_eq!(items[0].douban_ref, "db:subj:35322132");
        assert_eq!(items[0].title, "罗斯");
        assert_eq!(items[0].rank, "1");
        assert_eq!(items[0].rate, "");
        assert_eq!(items[0].hotness, 0, "口碑榜 HTML 里没有『想看』字样");
        assert_eq!(items[0].poster_url, "");
        assert_eq!(items[0].url, "https://movie.douban.com/subject/35322132/");
        assert_eq!(items[9].rank, "10");
        assert_eq!(items[9].title, "托尼");
        assert_eq!(items[9].douban_ref, "db:subj:37002986");

        // 前台不补海报: 只发一次页面请求
        assert_eq!(
            stub.requests().len(),
            1,
            "deep_refresh=false 不该有海报查询"
        );
    }

    /// 后台(deep_refresh)只为前 `POSTER_LOOKUP_LIMIT` 条补海报(Go `main.go:749`)。
    #[test]
    fn fetch_chart_deep_refresh_limits_poster_lookups() {
        let stub = ScriptedHttp::new();
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        // 站内 suggest 与 rexxar 都 404 → movie_poster 两条路都失败, 但调用次数可数
        stub.route("/j/subject_suggest", 404, Vec::new());
        stub.route("/rexxar/api/v2/movie/", 404, Vec::new());
        let _guard = stub.install();

        let mut runtime = Runtime::new();
        runtime.deep_refresh = true;
        let items = runtime.fetch_chart(20).expect("抓取成功");
        assert_eq!(items.len(), 10);
        assert!(items.iter().all(|item| item.poster_url.is_empty()));

        let urls: Vec<String> = stub.requests().iter().map(|r| r.path.clone()).collect();
        let suggest_calls = urls
            .iter()
            .filter(|url| url.contains("/j/subject_suggest"))
            .count();
        let rexxar_calls = urls
            .iter()
            .filter(|url| url.contains("/rexxar/api/v2/movie/"))
            .count();
        assert_eq!(suggest_calls, POSTER_LOOKUP_LIMIT);
        assert_eq!(
            rexxar_calls, POSTER_LOOKUP_LIMIT,
            "suggest 失败后回退 rexxar"
        );
        assert_eq!(urls.len(), 1 + POSTER_LOOKUP_LIMIT * 2);
        // 只问前 8 条(按标题查, 校验 id 一致)
        assert!(urls[1].starts_with("https://movie.douban.com/j/subject_suggest?q="));
        assert!(
            urls[1].contains("%E7%BD%97%E6%96%AF"),
            "第一条是《罗斯》: {}",
            urls[1]
        );
        assert!(urls[2].ends_with("/rexxar/api/v2/movie/35322132"));
    }

    /// 海报按标题查询时校验 id 一致(Go `suggestPoster`), id 不符要回退 rexxar。
    #[test]
    fn fetch_chart_poster_lookup_prefers_id_checked_suggest() {
        let stub = ScriptedHttp::new();
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        stub.route(
            "/j/subject_suggest",
            200,
            br#"[{"id":"999999","img":"https://img1.doubanio.com/wrong.jpg"},
                  {"id":"35322132","img":"https://img3.doubanio.com/right.jpg"}]"#
                .to_vec(),
        );
        let _guard = stub.install();
        let mut runtime = Runtime::new();
        runtime.deep_refresh = true;
        let items = runtime.fetch_chart(1).expect("抓取成功");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].poster_url, "https://img3.doubanio.com/right.jpg");
        // 第一条命中后不再问 rexxar
        assert!(stub.requests().iter().all(|r| !r.path.contains("/rexxar/")));
    }

    // ─────────────────────────── fetch_list 分派 ───────────────────────────

    #[test]
    fn fetch_list_dispatches_and_reports_unknown_source() {
        let stub = ScriptedHttp::new();
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        let _guard = stub.install();
        let runtime = Runtime::new();

        let chart = ListConfig {
            source: "chart_html".into(),
            limit: 3,
            ..ListConfig::default()
        };
        assert_eq!(runtime.fetch_list("movie_wom", &chart).unwrap().len(), 3);

        let unknown = ListConfig {
            source: "rss_xml".into(),
            ..ListConfig::default()
        };
        let err = runtime.fetch_list("x", &unknown).unwrap_err().to_string();
        assert_eq!(err, "未知榜单来源 \"rss_xml\"");

        let empty = ListConfig::default();
        assert_eq!(
            runtime.fetch_list("x", &empty).unwrap_err().to_string(),
            "未知榜单来源 \"\""
        );
    }

    // ─────────────────────────── refreshNow 的排序与预算 ───────────────────────────

    fn refresh_settings() -> Settings {
        let mut lists = BTreeMap::new();
        lists.insert(
            "upcoming".to_string(),
            ListConfig {
                source: "coming_html".into(),
                kind: "movie".into(),
                limit: 20,
                enabled: true,
                ..ListConfig::default()
            },
        );
        lists.insert(
            "movie_wom".to_string(),
            ListConfig {
                source: "chart_html".into(),
                kind: "movie".into(),
                limit: 20,
                enabled: true,
                ..ListConfig::default()
            },
        );
        lists.insert(
            "hot".to_string(),
            ListConfig {
                source: "subjects_json".into(),
                kind: "movie".into(),
                tag: "热门".into(),
                sort: "recommend".into(),
                limit: 30,
                enabled: true,
                ..ListConfig::default()
            },
        );
        lists.insert(
            "off".to_string(),
            ListConfig {
                source: "subjects_json".into(),
                kind: "tv".into(),
                tag: "国产剧".into(),
                enabled: false,
                ..ListConfig::default()
            },
        );
        Settings {
            lists: Some(lists),
            observe_period_hours: 24,
            max_logs: 200,
            ..Settings::default()
        }
    }

    /// Go: 按 `sourceCost` 稳定排序, 便宜的 JSON 榜单先抓; 未启用的不抓。
    #[test]
    fn fetch_enabled_lists_orders_by_cost_and_skips_disabled() {
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 200, SUBJECTS_JSON.to_vec());
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        stub.route("/cinema/later/", 200, COMING_HTML.to_vec());
        let _guard = stub.install();

        let mut runtime = Runtime::new();
        let settings = refresh_settings();
        let results = runtime.fetch_enabled_lists(&settings, ACTION_BUDGET_MS);

        let keys: Vec<&str> = results.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["hot", "movie_wom", "upcoming"], "成本 1 < 2 < 3");
        assert!(results.iter().all(|result| result.items.is_ok()));
        assert_eq!(results[0].items.as_ref().unwrap().len(), 6);
        assert_eq!(results[1].items.as_ref().unwrap().len(), 10);
        assert_eq!(results[2].items.as_ref().unwrap().len(), 6);

        let urls: Vec<String> = stub.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(urls.len(), 3);
        assert!(urls[0].starts_with("https://movie.douban.com/j/search_subjects?"));
        assert!(urls[1].starts_with("https://movie.douban.com/chart"));
        assert!(urls[2].starts_with("https://movie.douban.com/cinema/later/"));
        assert!(
            !urls.iter().any(|url| url.contains("type=tv")),
            "禁用的榜单不能被请求"
        );

        // 日志: 每个榜单两条(开始 / 抓到 N 条)
        let logs = runtime.logs.clone().unwrap_or_default();
        let messages: Vec<&str> = logs.iter().map(|entry| entry.message.as_str()).collect();
        assert_eq!(messages[0], "开始抓取榜单 hot source=subjects_json");
        assert_eq!(messages[1], "榜单 hot 抓到 6 条");
        assert_eq!(messages[4], "开始抓取榜单 upcoming source=coming_html");
        assert_eq!(messages[5], "榜单 upcoming 抓到 6 条");
    }

    /// Go: `used > budget` 就跳过剩余榜单, 并写那条"本次已用 N 秒"的 warning。
    #[test]
    fn fetch_enabled_lists_skips_remaining_lists_over_budget() {
        let _clock = FixedClock::at(FIXED_NOW);
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 200, SUBJECTS_JSON.to_vec());
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        stub.route("/cinema/later/", 200, COMING_HTML.to_vec());
        // 第一次出站请求返回时把时钟拨到 7 秒后(前台预算 6.5 秒)
        stub.on_request(|_| clock::testhooks::set_now(Some(FIXED_NOW + 7_000_000_000)));
        let _guard = stub.install();

        let mut runtime = Runtime::new();
        let settings = refresh_settings();
        let results = runtime.fetch_enabled_lists(&settings, ACTION_BUDGET_MS);

        assert_eq!(results.len(), 1, "只剩第一个(最便宜的)榜单");
        assert_eq!(results[0].key, "hot");
        assert_eq!(stub.requests().len(), 1);

        let logs = runtime.logs.clone().unwrap_or_default();
        let messages: Vec<&str> = logs.iter().map(|entry| entry.message.as_str()).collect();
        assert_eq!(
            messages[2],
            "本次已用 7 秒, 跳过剩余榜单(下轮自动刷新会补齐)"
        );
        assert_eq!(logs[2].level, "warning");

        // 后台预算 8 分钟: 同样的 7 秒不触发跳过
        let mut runtime2 = Runtime::new();
        runtime2.deep_refresh = true;
        let results2 = runtime2.fetch_enabled_lists(&settings, JOB_BUDGET_MS);
        assert_eq!(results2.len(), 3);
    }

    #[test]
    fn refresh_budget_follows_deep_refresh() {
        let mut runtime = Runtime::new();
        assert_eq!(runtime.refresh_budget_ms(), ACTION_BUDGET_MS);
        assert_eq!(ACTION_BUDGET_MS, 6_500);
        runtime.deep_refresh = true;
        assert_eq!(runtime.refresh_budget_ms(), JOB_BUDGET_MS);
        assert_eq!(JOB_BUDGET_MS, 480_000);
    }

    #[test]
    fn fetch_enabled_lists_logs_failures_without_aborting() {
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 500, Vec::new());
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        stub.route("/cinema/later/", 200, COMING_HTML.to_vec());
        let _guard = stub.install();

        let mut runtime = Runtime::new();
        let results = runtime.fetch_enabled_lists(&refresh_settings(), ACTION_BUDGET_MS);
        assert_eq!(results.len(), 3, "单榜失败不打断其余榜单");
        assert!(results[0].items.is_err());
        assert_eq!(
            results[0].items.as_ref().unwrap_err().to_string(),
            "HTTP 500"
        );
        assert!(results[1].items.is_ok());
        let logs = runtime.logs.clone().unwrap_or_default();
        assert_eq!(logs[1].message, "榜单 hot 抓取失败: HTTP 500");
        assert_eq!(logs[1].level, "warning");
    }

    #[test]
    fn refresh_now_guards_against_reentry() {
        let mut runtime = Runtime::new();
        runtime.refreshing = true;
        let err = runtime.refresh_now("inv_1").unwrap_err().to_string();
        assert_eq!(err, "榜单刷新正在进行中");
        assert!(runtime.refreshing, "重入失败不能把标志清掉");
    }

    // ─────────────────────────── 黑名单过滤 + 入队 ───────────────────────────

    fn fixture_document() -> PersistedState {
        PersistedState::parse(crate::fixtures::STATE).expect("夹具状态文档必须能解析")
    }

    fn loaded_runtime() -> Runtime {
        let document = fixture_document();
        let mut runtime = Runtime::new();
        runtime.settings = document.settings;
        runtime.snapshot = document.snapshot;
        runtime.queue = document.queue;
        runtime.history = document.history;
        runtime.black_state = document.blackstate;
        runtime
    }

    /// 真实 state 文档: 快照里 107 条已全部在队列中 → 只统计黑名单命中, 不重复入队。
    #[test]
    fn filter_and_enqueue_counts_blacklist_hits_on_real_state() {
        let _clock = FixedClock::at(FIXED_NOW);
        let mut runtime = loaded_runtime();
        let queue_before = runtime.queue.items.as_ref().map_or(0, Vec::len);
        let mut settings = runtime.settings.clone();
        settings.blacklist = Some(vec!["兽".to_string()]);
        let snapshot = runtime.snapshot.clone();

        runtime.filter_and_enqueue(&snapshot, &settings);

        assert_eq!(runtime.black_state.hits, 1, "快照里只有《野兽之心》命中");
        let recent = runtime.black_state.recent.clone().unwrap_or_default();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].title, "野兽之心");
        assert_eq!(recent[0].keyword, "兽");
        assert_eq!(recent[0].at, clock::rfc3339(FIXED_NOW));
        assert_eq!(
            runtime.queue.items.as_ref().map_or(0, Vec::len),
            queue_before,
            "队列里的 ref 一个都不该重复入队"
        );
    }

    /// 把命中黑名单/已在队列的条目摘掉后, 其余条目要按 `observing` 入队,
    /// `due_at` = 现在 + `observe_period_hours`。
    #[test]
    fn check_item_enqueues_with_due_at_from_observe_period() {
        let _clock = FixedClock::at(FIXED_NOW);
        let mut runtime = loaded_runtime();
        let snapshot = runtime.snapshot.clone();
        // 只留 upcoming 榜单, 队列清空
        // `lists.get(...)` 给的是 `Option<&Option<Vec<ChartItem>>>`,
        // 这里要的是内层那份(缺席与空列表在 Go 里都是"没有条目")。
        let upcoming: Option<Vec<ChartItem>> = snapshot
            .lists
            .as_ref()
            .and_then(|lists| lists.get(list_upcoming()))
            .and_then(|items| items.clone());
        let items = upcoming.as_ref().expect("夹具里 upcoming 非空");
        let subscribed_ref = items
            .get(1)
            .map(|item| item.douban_ref.clone())
            .expect("夹具里 upcoming 至少 2 条");
        runtime.snapshot = Snapshot {
            fetched_at: snapshot.fetched_at.clone(),
            lists: Some(BTreeMap::from([(
                list_upcoming().to_string(),
                upcoming.clone(),
            )])),
        };
        runtime.queue = crate::model::Queue::EMPTY;
        // 第 2 条当作"历史上已成功订阅过"(第 1 条留给黑名单用例)
        runtime.history = Some(vec![crate::model::HistoryEntry {
            douban_ref: subscribed_ref.clone(),
            action: "subscribe".into(),
            result: "succeeded".into(),
            ..crate::model::HistoryEntry::default()
        }]);

        let mut settings = runtime.settings.clone();
        // 命中黑名单的一条(《野兽之心》在 upcoming 里)
        settings.blacklist = Some(vec!["兽".to_string()]);
        settings.observe_period_hours = 24;

        let snapshot = runtime.snapshot.clone();
        runtime.filter_and_enqueue(&snapshot, &settings);

        let queued = runtime.queue.items.clone().unwrap_or_default();
        assert_eq!(
            queued.len(),
            items.len() - 2,
            "去掉黑名单命中与已订阅各 1 条"
        );
        assert!(queued.iter().all(|item| item.state == "observing"));
        assert!(queued.iter().all(|item| item.list == "upcoming"));
        assert!(
            queued
                .iter()
                .all(|item| item.due_at == "2026-09-30T10:00:09Z"),
            "due = now + 24h"
        );
        assert!(queued
            .iter()
            .all(|item| item.entered_at == "2026-09-29T10:00:09Z"));
        assert!(queued.iter().all(|item| item.attempt == 0));
        assert!(
            !queued.iter().any(|item| item.douban_ref == subscribed_ref),
            "历史成功订阅过的要跳过"
        );
        assert!(
            !queued
                .iter()
                .any(|item| item.douban_ref == "db:subj:36828393"),
            "黑名单命中的不入队"
        );
        assert_eq!(runtime.black_state.hits, 1);
    }

    #[test]
    fn check_item_uses_blacklist_keyword_priority_and_observation_default() {
        let _clock = FixedClock::at(FIXED_NOW);
        let mut runtime = Runtime::new();
        let mut hits: BTreeMap<String, String> = BTreeMap::new();
        let item = ChartItem {
            douban_ref: "db:subj:1".into(),
            title: "疯狂动物城2".into(),
            url: "https://movie.douban.com/subject/1/".into(),
            poster_url: "https://img1.doubanio.com/a.jpg".into(),
            ..ChartItem::default()
        };
        // 空关键词不参与命中(Go: `kw != "" && ...`)
        runtime.check_item(
            &item,
            "hot",
            &["".to_string(), "动物".to_string()],
            &mut hits,
        );
        assert_eq!(hits.get("疯狂动物城2").map(String::as_str), Some("动物"));
        assert_eq!(
            runtime.queue.items.as_ref().map_or(0, Vec::len),
            0,
            "命中黑名单不入队"
        );

        // 未命中 → 入队; observe_period_hours = 0 → Go 按 24 小时
        let mut hits2 = BTreeMap::new();
        runtime.check_item(&item, "hot", &[], &mut hits2);
        assert!(hits2.is_empty());
        let queued = runtime.queue.items.clone().unwrap_or_default();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].list, "hot");
        assert_eq!(queued[0].poster_url, "https://img1.doubanio.com/a.jpg");
        assert_eq!(queued[0].due_at, "2026-09-30T10:00:09Z");

        // 同一个 ref 再来一次 → 跳过
        runtime.check_item(&item, "hot", &[], &mut hits2);
        assert_eq!(runtime.queue.items.as_ref().map_or(0, Vec::len), 1);
    }

    /// `recent` 只留最近 20 条, `hits` 按命中标题数累加(Go `main.go:1280` 起)。
    #[test]
    fn filter_and_enqueue_trims_recent_to_20() {
        let _clock = FixedClock::at(FIXED_NOW);
        let mut runtime = Runtime::new();
        let mut lists = BTreeMap::new();
        let items: Vec<ChartItem> = (0..25)
            .map(|index| ChartItem {
                douban_ref: format!("db:subj:{index}"),
                title: format!("黑片{index:02}"),
                ..ChartItem::default()
            })
            .collect();
        lists.insert("hot".to_string(), Some(items));
        runtime.snapshot = Snapshot {
            fetched_at: clock::now_rfc3339(),
            lists: Some(lists.clone()),
        };
        runtime.queue = crate::model::Queue::EMPTY;
        let snapshot = Snapshot {
            fetched_at: clock::now_rfc3339(),
            lists: Some(lists),
        };
        let settings = Settings {
            blacklist: Some(vec!["黑片".to_string()]),
            ..Settings::default()
        };

        runtime.filter_and_enqueue(&snapshot, &settings);
        assert_eq!(runtime.black_state.hits, 25);
        assert_eq!(runtime.black_state.recent.as_ref().map_or(0, Vec::len), 20);
        assert_eq!(
            runtime.black_state.hits, 25,
            "hits 是命中条数, 不受 recent 截断影响"
        );
        // 全部命中黑名单 → 一条都不入队
        assert_eq!(runtime.queue.items.as_ref().map_or(0, Vec::len), 0);
    }

    // ─────────────────────────── 端到端: 前台 refreshNow ───────────────────────────

    /// 前台(`deep_refresh=false`)整条刷新链路(Go `main.go:1145` `refreshNow`):
    /// 按成本抓 3 个榜 → 组装快照 → 黑名单过滤 + 入队 → 摘要日志 → `bump` + `persistAll`。
    ///
    /// 跨路依赖只有一处: `sync_wish_list`(路 2)在 `wish_sync_enabled=false` 时立刻返回,
    /// 因此本用例不进入想看逻辑; 后台才跑的 `process_due`(路 3)**一次都不能被调用** ——
    /// 这一点用"出站 GET 只有 3 次页面抓取"来证明(补海报/查 TMDB/建订阅都会额外发请求)。
    #[test]
    fn refresh_now_front_end_fetches_enqueues_and_skips_subscriptions() {
        let _clock = FixedClock::at(FIXED_NOW);
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 200, SUBJECTS_JSON.to_vec());
        stub.route("https://movie.douban.com/chart", 200, CHART_HTML.to_vec());
        stub.route("/cinema/later/", 200, COMING_HTML.to_vec());
        let _guard = stub.install();

        let mut runtime = Runtime::new();
        runtime.settings = refresh_settings();
        runtime.refresh_now("inv_front").expect("前台刷新成功");

        // 1. 快照: 3 个启用的榜单(未启用的 off 不出现), 条目数与真实夹具一致
        let lists = runtime.snapshot.lists.clone().expect("lists 非空");
        assert_eq!(lists.len(), 3);
        assert_eq!(
            lists
                .get("hot")
                .and_then(|items| items.as_ref())
                .map(Vec::len),
            Some(6)
        );
        assert_eq!(
            lists
                .get("movie_wom")
                .and_then(|items| items.as_ref())
                .map(Vec::len),
            Some(10)
        );
        assert_eq!(
            lists
                .get("upcoming")
                .and_then(|items| items.as_ref())
                .map(Vec::len),
            Some(6)
        );
        assert!(!lists.contains_key("off"), "禁用的榜单不进快照");
        assert_eq!(runtime.snapshot.fetched_at, clock::rfc3339(FIXED_NOW));
        assert_eq!(runtime.last_run, clock::rfc3339(FIXED_NOW));

        // 2. 入队: 22 条抓取结果里有 2 条与更早的榜单同 ref(hot 与 movie_wom 都有
        //    35322132/36801617) → `check_item` 按 ref 去重, 实际入队 20 条。
        let queued = runtime.queue.items.clone().unwrap_or_default();
        assert_eq!(
            queued.len(),
            20,
            "Go 的 checkItem 按 douban_ref 去重, 跨榜单也算"
        );
        let refs: BTreeSet<&str> = queued.iter().map(|item| item.douban_ref.as_str()).collect();
        assert_eq!(refs.len(), 20, "队列里不能有重复 ref");
        assert!(queued.iter().all(|item| item.state == "observing"));
        assert!(queued.iter().all(|item| item.attempt == 0));
        assert!(
            queued
                .iter()
                .all(|item| item.due_at == "2026-09-30T10:00:09Z"),
            "due = now + 24h"
        );
        // Go 的遍历顺序: 先 upcoming, 再其余榜单(这里按榜单键字典序), 队尾是 movie_wom
        assert_eq!(queued[0].list, "upcoming");
        assert_eq!(queued[0].douban_ref, "db:subj:36828393");
        assert_eq!(queued[5].douban_ref, "db:subj:36964833");
        assert_eq!(queued[19].list, "movie_wom");
        assert_eq!(queued[19].douban_ref, "db:subj:37002986");

        // 3. 摘要: 前台不订阅(processDue 只在后台), 因此带那句后缀
        let logs = runtime.logs.clone().unwrap_or_default();
        let messages: Vec<&str> = logs.iter().map(|entry| entry.message.as_str()).collect();
        let summary = "榜单刷新完成：3 榜，新增订阅 0，待人工确认 0；订阅由后台任务处理";
        assert!(messages.contains(&summary), "实际日志: {messages:?}");

        // 4. 出站: 只有 3 次页面 GET(经 host broker), 且都带防盗链头
        let page_gets: Vec<crate::host::HostCallRequest> = stub
            .requests()
            .into_iter()
            .filter(|request| request.method == "GET" && request.path.starts_with("https://"))
            .collect();
        assert_eq!(page_gets.len(), 3, "实际: {page_gets:?}");
        assert!(page_gets[0]
            .path
            .starts_with("https://movie.douban.com/j/search_subjects?"));
        assert!(page_gets[1]
            .path
            .starts_with("https://movie.douban.com/chart"));
        assert!(page_gets[2]
            .path
            .starts_with("https://movie.douban.com/cinema/later/"));
        assert!(page_gets.iter().all(|request| {
            request.headers.get("referer").map(String::as_str) == Some("https://movie.douban.com/")
                && request.headers.get("user-agent").map(String::as_str) == Some(BROWSER_USER_AGENT)
        }));
    }

    /// 同成本的榜单键在平手时按字典序抓(Go 是随机序 + `SliceStable`; 见模块差异清单第 4 条)。
    #[test]
    fn fetch_enabled_lists_breaks_cost_ties_by_key_order() {
        let stub = ScriptedHttp::new();
        stub.route("/j/search_subjects", 200, SUBJECTS_JSON.to_vec());
        let _guard = stub.install();

        let mut runtime = Runtime::new();
        let mut lists = BTreeMap::new();
        for key in ["zz_wom", "aa_wom", "mm_wom"] {
            lists.insert(
                key.to_string(),
                ListConfig {
                    source: "subjects_json".into(),
                    kind: "movie".into(),
                    limit: 1,
                    enabled: true,
                    ..ListConfig::default()
                },
            );
        }
        let settings = Settings {
            lists: Some(lists),
            ..Settings::default()
        };

        let results = runtime.fetch_enabled_lists(&settings, ACTION_BUDGET_MS);
        let keys: Vec<&str> = results.iter().map(|result| result.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["aa_wom", "mm_wom", "zz_wom"],
            "同成本时按键序, 结果可复现"
        );
    }
}
