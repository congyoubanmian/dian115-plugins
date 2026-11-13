// AVDB Lite 页面：X1080X 文章浏览 + 一键 115 磁力离线。
// 站点数据由后台 job 抓取并写入插件 KV；页面只读 KV、调用宿主 API。

const BOARDS = {
  '7RHPO2w4jFUYiDhDsxz0wE': '1080X-BT綜合區',
  '3UKFoLtYJ7dVJH11Vhlhr0': '1080X-探花直播',
  '4QObtALYl5lGgpGdZtpzSr': '1080X-直播精品',
  '03j1fgCMP0OwIajgTgnUJP': '1080X-無碼破解',
  '22OcW3dDpsqmxQDGUk9TM1': '1080X-GIGA / ZEN 特攝女英雄',
  '1qkom8EvNlFV5hrXoHYgxF': '1080X-綜合資源',
  '7cJesEOmwz37MUQcpa23tU': '1080X-訂閱精品',
  '1TzKdT64tXQsh55bFLcP4B': '1080X-MGS素人 / DMM素人',
  '4p9onvFrBhb4GoTJjvMEwm': '1080X-4K超清',
  '14H7D8YbmYIK5gt84qR8mh': '1080X-VR視頻',
  '2SeUSjSuXYiPAfTkWMNc9T': '1080X-高清有碼',
  '0YB5HUwgTlLJnll5PR3Sxz': '1080X-外挂字幕',
  '5Vq0rCx89xT1rMiJ6ZAw42': '1080X-亞洲SM',
  '6Rj9of8m6shoqhAaXiXJje': '1080X-FC2視頻',
  '1I2Kx6AghQua8kCRtGk120': '1080X-S-cute / Mywife',
  '19jr2jN2gjuBwlIGlfoO4a': '1080X-歷史資源',
  '3zfPdYrZvRsB5MYMHwE70K': '1080X-無碼BT',
  '5PDZcHM9127Cbn21wUhl1q': '1080X-有碼BT'
}

const KEY_SETTINGS = 'avdb-settings'
const KEY_ARTICLES = 'avdb-articles'
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

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const selected = Array.isArray(value.boards) ? value.boards.filter(id => BOARDS[id]) : []
  return {
    cookie: String(value.cookie || ''),
    csrf: String(value.csrf || ''),
    boards: selected.length ? selected : ['7RHPO2w4jFUYiDhDsxz0wE'],
    pages: clamp(Number(value.pages) || 1, 1, 3),
    max_items: clamp(Number(value.max_items) || 40, 1, 100),
    cache_images: value.cache_images !== false,
    account_mode: value.account_mode === 'backup' ? 'backup' : 'main',
    account_id: value.account_id ? Number(value.account_id) : null,
    save_cid: String(value.save_cid || '')
  }
}

