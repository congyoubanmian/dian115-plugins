// 下载管线设置 —— 从 plugins/music-rs/src/download.rs 的 Settings/settings_view/settings_update
// 移植。v3 变化（架构使然，详见 README）：
// - `staging_dir` 移除：v3 的插件自有文件目录（downloads/）就是暂存区（developer-guide §文件与 CD2）；
// - CookieCloud 三项移除：宿主新规约下插件不读 CookieCloud，登录态只来自扫码或手动粘贴；
// - CD2 直送五项移除：v3 宿主文件操作自动按 CD2 挂载前缀分流，不再需要插件直连 gRPC-Web。

/** 最终落点默认值（与 sidecar MUSIC_MOUNT + DL_SUBDIR 一致）。 */
export const DEFAULT_TARGET_DIR = '/CloudNAS/115open/音乐/音乐下载'
/** 默认音质（网易档位；QQ 用 master/flac/320/128 裁剪取链阶梯）。 */
export const DEFAULT_QUALITY = 'jymaster'
/** 默认并发（与 sidecar MAX_CONCURRENT_DOWNLOADS 默认一致；v3 里是「单轮最多新开几首」）。 */
export const DEFAULT_MAX_ACTIVE = 2
/** max_active 的接受上限（防止一轮跑过多下载）。 */
export const MAX_ACTIVE_CAP = 16

/** 设置白名单（settings_update 接受的键；KV 里多出的未知键原样保留）。 */
const PATCH_KEYS = ['target_dir', 'quality', 'max_active', 'notify_on_fail']

/** 目录去掉结尾的 `/`（根目录保留），避免拼出 `dir//name`。 */
function trimTrailingSlash(dir) {
  return dir.replace(/\/+$/, '') || '/'
}

/** 读取设置（ctx.settings.get() 的结果叠加默认值；缺失/类型不符回默认）。 */
export function normalizeSettings(saved) {
  const raw = saved && typeof saved === 'object' ? saved : {}
  const targetDir = typeof raw.target_dir === 'string' && raw.target_dir.trim() !== ''
    ? trimTrailingSlash(raw.target_dir.trim())
    : DEFAULT_TARGET_DIR
  const quality = typeof raw.quality === 'string' && raw.quality.trim() !== ''
    ? raw.quality.trim()
    : DEFAULT_QUALITY
  let maxActive = Number(raw.max_active)
  if (!Number.isInteger(maxActive) || maxActive <= 0 || maxActive > MAX_ACTIVE_CAP) {
    maxActive = DEFAULT_MAX_ACTIVE
  }
  return {
    target_dir: targetDir,
    quality,
    max_active: maxActive,
    notify_on_fail: raw.notify_on_fail !== false,
  }
}

/** 设置的可展示形态（state 响应 / 保存返回）。v3 无宿主绝对路径过滤，路径原样展示。 */
export function settingsView(settings) {
  const s = normalizeSettings(settings)
  return {
    target_dir: s.target_dir,
    quality: s.quality,
    max_active: s.max_active,
    notify_on_fail: s.notify_on_fail,
  }
}

/** 合并设置补丁（action settings-update）：只接受类型正确的已知键，非法值忽略。 */
export function applySettingsPatch(current, patch) {
  const settings = normalizeSettings(current)
  const input = patch && typeof patch === 'object' ? patch : {}
  const next = { ...settings }
  if (typeof input.target_dir === 'string' && input.target_dir.trim() !== '') {
    next.target_dir = trimTrailingSlash(input.target_dir.trim())
  }
  if (typeof input.quality === 'string' && input.quality.trim() !== '') {
    next.quality = input.quality.trim()
  }
  if (typeof input.max_active === 'number' && Number.isInteger(input.max_active)) {
    if (input.max_active >= 1 && input.max_active <= MAX_ACTIVE_CAP) next.max_active = input.max_active
  }
  if (typeof input.notify_on_fail === 'boolean') next.notify_on_fail = input.notify_on_fail
  // 丢弃白名单之外的键（旧键 cookiecloud_* / cd2_* / staging_dir 在 v3 无意义）。
  const cleaned = {}
  for (const key of PATCH_KEYS) cleaned[key] = next[key]
  return cleaned
}
