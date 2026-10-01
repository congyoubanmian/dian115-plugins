//! Emby 侧: 实例解析(`/api/plugin-host/emby/instances`)与已有/缺集读取
//! (`/api/plugin-host/emby/episodes`)。
//!
//! # 两个端点的契约等级完全不同
//!
//! - `instances` 是强类型 schema(`PluginEmbyInstanceList` /
//!   `PluginEmbyInstance{id,name,is_default,api_key_configured}`, openapi-v1.yaml:6244-6265);
//! - `episodes` **既没有 `parameters` 也没有响应字段声明**(openapi-v1.yaml:4332-4353,
//!   响应只是 `GenericHostObject`)。参数名与字段名都未知 —— 所以这里按
//!   [`candidates`] 的参数矩阵试、按 [`parse_coverage`] 的多候选字段名收。
//!
//! # 接受判定(与设计规格一致)
//!
//! 能从候选路径产出「整数集集合 H」或「明确缺集列表」之一 ⇒ `ok`; 否则 `unparsed`。
//! **只有数值没有逐集信息 ⇒ 判为 unparsed** —— 不允许凭一个 `count` 推断缺口并写 PATCH。
//!
//! 形状指纹(命中即持久化到 `settings.probe.emby_episodes_shape`)形如:
//! `params=proxy_id,tmdb_id,season;list=items;index=index_number;missing=missing`。

use std::collections::BTreeSet;

use serde_json::Value;

use crate::host;
use crate::raw::{self, ParseFailure};

/// 实例列表路径。
pub const INSTANCES_PATH: &str = "/api/plugin-host/emby/instances";
/// 缺集读取路径。
pub const EPISODES_PATH: &str = "/api/plugin-host/emby/episodes";

/// 实例列表的响应字段候选(强类型是 `items`)。
const LIST_KEYS: &[&str] = &["items", "instances", "data", "list"];

/// 集列表字段候选(根对象下探一层)。
const COVERAGE_KEYS: &[&str] = &[
    "items",
    "episodes",
    "existing",
    "existing_episodes",
    "have",
    "present",
    "data",
];
/// `data` 还要再下探一层这些键(规格里的 `data` 再下探一层 items/episodes)。
const COVERAGE_DEEP_KEYS: &[&str] = &["items", "episodes", "existing", "existing_episodes"];
/// 单集序号的字段候选。
const INDEX_KEYS: &[&str] = &[
    "index_number",
    "index",
    "episode_number",
    "episode",
    "episode_index",
    "number",
];
/// 显式缺集列表的字段候选。
const MISSING_KEYS: &[&str] = &["missing", "missing_episodes", "absent", "lack", "gaps"];
/// 数值兜底字段候选(仅当同时存在显式缺集列表时才认)。
const COUNT_KEYS: &[&str] = &["episode_count", "existing_count", "have_count", "count"];

// ─────────────────────────── instances ───────────────────────────

/// 一个可用的 Emby 实例(只保留选择与展示需要的字段)。
///
/// 宿主原字段 `api_key_configured` 在这里改名为 [`Instance::key_ready`]:
/// 该键名命中凭据模式 `api_key`, 直接落进状态文档会违反
/// "全文档不得出现凭据键名"的硬约束(见 [`raw::is_forbidden_key`])。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Instance {
    pub id: i64,
    pub name: String,
    pub is_default: bool,
    pub key_ready: bool,
}

/// 选中的实例 + 调用其它接口时要带的 `proxy_id`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub id: i64,
    pub name: String,
    /// `id == 0`(旧版单实例)时为 `None`: 后续调用一律**省略** `proxy_id`
    /// (openapi-v1.yaml:6253)。
    pub proxy_id: Option<i64>,
}

/// 解析实例列表(强类型 `PluginEmbyInstanceList`, 但字段名多候选)。
pub fn parse_instances(raw: &[u8]) -> Result<Vec<Instance>, String> {
    let value = raw::decode_json(raw)?;
    let array = raw::array_at(&value, LIST_KEYS)
        .or_else(|| raw::descend(&value, &["data"]).and_then(|inner| raw::array_at(inner, LIST_KEYS)))
        .ok_or_else(|| "实例列表结构未识别: 缺少 items 数组".to_string())?;

    let mut instances = Vec::new();
    for element in array {
        let Some(obj) = element.as_object() else { continue };
        let Some(id) = raw::first_i64(obj, &["id", "proxy_id"]) else { continue };
        if id < 0 {
            continue;
        }
        instances.push(Instance {
            id,
            name: raw::first_string(obj, &["name", "title"]).unwrap_or_default(),
            is_default: raw::first_bool(obj, &["is_default", "default"]),
            key_ready: raw::first_bool(obj, &["api_key_configured", "has_key", "configured"]),
        });
    }
    Ok(instances)
}

