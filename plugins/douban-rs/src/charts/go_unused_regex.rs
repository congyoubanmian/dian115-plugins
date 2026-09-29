//! Go `main.go` 里 **定义后从未被调用**的 9 条 `regexp.MustCompile` —— 逐条 1:1 移植。
//!
//! 出生理由: 移植规范要求"Go 的 19 条正则 1:1 移植"。`main.go` 一共 19 处
//! `regexp.MustCompile`(含两处同形的局部 `space`), 其中有调用点的 9 条在
//! [`crate::charts`] 主区块, 这里放剩下的 9 条:
//!
//! | 本文件 | Go | 形态备注 |
//! |--------|----|----------|
//! | [`re_li`] | `main.go:514` `reLi` | |
//! | [`re_subj`] | `main.go:515` `reSubj` | 与 [`re_row_subj`] 逐字同形 |
//! | [`re_rate`] | `main.go:517` `reRate` | |
//! | [`re_title`] | `main.go:518` `reTitle` | |
//! | [`re_list_cont`] | `main.go:519` `reListCont` | [`crate::charts::section_after`] 的旧实现 |
//! | [`re_showing_soon`] | `main.go:524` `reShowingSoon` | `section_after` 的旧实现(贪婪到结尾) |
//! | [`re_row`] | `main.go:626` `reRow` | 旧版 `/later/` 表格行 |
//! | [`re_row_subj`] | `main.go:627` `reRowSubj` | 与 [`re_subj`] 逐字同形 |
//! | [`re_img`] | `main.go:673` `reImg` | 与 `crate::charts::re_item_img` 逐字同形 |
//!
//! Go 里这 9 条只被同样没被调用的 `extractPoster`(`main.go:675`)与旧版解析路径引用,
//! 因此当前没有调用点。保留它们是为了:
//!
//! 1. 与 Go 的 19 条一一对齐 —— 豆瓣换回旧模板时可以直接接线, 不用重抄模式;
//! 2. 让"捕获组是否与 Go 一致"这件事留一份可执行的证据(见本文件 `mod tests`,
//!    用例把真实夹具/最小片段喂进去, 逐条核对捕获组)。
//!
//! 成本: 零。函数从没被调用时 LTO(`opt-level="z"` + `lto=true`)会整段丢掉,
//! 连模式字符串都不进 wasm; `#[allow(dead_code)]` 只是让本机 `cargo build`
//! 不因这份刻意的对齐而报警告。
//!
//! 模式与 [`crate::charts`] 主区块同规则:`\d`/`\s` 在 Go 里是 **ASCII** 类, Rust regex
//! 默认是 Unicode 类, 因此写成 `[0-9]` / `[\t\n\f\r ]`(后者就是 Go `\s` 的定义, 不含 `\v`);
//! `(?s)` 内联标志两边同义。

#![allow(dead_code)]

use std::sync::OnceLock;

use regex::Regex;

macro_rules! go_regex {
    ($name:ident, $pattern:expr) => {
        #[allow(dead_code)]
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            CELL.get_or_init(|| Regex::new($pattern).expect("榜单正则编译失败"))
        }
    };
}

/// Go `main.go:514` `reLi`: `(?s)<li>(.*?)</li>`。
go_regex!(re_li, r"(?s)<li>(.*?)</li>");

/// Go `main.go:515` `reSubj`: `https://movie\.douban\.com/subject/(\d+)/"[^>]*>\s*([^<]{1,120}?)\s*</a>`。
go_regex!(
    re_subj,
    r#"https://movie\.douban\.com/subject/([0-9]+)/"[^>]*>[\t\n\f\r ]*([^<]{1,120}?)[\t\n\f\r ]*</a>"#
);