export function mount(element, ctx) {
  const state = {
    settings: normalizeSettings(null),
    articles: [],
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
      @media(max-width:640px){.avdb{padding:10px}.avdb-list{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}.avdb-magnet{grid-template-columns:1fr auto}}
    </style>
    <div class="avdb">
      <header class="avdb-header">
        <div class="avdb-title">
          <h2>AVDB Lite</h2>
          <span class="avdb-muted">X1080X → 115</span>
        </div>
        <div class="avdb-actions">
          <button type="button" data-action="toggle-settings">设置</button>
          <button type="button" class="primary" data-action="crawl">立即抓取</button>
          <button type="button" data-action="reload">刷新</button>
        </div>
      </header>

      <section class="avdb-panel avdb-settings" data-panel="settings" hidden>
        <div class="row">
          <label>X1080X Cookie
            <textarea data-k="cookie" placeholder="粘贴浏览器里 x1080x.com 的完整 Cookie"></textarea>
          </label>
          <label>X-CSRFToken（可选）
            <input data-k="csrf" placeholder="站点要求时填写">
          </label>
        </div>
        <div>
          <div class="avdb-muted">抓取板块</div>
          <div class="avdb-boards" data-boards></div>
        </div>
        <div class="row">
          <label>每个板块页数
            <input data-k="pages" type="number" min="1" max="3" step="1">
          </label>
          <label>最多文章数
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
          <label>缓存封面到插件目录
            <span style="display:flex;align-items:center;gap:6px"><input data-k="cache_images" type="checkbox" style="width:auto"> 是</span>
          </label>
        </div>
        <div class="avdb-actions">
          <button type="button" class="primary" data-action="save-settings">保存设置</button>
          <span class="avdb-muted">Cookie/CSRF 只保存在插件加密 KV；不会写入日志。</span>
        </div>
      </section>

      <div class="avdb-toolbar">
        <input data-filter="query" placeholder="搜索标题 / 番号 / ID">
        <select data-filter="board"><option value="all">全部板块</option></select>
        <span class="avdb-muted" data-lastrun></span>
      </div>
      <div class="avdb-status" data-status></div>
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
    board: element.querySelector('[data-filter="board"]')
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
      cookie: element.querySelector('[data-k="cookie"]').value,
      csrf: element.querySelector('[data-k="csrf"]').value,
      boards: Array.from(element.querySelectorAll('[data-board]:checked')).map(input => input.dataset.board),
      pages: element.querySelector('[data-k="pages"]').value,
      max_items: element.querySelector('[data-k="max_items"]').value,
      save_cid: element.querySelector('[data-k="save_cid"]').value,
      account_mode: element.querySelector('[data-k="account_mode"]').value,
      account_id: element.querySelector('[data-k="account_id"]').value,
      cache_images: element.querySelector('[data-k="cache_images"]').checked
    })
  }

  function fillSettingsForm() {
    const s = state.settings
    element.querySelector('[data-k="cookie"]').value = s.cookie
    element.querySelector('[data-k="csrf"]').value = s.csrf
    element.querySelector('[data-k="pages"]').value = String(s.pages)
    element.querySelector('[data-k="max_items"]').value = String(s.max_items)
    element.querySelector('[data-k="save_cid"]').value = s.save_cid
    element.querySelector('[data-k="account_mode"]').value = s.account_mode
    element.querySelector('[data-k="account_id"]').value = s.account_id ? String(s.account_id) : ''
    element.querySelector('[data-k="cache_images"]').checked = s.cache_images
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
      ui.list.innerHTML = `<div class="avdb-empty">${state.articles.length ? '没有匹配的文章' : '还没有数据，填好 Cookie 后点“立即抓取”'}</div>`
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
              ${article.published_at ? `<span>${esc(short(article.published_at, 19))}</span>` : ''}
            </div>
            <div class="avdb-meta">
              <span>磁力 ${magnets}</span>
              ${edk ? `<span>ED2K ${edk}</span>` : ''}
              ${article.access_denied ? '<span style="color:#e5484d">需要登录/权限</span>' : ''}
              ${article.detail_error ? '<span style="color:#e5484d">详情失败</span>' : ''}
            </div>
            <div class="avdb-card-actions">
              <button type="button" data-action="detail" data-id="${esc(article.id)}">详情</button>
              <button type="button" class="primary" data-action="send-first" data-id="${esc(article.id)}" ${magnets ? '' : 'disabled'}>发送 115</button>
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
      ? `上次：${short(state.lastRun.at || '', 19)} · ${state.lastRun.count || 0} 条 · 失败 ${state.lastRun.failed || 0}`
      : '尚未抓取'
  }

  async function loadData() {
    state.settings = normalizeSettings(await ctx.storage.get(KEY_SETTINGS))
    const articles = await ctx.storage.get(KEY_ARTICLES)
    state.articles = Array.isArray(articles) ? articles : []
    const lastRun = await ctx.storage.get(KEY_LAST_RUN)
    state.lastRun = lastRun && typeof lastRun === 'object' ? lastRun : null
    fillSettingsForm()
  }

  async function saveSettings() {
    const next = readSettingsFromForm()
    if (!next.boards.length) throw new Error('至少选择一个板块')
    await ctx.storage.set(KEY_SETTINGS, next)
    state.settings = next
    fillBoardFilter()
    setStatus('设置已保存')
  }

  async function runCrawl() {
    try {
      await saveSettings()
    } catch (error) {
      setStatus(error.message, true)
      return
    }
    if (!state.settings.cookie) {
      setStatus('请先填写 X1080X Cookie', true)
      ui.settingsPanel.hidden = false
      return
    }
    setStatus('已提交抓取任务…')
    try {
      const task = await ctx.tasks.run('crawl-x1080x', 'crawl:' + Date.now(), {})
      setStatus('抓取任务已提交：' + (task.id || ''))
      pollTask(task.id)
    } catch (error) {
      setStatus('提交失败：' + error.message, true)
    }
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

  async function send115(article, kind, index, button) {
    const list = kind === 'edk' ? article.edk : article.magnets
    const url = Array.isArray(list) ? list[index] : ''
    if (!url) throw new Error('没有可发送的链接')
    const body = { urls: [url] }
    const s = state.settings
    if (s.save_cid) body.save_cid = s.save_cid
    const account = { mode: s.account_mode || 'main' }
    if (account.mode === 'backup' && s.account_id) account.id = Number(s.account_id)
    body.account = account
    if (button) button.disabled = true
    try {
      const result = await ctx.api.post('/api/115/offline/add', body)
      if (!result || result.success !== true || !(Number(result.accepted) > 0)) {
        throw new Error('115 未接受该链接')
      }
      setStatus(`已提交 115，accepted=${result.accepted}`)
    } catch (error) {
      setStatus('发送 115 失败：' + (error.message || error), true)
    } finally {
      if (button) button.disabled = false
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('已复制')
    } catch (_) {
      setStatus('复制失败，请手动选择', true)
    }
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
