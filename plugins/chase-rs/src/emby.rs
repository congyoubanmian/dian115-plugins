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
const LIST_KEYS: &[&str] = &["items", "instances", "data", "list", "result", "rows"];

/// 集列表字段候选(根对象下探一层)。
const COVERAGE_KEYS: &[&str] = &[
    "items",
    "episodes",
    "existing",
    "existing_episodes",
    "have",
    "present",
    "data",
    "list",
    "rows",
    "episode_numbers",
];
/// `data` 还要再下探一层这些键(规格里的 `data` 再下探一层 items/episodes)。
const COVERAGE_DEEP_KEYS: &[&str] = &[
    "items",
    "episodes",
    "existing",
    "existing_episodes",
    "list",
    "episode_numbers",
];
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
const MISSING_KEYS: &[&str] = &["missing", "missing_episodes", "absent", "lack", "gaps", "missing_numbers"];
/// 数值兜底字段候选(仅当同时存在显式缺集列表时才认)。
const COUNT_KEYS: &[&str] = &["episode_count", "existing_count", "have_count", "count"];

/// 区间式覆盖的字段候选(真实宿主 2026-10-02 实测: `covered_episodes` 是 `"1-24"`
/// 这样的**区间串**而不是数组; `needed_episodes` 同构, 空串 = 没有缺口)。
const RANGE_HAVE_KEYS: &[&str] = &["covered_episodes", "episodes_covered", "have_episodes"];
const RANGE_MISSING_KEYS: &[&str] = &["needed_episodes", "episodes_needed", "required_episodes"];
/// 单段区间与整个集合的膨胀上限(防畸形输入把内存打爆)。
const RANGE_SEGMENT_MAX: i64 = 2_000;
const RANGE_SET_MAX: usize = 10_000;

/// 解析区间串: `""`、`"5"`、`"1-24"`、`"1,3,5-7"`。
/// 非法段(解析失败/倒序/超上限)返回 `None` —— 整体视为未识别, 不猜。
fn parse_episode_ranges(text: &str) -> Option<BTreeSet<i64>> {
    let mut set = BTreeSet::new();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(set);
    }
    for segment in trimmed.split(',') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let (start, end) = match segment.split_once('-') {
            Some((left, right)) => {
                let start = left.trim().parse::<i64>().ok()?;
                let end = right.trim().parse::<i64>().ok()?;
                (start, end)
            }
            None => {
                let single = segment.parse::<i64>().ok()?;
                (single, single)
            }
        };
        if start < 0 || end < start || end - start > RANGE_SEGMENT_MAX {
            return None;
        }
        for episode in start..=end {
            set.insert(episode);
            if set.len() > RANGE_SET_MAX {
                return None;
            }
        }
    }
    Some(set)
}

