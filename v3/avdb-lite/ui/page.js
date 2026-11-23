// AVDB Lite 页面：X1080X 文章浏览 + 一键 115 磁力离线。
// 站点数据由后台 job 抓取并写入插件 KV；页面只读 KV、调用宿主 API。

const BOARDS = {
  '3zfPdYrZvRsB5MYMHwE70K': '1080X-無碼BT',
  '5PDZcHM9127Cbn21wUhl1q': '1080X-有碼BT'
}

const KEY_SETTINGS = 'avdb-settings'
const KEY_ARTICLES = 'avdb-articles'
const KEY_SENT = 'avdb-sent'
const KEY_115 = 'avdb-115'
const KEY_LAST_RUN = 'avdb-last-run'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ESC[ch])
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
function short(text, max) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}
function localTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const selected = Array.isArray(value.boards) ? value.boards.filter(id => BOARDS[id]) : []
  const solver = String(value.flaresolverr_url || '').trim()
  return {
    flaresolverr_url: /^https?:\/\//i.test(solver) ? solver.replace(/\/+$/, '') : 'http://127.0.0.1:8191',
    boards: selected.length ? selected : ['3zfPdYrZvRsB5MYMHwE70K', '5PDZcHM9127Cbn21wUhl1q'],
    max_items: clamp(Number(value.max_items) || 40, 1, 100),
    account_mode: value.account_mode === 'backup' ? 'backup' : 'main',
    account_id: value.account_id ? Number(value.account_id) : null,
    save_cid: String(value.save_cid || '')
  }
}

