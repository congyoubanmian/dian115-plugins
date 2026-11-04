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
  /** 会员/付费标识：'' | 'vip' | 'svip' | 'paid'（付费专辑）。 */
  vip?: string
}

/** 会员档位信息（lib/vip.js）。 */
export interface VipInfo {
  /** svip / vip / music_package / none / unknown（QQ 字段未识别时）。 */
  tier: string
  level: number
  /** 到期时间（毫秒），0 表示未知。 */
  expire_ms: number
  /** 官方会员图标 URL，无则空串。 */
  icon: string
  /** 次级会员包标签（如黑胶 VIP、音乐包）。 */
  secondary: string[]
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
  /** QQ 才有：有账号标识（encryptUin）—— 收藏歌单 / 我喜欢接口的 uin 参数要用它。 */
  has_account_id?: boolean
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

/** 歌单条目（网易云 / QQ 通用投影）。 */
export interface PlaylistItem {
  id: string
  name: string
  cover: string
  count: number
  creator: string
  /** QQ 才有：'created' 我创建的 / 'fav' 收藏的 / 'liked' 我喜欢；网易云没有这个维度。 */
  kind?: string
  /** QQ 才有：私有歌单（QQ 的 dirShow=2）。 */
  private?: boolean
  /** 特殊入口标记（'daily' 每日推荐 / 'liked' 我喜欢）：不是普通歌单，走各自的后端接口。 */
  special?: string
}

/**
 * 打开中的歌单视图。
 *
 * target 是「取曲目的目标」，两个来源的语义不同：
 * - 网易云：歌单 id（数字字符串）；
 * - QQ：歌单 tid，或特殊入口 'daily'（每日推荐）/ 'liked'（我喜欢）。
 */
export interface PlaylistView {
  /** 歌单 id（网易云 = 歌单 id；QQ 特殊入口 = 'daily' / 'liked'）。 */
  id: string
  name: string
  /** 所属来源：netease / qq。 */
  source: string
  /** 取曲目的目标（见上）。 */
  target: string
  /** 特殊入口标记（'daily' / 'liked'）；普通歌单为空串。 */
  special?: string
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
