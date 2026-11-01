// 音乐下载页面用到的数据类型（页面自己的投影，不改变插件 lib/ 的契约形状）。
//
// 这些形状与 v3/music-rs/lib 的返回一致：
// - Song：搜索/歌单里的一首歌（mapSearchSong / parseSongDetail 的映射结果）；
// - TaskEntry：任务索引条目（tasks-core.js indexEntryOf 的九键投影）；
// - LoginInfo：登录态摘要（cookies.js neteaseLoginInfo / qqLoginInfo，绝不回显 cookie 值）；
// - MusicSettings：设置视图（settings.js settingsView）。

/** 一首歌（搜索结果 / 歌单曲目）。 */
export interface Song {
  id: string | number
  name: string
  singers: string
  album: string
  cover?: string
  /** netease / qq；缺失时由页面按当前来源补。 */
  source?: string
  /** 该曲可选音质（歌单曲目带，搜索结果不带）。 */
  qualities?: string[]
  /** 默认音质。 */
  quality?: string
}

/** 任务索引条目。 */
export interface TaskEntry {
  id: string
  status: string
  source?: string
  song_id?: string
  name?: string
  singers?: string
  quality?: string
  error?: string
  updated_ms?: number
}

/** 登录态摘要。 */
export interface LoginInfo {
  logged_in: boolean
  uin?: string
  has_music_u?: boolean
  has_key?: boolean
  source?: string
  error?: string
}

/** 设置视图。 */
export interface MusicSettings {
  target_dir: string
  quality: string
  max_active: number
  notify_on_fail: boolean
}

/** 运行日志条目（KV logs）。 */
export interface LogEntry {
  at: string
  level: string
  message: string
}

/** 歌单条目。 */
export interface PlaylistItem {
  id: string
  name: string
  cover: string
  count: number
  creator: string
}

/** 一次队列推进的状态摘要（KV state.last_pump）。 */
export interface PumpState {
  at?: string
  messages?: string[]
}

/** 页面提示（右下角 toast）。 */
export interface Toast {
  id: number
  kind: 'success' | 'error' | 'warning' | 'info'
  message: string
}

/**
 * 扫码状态机（页面自己的一份投影，后端返回的 status 归一到这几种）：
 * - ''：还没生成二维码；
 * - waiting：等待扫码；
 * - scanned：已扫码，待手机确认；
 * - success：登录成功（后端确认拿到了登录凭据）；
 * - no-login：扫码完成但没拿到登录凭据 —— 如实提示，不冒充登录成功；
 * - expired：二维码已过期；
 * - failed：轮询/状态异常。
 */
export type QrStatus = '' | 'waiting' | 'scanned' | 'success' | 'no-login' | 'expired' | 'failed'

/** 一次二维码的生命周期（网易云 unikey 会话 / QQ 官方 PNG 二维码）。 */
export interface QrSession {
  /** netease / qq。 */
  source: string
  /** 轮询用的不透明句柄（网易云 unikey / QQ 随机 key），不是凭据。 */
  key: string
  /** 本地编码用的内容（网易云登录页 URL）；QQ 走图片二维码，没有这个字段。 */
  content?: string
  /** PNG 的 data URL（QQ 官方二维码图片）。 */
  image?: string
  /** 过期时刻（毫秒时间戳）。 */
  expiresAt: number
}

/** 扫码轮询结果（两个来源同形）。 */
export interface QrPollResult {
  status: QrStatus
  message?: string
  /** 后端确认是否真的拿到了登录凭据（没有这个字段就按 false 处理）。 */
  logged_in?: boolean
  /** 登录成功但收尾没做完时的告警（如宿主会话里的 QQ 授权 Cookie 没清掉）。 */
  warning?: string
}