export function mount(element, ctx) {
  const state = {
    settings: normalizeSettings(null),
    articles: [],
    sent: [],
    lastRun: null,
    query: '',
    board: 'all',
    detailId: '',
    polling: null
  }

  element.innerHTML = `
    <style>
      .avdb{display:grid;gap:14px;padding:16px;color:var(--app-text);background:var(--app-bg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
      .avdb *{box-sizing:border-box}
      .avdb-header{display:flex;flex-wrap:wrap;align-items:center;gap:10px;justify-content:space-between}
      .avdb-title{display:flex;align-items:baseline;gap:10px}
      .avdb-title h2{margin:0;font-size:20px}
      .avdb-muted{color:var(--app-text-secondary);font-size:12px}
      .avdb-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .avdb button{border:1px solid var(--app-border);background:var(--app-surface);color:var(--app-text);border-radius:8px;padding:7px 12px;cursor:pointer}
      .avdb button:hover{border-color:var(--app-accent)}
      .avdb button.primary{background:var(--app-accent);border-color:var(--app-accent);color:#fff}
      .avdb button:disabled{opacity:.45;cursor:not-allowed}
      .avdb input,.avdb textarea,.avdb select{width:100%;border:1px solid var(--app-border);background:var(--app-surface);color:var(--app-text);border-radius:8px;padding:7px 9px;font:inherit}
      .avdb textarea{min-height:76px;resize:vertical}
      .avdb a{color:var(--app-accent)}
      .avdb-panel{border:1px solid var(--app-border);background:var(--app-surface);border-radius:12px;padding:14px}
      .avdb-grid{display:grid;gap:12px}
      .avdb-settings{display:grid;gap:12px}
      .avdb-settings .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
      .avdb-settings label{display:grid;gap:4px;font-size:12px;color:var(--app-text-secondary)}
      .avdb-boards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:4px 12px;max-height:220px;overflow:auto;padding:6px 0}
      .avdb-boards label{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--app-text)}
      .avdb-boards input{width:auto}
      .avdb-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .avdb-toolbar input{flex:1 1 180px}
      .avdb-toolbar select{flex:0 1 240px}
      .avdb-status{min-height:20px;color:var(--app-text-secondary);font-size:12px}
      .avdb-status.error{color:#e5484d}
      .avdb-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
      .avdb-card{border:1px solid var(--app-border);background:var(--app-surface);border-radius:12px;overflow:hidden;display:grid;grid-template-rows:auto 1fr}
      .avdb-cover{aspect-ratio:3/4;background:linear-gradient(135deg,rgba(127,127,127,.16),rgba(127,127,127,.06));display:flex;align-items:center;justify-content:center;color:var(--app-text-secondary);font-size:12px;overflow:hidden}
      .avdb-cover img{width:100%;height:100%;object-fit:cover;display:block}
      .avdb-card-body{display:grid;gap:8px;padding:10px}
      .avdb-card h3{margin:0;font-size:14px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .avdb-meta{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--app-text-secondary);align-items:center}
      .avdb-pill{border:1px solid var(--app-border);border-radius:999px;padding:1px 7px}
      .avdb-card-actions{display:flex;gap:8px;flex-wrap:wrap}
      .avdb-card-actions button{flex:1;padding:6px 8px;font-size:12px}
      .avdb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;z-index:9999}
      .avdb-detail{width:min(860px,96vw);max-height:90vh;overflow:auto;border:1px solid var(--app-border);background:var(--app-bg);color:var(--app-text);border-radius:14px;padding:16px;display:grid;gap:12px}
      .avdb-detail-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
      .avdb-detail h3{margin:0;font-size:18px;line-height:1.35}
      .avdb-magnet{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;border:1px solid var(--app-border);border-radius:8px;padding:6px 8px}
      .avdb-magnet code{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--app-text-secondary)}
      .avdb-magnet button{font-size:11px;padding:4px 8px}
      .avdb-previews{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
      .avdb-previews img{width:100%;border-radius:8px;border:1px solid var(--app-border);aspect-ratio:3/4;object-fit:cover}
      .avdb-empty{padding:28px;text-align:center;color:var(--app-text-secondary);border:1px dashed var(--app-border);border-radius:12px}
      .avdb-offline{display:grid;gap:8px;margin:0 0 12px}
      .avdb-offline-item{display:grid;grid-template-columns:1fr auto;gap:6px 10px;border:1px solid var(--app-border);border-radius:8px;padding:8px 10px;font-size:12px}
      .avdb-offline-item .avdb-offline-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .avdb-offline-item .avdb-offline-meta{grid-column:1/-1;color:var(--app-text-secondary)}
      .avdb-offline-bar{height:4px;border-radius:2px;background:var(--app-border);overflow:hidden}
      .avdb-offline-bar>i{display:block;height:100%;background:#3b82f6}
      @media(max-width:640px){.avdb{padding:10px}.avdb-list{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}.avdb-magnet{grid-template-columns:1fr auto}}
    </style>
    <div class="avdb">
      <header class="avdb-header">
        <div class="avdb-title">
          <h2>AVDB Lite</h2>
          <span class="avdb-muted">X1080X → 115 · 新帖磁力约 6 小时内可见，每 30 分钟自动抓一次</span>
        </div>
        <div class="avdb-actions">
          <button type="button" data-action="toggle-settings">设置</button>
          <button type="button" data-action="offline">离线任务</button>
          <button type="button" data-action="export">导出磁力库</button>
          <button type="button" data-action="diag">复制诊断</button>
          <button type="button" class="primary" data-action="crawl">立即抓取</button>
          <button type="button" data-action="reload">刷新</button>
        </div>
      </header>

      <section class="avdb-panel avdb-settings" data-panel="settings" hidden>
        <div class="row">
          <label>FlareSolverr 地址（过 Cloudflare）
            <input data-k="flaresolverr_url" placeholder="http://127.0.0.1:8191">
          </label>
        </div>
        <div>
          <div class="avdb-muted">抓取板块</div>
          <div class="avdb-boards" data-boards></div>
        </div>
        <div class="row">
          <label>每个板块最多文章数（每页 20 条，自动翻页）
            <input data-k="max_items" type="number" min="1" max="100" step="1">
          </label>
          <label>115 保存目录 cid（可选）
            <input data-k="save_cid" placeholder="留空使用默认离线目录">
          </label>
          <label>115 账号
            <select data-k="account_mode">
              <option value="main">主账号</option>
              <option value="backup">备用账号</option>
            </select>
          </label>
          <label>备用账号 ID（mode=backup 时）
            <input data-k="account_id" type="number" min="1" step="1" placeholder="从账号列表获取">
          </label>
        </div>
        <div class="avdb-actions">
          <button type="button" class="primary" data-action="save-settings">保存设置</button>
          <button type="button" data-action="check-env">检查环境</button>
          <span class="avdb-muted">游客身份就能拿到这两个板块的下载地址，不需要账号；过盾交给同机的 FlareSolverr 容器（Docker），详见插件介绍里的 compose。</span>
          <div class="avdb-muted" data-env></div>
        </div>
      </section>

      <div class="avdb-toolbar">
        <input data-filter="query" placeholder="搜索标题 / 番号 / ID">
        <select data-filter="board"><option value="all">全部板块</option></select>
        <span class="avdb-muted" data-lastrun></span>
      </div>
      <div class="avdb-status" data-status></div>
      <section class="avdb-panel avdb-offline" data-panel="offline" hidden>
        <div class="avdb-actions">
          <strong>115 离线任务（本插件送出的）</strong>
          <button type="button" data-action="offline-refresh">同步状态</button>
          <button type="button" data-action="offline-close">关闭</button>
        </div>
        <div data-offlinelist class="avdb-muted">加载中…</div>
      </section>
      <main class="avdb-list" data-list></main>
      <div data-detail></div>
    </div>`

  const ui = {
    settingsPanel: element.querySelector('[data-panel="settings"]'),
    boards: element.querySelector('[data-boards]'),
    list: element.querySelector('[data-list]'),
    detail: element.querySelector('[data-detail]'),
    status: element.querySelector('[data-status]'),
    lastRun: element.querySelector('[data-lastrun]'),
    query: element.querySelector('[data-filter="query"]'),
    board: element.querySelector('[data-filter="board"]'),
    env: element.querySelector('[data-env]'),
    offlinePanel: element.querySelector('[data-panel="offline"]'),
    offlineList: element.querySelector('[data-offlinelist]')
  }

  ui.boards.innerHTML = Object.entries(BOARDS).map(([id, name]) => `
    <label><input type="checkbox" data-board="${esc(id)}"> ${esc(name)}</label>
  `).join('')

  function setStatus(text, isError = false) {
    ui.status.textContent = text || ''
    ui.status.classList.toggle('error', Boolean(isError))
  }

  function readSettingsFromForm() {
    return normalizeSettings({
      flaresolverr_url: element.querySelector('[data-k="flaresolverr_url"]').value,
      boards: Array.from(element.querySelectorAll('[data-board]:checked')).map(input => input.dataset.board),
      max_items: element.querySelector('[data-k="max_items"]').value,
      save_cid: element.querySelector('[data-k="save_cid"]').value,
      account_mode: element.querySelector('[data-k="account_mode"]').value,
      account_id: element.querySelector('[data-k="account_id"]').value
    })
  }

  function fillSettingsForm() {
    const s = state.settings
    element.querySelector('[data-k="flaresolverr_url"]').value = s.flaresolverr_url
    element.querySelector('[data-k="max_items"]').value = String(s.max_items)
    element.querySelector('[data-k="save_cid"]').value = s.save_cid
    element.querySelector('[data-k="account_mode"]').value = s.account_mode
    element.querySelector('[data-k="account_id"]').value = s.account_id ? String(s.account_id) : ''
    element.querySelectorAll('[data-board]').forEach(input => {
      input.checked = s.boards.includes(input.dataset.board)
    })
    fillBoardFilter()
  }

  function fillBoardFilter() {
    ui.board.innerHTML = '<option value="all">全部板块</option>' + Object.entries(BOARDS)
      .filter(([id]) => state.settings.boards.includes(id))
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')
  }

  function articleMatches(article) {
    if (state.board !== 'all' && article.board_id !== state.board) return false
    const q = state.query.trim().toLowerCase()
    if (!q) return true
    return [article.title, article.id, article.category, article.board_name]
      .some(value => String(value || '').toLowerCase().includes(q))
  }

  function coverUrl(article) {
    if (article.cover) {
      try {
        return ctx.files.downloadURL(article.cover)
      } catch (_) {}
    }
    if (article.cover_remote && /^https?:\/\//i.test(article.cover_remote)) return article.cover_remote
    if (article.preview_images && article.preview_images[0]) return article.preview_images[0]
    return ''
  }

  function renderList() {
    const items = state.articles.filter(articleMatches)
    if (!items.length) {
      const boardName = state.board === 'all' ? '' : (BOARDS[state.board] || state.board)
      ui.list.innerHTML = `<div class="avdb-empty">${state.articles.length
        ? (boardName ? `「${boardName}」本轮没有抓到内容（该板块可能没有磁力链，或抓取预算被别的板块用完）；换个板块看看` : '没有匹配的文章')
        : '还没有数据，点“立即抓取”开始采集'}</div>`
      return
    }
    ui.list.innerHTML = items.map(article => {
      const cover = coverUrl(article)
      const magnets = Array.isArray(article.magnets) ? article.magnets.length : 0
      const edk = Array.isArray(article.edk) ? article.edk.length : 0
      return `
        <article class="avdb-card" data-id="${esc(article.id)}">
          <div class="avdb-cover">${cover
            ? `<img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
            : '无封面'}</div>
          <div class="avdb-card-body">
            <h3 title="${esc(article.title)}">${esc(article.title || article.id)}</h3>
            <div class="avdb-meta">
              <span class="avdb-pill">${esc(article.board_name || '')}</span>
              ${article.category ? `<span class="avdb-pill">${esc(article.category)}</span>` : ''}
              ${article.size ? `<span class="avdb-pill">${esc(article.size)}</span>` : ''}
              ${article.published_at ? `<span>${esc(localTime(article.published_at))}</span>` : ''}
            </div>
            <div class="avdb-meta">
              <span>磁力 ${magnets}${article.magnets_seen_at ? `（${esc(localTime(article.magnets_seen_at))} 抓到）` : ''}</span>
              ${edk ? `<span>ED2K ${edk}</span>` : ''}
              ${article.login_required ? '<span style="color:#e5484d">需登录才能看下载地址</span>' : ''}
              ${article.member_required ? '<span style="color:#e5484d">该帖 6 小时限时已过，需会员权益才能看下载地址</span>' : ''}
              ${article.access_denied ? '<span style="color:#e5484d">需要登录/权限</span>' : ''}
              ${article.detail_error ? '<span style="color:#e5484d">详情失败</span>' : ''}
            </div>
            <div class="avdb-card-actions">
              <button type="button" data-action="detail" data-id="${esc(article.id)}">详情</button>
              <button type="button" class="primary" data-action="send-first" data-id="${esc(article.id)}" ${magnets ? '' : 'disabled'}>${magnets ? '发送 115' : (article.login_required ? '需登录' : (article.member_required ? '需会员' : '无磁力'))}</button>
            </div>
          </div>
        </article>`
    }).join('')
    ui.list.querySelectorAll('img').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none' })
    })
  }

  function renderDetail() {
    if (!state.detailId) {
      ui.detail.innerHTML = ''
      return
    }
    const article = state.articles.find(item => item.id === state.detailId)
    if (!article) {
      state.detailId = ''
      ui.detail.innerHTML = ''
      return
    }
    const cover = coverUrl(article)
    const magnets = Array.isArray(article.magnets) ? article.magnets : []
    const edk = Array.isArray(article.edk) ? article.edk : []
    const previews = (article.preview_images || []).filter(url => /^https?:\/\//i.test(url))
    ui.detail.innerHTML = `
      <div class="avdb-overlay" data-action="close-detail">
        <div class="avdb-detail">
          <div class="avdb-detail-head">
            <div>
              <h3>${esc(article.title || article.id)}</h3>
              <div class="avdb-meta">
                <span class="avdb-pill">${esc(article.board_name || '')}</span>
                ${article.category ? `<span class="avdb-pill">${esc(article.category)}</span>` : ''}
                ${article.size ? `<span class="avdb-pill">${esc(article.size)}</span>` : ''}
                <span>${esc(article.published_at || '')}</span>
              </div>
            </div>
            <button type="button" data-action="close-detail">关闭</button>
          </div>
          ${article.member_required ? '<div style="color:#e5484d">该帖的 6 小时限时免费查看已结束，下载地址需要站点会员权益（插件不绕过站点的会员限制）。</div>' : ''}
          ${article.access_denied ? '<div style="color:#e5484d">该文章需要更高权限，正文/磁力可能不可见。</div>' : ''}
          ${cover ? `<div><img src="${esc(cover)}" alt="" style="max-width:220px;border-radius:10px" referrerpolicy="no-referrer"></div>` : ''}
          <div class="avdb-muted">磁力（${magnets.length}）</div>
          <div class="avdb-grid">
            ${magnets.length ? magnets.map((magnet, index) => `
              <div class="avdb-magnet">
                <code title="${esc(magnet)}">${esc(short(magnet, 110))}</code>
                <button type="button" data-action="copy" data-id="${esc(article.id)}" data-kind="magnet" data-index="${index}">复制</button>
                <button type="button" class="primary" data-action="send" data-id="${esc(article.id)}" data-kind="magnet" data-index="${index}">发送 115</button>
              </div>`).join('') : '<div class="avdb-muted">没有提取到磁力</div>'}
          </div>
          ${edk.length ? `
            <div class="avdb-muted">ED2K（${edk.length}）</div>
            <div class="avdb-grid">
              ${edk.map((link, index) => `
                <div class="avdb-magnet">
                  <code title="${esc(link)}">${esc(short(link, 110))}</code>
                  <button type="button" data-action="copy" data-id="${esc(article.id)}" data-kind="edk" data-index="${index}">复制</button>
                  <button type="button" class="primary" data-action="send" data-id="${esc(article.id)}" data-kind="edk" data-index="${index}">发送 115</button>
                </div>`).join('')}
            </div>` : ''}
          ${article.archive_passwords && article.archive_passwords.length ? `
            <div class="avdb-muted">压缩包密码</div>
            <div>${article.archive_passwords.map(value => `<span class="avdb-pill">${esc(value)}</span>`).join(' ')}</div>` : ''}
          ${article.archive_names && article.archive_names.length ? `
            <div class="avdb-muted">压缩包文件</div>
            <div class="avdb-muted">${article.archive_names.map(value => esc(value)).join('<br>')}</div>` : ''}
          ${previews.length ? `
            <div class="avdb-muted">预览图</div>
            <div class="avdb-previews">${previews.map(url => `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>` : ''}
          <div class="avdb-meta">
            <a href="${esc(article.detail_url)}" target="_blank" rel="noreferrer">打开原帖</a>
            ${article.detail_error ? `<span style="color:#e5484d">${esc(article.detail_error)}</span>` : ''}
          </div>
        </div>
      </div>`
    ui.detail.querySelectorAll('img').forEach(img => {
      img.addEventListener('error', () => { img.style.display = 'none' })
    })
  }

  function render() {
    renderList()
    renderDetail()
    ui.lastRun.textContent = state.lastRun
      ? `上次：${esc(localTime(state.lastRun.at))} · 库内 ${state.lastRun.count || 0} 条 · ${state.lastRun.with_magnets || 0} 条有磁力`
        + (state.lastRun.fetched != null ? ` · 本轮新取 ${state.lastRun.fetched} / 跳过已知 ${state.lastRun.skipped || 0}` : '')
        + ` · 失败 ${state.lastRun.failed || 0}`
      : '尚未抓取'
  }

  async function loadData() {
    state.settings = normalizeSettings(await ctx.storage.get(KEY_SETTINGS))
    const articles = await ctx.storage.get(KEY_ARTICLES)
    state.articles = Array.isArray(articles) ? articles : []
    const lastRun = await ctx.storage.get(KEY_LAST_RUN)
    state.lastRun = lastRun && typeof lastRun === 'object' ? lastRun : null
    const sent = await ctx.storage.get(KEY_SENT)
    state.sent = Array.isArray(sent) ? sent : []
    fillSettingsForm()
  }

  async function saveSettings() {
    const next = readSettingsFromForm()
    if (!next.boards.length) throw new Error('至少选择一个板块')
    await ctx.storage.set(KEY_SETTINGS, next)
    state.settings = next
    fillBoardFilter()
    setStatus('设置已保存')
    // 地址可能刚改过，顺手探一下 Docker 那边配好没有
    checkEnvironment()
  }

  /** 宿主接口报错时把真正的原因捞出来（axios 默认只给状态码）。 */
  function apiErrorText(error) {
    const data = error && (error.response?.data || error.data)
    if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 240)
    if (data && typeof data === 'object') {
      const text = data.error || data.message || data.reason || data.detail || data.error_code
      if (text) return String(text).slice(0, 240)
    }
    return String((error && error.message) || error || '').slice(0, 240)
  }

  /**
   * 环境自检：插件把「过盾」交给同机的 FlareSolverr 容器，
   * 所以这里直接探一下它通不通、/login 路由在不在，
   * 省得用户对着「提交失败 400」猜 Docker 是不是没起。
   */
  async function checkEnvironment() {
    const solver = String(state.settings.flaresolverr_url || '').replace(/\/+$/, '')
    const lines = []
    try {
      const res = await ctx.http.request({
        url: solver + '/health',
        method: 'GET',
        headers: { Accept: 'application/json' },
        proxy: 'direct',
        timeout_seconds: 10
      })
      if (res.status === 200) {
        lines.push('FlareSolverr 已连接（' + solver + '）')
        // /login 是挂上去的路由：404 说明容器用的是官方原版镜像
        const probe = await ctx.http.request({
          url: solver + '/login',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
          proxy: 'direct',
          timeout_seconds: 10
        })
        const data = probe.data || {}
        if (probe.status === 200 && data.error === '缺少账号或密码') {
          lines.push('（附带的 /login 路由可用，游客模式用不到）')
        } else if (probe.status === 404) {
          lines.push('没有 /login 路由也没关系：游客模式用不到它')
        }
      } else {
        lines.push('FlareSolverr 返回 HTTP ' + res.status)
      }
    } catch (error) {
      lines.push('连不上 FlareSolverr（' + solver + '）：' + apiErrorText(error) + ' —— Docker 容器没起或端口不对')
    }
    ui.env.textContent = lines.join('；')
  }

  /**
   * 清掉卡住的任务。宿主重启等情况下任务会停在 attention_required，
   * 而抓取任务不允许并行运行（有未完成的同类任务时新任务直接 400），
   * 定时调度也会被堵着。
   */
  async function clearStuckRuns() {
    let cleared = 0
    try {
      const pluginId = (ctx.plugin && ctx.plugin.id) || 'avdb.lite'
      const res = await ctx.api.get('/api/extensions/v3/' + pluginId + '/runs')
      const runs = Array.isArray(res) ? res : (res && Array.isArray(res.runs) ? res.runs : [])
      for (const run of runs) {
        if (!run || run.status !== 'attention_required') continue
        if (run.job_id && run.job_id !== 'crawl-x1080x') continue
        try {
          await ctx.api.post('/api/extensions/v3/' + pluginId + '/runs/' + encodeURIComponent(run.id) + '/cancel', {})
          cleared++
        } catch (_) {}
      }
    } catch (_) {}
    return cleared
  }

  async function runCrawl() {
    try {
      await saveSettings()
    } catch (error) {
      setStatus(error.message, true)
      return
    }
    setStatus('正在提交抓取任务…')
    let task = null
    try {
      task = await ctx.tasks.run('crawl-x1080x', 'crawl:' + Date.now(), {})
    } catch (error) {
      // 有没跑完的同类任务卡着时，新任务会被宿主直接拒掉；先清掉再试一次。
      const cleared = await clearStuckRuns()
      if (!cleared) {
        setStatus('提交失败：' + apiErrorText(error), true)
        return
      }
      setStatus('清理了 ' + cleared + ' 个卡住的任务，重新提交…')
      try {
        task = await ctx.tasks.run('crawl-x1080x', 'crawl:' + Date.now(), {})
      } catch (retryError) {
        setStatus('提交失败：' + apiErrorText(retryError), true)
        return
      }
    }
    setStatus('抓取任务已提交：' + (task.id || ''))
    pollTask(task.id)
  }

  /** 轮询后台同步任务，完成后刷新面板。 */
  function pollSync(taskId) {
    if (!taskId) return
    let ticks = 0
    const tick = async () => {
      try {
        const task = await ctx.tasks.get(taskId)
        const status = task && task.status
        if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
          await loadOfflineTasks()
          if (status === 'succeeded') setStatus('115 状态已同步')
          else setStatus('同步任务未成功：' + (status || ''), true)
          return
        }
      } catch (_) {}
      if (++ticks < 60) setTimeout(tick, 1500)
    }
    setTimeout(tick, 1200)
  }

  function pollTask(taskId) {
    if (!taskId) return
    if (state.polling) clearTimeout(state.polling)
    let ticks = 0
    const tick = async () => {
      if (ctx.signal && ctx.signal.aborted) return
      ticks++
      try {
        const task = await ctx.tasks.get(taskId)
        const status = String((task && (task.status || task.state)) || '').toLowerCase()
        if (['completed', 'success', 'succeeded', 'done'].includes(status)) {
          setStatus('抓取完成，正在刷新…')
          await loadData()
          render()
          setStatus('抓取完成')
          return
        }
        if (['failed', 'error', 'cancelled', 'canceled', 'attention_required'].includes(status)) {
          setStatus('抓取失败：' + String((task && (task.error || task.message)) || status), true)
          await loadData()
          render()
          return
        }
        setStatus('抓取中：' + String((task && (task.message || task.stage)) || status || '…'))
      } catch (error) {
        setStatus('查询任务失败：' + error.message, true)
        return
      }
      if (ticks < 150) state.polling = setTimeout(tick, 2000)
      else setStatus('任务仍在运行，稍后点“刷新”查看结果')
    }
    state.polling = setTimeout(tick, 1500)
  }

  /**
   * 取 115 账号。写操作的 account.mode/id 要从 GET /api/115/accounts/options 取，
   * 只给 mode 不给 id 宿主可能挑不出账号（表现为 400）。
   */
  async function resolveAccount() {
    const s = state.settings
    const wanted = s.account_mode === 'backup' ? 'backup' : 'main'
    try {
      const res = await ctx.api.get('/api/115/accounts/options')
      const list = Array.isArray(res?.accounts) ? res.accounts : (Array.isArray(res) ? res : [])
      const hit = list.find(item => item && item.mode === wanted &&
        (wanted !== 'backup' || Number(item.id) === Number(s.account_id)))
      if (!hit) {
        const names = list.map(item => `${item.mode}/${item.name || item.id}`).join('、')
        throw new Error(`宿主里没有可用的 115 ${wanted} 账号（现有：${names || '无'}）`)
      }
      return { mode: wanted, id: Number(hit.id) }
    } catch (error) {
      // 取不到就退回最简形式，让宿主用默认主账号
      if (wanted === 'backup') throw error
      return { mode: 'main' }
    }
  }


  /** 记下送出去的磁力，面板按这个过滤（文章被轮换掉也不影响）。 */
  async function rememberSent(url, article) {
    const hit = String(url || '').match(/urn:btih:([A-Za-z0-9]+)/i)
    if (!hit) return
    const hash = hit[1].toUpperCase()
    let list = []
    try { list = await ctx.storage.get(KEY_SENT) } catch (_) {}
    list = Array.isArray(list) ? list : []
    list = list.filter(item => item && String(item.hash).toUpperCase() !== hash)
    list.unshift({
      hash,
      title: String((article && article.title) || '').slice(0, 80),
      at: new Date().toISOString()
    })
    if (list.length > 100) list.length = 100
    try { await ctx.storage.set(KEY_SENT, list) } catch (_) {}
  }


  /** 把库里所有磁力/ED2K 导出成一份本地文件（插件自有目录，可下载）。 */
  async function exportLibrary() {
    const articles = Array.isArray(state.articles) ? state.articles : []
    const rows = []
    for (const article of articles) {
      for (const magnet of article.magnets || []) rows.push({ kind: 'magnet', url: magnet, ...metaOf(article) })
      for (const edk of article.edk || []) rows.push({ kind: 'ed2k', url: edk, ...metaOf(article) })
    }
    if (!rows.length) {
      setStatus('库里还没有磁力链可导出', true)
      return
    }
    const lines = rows.map(row => [row.kind, row.title, row.published_at, row.url].join('\t'))
    const text = ['# kind\ttitle\tpublished\turl', ...lines].join('\n')
    try {
      await ctx.files.call({ operation: 'write', path: 'magnet-library.tsv', content: text })
      const url = ctx.files.downloadURL('magnet-library.tsv')
      let link = element.querySelector('[data-liblink]')
      if (!link) {
        link = document.createElement('a')
        link.setAttribute('data-liblink', '')
        link.style.cssText = 'font-size:12px;color:var(--app-link,#3b82f6)'
        ui.status.parentElement.appendChild(link)
      }
      link.href = url
      link.textContent = `下载 magnet-library.tsv（${rows.length} 条）`
      link.setAttribute('download', 'magnet-library.tsv')
      setStatus(`已导出 ${rows.length} 条链接到插件文件 magnet-library.tsv`)
    } catch (error) {
      setStatus('导出失败：' + apiErrorText(error), true)
    }
  }

  function metaOf(article) {
    return {
      title: String(article.title || ''),
      published_at: String(article.published_at || ''),
      board: String(article.board_name || ''),
      id: String(article.id || '')
    }
  }

  /**
   * 115 离线任务面板：直接读插件 KV（后台同步好的），打开就显示，不去拉 115。
   * 要最新状态点「同步状态」，由后台任务去查一次 115。
   */
  async function loadOfflineTasks() {
    ui.offlinePanel.hidden = false
    ui.offlineList.innerHTML = '加载中…'
    try {
      const saved = await ctx.storage.get(KEY_115)
      const items = Array.isArray(saved) ? saved : []
      if (!items.length) {
        ui.offlineList.textContent = '还没有本插件送出的离线任务记录（送过一次磁力后点「同步状态」）'
        return
      }
      const statusText = {
        downloading: '下载中', completed: '已完成', failed: '失败',
        pending: '排队中', paused: '已暂停', running: '进行中',
        unknown: '115 列表里没有（可能已完成或被拒）'
      }
      const latest = items.map(item => item.updated_at).filter(Boolean).sort().pop() || ''
      ui.offlineList.innerHTML = items.map(item => {
        const progress = Math.max(0, Math.min(1, Number(item.progress) || 0))
        const rate = Number(item.rate) || 0
        const meta = [
          statusText[item.status] || item.status || '',
          item.size ? (item.size / 1024 ** 3).toFixed(2) + ' GB' : '',
          rate ? (rate / 1024).toFixed(0) + ' KB/s' : '',
          item.error ? '报错：' + item.error : ''
        ].filter(Boolean).join(' · ')
        return `<div class="avdb-offline-item">
          <div class="avdb-offline-name" title="${esc(item.title || item.hash || '')}">${esc(item.title || item.hash || '(未命名)')}</div>
          <div>${esc(item.hash || '').slice(0, 12)}</div>
          <div class="avdb-offline-meta">${esc(meta)}</div>
          <div class="avdb-offline-bar"><i style="width:${Math.round(progress * 100)}%"></i></div>
        </div>`
      }).join('') + (latest ? `<div class="avdb-muted">状态快照：${esc(latest)}</div>` : '')
    } catch (error) {
      ui.offlineList.textContent = '读不到离线任务：' + apiErrorText(error)
    }
  }

  async function send115(article, kind, index, button) {
    const list = kind === 'edk' ? article.edk : article.magnets
    const url = Array.isArray(list) ? list[index] : ''
    if (!url) throw new Error('没有可发送的链接')
    const s = state.settings
    if (button) button.disabled = true
    try {
      const account = await resolveAccount()
      const body = { urls: [url], account }
      if (s.save_cid) body.save_cid = s.save_cid
      let result = null
      let lastError = ''
      // 主账号这几种写法宿主都可能收，逐个试，把每次的真实报错都带上
      const bodies = [body]
      if (account.mode === 'main' && !s.save_cid) {
        bodies.push({ urls: [url], account: { mode: 'main', id: account.id } })
        bodies.push({ urls: [url] })
      }
      for (const payload of bodies) {
        try {
          result = await ctx.api.post('/api/115/offline/add', payload)
          break
        } catch (error) {
          lastError = apiErrorText(error)
        }
      }
      if (!result) {
        // 宿主把 115 的错误简化成 "errno=0"：115 实际返回的是「种子获取失败」
        //（errcode 10001，BT 没有做种者时 115 拿不到种子文件信息），这里翻译一下。
        if (/errno=0/.test(lastError || '')) {
          throw new Error('115 拿不到这个种子的文件信息（多半是已经没人做种了，115 取不到种子内容）；换一个种子试试，或者用 ED2K 链接')
        }
        throw new Error(lastError || '宿主拒绝了这次提交')
      }
      if (!result || result.success !== true || !(Number(result.accepted) > 0)) {
        throw new Error('115 未接受该链接（' + JSON.stringify(result).slice(0, 160) + '）')
      }
      await rememberSent(url, article)
      setStatus(`已提交 115，accepted=${result.accepted}（要看下载状态，点面板里的「同步状态」）`)
    } catch (error) {
      setStatus('发送 115 失败：' + apiErrorText(error), true)
    } finally {
      if (button) button.disabled = false
    }
  }

  async function copyText(text) {
    // 剪贴板 API 只在安全上下文可用；DIAN115 多半是 http，这里做多级兜底。
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        setStatus('已复制到剪贴板')
        return true
      }
    } catch (_) {}
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', 'readonly')
      area.style.position = 'fixed'
      area.style.top = '0'
      area.style.left = '0'
      area.style.width = '1px'
      area.style.height = '1px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.focus()
      area.select()
      area.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      if (ok) {
        setStatus('已复制到剪贴板')
        return true
      }
    } catch (_) {}
    setStatus('浏览器不允许自动复制，请手动选中下面的内容复制', true)
    showDiag(text)
    return false
  }

  function showDiag(text) {
    let box = element.querySelector('[data-diag]')
    if (!box) {
      box = document.createElement('pre')
      box.setAttribute('data-diag', '')
      box.style.cssText = 'white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:320px;overflow:auto;border:1px solid var(--app-border);border-radius:8px;padding:10px;background:var(--app-surface);color:var(--app-text)'
      ui.status.after(box)
    }
    box.textContent = text
    box.hidden = false
  }

  const onClick = async event => {
    const button = event.target.closest('[data-action]')
    if (!button) return
    const action = button.dataset.action
    if (action === 'toggle-settings') {
      ui.settingsPanel.hidden = !ui.settingsPanel.hidden
      return
    }
    if (action === 'save-settings') {
      try {
        await saveSettings()
      } catch (error) {
        setStatus(error.message, true)
      }
      return
    }
    if (action === 'export') {
      await exportLibrary()
      return
    }
    if (action === 'offline') {
      await loadOfflineTasks()
      return
    }
    if (action === 'offline-refresh') {
      ui.offlineList.textContent = '正在后台同步 115 状态…'
      try {
        const task = await ctx.tasks.run('sync-115', 'sync115:' + Date.now(), {})
        setStatus('已提交 115 状态同步任务：' + (task.id || ''))
        pollSync(task.id)
      } catch (error) {
        setStatus('提交同步失败：' + apiErrorText(error), true)
      }
      return
    }
    if (action === 'offline-close') {
      ui.offlinePanel.hidden = true
      return
    }
    if (action === 'check-env') {
      ui.env.textContent = '检查中…'
      await checkEnvironment()
      return
    }
    if (action === 'diag') {
      const diag = await ctx.storage.get('avdb-diag')
      if (!diag) {
        setStatus('还没有诊断信息（先点一次「立即抓取」）', true)
        return
      }
      const text = JSON.stringify(diag, null, 2)
      showDiag(text)
      // 同时落一份文件，页面里给下载链接（http 环境下这是最可靠的取法）
      try {
        await ctx.files.call({ operation: 'write', path: 'diag/last.json', content: text })
        const url = ctx.files.downloadURL('diag/last.json')
        const link = element.querySelector('[data-diaglink]') || (() => {
          const a = document.createElement('a')
          a.setAttribute('data-diaglink', '')
          a.style.cssText = 'font-size:12px;color:var(--app-accent)'
          ui.status.after(a)
          return a
        })()
        link.href = url
        link.textContent = '下载诊断文件 diag/last.json'
        link.hidden = false
      } catch (error) {
        setStatus('诊断文件写入失败：' + error.message, true)
      }
      await copyText(text)
      return
    }
    if (action === 'crawl') {
      await runCrawl()
      return
    }
    if (action === 'reload') {
      await loadData()
      render()
      setStatus('已刷新')
      return
    }
    if (action === 'close-detail') {
      // 点击详情卡片内部不关闭，只有遮罩和“关闭”按钮关闭。
      if (event.target.closest('.avdb-detail') && !event.target.closest('button[data-action="close-detail"]')) return
      state.detailId = ''
      renderDetail()
      return
    }
    if (action === 'detail') {
      state.detailId = button.dataset.id || ''
      renderDetail()
      return
    }
    if (action === 'copy') {
      const article = state.articles.find(item => item.id === button.dataset.id)
      if (!article) return
      const list = button.dataset.kind === 'edk' ? article.edk : article.magnets
      const url = Array.isArray(list) ? list[Number(button.dataset.index)] : ''
      if (url) await copyText(url)
      return
    }
    if (action === 'send' || action === 'send-first') {
      const article = state.articles.find(item => item.id === button.dataset.id)
      if (!article) return
      const kind = button.dataset.kind || 'magnet'
      const index = action === 'send-first' ? 0 : Number(button.dataset.index)
      await send115(article, kind, index, button)
      return
    }
  }

  element.addEventListener('click', onClick)
  ui.query.addEventListener('input', () => {
    state.query = ui.query.value
    renderList()
  })
  ui.board.addEventListener('change', () => {
    state.board = ui.board.value
    renderList()
  })

  ;(async () => {
    try {
      await loadData()
      render()
    } catch (error) {
      setStatus('加载失败：' + error.message, true)
    }
  })()

  return () => {
    if (state.polling) clearTimeout(state.polling)
    element.removeEventListener('click', onClick)
    element.innerHTML = ''
  }
}