/// 一个集集合的值: 区间串、整数/数字串数组、或单个数字。
fn episode_set_of(value: &Value) -> Option<BTreeSet<i64>> {
    match value {
        Value::String(text) => parse_episode_ranges(text),
        Value::Array(items) => {
            let mut set = BTreeSet::new();
            for element in items {
                set.insert(raw::loose_i64(element)?);
            }
            Some(set)
        }
        other => raw::loose_i64(other).map(|single| BTreeSet::from([single])),
    }
}

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
        let Some(id) = raw::first_i64(obj, &["id", "proxy_id", "instance_id", "emby_id"]) else { continue };
        if id < 0 {
            continue;
        }
        instances.push(Instance {
            id,
            name: raw::first_string(obj, &["name", "title", "label"]).unwrap_or_default(),
            is_default: raw::first_bool(obj, &["is_default", "default"]),
            key_ready: raw::first_bool(obj, &[
                "api_key_configured",
                "has_key",
                "configured",
                "key_configured",
            ]),
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
    fetch_instances_detailed().map(|(instances, _, _)| instances)
}

/// 拉取实例列表并保留原始响应(HTTP 状态 + 原文, 供探测快照落 `state.debug`)。
///
/// 真实宿主上出现过「200 但解析结果为空」——那是"字段没认出"还是"宿主真的没配实例"
/// 无法从解析结果区分, 所以探测路径用这个版本把原文样本留下来。
pub fn fetch_instances_detailed() -> Result<(Vec<Instance>, i32, Vec<u8>), ParseFailure> {
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
        .map(|instances| (instances, response.status, response.raw.clone()))
        .map_err(|message| ParseFailure::http(response.status, response.raw.clone(), message))
}

// ─────────────────────────── episodes ───────────────────────────

/// 一次 `emby/episodes` 请求的参数组合(候选矩阵 V1/V2/V3/V5)。
///
/// 真实宿主(2026-10-02 探测)对缺参请求回 400 且点名
/// `{"error":"tmdb_id and total_episodes are required"}` —— 所以每个变体都带
/// `total_episodes`(V5 用备选参数名 `total`)。全部变体都是 GET: 曾经的 V4
/// (POST JSON body)已被宿主权限闸门否决, 见 [`candidates`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeQuery {
    /// `None` = 省略 `proxy_id`(实例 id 为 0 的旧版单实例)。
    pub proxy_id: Option<i64>,
    pub tmdb_id: i64,
    pub season: i64,
    /// 订阅已知总集数; `None` = 省略总数参数(宿主必填, 省略基本必 400, 仅兜底)。
    pub total: Option<i64>,
    /// 见 [`candidates`] 的矩阵(1/2/3/5)。
    pub variant: u8,
}

impl EpisodeQuery {
    /// 该变体的 (tmdb 参数名, season 参数名, 总数参数名)。
    fn keys(&self) -> (&'static str, &'static str, &'static str) {
        match self.variant {
            2 => ("tmdb_id", "season_number", "total_episodes"),
            3 => ("tmdbId", "season", "total_episodes"),
            5 => ("tmdb_id", "season", "total"),
            _ => ("tmdb_id", "season", "total_episodes"),
        }
    }

    /// GET 变体的请求路径(参数全是数字, 无需转义)。
    pub fn path(&self) -> String {
        let (id_key, season_key, total_key) = self.keys();
        let mut path = String::from(EPISODES_PATH);
        path.push('?');
        if let Some(proxy_id) = self.proxy_id {
            path.push_str(&format!("proxy_id={proxy_id}&"));
        }
        path.push_str(&format!("{id_key}={}&{season_key}={}", self.tmdb_id, self.season));
        if let Some(total) = self.total {
            path.push_str(&format!("&{total_key}={total}"));
        }
        path
    }

    /// 执行该变体(GET 查询串)。
    pub fn execute(&self) -> Result<crate::host::HttpResponse, crate::host::HostError> {
        crate::host::get(&self.path())
    }

    /// 参数名列表(写进形状指纹与 debug.attempts[].params)。
    pub fn params_label(&self) -> String {
        let (id_key, season_key, total_key) = self.keys();
        match self.proxy_id {
            Some(_) => format!("proxy_id,{id_key},{season_key},{total_key}"),
            None => format!("{id_key},{season_key},{total_key}"),
        }
    }

    /// 完整指纹的 `params=` 段(带变体号, 缓存命中时按它直接调用)。
    pub fn shape_prefix(&self) -> String {
        format!("params={};v={}", self.params_label(), self.variant)
    }
}

/// 候选矩阵的变体号(与 [`candidates`] 同序)。
///
/// V4(POST JSON body)自 0.1.5 起移除: 宿主的安装期权限闸门只批准 manifest
/// 里声明的 API, 而官方目录里 `emby/episodes` 只有 GET —— POST 每次都被
/// "host API was not approved at installation" 挡下, 是纯白烧(2026-10-07 的
/// 08:00 轮实测 18 次)。矩阵与 [`variant_from_shape`] 共用这份清单, 免得
/// 旧指纹再把一个必被拒的变体排到最前。
pub const CANDIDATE_VARIANTS: [u8; 4] = [1, 2, 3, 5];

