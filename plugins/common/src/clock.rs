//! 墙钟时间、日历换算与休眠(对照 Go `time.Now()` / `time.Sleep()`)。
//!
//! # 为什么需要 WASI
//!
//! `wasm32-unknown-unknown` 的 std **没有**时间实现(`SystemTime::now()` 直接 panic),
//! 而生产宿主提供 wasip1 的 `clock_time_get` / `poll_oneoff`(插件的
//! `runtime/plugin.wasm` 导入段里就有这两个函数)。本模块用它们取时间 / 休眠。
//! 失败时(宿主返回非 0 errno)退化为 0 纳秒, 不 panic。
//!
//! # nanos 家族与秒级家族
//!
//! 核心面是 music-rs / douban-rs 使用的**纳秒**家族:
//! [`now_unix_nanos`] / [`rfc3339`] / [`parse_rfc3339`] / [`current_month`]。
//! chase-rs 使用**秒级 + 日历**函数([`now_unix_secs`] / [`rfc3339_from_unix`] /
//! [`parse_rfc3339_secs`] / [`local_date`] / ...), 它们放在 `ext` feature 下。
//!
//! 两套 `parse` 的语义确实不同(music/douban 要求时区、校验每月天数、返回纳秒;
//! chase 时区可省、日 1..31、返回秒), **不要合并** —— 合并会改变到期/TTL 判定。
//!
//! # 本机(cargo test)
//!
//! native 构建只服务测试: 时间可用 [`testhooks::set_now`] 固定, 休眠只记录不真睡 ——
//! 否则存储层的 300ms/200ms 重试会把用例拖慢。注意这些钩子按
//! `cfg(not(target_arch = "wasm32"))` 编译(不是 `cfg(test)`): common 作为依赖编译时
//! `cfg(test)` 为 false, 用 `cfg(test)` 会让插件测试静默失效。

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
        if let Some(fixed) = testhooks::now() {
            return fixed;
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
/// 非法输入返回 `None`(解不出来时调用方按"已过期/需重试"处理), 不 panic。
pub fn parse_rfc3339(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
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
    };
    if index != bytes.len() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds =
        days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64 - offset_seconds;
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
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
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
/// 用于 `load_state_with_retry` 的重试间隔与 404 两次确认窗口 —— 宿主重启风暴期间
/// 单次 404 不代表全新安装, 必须隔一段时间再确认一次。
pub fn sleep_ms(ms: u64) {
    #[cfg(target_arch = "wasm32")]
    {
        wasi_sleep_nanos(ms.saturating_mul(1_000_000));
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        testhooks::record_sleep(ms);
        // native 构建只服务 `cargo test`: 真睡只会拖慢用例, 时序语义只在 wasm 上有意义。
        let _ = ms;
    }
}

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
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
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
pub fn base36(mut value: u64) -> String {
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
///
/// 按 `cfg(not(target_arch = "wasm32"))` 编译(不是 `cfg(test)`), 因为 common 作为
/// 依赖被插件测试链接时 `cfg(test)` 为 false; 全部 `pub` 供插件 wrapper 的测试使用。
#[cfg(not(target_arch = "wasm32"))]
pub mod testhooks {
    use std::cell::{Cell, RefCell};

    thread_local! {
        static FIXED_NOW: Cell<Option<u64>> = const { Cell::new(None) };
        static SLEEPS: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
    }

    /// 固定当前时间(纳秒), `None` 恢复真实时钟。
    pub fn set_now(nanos: Option<u64>) {
        FIXED_NOW.with(|cell| cell.set(nanos));
    }

    pub fn now() -> Option<u64> {
        FIXED_NOW.with(Cell::get)
    }

    pub fn record_sleep(ms: u64) {
        SLEEPS.with(|sleeps| sleeps.borrow_mut().push(ms));
    }

    /// 取走并清空已记录的休眠序列。
    pub fn take_sleeps() -> Vec<u64> {
        SLEEPS.with(|sleeps| std::mem::take(&mut *sleeps.borrow_mut()))
    }
}

// ─────────────────────────── 秒级 / 日历(chase-rs) ───────────────────────────

/// 当前 Unix 秒(负数按 0 处理: 时钟未同步时不让日期换算落到 1969 年)。
#[cfg(feature = "ext")]
pub fn now_unix_secs() -> i64 {
    (now_unix_nanos() / 1_000_000_000) as i64
}

/// Unix 秒 → RFC3339(UTC)。
#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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
    let mut seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;

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

/// 带偏移的"本地"天数与秒内时刻。
#[cfg(feature = "ext")]
fn local_parts(offset_minutes: i32) -> (i64, i64) {
    let shifted = now_unix_secs() + i64::from(offset_minutes) * 60;
    (shifted.div_euclid(86_400), shifted.rem_euclid(86_400))
}

/// 本地日期(`YYYY-MM-DD`), 偏移取自 `settings.report.tz_offset_minutes`。
#[cfg(feature = "ext")]
pub fn local_date(offset_minutes: i32) -> String {
    let (days, _) = local_parts(offset_minutes);
    date_from_days(days)
}

/// 本地小时(0-23)。
#[cfg(feature = "ext")]
pub fn local_hour(offset_minutes: i32) -> u8 {
    let (_, seconds) = local_parts(offset_minutes);
    (seconds / 3600) as u8
}

/// 天数 → `YYYY-MM-DD`。
#[cfg(feature = "ext")]
pub fn date_from_days(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 日期加减天数; 输入不是 `YYYY-MM-DD` 时返回 `None`(不猜)。
#[cfg(feature = "ext")]
pub fn date_plus_days(date: &str, delta: i64) -> Option<String> {
    let days = parse_date_days(date)?;
    Some(date_from_days(days + delta))
}

/// `YYYY-MM-DD` → 天数; 非法输入(长度/分隔/范围)返回 `None`。
#[cfg(feature = "ext")]
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

#[cfg(feature = "ext")]
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
#[cfg(feature = "ext")]
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
