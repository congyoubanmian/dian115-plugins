//! 薄封装: 生产代码在 `common::clock`, 本模块只做 re-export。
//!
//! 插件级测试保留在这里(依赖插件的 testkit / 前缀断言 / 业务语义)。

pub use common::clock::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_nonce_is_stable_within_the_session() {
        let first = session_nonce();
        assert_eq!(first, session_nonce(), "同一会话必须复用同一个前缀");
        assert!(!first.is_empty());
        assert!(
            first.bytes().all(|b| b.is_ascii_alphanumeric()),
            "base36: {first}"
        );
    }

    #[test]
    fn base36_matches_go_format_int() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        // Go: strconv.FormatInt(1_700_000_000_000_000_000, 36) == "cwyvpelgpse8"
        // (对照值用 Python 的同一进制换算独立复算过)
        assert_eq!(base36(1_700_000_000_000_000_000), "cwyvpelgpse8");
    }

    #[test]
    fn sleeps_are_recorded_not_taken_on_native() {
        let _ = testhooks::take_sleeps();
        sleep_ms(300);
        sleep_ms(200);
        assert_eq!(testhooks::take_sleeps(), vec![300, 200]);
    }

    #[test]
    fn fixed_now_overrides_the_wall_clock() {
        testhooks::set_now(Some(1_700_000_000_000_000_000));
        assert_eq!(now_unix_nanos(), 1_700_000_000_000_000_000);
        assert_eq!(now_unix_secs(), 1_700_000_000);
        // Go: time.Unix(1_700_000_000, 0).UTC().Format(time.RFC3339) == "2023-11-14T22:13:20Z"
        assert_eq!(now_rfc3339(), "2023-11-14T22:13:20Z");
        assert_eq!(local_hour(0), 22);
        assert_eq!(local_date(0), "2023-11-14");
        // +08:00 → 次日 06:13:20
        assert_eq!(local_hour(480), 6);
        assert_eq!(local_date(480), "2023-11-15");
        // -05:00 → 同日 17:13:20
        assert_eq!(local_hour(-300), 17);
        assert_eq!(local_date(-300), "2023-11-14");
        testhooks::set_now(None);
    }

    #[test]
    fn civil_roundtrip_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(days_from_civil(2024, 1, 1), 19_723);
        // 闰日: 2024-02-29 存在, 2023-02-29 归一化到 03-01(纯天数运算)
        assert_eq!(date_from_days(days_from_civil(2024, 2, 29)), "2024-02-29");
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn date_arithmetic_and_normalization() {
        assert_eq!(
            date_plus_days("2026-10-01", 7).as_deref(),
            Some("2026-10-08")
        );
        assert_eq!(
            date_plus_days("2026-12-31", 1).as_deref(),
            Some("2027-01-01")
        );
        assert_eq!(date_plus_days("not-a-date", 1), None);
        assert_eq!(date_plus_days("2026-13-01", 1), None);

        assert_eq!(normalize_date("2026-10-01").as_deref(), Some("2026-10-01"));
        assert_eq!(
            normalize_date("2026-10-01T12:00:00Z").as_deref(),
            Some("2026-10-01")
        );
        assert_eq!(
            normalize_date("2026-10-01 12:00").as_deref(),
            Some("2026-10-01")
        );
        assert_eq!(normalize_date("2026/10/01").as_deref(), Some("2026-10-01"));
        assert_eq!(normalize_date("10月1日"), None);
        assert_eq!(normalize_date(""), None);
        assert_eq!(parse_date_days("2026-10-1"), None, "长度不足必须拒绝");
    }

    #[test]
    fn rfc3339_parsing_inverts_formatting() {
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_secs("2023-11-14T22:13:20Z"),
            Some(1_700_000_000)
        );
        for seconds in [0_i64, 1, 59, 3_600, 86_399, 1_700_000_000, 1_790_000_000] {
            assert_eq!(
                parse_rfc3339_secs(&rfc3339_from_unix(seconds)),
                Some(seconds)
            );
        }
        // 带偏移的形态
        assert_eq!(
            parse_rfc3339_secs("2023-11-15T06:13:20+08:00"),
            Some(1_700_000_000)
        );
        assert_eq!(
            parse_rfc3339_secs("2023-11-14T17:13:20-05:00"),
            Some(1_700_000_000)
        );
        // 认不出 → None(调用方必须当作不新鲜)
        assert_eq!(parse_rfc3339_secs(""), None);
        assert_eq!(parse_rfc3339_secs("2023-11-14"), None);
        assert_eq!(parse_rfc3339_secs("2023-11-14 22:13:20"), None);
        assert_eq!(parse_rfc3339_secs("2023-11-14T25:13:20Z"), None);
        assert_eq!(parse_rfc3339_secs("not a time at all"), None);
        assert_eq!(parse_rfc3339_secs("2023-13-14T22:13:20Z"), None);
    }
}