/// 参数矩阵: 依可能性排序 V1 → V2 → V3 → V5, 命中即停。
///
/// - V1 GET `tmdb_id`+`season`+`total_episodes`(宿主 400 报错点名的参数);
/// - V2 GET `season_number` 变体; V3 GET `tmdbId` 驼峰变体; V5 GET `total` 变体。
pub fn candidates(tmdb_id: i64, season: i64, proxy_id: Option<i64>, total: Option<i64>) -> Vec<EpisodeQuery> {
    CANDIDATE_VARIANTS
        .into_iter()
        .map(|variant| EpisodeQuery { proxy_id, tmdb_id, season, total, variant })
        .collect()
}

/// 从形状指纹里取出参数组合的变体号(缓存命中时按它直接调用)。
///
/// 优先认 `v=N` 段(只认 [`CANDIDATE_VARIANTS`] 里的变体); 兼容旧指纹(无 `v=`)
/// 按参数名尾缀匹配映射到 GET 变体。
pub fn variant_from_shape(shape: &str) -> Option<u8> {
    if let Some(variant) = shape
        .split(';')
        .find_map(|segment| segment.strip_prefix("v="))
        .and_then(|value| value.parse::<u8>().ok())
    {
        // v=4(POST)是旧版本留下的必败指纹: 当作"没指纹"从矩阵头重试。
        return CANDIDATE_VARIANTS.contains(&variant).then_some(variant);
    }
    let params = shape
        .split(';')
        .find_map(|segment| segment.strip_prefix("params="))?;
    let names: Vec<&str> = params.split(',').collect();
    // 允许带或不带 proxy_id 前缀
    let tail: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| *name != "proxy_id" && !name.starts_with("total"))
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

    /// 该季在 Emby 侧一集都没有(探到了空集): 未收录/未入库, 不是"无缺口"。
    ///
    /// 只读判定, 不改任何解析路径: `have == Some(空集)`(区间契约里的空覆盖串
    /// `covered_episodes:""` 或空数组)。是否同时带缺集列表(`needed_episodes:"1-24"`)
    /// 不影响这个已知事实 —— 缺集列表只是补充证据, 空覆盖仍然是"0 集"。
    /// (解析器把"命中了集列表字段但列表为空"记成 `Some(空集)` 而不是 `None`,
    /// 所以这里能把它与"响应里根本没有逐集信息"严格分开。)
    pub fn is_absent(&self) -> bool {
        self.have.as_ref().map(BTreeSet::is_empty).unwrap_or(false)
    }

    /// 覆盖未知([`Coverage::have_max`] 为 `None`)时的可读原因。
    ///
    /// `have_max = None` 有两种来源, 文案必须分开:
    ///
    /// - `have = Some(空集)`: 解析成功且逐集覆盖**就是空的**(区间契约的
    ///   `covered_episodes:""`)。这是"该季 0 集"的已知事实, 判定层按
    ///   「Emby 该季 0 集」归类, 不走"覆盖未知"; 这里仍给一句真话兜底 ——
    ///   **绝不返回空串**: 空串曾让判定层用"本季未探测成功"这种假话顶上
    ///   (实测缺陷: 探测其实成功, 只是没有逐集明细)。
    /// - `have = None`: 真的没解析出逐集覆盖, 才是"覆盖未知"。
    pub fn unknown_note(&self) -> &'static str {
        if self.have.is_some() {
            "响应里的逐集覆盖是空集(该季 0 集), 没有更细的逐集明细"
        } else if self.missing.is_some() {
            "响应只有缺集列表, 没有逐集覆盖"
        } else {
            "响应里没有逐集覆盖字段"
        }
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

    // 区间式契约(实测宿主形态)优先: `covered_episodes:"1-24"` / `needed_episodes:""`。
    // 两个字段是纯字符串, 命中即建 Coverage; 值解析不了(畸形区间)则落回后面的数组路径。
    for source in [value.as_object(), raw::descend(&value, &["data"]).and_then(Value::as_object)] {
        let Some(obj) = source else { continue };
        let range_have = raw::first_of(obj, RANGE_HAVE_KEYS).and_then(episode_set_of);
        let range_missing = raw::first_of(obj, RANGE_MISSING_KEYS).and_then(episode_set_of);
        if range_have.is_some() || range_missing.is_some() {
            let have_name = RANGE_HAVE_KEYS
                .iter()
                .copied()
                .find(|key| obj.contains_key(*key))
                .unwrap_or("n/a");
            let missing_name = RANGE_MISSING_KEYS
                .iter()
                .copied()
                .find(|key| obj.contains_key(*key))
                .unwrap_or("n/a");
            return Ok(Coverage {
                have: range_have,
                missing: range_missing,
                count_hint: None,
                shape: format!("list={have_name};index=range;missing={missing_name}"),
            });
        }
    }

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

