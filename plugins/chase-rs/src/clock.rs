//! 墙钟时间、日历换算与休眠(对照 Go `time.Now()` / `time.Sleep()`)。
//!
//! 从 douban-rs 的 `clock.rs` 裁剪并补回业务需要的一小块:
//!
//! - [`session_nonce`] 幂等键的会话前缀, [`sleep_ms`] 存储重试间隔(骨架已有);
//! - [`now_rfc3339`] 状态文档里的时间戳(`align.items[].at` / `daily.last_at`);
//! - [`local_date`] / [`local_hour`] 日报的"本地自然日"判定(`settings.report.tz_offset_minutes`);
//! - [`date_plus_days`] / [`normalize_date`] 追剧日历的 8 天窗口与日期归一。
//!
//! 日历换算用 Howard Hinnant 的 `civil_from_days` / `days_from_civil`(纯整数算法,
//! 不依赖任何时区库 —— wasm 里也没有 `chrono`)。全部是 UTC 秒 + 固定分钟偏移, 因此
//! DST 不参与: 日报的"本地小时"是用户显式配置的固定偏移, 这是有意的。
//!
//! # 为什么需要 WASI
//!
//! `wasm32-unknown-unknown` 的 std **没有**时间实现(`SystemTime::now()` 直接 panic),
//! 而生产宿主提供 wasip1 的 `clock_time_get` / `poll_oneoff`(douban-rs 的
//! `runtime/plugin.wasm` 导入段里就有这两个函数)。本模块用它们取时间 / 休眠。
//! 失败时(宿主返回非 0 errno)退化为 0 纳秒, 不 panic。
//!
//! # 本机(cargo test)
//!
//! native 构建只服务测试: 时间可用 [`testhooks::set_now`] 固定, 休眠只记录不真睡 ——
//! 否则存储层的 300ms/200ms 重试会把用例拖慢。

use std::sync::OnceLock;

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

/// 会话幂等键前缀, 对应 Go `wasm.go:18` 的
/// `strconv.FormatInt(time.Now().UnixNano(), 36)`。
///
/// 用途: 宿主保留 24h 的幂等记录。worker 重启后进程内计数会从头开始, 若幂等键里不含
/// 会话唯一值, 新会话会与上一会话撞出同一个 key + 不同指纹 → 宿主回 412
/// `idempotency_conflict`。因此每次会话都要有一个新的前缀。
pub fn session_nonce() -> &'static str {
    static NONCE: OnceLock<String> = OnceLock::new();
    NONCE.get_or_init(|| base36(now_unix_nanos()))
}

/// 休眠 `ms` 毫秒(Go `time.Sleep`)。
///
/// 用于存储层 `load_state_with_retry` 的重试间隔与 404 两次确认窗口 —— 宿主重启风暴
/// 期间单次 404 不代表全新安装, 必须隔一段时间再确认一次。
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

/// 当前 Unix 秒(负数按 0 处理: 时钟未同步时不让日期换算落到 1969 年)。
pub fn now_unix_secs() -> i64 {
    (now_unix_nanos() / 1_000_000_000) as i64
}

/// 当前 UTC 时间的 RFC3339 文本(`2026-10-01T12:34:56Z`, 秒级)。
///
/// 状态文档里的所有 `at` / `last_run` 字段都用它 —— 与宿主其余时间字段同形。
pub fn now_rfc3339() -> String {
    rfc3339_from_unix(now_unix_secs())
}

