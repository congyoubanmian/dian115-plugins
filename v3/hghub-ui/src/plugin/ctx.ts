/**
 * DIAN115 v3 页面 ctx 桥接层。
 *
 * 宿主在插件页面注入 ctx（http/storage/theme/signal…），本模块把应用需要的
 * 能力收敛成一套接口：上游信封调用（edge）、线路管理、会话与设置持久化。
 * 无宿主预览时（`vite dev`）由 preview.ts 提供同一接口的 mock 实现。
 */

/* ── 宿主 ctx 类型（只声明用到的子集） ─────────────────────── */

export type DianHttpRequestOptions = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  body_base64?: string;
  json?: unknown;
  response_type?: "text" | "base64" | "json";
  timeout_seconds?: number;
  session?: string;
};

export type DianHttpResponse = {
  status: number;
  url?: string;
  headers?: Record<string, string[]>;
  body?: string;
  body_base64?: string;
  data?: unknown;
  cached?: boolean;
  error?: string;
};

export type DianStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, expected_revision?: number | string): Promise<number>;
  remove(key: string): Promise<void>;
  list(): Promise<string[]>;
};

export type DianTheme = { mode: "light" | "dark"; subscribe(fn: (mode: "light" | "dark") => void): () => void };

export type DianPluginCtx = {
  id: string;
  signal: AbortSignal;
  theme: DianTheme;
  storage: DianStorage;
  http: {
    request(opts: DianHttpRequestOptions): Promise<DianHttpResponse>;
  };
  api?: {
    get(path: string): Promise<unknown>;
    post(path: string, body?: unknown): Promise<unknown>;
  };
};

/* ── 运行时状态 ────────────────────────────────────────────── */

let ctx: DianPluginCtx | null = null;

export function installPlugin(c: DianPluginCtx): void {
  ctx = c;
  followHostTheme = true;
}

export function pluginCtx(): DianPluginCtx | null {
  return ctx;
}

/* ── 主题跟随 ─────────────────────────────────────────────── */

/** 用户手动切换过外观后就不再跟随宿主主题 */
let followHostTheme = true;
let onHostTheme: ((mode: "light" | "dark") => void) | null = null;

export function themeFollowEnabled(): boolean {
  return followHostTheme;
}

export function markThemeTouched(): void {
  followHostTheme = false;
}

export function setHostThemeListener(fn: (mode: "light" | "dark") => void): void {
  onHostTheme = fn;
  const c = ctx;
  if (c?.theme?.subscribe) {
    c.theme.subscribe((mode) => {
      if (followHostTheme) onHostTheme?.(mode);
    });
  }
}

/* ── 上游线路（数据源） ───────────────────────────────────── */

export const DEFAULT_BASE = "https://huangguoai.com";

export const FIXED_LINES: { name: string; url: string }[] = [
  { name: "固定线路 1", url: "https://huangguoai.com" },
  { name: "固定线路 2", url: "https://thu.adihsppe.cc" },
  { name: "固定线路 3", url: "https://pku.adihsppe.cc" },
];

/** 官方发布页的国内备用入口（2026-11 抓取）：可直连，适合大陆网络。 */
export const DOMESTIC_LINES: { name: string; url: string }[] = [
  { name: "国内备用 01", url: "https://boazcf.rlhjeyuvw.cc" },
  { name: "国内备用 02", url: "https://uyq06.rlhjeyuvw.cc" },
  { name: "国内备用 03", url: "https://y3vg73.rlhjeyuvw.cc" },
];

const PUBLISH_PAGE = "https://huangguoai.pages.dev/";
const MIRROR_MAX = 60;
const CUSTOM_MAX = 30;

/** 已失效线路：KV 里残留时自动回落默认线路（2026-11 起 .ai 域名的 API 全部 404）。 */
const DEAD_LINES = new Set(["https://huangguoai.ai"]);

let baseCache = DEFAULT_BASE;
let baseLoaded = false;
let customCache: string[] = [];

type LineStore = { base?: string; custom?: unknown };

export function base(): string {
  return baseCache;
}

/** 用户自定义线路（KV 持久化，顺序即添加顺序）。 */
export function customLines(): { name: string; url: string }[] {
  return customCache.map((url, i) => ({ name: `自定义线路 ${i + 1}`, url }));
}

function sanitizeCustom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const next = normalizeBase(entry);
    if (!next || DEAD_LINES.has(next)) continue;
    if (FIXED_LINES.some((line) => line.url === next) || DOMESTIC_LINES.some((line) => line.url === next)) continue;
    if (!out.includes(next)) out.push(next);
    if (out.length >= CUSTOM_MAX) break;
  }
  return out;
}