/// 按配置选实例。
///
/// - `proxy_id >= 1`: 必须找到该 id, 且已配置密钥; 找不到/没密钥 → `Err`(整段 Emby 跳过);
/// - `proxy_id == 0`: 旧版单实例, 选 id 为 0 的那条;
/// - `proxy_id == -1`: 优先 `is_default`, 再退第一个已配置密钥的实例。
pub fn select(instances: &[Instance], proxy_id: i64) -> Result<Selection, String> {
    if instances.is_empty() {
        return Err("宿主没有返回可用的 Emby 实例".to_string());
    }
    if proxy_id >= 0 {
        let found = instances
            .iter()
            .find(|instance| instance.id == proxy_id)
            .ok_or_else(|| format!("配置的 Emby 实例 id={proxy_id} 不在可用列表中"))?;
        if !found.key_ready {
            return Err(format!("Emby 实例 id={} 未配置密钥", found.id));
        }
        return Ok(selection_of(found));
    }
    let chosen = instances
        .iter()
        .find(|instance| instance.is_default && instance.key_ready)
        .or_else(|| instances.iter().find(|instance| instance.key_ready))
        .ok_or_else(|| "所有 Emby 实例都没有配置密钥".to_string())?;
    Ok(selection_of(chosen))
}

fn selection_of(instance: &Instance) -> Selection {
    Selection {
        id: instance.id,
        name: instance.name.clone(),
        // id==0 是旧版单实例配置: 调用时省略 proxy_id
        proxy_id: if instance.id == 0 { None } else { Some(instance.id) },
    }
}

/// 没有实例列表时, 按用户**显式配置**的实例 id 直接构造选择。
///
/// 只用于拿不到 `/emby/instances` 列表的场合(全新安装还没跑过 job 时的 `align-now`):
/// - `0` → 旧版单实例(`id = 0`, 调用时省略 `proxy_id`, 见 openapi-v1.yaml:6253);
/// - `>= 1` → 直接用这个 id;
/// - `-1`(跟随宿主默认) → `None`: 默认实例只有 instances 接口才知道, **不猜**
///   (规格的降级阶梯: 实例层不可用 ⇒ 整段 Emby 跳过)。
///
/// 这条路径不额外发 host.call, 因此不影响 align-now 的 `1 + max_patch + 3` 预算;
/// 若指定的实例其实不存在, 那条 `emby/episodes` 会 HTTP 失败 ⇒ 该条零写入 + 记 debug。
pub fn selection_from_settings(proxy_id: i64) -> Option<Selection> {
    match proxy_id {
        0 => Some(Selection { id: 0, name: String::new(), proxy_id: None }),
        id if id >= 1 => Some(Selection { id, name: String::new(), proxy_id: Some(id) }),
        _ => None,
    }
}

/// 拉取实例列表。
pub fn fetch_instances() -> Result<Vec<Instance>, ParseFailure> {
    let response = host::get(INSTANCES_PATH)
        .map_err(|err| ParseFailure::transport(format!("Emby 实例请求失败: {err}")))?;
    if response.status >= 400 {
        return Err(ParseFailure::http(
            response.status,
            response.raw.clone(),
            format!("Emby 实例 HTTP {}", response.status),
        ));
    }
    parse_instances(&response.raw)
        .map_err(|message| ParseFailure::http(response.status, response.raw.clone(), message))
}

// ─────────────────────────── episodes ───────────────────────────

/// 一次 `emby/episodes` 请求的参数组合(候选矩阵 M1/M2/M3)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeQuery {
    /// `None` = 省略 `proxy_id`(实例 id 为 0 的旧版单实例)。
    pub proxy_id: Option<i64>,
    pub tmdb_id: i64,
    pub season: i64,
    /// 1 = `tmdb_id`+`season`; 2 = `tmdb_id`+`season_number`; 3 = `tmdbId`+`season`。
    pub variant: u8,
}

impl EpisodeQuery {
    /// 请求路径(参数全是数字, 无需转义)。
    pub fn path(&self) -> String {
        let (id_key, season_key) = match self.variant {
            2 => ("tmdb_id", "season_number"),
            3 => ("tmdbId", "season"),
            _ => ("tmdb_id", "season"),
        };
        let mut path = String::from(EPISODES_PATH);
        path.push('?');
        let mut first = true;
        if let Some(proxy_id) = self.proxy_id {
            path.push_str(&format!("proxy_id={proxy_id}"));
            first = false;
        }
        if !first {
            path.push('&');
        }
        path.push_str(&format!("{id_key}={}&{season_key}={}", self.tmdb_id, self.season));
        path
    }

    /// 参数名列表(写进形状指纹与 debug.attempts[].params)。
    pub fn params_label(&self) -> String {
        let (id_key, season_key) = match self.variant {
            2 => ("tmdb_id", "season_number"),
            3 => ("tmdbId", "season"),
            _ => ("tmdb_id", "season"),
        };
        match self.proxy_id {
            Some(_) => format!("proxy_id,{id_key},{season_key}"),
            None => format!("{id_key},{season_key}"),
        }
    }

    /// 完整指纹的 `params=` 段。
    pub fn shape_prefix(&self) -> String {
        format!("params={}", self.params_label())
    }
}

