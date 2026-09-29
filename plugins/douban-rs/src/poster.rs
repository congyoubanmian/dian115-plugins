//! 海报: 榜单条目的海报补齐(Go `main.go:770` `moviePoster` / `main.go:779` `suggestPoster` /
//! `main.go:801` `rexxarPoster`)、前端按需取图的 `get-poster` 动作
//! (Go `main.go:1819` `getPoster`)与 MIME 嗅探(Go `main.go:2181` `sniffImage`)。
//!
//! # 路 1(榜单与海报)的名下文件
//!
//! 本文件与 [`crate::charts`] 属于同一路: **并行阶段只填这两个文件里的函数体**。
//! 冻结文件(任何一路都不得修改): `lib.rs`、`runtime.rs`、`protocol.rs`、`host.rs`、
//! `store.rs`、`model.rs`、`raw.rs`、`util.rs`、`clock.rs`、`Cargo.toml`。
//! 另外两路的名下文件: 路 2 = `cookiecloud.rs` + `wish.rs`, 路 3 = `subscribe.rs`。
//!
//! # 已冻结的调用点
//!
//! - [`crate::charts::Runtime::fetch_chart`] → [`Runtime::movie_poster`](仅 `deep_refresh` 且
//!   未超过 [`crate::charts::POSTER_LOOKUP_LIMIT`])
//! - `runtime.rs::action` 的 `get-poster` → [`Runtime::get_poster`]
//! - 本文件内: `movie_poster` → `suggest_poster`(按标题查, 校验 id 一致)→ 失败回退
//!   `rexxar_poster`(按 subject id 精确取)
//!
//! # 实现要点(照抄时对照)
//!
//! - 出站 GET 一律用 [`Runtime::http_get`](`main.go:565`), 它已带豆瓣 Referer 与浏览器 UA
//!   (豆瓣图片 CDN 防盗链: 少 Referer 会 418)。
//! - `get-poster` 的 dataURL 用 **补 padding 的** base64(Go `base64.StdEncoding`,
//!   `main.go:1884`): `base64::engine::general_purpose::STANDARD`。这与出站请求体用的
//!   `RawStd`([`crate::host::encode_body_base64`])不是一回事, 别混。
//! - 缓存是 `self.poster_cache`(Go `runtime.posterCache`):
//!   只存内存、不落盘; 条目数超过 [`POSTER_CACHE_LIMIT`] 时**整表清空**再插入(Go
//!   `main.go:1887` 的 `len(...) > posterCacheLimit`)。
//! - 尺寸上限 [`MAX_POSTER_BYTES`]: 超限且 URL 含 `s_ratio_poster` 时换 `m_ratio_poster`
//!   小图重试, 仍超限就放弃 —— 宿主对 action 业务 JSON 有 256KiB 限额, base64 会膨胀 1.33 倍。
//! - 镜像域名回退顺序(`main.go:1837`): 原域名 → `img3` → `img1` → `img2` → `img4` →
//!   `img5` → `img6` → `img7` → `img8` → `img9`(已出现的域名不重复); 每个候选最多试 2 次,
//!   第二次前 `clock::sleep_ms(200)`。
//! - 失败文案(`main.go:1895`): `海报抓取失败: <最后一次原因>`, 原因是
//!   `HTTP <status>` / `非图片内容(mime=<mime>, <n>B)` / `海报过大 <n>B (上限 <n>B)`。
//! - Go 里 `posterURL(path)`(`main.go:1442`)与 `listLabel(key)`(`main.go:1449`)
//!   定义后从未被调用, 属于死代码, 不移植。
//!
//! # 本阶段(路 1)落地清单
//!
//! - `net/url.QueryEscape` / `PathEscape` 手写(依赖表里没有 `url` crate):
//!   查询串用 [`crate::charts::query_escape`], 路径段用本文件的 [`path_escape`]
//!   (Go 的 `encodePathSegment`: 放行 unreserved 与 `$&+:;=?@` 的子集, 其中
//!   `/ ; , ?` 转义)。
//! - `sniffImage` 逐字节照搬(含 PNG 分支只看 `data[1..4]`、不看 `data[0]` 的原样行为)。
//!
//! # 与 Go 的差异清单(本文件相关)
//!
//! 1. **`posterHostRe` 只编译一次**: Go 把 `regexp.MustCompile` 写在 `getPoster`
//!    函数体内(`main.go:1838`), 每次调用都重新编译; 这里用 `OnceLock` 缓存一份,
//!    行为(候选顺序、替换结果、`len(m) == 4` 判定)完全一致。
//! 2. **`url.PathEscape` 手写**(依赖表里没有 `url` crate): 按 Go 的
//!    `encodePathSegment` 规则放行 `A-Za-z0-9-_.~$&+:;=?@` 的子集(`/ ; , ?` 转义);
//!    subject id 是纯数字, 实际是恒等映射。
//! 3. **错误文案**: 与 Go 逐字一致(`HTTP <status>` / `非图片内容(mime=<mime>, <n>B)` /
//!    `海报过大 <n>B (上限 <n>B)`), 前缀 `海报抓取失败: `。
//! 4. `getPoster` 的输入取值、缓存命中、`s_ratio` → `m_ratio` 降级、每个候选 2 次
//!    尝试(第二次前 `sleep_ms(200)`)、`len(cache) > 64` 整表清空 —— 全部照搬。

