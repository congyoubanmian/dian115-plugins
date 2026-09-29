//! 墙钟时间与休眠(对照 Go `time.Now()` / `time.Sleep()`)。
//!
//! # 为什么需要 WASI
//!
//! `wasm32-unknown-unknown` 的 std **没有**时间实现(`SystemTime::now()` 直接 panic),
//! 而 Go 版是 wasip1, `time.Now()`/`time.Sleep()` 全都能用 —— 状态文档里的
//! `entered_at`/`due_at`/`fetched_at`、观察期 24h、cookie 缓存 45min TTL 都依赖真实时钟。
//! 生产插件(Go)的 wasm 导入段里有 `wasi_snapshot_preview1.clock_time_get` 与
//! `poll_oneoff`(见 `runtime/plugin.wasm` 的 import 段), 说明宿主必然提供这两个函数;
//! 本模块就用它们取当前时间 / 休眠, 与 Go 走的是同一套宿主能力。
//!
//! 失败时(宿主返回非 0 errno)退化为 0 纳秒 = `1970-01-01T00:00:00Z`, 不 panic。
//!
//! # 本机(cargo test)
//!
//! native 构建只服务测试: 时间可用 `set_test_now` 固定(让 diag 面包屑的 `at` 可断言),
//! 休眠只记录不真睡, 用例不受 300ms/200ms 重试间隔拖慢。

use std::sync::OnceLock;

/// Go `time.RFC3339` 在本插件里的实际形态: UTC, 秒级精度, 例如 `2026-09-29T10:00:09Z`。
pub const RFC3339_EXAMPLE: &str = "2026-09-29T10:00:09Z";

/// 当前 UTC 时间(Unix 纳秒)。
pub fn now_unix_nanos() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        wasi_realtime_nanos().unwrap_or(0)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        #[cfg(test)]
        {
            if let Some(fixed) = testhooks::now() {
                return fixed;
            }
        }
        match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(since_epoch) => since_epoch.as_nanos() as u64,
            Err(_) => 0,
        }
    }
}

/// `now_unix_nanos()` 的 RFC3339(UTC) 文本, 对应 Go `r.now()`。
pub fn now_rfc3339() -> String {
    rfc3339(now_unix_nanos())
}

/// 把 Unix 纳秒格式化成 Go `time.Time.Format(time.RFC3339)` 的 UTC 形式。
pub fn rfc3339(nanos: u64) -> String {
    let (year, month, day, hour, minute, second) = civil_from_unix_nanos(nanos);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// 当前月份, 对应 Go `time.Now().Format("2006-01")`(统计口径)。
pub fn current_month() -> String {
    month_of(now_unix_nanos())
}

/// 把 Unix 纳秒格式化成 `2006-01` 形式的月份。
pub fn month_of(nanos: u64) -> String {
    let (year, month, ..) = civil_from_unix_nanos(nanos);
    format!("{year:04}-{month:02}")
}

/// Go `time.Parse(time.RFC3339, s)` 的等价物(只认本插件自己写出来的形态)。
///
/// 接受 `YYYY-MM-DDTHH:MM:SS` + 时区(`Z` / `±HH:MM`)+ 可选小数秒, 返回 Unix 纳秒。
/// 下面是 Go 里用到解析的两处, 都依赖它:
/// - `wish.go:52` `cookieCacheFresh`(45 分钟 TTL 的新鲜度判定);
/// - `main.go:1340` `processDue`(到期判定: 解不出来就当作已到期, 与 Go 一致)。
///
/// 非法输入返回 `None`(Go 的 `err != nil`), 不 panic。
pub fn parse_rfc3339(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year = parse_digits(bytes, 0, 4)? as i64;
    let month = parse_digits(bytes, 5, 2)?;
    let day = parse_digits(bytes, 8, 2)?;
    let hour = parse_digits(bytes, 11, 2)?;
    let minute = parse_digits(bytes, 14, 2)?;
    let second = parse_digits(bytes, 17, 2)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // 可选小数秒(RFC3339 里在秒之后、时区之前): 截断到纳秒(Go 也保留纳秒精度)
    let mut index = 19;
    let mut nanos = 0u64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return None;
        }
        let mut scale = 100_000_000u64;
        for digit in &bytes[start..index] {
            if scale == 0 {
                break; // 超过 9 位直接丢弃
            }
            nanos += u64::from(*digit - b'0') * scale;
            scale /= 10;
        }
    }
    // 时区: `Z` 或 `±HH:MM`(Go 的 RFC3339 布局里这是必需的一部分)
    let mut offset_seconds = 0i64;
    match bytes.get(index)? {
        b'Z' | b'z' => index += 1,
        b'+' | b'-' => {
            let sign = if bytes[index] == b'-' { -1i64 } else { 1 };
            if bytes.get(index + 3)? != &b':' {
                return None;
            }
            let offset_hour = parse_digits(bytes, index + 1, 2)? as i64;
            let offset_minute = parse_digits(bytes, index + 4, 2)? as i64;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            offset_seconds = sign * (offset_hour * 3600 + offset_minute * 60);
            index += 6;
        }
        _ => return None,
    }
    if index != bytes.len() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64
        - offset_seconds;
    if seconds < 0 {
        return None; // 1970 之前(本插件不会写出来)
    }
    Some(seconds as u64 * 1_000_000_000 + nanos)
}

