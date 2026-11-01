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
