"""给 FlareSolverr 挂一个 POST /login 路由。

站点（1080xin）的登录接口强制要 Turnstile token，缺了就返回 turnstile_required；
token 只有在登录表单被填写之后才会渲染，而且必须由能过 Cloudflare 的真实浏览器
签发。FlareSolverr 里的 Chromium 正好满足这两点，所以在同一个会话浏览器里把登录
做完最省事：

  1. 过 Cloudflare 挑战，打开登录页
  2. 填表单（站点自己才会渲染 Turnstile 控件）
  3. 等 Turnstile 出 token（必要时点一下控件）
  4. 带 token 直接 POST 站点的登录接口
  5. 登录成功后回到首页，让站点签发「列表用途」的通行凭据
     （站点的通行凭据按用途区分，登录页签发的那套调不了列表/详情接口）
  6. 把 Cookie 与 User-Agent 一起返回，插件用普通 HTTP 继续取数

会话是 FlareSolverr 原有的 session 机制：插件用同一个 session 名调 /v1，
浏览器里的登录态一直都在。
"""

import json
import logging
import threading
import time

from bottle import request, response

import flaresolverr_service
from flaresolverr_service import V1RequestBase, _evil_logic

LOGIN_LOCK = threading.Lock()

PAGE_SCRIPT = """
function deepFind(root, pred){
  const out = [];
  (function walk(n){
    if(!n) return;
    if(n.nodeType===1 && pred(n)) out.push(n);
    if(n.shadowRoot) walk(n.shadowRoot);
    if(n.children) for(const c of n.children) walk(c);
  })(root);
  return out;
}
function readCookie(name){
  const hit = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
return {
  title: document.title,
  path: location.pathname + location.search,
  hasUser: !!document.getElementById('auth-username'),
  hasPass: !!document.getElementById('auth-password'),
  token: (function(){
    const ins = deepFind(document, e => e.tagName === 'INPUT' && e.name === 'cf-turnstile-response');
    if (ins.length && ins[0].value) return ins[0].value;
    try { if (window.turnstile && window.turnstile.getResponse) return window.turnstile.getResponse() || ''; } catch (e) {}
    return '';
  })(),
  widgetRect: (function(){
    const ins = deepFind(document, e => e.tagName === 'INPUT' && e.name === 'cf-turnstile-response');
    if (!ins.length) return null;
    let node = ins[0].parentElement;
    for (let i = 0; i < 4 && node; i++) {
      const r = node.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) return {x: r.x, y: r.y, w: r.width, h: r.height};
      node = node.parentElement;
    }
    return null;
  })(),
  bodyText: (document.body ? document.body.textContent : '').replace(/\\s+/g, ' ').slice(0, 200)
};
"""

FILL_SCRIPT = """
const username = arguments[0], password = arguments[1];
return (function(){
  function setValue(el, val){
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  const u = document.getElementById('auth-username');
  const p = document.getElementById('auth-password');
  if (!u || !p) return 'no-form';
  u.focus(); setValue(u, username);
  p.focus(); setValue(p, password);
  return 'filled:' + u.value + '/密码长度' + (p.value ? p.value.length : 0);
})()
"""

LOGIN_SCRIPT = """
const done = arguments[arguments.length - 1];
const token = arguments[0], username = arguments[1], password = arguments[2], loginType = arguments[3];
function readCookie(name){
  const hit = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}
fetch('/api/auth/login', {
  method: 'POST',
  credentials: 'same-origin',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-CSRFToken': readCookie('__Host-x1080x_csrf'),
    'X-Turnstile-Token': token
  },
  body: JSON.stringify({username: username, login_type: loginType, password: password})
}).then(async r => {
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  done({status: r.status, data: data, text: text.slice(0, 300)});
}).catch(e => done({status: 0, data: null, text: String(e)}));
"""


def _page_state(driver):
    try:
        return driver.execute_script(PAGE_SCRIPT) or {}
    except Exception as error:
        logging.warning("读取页面状态失败：%s" % error)
        return {}