/// 定长数字字段: 全部是 ASCII 数字才算数。
fn parse_digits(bytes: &[u8], start: usize, len: usize) -> Option<u32> {
    let field = bytes.get(start..start + len)?;
    let mut value = 0u32;
    for byte in field {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u32::from(byte - b'0');
    }
    Some(value)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// [`civil_from_days`] 的逆运算(Howard Hinnant `days_from_civil`)。
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400; // [0, 399]
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + day as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// 会话幂等键前缀, 对应 Go `wasm.go:18` 的
/// `strconv.FormatInt(time.Now().UnixNano(), 36)`。
///
/// 用途: 宿主保留 24h 的幂等记录。worker 重启后进程内计数会从头开始, 若幂等键
/// 里不含会话唯一值, 新会话会与上一会话撞出同一个 key + 不同指纹 → 宿主回
/// 412 `idempotency_conflict`。因此每次会话都要有一个新的随机前缀。
pub fn session_nonce() -> &'static str {
    static NONCE: OnceLock<String> = OnceLock::new();
    NONCE.get_or_init(|| base36(now_unix_nanos()))
}

/// 休眠 `ms` 毫秒(Go `time.Sleep`)。
///
/// 用于 `loadStateWithRetry` 的重试间隔与 404 两次确认窗口 —— 宿主重启风暴期间
/// 单次 404 不代表全新安装, 必须隔一段时间再确认一次。
pub fn sleep_ms(ms: u64) {
    #[cfg(target_arch = "wasm32")]
    {
        wasi_sleep_nanos(ms.saturating_mul(1_000_000));
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        #[cfg(test)]
        testhooks::record_sleep(ms);
        // native 构建只服务 `cargo test`: 真睡只会拖慢用例, 时序语义只在 wasm 上有意义。
        let _ = ms;
    }
}

// ─────────────────────────── 日历换算 ───────────────────────────

