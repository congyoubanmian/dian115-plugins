// 辅种助手（reseed.puppy）前端页面 v0.6.0
// 对齐 DIAN115 v3 插件设计体系（共享 --app-* 令牌、明暗主题、Hero 页头、Bento 指标瓦片、滑出抽屉）。

const BUILTIN_SITES = [
  { id: 'soulvoice', name: '聆音 SoulVoice', url: 'https://pt.soulvoice.club', api: 'https://pt.soulvoice.club/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['pt.soulvoice.club', 'soulvoice.club'] },
  { id: 'hhanclub', name: '憨憨 HHanClub', url: 'https://hhanclub.net', api: 'https://hhanclub.net/nexusapi/pieces-hash', dialect: 'nexusapi', trackerDomains: ['hhanclub.net', 'hhan.club', 'tracker.hhan.club', 'hhanclub.top'] },
  { id: 'agsvpt', name: 'AGSVPT', url: 'https://www.agsvpt.com', api: 'https://www.agsvpt.com/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['agsvpt.com', 'www.agsvpt.com', 'agsvpt.trackers.work', 'agsvpt.work', 'agsvpt.cn', 'tracker.agsvpt.cn'] },
  { id: 'carpt', name: '车站 CarPT', url: 'https://carpt.net', api: 'https://carpt.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['carpt.net', 'tracker.carpt.net'] },
  { id: 'hdkylin', name: '麒麟 HDKylin', url: 'https://www.hdkyl.in', api: 'https://www.hdkyl.in/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdkyl.in', 'www.hdkyl.in', 'tracker.hdkyl.in', 'hdkylin.top', 'www.hdkylin.top'] },
  { id: 'zmpt', name: '织梦 ZMPT', url: 'https://zmpt.cc', api: 'https://zmpt.cc/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['zmpt.cc'] },
  { id: 'hdfans', name: 'HDFans', url: 'https://hdfans.org', api: 'https://hdfans.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdfans.org'] },
  { id: 'wintersakura', name: '冬樱 WinterSakura', url: 'https://wintersakura.net', api: 'https://wintersakura.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['wintersakura.net', 'tracker.wintersakura.net'] },
  { id: 'crabpt', name: '蟹黄堡 CrabPT', url: 'https://crabpt.vip', api: 'https://crabpt.vip/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['crabpt.vip'] },
  { id: 'gamegamept', name: 'GGPT 游戏', url: 'https://www.gamegamept.com', api: 'https://www.gamegamept.com/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['gamegamept.com', 'www.gamegamept.com'] },
  { id: 'qingwa', name: '青蛙 QingWa', url: 'https://www.qingwapt.org', api: 'https://www.qingwapt.org/api/pieces-hash', dialect: 'auto', trackerDomains: ['qingwapt.org', 'www.qingwapt.org', 'qingwapt.com', 'newqingwa.com'] },
  { id: 'ubits', name: 'UBits', url: 'https://ubits.club', api: 'https://ubits.club/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['ubits.club'] },
  { id: 'hdhome', name: '家园 HDHome', url: 'https://hdhome.org', api: 'https://hdhome.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdhome.org'] },
  { id: 'hdtime', name: 'HDTime', url: 'https://hdtime.org', api: 'https://hdtime.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['hdtime.org'] },
  { id: 'cyanbug', name: '大青虫 CyanBug', url: 'https://cyanbug.net', api: 'https://cyanbug.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['cyanbug.net'] },
  { id: 'ptcafe', name: 'PTCafe 咖啡', url: 'https://ptcafe.club', api: 'https://ptcafe.club/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['ptcafe.club'] },
  { id: 'kufei', name: '库非 KuFei', url: 'https://kufei.org', api: 'https://kufei.org/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['kufei.org'] },
  { id: 'oshen', name: '奥申 Oshen', url: 'https://www.oshen.win', api: 'https://www.oshen.win/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['oshen.win', 'www.oshen.win'] },
  { id: 'ultrahd', name: 'UltraHD', url: 'https://ultrahd.net', api: 'https://ultrahd.net/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['ultrahd.net'] },
  { id: 'leaves', name: '红叶 Leaves', url: 'https://leaves.red', api: '', dialect: 'auto', trackerDomains: ['leaves.red'] },
  { id: 'piggo', name: '猪猪 PigGo', url: 'https://piggo.me', api: 'https://api.piggo.me/api/pieces-hash', dialect: 'nexusphp', trackerDomains: ['piggo.me', 'api.piggo.me'] },
  { id: 'keepfrds', name: '月月 KeepFRDS', url: 'https://pt.keepfrds.com', api: 'https://pt.keepfrds.com/api/torrents/pieces-hash', dialect: 'nexusphp', trackerDomains: ['pt.keepfrds.com', 'keepfrds.com'] },
  { id: 'ptlsp', name: 'PTLSP', url: 'https://www.ptlsp.com', api: '', dialect: 'auto', trackerDomains: ['ptlsp.com', 'www.ptlsp.com', 'tracker.ptlsp.com', 'x.ptlsp.com'] },
  { id: '1ptba', name: '1PTBA', url: 'https://1ptba.com', api: '', dialect: 'auto', trackerDomains: ['1ptba.com'] },
  { id: 'rousi', name: '肉丝 RouSi', url: 'https://rousi.pro', api: '', dialect: 'auto', trackerDomains: ['rousi.pro', 'rousi.zip'] },
  { id: 'hdpt', name: '明教 HDPT', url: 'https://hdpt.xyz', api: '', dialect: 'auto', trackerDomains: ['hdpt.xyz'] },
  { id: '2xfree', name: '2xFree', url: 'https://pt.2xfree.org', api: '', dialect: 'auto', trackerDomains: ['2xfree.org', 'pt.2xfree.org'] },
  { id: '3wmg', name: '3WMG 芒果', url: 'https://3wmg.com', api: '', dialect: 'auto', trackerDomains: ['3wmg.com', 'www.3wmg.com'] }
]

const DEPRECATED_HOSTS = new Set(['hhanclub.top', 'www.hdkylin.top', 'hdkylin.top', 'rousi.zip', 'www.3wmg.com', 'www.qingwapt.com', 'qingwapt.com'])
const FLUX_NAMES = new Set([])

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c])
}

function fmtBytes(n) {
  const num = Number(n) || 0
  if (num <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = num
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return (v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(2)) + ' ' + units[i]
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19)
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtPct(p) {
  const n = Number(p)
  if (!Number.isFinite(n)) return '0%'
  return Math.round(Math.max(0, Math.min(1, n)) * 100) + '%'
}

function resolveDialect(s) {
  const d = String(s.dialect || 'auto').trim().toLowerCase()
  if (['nexusphp', 'nexusapi', 'flux', 'custom'].includes(d)) return d
  const name = String(s.name || '').trim()
  const pk = String(s.passkey || '').trim()
  const api = String(s.api || '').trim()
  if (pk.startsWith('fxo_') || /\/crossseed\//i.test(api)) return 'flux'
  if (!pk && FLUX_NAMES.has(name)) return 'flux'
  if (/\/nexusapi\//i.test(api) || name === '憨憨' || name === 'hhanclub') return 'nexusapi'
  return 'nexusphp'
}

function dialectLabel(d) {
  if (d === 'flux') return 'FluxTorrent'
  if (d === 'nexusapi') return 'NexusAPI'
  if (d === 'custom') return '自定义'
  return 'NexusPHP'
}

function inferApiUrl(s) {
  const api = String(s.api || '').trim()
  if (api) return api
  const base = String(s.url || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  const d = resolveDialect(s)
  if (d === 'flux') return base + '/api/v1/crossseed/lookup'
  if (d === 'nexusapi') return base + '/nexusapi/pieces-hash'
  return base + '/api/pieces-hash'
}

function inferDownloadPreview(s) {
  const tpl = String(s.downloadTemplate || '').trim()
  if (tpl) return tpl
  const base = String(s.url || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (resolveDialect(s) === 'flux') return base + '/api/v1/crossseed/dl/{id}  (Header: Authorization: Token ...)'
  return base + '/download.php?id={id}&passkey={passkey}'
}

function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return h === 'localhost' || h === '::1' || h.startsWith('127.') || h.startsWith('10.') ||
      h.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  } catch {
    return false
  }
}

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3)
}

function integrityMeta(code) {
  switch (code) {
    case 'complete': return { label: '磁盘已校验', cls: 'ok' }
    case 'downloader_complete': return { label: '下载器 100%', cls: 'ok' }
    case 'unchecked': return { label: '未校验', cls: 'muted' }
    case 'size_mismatch': return { label: '大小不符', cls: 'err' }
    case 'partial': return { label: '数据不全', cls: 'warn' }
    case 'missing': return { label: '文件缺失', cls: 'err' }
    case 'unlinked': return { label: '未关联下载器', cls: 'muted' }
    default: return { label: code || '未知', cls: 'muted' }
  }
}

function matchStatusMeta(status) {
  switch (status) {
    case 'candidate': return { label: '可辅种', cls: 'accent' }
    case 'added': return { label: '已推送', cls: 'ok' }
    case 'already_existed': return { label: '已存在', cls: 'teal' }
    case 'cached': return { label: '已辅种', cls: 'ok' }
    case 'seeding': return { label: '已做种', cls: 'muted' }
    case 'failed': return { label: '失败', cls: 'err' }
    default: return { label: status || '未知', cls: 'muted' }
  }
}

const CSS = `
.rs-page{
  --rs-accent:var(--app-accent,#2080f0);
  --rs-accent-2:color-mix(in oklab,var(--rs-accent) 68%,#18a058);
  --rs-bg:var(--app-bg,#f5f6f8);
  --rs-surface:var(--app-surface,#ffffff);
  --rs-text:var(--app-text,#1f2329);
  --rs-muted:var(--app-text-secondary,#6b7280);
  --rs-border:var(--app-border,#e3e6eb);
  --rs-soft:color-mix(in srgb,var(--rs-text) 3.5%,var(--rs-surface));
  --rs-tint:color-mix(in srgb,var(--rs-accent) 10%,var(--rs-surface));
  --rs-ok:color-mix(in srgb,#18a058 84%,var(--rs-text));
  --rs-warn:color-mix(in srgb,#e69818 84%,var(--rs-text));
  --rs-err:color-mix(in srgb,#d03050 84%,var(--rs-text));
  --rs-teal:color-mix(in srgb,#0ea5a4 84%,var(--rs-text));
  --rs-orange:color-mix(in srgb,#ea580c 84%,var(--rs-text));
  --rs-shadow:color-mix(in srgb,var(--rs-text) 14%,transparent);
  --rs-scrim:color-mix(in srgb,var(--rs-text) 36%,transparent);
  --rs-r:16px;
  --rs-r-sm:10px;
  --rs-ease:cubic-bezier(.2,.8,.2,1);
  --rs-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  height:100%;width:100%;min-width:0;box-sizing:border-box;overflow:auto;
  overscroll-behavior-y:contain;color:var(--rs-text);background:var(--rs-bg);
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  padding:14px;
}
.rs-page[data-theme="dark"]{
  --rs-soft:color-mix(in srgb,var(--rs-text) 4.5%,var(--rs-surface));
  --rs-shadow:rgba(0,0,0,.5);
  --rs-scrim:rgba(0,0,0,.62);
}
.rs-page *{box-sizing:border-box}
.rs-shell{container:rspage / inline-size;display:grid;gap:14px;max-width:1440px;margin:0 auto;min-width:0;padding-bottom:24px}

/* Hero Header */
.rs-hero{
  position:relative;isolation:isolate;overflow:hidden;
  display:grid;grid-template-columns:minmax(0,1fr);gap:12px 18px;
  padding:18px 20px;border-radius:20px;
  border:1px solid color-mix(in srgb,var(--rs-accent) 26%,var(--rs-border));
  background:
    radial-gradient(110% 150% at 0% 0%,color-mix(in srgb,var(--rs-accent) 20%,transparent),transparent 56%),
    radial-gradient(90% 140% at 100% 0%,color-mix(in srgb,#18a058 14%,transparent),transparent 58%),
    linear-gradient(135deg,color-mix(in srgb,var(--rs-surface) 92%,transparent),color-mix(in srgb,var(--rs-surface) 74%,transparent));
  box-shadow:inset 0 1px 0 color-mix(in srgb,var(--rs-surface) 70%,transparent),0 14px 36px -24px var(--rs-shadow);
}
.rs-hero-art{
  position:absolute;z-index:-1;right:-36px;top:-54px;width:230px;height:230px;pointer-events:none;
  fill:none;stroke:color-mix(in srgb,var(--rs-accent) 24%,transparent);stroke-width:1.1;stroke-dasharray:4 6;
}
.rs-hero-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.rs-brand{display:flex;align-items:center;gap:12px;min-width:0}
.rs-brand-icon{
  width:46px;height:46px;flex:none;border-radius:14px;display:grid;place-items:center;color:#fff;
  background:linear-gradient(135deg,var(--rs-accent),var(--rs-accent-2));
  box-shadow:0 8px 22px -6px color-mix(in srgb,var(--rs-accent) 62%,transparent),inset 0 1px 0 rgba(255,255,255,.35);
}
.rs-brand-text{min-width:0}
.rs-brand-title{margin:0;font-size:21px;font-weight:750;line-height:1.2;letter-spacing:-.01em;color:var(--rs-text)}
@supports ((-webkit-background-clip:text) or (background-clip:text)){
  .rs-brand-title{
    background:linear-gradient(90deg,var(--rs-text),color-mix(in srgb,var(--rs-accent) 72%,var(--rs-text)));
    -webkit-background-clip:text;background-clip:text;color:transparent;
  }
}
.rs-brand-sub{margin:3px 0 0;font-size:12px;color:var(--rs-muted)}
.rs-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rs-capsules{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rs-cap{
  display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:500;
  border:1px solid var(--rs-border);background:color-mix(in srgb,var(--rs-surface) 76%,transparent);color:var(--rs-text);
}
.rs-cap-ok{border-color:color-mix(in srgb,var(--rs-ok) 35%,var(--rs-border));color:var(--rs-ok)}
.rs-cap-warn{border-color:color-mix(in srgb,var(--rs-warn) 38%,var(--rs-border));color:var(--rs-warn)}
.rs-cap-accent{border-color:color-mix(in srgb,var(--rs-accent) 35%,var(--rs-border));color:var(--rs-accent)}
.rs-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.rs-hero-bar{position:absolute;left:0;right:0;bottom:0;height:3px;overflow:hidden;background:color-mix(in srgb,var(--rs-accent) 14%,transparent)}
.rs-hero-bar::after{
  content:"";position:absolute;inset:0 auto 0 0;width:38%;border-radius:3px;
  background:linear-gradient(90deg,transparent,var(--rs-accent),transparent);
  animation:rs-indet 1.25s var(--rs-ease) infinite;
}
@keyframes rs-indet{from{transform:translateX(-110%)}to{transform:translateX(270%)}}

/* Buttons */
.rs-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  min-height:38px;padding:0 13px;border-radius:10px;font:inherit;font-size:13px;font-weight:550;
  border:1px solid var(--rs-border);background:var(--rs-surface);color:var(--rs-text);
  cursor:pointer;transition:border-color .18s,background-color .18s,transform .15s,box-shadow .18s;white-space:nowrap;
}
.rs-btn:hover:not(:disabled){border-color:var(--rs-accent);color:var(--rs-accent)}
.rs-btn:active:not(:disabled){transform:translateY(1px)}
.rs-btn:disabled{opacity:.5;cursor:not-allowed}
.rs-btn-primary{
  background:linear-gradient(135deg,var(--rs-accent),color-mix(in srgb,var(--rs-accent) 82%,#0b5ed7));
  border-color:transparent;color:#fff;
  box-shadow:0 6px 18px -8px color-mix(in srgb,var(--rs-accent) 78%,transparent);
}
.rs-btn-primary:hover:not(:disabled){color:#fff;filter:brightness(1.06)}
.rs-btn-ok{
  background:color-mix(in srgb,var(--rs-ok) 12%,var(--rs-surface));
  border-color:color-mix(in srgb,var(--rs-ok) 36%,var(--rs-border));color:var(--rs-ok);
}
.rs-btn-ok:hover:not(:disabled){background:color-mix(in srgb,var(--rs-ok) 20%,var(--rs-surface));color:var(--rs-ok);border-color:var(--rs-ok)}
.rs-btn-danger{color:var(--rs-err);border-color:color-mix(in srgb,var(--rs-err) 30%,var(--rs-border))}
.rs-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--rs-err) 10%,var(--rs-surface));color:var(--rs-err);border-color:var(--rs-err)}
.rs-btn-sm{min-height:30px;padding:0 10px;font-size:12px;border-radius:8px}
.rs-btn-xs{min-height:24px;padding:0 8px;font-size:11px;border-radius:6px}
.rs-btn-nav{min-height:44px;min-width:44px}

/* Progress banner */
.rs-banner{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;
  padding:11px 14px;border-radius:12px;font-size:13px;
  background:color-mix(in srgb,var(--rs-accent) 9%,var(--rs-surface));
  border:1px solid color-mix(in srgb,var(--rs-accent) 28%,var(--rs-border));color:var(--rs-text);
}
.rs-banner-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.rs-spinner{
  width:15px;height:15px;flex:none;border-radius:50%;
  border:2px solid color-mix(in srgb,var(--rs-accent) 25%,transparent);border-top-color:var(--rs-accent);
  animation:rs-spin .85s linear infinite;
}
@keyframes rs-spin{to{transform:rotate(360deg)}}
.rs-prog-track{width:140px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--rs-text) 10%,transparent);overflow:hidden;flex:none}
.rs-prog-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--rs-accent),var(--rs-accent-2));transition:width .25s ease}

/* Bento KPI Tiles */
.rs-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.rs-kpi{
  --tone:var(--rs-accent);
  position:relative;display:grid;gap:3px;align-content:start;padding:13px 14px 12px 16px;
  border-radius:14px;text-align:left;font:inherit;color:inherit;cursor:pointer;overflow:hidden;
  border:1px solid var(--rs-border);
  background:
    radial-gradient(120% 90% at 100% 0%,color-mix(in srgb,var(--tone) 12%,transparent),transparent 62%),
    var(--rs-surface);
  transition:transform .2s var(--rs-ease),border-color .2s,box-shadow .2s;
}
.rs-kpi::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:linear-gradient(180deg,var(--tone),color-mix(in srgb,var(--tone) 18%,transparent))}
.rs-kpi:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--tone) 45%,var(--rs-border));box-shadow:0 10px 24px -16px var(--tone)}
.rs-kpi-ok{--tone:var(--rs-ok)}
.rs-kpi-warn{--tone:var(--rs-warn)}
.rs-kpi-err{--tone:var(--rs-err)}
.rs-kpi-teal{--tone:var(--rs-teal)}
.rs-kpi-muted{--tone:var(--rs-muted)}
.rs-kpi-label{font-size:12px;color:var(--rs-muted);font-weight:500}
.rs-kpi-val{font-size:26px;font-weight:750;line-height:1.15;font-variant-numeric:tabular-nums;color:var(--rs-text)}
.rs-kpi-hint{font-size:11px;color:var(--rs-muted)}

/* Tabs */
.rs-tabs-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.rs-tabs{
  display:inline-flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:14px;
  background:var(--rs-surface);border:1px solid var(--rs-border);
}
.rs-tab{
  display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 14px;border-radius:10px;
  border:1px solid transparent;background:transparent;color:var(--rs-muted);font:inherit;font-size:13px;font-weight:600;
  cursor:pointer;transition:background-color .18s,color .18s,border-color .18s;
}
.rs-tab:hover{color:var(--rs-text)}
.rs-tab.active{
  background:var(--rs-tint);color:var(--rs-accent);
  border-color:color-mix(in srgb,var(--rs-accent) 28%,var(--rs-border));
}
.rs-tab-badge{
  font-size:11px;font-weight:650;padding:1px 6px;border-radius:999px;font-variant-numeric:tabular-nums;
  background:color-mix(in srgb,var(--rs-text) 8%,transparent);color:inherit;
}
.rs-tab.active .rs-tab-badge{background:color-mix(in srgb,var(--rs-accent) 18%,transparent)}

/* Card / Panel */
.rs-card{
  background:var(--rs-surface);border:1px solid var(--rs-border);border-radius:var(--rs-r);
  padding:16px;display:grid;gap:12px;min-width:0;
  box-shadow:0 1px 2px color-mix(in srgb,var(--rs-text) 4%,transparent),0 12px 30px -26px var(--rs-shadow);
}
.rs-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px}
.rs-card-title{margin:0;font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.rs-muted{color:var(--rs-muted);font-size:12px}

/* Inputs & Toolbars */
.rs-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rs-input,.rs-select,.rs-textarea{
  font:inherit;font-size:13px;color:var(--rs-text);background:var(--rs-bg);
  border:1px solid var(--rs-border);border-radius:10px;padding:8px 11px;min-height:38px;
  transition:border-color .18s;
}
.rs-input:focus,.rs-select:focus,.rs-textarea:focus{outline:none;border-color:var(--rs-accent)}
.rs-textarea{min-height:76px;resize:vertical;width:100%}
.rs-toolbar .rs-search{flex:1 1 220px;min-width:160px}
.rs-toolbar .rs-select{flex:0 1 170px}

.rs-seg{display:inline-flex;padding:2px;gap:2px;border-radius:10px;background:var(--rs-soft);border:1px solid var(--rs-border)}
.rs-seg button{border:0;background:transparent;color:var(--rs-muted);padding:5px 10px;border-radius:8px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.rs-seg button.active{background:var(--rs-surface);color:var(--rs-accent);box-shadow:0 1px 3px color-mix(in srgb,var(--rs-text) 10%,transparent)}

/* Batch bar */
.rs-batch{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;
  padding:10px 14px;border-radius:12px;
  background:color-mix(in srgb,var(--rs-accent) 7%,var(--rs-soft));
  border:1px dashed color-mix(in srgb,var(--rs-accent) 36%,var(--rs-border));
}

/* Pills & Badges */
.rs-pill{
  display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;
  border:1px solid var(--rs-border);background:var(--rs-soft);color:var(--rs-text);line-height:1.4;
}
.rs-pill-ok{color:var(--rs-ok);background:color-mix(in srgb,var(--rs-ok) 10%,transparent);border-color:color-mix(in srgb,var(--rs-ok) 28%,transparent)}
.rs-pill-accent{color:var(--rs-accent);background:color-mix(in srgb,var(--rs-accent) 10%,transparent);border-color:color-mix(in srgb,var(--rs-accent) 30%,transparent)}
.rs-pill-warn{color:var(--rs-warn);background:color-mix(in srgb,var(--rs-warn) 10%,transparent);border-color:color-mix(in srgb,var(--rs-warn) 30%,transparent)}
.rs-pill-err{color:var(--rs-err);background:color-mix(in srgb,var(--rs-err) 10%,transparent);border-color:color-mix(in srgb,var(--rs-err) 30%,transparent)}
.rs-pill-teal{color:var(--rs-teal);background:color-mix(in srgb,var(--rs-teal) 10%,transparent);border-color:color-mix(in srgb,var(--rs-teal) 30%,transparent)}
.rs-pill-muted{color:var(--rs-muted);background:var(--rs-soft);border-color:var(--rs-border)}
.rs-pill-qb{color:var(--rs-accent);background:color-mix(in srgb,var(--rs-accent) 12%,transparent);border-color:color-mix(in srgb,var(--rs-accent) 32%,transparent)}
.rs-pill-tr{color:var(--rs-orange);background:color-mix(in srgb,var(--rs-orange) 12%,transparent);border-color:color-mix(in srgb,var(--rs-orange) 32%,transparent)}

/* Torrent Cards */
.rs-tlist{display:grid;gap:10px}
.rs-tcard{
  --stripe:var(--rs-border);
  position:relative;display:grid;gap:10px;padding:13px 14px 13px 16px;border-radius:14px;
  border:1px solid var(--rs-border);background:var(--rs-soft);overflow:hidden;
  transition:border-color .18s,box-shadow .18s;
}
.rs-tcard::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--stripe)}
.rs-tcard:hover{border-color:color-mix(in srgb,var(--rs-accent) 32%,var(--rs-border))}
.rs-tcard.has-cand{--stripe:var(--rs-accent)}
.rs-tcard.has-fail{--stripe:var(--rs-err)}
.rs-tcard.all-ok{--stripe:var(--rs-ok)}
.rs-tcard-head{display:flex;align-items:flex-start;gap:10px;justify-content:space-between}
.rs-tcard-left{display:flex;align-items:flex-start;gap:10px;min-width:0;flex:1}
.rs-tcard-left input[type=checkbox]{width:18px;height:18px;margin-top:2px;accent-color:var(--rs-accent);flex:none;cursor:pointer}
.rs-tcard-name{font-weight:650;font-size:14px;overflow-wrap:anywhere;line-height:1.35}
.rs-tcard-meta{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:4px;font-size:12px;color:var(--rs-muted);align-items:center}
.rs-code{font-family:var(--rs-mono);font-size:11px;padding:1px 6px;border-radius:6px;background:color-mix(in srgb,var(--rs-text) 6%,transparent);color:var(--rs-muted)}

.rs-tcard-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;padding-top:8px;border-top:1px dashed var(--rs-border)}
.rs-subblock{display:grid;gap:6px;align-content:start}
.rs-subblock-title{font-size:11px;font-weight:650;color:var(--rs-muted);text-transform:uppercase;letter-spacing:.03em}
.rs-client-row{
  display:grid;gap:3px;padding:7px 10px;border-radius:10px;background:var(--rs-surface);border:1px solid var(--rs-border);font-size:12px;
}
.rs-client-top{display:flex;flex-wrap:wrap;align-items:center;gap:6px;justify-content:space-between}
.rs-path{font-family:var(--rs-mono);font-size:11px;color:var(--rs-muted);overflow-wrap:anywhere}

.rs-matches{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rs-match-chip{
  display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:10px;font-size:12px;
  border:1px solid var(--rs-border);background:var(--rs-surface);
}
.rs-match-chip.is-candidate{border-color:color-mix(in srgb,var(--rs-accent) 40%,var(--rs-border));background:color-mix(in srgb,var(--rs-accent) 6%,var(--rs-surface))}
.rs-match-chip.is-added,.rs-match-chip.is-cached{border-color:color-mix(in srgb,var(--rs-ok) 35%,var(--rs-border))}
.rs-match-chip.is-failed{border-color:color-mix(in srgb,var(--rs-err) 40%,var(--rs-border));background:color-mix(in srgb,var(--rs-err) 5%,var(--rs-surface))}
.rs-match-err{font-size:11px;color:var(--rs-err);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Table View */
.rs-table-wrap{overflow-x:auto;border:1px solid var(--rs-border);border-radius:12px}
.rs-table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:760px}
.rs-table th{
  text-align:left;padding:9px 10px;background:var(--rs-soft);color:var(--rs-muted);font-weight:650;font-size:12px;
  border-bottom:1px solid var(--rs-border);white-space:nowrap;
}
.rs-table td{padding:9px 10px;border-bottom:1px solid var(--rs-border);vertical-align:top}
.rs-table tr:last-child td{border-bottom:0}
.rs-table tr:hover td{background:color-mix(in srgb,var(--rs-accent) 3%,transparent)}

/* Site & Downloader Grids */
.rs-grid-2{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:12px}
.rs-entity{
  display:grid;gap:10px;padding:14px;border-radius:14px;border:1px solid var(--rs-border);background:var(--rs-soft);
  transition:border-color .18s;
}
.rs-entity.is-enabled{background:var(--rs-surface);border-color:color-mix(in srgb,var(--rs-accent) 32%,var(--rs-border))}
.rs-entity-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.rs-entity-title{font-weight:700;font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rs-entity-url{font-family:var(--rs-mono);font-size:11.5px;color:var(--rs-muted);overflow-wrap:anywhere}
.rs-entity-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px dashed var(--rs-border)}

/* Toggle switch */
.rs-switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;user-select:none}
.rs-switch input{appearance:none;width:36px;height:20px;border-radius:999px;background:var(--rs-border);position:relative;cursor:pointer;transition:background-color .2s;margin:0;flex:none}
.rs-switch input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.22)}
.rs-switch input:checked{background:var(--rs-accent)}
.rs-switch input:checked::after{transform:translateX(16px)}

/* Timeline Logs */
.rs-logs{list-style:none;margin:0;padding:0 0 0 4px;display:grid;gap:0;font-size:12.5px}
.rs-logs li{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:10px;align-items:baseline;padding:6px 0;position:relative}
.rs-logs li::before{content:"";position:absolute;left:3px;top:0;bottom:0;width:1px;background:var(--rs-border)}
.rs-logs li:first-child::before{top:50%}
.rs-logs li:last-child::before{bottom:50%}
.rs-log-dot{width:7px;height:7px;border-radius:50%;background:var(--rs-accent);position:relative;align-self:center;box-shadow:0 0 0 3px color-mix(in srgb,var(--rs-accent) 16%,transparent)}
.rs-log-warning .rs-log-dot{background:var(--rs-warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--rs-warn) 18%,transparent)}
.rs-log-error .rs-log-dot{background:var(--rs-err);box-shadow:0 0 0 3px color-mix(in srgb,var(--rs-err) 18%,transparent)}
.rs-log-time{font-family:var(--rs-mono);font-size:11px;color:var(--rs-muted);white-space:nowrap}
.rs-log-msg{overflow-wrap:anywhere}

/* Empty state */
.rs-empty{
  padding:32px 18px;text-align:center;border-radius:14px;border:1px dashed var(--rs-border);
  background:var(--rs-soft);color:var(--rs-muted);display:grid;gap:8px;justify-items:center;
}
.rs-empty strong{color:var(--rs-text);font-size:14px}

/* Drawer / Modal */
.rs-overlay{
  position:fixed;inset:0;z-index:80;background:var(--rs-scrim);backdrop-filter:blur(3px);
  display:grid;justify-items:end;
}
.rs-drawer{
  width:min(500px,95vw);height:100%;background:var(--rs-surface);color:var(--rs-text);
  border-left:1px solid var(--rs-border);box-shadow:-12px 0 40px -12px var(--rs-shadow);
  display:grid;grid-template-rows:auto minmax(0,1fr) auto;
}
.rs-drawer-head{
  display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;
  border-bottom:1px solid var(--rs-border);
  background:linear-gradient(135deg,color-mix(in srgb,var(--rs-accent) 10%,transparent),transparent 70%);
}
.rs-drawer-head h3{margin:0;font-size:16px;font-weight:700}
.rs-drawer-body{overflow-y:auto;padding:16px 18px;display:grid;gap:12px;align-content:start}
.rs-drawer-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--rs-border)}

.rs-field{display:grid;gap:5px}
.rs-field label{font-size:12.5px;font-weight:600;color:var(--rs-text)}
.rs-field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.rs-help{font-size:11.5px;color:var(--rs-muted);line-height:1.45}
.rs-preview-box{
  padding:8px 10px;border-radius:10px;background:var(--rs-soft);border:1px solid var(--rs-border);
  font-family:var(--rs-mono);font-size:11px;color:var(--rs-muted);overflow-wrap:anywhere;display:grid;gap:4px;
}
.rs-map-row{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:center}

/* Toast */
.rs-toasts{position:fixed;top:14px;right:14px;z-index:100;display:grid;gap:8px;max-width:min(360px,90vw);pointer-events:none}
.rs-toast{
  pointer-events:auto;padding:10px 14px;border-radius:12px;font-size:13px;font-weight:550;
  background:var(--rs-surface);color:var(--rs-text);border:1px solid var(--rs-border);
  box-shadow:0 12px 30px -12px var(--rs-shadow);display:flex;align-items:center;gap:8px;
}
.rs-toast-ok{border-color:color-mix(in srgb,var(--rs-ok) 45%,var(--rs-border));color:var(--rs-ok)}
.rs-toast-err{border-color:color-mix(in srgb,var(--rs-err) 45%,var(--rs-border));color:var(--rs-err)}
.rs-toast-warn{border-color:color-mix(in srgb,var(--rs-warn) 45%,var(--rs-border));color:var(--rs-warn)}

@media(max-width:640px){
  .rs-page{padding:8px}
  .rs-hero{padding:14px}
  .rs-field-row{grid-template-columns:1fr}
  .rs-map-row{grid-template-columns:1fr}
}
@media(pointer:coarse){
  .rs-page :is(input,textarea,select){font-size:max(16px,1em)}
  .rs-btn{min-height:44px}
}
`

const BRAND_SVG = `<svg width="24" height="24" viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <path d="M18 25a14 14 0 0 1 25.2-8.4L47 21" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M47 12v9h-9" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M46 39a14 14 0 0 1-25.2 8.4L17 43" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M17 52v-9h9" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="32" cy="32" r="5" fill="currentColor"/>
</svg>`

const HERO_ART = `<svg class="rs-hero-art" viewBox="0 0 240 240" aria-hidden="true">
  <circle cx="120" cy="120" r="108"/>
  <circle cx="120" cy="120" r="76"/>
  <circle cx="120" cy="120" r="44"/>
</svg>`

export function mount(element, ctx) {
  const root = document.createElement('div')
  root.className = 'rs-page'
  const styleEl = document.createElement('style')
  styleEl.textContent = CSS
  element.replaceChildren(styleEl, root)

  const state = {
    tab: 'torrents',        // 'torrents' | 'sites' | 'downloaders' | 'logs'
    viewMode: 'cards',      // 'cards' | 'table'
    loading: true,
    busyTask: null,         // { id, job, stage, progress, message, status }
    pollTimer: null,
    settings: {
      torrentDirs: '',
      dryRun: true,
      autoEnabled: false,
      autoMode: 'scan',
      skipIncomplete: true,
      batchSize: 100,
      rateLimitMs: 300,
      defaultTags: '辅种',
      defaultPaused: false,
      defaultSkipChecking: true
    },
    sites: [],
    downloaders: [],
    probeResults: {},       // downloaderId -> { ok, version, torrents, error, loading }
    siteProbes: {},         // siteId -> { ok, message, loading }
    dirProbes: null,        // [{ dir, ok, count, error }]
    data: null,             // reseed:state
    // filters
    q: '',
    statusFilter: 'all',    // all | candidate | seeded | failed | incomplete
    dlFilter: 'all',
    siteFilter: 'all',
    siteSearch: '',
    siteTabFilter: 'all',   // all | enabled | custom
    selectedKeys: new Set(), // 'fp::siteId::dlId'
    // drawers
    drawer: null,           // null | { kind: 'settings' } | { kind: 'site', index, draft } | { kind: 'downloader', index, draft }
    toasts: [],
    lastNotice: null        // { kind: 'ok'|'err'|'warn', text }
  }

  let unsubTheme = null
  if (ctx.theme) {
    if (ctx.theme.mode) root.dataset.theme = ctx.theme.mode
    if (typeof ctx.theme.subscribe === 'function') {
      unsubTheme = ctx.theme.subscribe((mode) => {
        root.dataset.theme = mode || 'light'
      })
    }
  }

  function toast(kind, text) {
    state.lastNotice = { kind, text }
    const id = uid('t')
    state.toasts.push({ id, kind, text })
    if (state.toasts.length > 4) state.toasts.shift()
    renderToasts()
    setTimeout(() => {
      state.toasts = state.toasts.filter((t) => t.id !== id)
      renderToasts()
    }, 5200)
  }

  function renderToasts() {
    let host = root.querySelector('[data-toasts]')
    if (!host) return
    host.innerHTML = state.toasts.map((t) =>
      `<div class="rs-toast rs-toast-${esc(t.kind)}">${esc(t.text)}</div>`
    ).join('')
  }

  function normalizeSiteLocal(raw, idx) {
    const url = String(raw.url || raw.siteUrl || '').trim().replace(/\/+$/, '')
    const name = String(raw.name || '').trim()
    const trackers = Array.isArray(raw.trackerDomains)
      ? raw.trackerDomains.map((x) => String(x || '').trim()).filter(Boolean)
      : String(raw.trackerDomains || '').split(/[\s,;，]+/).map((x) => x.trim()).filter(Boolean)
    return {
      id: String(raw.id || '').trim() || uid('site'),
      name: name || url || ('站点-' + (idx + 1)),
      url,
      api: String(raw.api || raw.apiUrl || '').trim(),
      dialect: String(raw.dialect || 'auto').trim().toLowerCase(),
      passkey: String(raw.passkey || '').trim(),
      downloadTemplate: String(raw.downloadTemplate || '').trim(),
      trackerDomains: trackers,
      enabled: !!raw.enabled,
      custom: !!raw.custom
    }
  }

  function normalizeDlLocal(raw, idx) {
    const type = String(raw.type || '').toLowerCase() === 'transmission' ? 'transmission' : 'qbittorrent'
    const maps = Array.isArray(raw.pathMaps)
      ? raw.pathMaps.filter((m) => m && (m.from || m.to)).map((m) => ({ from: String(m.from || '').trim(), to: String(m.to || '').trim() }))
      : []
    const tDirs = Array.isArray(raw.torrentDirs)
      ? raw.torrentDirs.filter(Boolean)
      : String(raw.torrentDirs || '').split('\n').map((s) => s.trim()).filter(Boolean)
    return {
      id: String(raw.id || '').trim() || uid(type === 'transmission' ? 'tr' : 'qb'),
      name: String(raw.name || '').trim() || (type === 'transmission' ? 'Transmission' : 'qBittorrent'),
      type,
      url: String(raw.url || '').trim().replace(/\/+$/, ''),
      username: String(raw.username || ''),
      password: String(raw.password || ''),
      enabled: raw.enabled !== false,
      paused: raw.paused === true,
      skipChecking: raw.skipChecking !== false,
      tags: Array.isArray(raw.tags) ? raw.tags.join(',') : String(raw.tags ?? '辅种'),
      torrentDirs: tDirs,
      pathMaps: maps
    }
  }

  async function loadAll() {
    state.loading = true
    try {
      const [savedSettings, storedSites, storedDls, storedState] = await Promise.all([
        ctx.settings.get().catch(() => ({})),
        ctx.storage.get('sites').catch(() => null),
        ctx.storage.get('downloaders').catch(() => null),
        ctx.storage.get('reseed:state').catch(() => null)
      ])
      state.settings = {
        torrentDirs: String(savedSettings?.torrentDirs || ''),
        dryRun: savedSettings?.dryRun !== false,
        autoEnabled: savedSettings?.autoEnabled === true,
        autoMode: savedSettings?.autoMode === 'reseed' ? 'reseed' : 'scan',
        skipIncomplete: savedSettings?.skipIncomplete !== false,
        batchSize: Number(savedSettings?.batchSize) || 100,
        rateLimitMs: Number(savedSettings?.rateLimitMs) || 300,
        defaultTags: String(savedSettings?.defaultTags ?? '辅种'),
        defaultPaused: savedSettings?.defaultPaused === true,
        defaultSkipChecking: savedSettings?.defaultSkipChecking !== false
      }

      if (Array.isArray(storedSites) && storedSites.length) {
        state.sites = storedSites.map((s, i) => normalizeSiteLocal(s, i))
      } else {
        state.sites = BUILTIN_SITES.map((s, i) => normalizeSiteLocal({ ...s, passkey: '', enabled: false }, i))
      }

      if (Array.isArray(storedDls) && storedDls.length) {
        state.downloaders = storedDls.map((d, i) => normalizeDlLocal(d, i))
      } else {
        const migrated = []
        if (savedSettings?.qbUrl || savedSettings?.qbEnabled) {
          migrated.push(normalizeDlLocal({
            id: 'qb-main', name: 'qBittorrent', type: 'qbittorrent',
            url: savedSettings.qbUrl || '', username: savedSettings.qbUsername || '',
            password: savedSettings.qbPassword || '', enabled: !!savedSettings.qbEnabled
          }, 0))
        }
        if (savedSettings?.trUrl || savedSettings?.trEnabled) {
          migrated.push(normalizeDlLocal({
            id: 'tr-main', name: 'Transmission', type: 'transmission',
            url: savedSettings.trUrl || '', username: savedSettings.trUsername || '',
            password: savedSettings.trPassword || '', enabled: !!savedSettings.trEnabled
          }, 1))
        }
        state.downloaders = migrated
      }

      state.data = storedState && typeof storedState === 'object' ? storedState : null
    } catch (err) {
      toast('err', '加载配置失败：' + (err?.message || err))
    } finally {
      state.loading = false
      render()
    }
  }

  async function saveSites() {
    const clean = state.sites.map((s) => ({
      id: s.id,
      name: String(s.name || '').trim(),
      url: String(s.url || '').trim().replace(/\/+$/, ''),
      api: String(s.api || '').trim(),
      dialect: s.dialect || 'auto',
      passkey: String(s.passkey || '').trim(),
      downloadTemplate: String(s.downloadTemplate || '').trim(),
      trackerDomains: Array.isArray(s.trackerDomains) ? s.trackerDomains : [],
      enabled: !!s.enabled,
      custom: !!s.custom
    }))
    await ctx.storage.set('sites', clean)
  }

  async function saveDownloaders() {
    const clean = state.downloaders.map((d) => ({
      id: d.id,
      name: String(d.name || '').trim(),
      type: d.type === 'transmission' ? 'transmission' : 'qbittorrent',
      url: String(d.url || '').trim().replace(/\/+$/, ''),
      username: String(d.username || ''),
      password: String(d.password || ''),
      enabled: !!d.enabled,
      paused: !!d.paused,
      skipChecking: !!d.skipChecking,
      tags: String(d.tags || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
      torrentDirs: Array.isArray(d.torrentDirs) ? d.torrentDirs.filter(Boolean) : [],
      pathMaps: Array.isArray(d.pathMaps) ? d.pathMaps.filter((m) => m.from && m.to) : []
    }))
    await ctx.storage.set('downloaders', clean)
  }

  async function saveSettings() {
    await ctx.settings.set({
      torrentDirs: state.settings.torrentDirs,
      dryRun: !!state.settings.dryRun,
      autoEnabled: !!state.settings.autoEnabled,
      autoMode: state.settings.autoMode === 'reseed' ? 'reseed' : 'scan',
      skipIncomplete: !!state.settings.skipIncomplete,
      batchSize: Math.max(1, Math.min(500, Number(state.settings.batchSize) || 100)),
      rateLimitMs: Math.max(0, Math.min(10000, Number(state.settings.rateLimitMs) || 300)),
      defaultTags: String(state.settings.defaultTags || '辅种'),
      defaultPaused: !!state.settings.defaultPaused,
      defaultSkipChecking: !!state.settings.defaultSkipChecking
    })
  }

  async function runQuickProbe(payload) {
    const task = await ctx.tasks.run('reseed-probe', 'probe:' + Date.now() + ':' + Math.random().toString(36).slice(2, 6), payload)
    for (let i = 0; i < 40; i++) {
      if (ctx.signal && ctx.signal.aborted) throw new Error('已取消')
      await new Promise((r) => setTimeout(r, 450))
      const cur = await ctx.tasks.get(task.id)
      const st = String(cur?.status || cur?.state || '').toLowerCase()
      if (['completed', 'success', 'succeeded', 'done'].includes(st)) {
        return cur?.result || cur?.output || {}
      }
      if (['failed', 'error', 'cancelled', 'canceled', 'attention_required'].includes(st)) {
        throw new Error(cur?.error || cur?.message || st)
      }
    }
    throw new Error('探测超时')
  }

  // 通过后台 probe 任务测试 BT 下载器连通性（复用 lib/downloaders 统一协议实现）
  async function probeDownloader(dl) {
    state.probeResults[dl.id] = { loading: true }
    render()
    try {
      const r = await runQuickProbe({ kind: 'downloader', downloader: dl })
      state.probeResults[dl.id] = { ok: true, version: r.version || '', torrents: Number(r.torrents || 0) }
      toast('ok', dl.name + ' 连接成功（' + (r.version || dl.type) + '，' + (r.torrents ?? 0) + ' 个种子）')
    } catch (err) {
      const msg = err?.message || String(err)
      state.probeResults[dl.id] = { ok: false, error: msg }
      toast('err', dl.name + ' 测试失败：' + msg)
    }
    render()
  }

  // 通过后台 probe 任务测试单个站点的 pieces-hash 接口
  async function probeSite(site) {
    state.siteProbes[site.id] = { loading: true }
    render()
    try {
      const r = await runQuickProbe({ kind: 'site', site })
      state.siteProbes[site.id] = {
        ok: true,
        message: '接口正常（HTTP ' + (r.status || 200) + '，' + dialectLabel(r.dialect) + '）'
      }
      toast('ok', site.name + ' 接口测试通过')
    } catch (err) {
      const msg = err?.message || String(err)
      state.siteProbes[site.id] = { ok: false, message: msg }
      toast('err', site.name + ' 测试失败：' + msg)
    }
    render()
  }

  function extractFileItems(res) {
    if (Array.isArray(res)) return res
    if (Array.isArray(res?.items)) return res.items
    if (Array.isArray(res?.result)) return res.result
    if (Array.isArray(res?.result?.items)) return res.result.items
    if (Array.isArray(res?.entries)) return res.entries
    if (Array.isArray(res?.files)) return res.files
    if (Array.isArray(res?.data)) return res.data
    if (Array.isArray(res?.data?.items)) return res.data.items
    return []
  }

  // 探测种子目录可读性与 .torrent 文件数
  async function probeTorrentDirs() {
    const dirs = String(state.settings.torrentDirs || '').split('\n').map((s) => s.trim()).filter(Boolean)
    if (!dirs.length) {
      toast('warn', '请先填写至少一个种子目录')
      return
    }
    state.dirProbes = dirs.map((dir) => ({ dir, loading: true }))
    render()
    const results = []
    for (const dir of dirs) {
      try {
        const res = await ctx.files.call({ operation: 'list', path: dir, limit: 100000 })
        const items = extractFileItems(res)
        const cnt = items.filter((it) => it && !it.is_dir && /\.torrent$/i.test(it.name || it.path || '')).length
        const diag = !items.length && res && typeof res === 'object' ? (' [keys:' + Object.keys(res).join(',') + ']') : ''
        results.push({ dir, ok: true, count: cnt, total: items.length, diag })
      } catch (err) {
        results.push({ dir, ok: false, error: err?.message || String(err) })
      }
    }
    state.dirProbes = results
    render()
  }

  // 从 DIAN115 宿主导入已有 PT 站点（仅取站点名与域名，不含敏感凭据）
  async function importHostSites() {
    try {
      const res = await ctx.api.get('/api/pt/sites')
      const list = Array.isArray(res) ? res : (res?.sites || res?.data || [])
      if (!Array.isArray(list) || !list.length) {
        toast('warn', '宿主 PT 站点列表为空')
        return
      }
      const existingUrls = new Set(state.sites.map((s) => String(s.url || '').replace(/\/+$/, '').toLowerCase()))
      let added = 0
      for (const item of list) {
        const url = String(item.url || item.domain || item.site_url || '').trim().replace(/\/+$/, '')
        if (!url) continue
        const fullUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url
        if (existingUrls.has(fullUrl.toLowerCase())) continue
        existingUrls.add(fullUrl.toLowerCase())
        state.sites.push(normalizeSiteLocal({
          name: item.name || item.site_name || fullUrl,
          url: fullUrl,
          api: '',
          dialect: 'auto',
          passkey: '',
          enabled: false,
          custom: true
        }, state.sites.length))
        added++
      }
      await saveSites()
      render()
      toast(added ? 'ok' : 'warn', added ? ('已从宿主导入 ' + added + ' 个站点（请补充 Passkey 后启用）') : '宿主站点均已在列表中')
    } catch (err) {
      toast('err', '读取宿主 PT 站点失败：' + (err?.message || err))
    }
  }

  function pollTask(taskId, jobName) {
    if (state.pollTimer) clearTimeout(state.pollTimer)
    let ticks = 0
    const tick = async () => {
      if (ctx.signal && ctx.signal.aborted) return
      ticks++
      try {
        const task = await ctx.tasks.get(taskId)
        const st = String(task?.status || task?.state || '').toLowerCase()
        state.busyTask = {
          id: taskId,
          job: jobName,
          status: st,
          stage: task?.stage || '',
          progress: Number(task?.progress || 0),
          message: task?.message || task?.stage || st
        }
        if (['completed', 'success', 'succeeded', 'done'].includes(st)) {
          state.busyTask = null
          state.selectedKeys.clear()
          await loadAll()
          toast('ok', jobName === 'reseed-apply' ? '定向辅种已完成' : '扫描辅种任务已完成')
          return
        }
        if (['failed', 'error', 'cancelled', 'canceled', 'attention_required'].includes(st)) {
          const reason = task?.error || task?.message || st
          state.busyTask = null
          await loadAll()
          toast('err', '任务未完成：' + reason)
          return
        }
        render()
      } catch (err) {
        state.busyTask = null
        render()
        toast('err', '轮询任务状态失败：' + (err?.message || err))
        return
      }
      if (ticks < 600) state.pollTimer = setTimeout(tick, 1400)
    }
    state.pollTimer = setTimeout(tick, 900)
  }

  async function startJob(mode) {
    if (state.busyTask) {
      toast('warn', '已有任务在运行，请稍候')
      return
    }
    state.busyTask = {
      id: '',
      job: 'reseed',
      status: 'submitting',
      stage: mode === 'scan' ? '扫描预览' : '一键辅种',
      progress: 1,
      message: '正在保存配置并提交任务…'
    }
    render()
    try {
      await Promise.all([saveSettings(), saveSites(), saveDownloaders()])
      const task = await ctx.tasks.run('reseed', 'reseed:' + mode + ':' + Date.now(), { mode })
      state.busyTask = {
        id: task.id,
        job: 'reseed',
        status: 'running',
        stage: mode === 'scan' ? '扫描预览' : '一键辅种',
        progress: 5,
        message: '任务已提交，等待执行…'
      }
      render()
      pollTask(task.id, 'reseed')
    } catch (err) {
      state.busyTask = null
      toast('err', '启动任务失败：' + (err?.data?.error || err?.message || err))
      render()
    }
  }

  async function applyTargets(targets) {
    if (!targets.length) {
      toast('warn', '请先选择要辅种的站点条目')
      return
    }
    if (state.busyTask) {
      toast('warn', '已有任务在运行，请稍候')
      return
    }
    try {
      await Promise.all([saveSettings(), saveSites(), saveDownloaders()])
      const task = await ctx.tasks.run('reseed-apply', 'apply:' + Date.now(), { targets })
      state.busyTask = {
        id: task.id,
        job: 'reseed-apply',
        status: 'running',
        stage: '推送辅种',
        progress: 5,
        message: '正在推送 ' + targets.length + ' 项辅种…'
      }
      render()
      pollTask(task.id, 'reseed-apply')
    } catch (err) {
      toast('err', '推送辅种失败：' + (err?.message || err))
    }
  }

  async function cancelBusyTask() {
    if (!state.busyTask?.id) return
    try {
      await ctx.tasks.cancel(state.busyTask.id)
      toast('warn', '已发送取消请求')
    } catch (err) {
      toast('err', '取消失败：' + (err?.message || err))
    }
  }

  function filteredItems() {
    const items = Array.isArray(state.data?.items) ? state.data.items : []
    const q = state.q.trim().toLowerCase()
    return items.filter((it) => {
      const ms = it.matches || []
      const cls = it.clients || []
      if (state.statusFilter === 'candidate' && !ms.some((m) => m.status === 'candidate')) return false
      if (state.statusFilter === 'seeded' && !ms.some((m) => ['added', 'already_existed', 'cached', 'seeding'].includes(m.status))) return false
      if (state.statusFilter === 'failed' && !ms.some((m) => m.status === 'failed')) return false
      if (state.statusFilter === 'incomplete' && ['complete', 'downloader_complete', 'unchecked'].includes(it.integrity)) return false

      if (state.dlFilter === '__unlinked__') {
        if (cls.length) return false
      } else if (state.dlFilter !== 'all') {
        if (!cls.some((c) => c.downloaderId === state.dlFilter)) return false
      }

      if (state.siteFilter !== 'all') {
        const hitSite = ms.some((m) => m.siteName === state.siteFilter) || (it.sourceSites || []).includes(state.siteFilter)
        if (!hitSite) return false
      }

      if (q) {
        const hay = [
          it.name, it.fingerprint,
          ...(it.sourceSites || []),
          ...cls.map((c) => c.downloaderName + ' ' + c.savePath + ' ' + (c.infoHashes || []).join(' ')),
          ...ms.map((m) => m.siteName + ' ' + m.torrentId + ' ' + (m.reason || ''))
        ].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }

  function collectActionableKeys(items) {
    const out = []
    for (const it of items) {
      for (const m of it.matches || []) {
        if (m.status === 'candidate' || m.status === 'failed') {
          const dlId = m.downloaderId || it.clients?.[0]?.downloaderId || ''
          out.push({ key: it.fingerprint + '::' + m.siteId + '::' + dlId, fingerprint: it.fingerprint, siteId: m.siteId, downloaderId: dlId })
        }
      }
    }
    return out
  }

  function renderHeader() {
    const enabledSites = state.sites.filter((s) => s.enabled && s.passkey && s.url).length
    const enabledDls = state.downloaders.filter((d) => d.enabled && d.url).length
    const hasMenu = typeof ctx.navigation?.openSidebar === 'function'
    const hasBack = typeof ctx.navigation?.close === 'function'
    const lastAt = state.data?.updatedAt ? fmtTime(state.data.updatedAt) : '尚未扫描'

    return `
      <header class="rs-hero">
        ${HERO_ART}
        <div class="rs-hero-top">
          <div class="rs-brand">
            ${hasMenu ? '<button type="button" class="rs-btn rs-btn-nav" data-act="nav-menu" aria-label="主菜单">☰</button>' : ''}
            ${hasBack ? '<button type="button" class="rs-btn rs-btn-nav" data-act="nav-back" aria-label="返回">←</button>' : ''}
            <span class="rs-brand-icon">${BRAND_SVG}</span>
            <div class="rs-brand-text">
              <h1 class="rs-brand-title">辅种助手</h1>
              <p class="rs-brand-sub">按 pieces 指纹跨站比对 · 一览每个种子的 BT 软件与辅种站点</p>
            </div>
          </div>
          <div class="rs-actions">
            <button type="button" class="rs-btn" data-act="scan" ${state.busyTask ? 'disabled' : ''}>扫描预览</button>
            <button type="button" class="rs-btn rs-btn-primary" data-act="reseed" ${state.busyTask ? 'disabled' : ''}>一键辅种</button>
            <button type="button" class="rs-btn" data-act="open-settings">策略设置</button>
            <button type="button" class="rs-btn" data-act="refresh" title="刷新状态">刷新</button>
          </div>
        </div>
        <div class="rs-capsules">
          <span class="rs-cap ${enabledDls ? 'rs-cap-ok' : 'rs-cap-warn'}"><i class="rs-dot"></i>BT 下载器 ${enabledDls}/${state.downloaders.length}</span>
          <span class="rs-cap ${enabledSites ? 'rs-cap-accent' : 'rs-cap-warn'}"><i class="rs-dot"></i>启用站点 ${enabledSites}/${state.sites.length}</span>
          <span class="rs-cap ${state.settings.autoEnabled ? 'rs-cap-ok' : ''}">${state.settings.autoEnabled ? ('定时自动：' + (state.settings.autoMode === 'reseed' ? '自动辅种' : '仅扫描')) : '模式：手动触发'}</span>
          <span class="rs-cap">上次：${esc(lastAt)}</span>
        </div>
        ${state.busyTask ? '<span class="rs-hero-bar" aria-hidden="true"></span>' : ''}
      </header>
    `
  }

  function renderBusyBanner() {
    if (state.busyTask) {
      const pct = Math.max(0, Math.min(100, Number(state.busyTask.progress) || 0))
      return `
        <div class="rs-banner" role="status">
          <div class="rs-banner-left">
            <span class="rs-spinner"></span>
            <strong>${esc(state.busyTask.stage || '执行中')}</strong>
            <span>${esc(state.busyTask.message || '')}</span>
          </div>
          <div class="rs-actions">
            <div class="rs-prog-track"><div class="rs-prog-fill" style="width:${pct}%"></div></div>
            <span class="rs-muted">${pct}%</span>
            ${state.busyTask.id ? '<button type="button" class="rs-btn rs-btn-sm rs-btn-danger" data-act="cancel-task">取消</button>' : ''}
          </div>
        </div>
      `
    }
    if (state.lastNotice && state.lastNotice.kind === 'err') {
      return `
        <div class="rs-banner" style="border-color:color-mix(in srgb,var(--rs-err) 45%,var(--rs-border));background:color-mix(in srgb,var(--rs-err) 8%,var(--rs-surface));color:var(--rs-err)" role="alert">
          <div class="rs-banner-left"><strong>操作异常：</strong><span>${esc(state.lastNotice.text)}</span></div>
          <button type="button" class="rs-btn rs-btn-xs" data-act="dismiss-notice">知道了</button>
        </div>
      `
    }
    return ''
  }

  function renderKpis() {
    const s = state.data?.summary || {}
    const seededTotal = (s.addedCount || 0) + (s.alreadyExistedCount || 0) + (s.cachedCount || 0) + (s.sameSiteSeeding || 0)
    return `
      <section class="rs-kpi-grid" aria-label="核心指标">
        <button type="button" class="rs-kpi" data-kpi="all">
          <span class="rs-kpi-label">聚合资源</span>
          <strong class="rs-kpi-val">${s.uniqueResources ?? 0}</strong>
          <span class="rs-kpi-hint">共 ${s.totalTorrents ?? 0} 个 .torrent · 已连 BT ${s.downloaderLinked ?? 0}</span>
        </button>
        <button type="button" class="rs-kpi" data-kpi="candidate">
          <span class="rs-kpi-label">可跨站辅种</span>
          <strong class="rs-kpi-val">${s.crossSeedAvailable ?? 0}</strong>
          <span class="rs-kpi-hint">点击筛选待辅种条目</span>
        </button>
        <button type="button" class="rs-kpi rs-kpi-ok" data-kpi="seeded">
          <span class="rs-kpi-label">已辅种 / 已做种</span>
          <strong class="rs-kpi-val">${seededTotal}</strong>
          <span class="rs-kpi-hint">新增 ${s.addedCount ?? 0} · 同站 ${s.sameSiteSeeding ?? 0} · 缓存 ${s.cachedCount ?? 0}</span>
        </button>
        <button type="button" class="rs-kpi rs-kpi-teal" data-kpi="incomplete">
          <span class="rs-kpi-label">数据完整性</span>
          <strong class="rs-kpi-val">${s.completeCount ?? 0}</strong>
          <span class="rs-kpi-hint">不全 ${s.incompleteCount ?? 0} · 未关联 ${s.unlinkedCount ?? 0}</span>
        </button>
        <button type="button" class="rs-kpi ${(s.failedCount || 0) > 0 ? 'rs-kpi-err' : 'rs-kpi-muted'}" data-kpi="failed">
          <span class="rs-kpi-label">推送失败</span>
          <strong class="rs-kpi-val">${s.failedCount ?? 0}</strong>
          <span class="rs-kpi-hint">${s.failedCount ? '点击查看错误并重试' : '暂无异常'}</span>
        </button>
      </section>
    `
  }

  function renderTabs() {
    const s = state.data?.summary || {}
    const enabledSites = state.sites.filter((x) => x.enabled && x.passkey).length
    const tabs = [
      { id: 'torrents', label: '种子与辅种', badge: s.uniqueResources ?? 0 },
      { id: 'sites', label: '站点管理', badge: enabledSites + '/' + state.sites.length },
      { id: 'downloaders', label: 'BT 下载器 & 目录', badge: state.downloaders.length },
      { id: 'logs', label: '任务与日志', badge: (state.data?.logs || []).length }
    ]
    return `
      <div class="rs-tabs-bar">
        <nav class="rs-tabs" role="tablist">
          ${tabs.map((t) => `
            <button type="button" role="tab" aria-selected="${state.tab === t.id}" class="rs-tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
              <span>${esc(t.label)}</span>
              <span class="rs-tab-badge">${esc(t.badge)}</span>
            </button>
          `).join('')}
        </nav>
      </div>
    `
  }

  function renderTorrentsTab() {
    const allItems = Array.isArray(state.data?.items) ? state.data.items : []
    if (!state.data) {
      return `
        <section class="rs-card">
          <div class="rs-empty">
            <strong>还没有扫描记录</strong>
            <div class="rs-muted">先在「BT 下载器 & 目录」配好 qBittorrent / Transmission 和种子目录，在「站点管理」启用 PT 站点，然后点击右上角「扫描预览」。</div>
            <div class="rs-actions" style="margin-top:6px">
              <button type="button" class="rs-btn" data-tab="downloaders">配置 BT 下载器</button>
              <button type="button" class="rs-btn" data-tab="sites">配置 PT 站点</button>
              <button type="button" class="rs-btn rs-btn-primary" data-act="scan">立即扫描预览</button>
            </div>
          </div>
        </section>
      `
    }

    // 收集筛选下拉选项
    const dlOptions = new Map()
    for (const d of state.downloaders) dlOptions.set(d.id, d.name + ' (' + (d.type === 'transmission' ? 'TR' : 'qB') + ')')
    for (const it of allItems) {
      for (const c of it.clients || []) {
        if (!dlOptions.has(c.downloaderId)) dlOptions.set(c.downloaderId, c.downloaderName)
      }
    }
    const siteSet = new Set()
    for (const it of allItems) {
      for (const s of it.sourceSites || []) siteSet.add(s)
      for (const m of it.matches || []) siteSet.add(m.siteName)
    }

    const items = filteredItems()
    const actionable = collectActionableKeys(items)
    const selectedActionable = actionable.filter((a) => state.selectedKeys.has(a.key))

    const toolbar = `
      <div class="rs-toolbar">
        <input class="rs-input rs-search" data-filter="q" value="${esc(state.q)}" placeholder="搜索种子名 / 指纹 / 保存路径 / 站点…" />
        <select class="rs-select" data-filter="status">
          <option value="all" ${state.statusFilter === 'all' ? 'selected' : ''}>全部状态</option>
          <option value="candidate" ${state.statusFilter === 'candidate' ? 'selected' : ''}>可跨站辅种</option>
          <option value="seeded" ${state.statusFilter === 'seeded' ? 'selected' : ''}>已辅种 / 已做种</option>
          <option value="failed" ${state.statusFilter === 'failed' ? 'selected' : ''}>推送失败</option>
          <option value="incomplete" ${state.statusFilter === 'incomplete' ? 'selected' : ''}>数据不全 / 未关联</option>
        </select>
        <select class="rs-select" data-filter="dl">
          <option value="all" ${state.dlFilter === 'all' ? 'selected' : ''}>全部 BT 软件</option>
          ${[...dlOptions.entries()].map(([id, label]) => `<option value="${esc(id)}" ${state.dlFilter === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          <option value="__unlinked__" ${state.dlFilter === '__unlinked__' ? 'selected' : ''}>未关联下载器</option>
        </select>
        <select class="rs-select" data-filter="site">
          <option value="all" ${state.siteFilter === 'all' ? 'selected' : ''}>全部站点</option>
          ${[...siteSet].sort().map((s) => `<option value="${esc(s)}" ${state.siteFilter === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
        <div class="rs-seg" role="group" aria-label="视图切换">
          <button type="button" class="${state.viewMode === 'cards' ? 'active' : ''}" data-view="cards">卡片</button>
          <button type="button" class="${state.viewMode === 'table' ? 'active' : ''}" data-view="table">表格</button>
        </div>
      </div>
    `

    const batchBar = actionable.length ? `
      <div class="rs-batch">
        <div class="rs-muted">当前筛选结果中共有 <strong>${actionable.length}</strong> 个可推送/可重试站点项，已选 <strong>${selectedActionable.length}</strong> 项</div>
        <div class="rs-actions">
          <button type="button" class="rs-btn rs-btn-sm" data-act="select-all">全选可辅种</button>
          <button type="button" class="rs-btn rs-btn-sm" data-act="select-none">取消选择</button>
          <button type="button" class="rs-btn rs-btn-sm rs-btn-primary" data-act="apply-selected" ${selectedActionable.length && !state.busyTask ? '' : 'disabled'}>辅种选中 (${selectedActionable.length})</button>
        </div>
      </div>
    ` : ''

    if (!items.length) {
      return `<section class="rs-card">${toolbar}<div class="rs-empty"><strong>没有匹配的种子记录</strong><span class="rs-muted">尝试调整搜索词或筛选条件</span></div></section>`
    }

    const shown = items.slice(0, 200)
    const truncNote = items.length > 200 ? `<div class="rs-muted" style="text-align:center">当前显示前 200 / ${items.length} 条，请用上方搜索或下拉筛选精确定位</div>` : ''

    if (state.viewMode === 'table') {
      return `
        <section class="rs-card">
          ${toolbar}
          ${batchBar}
          <div class="rs-table-wrap">
            <table class="rs-table">
              <thead>
                <tr>
                  <th>种子资源 / 大小</th>
                  <th>所属 BT 软件 & 保存路径</th>
                  <th>已做种站点</th>
                  <th>目标辅种站点</th>
                  <th>完整性</th>
                </tr>
              </thead>
              <tbody>
                ${shown.map((it) => {
                  const im = integrityMeta(it.integrity)
                  const clientsHtml = (it.clients || []).length
                    ? it.clients.map((c) => `
                        <div style="margin-bottom:4px">
                          <span class="rs-pill ${c.downloaderType === 'transmission' ? 'rs-pill-tr' : 'rs-pill-qb'}">${c.downloaderType === 'transmission' ? 'TR' : 'qB'} · ${esc(c.downloaderName)}</span>
                          <span class="rs-muted">${fmtPct(c.progress)}</span>
                          <div class="rs-path">${esc(c.savePath || '无路径')}</div>
                        </div>
                      `).join('')
                    : '<span class="rs-muted">未关联</span>'
                  const srcHtml = (it.sourceSites || []).length
                    ? it.sourceSites.map((s) => `<span class="rs-pill rs-pill-ok">${esc(s)}</span>`).join(' ')
                    : '<span class="rs-muted">未知</span>'
                  const matchHtml = (it.matches || []).length
                    ? `<div class="rs-matches">${it.matches.map((m) => renderMatchChip(it, m)).join('')}</div>`
                    : '<span class="rs-muted">无站点命中</span>'
                  return `
                    <tr>
                      <td style="max-width:260px">
                        <div class="rs-tcard-name">${esc(it.name)}</div>
                        <div class="rs-muted">${fmtBytes(it.totalSize)} · ${it.fileCount} 文件 · <span class="rs-code">${esc(it.fingerprint.slice(0, 10))}</span></div>
                      </td>
                      <td style="max-width:240px">${clientsHtml}</td>
                      <td><div class="rs-matches">${srcHtml}</div></td>
                      <td>${matchHtml}</td>
                      <td><span class="rs-pill rs-pill-${im.cls}" title="${esc(it.integrityDetail || '')}">${esc(im.label)}</span></td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
          ${truncNote}
        </section>
      `
    }

    return `
      <section class="rs-card">
        ${toolbar}
        ${batchBar}
        <div class="rs-tlist">
          ${shown.map((it) => {
            const im = integrityMeta(it.integrity)
            const ms = it.matches || []
            const cls = it.clients || []
            const candMatches = ms.filter((m) => m.status === 'candidate' || m.status === 'failed')
            const allChecked = candMatches.length > 0 && candMatches.every((m) => {
              const dlId = m.downloaderId || cls[0]?.downloaderId || ''
              return state.selectedKeys.has(it.fingerprint + '::' + m.siteId + '::' + dlId)
            })
            const cardCls = ms.some((m) => m.status === 'failed')
              ? 'has-fail'
              : (ms.some((m) => m.status === 'candidate') ? 'has-cand' : (ms.length ? 'all-ok' : ''))

            return `
              <article class="rs-tcard ${cardCls}">
                <div class="rs-tcard-head">
                  <div class="rs-tcard-left">
                    ${candMatches.length ? `<input type="checkbox" data-check-item="${esc(it.fingerprint)}" ${allChecked ? 'checked' : ''} aria-label="选中此种子的可辅种项" />` : ''}
                    <div style="min-width:0">
                      <div class="rs-tcard-name">${esc(it.name)}</div>
                      <div class="rs-tcard-meta">
                        <span>${fmtBytes(it.totalSize)}</span>
                        <span>${it.fileCount} 个文件</span>
                        <span class="rs-code" title="pieces SHA1: ${esc(it.fingerprint)}">FP ${esc(it.fingerprint.slice(0, 12))}</span>
                        <span class="rs-pill rs-pill-${im.cls}" title="${esc(it.integrityDetail || '')}">${esc(im.label)}</span>
                        ${it.integrityDetail ? `<span class="rs-muted">${esc(it.integrityDetail)}</span>` : ''}
                      </div>
                    </div>
                  </div>
                </div>
                <div class="rs-tcard-grid">
                  <div class="rs-subblock">
                    <span class="rs-subblock-title">对应 BT 软件 (${cls.length})</span>
                    ${cls.length ? cls.map((c) => `
                      <div class="rs-client-row">
                        <div class="rs-client-top">
                          <span>
                            <span class="rs-pill ${c.downloaderType === 'transmission' ? 'rs-pill-tr' : 'rs-pill-qb'}">${c.downloaderType === 'transmission' ? 'Transmission' : 'qBittorrent'}</span>
                            <strong>${esc(c.downloaderName)}</strong>
                          </span>
                          <span class="rs-muted">${fmtPct(c.progress)} · ${esc(c.state || '')}</span>
                        </div>
                        <div class="rs-path" title="下载器路径">${esc(c.savePath || '（无保存目录）')}</div>
                        ${c.hostPath ? `<div class="rs-path" title="宿主机映射路径">↪ 映射: ${esc(c.hostPath)}</div>` : ''}
                      </div>
                    `).join('') : '<span class="rs-muted">未在已启用的下载器中匹配到对应 info_hash</span>'}
                  </div>
                  <div class="rs-subblock">
                    <span class="rs-subblock-title">已做种来源站点 (${(it.sourceSites || []).length})</span>
                    <div class="rs-matches">
                      ${(it.sourceSites || []).length
                        ? it.sourceSites.map((s) => `<span class="rs-pill rs-pill-ok">${esc(s)}</span>`).join('')
                        : '<span class="rs-muted">未能识别 Tracker 归属</span>'}
                    </div>
                  </div>
                  <div class="rs-subblock">
                    <span class="rs-subblock-title">匹配到的辅种站点 (${ms.length})</span>
                    <div class="rs-matches">
                      ${ms.length
                        ? ms.map((m) => renderMatchChip(it, m)).join('')
                        : '<span class="rs-muted">已启用站点暂未命中同款资源</span>'}
                    </div>
                  </div>
                </div>
              </article>
            `
          }).join('')}
        </div>
        ${truncNote}
      </section>
    `
  }

  function renderMatchChip(it, m) {
    const sm = matchStatusMeta(m.status)
    const dlId = m.downloaderId || it.clients?.[0]?.downloaderId || ''
    const canApply = (m.status === 'candidate' || m.status === 'failed') && !!dlId && !state.busyTask
    return `
      <span class="rs-match-chip is-${esc(m.status)}" title="${esc(m.reason || '')}">
        <strong>${esc(m.siteName)}</strong>
        <span class="rs-code">#${esc(m.torrentId)}</span>
        <span class="rs-pill rs-pill-${sm.cls}">${esc(sm.label)}</span>
        ${m.status === 'failed' && m.reason ? `<span class="rs-match-err">${esc(m.reason)}</span>` : ''}
        ${canApply ? `<button type="button" class="rs-btn rs-btn-xs rs-btn-ok" data-act="apply-one" data-fp="${esc(it.fingerprint)}" data-site="${esc(m.siteId)}" data-dl="${esc(dlId)}">${m.status === 'failed' ? '重试' : '辅种'}</button>` : ''}
      </span>
    `
  }

  function renderSitesTab() {
    const statMap = new Map((state.data?.siteStats || []).map((st) => [st.id, st]))
    const q = state.siteSearch.trim().toLowerCase()
    const list = state.sites.map((s, idx) => ({ s, idx })).filter(({ s }) => {
      if (state.siteTabFilter === 'enabled' && !s.enabled) return false
      if (state.siteTabFilter === 'custom' && !s.custom) return false
      if (q) {
        const hay = (s.name + ' ' + s.url + ' ' + s.api + ' ' + (s.trackerDomains || []).join(' ')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    return `
      <section class="rs-card">
        <div class="rs-card-head">
          <h2 class="rs-card-title">PT 站点配置 <span class="rs-muted">（支持任意自定义站点与方言）</span></h2>
          <div class="rs-actions">
            <button type="button" class="rs-btn rs-btn-sm" data-act="import-host-sites">从宿主导入</button>
            <button type="button" class="rs-btn rs-btn-sm" data-act="restore-builtins">同步站点库</button>
            <button type="button" class="rs-btn rs-btn-sm rs-btn-primary" data-act="add-site">+ 添加自定义站点</button>
          </div>
        </div>
        <div class="rs-toolbar">
          <input class="rs-input rs-search" data-filter="siteSearch" value="${esc(state.siteSearch)}" placeholder="搜索站点名 / 域名 / 接口地址…" />
          <div class="rs-seg">
            <button type="button" class="${state.siteTabFilter === 'all' ? 'active' : ''}" data-sitefilter="all">全部 (${state.sites.length})</button>
            <button type="button" class="${state.siteTabFilter === 'enabled' ? 'active' : ''}" data-sitefilter="enabled">已启用 (${state.sites.filter((x) => x.enabled).length})</button>
            <button type="button" class="${state.siteTabFilter === 'custom' ? 'active' : ''}" data-sitefilter="custom">自定义 (${state.sites.filter((x) => x.custom).length})</button>
          </div>
        </div>
        <div class="rs-grid-2">
          ${list.map(({ s, idx }) => {
            const d = resolveDialect(s)
            const api = inferApiUrl(s)
            const st = statMap.get(s.id)
            const pr = state.siteProbes[s.id]
            return `
              <article class="rs-entity ${s.enabled ? 'is-enabled' : ''}">
                <div class="rs-entity-head">
                  <div style="min-width:0">
                    <div class="rs-entity-title">
                      <span>${esc(s.name)}</span>
                      <span class="rs-pill rs-pill-accent">${esc(dialectLabel(d))}</span>
                      ${s.custom ? '<span class="rs-pill rs-pill-teal">自定义</span>' : ''}
                    </div>
                    <div class="rs-entity-url">${esc(s.url || '未填地址')}</div>
                    <div class="rs-entity-url" title="实际查询接口">API: ${esc(api || '—')}</div>
                  </div>
                  <label class="rs-switch" title="启用/停用">
                    <input type="checkbox" data-toggle-site="${idx}" ${s.enabled ? 'checked' : ''} />
                  </label>
                </div>
                <div class="rs-matches">
                  <span class="rs-pill ${s.passkey ? 'rs-pill-ok' : 'rs-pill-warn'}">${s.passkey ? '已填凭据' : '缺少 Passkey'}</span>
                  ${st ? `<span class="rs-pill ${st.ok ? 'rs-pill-accent' : 'rs-pill-err'}">${st.ok ? ('上次命中 ' + st.totalHits + ' / 跨站 ' + st.crossHits) : ('上次失败: ' + st.error)}</span>` : ''}
                  ${pr ? (pr.loading
                    ? '<span class="rs-pill rs-pill-muted">测试中…</span>'
                    : `<span class="rs-pill ${pr.ok ? 'rs-pill-ok' : 'rs-pill-err'}">${esc(pr.message)}</span>`) : ''}
                </div>
                <div class="rs-entity-foot">
                  <button type="button" class="rs-btn rs-btn-xs" data-act="probe-site" data-idx="${idx}">测试接口</button>
                  <div class="rs-actions">
                    <button type="button" class="rs-btn rs-btn-xs" data-act="edit-site" data-idx="${idx}">编辑</button>
                    <button type="button" class="rs-btn rs-btn-xs rs-btn-danger" data-act="del-site" data-idx="${idx}">删除</button>
                  </div>
                </div>
              </article>
            `
          }).join('')}
        </div>
      </section>
    `
  }

  function renderDownloadersTab() {
    const dlStatusMap = new Map((state.data?.downloaders || []).map((d) => [d.id, d]))
    return `
      <section class="rs-card">
        <div class="rs-card-head">
          <h2 class="rs-card-title">BT 下载器实例 <span class="rs-muted">（支持同时配置多个 qBittorrent / Transmission）</span></h2>
          <button type="button" class="rs-btn rs-btn-sm rs-btn-primary" data-act="add-dl">+ 添加 BT 下载器</button>
        </div>
        ${state.downloaders.length ? `
          <div class="rs-grid-2">
            ${state.downloaders.map((d, idx) => {
              const pr = state.probeResults[d.id]
              const last = dlStatusMap.get(d.id)
              const statusPill = pr
                ? (pr.loading
                  ? '<span class="rs-pill rs-pill-muted">连接测试中…</span>'
                  : (pr.ok
                    ? `<span class="rs-pill rs-pill-ok">在线 · ${esc(pr.version || d.type)} · ${pr.torrents} 种子</span>`
                    : `<span class="rs-pill rs-pill-err">失败：${esc(pr.error)}</span>`))
                : (last
                  ? (last.ok
                    ? `<span class="rs-pill rs-pill-ok">上次在线 · ${last.torrentCount} 种子</span>`
                    : `<span class="rs-pill rs-pill-err">上次失败：${esc(last.error)}</span>`)
                  : '<span class="rs-pill rs-pill-muted">未测试</span>')

              return `
                <article class="rs-entity ${d.enabled ? 'is-enabled' : ''}">
                  <div class="rs-entity-head">
                    <div style="min-width:0">
                      <div class="rs-entity-title">
                        <span class="rs-pill ${d.type === 'transmission' ? 'rs-pill-tr' : 'rs-pill-qb'}">${d.type === 'transmission' ? 'Transmission' : 'qBittorrent'}</span>
                        <span>${esc(d.name)}</span>
                      </div>
                      <div class="rs-entity-url">${esc(d.url || '未填地址')}</div>
                    </div>
                    <label class="rs-switch" title="启用/停用">
                      <input type="checkbox" data-toggle-dl="${idx}" ${d.enabled ? 'checked' : ''} />
                    </label>
                  </div>
                  <div class="rs-matches">
                    ${statusPill}
                    <span class="rs-pill rs-pill-muted">路径映射 ${d.pathMaps.length} 条</span>
                    <span class="rs-pill rs-pill-muted">标签：${esc(d.tags || '无')}</span>
                    <span class="rs-pill rs-pill-muted">${d.paused ? '暂停添加' : '直接开始'}</span>
                  </div>
                  ${d.pathMaps.length ? `<div class="rs-preview-box">${d.pathMaps.map((m) => `<div>${esc(m.from)}  →  ${esc(m.to)}</div>`).join('')}</div>` : ''}
                  <div class="rs-entity-foot">
                    <button type="button" class="rs-btn rs-btn-xs" data-act="probe-dl" data-idx="${idx}">测试连接</button>
                    <div class="rs-actions">
                      <button type="button" class="rs-btn rs-btn-xs" data-act="edit-dl" data-idx="${idx}">编辑 / 路径映射</button>
                      <button type="button" class="rs-btn rs-btn-xs rs-btn-danger" data-act="del-dl" data-idx="${idx}">删除</button>
                    </div>
                  </div>
                </article>
              `
            }).join('')}
          </div>
        ` : `
          <div class="rs-empty">
            <strong>尚未添加 BT 下载器</strong>
            <div class="rs-muted">点击右上角「+ 添加 BT 下载器」配置本机 qBittorrent 或 NAS 上的 Transmission。</div>
          </div>
        `}
      </section>

      <section class="rs-card">
        <div class="rs-card-head">
          <h2 class="rs-card-title">全局种子目录（.torrent）</h2>
          <div class="rs-actions">
            <button type="button" class="rs-btn rs-btn-sm" data-act="probe-dirs">探测可读性</button>
            <button type="button" class="rs-btn rs-btn-sm rs-btn-primary" data-act="save-dirs">保存目录</button>
          </div>
        </div>
        <div class="rs-field">
          <textarea class="rs-textarea" data-dirs placeholder="每行一个 DIAN115 容器内可读的目录，例如：&#10;/qb-torrents&#10;/dian115AI/reseed-test/torrents">${esc(state.settings.torrentDirs)}</textarea>
          <span class="rs-help">目录必须已挂载到 DIAN115 容器中（如 compose.yaml 里的 /qb-torrents）。点击「探测可读性」可立即验证扫到多少 .torrent 文件。</span>
        </div>
        ${state.dirProbes ? `
          <div class="rs-matches">
            ${state.dirProbes.map((p) => p.loading
              ? `<span class="rs-pill rs-pill-muted">${esc(p.dir)} 探测中…</span>`
              : (p.ok
                ? `<span class="rs-pill rs-pill-ok">${esc(p.dir)}：可读（${p.count} 个 .torrent / 共 ${p.total ?? p.count} 项${esc(p.diag || '')}）</span>`
                : `<span class="rs-pill rs-pill-err">${esc(p.dir)}：${esc(p.error)}</span>`)).join('')}
          </div>
        ` : ''}
      </section>
    `
  }

  function renderLogsTab() {
    const siteStats = state.data?.siteStats || []
    const logs = state.data?.logs || []
    return `
      <section class="rs-card">
        <div class="rs-card-head">
          <h2 class="rs-card-title">各站点查询汇总</h2>
          <div class="rs-actions">
            <button type="button" class="rs-btn rs-btn-sm" data-act="copy-diag">复制诊断 JSON</button>
            <button type="button" class="rs-btn rs-btn-sm rs-btn-danger" data-act="clear-cache">清空已辅种缓存</button>
          </div>
        </div>
        ${siteStats.length ? `
          <div class="rs-table-wrap">
            <table class="rs-table">
              <thead>
                <tr>
                  <th>站点</th><th>方言</th><th>状态</th><th>总命中</th><th>跨站</th><th>同站</th><th>新增</th><th>失败</th><th>耗时</th><th>说明</th>
                </tr>
              </thead>
              <tbody>
                ${siteStats.map((st) => `
                  <tr>
                    <td><strong>${esc(st.name)}</strong></td>
                    <td><span class="rs-pill rs-pill-muted">${esc(dialectLabel(st.dialect))}</span></td>
                    <td><span class="rs-pill ${st.ok ? 'rs-pill-ok' : 'rs-pill-err'}">${st.ok ? '正常' : '失败'}</span></td>
                    <td>${st.totalHits}</td>
                    <td>${st.crossHits}</td>
                    <td>${st.sameHits}</td>
                    <td>${st.added}</td>
                    <td>${st.failed}</td>
                    <td>${st.elapsedMs} ms</td>
                    <td class="rs-muted">${esc(st.error || st.apiUrl || '')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : '<div class="rs-muted">暂无站点查询统计，请先执行一次「扫描预览」。</div>'}
      </section>

      <section class="rs-card">
        <h2 class="rs-card-title">最近运行日志（${logs.length}）</h2>
        ${logs.length ? `
          <ul class="rs-logs">
            ${logs.slice().reverse().map((l) => `
              <li class="rs-log-${esc(l.level || 'info')}">
                <span class="rs-log-dot"></span>
                <span class="rs-log-time">${esc(fmtTime(l.time))}</span>
                <span class="rs-log-msg">${esc(l.message)}</span>
              </li>
            `).join('')}
          </ul>
        ` : '<div class="rs-muted">暂无运行日志</div>'}
      </section>
    `
  }

  function renderDrawer() {
    if (!state.drawer) return ''
    if (state.drawer.kind === 'settings') {
      const s = state.settings
      return `
        <div class="rs-overlay" data-act="close-drawer">
          <div class="rs-drawer" role="dialog" aria-modal="true" aria-label="策略设置">
            <div class="rs-drawer-head">
              <h3>辅种策略设置</h3>
              <button type="button" class="rs-btn rs-btn-sm" data-act="close-drawer">关闭</button>
            </div>
            <div class="rs-drawer-body">
              <label class="rs-switch">
                <input type="checkbox" data-set="autoEnabled" ${s.autoEnabled ? 'checked' : ''} />
                <span><strong>开启定时自动扫描/辅种</strong>（默认每 6 小时运行，可在插件中心修改 cron）</span>
              </label>
              <div class="rs-field">
                <label>定时自动运行模式</label>
                <select class="rs-select" data-set="autoMode">
                  <option value="scan" ${s.autoMode !== 'reseed' ? 'selected' : ''}>仅自动扫描预览（更新矩阵，不推送下载器）</option>
                  <option value="reseed" ${s.autoMode === 'reseed' ? 'selected' : ''}>自动扫描并推送辅种（命中即推送到对应 BT 软件）</option>
                </select>
                <span class="rs-help">页面的「扫描预览」和「一键辅种」按钮随时可手动触发，不受定时开关限制。</span>
              </div>
              <label class="rs-switch">
                <input type="checkbox" data-set="skipIncomplete" ${s.skipIncomplete ? 'checked' : ''} />
                <span><strong>跳过数据不全的种子</strong>（有路径映射则校验磁盘大小，否则按下载器 100% 进度）</span>
              </label>
              <label class="rs-switch">
                <input type="checkbox" data-set="defaultPaused" ${s.defaultPaused ? 'checked' : ''} />
                <span><strong>添加后默认暂停</strong>（推荐开启，核对无误后再开始做种）</span>
              </label>
              <label class="rs-switch">
                <input type="checkbox" data-set="defaultSkipChecking" ${s.defaultSkipChecking ? 'checked' : ''} />
                <span><strong>qBittorrent 默认跳过校验</strong>（skip_checking 秒辅）</span>
              </label>
              <div class="rs-field-row">
                <div class="rs-field">
                  <label>每批查询指纹数</label>
                  <input class="rs-input" type="number" min="1" max="500" data-set="batchSize" value="${esc(s.batchSize)}" />
                </div>
                <div class="rs-field">
                  <label>批次间隔（毫秒）</label>
                  <input class="rs-input" type="number" min="0" max="10000" data-set="rateLimitMs" value="${esc(s.rateLimitMs)}" />
                </div>
              </div>
              <div class="rs-field">
                <label>默认辅种标签</label>
                <input class="rs-input" type="text" data-set="defaultTags" value="${esc(s.defaultTags)}" placeholder="辅种" />
                <span class="rs-help">多个标签用逗号分隔，会附加到推送的种子上便于筛选。</span>
              </div>
            </div>
            <div class="rs-drawer-foot">
              <button type="button" class="rs-btn" data-act="close-drawer">取消</button>
              <button type="button" class="rs-btn rs-btn-primary" data-act="save-settings">保存策略</button>
            </div>
          </div>
        </div>
      `
    }

    if (state.drawer.kind === 'site') {
      const d = state.drawer.draft
      const isNew = state.drawer.index < 0
      const resolvedApi = inferApiUrl(d)
      const resolvedDl = inferDownloadPreview(d)
      return `
        <div class="rs-overlay" data-act="close-drawer">
          <div class="rs-drawer" role="dialog" aria-modal="true" aria-label="${isNew ? '添加自定义站点' : '编辑站点'}">
            <div class="rs-drawer-head">
              <h3>${isNew ? '添加自定义站点' : ('编辑站点 · ' + esc(d.name))}</h3>
              <button type="button" class="rs-btn rs-btn-sm" data-act="close-drawer">关闭</button>
            </div>
            <div class="rs-drawer-body">
              <div class="rs-field-row">
                <div class="rs-field">
                  <label>站点名称 *</label>
                  <input class="rs-input" data-sd="name" value="${esc(d.name)}" placeholder="如：某某 PT" />
                </div>
                <div class="rs-field">
                  <label>接口方言</label>
                  <select class="rs-select" data-sd="dialect">
                    <option value="auto" ${d.dialect === 'auto' ? 'selected' : ''}>自动识别</option>
                    <option value="nexusphp" ${d.dialect === 'nexusphp' ? 'selected' : ''}>NexusPHP (/api/pieces-hash)</option>
                    <option value="nexusapi" ${d.dialect === 'nexusapi' ? 'selected' : ''}>NexusAPI (/nexusapi/pieces-hash)</option>
                    <option value="flux" ${d.dialect === 'flux' ? 'selected' : ''}>FluxTorrent (/api/v1/crossseed/lookup)</option>
                    <option value="custom" ${d.dialect === 'custom' ? 'selected' : ''}>完全自定义</option>
                  </select>
                </div>
              </div>
              <div class="rs-field">
                <label>站点地址（URL）*</label>
                <input class="rs-input" data-sd="url" value="${esc(d.url)}" placeholder="https://pt.example.com" />
              </div>
              <div class="rs-field">
                <label>Passkey / API Token</label>
                <input class="rs-input" data-sd="passkey" value="${esc(d.passkey)}" placeholder="NexusPHP 填 passkey；Flux 站填 fxo_ 开头令牌" />
              </div>
              <div class="rs-field">
                <label>查询接口覆盖（可选，留空自动推断）</label>
                <input class="rs-input" data-sd="api" value="${esc(d.api)}" placeholder="留空按站点地址 + 方言自动拼接" />
              </div>
              <div class="rs-field">
                <label>下载链接模板（可选，留空自动生成）</label>
                <input class="rs-input" data-sd="downloadTemplate" value="${esc(d.downloadTemplate)}" placeholder="如 https://site/download.php?id={id}&passkey={passkey}" />
              </div>
              <div class="rs-field">
                <label>Tracker 域名别名（可选，逗号分隔）</label>
                <input class="rs-input" data-sd="trackerDomains" value="${esc(Array.isArray(d.trackerDomains) ? d.trackerDomains.join(', ') : (d.trackerDomains || ''))}" placeholder="如 tracker.example.org, t.example.org" />
                <span class="rs-help">用于准确识别本地种子是否已在该站做种（特别是 Tracker 域名与主站不同的站点）。</span>
              </div>
              <label class="rs-switch">
                <input type="checkbox" data-sd="enabled" ${d.enabled ? 'checked' : ''} />
                <span>启用此站点参与辅种查询</span>
              </label>
              <div class="rs-preview-box" data-site-preview>
                <div><strong>生效方言：</strong>${esc(dialectLabel(resolveDialect(d)))}</div>
                <div><strong>查询接口：</strong>${esc(resolvedApi || '（请先填写站点地址）')}</div>
                <div><strong>下载方式：</strong>${esc(resolvedDl || '—')}</div>
              </div>
            </div>
            <div class="rs-drawer-foot">
              <button type="button" class="rs-btn" data-act="close-drawer">取消</button>
              <button type="button" class="rs-btn rs-btn-primary" data-act="save-site-draft">保存站点</button>
            </div>
          </div>
        </div>
      `
    }

    if (state.drawer.kind === 'downloader') {
      const d = state.drawer.draft
      const isNew = state.drawer.index < 0
      const maps = Array.isArray(d.pathMaps) ? d.pathMaps : []
      return `
        <div class="rs-overlay" data-act="close-drawer">
          <div class="rs-drawer" role="dialog" aria-modal="true" aria-label="${isNew ? '添加 BT 下载器' : '编辑 BT 下载器'}">
            <div class="rs-drawer-head">
              <h3>${isNew ? '添加 BT 下载器' : ('编辑下载器 · ' + esc(d.name))}</h3>
              <button type="button" class="rs-btn rs-btn-sm" data-act="close-drawer">关闭</button>
            </div>
            <div class="rs-drawer-body">
              <div class="rs-field-row">
                <div class="rs-field">
                  <label>下载器名称 *</label>
                  <input class="rs-input" data-dd="name" value="${esc(d.name)}" placeholder="如：本机 qB / 群晖 TR" />
                </div>
                <div class="rs-field">
                  <label>客户端类型</label>
                  <select class="rs-select" data-dd="type">
                    <option value="qbittorrent" ${d.type !== 'transmission' ? 'selected' : ''}>qBittorrent</option>
                    <option value="transmission" ${d.type === 'transmission' ? 'selected' : ''}>Transmission</option>
                  </select>
                </div>
              </div>
              <div class="rs-field">
                <label>WebUI / RPC 地址 *</label>
                <input class="rs-input" data-dd="url" value="${esc(d.url)}" placeholder="${d.type === 'transmission' ? 'http://127.0.0.1:9091（自动补 /transmission/rpc）' : 'http://127.0.0.1:8081'}" />
              </div>
              <div class="rs-field-row">
                <div class="rs-field">
                  <label>用户名</label>
                  <input class="rs-input" data-dd="username" value="${esc(d.username)}" placeholder="无认证可留空" />
                </div>
                <div class="rs-field">
                  <label>密码</label>
                  <input class="rs-input" type="password" data-dd="password" value="${esc(d.password)}" placeholder="存在插件加密 KV 中" />
                </div>
              </div>
              <div class="rs-field">
                <label>辅种标签（逗号分隔）</label>
                <input class="rs-input" data-dd="tags" value="${esc(d.tags)}" placeholder="辅种" />
              </div>
              <div class="rs-field">
                <label>专属种子目录（可选，每行一个）</label>
                <textarea class="rs-textarea" data-dd="torrentDirs" placeholder="可选：该下载器额外的 .torrent 目录">${esc((d.torrentDirs || []).join('\n'))}</textarea>
              </div>
              <div class="rs-field">
                <div class="rs-card-head">
                  <label>路径映射（下载器路径 → DIAN115 宿主可读路径）</label>
                  <button type="button" class="rs-btn rs-btn-xs" data-act="add-pathmap">+ 添加映射</button>
                </div>
                <span class="rs-help">用于本地磁盘逐文件大小校验；如果下载器在远端 NAS 且数据未挂载到本机，可留空（自动按下载器 100% 进度判定）。</span>
                <div style="display:grid;gap:6px">
                  ${maps.map((m, mi) => `
                    <div class="rs-map-row">
                      <input class="rs-input" data-pm-from="${mi}" value="${esc(m.from)}" placeholder="下载器路径 如 /downloads" />
                      <input class="rs-input" data-pm-to="${mi}" value="${esc(m.to)}" placeholder="宿主路径 如 /media" />
                      <button type="button" class="rs-btn rs-btn-xs rs-btn-danger" data-act="del-pathmap" data-mi="${mi}">删</button>
                    </div>
                  `).join('')}
                </div>
              </div>
              <label class="rs-switch">
                <input type="checkbox" data-dd="enabled" ${d.enabled ? 'checked' : ''} />
                <span>启用此下载器</span>
              </label>
              <label class="rs-switch">
                <input type="checkbox" data-dd="paused" ${d.paused ? 'checked' : ''} />
                <span>辅种推送后默认暂停</span>
              </label>
              ${d.type !== 'transmission' ? `
                <label class="rs-switch">
                  <input type="checkbox" data-dd="skipChecking" ${d.skipChecking ? 'checked' : ''} />
                  <span>启用跳过校验（skip_checking）</span>
                </label>
              ` : ''}
            </div>
            <div class="rs-drawer-foot">
              <button type="button" class="rs-btn" data-act="close-drawer">取消</button>
              <button type="button" class="rs-btn rs-btn-primary" data-act="save-dl-draft">保存下载器</button>
            </div>
          </div>
        </div>
      `
    }
    return ''
  }

  function render() {
    let body = ''
    if (state.loading) {
      body = '<section class="rs-card"><div class="rs-empty"><strong>加载中…</strong><span class="rs-muted">正在读取插件配置与上次扫描状态</span></div></section>'
    } else if (state.tab === 'torrents') {
      body = renderTorrentsTab()
    } else if (state.tab === 'sites') {
      body = renderSitesTab()
    } else if (state.tab === 'downloaders') {
      body = renderDownloadersTab()
    } else {
      body = renderLogsTab()
    }

    root.innerHTML = `
      <div class="rs-shell">
        ${renderHeader()}
        ${renderBusyBanner()}
        ${renderKpis()}
        ${renderTabs()}
        ${body}
      </div>
      ${renderDrawer()}
      <div class="rs-toasts" data-toasts></div>
    `
    renderToasts()
  }

  // 事件委托
  const onClick = async (e) => {
    const kpi = e.target.closest('[data-kpi]')
    if (kpi) {
      state.tab = 'torrents'
      state.statusFilter = kpi.dataset.kpi
      render()
      return
    }
    const tabBtn = e.target.closest('[data-tab]')
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab
      render()
      return
    }
    const viewBtn = e.target.closest('[data-view]')
    if (viewBtn) {
      state.viewMode = viewBtn.dataset.view
      render()
      return
    }
    const sfBtn = e.target.closest('[data-sitefilter]')
    if (sfBtn) {
      state.siteTabFilter = sfBtn.dataset.sitefilter
      render()
      return
    }

    const actEl = e.target.closest('[data-act]')
    if (!actEl) return
    const act = actEl.dataset.act

    // 遮罩点击：点在抽屉内部不关闭
    if (act === 'close-drawer') {
      if (e.target.closest('.rs-drawer') && !e.target.closest('button[data-act="close-drawer"]')) return
      state.drawer = null
      render()
      return
    }
    if (act === 'nav-menu') { ctx.navigation?.openSidebar?.(); return }
    if (act === 'nav-back') { ctx.navigation?.close?.(); return }
    if (act === 'refresh') { await loadAll(); toast('ok', '已刷新'); return }
    if (act === 'scan') { await startJob('scan'); return }
    if (act === 'reseed') { await startJob('reseed'); return }
    if (act === 'cancel-task') { await cancelBusyTask(); return }
    if (act === 'dismiss-notice') { state.lastNotice = null; render(); return }
    if (act === 'open-settings') { state.drawer = { kind: 'settings' }; render(); return }

    if (act === 'save-settings') {
      try {
        await saveSettings()
        state.drawer = null
        render()
        toast('ok', '策略设置已保存')
      } catch (err) {
        toast('err', '保存失败：' + (err?.message || err))
      }
      return
    }

    if (act === 'select-all') {
      for (const a of collectActionableKeys(filteredItems())) state.selectedKeys.add(a.key)
      render()
      return
    }
    if (act === 'select-none') {
      state.selectedKeys.clear()
      render()
      return
    }
    if (act === 'apply-selected') {
      const targets = collectActionableKeys(filteredItems())
        .filter((a) => state.selectedKeys.has(a.key) && a.downloaderId)
        .map(({ fingerprint, siteId, downloaderId }) => ({ fingerprint, siteId, downloaderId }))
      if (!targets.length) {
        toast('warn', '所选条目缺少关联的 BT 下载器，无法推送')
        return
      }
      await applyTargets(targets)
      return
    }
    if (act === 'apply-one') {
      await applyTargets([{
        fingerprint: actEl.dataset.fp,
        siteId: actEl.dataset.site,
        downloaderId: actEl.dataset.dl
      }])
      return
    }

    // 站点管理动作
    if (act === 'add-site') {
      state.drawer = {
        kind: 'site',
        index: -1,
        draft: { id: uid('site'), name: '', url: '', api: '', dialect: 'auto', passkey: '', downloadTemplate: '', trackerDomains: [], enabled: true, custom: true }
      }
      render()
      return
    }
    if (act === 'edit-site') {
      const idx = Number(actEl.dataset.idx)
      if (!state.sites[idx]) return
      state.drawer = { kind: 'site', index: idx, draft: { ...state.sites[idx], trackerDomains: [...(state.sites[idx].trackerDomains || [])] } }
      render()
      return
    }
    if (act === 'save-site-draft') {
      const d = state.drawer?.draft
      if (!d) return
      if (!String(d.url || '').trim() || !/^https?:\/\//i.test(String(d.url).trim())) {
        toast('err', '请填写有效的站点 URL（以 http:// 或 https:// 开头）')
        return
      }
      const norm = normalizeSiteLocal(d, state.sites.length)
      if (state.drawer.index < 0) state.sites.unshift(norm)
      else state.sites[state.drawer.index] = norm
      try {
        await saveSites()
        state.drawer = null
        render()
        toast('ok', '站点「' + norm.name + '」已保存')
      } catch (err) {
        toast('err', '保存站点失败：' + (err?.message || err))
      }
      return
    }
    if (act === 'del-site') {
      const idx = Number(actEl.dataset.idx)
      const name = state.sites[idx]?.name || ''
      state.sites.splice(idx, 1)
      await saveSites().catch(() => {})
      render()
      toast('warn', '已删除站点：' + name)
      return
    }
    if (act === 'probe-site') {
      const idx = Number(actEl.dataset.idx)
      if (state.sites[idx]) await probeSite(state.sites[idx])
      return
    }
    if (act === 'import-host-sites') { await importHostSites(); return }
    if (act === 'restore-builtins') {
      const hostOf = (u) => { try { return new URL(String(u || '')).hostname.toLowerCase() } catch { return '' } }
      let added = 0
      let updated = 0
      for (const b of BUILTIN_SITES) {
        const bHost = hostOf(b.url)
        const bTrackers = new Set((b.trackerDomains || []).map((t) => t.toLowerCase()))
        const match = state.sites.find((s) => {
          if (s.id === b.id) return true
          const sh = hostOf(s.url)
          if (sh && (sh === bHost || bTrackers.has(sh))) return true
          return false
        })
        if (match) {
          let changed = false
          const curHost = hostOf(match.url)
          if (curHost && DEPRECATED_HOSTS.has(curHost) && b.url) {
            match.url = b.url
            if (b.api) match.api = b.api
            if (b.dialect && b.dialect !== 'auto') match.dialect = b.dialect
            changed = true
          }
          const mergedTrackers = new Set([...(match.trackerDomains || []), ...(b.trackerDomains || [])])
          if (mergedTrackers.size > (match.trackerDomains || []).length) {
            match.trackerDomains = [...mergedTrackers]
            changed = true
          }
          if (changed) updated++
        } else {
          state.sites.push(normalizeSiteLocal({ ...b, passkey: '', enabled: false }, state.sites.length))
          added++
        }
      }
      await saveSites()
      render()
      if (added || updated) {
        toast('ok', '站点库已同步：新增 ' + added + ' 个，更新域名/Tracker ' + updated + ' 个')
      } else {
        toast('ok', '站点库已是最新，无需更新')
      }
      return
    }

    // 下载器管理动作
    if (act === 'add-dl') {
      state.drawer = {
        kind: 'downloader',
        index: -1,
        draft: {
          id: uid('dl'), name: 'qBittorrent', type: 'qbittorrent', url: '',
          username: '', password: '', enabled: true, paused: false, skipChecking: true,
          tags: state.settings.defaultTags || '辅种', torrentDirs: [], pathMaps: []
        }
      }
      render()
      return
    }
    if (act === 'edit-dl') {
      const idx = Number(actEl.dataset.idx)
      if (!state.downloaders[idx]) return
      const src = state.downloaders[idx]
      state.drawer = {
        kind: 'downloader',
        index: idx,
        draft: {
          ...src,
          torrentDirs: [...(src.torrentDirs || [])],
          pathMaps: (src.pathMaps || []).map((m) => ({ ...m }))
        }
      }
      render()
      return
    }
    if (act === 'add-pathmap') {
      if (state.drawer?.kind === 'downloader') {
        state.drawer.draft.pathMaps.push({ from: '', to: '' })
        render()
      }
      return
    }
    if (act === 'del-pathmap') {
      if (state.drawer?.kind === 'downloader') {
        state.drawer.draft.pathMaps.splice(Number(actEl.dataset.mi), 1)
        render()
      }
      return
    }
    if (act === 'save-dl-draft') {
      const d = state.drawer?.draft
      if (!d) return
      if (!String(d.url || '').trim() || !/^https?:\/\//i.test(String(d.url).trim())) {
        toast('err', '请填写有效的下载器地址（http:// 或 https://）')
        return
      }
      const norm = normalizeDlLocal(d, state.downloaders.length)
      if (state.drawer.index < 0) state.downloaders.push(norm)
      else state.downloaders[state.drawer.index] = norm
      try {
        await saveDownloaders()
        state.drawer = null
        render()
        toast('ok', '下载器「' + norm.name + '」已保存')
      } catch (err) {
        toast('err', '保存下载器失败：' + (err?.message || err))
      }
      return
    }
    if (act === 'del-dl') {
      const idx = Number(actEl.dataset.idx)
      const name = state.downloaders[idx]?.name || ''
      state.downloaders.splice(idx, 1)
      await saveDownloaders().catch(() => {})
      render()
      toast('warn', '已删除下载器：' + name)
      return
    }
    if (act === 'probe-dl') {
      const idx = Number(actEl.dataset.idx)
      if (state.downloaders[idx]) await probeDownloader(state.downloaders[idx])
      return
    }
    if (act === 'save-dirs') {
      try {
        await saveSettings()
        toast('ok', '种子目录已保存')
      } catch (err) {
        toast('err', '保存失败：' + (err?.message || err))
      }
      return
    }
    if (act === 'probe-dirs') { await probeTorrentDirs(); return }

    // 日志与维护
    if (act === 'clear-cache') {
      try {
        await ctx.storage.remove('reseed:done')
        toast('ok', '已清空历史已辅种缓存，下次扫描将重新匹配全部站点')
      } catch (err) {
        toast('err', '清空失败：' + (err?.message || err))
      }
      return
    }
    if (act === 'copy-diag') {
      const diag = JSON.stringify({
        updatedAt: state.data?.updatedAt,
        summary: state.data?.summary,
        downloaders: state.data?.downloaders,
        siteStats: state.data?.siteStats,
        logs: (state.data?.logs || []).slice(-30)
      }, null, 2)
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(diag)
          toast('ok', '诊断信息已复制到剪贴板')
          return
        }
      } catch { /* fallback */ }
      toast('warn', '当前非 HTTPS 环境，请从日志面板手动复制')
    }
  }

  const onInput = (e) => {
    const el = e.target
    if (el.dataset.filter === 'q' || el.dataset.filter === 'siteSearch') {
      const key = el.dataset.filter
      const pos = el.selectionStart
      state[key] = el.value
      render()
      const next = root.querySelector('[data-filter="' + key + '"]')
      if (next) {
        next.focus()
        if (typeof pos === 'number') {
          try { next.setSelectionRange(pos, pos) } catch { /* ignore */ }
        }
      }
      return
    }
    if (el.hasAttribute('data-dirs')) { state.settings.torrentDirs = el.value; return }

    if (el.dataset.set) {
      const k = el.dataset.set
      state.settings[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value)
      return
    }

    if (el.dataset.sd && state.drawer?.kind === 'site') {
      const k = el.dataset.sd
      if (k === 'enabled') state.drawer.draft.enabled = el.checked
      else if (k === 'trackerDomains') state.drawer.draft.trackerDomains = el.value.split(/[\s,;，]+/).map((x) => x.trim()).filter(Boolean)
      else state.drawer.draft[k] = el.value
      const box = root.querySelector('[data-site-preview]')
      if (box) {
        const d = state.drawer.draft
        box.innerHTML =
          `<div><strong>生效方言：</strong>${esc(dialectLabel(resolveDialect(d)))}</div>` +
          `<div><strong>查询接口：</strong>${esc(inferApiUrl(d) || '（请先填写站点地址）')}</div>` +
          `<div><strong>下载方式：</strong>${esc(inferDownloadPreview(d) || '—')}</div>`
      }
      return
    }

    if (el.dataset.dd && state.drawer?.kind === 'downloader') {
      const k = el.dataset.dd
      if (el.type === 'checkbox') state.drawer.draft[k] = el.checked
      else if (k === 'torrentDirs') state.drawer.draft.torrentDirs = el.value.split('\n').map((s) => s.trim()).filter(Boolean)
      else state.drawer.draft[k] = el.value
      if (k === 'type') render()
      return
    }

    if (el.dataset.pmFrom != null && state.drawer?.kind === 'downloader') {
      const mi = Number(el.dataset.pmFrom)
      if (state.drawer.draft.pathMaps[mi]) state.drawer.draft.pathMaps[mi].from = el.value
      return
    }
    if (el.dataset.pmTo != null && state.drawer?.kind === 'downloader') {
      const mi = Number(el.dataset.pmTo)
      if (state.drawer.draft.pathMaps[mi]) state.drawer.draft.pathMaps[mi].to = el.value
      return
    }
  }

  const onChange = async (e) => {
    const el = e.target
    if (el.dataset.set) {
      const k = el.dataset.set
      state.settings[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value)
      return
    }
    if (el.dataset.filter === 'status') { state.statusFilter = el.value; render(); return }
    if (el.dataset.filter === 'dl') { state.dlFilter = el.value; render(); return }
    if (el.dataset.filter === 'site') { state.siteFilter = el.value; render(); return }

    if (el.dataset.checkItem) {
      const fp = el.dataset.checkItem
      const item = (state.data?.items || []).find((x) => x.fingerprint === fp)
      if (item) {
        for (const m of item.matches || []) {
          if (m.status === 'candidate' || m.status === 'failed') {
            const dlId = m.downloaderId || item.clients?.[0]?.downloaderId || ''
            const key = fp + '::' + m.siteId + '::' + dlId
            if (el.checked) state.selectedKeys.add(key)
            else state.selectedKeys.delete(key)
          }
        }
        render()
      }
      return
    }

    if (el.dataset.toggleSite != null) {
      const idx = Number(el.dataset.toggleSite)
      if (state.sites[idx]) {
        state.sites[idx].enabled = el.checked
        await saveSites().catch(() => {})
        render()
      }
      return
    }

    if (el.dataset.toggleDl != null) {
      const idx = Number(el.dataset.toggleDl)
      if (state.downloaders[idx]) {
        state.downloaders[idx].enabled = el.checked
        await saveDownloaders().catch(() => {})
        render()
      }
      return
    }
  }

  root.addEventListener('click', onClick)
  root.addEventListener('input', onInput)
  root.addEventListener('change', onChange)

  render()
  loadAll()

  return () => {
    if (state.pollTimer) clearTimeout(state.pollTimer)
    if (typeof unsubTheme === 'function') unsubTheme()
    root.removeEventListener('click', onClick)
    root.removeEventListener('input', onInput)
    root.removeEventListener('change', onChange)
    element.replaceChildren()
  }
}