use std::collections::BTreeSet;
use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::clock;
use crate::protocol::OpError;
use crate::runtime::Runtime;

/// 海报缓存条目上限(Go `main.go:28` `posterCacheLimit`)。
pub const POSTER_CACHE_LIMIT: usize = 64;
/// 单张海报字节上限(Go `main.go:30` `maxPosterBytes`): base64 后要留在宿主 256KiB 限额内。
pub const MAX_POSTER_BYTES: usize = 128 << 10;
/// 取图请求的 `accept`(Go `main.go:1860` 的字面量)。
pub const IMAGE_ACCEPT: &str = "image/avif,image/webp,image/jpeg,image/*;q=0.8";

/// `j/subject_suggest` 的单条(Go `main.go:785` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct SubjectSuggest {
    pub id: String,
    pub img: String,
}

/// rexxar `movie/<id>` 的响应(Go `main.go:807` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct RexxarMovie {
    pub pic: RexxarPic,
}

/// rexxar 响应里的图片字段(Go `main.go:808` 的匿名结构)。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct RexxarPic {
    pub normal: String,
}

/// Go `main.go:1838` 的函数内 `posterHostRe`: `(https?://)(img\d+)\.(doubanio\.com/)`。
///
/// `\d` 在 Go 里是 ASCII 类, 这里显式写 `[0-9]`(Rust regex 默认的 `\d` 是 Unicode 类)。
fn re_poster_host() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(r"(https?://)(img[0-9]+)\.(doubanio\.com/)").expect("海报域名正则编译失败")
    })
}

/// Go `net/url.PathEscape`(`main.go:802` 拼 rexxar 的 subject id)。
///
/// Go 的 `shouldEscape(c, encodePathSegment)`: 放行 `A-Za-z0-9-_.~` 与
/// `$ & + : = @`, 其余(含 `/ ; , ?`)一律 `%XX`。subject id 是纯数字,
/// 实际是恒等映射, 这里仍按规则实现以免日后换成别的形态。
fn path_escape(text: &str) -> String {
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

/// Go `main.go:2181` `sniffImage`: 轻量 MIME 嗅探, 只认海报场景的四种格式
/// (`image/jpeg` / `image/png` / `image/gif` / `image/webp`), 其余返回空串。
///
/// 不用 `http.DetectContentType` 的等价物, 理由与 Go 相同: 别把整条 HTTP 链进 wasm。
///
/// 分支顺序与原样行为都照搬: PNG 只看 `data[1..4]`(不校验首字节 `0x89`),
/// GIF 只要前三字节是 `GIF`, WebP 要求 `RIFF` + 第 9~12 字节 `WEBP` 且总长 >= 12。
pub fn sniff_image(data: &[u8]) -> &'static str {
    if data.len() >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
        return "image/jpeg";
    }
    if data.len() >= 4 && data[1] == b'P' && data[2] == b'N' && data[3] == b'G' {
        return "image/png";
    }
    if data.len() >= 3 && data[0] == b'G' && data[1] == b'I' && data[2] == b'F' {
        return "image/gif";
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return "image/webp";
    }
    ""
}