/// `(year, month, day, hour, minute, second)`, 全部 UTC。
fn civil_from_unix_nanos(nanos: u64) -> (i64, u32, u32, u32, u32, u32) {
    let secs = (nanos / 1_000_000_000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = (rem / 3_600) as u32;
    let minute = ((rem % 3_600) / 60) as u32;
    let second = (rem % 60) as u32;
    (year, month, day, hour, minute, second)
}

/// Howard Hinnant 的 `civil_from_days`: 把"1970-01-01 起的天数"换算成公历年月日。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Go `strconv.FormatInt(v, 36)` 的小写 base36。
fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut buf = Vec::with_capacity(13);
    while value > 0 {
        buf.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap_or_else(|_| "0".to_string())
}

// ─────────────────────────── 宿主(WASI) ───────────────────────────

/// WASI `clock_time_get(id=realtime)`。
///
/// 与 Go wasip1 运行时调用的是同一个导入(`runtime/plugin.wasm` 的 import 段里就有它)。
#[cfg(target_arch = "wasm32")]
fn wasi_realtime_nanos() -> Option<u64> {
    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    extern "C" {
        fn clock_time_get(id: u32, precision: u64, out: *mut u64) -> u32;
    }
    const CLOCKID_REALTIME: u32 = 0;
    let mut out: u64 = 0;
    // 精度 1ms: 我们只用到秒级, 但要的是"真实时间"而不是"允许晚到"。
    let errno = unsafe { clock_time_get(CLOCKID_REALTIME, 1_000_000, &mut out) };
    if errno == 0 {
        Some(out)
    } else {
        None
    }
}

/// WASI `poll_oneoff` 的相对时钟订阅 —— 即 wasip1 上 Go `time.Sleep` 的等价物。
///
/// 布局(subscription_t, 48 字节, 对齐 8):
/// `userdata:u64 @0`, `tag:u8 @8`(0=clock), `clock.id:u32 @16`,
/// `clock.timeout:u64 @24`, `clock.precision:u64 @32`, `clock.flags:u16 @40`(0=相对时间)。
/// 宿主若返回非 0 errno(不支持时钟订阅), 就当作"不睡", 不 panic。
#[cfg(target_arch = "wasm32")]
fn wasi_sleep_nanos(timeout_nanos: u64) {
    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    extern "C" {
        fn poll_oneoff(
            subscriptions: *const u8,
            events: *mut u8,
            nsubscriptions: u32,
            nevents: *mut u32,
        ) -> u32;
    }
    let mut subscription = [0u8; 48];
    subscription[8] = 0; // tag = subscription_clock
    subscription[16..20].copy_from_slice(&0u32.to_le_bytes()); // id = realtime
    subscription[24..32].copy_from_slice(&timeout_nanos.to_le_bytes());
    subscription[32..40].copy_from_slice(&1u64.to_le_bytes()); // precision = 1ns
    subscription[40..42].copy_from_slice(&0u16.to_le_bytes()); // flags = 0 → 相对时间
    let mut events = [0u8; 32];
    let mut nevents: u32 = 0;
    let _ = unsafe { poll_oneoff(subscription.as_ptr(), events.as_mut_ptr(), 1, &mut nevents) };
}

// ─────────────────────────── 测试钩子 ───────────────────────────

/// 本机测试专用: 固定"现在"的时间点 + 记录 `sleep_ms` 的调用序列。
#[cfg(test)]
pub(crate) mod testhooks {
    use std::cell::{Cell, RefCell};

    thread_local! {
        static FIXED_NOW: Cell<Option<u64>> = const { Cell::new(None) };
        static SLEEPS: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
    }

    /// 固定当前时间(纳秒), `None` 恢复真实时钟。
    pub(crate) fn set_now(nanos: Option<u64>) {
        FIXED_NOW.with(|cell| cell.set(nanos));
    }

    pub(crate) fn now() -> Option<u64> {
        FIXED_NOW.with(Cell::get)
    }

    pub(crate) fn record_sleep(ms: u64) {
        SLEEPS.with(|sleeps| sleeps.borrow_mut().push(ms));
    }

    /// 取走并清空已记录的休眠序列。
    pub(crate) fn take_sleeps() -> Vec<u64> {
        SLEEPS.with(|sleeps| std::mem::take(&mut *sleeps.borrow_mut()))
    }
}

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
        assert_eq!(parse_rfc3339("2026-09-29T10:00:09.000Z"), Some(1_790_676_009_000_000_000));
    }

    /// 非法输入必须返回 `None`(Go 的 `err != nil`), 不许 panic。
    #[test]
    fn parse_rfc3339_rejects_garbage() {
        let cases: [&str; 12] = [
            "",
            "not a time",
            "2026-09-29",
            "2026-09-29T10:00:09",   // 缺时区
            "2026-09-29 10:00:09Z",  // 日期与时间之间必须是 T
            "2026-13-29T10:00:09Z",  // 月份越界
            "2026-02-30T10:00:09Z",  // 2 月没有 30 号
            "2025-02-29T10:00:09Z",  // 平年 2 月没有 29 号
            "2026-09-29T24:00:09Z",  // 小时越界
            "2026-09-29T10:60:09Z",  // 分钟越界
            "2026-09-29T10:00:09X",  // 非法时区
            "1969-12-31T23:59:59Z",  // 1970 之前(本插件不会写出来)
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
        assert!(first.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'z').contains(&b)));
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