/// 「Emby 里没有这部剧/这一季」的独立分类(只读判定, 绝不改解析路径)。
///
/// 宿主对该端点的业务结构没有契约(openapi-v1.yaml:4332-4352 响应是
/// `GenericHostObject`), "没有该剧"既可能回 404/400、也可能回 200 + 空覆盖:
/// - 200 + 空覆盖由 [`Coverage::is_absent`] 判定;
/// - HTTP 失败只有**正文明确**说"不存在/未收录/not found"时才归到这一类 ——
///   400 参数错误、500 服务端错误等维持 `failed`(不能把宿主故障说成"没有该剧")。
///
/// **空正文的 404 不算证据**: 宿主路由/权限变更让整个端点 404 时同样回空 404,
/// 若一律判"未收录", 整池都会被误报成未收录 —— 而且 absent 条目在 probe_book 里
/// 按"没探过"重新排队(不进 6 小时负缓存), 每小时对每条重复烧探测预算,
/// `last_error` 里也看不到失败。没有正文证据就按失败处理(进负缓存)。
pub fn failure_is_absent(failure: &ParseFailure) -> bool {
    if failure.http_status != 404 && failure.http_status < 400 {
        return false;
    }
    if failure.raw.is_empty() {
        return false;
    }
    let text = String::from_utf8_lossy(&failure.raw).to_ascii_lowercase();
    const MARKERS: [&str; 8] = [
        "没有该剧",
        "该剧不存在",
        "不存在",
        "未收录",
        "未找到",
        "not found",
        "no such",
        "not exist",
    ];
    MARKERS.iter().any(|marker| text.contains(marker))
}