export function normalizeBase(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 启动时从 KV 恢复上次线路与自定义线路（在首屏渲染前 await）。 */
export async function loadLine(): Promise<void> {
  if (baseLoaded) return;
  baseLoaded = true;
  try {
    const saved = (await ctx?.storage.get("lines")) as LineStore | null;
    customCache = sanitizeCustom(saved?.custom);
    if (saved?.base) {
      const next = normalizeBase(saved.base);
      if (next && !DEAD_LINES.has(next)) baseCache = next;
    }
  } catch {
    /* KV 不可用时保持默认线路 */
  }
}

export async function setBase(url: string): Promise<string> {
  const next = normalizeBase(url);
  if (!next) throw new Error("线路地址无效（需要纯 HTTPS 站点地址）");
  const previous = baseCache;
  baseCache = next;
  // 切换线路本身不因 KV 写入失败而回退（与会话内生效语义一致）。
  if (previous !== next) {
    try {
      await saveLine();
    } catch {
      /* 忽略持久化失败 */
    }
  }
  return next;
}

/** 添加自定义线路：只接受纯 HTTPS origin，内置线路/重复项/超限直接报错。 */
export async function addCustomLine(raw: string): Promise<string> {
  const next = normalizeBase(raw);
  if (!next) throw new Error("线路地址无效（需要纯 HTTPS 站点地址，不能带路径/参数）");
  if (FIXED_LINES.some((line) => line.url === next) || DOMESTIC_LINES.some((line) => line.url === next)) {
    throw new Error("该地址已是内置线路");
  }
  if (customCache.includes(next)) throw new Error("该地址已添加过");
  if (customCache.length >= CUSTOM_MAX) throw new Error(`自定义线路最多 ${CUSTOM_MAX} 条`);
  customCache.push(next);
  try {
    await saveLine();
  } catch (e) {
    customCache = customCache.filter((url) => url !== next);
    throw e;
  }
  return next;
}

/** 删除自定义线路；若删除的是当前线路，回落默认线路并返回新 base。 */
export async function removeCustomLine(url: string): Promise<string> {
  const next = normalizeBase(url);
  if (!next) return baseCache;
  const index = customCache.indexOf(next);
  if (index < 0) return baseCache;
  customCache.splice(index, 1);
  if (baseCache === next) baseCache = DEFAULT_BASE;
  await saveLine();
  return baseCache;
}

async function saveLine(): Promise<void> {
  try {
    await ctx?.storage.set("lines", { base: baseCache, custom: customCache });
  } catch (e) {
    throw e instanceof Error ? e : new Error("保存线路失败");
  }
}

/** 固定线路 + 镜像线路拉取（只在用户打开线路页时调用）。 */
export async function lineMirrors(): Promise<{ source: string; script?: string; items: { url: string; host: string }[] }> {
  const html = await httpText(PUBLISH_PAGE, 12000);
  const jsRel = scriptSrc(html) ?? "publish.js";
  const jsUrl = absoluteUrl(PUBLISH_PAGE, jsRel);
  const js = await httpText(jsUrl, 12000);

  const domains = jsArray(js, "var urls");
  const subs = jsArray(js, "var subdomains");
  if (!domains.length) throw new Error("地址发布页格式有变化：没找到镜像域名");

  const items: { url: string; host: string }[] = [];
  const seen = new Set<string>();
  outer: for (const domain of domains) {
    const d = domain.replace(/\/+$/, "");
    if (!d) continue;
    const hosts = subs.length ? subs.map((s) => `${s}.${d}`) : [d];
    for (const host of hosts) {
      if (seen.has(host)) continue;
      seen.add(host);
      items.push({ url: `https://${host}`, host });
      if (items.length >= MIRROR_MAX) break outer;
    }
  }
  if (!items.length) throw new Error("地址发布页里没有可用的镜像地址");
  return { source: PUBLISH_PAGE, script: jsUrl, items };
}

export async function lineProbe(urls: string[]): Promise<{ url: string; ok: boolean; status?: number; ms: number; error?: string }[]> {
  const out: { url: string; ok: boolean; status?: number; ms: number; error?: string }[] = [];
  for (const chunk of chunked(urls, 6)) {
    const results = await Promise.all(chunk.map(async (u) => {
      const started = Date.now();
      try {
        const r = await httpRequest({ url: u, method: "GET", timeout_seconds: 8, headers: { Accept: "text/html,application/xhtml+xml" } });
        return { url: u, ok: r.status < 400, status: r.status, ms: Date.now() - started };
      } catch (e) {
        return { url: u, ok: false, ms: Date.now() - started, error: String((e as Error).message || e) };
      }
    }));
    out.push(...results);
  }
  return out;
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ── 上游信封调用（edge/request） ─────────────────────────── */

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type SessionState = { token?: string; user?: unknown };

let session: SessionState = {};

export async function loadSession(): Promise<SessionState> {
  try {
    const s = (await ctx?.storage.get("session")) as SessionState | null;
    if (s?.token) session = s;
  } catch {
    /* ignore */
  }
  return session;
}

export function sessionToken(): string | undefined {
  return session.token;
}

export function sessionUser(): unknown {
  return session.user;
}

export async function saveSession(s: SessionState): Promise<void> {
  session = s;
  try {
    if (s.token) await ctx?.storage.set("session", s);
    else await ctx?.storage.remove("session");
  } catch {
    /* ignore */
  }
}

/** 信封调用：POST {base}/api/edge/request，body 里 base64 编码。 */
export async function edge(
  origin: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const cur = normalizeBase(origin);
  if (!cur) throw new Error("业务请求必须使用安全 HTTPS 线路");
  const encoded = body === undefined ? "" : b64encode(JSON.stringify(body));
  const envelope = {
    method,
    path,
    body: encoded,
    content_type: body === undefined ? "" : "application/json",
  };
  const headers: Record<string, string> = {
    Accept: "application/json",
    Referer: `${cur}/`,
    "User-Agent": UA,
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await httpRequest({
    url: `${cur}/api/edge/request`,
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    timeout_seconds: 45,
  });
  if (r.status === 401 || r.status === 403) throw new Error("401");
  if (r.status >= 400) {
    throw new Error(`HTTP ${r.status}: ${String(r.body || r.error || "").slice(0, 160)}`);
  }
  const text = r.body ?? "";
  if (!text.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${(e as Error).message}: ${text.slice(0, 160)}`);
  }
  const v = value as { status?: number; data?: unknown; msg?: string };
  if (v.status === 1) return v.data ?? null;
  throw new Error((v.msg || "接口返回失败").toString());
}

/**
 * 直连 REST：不经 edge 信封（上游 2026-11 新版取址/播放接口是明文 REST，
 * 如 POST /api/videos/{id}/episodes/{ep}/playback）。响应外壳与信封一致：{status:1,data}。
 */
export async function directApi(
  origin: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const cur = normalizeBase(origin);
  if (!cur) throw new Error("业务请求必须使用安全 HTTPS 线路");
  const headers: Record<string, string> = {
    Accept: "application/json",
    Referer: `${cur}/`,
    "User-Agent": UA,
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await httpRequest({
    url: `${cur}${path}`,
    method,
    headers,
    body: JSON.stringify(body === undefined ? {} : body),
    timeout_seconds: 45,
  });
  if (r.status === 401 || r.status === 403) throw new Error("401");
  if (r.status >= 400) {
    throw new Error(`HTTP ${r.status}: ${String(r.body || r.error || "").slice(0, 160)}`);
  }
  const text = r.body ?? "";
  if (!text.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${(e as Error).message}: ${text.slice(0, 160)}`);
  }
  const v = value as { status?: number; code?: number; data?: unknown; msg?: string };
  if (v.status === 1 || v.code === 200) return v.data ?? null;
  if (v.status === undefined && v.code === undefined && v.data !== undefined) return v.data;
  throw new Error((v.msg || "接口返回失败").toString());
}

/* ── 通用 HTTP（宿主代发 / 预览桥） ───────────────────────── */

export async function httpRequest(opts: DianHttpRequestOptions): Promise<DianHttpResponse> {
  const c = ctx;
  if (!c) throw new Error("插件运行时未初始化");
  return c.http.request(opts);
}

export async function httpText(url: string, timeout = 20000): Promise<string> {
  const r = await httpRequest({ url, method: "GET", timeout_seconds: timeout });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return r.body ?? "";
}

/* ── base64 / 解析工具（对应 Rust 侧实现） ─────────────────── */

export function b64encode(bytes: Uint8Array | string): string {
  if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 从 HTML 里挑出脚本地址（发布页只有一个 publish.js?<版本>）。 */
export function scriptSrc(html: string): string | null {
  const re = /src="([^"]*\.js[^"]*)"/i;
  const m = re.exec(html);
  return m ? m[1] : null;
}

export function absoluteUrl(base: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel;
  try {
    return new URL(rel, base.endsWith("/") ? base : base + "/").href;
  } catch {
    return rel;
  }
}

/** 取 JS 里 `var <name> = [ ... ]` 的字符串数组（去行尾 // 注释，保留引号内 //）。 */
export function jsArray(src: string, decl: string): string[] {
  const at = src.indexOf(decl);
  if (at < 0) return [];
  const rest = src.slice(at);
  const open = rest.indexOf("[");
  if (open < 0) return [];
  const close = rest.slice(open).indexOf("]");
  if (close < 0) return [];
  return stripLineComments(rest.slice(open + 1, open + close))
    .split(",")
    .map((raw) => raw.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter((s) => s.length > 0);
}

export function stripLineComments(body: string): string {
  let out = "";
  let quote: string | null = null;
  const chars = body;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") i++;
      if (i < chars.length) out += "\n";
    } else {
      out += c;
    }
  }
  return out;
}