/// 参数矩阵: 按序最多试 3 个组合, 命中即停(M1 → M2 → M3)。
pub fn candidates(tmdb_id: i64, season: i64, proxy_id: Option<i64>) -> Vec<EpisodeQuery> {
    (1..=3)
        .map(|variant| EpisodeQuery { proxy_id, tmdb_id, season, variant })
        .collect()
}

/// 从形状指纹里取出参数组合的变体号(缓存命中时按它直接调用)。
pub fn variant_from_shape(shape: &str) -> Option<u8> {
    let params = shape
        .split(';')
        .find_map(|segment| segment.strip_prefix("params="))?;
    let names: Vec<&str> = params.split(',').collect();
    // 允许带或不带 proxy_id 前缀
    let tail: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| *name != "proxy_id")
        .collect();
    match tail.as_slice() {
        ["tmdb_id", "season"] => Some(1),
        ["tmdb_id", "season_number"] => Some(2),
        ["tmdbId", "season"] => Some(3),
        _ => None,
    }
}

/// Emby 覆盖: 已有集集合 H 与/或明确缺集列表。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Coverage {
    /// 已有集的集号集合; `None` = 该响应里没有逐集信息。
    pub have: Option<BTreeSet<i64>>,
    /// 显式缺集列表; `None` = 响应里没有这个字段。
    pub missing: Option<BTreeSet<i64>>,
    /// 只做区间判断时缓存的上界(有 have 时等于 max(have))。
    pub count_hint: Option<i64>,
    pub shape: String,
}

impl Coverage {
    /// 已有集的最大集号(没有逐集信息时为 `None`)。
    pub fn have_max(&self) -> Option<i64> {
        self.have.as_ref().and_then(|set| set.iter().next_back().copied())
    }

    /// 已有集条数。
    pub fn have_count(&self) -> Option<i64> {
        self.have.as_ref().map(|set| set.len() as i64)
    }

    /// 明示缺集的最大集号。
    pub fn missing_max(&self) -> Option<i64> {
        self.missing.as_ref().and_then(|set| set.iter().next_back().copied())
    }

    /// 该季 `[from, to]` 是否全部已有(减方向建议的前置条件)。
    pub fn covers_range(&self, from: i64, to: i64) -> bool {
        if to < from {
            return true;
        }
        match &self.have {
            Some(have) => (from..=to).all(|episode| have.contains(&episode)),
            None => false,
        }
    }

    /// 缺口上沿(缺口集号区间的最高集号; 0 = 无缺口)。
    pub fn gap_max(&self, total_known: i64) -> i64 {
        if let Some(have_max) = self.have_max() {
            if have_max > total_known {
                return have_max;
            }
        }
        if let Some(missing) = &self.missing {
            if let Some(max) = missing.iter().rev().find(|episode| **episode > total_known) {
                return *max;
            }
        }
        0
    }
}

/// 解析 `emby/episodes` 响应。
///
/// 两条接受路径(**或**关系, 与规格的接受判定一致): 命中集列表(产出已有集集合 H)或
/// 命中显式缺集列表。两者都没有 ⇒ `Err`(绝不凭一个数字推断缺口)。
///
/// 返回的消息只描述"哪里没认出来", 前缀由 [`fetch_coverage`] 统一加
/// (那里才是"这三次探测全部未识别"的判定点, 也是排障时看到的那一条)。
pub fn parse_coverage(raw: &[u8]) -> Result<Coverage, String> {
    let value = raw::decode_json(raw)?;
    let located = locate_container(&value);

    // `locate_container` 只在真的命中"集列表"字段时才返回, 所以这里直接遍历它:
    // 空列表 = "该端点在 Emby 侧没有任何集", 记为 Some(空集) 而不是 None(拿不到结构)。
    let have: Option<BTreeSet<i64>> = located.as_ref().map(|(items, _)| collect_have(items));

    // 显式缺集列表(只在根对象上找; `data` 再下探一层)
    let mut missing: Option<BTreeSet<i64>> = None;
    if let Some(obj) = value.as_object() {
        missing = missing_from(obj);
    }
    if missing.is_none() {
        if let Some(inner) = raw::descend(&value, &["data"]).and_then(Value::as_object) {
            missing = missing_from(inner);
        }
    }

    if have.is_none() && missing.is_none() {
        return Err("既没有集列表也没有缺集列表".to_string());
    }

    let mut coverage = Coverage { have, missing, count_hint: None, shape: String::new() };
    // 数值兜底只在有显式缺集列表时才认(规则: 不允许凭一个数字推断缺口)
    if coverage.missing.is_some() {
        for source in [Some(&value), raw::descend(&value, &["data"])] {
            if let Some(obj) = source.and_then(Value::as_object) {
                if let Some(count) = raw::first_i64(obj, COUNT_KEYS) {
                    coverage.count_hint = Some(count);
                    break;
                }
            }
        }
    }
    let list_name = located
        .map(|(_, name)| name)
        .unwrap_or_else(|| "n/a".to_string());
    let index_name = index_field_name(&value).unwrap_or_else(|| "n/a".to_string());
    let missing_name = missing_field_name(&value).unwrap_or_else(|| "n/a".to_string());
    coverage.shape = format!("list={list_name};index={index_name};missing={missing_name}");
    Ok(coverage)
}