/// Unix 秒 → RFC3339(UTC)。
pub fn rfc3339_from_unix(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// RFC3339 文本 → Unix 秒(`now_rfc3339` 的逆运算, 用于判断缓存是否还在新鲜窗口内)。
///
/// 只吃自家格式(`YYYY-MM-DDTHH:MM:SS[Z|±HH:MM]`, 秒级); 认不出返回 `None` ——
/// "算不出时间差"必须当作**不新鲜**(调用方不能把未知当新鲜用)。
pub fn parse_rfc3339_secs(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    // 最短形态 "1970-01-01T00:00:00Z" = 20 字节
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year = parse_fixed_u32(&bytes[0..4])? as i64;
    let month = parse_fixed_u32(&bytes[5..7])?;
    let day = parse_fixed_u32(&bytes[8..10])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let hour = parse_fixed_u32(&bytes[11..13])? as i64;
    let minute = parse_fixed_u32(&bytes[14..16])? as i64;
    let second = parse_fixed_u32(&bytes[17..19])? as i64;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;

    // 时区后缀: Z / 空(按 UTC, 与自家格式一致) / ±HH:MM
    let rest = &bytes[19..];
    if rest.len() >= 6 && (rest[0] == b'+' || rest[0] == b'-') && rest[3] == b':' {
        let offset_hour = parse_fixed_u32(&rest[1..3])? as i64;
        let offset_minute = parse_fixed_u32(&rest[4..6])? as i64;
        let offset = offset_hour * 3600 + offset_minute * 60;
        if rest[0] == b'+' {
            seconds -= offset;
        } else {
            seconds += offset;
        }
    }
    Some(seconds)
}

/// 天数 → (年, 月, 日)。Howard Hinnant `civil_from_days`, 以 1970-01-01 为第 0 天。
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (年, 月, 日) → 天数。Howard Hinnant `days_from_civil`。
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + day as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// 带偏移的"本地"天数与秒内时刻。
fn local_parts(offset_minutes: i32) -> (i64, i64) {
    let shifted = now_unix_secs() + i64::from(offset_minutes) * 60;
    (shifted.div_euclid(86_400), shifted.rem_euclid(86_400))
}

/// 本地日期(`YYYY-MM-DD`), 偏移取自 `settings.report.tz_offset_minutes`。
pub fn local_date(offset_minutes: i32) -> String {
    let (days, _) = local_parts(offset_minutes);
    date_from_days(days)
}

/// 本地小时(0-23)。
pub fn local_hour(offset_minutes: i32) -> u8 {
    let (_, seconds) = local_parts(offset_minutes);
    (seconds / 3600) as u8
}

/// 天数 → `YYYY-MM-DD`。
pub fn date_from_days(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 日期加减天数; 输入不是 `YYYY-MM-DD` 时返回 `None`(不猜)。
pub fn date_plus_days(date: &str, delta: i64) -> Option<String> {
    let days = parse_date_days(date)?;
    Some(date_from_days(days + delta))
}

/// `YYYY-MM-DD` → 天数; 非法输入(长度/分隔/范围)返回 `None`。
pub fn parse_date_days(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = parse_fixed_u32(&bytes[0..4])? as i64;
    let month = parse_fixed_u32(&bytes[5..7])?;
    let day = parse_fixed_u32(&bytes[8..10])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn parse_fixed_u32(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut value = 0u32;
    for byte in bytes {
        value = value.checked_mul(10)?.checked_add(u32::from(byte - b'0'))?;
    }
    Some(value)
}

/// 把任意日期文本归一成 `YYYY-MM-DD`(取前 10 字符并校验), 认不出返回 `None`。
///
/// 宿主日历可能给 `2026-10-01` / `2026-10-01T12:00:00Z` / `2026-10-01 12:00` /
/// `2026/10/01` 等形态; 前 10 字符 + 分隔符替换覆盖前三种, 斜杠形态单独归一。
pub fn normalize_date(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.len() < 10 {
        return None;
    }
    let head = &trimmed[..10];
    if parse_date_days(head).is_some() {
        return Some(head.to_string());
    }
    let slashed = head.replace('/', "-");
    if parse_date_days(&slashed).is_some() {
        return Some(slashed);
    }
    None
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
    fn session_nonce_is_stable_within_the_session() {
        let first = session_nonce();
        assert_eq!(first, session_nonce(), "同一会话必须复用同一个前缀");
        assert!(!first.is_empty());
        assert!(first.bytes().all(|b| b.is_ascii_alphanumeric()), "base36: {first}");
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
        assert_eq!(date_plus_days("2026-10-01", 7).as_deref(), Some("2026-10-08"));
        assert_eq!(date_plus_days("2026-12-31", 1).as_deref(), Some("2027-01-01"));
        assert_eq!(date_plus_days("not-a-date", 1), None);
        assert_eq!(date_plus_days("2026-13-01", 1), None);

        assert_eq!(normalize_date("2026-10-01").as_deref(), Some("2026-10-01"));
        assert_eq!(normalize_date("2026-10-01T12:00:00Z").as_deref(), Some("2026-10-01"));
        assert_eq!(normalize_date("2026-10-01 12:00").as_deref(), Some("2026-10-01"));
        assert_eq!(normalize_date("2026/10/01").as_deref(), Some("2026-10-01"));
        assert_eq!(normalize_date("10月1日"), None);
        assert_eq!(normalize_date(""), None);
        assert_eq!(parse_date_days("2026-10-1"), None, "长度不足必须拒绝");
    }

    #[test]
    fn rfc3339_parsing_inverts_formatting() {
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_secs("2023-11-14T22:13:20Z"), Some(1_700_000_000));
        for seconds in [0_i64, 1, 59, 3_600, 86_399, 1_700_000_000, 1_790_000_000] {
            assert_eq!(parse_rfc3339_secs(&rfc3339_from_unix(seconds)), Some(seconds));
        }
        // 带偏移的形态
        assert_eq!(parse_rfc3339_secs("2023-11-15T06:13:20+08:00"), Some(1_700_000_000));
        assert_eq!(parse_rfc3339_secs("2023-11-14T17:13:20-05:00"), Some(1_700_000_000));
        // 认不出 → None(调用方必须当作不新鲜)
        assert_eq!(parse_rfc3339_secs(""), None);
        assert_eq!(parse_rfc3339_secs("2023-11-14"), None);
        assert_eq!(parse_rfc3339_secs("2023-11-14 22:13:20"), None);
        assert_eq!(parse_rfc3339_secs("2023-11-14T25:13:20Z"), None);
        assert_eq!(parse_rfc3339_secs("not a time at all"), None);
        assert_eq!(parse_rfc3339_secs("2023-13-14T22:13:20Z"), None);
    }
}
