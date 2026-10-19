//! 薄封装: 生产代码在 `common::clock`, 本模块只做 re-export。
//!
//! 插件级测试保留在这里(依赖插件的 testkit / 前缀断言 / 业务语义)。

pub use common::clock::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_matches_go_formatting() {
        // 夹具里的真实时间戳(Go 写出来的形态)必须逐字节还原
        let cases: [(u64, &str); 6] = [
            (0, "1970-01-01T00:00:00Z"),
            (1_700_000_000_000_000_000, "2023-11-14T22:13:20Z"),
            (1_790_676_009_000_000_000, "2026-09-29T10:00:09Z"),
            (1_790_647_215_000_000_000, "2026-09-29T02:00:15Z"),
            (1_790_589_609_000_000_000, "2026-09-28T10:00:09Z"),
            (1_893_456_000_000_000_000, "2030-01-01T00:00:00Z"),
        ];
        for (nanos, want) in cases {
            assert_eq!(rfc3339(nanos), want, "nanos={nanos}");
        }
    }

    #[test]
    fn rfc3339_handles_leap_day_and_year_boundary() {
        // 2024-02-29(闰日) 与跨年
        assert_eq!(rfc3339(1_709_164_800_000_000_000), "2024-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_735_689_599_000_000_000), "2024-12-31T23:59:59Z");
        assert_eq!(rfc3339(1_735_689_600_000_000_000), "2025-01-01T00:00:00Z");
        // 2100 不是闰年(百年例外)
        assert_eq!(rfc3339(4_107_542_400_000_000_000), "2100-03-01T00:00:00Z");
    }

    #[test]
    fn month_matches_go_layout() {
        assert_eq!(month_of(1_790_676_009_000_000_000), "2026-09");
        assert_eq!(month_of(0), "1970-01");
        assert_eq!(month_of(1_709_164_800_000_000_000), "2024-02");
    }

    /// Go `time.Parse(time.RFC3339, ...)`: 插件写出来的形态必须逐字节往返。
    #[test]
    fn parse_rfc3339_round_trips_plugin_timestamps() {
        let cases: [(u64, &str); 7] = [
            (0, "1970-01-01T00:00:00Z"),
            (1_700_000_000_000_000_000, "2023-11-14T22:13:20Z"),
            (1_790_676_009_000_000_000, "2026-09-29T10:00:09Z"),
            (1_790_647_215_000_000_000, "2026-09-29T02:00:15Z"),
            (1_790_589_609_000_000_000, "2026-09-28T10:00:09Z"),
            (1_709_164_800_000_000_000, "2024-02-29T00:00:00Z"),
            (1_735_689_600_000_000_000, "2025-01-01T00:00:00Z"),
        ];
        for (nanos, text) in cases {
            assert_eq!(parse_rfc3339(text), Some(nanos), "text={text}");
            assert_eq!(rfc3339(parse_rfc3339(text).unwrap()), text, "往返: {text}");
        }
    }

    #[test]
    fn parse_rfc3339_accepts_offsets_and_fractions() {
        // 偏移量换算成 UTC
        assert_eq!(
            parse_rfc3339("2026-09-29T18:00:09+08:00"),
            Some(1_790_676_009_000_000_000)
        );
        assert_eq!(
            parse_rfc3339("2026-09-29T02:00:09-08:00"),
            Some(1_790_676_009_000_000_000)
        );
        // 小数秒(截断到纳秒)
        assert_eq!(
            parse_rfc3339("2026-09-29T10:00:09.5Z"),
            Some(1_790_676_009_500_000_000)
        );
        assert_eq!(
            parse_rfc3339("2026-09-29T10:00:09.000Z"),
            Some(1_790_676_009_000_000_000)
        );
    }

    /// 非法输入必须返回 `None`(Go 的 `err != nil`), 不许 panic。
    #[test]
    fn parse_rfc3339_rejects_garbage() {
        let cases: [&str; 12] = [
            "",
            "not a time",
            "2026-09-29",
            "2026-09-29T10:00:09",  // 缺时区
            "2026-09-29 10:00:09Z", // 日期与时间之间必须是 T
            "2026-13-29T10:00:09Z", // 月份越界
            "2026-02-30T10:00:09Z", // 2 月没有 30 号
            "2025-02-29T10:00:09Z", // 平年 2 月没有 29 号
            "2026-09-29T24:00:09Z", // 小时越界
            "2026-09-29T10:60:09Z", // 分钟越界
            "2026-09-29T10:00:09X", // 非法时区
            "1969-12-31T23:59:59Z", // 1970 之前(本插件不会写出来)
        ];
        for text in cases {
            assert!(parse_rfc3339(text).is_none(), "不该解出来: {text:?}");
        }
    }

    #[test]
    fn base36_matches_strconv() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        // Go: strconv.FormatInt(1790676009000000000, 36)
        assert_eq!(base36(1_790_676_009_000_000_000), "dlrpo22a54w0");
    }

    #[test]
    fn session_nonce_is_stable_and_base36() {
        let first = session_nonce().to_string();
        assert_eq!(first, session_nonce(), "同一会话内必须稳定");
        assert!(!first.is_empty());
        assert!(first
            .bytes()
            .all(|b: u8| b.is_ascii_digit() || b.is_ascii_lowercase()));
    }

    #[test]
    fn fixed_clock_drives_now() {
        testhooks::set_now(Some(1_790_676_009_000_000_000));
        assert_eq!(now_rfc3339(), "2026-09-29T10:00:09Z");
        assert_eq!(current_month(), "2026-09");
        testhooks::set_now(None);
        assert_eq!(rfc3339(now_unix_nanos()).len(), RFC3339_EXAMPLE.len());
    }

    #[test]
    fn sleeps_are_recorded_not_real() {
        let _ = testhooks::take_sleeps();
        sleep_ms(300);
        sleep_ms(200);
        assert_eq!(testhooks::take_sleeps(), vec![300, 200]);
        assert!(testhooks::take_sleeps().is_empty(), "取走即清空");
    }
}