/// 逐元素取集号(数字/数字串/带序号的 object), 认不出的元素直接跳过。
fn collect_have(items: &[Value]) -> BTreeSet<i64> {
    let mut set = BTreeSet::new();
    for element in items {
        if let Some(number) = episode_number(element) {
            set.insert(number);
        }
    }
    set
}

/// 定位集列表容器, 返回 (元素数组, 命中的键名)。
fn locate_container(value: &Value) -> Option<(&Vec<Value>, String)> {
    if let Value::Array(items) = value {
        return Some((items, "array".to_string()));
    }
    let obj = value.as_object()?;
    for key in COVERAGE_KEYS {
        let Some(candidate) = obj.get(*key) else { continue };
        if let Value::Array(items) = candidate {
            return Some((items, (*key).to_string()));
        }
        if *key == "data" {
            if let Some(inner) = candidate.as_object() {
                for deep in COVERAGE_DEEP_KEYS {
                    if let Some(Value::Array(items)) = inner.get(*deep) {
                        return Some((items, format!("data.{deep}")));
                    }
                }
            }
        }
    }
    None
}

/// 单个元素 → 集号(整数、数字字符串、或带序号的 object)。
fn episode_number(element: &Value) -> Option<i64> {
    if let Some(number) = raw::loose_i64(element) {
        return Some(number);
    }
    let obj = element.as_object()?;
    raw::first_i64(obj, INDEX_KEYS)
}

/// 从对象里取显式缺集列表。
fn missing_from(obj: &serde_json::Map<String, Value>) -> Option<BTreeSet<i64>> {
    let value = raw::first_of(obj, MISSING_KEYS)?;
    let array = match value {
        Value::Array(items) => items,
        Value::Object(inner) => raw::first_of(inner, &["items", "episodes", "list"])?.as_array()?,
        // 单个数字也是合法的"缺集列表"(宿主可能只返回一个)
        _ => {
            let single = raw::loose_i64(value)?;
            return Some(BTreeSet::from([single]));
        }
    };
    let mut set = BTreeSet::new();
    for element in array {
        if let Some(number) = episode_number(element) {
            set.insert(number);
        }
    }
    Some(set)
}

/// 第一个命中的集序号字段名(用于形状指纹)。
fn index_field_name(value: &Value) -> Option<String> {
    let container = locate_container(value)?.0;
    for element in container {
        let Some(obj) = element.as_object() else { continue };
        for key in INDEX_KEYS {
            if obj.get(*key).and_then(raw::loose_i64).is_some() {
                return Some((*key).to_string());
            }
        }
    }
    None
}

/// 命中的缺集字段名(用于形状指纹)。
fn missing_field_name(value: &Value) -> Option<String> {
    let mut objects = vec![value];
    let inner;
    if let Some(descended) = raw::descend(value, &["data"]) {
        inner = descended;
        objects.push(inner);
    }
    for candidate in objects {
        let Some(obj) = candidate.as_object() else { continue };
        for key in MISSING_KEYS {
            if obj.contains_key(*key) {
                return Some((*key).to_string());
            }
        }
    }
    None
}