impl Runtime {
    /// Go `main.go:770` `moviePoster`: 先按标题搜(校验 id 一致), 再按 id 兜底;
    /// 两条路都失败返回空串(调用方保留空 `poster_url`, 前端再按需取图)。
    pub fn movie_poster(&self, title: &str, want_id: &str) -> String {
        let poster = self.suggest_poster(title, want_id);
        if !poster.is_empty() {
            return poster;
        }
        self.rexxar_poster(want_id)
    }

    /// Go `main.go:779` `suggestPoster`: `j/subject_suggest?q=<title>`,
    /// 只有返回条目 `id == want_id` 且 `img` 以 `http` 开头才采用(防止同名不同片错配)。
    pub fn suggest_poster(&self, title: &str, want_id: &str) -> String {
        let url = format!(
            "https://movie.douban.com/j/subject_suggest?q={}",
            crate::charts::query_escape(title)
        );
        let Ok((body, _status)) = self
            .http_get(&url, "application/json, text/plain;q=0.9")
            .into_result()
        else {
            return String::new();
        };
        // Go: `json.Unmarshal(body, &arr) != nil` → ""
        let Some(entries) = crate::model::decode::<Vec<SubjectSuggest>>(&body) else {
            return String::new();
        };
        for entry in entries {
            if entry.id == want_id && entry.img.starts_with("http") {
                return entry.img;
            }
        }
        String::new()
    }

    /// Go `main.go:801` `rexxarPoster`: `m.douban.com/rexxar/api/v2/movie/<id>`,
    /// 取 `pic.normal` 且必须以 `http` 开头。
    pub fn rexxar_poster(&self, subject_id: &str) -> String {
        let url = format!(
            "https://m.douban.com/rexxar/api/v2/movie/{}",
            path_escape(subject_id)
        );
        let Ok((body, _status)) = self
            .http_get(&url, "application/json, text/plain;q=0.9")
            .into_result()
        else {
            return String::new();
        };
        let Some(movie) = crate::model::decode::<RexxarMovie>(&body) else {
            return String::new();
        };
        if !movie.pic.normal.starts_with("http") {
            return String::new();
        }
        movie.pic.normal
    }

