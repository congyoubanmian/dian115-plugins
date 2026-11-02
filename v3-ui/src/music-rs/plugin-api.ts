// 页面 → 插件后端模块的唯一入口（页面不改业务逻辑，只换界面层）。
//
// 这里直接把插件自己的 lib/ 与 jobs/ 模块重新导出：页面与后台任务共用同一份业务逻辑
// （搜索、扫码、取链入队、Cookie 清洗、队列 CAS……），界面层不复制、不改写它们。
// 打包时（vite.base.config.mjs）这些模块会被内联进 v3/music-rs/ui/page.js，产物自包含；
// 插件的 jobs/ 仍在运行时按相对路径 import 同一份源码——逻辑只有一份，页面只是它的另一个调用方。
//
// @ts-nocheck：这些是插件目录里的纯 JS 模块（v3/music-rs/lib/*.js），仓库的 tsconfig 没有开
// allowJs，TS 无法为它们生成类型。本文件只做转调，调用点的形状在 types.ts 与调用处约定。

// @ts-nocheck
export { buildDeps, readSettings } from '../../../v3/music-rs/jobs/runtime.js'
export {
  normalizeSettings,
  applySettingsPatch,
  settingsView,
  MAX_ACTIVE_CAP,
  DEFAULT_QUALITY,
  DEFAULT_TARGET_DIR,
} from '../../../v3/music-rs/lib/settings.js'
export { LEVELS, LEVELS_ASCENDING, qualitiesForLevel } from '../../../v3/music-rs/lib/eapi.js'
export {
  neteaseSearch,
  neteaseQrCreate,
  neteaseQrPoll,
  neteasePlaylists,
  neteasePlaylistSongs,
  neteasePlaylistIndex,
  neteasePlaylistSongsFromIndex,
  qqSearch,
  qqQrCreate,
  qqQrPoll,
  qqPlaylists,
  qqPlaylistSongs,
  qqPlaylistSongsPage,
  qqDailyRecommendations,
  qqLikedSongs,
  qqLibraryInfo,
  loadCookies,
  saveCookies,
  imageDataUrl,
} from '../../../v3/music-rs/lib/music-api.js'
export {
  cleanNeteaseCookieString,
  cleanQqCookieString,
  neteaseLoginInfo,
  qqLoginInfo,
  normalizeCookies,
} from '../../../v3/music-rs/lib/cookies.js'
export { enqueue, retry, adopt, clearFinished, loadIndex } from '../../../v3/music-rs/lib/queue-store.js'
export { queuePlaylistPages, PLAYLIST_QUEUE_DEFAULT_PAGES } from '../../../v3/music-rs/lib/queue-pages.js'
export { PLAYLIST_PAGE_SIZE } from '../../../v3/music-rs/lib/constants.js'
export { addLog, loadLogs } from '../../../v3/music-rs/lib/logs.js'
export { stateView, STATUS_QUEUED, MAX_ATTEMPTS } from '../../../v3/music-rs/lib/tasks-core.js'
export { encodeQr, qrSvgPath } from '../../../v3/music-rs/ui/qr.js'