/// Go `main.go:517` `reRate`: `<span class="rating_nums">([\d.]+)</span>`。
go_regex!(re_rate, r#"<span class="rating_nums">([0-9.]+)</span>"#);

/// Go `main.go:518` `reTitle`: `<a[^>]*href="https://movie\.douban\.com/subject/(\d+)/"[^>]*>([^<]{1,120})</a>`。
go_regex!(
    re_title,
    r#"<a[^>]*href="https://movie\.douban\.com/subject/([0-9]+)/"[^>]*>([^<]{1,120})</a>"#
);

/// Go `main.go:519` `reListCont`: `(?s)id="listCont2"(.*?)</ul>`。
go_regex!(re_list_cont, r#"(?s)id="listCont2"(.*?)</ul>"#);

/// Go `main.go:524` `reShowingSoon`: `(?s)id="showing-soon"(.*)`(贪婪到文本结尾)。
go_regex!(re_showing_soon, r#"(?s)id="showing-soon"(.*)"#);

/// Go `main.go:626` `reRow`: `(?s)<tr>(.*?)</tr>`(旧版 `/later/` 表格)。
go_regex!(re_row, r"(?s)<tr>(.*?)</tr>");

/// Go `main.go:627` `reRowSubj`(与 [`re_subj`] 逐字同形)。
go_regex!(
    re_row_subj,
    r#"https://movie\.douban\.com/subject/([0-9]+)/"[^>]*>[\t\n\f\r ]*([^<]{1,120}?)[\t\n\f\r ]*</a>"#
);

/// Go `main.go:673` `reImg`: `<img[^>]+src="([^"]+)"`。
go_regex!(re_img, r#"<img[^>]+src="([^"]+)""#);

// ---------------------------------------------------------------------------
// 测试: 逐条对拍捕获组
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 口碑榜夹具(`https://movie.douban.com/chart`, 2026-09-29 实抓, 见
    /// `tests/fixtures/README.md`)。
    const CHART_HTML: &[u8] = include_bytes!("../../tests/fixtures/chart_listcont2.html");
    /// 即将上映夹具(`https://movie.douban.com/cinema/later/`)。
    const COMING_HTML: &[u8] = include_bytes!("../../tests/fixtures/coming_showing_soon.html");

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    /// 取某个捕获组在所有匹配里的值。
    ///
    /// 刻意不用 `caps[i]` 索引: regex 的 `Index<usize> for Captures<'_>` 返回的 `&str`
    /// 绑在 `&self` 上而不是 haystack 的生命周期上, 在 `.map(|c| c[1])` 这种"闭包持有
    /// 捕获对象"的写法里借用会活不过闭包体; `Match::as_str` 返回的才是 `&'h str`。
    fn groups(re: &Regex, haystack: &str, index: usize) -> Vec<String> {
        re.captures_iter(haystack)
            .map(|caps| caps.get(index).map(|m| m.as_str().to_string()).unwrap_or_default())
            .collect()
    }

    /// 旧版样式的**手工最小片段**(现在的豆瓣页面已经没有这套标签; 这里只做模式对拍)。
    /// 形态照抄 Go 时代的口碑榜: `<li>` 行里带 `<span class="rating_nums">`。
    const OLD_LI: &str = "<ul><li><a href=\"https://movie.douban.com/subject/1/\" class=\"\">甲</a>\
                          <span class=\"rating_nums\">8.7</span></li><li>乙</li></ul>";

    /// 旧版 `/later/` 表格的**手工最小片段**(每行一个 `<tr>`: 日期 / 片名链接 / 类型 / 地区 / 想看)。
    const OLD_TABLE: &str = "<table>\
        <tr><td>09月30日</td><td><a href=\"https://movie.douban.com/subject/36828393/\" class=\"title\">野兽之心</a></td>\
        <td>剧情</td><td>中国大陆</td><td>15177人想看</td></tr>\
        <tr><td>10月01日</td><td><a href=\"https://movie.douban.com/subject/12345678/\" class=\"title\">另一部片</a></td>\
        <td>喜剧</td><td>美国</td><td>1,024人想看</td></tr></table>";

    /// `reLi` 的惰性行匹配 + 两处调用点的形态(旧版页面才有 `<li>` 裸标签)。
    #[test]
    fn re_li_matches_go_capture_group() {
        let rows: Vec<&str> = re_li().find_iter(OLD_LI).map(|m| m.as_str()).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            "<li><a href=\"https://movie.douban.com/subject/1/\" class=\"\">甲</a>\
             <span class=\"rating_nums\">8.7</span></li>"
        );
        assert_eq!(rows[1], "<li>乙</li>");
        // 惰性: 每个 `<li>` 只吃到自己的 `</li>`
        let captures = groups(re_li(), OLD_LI, 1);
        assert_eq!(captures.len(), 2);
        assert!(captures[0].contains("rating_nums"));
        assert_eq!(captures[1], "乙");
        // 现在的 chart 页用 `<li class="clearfix">`, 裸 `<li>` 不再命中(所以 Go 才会写两份)
        assert_eq!(re_li().find_iter(&text(CHART_HTML)).count(), 0);
    }

    /// `reSubj`/`reRowSubj`(同形)在真实 chart 夹具上的捕获组:
    /// 去掉链接内外的空白, 取 subject id 与片名。
    #[test]
    fn re_subj_matches_go_capture_groups() {
        for regex in [re_subj(), re_row_subj()] {
            let got: Vec<(String, String)> = regex
                .captures_iter(&text(CHART_HTML))
                .map(|c| (c[1].to_string(), c[2].to_string()))
                .collect();
            assert_eq!(got.len(), 10);
            assert_eq!(got[0], ("35322132".to_string(), "罗斯".to_string()));
            assert_eq!(got[9], ("37002986".to_string(), "托尼".to_string()));
            // `([^<]{1,120}?)` 是惰性的, 尾随空白由 `\s*</a>` 吃掉
            assert!(got.iter().all(|(_, title)| title == title.trim()));
        }
        // 旧表格片段: id 与片名对得上
        assert_eq!(groups(re_row_subj(), OLD_TABLE, 1), vec!["36828393", "12345678"]);
        assert_eq!(groups(re_row_subj(), OLD_TABLE, 2), vec!["野兽之心", "另一部片"]);
    }

    /// `reRate` / `reTitle`: 旧版行内评分与标题链接(现在的 chart 页把评分搬走了)。
    #[test]
    fn re_rate_and_re_title_match_go_capture_groups() {
        let rated = groups(re_rate(), OLD_LI, 1);
        assert_eq!(rated, vec!["8.7"]);
        assert_eq!(re_rate().find_iter(&text(CHART_HTML)).count(), 0, "新页面没有 rating_nums");

        let titles: Vec<(String, String)> = re_title()
            .captures_iter(&text(CHART_HTML))
            .map(|c| (c[1].to_string(), c[2].to_string()))
            .collect();
        assert_eq!(titles.len(), 10);
        // `([^<]{1,120})` 是贪婪的且不吃 `<`: 首尾的换行/缩进原样留在捕获组里(Go 里由调用方 TrimSpace)
        assert_eq!(titles[0].0, "35322132");
        assert_eq!(titles[0].1.trim(), "罗斯");
        assert!(titles[0].1.starts_with('\n') && titles[0].1.ends_with(' '));
    }

    /// `reListCont` / `reShowingSoon`: 两个 `sectionAfter` 出现之前的旧版段落截取正则。
    #[test]
    fn re_list_cont_and_showing_soon_match_go_capture_groups() {
        let chart = text(CHART_HTML);
        let captures = re_list_cont().captures(&chart).expect("锚点存在");
        let segment = captures.get(1).expect("有捕获组").as_str();
        // 夹具是中文页面, `str::len()` 数的是 UTF-8 字节(与 Go 的 `len(string)` 同口径),
        // 字符数另记 —— 两者都钉住, 免得再把字符数当字节数用。
        assert_eq!(segment.len(), 3830, "从锚点后到 </ul> 之前的 UTF-8 字节数");
        assert_eq!(segment.chars().count(), 3736, "同一段落的字符数");
        assert!(segment.starts_with(">\n"));
        assert!(!segment.contains("</ul>"));
        assert_eq!(segment.matches("<li class=\"clearfix\">").count(), 10);

        let coming = text(COMING_HTML);
        let anchor = "id=\"showing-soon\"";
        let at = coming.find(anchor).expect("夹具里必须有锚点");
        let captures = re_showing_soon().captures(&coming).expect("锚点存在");
        let tail = captures.get(1).expect("有捕获组").as_str();
        // Go 的 `(.*)` 带 `(?s)` 且贪婪: 从锚点之后一路吃到文档结尾
        assert_eq!(tail, &coming[at + anchor.len()..]);
        assert_eq!(tail.len(), 6530, "锚点之后到文档结尾的 UTF-8 字节数");
        assert_eq!(tail.chars().count(), 6277, "同一段的字符数");
        assert!(tail.ends_with('\n'));
        assert_eq!(tail.matches("<div class=\"item mod").count(), 6);
    }

    /// `reRow` / `reImg`: 旧版表格行与图片地址。
    #[test]
    fn re_row_and_re_img_match_go_capture_groups() {
        let rows = groups(re_row(), OLD_TABLE, 1);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].contains("野兽之心"));
        assert!(rows[1].contains("另一部片"));

        let images = groups(re_img(), &text(COMING_HTML), 1);
        assert_eq!(images.len(), 6);
        assert_eq!(
            images[0],
            "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2935475988.jpg"
        );
        // 与有调用点的那条同形(`reItemImg`), 因此 chart 页(无图)不命中
        assert_eq!(re_img().find_iter(&text(CHART_HTML)).count(), 0);
    }
}