/// 拉取一次覆盖。
///
/// `shape_hint` 非空时先把指纹命中的参数组合排到最前(命中即停, 1 次 host.call);
/// `max_attempts` 是**本次允许发出的 host.call 次数上限**(调用方用它把单轮探测预算
/// 收敛到 `settings.emby_probe_budget` / align-now 的 3 次)。返回实际发出的次数,
/// 调用方据此记账 —— 预算必须按真实调用数扣减。
///
/// 三次尝试全部失败时返回带原文的 `ParseFailure`(其 `attempts` = 实际调用数)。
pub fn fetch_coverage(
    tmdb_id: i64,
    season: i64,
    proxy_id: Option<i64>,
    shape_hint: &str,
    max_attempts: u8,
) -> Result<(Coverage, EpisodeQuery, u8), ParseFailure> {
    if max_attempts == 0 {
        // 预算已经用尽: 一次都不发(这是唯一"零调用失败"的形态)
        return Err(ParseFailure::transport("Emby 探测预算已用尽").with_attempts(0));
    }
    let mut order = candidates(tmdb_id, season, proxy_id);
    if let Some(variant) = variant_from_shape(shape_hint) {
        // 指纹命中的组合排到最前(命中即停, 省掉两次无谓探测)
        if let Some(position) = order.iter().position(|query| query.variant == variant) {
            let preferred = order.remove(position);
            order.insert(0, preferred);
        }
    }
    order.truncate(usize::from(max_attempts.min(3)));

    let mut calls: u8 = 0;
    let mut last: Option<ParseFailure> = None;
    for query in order {
        calls = calls.saturating_add(1);
        let response = match host::get(&query.path()) {
            Ok(response) => response,
            Err(err) => {
                last = Some(ParseFailure::transport(format!("Emby 覆盖请求失败: {err}")));
                continue;
            }
        };
        if response.status >= 400 {
            last = Some(ParseFailure::http(
                response.status,
                response.raw.clone(),
                format!("Emby 覆盖 HTTP {}", response.status),
            ));
            continue;
        }
        match parse_coverage(&response.raw) {
            Ok(mut coverage) => {
                coverage.shape = format!("{};{}", query.shape_prefix(), coverage.shape);
                return Ok((coverage, query, calls));
            }
            Err(message) => {
                // 统一前缀: 200 但认不出形状(含根本不是 JSON 的 HTML 页面)都归到这一类,
                // 上层据此区分"HTTP 失败"与"结构未识别", 原文样本照旧随 ParseFailure 带走。
                last = Some(ParseFailure::http(
                    response.status,
                    response.raw.clone(),
                    format!("Emby 覆盖结构未识别: {message}"),
                ));
            }
        }
    }
    Err(last.unwrap_or_else(|| ParseFailure::transport("Emby 覆盖探测没有可用参数组合"))
        .with_attempts(calls))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::FakeHost;
    use serde_json::json;

    // ── instances ──

    /// 强类型形态(`PluginEmbyInstanceList`)。
    fn instances_fixture() -> Vec<u8> {
        r#"{
          "items": [
            {"id": 0, "name": "旧版单实例", "is_default": false, "api_key_configured": true},
            {"id": 3, "name": "客厅", "is_default": true, "api_key_configured": true},
            {"id": 4, "name": "书房", "is_default": false, "api_key_configured": false}
          ]
        }"#.as_bytes()
        .to_vec()
    }

    #[test]
    fn parses_instances_strict_and_loose() {
        let instances = parse_instances(&instances_fixture()).unwrap();
        assert_eq!(instances.len(), 3);
        assert_eq!(instances[1].id, 3);
        assert_eq!(instances[1].name, "客厅");
        assert!(instances[1].is_default);
        assert!(instances[1].key_ready);

        // 宽松形态: data.items / 字符串 id / 缺字段
        let loose = r#"{"data":{"items":[{"id":"5","name":"卧室"}]}}"#.as_bytes();
        let instances = parse_instances(loose).unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].id, 5);
        assert!(!instances[0].is_default);
        assert!(!instances[0].key_ready);
    }

    #[test]
    fn unparsable_instance_payloads_are_reported() {
        assert!(parse_instances(br#"{"nope":[]}"#).is_err());
        assert!(parse_instances(b"<html>").is_err());
        // 裸空数组: 是合法的"没有实例", 由 select 负责报错
        let empty = parse_instances(b"[]").unwrap();
        assert!(empty.is_empty());
        assert!(select(&empty, -1).is_err());
    }

    #[test]
    fn instance_selection_follows_the_config_rules() {
        let instances = parse_instances(&instances_fixture()).unwrap();
        // -1 → 默认实例
        let chosen = select(&instances, -1).unwrap();
        assert_eq!(chosen.id, 3);
        assert_eq!(chosen.proxy_id, Some(3));
        // ≥1 → 指定实例; 该实例没配密钥就整段跳过
        let err = select(&instances, 4).unwrap_err();
        assert!(err.contains("未配置密钥"), "{err}");
        // 0 → 旧版单实例, 调用时省略 proxy_id
        let legacy = select(&instances, 0).unwrap();
        assert_eq!(legacy.id, 0);
        assert_eq!(legacy.proxy_id, None);
        // 指定了不存在的实例 → 整段跳过
        assert!(select(&instances, 77).is_err());
        // 空列表
        assert!(select(&[], -1).is_err());
    }

    #[test]
    fn instance_selection_prefers_default_then_key_ready() {
        let instances = parse_instances(
            r#"[{"id":9,"name":"无密钥默认","is_default":true,"api_key_configured":false},
                 {"id":10,"name":"有密钥","api_key_configured":true}]"#.as_bytes(),
        )
        .unwrap();
        assert_eq!(select(&instances, -1).unwrap().id, 10, "默认实例没密钥时退到可用实例");
    }

    // ── episodes ──

    /// 形态 A: 根数组 + index_number。
    fn coverage_array_fixture() -> Vec<u8> {
        br#"[{"index_number":1},{"index_number":2},{"index_number":3}]"#.to_vec()
    }

    /// 形态 B: `{"items":[...]}` + `episode_number` + 显式缺集列表 + 数值。
    fn coverage_items_fixture() -> Vec<u8> {
        br#"{
          "items": [
            {"episode_number": 1, "parent_index_number": 1},
            {"episode_number": 2, "parent_index_number": 1},
            {"episode_number": 4, "parent_index_number": 1}
          ],
          "missing": [3],
          "episode_count": 3
        }"#
        .to_vec()
    }

    /// 形态 C: `{"data":{"episodes":[...]}}` + `episode_number` 字符串。
    fn coverage_data_fixture() -> Vec<u8> {
        br#"{"data":{"episodes":[{"episode_number":"1"},{"episode_number":"2"}]}}"#.to_vec()
    }

    #[test]
    fn parses_coverage_shapes() {
        for (raw, expected_max, expected_count) in [
            (coverage_array_fixture(), 3, 3),
            (coverage_items_fixture(), 4, 3),
            (coverage_data_fixture(), 2, 2),
        ] {
            let coverage = parse_coverage(&raw).unwrap();
            assert_eq!(coverage.have_max(), Some(expected_max), "{:?}", coverage.shape);
            assert_eq!(coverage.have_count(), Some(expected_count));
        }

        let coverage = parse_coverage(&coverage_array_fixture()).unwrap();
        assert_eq!(coverage.shape, "list=array;index=index_number;missing=n/a");
        let coverage = parse_coverage(&coverage_items_fixture()).unwrap();
        assert_eq!(coverage.shape, "list=items;index=episode_number;missing=missing");
        assert_eq!(coverage.missing_max(), Some(3));
        assert_eq!(coverage.count_hint, Some(3));
        let coverage = parse_coverage(&coverage_data_fixture()).unwrap();
        assert_eq!(coverage.shape, "list=data.episodes;index=episode_number;missing=n/a");
    }

    #[test]
    fn coverage_accepts_explicit_missing_without_have_list() {
        // 只有缺集列表, 没有逐集已有: 仍然 ok(规格接受判定之一)
        let raw = br#"{"missing_episodes":[7,8,9]}"#;
        let coverage = parse_coverage(raw).unwrap();
        assert_eq!(coverage.have, None);
        assert_eq!(coverage.missing_max(), Some(9));
        assert_eq!(coverage.gap_max(5), 9);
    }

    #[test]
    fn coverage_rejects_count_only_payloads() {
        // 只有数值没有逐集信息 → unparsed, 绝不允许凭数字写 PATCH
        let cases: Vec<(Vec<u8>, bool)> = vec![
            (br#"{"episode_count":12}"#.to_vec(), false),
            (br#"{"count":3,"have_count":2}"#.to_vec(), false),
            (b"".to_vec(), false),
            (b"<html>502</html>".to_vec(), false),
            // 空的集数组是"明确没有已存在集", 属于可解析
            (br#"{"items":[]}"#.to_vec(), true),
        ];
        for (raw, expect_ok) in cases {
            let result = parse_coverage(&raw);
            assert_eq!(
                result.is_ok(),
                expect_ok,
                "{:?} 的判定不符合预期: {:?}",
                String::from_utf8_lossy(&raw),
                result.err()
            );
        }
    }

    #[test]
    fn coverage_handles_scalar_lists_and_objects() {
        // 元素是数字/数字字符串
        let coverage = parse_coverage(br#"[1,"2",3]"#).unwrap();
        assert_eq!(coverage.have_max(), Some(3));
        // 元素是 object 且带季号
        let coverage = parse_coverage(br#"[{"season":1,"episode":5}]"#).unwrap();
        assert_eq!(coverage.have_max(), Some(5));
        // 缺集列表里元素是 object
        let coverage = parse_coverage(br#"{"missing":[{"index_number":4}]}"#).unwrap();
        assert_eq!(coverage.missing_max(), Some(4));
    }

    #[test]
    fn coverage_range_and_gap_math() {
        let coverage = parse_coverage(&coverage_items_fixture()).unwrap();
        assert!(coverage.covers_range(1, 2));
        assert!(!coverage.covers_range(1, 3), "缺 3 就不算覆盖");
        assert_eq!(coverage.gap_max(2), 4);
        assert_eq!(coverage.gap_max(10), 0, "没有超出订阅总集数的缺口");
    }

    #[test]
    fn query_paths_and_shape_fingerprints() {
        let queries = candidates(1396, 5, Some(3));
        assert_eq!(queries.len(), 3);
        assert_eq!(
            queries[0].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season=5"
        );
        assert_eq!(
            queries[1].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season_number=5"
        );
        assert_eq!(
            queries[2].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdbId=1396&season=5"
        );
        // 旧版单实例: 一律省略 proxy_id
        assert_eq!(
            candidates(1396, 5, None)[0].path(),
            "/api/plugin-host/emby/episodes?tmdb_id=1396&season=5"
        );

        assert_eq!(variant_from_shape("params=proxy_id,tmdb_id,season;list=items"), Some(1));
        assert_eq!(variant_from_shape("params=tmdb_id,season_number;list=array"), Some(2));
        assert_eq!(variant_from_shape("params=proxy_id,tmdbId,season;list=data.items"), Some(3));
        assert_eq!(variant_from_shape("garbage"), None);
        assert_eq!(variant_from_shape("params=tmdb_id;list=items"), None);
    }

    #[test]
    fn fetch_coverage_uses_shape_hint_first_and_probes_on_failure() {
        let fake = FakeHost::new();
        // M2(season_number)才是对的: 指纹命中时 1 次调用就够
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season_number",
            200,
            &coverage_items_fixture(),
        );
        // 其它组合返回不可解析的 body
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, br#"{"count":3}"#);
        let guard = fake.install();

        let (coverage, query, calls) =
            fetch_coverage(1396, 5, Some(3), "params=proxy_id,tmdb_id,season_number;list=items", 3)
                .unwrap();
        assert_eq!(query.variant, 2);
        assert_eq!(coverage.have_max(), Some(4));
        assert_eq!(calls, 1);
        assert_eq!(crate::host::observed_calls(), 1, "指纹命中时只该发 1 次 host.call");
        drop(guard);
    }

    #[test]
    fn fetch_coverage_honours_the_attempt_budget() {
        // 计数是线程本地且只增, 所以每段都取自己的基线做差。
        // 全矩阵都不可解析: 预算给 1 就只发 1 次
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, br#"{"count":3}"#);
        let guard = fake.install();
        let before = crate::host::observed_calls();
        let failure = fetch_coverage(1396, 5, Some(3), "", 1).unwrap_err();
        assert_eq!(failure.attempts, 1);
        assert_eq!(crate::host::observed_calls() - before, 1, "预算 1 → 只许 1 次 host.call");
        drop(guard);

        // 预算 0: 一次都不发
        let fake = FakeHost::new();
        let guard = fake.install();
        let before = crate::host::observed_calls();
        let failure = fetch_coverage(1396, 5, Some(3), "", 0).unwrap_err();
        assert_eq!(failure.attempts, 0);
        assert_eq!(crate::host::observed_calls() - before, 0);
        assert!(failure.message.contains("预算"), "{}", failure.message);
        drop(guard);

        // 预算 9 → 最多 3 次(矩阵只有 3 个组合)
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, br#"{"count":3}"#);
        let guard = fake.install();
        let before = crate::host::observed_calls();
        let failure = fetch_coverage(1396, 5, None, "", 9).unwrap_err();
        assert_eq!(failure.attempts, 3);
        assert_eq!(crate::host::observed_calls() - before, 3);
        drop(guard);
    }

    #[test]
    fn fetch_coverage_reports_failure_with_raw_sample() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, b"<html>nope</html>");
        let guard = fake.install();
        let failure = fetch_coverage(1396, 5, Some(3), "", 3).unwrap_err();
        assert_eq!(failure.http_status, 200);
        assert_eq!(failure.kind(), "unparsed");
        assert_eq!(failure.attempts, 3, "三次尝试都试过");
        assert!(failure.message.contains("未识别"), "{}", failure.message);
        assert!(failure.sample().contains("nope"));
        drop(guard);

        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 503, b"");
        let guard = fake.install();
        let failure = fetch_coverage(1396, 5, None, "", 3).unwrap_err();
        assert_eq!(failure.http_status, 503);
        assert_eq!(failure.kind(), "http_error");
        drop(guard);
    }

    #[test]
    fn instances_fetch_reports_http_failures() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 502, b"bad gateway");
        let guard = fake.install();
        let failure = fetch_instances().unwrap_err();
        assert_eq!(failure.http_status, 502);
        assert!(failure.raw.starts_with(b"bad"));
        drop(guard);

        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/instances", 200, &instances_fixture());
        let guard = fake.install();
        assert_eq!(fetch_instances().unwrap().len(), 3);
        drop(guard);
    }

    #[test]
    fn instance_view_rename_avoids_credential_key_names() {
        // 宿主原键名会命中凭据模式, 所以对外结构体用 key_ready
        assert!(raw::is_forbidden_key("api_key_configured"));
        assert!(!raw::is_forbidden_key("key_ready"));
        let instance = Instance { id: 1, name: "x".into(), is_default: false, key_ready: true };
        let value = json!({"id": instance.id, "key_ready": instance.key_ready});
        assert_eq!(raw::contains_forbidden_key(&value), None);
    }

    // ── 补: 实例列表的畸形条目 / 钉住实例的兜底 / 覆盖边界 ──

    #[test]
    fn parse_instances_skips_junk_entries_and_negative_ids() {
        let raw = r#"[
          {"id": -1, "name": "坏 id"},
          {"id": 2, "name": "好", "api_key_configured": true},
          "not an object",
          {"name": "没有 id"},
          {"id": "3", "name": "字符串 id"}
        ]"#
        .as_bytes();
        let instances = parse_instances(raw).unwrap();
        assert_eq!(instances.len(), 2, "只收 id 合法且非负的条目");
        assert_eq!(instances[0].id, 2);
        assert_eq!(instances[1].id, 3);
        assert!(!instances[1].key_ready);
    }

    #[test]
    fn select_rejects_pinned_ids_that_are_missing_or_keyless() {
        let instances = parse_instances(&instances_fixture()).unwrap();
        // id=4 在列表里但没配密钥 → 整段跳过, 不能"试试看"
        let err = select(&instances, 4).unwrap_err();
        assert!(err.contains("未配置密钥"), "{err}");
        // id=0 旧版单实例: 选中且省略 proxy_id
        assert_eq!(select(&instances, 0).unwrap().proxy_id, None);
        // 列表里没有 id=0 时不能凭空造一个
        let no_legacy = parse_instances(
            r#"[{"id":3,"name":"客厅","api_key_configured":true}]"#.as_bytes(),
        )
        .unwrap();
        assert!(select(&no_legacy, 0).is_err());
        // 空列表
        assert!(select(&[], 3).is_err());
    }

    #[test]
    fn selection_from_settings_only_pins_explicit_ids() {
        let pinned = selection_from_settings(3).unwrap();
        assert_eq!(pinned.id, 3);
        assert_eq!(pinned.proxy_id, Some(3));

        let legacy = selection_from_settings(0).unwrap();
        assert_eq!(legacy.id, 0);
        assert_eq!(legacy.proxy_id, None, "旧版单实例一律省略 proxy_id");

        assert!(selection_from_settings(-1).is_none(), "跟随宿主默认时没有列表就不猜");
        assert!(selection_from_settings(-9).is_none());
    }

    #[test]
    fn coverage_range_and_gap_edges() {
        // 空集列表 = "Emby 侧一集都没有", 是已知事实而不是未知
        let empty = parse_coverage(br#"{"items":[]}"#).unwrap();
        assert_eq!(empty.have_count(), Some(0));
        assert!(!empty.covers_range(1, 1), "没有任何集就不算覆盖");
        assert_eq!(empty.gap_max(5), 0);
        assert!(empty.covers_range(5, 1), "空区间恒真");

        // 只有缺集列表: 超出订阅总集数的最高缺集号才是缺口上沿
        let coverage = parse_coverage(br#"{"missing":[2,3,9]}"#).unwrap();
        assert_eq!(coverage.gap_max(5), 9);
        assert_eq!(coverage.gap_max(9), 0, "等于总集数不算缺口");
        assert_eq!(coverage.have_max(), None);

        // 有逐集覆盖时以 have_max 为准
        let both = parse_coverage(&coverage_items_fixture()).unwrap();
        assert_eq!(both.gap_max(3), 4);
        assert!(!both.covers_range(1, 3), "缺 3 就不算覆盖");
    }

    #[test]
    fn coverage_accepts_nested_missing_containers_and_scalars() {
        let nested = parse_coverage(
            br#"{"data":{"missing":{"items":[{"index_number":6},{"index_number":7}]}}}"#,
        )
        .unwrap();
        assert_eq!(nested.missing_max(), Some(7));
        assert_eq!(nested.have, None);
        assert_eq!(nested.shape, "list=n/a;index=n/a;missing=missing");

        let single = parse_coverage(br#"{"missing":5}"#).unwrap();
        assert_eq!(single.missing_max(), Some(5), "单个数字也是合法的缺集列表");
        // 缺集列表里的垃圾元素被跳过, 但字段本身仍算命中
        let junk = parse_coverage(br#"{"missing":[1,"x",null,{"nope":1}]}"#).unwrap();
        assert_eq!(junk.missing_max(), Some(1));
    }

    #[test]
    fn fetch_coverage_falls_back_to_the_matrix_when_the_hint_misses() {
        let fake = FakeHost::new();
        // 指纹说 M2, 但 M2 这条参数在宿主上返回不可解析的 body
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season_number",
            200,
            br#"{"count":3}"#,
        );
        // M1 才是对的
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season=",
            200,
            &coverage_array_fixture(),
        );
        let guard = fake.install();
        let before = crate::host::observed_calls();
        let (coverage, query, calls) = fetch_coverage(
            1396,
            5,
            Some(3),
            "params=proxy_id,tmdb_id,season_number;list=items",
            3,
        )
        .unwrap();
        assert_eq!(calls, 2, "指纹失效后要退回矩阵重探一次");
        assert_eq!(query.variant, 1);
        assert_eq!(coverage.have_max(), Some(3));
        assert!(coverage.shape.starts_with("params=proxy_id,tmdb_id,season;"), "{}", coverage.shape);
        assert_eq!(crate::host::observed_calls() - before, 2);
        drop(guard);
    }

    #[test]
    fn fetch_coverage_reports_transport_failures_without_panicking() {
        let fake = FakeHost::new();
        fake.fail_all(true);
        let guard = fake.install();
        let failure = fetch_coverage(1396, 5, Some(3), "", 3).unwrap_err();
        assert_eq!(failure.kind(), "http_error", "传输层失败也归 http_error");
        assert_eq!(failure.attempts, 3, "每个候选都要记一次尝试");
        assert!(failure.message.contains("Emby 覆盖请求失败"), "{}", failure.message);
        assert!(failure.sample().is_empty(), "传输失败没有原文可留");
        drop(guard);
    }
}