/// 拉取一次覆盖。
///
/// `shape_hint` 非空时先把指纹命中的参数组合排到最前(命中即停, 1 次 host.call);
/// `max_attempts` 是**本次允许发出的 host.call 次数上限**(调用方用它把单轮探测预算
/// 收敛到 `settings.emby_probe_budget` / align-now 的 3 次)。返回实际发出的次数,
/// 调用方据此记账 —— 预算必须按真实调用数扣减。
///
/// 全部尝试失败时返回带原文的 `ParseFailure`(其 `attempts` = 实际调用数)。
pub fn fetch_coverage(
    tmdb_id: i64,
    season: i64,
    proxy_id: Option<i64>,
    total: Option<i64>,
    shape_hint: &str,
    max_attempts: u8,
) -> Result<(Coverage, EpisodeQuery, u8), ParseFailure> {
    if max_attempts == 0 {
        // 预算已经用尽: 一次都不发(这是唯一"零调用失败"的形态)
        return Err(ParseFailure::transport("Emby 探测预算已用尽").with_attempts(0));
    }
    let mut order = candidates(tmdb_id, season, proxy_id, total);
    if let Some(variant) = variant_from_shape(shape_hint) {
        // 指纹命中的组合排到最前(命中即停, 省掉无谓探测)
        if let Some(position) = order.iter().position(|query| query.variant == variant) {
            let preferred = order.remove(position);
            order.insert(0, preferred);
        }
    }
    order.truncate(usize::from(max_attempts.min(5)));

    let mut calls: u8 = 0;
    let mut last: Option<ParseFailure> = None;
    for query in order {
        calls = calls.saturating_add(1);
        let response = match query.execute() {
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
        let queries = candidates(1396, 5, Some(3), Some(12));
        assert_eq!(queries.len(), 4, "矩阵 V1/V2/V3/V5");
        // 顺序按可能性: V1 GET(宿主点名的参数) → V2 → V3 → V5
        assert_eq!(
            queries[0].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season=5&total_episodes=12"
        );
        assert_eq!(queries[0].variant, 1);
        assert_eq!(
            queries[1].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season_number=5&total_episodes=12"
        );
        assert_eq!(
            queries[2].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdbId=1396&season=5&total_episodes=12"
        );
        assert_eq!(
            queries[3].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season=5&total=12",
            "V5 用备选总数参数名 total"
        );
        assert!(
            queries.iter().all(|query| !query.params_label().contains("POST")),
            "0.1.5 起矩阵里没有 POST 变体(宿主的权限闸门只批 GET)"
        );
        // 旧版单实例: 一律省略 proxy_id; total 未知时省略总数参数
        assert_eq!(
            candidates(1396, 5, None, Some(12))[0].path(),
            "/api/plugin-host/emby/episodes?tmdb_id=1396&season=5&total_episodes=12"
        );
        assert_eq!(
            candidates(1396, 5, Some(3), None)[0].path(),
            "/api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season=5"
        );

        // v=N 段优先(新指纹), 参数名尾缀匹配兜底(旧指纹迁移)
        assert_eq!(variant_from_shape("params=proxy_id,tmdb_id,season,total_episodes;v=1;list=items"), Some(1));
        assert_eq!(
            variant_from_shape("params=POST:proxy_id,tmdb_id,season,total_episodes;v=4"),
            None,
            "旧版本缓存的 v=4(POST)指纹不再可用, 必须从矩阵头重试"
        );
        assert_eq!(variant_from_shape("params=proxy_id,tmdb_id,season,total;v=5"), Some(5));
        assert_eq!(variant_from_shape("params=proxy_id,tmdb_id,season;list=items"), Some(1), "旧指纹仍映射到 V1");
        assert_eq!(variant_from_shape("params=tmdb_id,season_number;list=array"), Some(2));
        assert_eq!(variant_from_shape("params=proxy_id,tmdbId,season;list=data.items"), Some(3));
        assert_eq!(variant_from_shape("garbage"), None);
        assert_eq!(variant_from_shape("params=tmdb_id;list=items"), None);
    }

    #[test]
    fn fetch_coverage_never_sends_the_rejected_post_variant() {
        // 曾经有宿主"只吃 POST body"的假设(V4) —— 0.1.5 起不再探测它:
        // 权限闸门在安装期就否决了 POST, 每个变体都是 GET, 全失败就如实报失败。
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 400, br#"{"error":"tmdb_id and total_episodes are required"}"#);
        // 就算宿主对 POST 有响应, 也不该有人去发它
        fake.route_prefix("POST", "POST /api/plugin-host/emby/episodes", 200, &coverage_items_fixture());
        let guard = fake.install();
        let failure = fetch_coverage(1396, 5, Some(3), Some(12), "params=POST:proxy_id,tmdb_id,season,total_episodes;v=4", 5)
            .unwrap_err();
        assert!(failure.message.contains("HTTP 400"), "{}", failure.message);
        assert_eq!(fake.requests().iter().filter(|r| r.method == "POST").count(), 0, "一次 POST 都不许发");
        drop(guard);
    }

    #[test]
    fn coverage_accepts_plain_number_lists() {
        // v0.1.2 新增候选: 裸集号数组字段(真实宿主 200 响应的疑似形态)
        let coverage = parse_coverage(br#"{"episode_numbers":[1,2,3]}"#).unwrap();
        assert_eq!(coverage.have_max(), Some(3));
        assert_eq!(coverage.shape, "list=episode_numbers;index=n/a;missing=n/a");
        let nested = parse_coverage(br#"{"data":{"episode_numbers":["4","5"]}}"#).unwrap();
        assert_eq!(nested.have_max(), Some(5));
        let missing = parse_coverage(br#"{"missing_numbers":[7,9]}"#).unwrap();
        assert_eq!(missing.missing_max(), Some(9));
        let list = parse_coverage(br#"{"data":{"list":[2,4]}}"#).unwrap();
        assert_eq!(list.have_max(), Some(4));
    }

    /// v0.1.3: 真实宿主(2026-10-02)实测的区间串契约, 原样钉死。
    #[test]
    fn coverage_parses_the_range_contract_from_the_live_host() {
        let coverage = parse_coverage(
            br#"{"complete":true,"covered_episodes":"1-24","needed_episodes":"","proxy_id":1,"season":1,"tmdb_id":286988,"total_episodes":24}"#,
        )
        .unwrap();
        assert_eq!(coverage.have_max(), Some(24));
        assert_eq!(coverage.have_count(), Some(24));
        assert!(coverage.covers_range(1, 24), "已齐 1-24");
        assert_eq!(coverage.gap_max(24), 0, "没有超出订阅总集数的缺口");
        assert_eq!(coverage.shape, "list=covered_episodes;index=range;missing=needed_episodes");

        // 缺口方向: 空覆盖 + 缺 1-24
        let empty = parse_coverage(br#"{"complete":false,"covered_episodes":"","needed_episodes":"1-24"}"#).unwrap();
        assert_eq!(empty.have_count(), Some(0), "空串 = 一集都没有(已知事实)");
        assert_eq!(empty.missing_max(), Some(24));
        assert_eq!(empty.gap_max(10), 24);

        // 多段区间 + data 下探 + 数组形态的宽容
        let multi = parse_coverage(br#"{"covered_episodes":"1,3,5-7"}"#).unwrap();
        assert_eq!(multi.have_count(), Some(5));
        assert!(!multi.covers_range(1, 2), "缺 2");
        let nested = parse_coverage(br#"{"data":{"needed_episodes":"9-12"}}"#).unwrap();
        assert_eq!(nested.missing_max(), Some(12));
        let as_array = parse_coverage(br#"{"covered_episodes":["1","2"]}"#).unwrap();
        assert_eq!(as_array.have_max(), Some(2));
    }

    #[test]
    fn range_contract_rejects_malformed_segments() {
        // 畸形区间: 整体未识别, 但允许落回数组路径(这里没有数组字段 → Err)
        assert!(parse_coverage(br#"{"covered_episodes":"1-2-3"}"#).is_err());
        assert!(parse_coverage(br#"{"covered_episodes":"5-1"}"#).is_err());
        assert!(parse_coverage(br#"{"covered_episodes":"x"}"#).is_err());
    }

    #[test]
    fn fetch_coverage_uses_shape_hint_first_and_probes_on_failure() {
        let fake = FakeHost::new();
        // V2(season_number)才是对的: 指纹命中时 1 次调用就够
        fake.route_prefix(
            "GET",
            "GET /api/plugin-host/emby/episodes?proxy_id=3&tmdb_id=1396&season_number",
            200,
            &coverage_items_fixture(),
        );
        // 其它组合返回不可解析的 body
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, br#"{"count":3}"#);
        let guard = fake.install();

        let (coverage, query, calls) = fetch_coverage(
            1396,
            5,
            Some(3),
            Some(12),
            "params=proxy_id,tmdb_id,season_number;list=items",
            3,
        )
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
        let failure = fetch_coverage(1396, 5, Some(3), None, "", 1).unwrap_err();
        assert_eq!(failure.attempts, 1);
        assert_eq!(crate::host::observed_calls() - before, 1, "预算 1 → 只许 1 次 host.call");
        drop(guard);

        // 预算 0: 一次都不发
        let fake = FakeHost::new();
        let guard = fake.install();
        let before = crate::host::observed_calls();
        let failure = fetch_coverage(1396, 5, Some(3), None, "", 0).unwrap_err();
        assert_eq!(failure.attempts, 0);
        assert_eq!(crate::host::observed_calls() - before, 0);
        assert!(failure.message.contains("预算"), "{}", failure.message);
        drop(guard);

        // 预算 9 → 最多 4 次(矩阵只有 4 个组合, 全是 GET; POST 变体已随 V4 移除)
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, br#"{"count":3}"#);
        fake.route_prefix("POST", "POST /api/plugin-host/emby/episodes", 200, br#"{"count":9}"#);
        let guard = fake.install();
        let before = crate::host::observed_calls();
        let failure = fetch_coverage(1396, 5, None, Some(12), "", 9).unwrap_err();
        assert_eq!(failure.attempts, 4);
        assert_eq!(crate::host::observed_calls() - before, 4);
        drop(guard);
    }

    #[test]
    fn fetch_coverage_reports_failure_with_raw_sample() {
        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 200, b"<html>nope</html>");
        fake.route_prefix("POST", "POST /api/plugin-host/emby/episodes", 200, b"<html>nope</html>");
        let guard = fake.install();
        let failure = fetch_coverage(1396, 5, Some(3), None, "", 3).unwrap_err();
        assert_eq!(failure.http_status, 200);
        assert_eq!(failure.kind(), "unparsed");
        assert_eq!(failure.attempts, 3, "预算 3 就只试 3 个变体");
        assert!(failure.message.contains("未识别"), "{}", failure.message);
        assert!(failure.sample().contains("nope"));
        drop(guard);

        let fake = FakeHost::new();
        fake.route_prefix("GET", "GET /api/plugin-host/emby/episodes?", 503, b"");
        fake.route_prefix("POST", "POST /api/plugin-host/emby/episodes", 503, b"");
        let guard = fake.install();
        let failure = fetch_coverage(1396, 5, None, None, "", 3).unwrap_err();
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
            Some(12),
            "params=proxy_id,tmdb_id,season_number;list=items",
            3,
        )
        .unwrap();
        assert_eq!(calls, 2, "指纹失效后要退回矩阵重探一次");
        assert_eq!(query.variant, 1);
        assert_eq!(coverage.have_max(), Some(3));
        assert!(
            coverage.shape.starts_with("params=proxy_id,tmdb_id,season,total_episodes;v=1;"),
            "{}",
            coverage.shape
        );
        assert_eq!(crate::host::observed_calls() - before, 2);
        drop(guard);
    }

    #[test]
    fn fetch_coverage_reports_transport_failures_without_panicking() {
        let fake = FakeHost::new();
        fake.fail_all(true);
        let guard = fake.install();
        let failure = fetch_coverage(1396, 5, Some(3), None, "", 3).unwrap_err();
        assert_eq!(failure.kind(), "http_error", "传输层失败也归 http_error");
        assert_eq!(failure.attempts, 3, "预算 3: 每个候选都要记一次尝试");
        assert!(failure.message.contains("Emby 覆盖请求失败"), "{}", failure.message);
        assert!(failure.sample().is_empty(), "传输失败没有原文可留");
        drop(guard);
    }

    // ── 「Emby 没有这部剧/这一季」的独立分类(只读) ──

    #[test]
    fn is_absent_only_for_a_known_empty_season() {
        // 200 + 空逐集列表 → 探到了空集
        let empty = parse_coverage(br#"{"items":[]}"#).unwrap();
        assert_eq!(empty.have, Some(BTreeSet::new()));
        assert_eq!(empty.have_count(), Some(0));
        assert!(empty.is_absent());
        // 裸空数组同样算"探到了空"
        assert!(parse_coverage(b"[]").unwrap().is_absent());
        // 实测宿主的区间契约: covered_episodes 与 needed_episodes 都是空串
        let ranges = parse_coverage(br#"{"covered_episodes":"","needed_episodes":""}"#).unwrap();
        assert_eq!(ranges.have, Some(BTreeSet::new()));
        assert!(ranges.is_absent());
        // 实测宿主形态: 空覆盖 + 非空缺集列表(needed_episodes:"1-24")同样是
        // "该季 0 集"的已知事实 —— 缺集列表只是补充证据, 不能据此把探测成功
        // 说成"覆盖未知"(判定层旧实现就是这么报的, 已修)。
        let empty_covered_with_needed =
            parse_coverage(br#"{"complete":false,"covered_episodes":"","needed_episodes":"1-24"}"#)
                .unwrap();
        assert!(empty_covered_with_needed.is_absent());
        assert_eq!(empty_covered_with_needed.have_count(), Some(0));
        // have_max 为 None 的两种来源都必须有真话兜底: 空串曾让判定层用
        // "本季未探测成功"顶上(探测其实成功), 这里钉死绝不返回空串。
        assert!(
            !empty_covered_with_needed.unknown_note().is_empty(),
            "空覆盖也要给可读原因, 空串会变成假话的温床"
        );
        assert!(
            empty_covered_with_needed.unknown_note().contains("空集"),
            "{}",
            empty_covered_with_needed.unknown_note()
        );
        // 有集号 → 不是 absent
        assert!(!parse_coverage(br#"{"items":[{"index_number":1}]}"#).unwrap().is_absent());
        assert!(!parse_coverage(br#"{"covered_episodes":"1-24","needed_episodes":""}"#)
            .unwrap()
            .is_absent());
        // 只有缺集列表(没有逐集覆盖) → 是"未知", 不是"空"
        let missing_only = parse_coverage(br#"{"missing":[12]}"#).unwrap();
        assert_eq!(missing_only.have, None);
        assert!(!missing_only.is_absent());
        assert_eq!(missing_only.unknown_note(), "响应只有缺集列表, 没有逐集覆盖");
        // `{"missing":[]}` 走区间路径时同样没有逐集覆盖 → 未知
        let empty_missing = parse_coverage(br#"{"missing":[]}"#).unwrap();
        assert!(!empty_missing.is_absent());
        assert_eq!(empty_missing.unknown_note(), "响应只有缺集列表, 没有逐集覆盖");
    }

    #[test]
    fn failure_is_absent_only_with_explicit_evidence() {
        // 404 空正文: **没有证据**, 按失败处理 —— 宿主路由/权限整体 404 时也是空正文,
        // 判成"未收录"会让整池误报、不进负缓存、每小时重复烧预算(实测缺陷)。
        assert!(!failure_is_absent(&ParseFailure::http(404, Vec::new(), "Emby 覆盖 HTTP 404")));
        // 404 正文明确"不存在" → 才是未收录
        assert!(failure_is_absent(&ParseFailure::http(
            404,
            br#"{"error":"no such show"}"#.to_vec(),
            "Emby 覆盖 HTTP 404"
        )));
        // 400 正文明确"没有该剧" → 归未收录
        assert!(failure_is_absent(&ParseFailure::http(
            400,
            r#"{"error":"没有该剧"}"#.as_bytes().to_vec(),
            "Emby 覆盖 HTTP 400"
        )));
        assert!(failure_is_absent(&ParseFailure::http(
            404,
            br#"{"message":"Not Found"}"#.to_vec(),
            "Emby 覆盖 HTTP 404"
        )));
        // 400 空正文 / 500 / 400 其它原因 → 维持 failed(不许把宿主故障说成没有该剧)
        assert!(!failure_is_absent(&ParseFailure::http(400, Vec::new(), "Emby 覆盖 HTTP 400")));
        assert!(!failure_is_absent(&ParseFailure::http(
            400,
            br#"{"error":"missing parameter total_episodes"}"#.to_vec(),
            "Emby 覆盖 HTTP 400"
        )));
        assert!(!failure_is_absent(&ParseFailure::http(500, b"boom".to_vec(), "Emby 覆盖 HTTP 500")));
        // 传输失败(无状态码)不算
        assert!(!failure_is_absent(&ParseFailure::transport("Emby 覆盖请求失败")));
        // 200 但结构未识别不算
        assert!(!failure_is_absent(&ParseFailure::http(200, b"nope".to_vec(), "结构未识别")));
    }
}