    /// Go `main.go:1819` `getPoster` —— action `get-poster` 的落地函数(已接线, 见
    /// `runtime.rs::action`)。返回 `{"status","url"}` 或 `{"status","message"}`:
    ///
    /// - 缺 `poster_url` → `缺少 poster_url`; 不是 `http(s)://` 开头 → `非法的海报地址`;
    /// - 命中 `self.poster_cache` → 直接返回缓存(不发起任何 host.call);
    /// - 抓取成功 → `{"status":"succeeded","url":"data:<mime>;base64,..."}`, 并写缓存。
    ///
    /// 输入取值用 [`crate::util::string_val`](Go 的 `stringVal`,`main.go:2085`)。
    pub fn get_poster(&mut self, input: &Map<String, Value>) -> Result<Value, OpError> {
        let poster_url = crate::util::string_val(input.get("poster_url")).trim().to_string();
        if poster_url.is_empty() {
            return Ok(json!({"status": "failed", "message": "缺少 poster_url"}));
        }
        if !poster_url.starts_with("https://") && !poster_url.starts_with("http://") {
            return Ok(json!({"status": "failed", "message": "非法的海报地址"}));
        }
        if let Some(cached) = self.poster_cache.get(&poster_url) {
            return Ok(json!({"status": "succeeded", "url": cached.clone()}));
        }

        // 豆瓣海报 CDN 是镜像集群: 同一图片可在 img1~img9.doubanio.com 任一域名访问。
        // 候选顺序: 原域名 → img3 → img1 → img2 → img4 → img5 → img6 → img7 → img8 → img9。
        let mut candidates: Vec<String> = vec![String::new()];
        if let Some(captures) = re_poster_host().captures(&poster_url) {
            let mut seen: BTreeSet<String> = BTreeSet::new();
            let current = captures.get(2).map(|m| m.as_str()).unwrap_or("");
            seen.insert(current.to_string());
            for alt in [
                "img3", "img1", "img2", "img4", "img5", "img6", "img7", "img8", "img9",
            ] {
                if !seen.contains(alt) {
                    candidates.push(alt.to_string());
                    seen.insert(alt.to_string());
                }
            }
        }

        let mut last_err = String::new();
        for alt in candidates {
            let url = if alt.is_empty() {
                poster_url.clone()
            } else {
                // Go: `posterHostRe.ReplaceAllString(posterURL, "${1}"+alt+".${3}")`
                re_poster_host()
                    .replace_all(&poster_url, format!("${{1}}{alt}.${{3}}"))
                    .into_owned()
            };
            // 单个候选做有限次重试, 容忍间歇性限流
            for attempt in 0..2 {
                if attempt > 0 {
                    clock::sleep_ms(200);
                }
                let got = self.http_get(&url, IMAGE_ACCEPT);
                if got.error.is_some() {
                    // Go: `lastErr = fmt.Sprintf("HTTP %d", status)`(host.call 失败时是 0)
                    last_err = format!("HTTP {}", got.status);
                    continue;
                }
                let mut body = got.body;
                let mut mime = sniff_image(&body);
                if !mime.starts_with("image/") {
                    last_err = format!("非图片内容(mime={mime}, {}B)", body.len());
                    continue;
                }
                // 宿主限制 action 业务 JSON 256KiB: data URL 经 base64 膨胀 1.33 倍,
                // 原图超过 128KiB 时降级到小尺寸变体, 仍超限则放弃。
                if body.len() > MAX_POSTER_BYTES && url.contains("s_ratio_poster") {
                    let small = url.replacen("s_ratio_poster", "m_ratio_poster", 1);
                    let fallback = self.http_get(&small, IMAGE_ACCEPT);
                    if fallback.error.is_none() && fallback.status < 400 {
                        let small_mime = sniff_image(&fallback.body);
                        if small_mime.starts_with("image/") && fallback.body.len() <= MAX_POSTER_BYTES
                        {
                            body = fallback.body;
                            mime = small_mime;
                        }
                    }
                }
                if body.len() > MAX_POSTER_BYTES {
                    last_err = format!("海报过大 {}B (上限 {}B)", body.len(), MAX_POSTER_BYTES);
                    continue;
                }
                let data_url = format!("data:{mime};base64,{}", STANDARD.encode(&body));
                // 缓存上限保护: 每张海报 data URL 可达上百 KB, 上限过大会把堆顶到内存硬限额。
                if self.poster_cache.len() > POSTER_CACHE_LIMIT {
                    self.poster_cache.clear();
                }
                self.poster_cache.insert(poster_url.clone(), data_url.clone());
                return Ok(json!({"status": "succeeded", "url": data_url}));
            }
        }
        Ok(json!({"status": "failed", "message": format!("海报抓取失败: {last_err}")}))
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::charts::testhttp::{Guard, ScriptedHttp};

    fn jpeg(size: usize) -> Vec<u8> {
        let mut body = vec![0u8; size];
        body[0] = 0xFF;
        body[1] = 0xD8;
        body[2] = 0xFF;
        body
    }

    fn poster_input(url: &str) -> Map<String, Value> {
        input_with(json!(url))
    }

    fn input_with(value: Value) -> Map<String, Value> {
        match json!({"poster_url": value}) {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn data_url_of(mime: &str, body: &[u8]) -> String {
        format!("data:{mime};base64,{}", STANDARD.encode(body))
    }

    /// 对拍 Go `sniffImage` 的四个分支(含 PNG 不校验首字节、WebP 长度门槛).
    #[test]
    fn sniff_image_matches_go_branches() {
        assert_eq!(sniff_image(&[]), "");
        assert_eq!(sniff_image(&[0xFF, 0xD8]), "", "长度不足 3");
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF]), "image/jpeg");
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), "image/jpeg");
        // Go 只看 data[1..4], 不校验 0x89
        assert_eq!(sniff_image(b"\x00PNG\r\n"), "image/png");
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(sniff_image(b"PNG"), "");
        assert_eq!(sniff_image(b"GIF89a"), "image/gif");
        assert_eq!(sniff_image(b"GIF"), "image/gif");
        assert_eq!(sniff_image(b"RIFF????WEBPVP8 "), "image/webp");
        assert_eq!(sniff_image(b"RIFF????WEB"), "", "长度不足 12");
        assert_eq!(sniff_image(b"RIFF????WEBx"), "");
        assert_eq!(sniff_image(b"WEBP????RIFF"), "");
        assert_eq!(sniff_image(b"<html>418 I'm a teapot</html>"), "");
        // jpeg 分支优先: 前 3 字节命中后不再看 PNG 分支
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, b'P', b'N', b'G']), "image/jpeg");
    }

    #[test]
    fn get_poster_validates_input_without_any_host_call() {
        let stub = ScriptedHttp::new();
        let _guard: Guard = stub.install();
        let mut runtime = Runtime::new();

        let result = runtime.get_poster(&Map::new()).expect("正常返回");
        assert_eq!(result["status"], "failed");
        assert_eq!(result["message"], "缺少 poster_url");

        // 只有空白也算缺
        let result = runtime.get_poster(&poster_input("   ")).expect("正常返回");
        assert_eq!(result["message"], "缺少 poster_url");

        for bad in ["/p2935475988.jpg", "img3.doubanio.com/x.jpg", "ftp://img3.doubanio.com/x.jpg"] {
            let result = runtime.get_poster(&poster_input(bad)).expect("正常返回");
            assert_eq!(result["message"], "非法的海报地址", "url={bad}");
        }
        // Go 的 stringVal: 非字符串走 fmt.Sprint → 42 变成 "42" → 非法地址
        let result = runtime.get_poster(&input_with(json!(42))).expect("正常返回");
        assert_eq!(result["message"], "非法的海报地址");
        assert!(stub.requests().is_empty(), "校验失败不该发起任何 host.call");
    }

    #[test]
    fn get_poster_builds_std_base64_data_url_and_caches_it() {
        let stub = ScriptedHttp::new();
        let body = jpeg(64);
        stub.route("img3.doubanio.com", 200, body.clone());
        let _guard = stub.install();
        let mut runtime = Runtime::new();

        let url = "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2935475988.jpg";
        let result = runtime.get_poster(&poster_input(url)).expect("正常返回");
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["url"], Value::String(data_url_of("image/jpeg", &body)));
        assert_eq!(stub.requests().len(), 1);
        assert_eq!(
            stub.requests()[0].headers.get("accept").map(String::as_str),
            Some(IMAGE_ACCEPT)
        );
        assert_eq!(
            stub.requests()[0].headers.get("referer").map(String::as_str),
            Some("https://movie.douban.com/")
        );

        // 第二次命中缓存: 不再发请求, 返回同一个 data URL
        let again = runtime.get_poster(&poster_input(url)).expect("正常返回");
        assert_eq!(again["url"], result["url"]);
        assert_eq!(stub.requests().len(), 1, "缓存命中不该再发 host.call");
    }

    /// 原域名返回非图片(拦截页) → 依次回退镜像域名(Go `main.go:1837` 起)。
    #[test]
    fn get_poster_falls_back_over_mirror_hosts() {
        let stub = ScriptedHttp::new();
        // 原域名(img9)的两次尝试都返回 HTML 拦截页
        stub.route("img9.doubanio.com", 200, b"<html>418</html>".to_vec());
        let body = jpeg(32);
        stub.route("img3.doubanio.com", 200, body.clone());
        let _guard = stub.install();
        let mut runtime = Runtime::new();

        let url = "https://img9.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg";
        let result = runtime.get_poster(&poster_input(url)).expect("正常返回");
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["url"], Value::String(data_url_of("image/jpeg", &body)));

        let urls: Vec<String> = stub.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(urls.len(), 3, "原域名试 2 次 + img3 命中 1 次");
        assert_eq!(urls[0], url);
        assert_eq!(urls[1], url);
        assert_eq!(
            urls[2],
            "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg",
            "候选顺序: 原域名 → img3"
        );
        assert_eq!(runtime.poster_cache.len(), 1);
    }

    /// 超过 128KiB 且 URL 含 `s_ratio_poster` → 换 `m_ratio_poster` 小图。
    #[test]
    fn get_poster_downgrades_to_m_ratio_when_too_large() {
        let stub = ScriptedHttp::new();
        stub.route("s_ratio_poster", 200, jpeg(MAX_POSTER_BYTES + 1));
        let small = jpeg(1024);
        stub.route("m_ratio_poster", 200, small.clone());
        let _guard = stub.install();
        let mut runtime = Runtime::new();

        let url = "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2.jpg";
        let result = runtime.get_poster(&poster_input(url)).expect("正常返回");
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["url"], Value::String(data_url_of("image/jpeg", &small)));

        let urls: Vec<String> = stub.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0], url);
        assert_eq!(
            urls[1],
            "https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2.jpg"
        );
    }

    /// 没有 `s_ratio_poster` 可降级 → 直接按 `海报过大` 失败(Go `main.go:1880` 起)。
    #[test]
    fn get_poster_reports_oversize_without_downgrade() {
        let stub = ScriptedHttp::new();
        stub.route("img.doubanio.com", 200, jpeg(MAX_POSTER_BYTES + 1));
        let _guard = stub.install();
        let mut runtime = Runtime::new();

        // 域名不含 imgN → 候选只有原地址(每个候选 2 次尝试)
        let url = "https://img.doubanio.com/view/photo/public/p3.jpg";
        let result = runtime.get_poster(&poster_input(url)).expect("正常返回");
        assert_eq!(result["status"], "failed");
        assert_eq!(
            result["message"],
            format!("海报抓取失败: 海报过大 {}B (上限 {}B)", MAX_POSTER_BYTES + 1, MAX_POSTER_BYTES)
        );
        assert_eq!(stub.requests().len(), 2);
    }

    /// 每个候选最多 2 次尝试, 第二次前 `sleep_ms(200)`; 全部失败后带回最后一次原因。
    #[test]
    fn get_poster_retries_each_candidate_twice() {
        let _ = clock::testhooks::take_sleeps(); // 清掉可能残留的记录
        let stub = ScriptedHttp::new();
        stub.route("img3.doubanio.com", 404, Vec::new());
        let _guard = stub.install();
        let mut runtime = Runtime::new();

        let result = runtime
            .get_poster(&poster_input("https://img3.doubanio.com/view/photo/public/p4.jpg"))
            .expect("正常返回");
        assert_eq!(result["status"], "failed");
        assert_eq!(result["message"], "海报抓取失败: HTTP 404");
        // 候选里 img3 被 current 去重, 只剩 img1/img2/img4..img9 各 2 次
        assert_eq!(stub.requests().len(), (1 + 8) * 2);
        assert_eq!(clock::testhooks::take_sleeps(), vec![200u64; 9]);

        // host.call 失败(status=0)时错误文案是 `HTTP 0`
        let stub2 = ScriptedHttp::new();
        stub2.fail_all("host_call 返回长度 0");
        let _guard2 = stub2.install();
        let result = runtime
            .get_poster(&poster_input("https://img.doubanio.com/x.jpg"))
            .expect("正常返回");
        assert_eq!(result["message"], "海报抓取失败: HTTP 0");
    }

    /// 缓存上限: Go 是 `len(cache) > 64` 时整表清空再插入。
    #[test]
    fn get_poster_clears_cache_only_when_over_limit() {
        let stub = ScriptedHttp::new();
        let body = jpeg(16);
        stub.route("img3.doubanio.com", 200, body.clone());
        let _guard = stub.install();

        let mut runtime = Runtime::new();
        for index in 0..POSTER_CACHE_LIMIT + 1 {
            runtime
                .poster_cache
                .insert(format!("https://img3.doubanio.com/cache/{index}.jpg"), "stale".to_string());
        }
        let url = "https://img3.doubanio.com/fresh.jpg";
        let result = runtime.get_poster(&poster_input(url)).expect("正常返回");
        assert_eq!(result["status"], "succeeded");
        assert_eq!(runtime.poster_cache.len(), 1, "65 > 64 → 整表清空后只留新条目");
        assert!(runtime.poster_cache.contains_key(url));

        // 恰好 64 条时不清理: 插入后 65 条
        let mut runtime2 = Runtime::new();
        for index in 0..POSTER_CACHE_LIMIT {
            runtime2
                .poster_cache
                .insert(format!("https://img3.doubanio.com/cache/{index}.jpg"), "stale".to_string());
        }
        let result = runtime2
            .get_poster(&poster_input("https://img3.doubanio.com/fresh2.jpg"))
            .expect("正常返回");
        assert_eq!(result["status"], "succeeded");
        assert_eq!(runtime2.poster_cache.len(), POSTER_CACHE_LIMIT + 1);
    }

    // ─────────────────────────── movie_poster / suggest / rexxar ───────────────────────────

    #[test]
    fn movie_poster_prefers_id_checked_suggest_then_rexxar() {
        let stub = ScriptedHttp::new();
        stub.route(
            "/j/subject_suggest",
            200,
            br#"[{"id":"111","img":"https://img1.doubanio.com/wrong.jpg"}]"#.to_vec(),
        );
        stub.route(
            "/rexxar/api/v2/movie/222",
            200,
            br#"{"pic":{"normal":"https://img2.doubanio.com/right.jpg"}}"#.to_vec(),
        );
        let _guard = stub.install();
        let runtime = Runtime::new();

        // suggest 里的 id 与目标不符 → 回退 rexxar
        assert_eq!(
            runtime.movie_poster("某片", "222"),
            "https://img2.doubanio.com/right.jpg"
        );
        let urls: Vec<String> = stub.requests().iter().map(|r| r.path.clone()).collect();
        assert_eq!(urls[0], "https://movie.douban.com/j/subject_suggest?q=%E6%9F%90%E7%89%87");
        assert_eq!(urls[1], "https://m.douban.com/rexxar/api/v2/movie/222");
    }

    #[test]
    fn suggest_poster_and_rexxar_poster_reject_bad_payloads() {
        let stub = ScriptedHttp::new();
        // 不是数组 → Go 的 Unmarshal 报错 → ""
        stub.route("/j/subject_suggest", 200, br#"{"id":"1"}"#.to_vec());
        // pic.normal 是相对路径 → ""
        stub.route("/rexxar/api/v2/movie/1", 200, br#"{"pic":{"normal":"/p1.jpg"}}"#.to_vec());
        let _guard = stub.install();
        let runtime = Runtime::new();

        assert_eq!(runtime.suggest_poster("某片", "1"), "");
        assert_eq!(runtime.rexxar_poster("1"), "");
        assert_eq!(runtime.movie_poster("某片", "1"), "");

        // 500 → httpGet 报错 → ""
        let stub2 = ScriptedHttp::new();
        stub2.route("/j/subject_suggest", 500, Vec::new());
        stub2.route("/rexxar/api/v2/movie/1", 500, Vec::new());
        let _guard2 = stub2.install();
        assert_eq!(runtime.suggest_poster("某片", "1"), "");
        assert_eq!(runtime.rexxar_poster("1"), "");
    }
}