def _cookies(driver):
    out = []
    for item in driver.get_cookies():
        out.append({
            "name": item.get("name"),
            "value": item.get("value"),
            "domain": item.get("domain"),
            "path": item.get("path") or "/",
            "secure": bool(item.get("secure")),
            "httpOnly": bool(item.get("httpOnly")),
            "sameSite": item.get("sameSite") or "Lax",
            "expiry": int(item.get("expiry") or (time.time() + 3600)),
            "expirationDate": int(item.get("expiry") or (time.time() + 3600)),
        })
    return out


def _solve_login(driver, username, password, base, steps):
    url = base.rstrip("/") + "/login?return=%2Fmember"
    steps.append("打开登录页 " + url)
    req = V1RequestBase({"cmd": "request.get", "url": url, "maxTimeout": 180000})
    res = _evil_logic(req, driver, "GET")
    steps.append("过盾：" + str(res.message))
    state = _page_state(driver)
    steps.append("页面：title=%s form=%s" % (state.get("title"), state.get("hasUser")))
    if not state.get("hasUser"):
        return {"ok": False, "error": "登录页没有渲染出表单（可能被 Cloudflare 拦截）", "steps": steps}

    filled = driver.execute_script(FILL_SCRIPT, username, password)
    steps.append("填写表单：" + str(filled))

    token = ""
    deadline = time.time() + 90
    clicked = False
    while time.time() < deadline:
        time.sleep(2)
        state = _page_state(driver)
        if state.get("token"):
            token = state["token"]
            steps.append("拿到 Turnstile token")
            break
        rect = state.get("widgetRect")
        if rect and not clicked:
            x = rect["x"] + 30
            y = rect["y"] + rect["h"] / 2
            try:
                driver.execute_cdp_cmd("Input.dispatchMouseEvent",
                                       {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
                driver.execute_cdp_cmd("Input.dispatchMouseEvent",
                                       {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
                clicked = True
                steps.append("点了验证框")
            except Exception as error:
                steps.append("点验证框失败：" + str(error))
    if not token:
        steps.append("没有等到 Turnstile token")
        return {"ok": False, "error": "Turnstile 没有出 token", "steps": steps, "state": _page_state(driver)}

    login_type = "email" if "@" in username else "username"
    result = driver.execute_async_script(LOGIN_SCRIPT, token, username, password, login_type)
    steps.append("登录接口：HTTP %s %s" % (result.get("status"), str(result.get("text"))[:160]))
    if result.get("status") != 200:
        return {"ok": False, "error": "登录接口拒绝：" + str(result.get("text"))[:200],
                "steps": steps, "state": _page_state(driver)}

    # 回首页：让站点签发「列表用途」的通行凭据（登录页那套调不了列表/详情接口）
    try:
        driver.get(base.rstrip("/") + "/")
        time.sleep(6)
        steps.append("回到首页：title=%s" % _page_state(driver).get("title"))
    except Exception as error:
        steps.append("回首页失败：" + str(error))

    cookies = _cookies(driver)
    user_agent = driver.execute_script("return navigator.userAgent")
    steps.append("返回 %d 条 Cookie" % len(cookies))
    return {"ok": True, "cookies": cookies, "userAgent": user_agent, "steps": steps}


def register(app):
    @app.post('/login')
    def login():
        data = request.json or {}
        username = str(data.get('username') or '')
        password = str(data.get('password') or '')
        base = str(data.get('base') or 'https://1080xin.com')
        session_id = str(data.get('session') or 'avdb-lite')
        max_timeout = int(data.get('maxTimeout') or 180000)
        if not username or not password:
            response.status = 400
            return json.dumps({"ok": False, "error": "缺少账号或密码"}, ensure_ascii=False)

        if not LOGIN_LOCK.acquire(blocking=False):
            response.status = 429
            return json.dumps({"ok": False, "error": "上一个登录还在进行中"}, ensure_ascii=False)

        steps = []
        try:
            session, fresh = flaresolverr_service.SESSIONS_STORAGE.create(session_id=session_id)
            steps.append("会话 %s %s" % (session_id, "新建" if fresh else "复用"))
            req = V1RequestBase({"cmd": "request.get", "url": base, "maxTimeout": max_timeout})
            result = _solve_login(session.driver, username, password, base, steps)
        except Exception as error:
            logging.exception("登录失败")
            result = {"ok": False, "error": str(error), "steps": steps}
        finally:
            LOGIN_LOCK.release()
        return json.dumps(result, ensure_ascii=False)

    return app
