import type {
  CommentPage, Detail, Paged, PlayInfo, Post, RankItem, User, VideoCard,
} from "./types";
import { isStrictSecurity as htmlStrict, setStrictSecurity as setHtmlStrictSecurity } from "./html";
import {
  base, DEFAULT_BASE, edge, FIXED_LINES, lineMirrors as fetchMirrors, lineProbe as probeLines,
  loadLine, loadSession, saveSession, sessionToken, sessionUser, setBase,
  httpRequest, pluginCtx, b64decode, UA,
} from "./plugin/ctx";
import { clearCoverCache, clearDirectCache, COVER_PREFIX, isCoverMarker, stripCoverMarker, resolveCover } from "./plugin/media";

/* ── 运行环境（转发自 env.ts，保持原有导出面） ────────────── */

export { PLUGIN, LOCAL, isLocalMedia, isAndroid, isIos, isMacos, platform, isMobile } from "./env";
import { PLUGIN, LOCAL } from "./env";

/** 应用版本（构建时由 vite 从 package.json 注入） */
export const APP_VERSION = __APP_VERSION__;

/**
 * 封面地址。插件模式返回 `hgcover:<url>` 标记：浏览器加载该 src 必然失败并触发
 * error 事件，由页面统一拦截（Img 组件 / 图文正文的错误捕获）后经宿主代拉 +
 * WebCrypto 解密换成 blob URL。桌面模式保持原本地解密协议。
 */
export const cover = (url?: string, _w = 480) =>
  url ? (PLUGIN ? `${COVER_PREFIX}${url}` : `${LOCAL}/img?u=${encodeURIComponent(url)}`) : "";

/** m3u8 播放列表：插件模式原样返回（hls.js 自定义 loader 走宿主代发并带防盗链头）。 */
export const playlist = (url: string) => (PLUGIN ? url : `${LOCAL}/hls?u=${encodeURIComponent(url)}`);

export const isHlsUrl = (url: string) => /\.m3u8(\?|$)/i.test(url);

/** 写一行到调试日志（插件模式：console，宿主无任务日志可写）。 */
export const logLine = (msg: string) => {
  if (PLUGIN) {
    console.debug("[hghub]", msg);
    return;
  }
  void msg;
};

/* ── 调用封装 ───────────────────────────────────────────── */

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await pluginDispatch(cmd, args)) as T;
  } catch (e) {
    const msg = typeof e === "string" ? e : (e as Error).message || "请求失败，请检查网络";
    logLine(`[api] ${cmd} → ${msg}`);
    const status = /^HTTP (\d{3})\b/.exec(msg)?.[1];
    if (status) {
      throw new Error(`服务器请求失败（HTTP ${status}），请稍后重试或在设置中切换线路`);
    }
    throw new Error(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
  }
}

/* ── 插件分发：命令名 → 桥接实现（替代原 Tauri invoke） ──── */

async function pluginDispatch(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const origin = base();
  const token = sessionToken();

  switch (cmd) {
    case "app_boot": {
      const strict = await readStrict();
      return {
        user: sessionUser() ?? null,
        logged_in: !!token,
        base: origin,
        strict_security: strict,
        cli_relaxed: false,
      };
    }
    case "security_set": {
      const strict = !!args?.strict;
      await writeStrict(strict);
      setHtmlStrictSecurity(strict);
      return strict;
    }
    case "api_login": {
      const data = (await edge(
        origin, "POST", "/api/account/loginByPassword",
        { username: args?.username, password: args?.password }, undefined,
      )) as { token?: string; user?: User };
      if (!data?.token) throw new Error("登录返回缺少 token");
      await saveSession({ token: data.token, user: data.user ?? null });
      return { user: data.user ?? null };
    }
    case "api_register": {
      const body: Record<string, unknown> = {
        username: args?.username, password: args?.password, confirm_password: args?.password,
      };
      if (args?.email) body.email = args.email;
      const data = (await edge(origin, "POST", "/api/account/registerByPassword", body, undefined)) as {
        token?: string; user?: User;
      };
      if (!data?.token) throw new Error("注册返回缺少 token");
      await saveSession({ token: data.token, user: data.user ?? null });
      return { user: data.user ?? null };
    }
    case "api_logout": {
      try {
        await edge(origin, "POST", "/api/account/logout", undefined, token);
      } catch { /* 忽略 */ }
      await saveSession({});
      return { ok: true };
    }
    case "api_me": {
      const me = (await edge(origin, "GET", "/api/account/me", undefined, token)) as User;
      await saveSession({ token, user: me });
      return me;
    }

    case "api_feed":
      return edge(origin, "GET", `/api/videos?page=${args?.page}&size=${args?.size}`, undefined, token);
    case "api_category":
      return edge(origin, "GET", `/api/videos/category/${args?.cate}?page=${args?.page}&size=${args?.size}`, undefined, token);
    case "api_rank": {
      const kind = args?.kind === "recommend" || args?.kind === "potential" ? args.kind : "hot";
      return edge(origin, "GET", `/api/ranks/${kind}`, undefined, token);
    }
    case "api_search":
      return edge(origin, "GET", `/api/search?q=${encodeURIComponent(String(args?.q ?? ""))}&page=${args?.page}&size=${args?.size}`, undefined, token);
    case "api_posts":
      return edge(origin, "GET", `/api/posts?page=${args?.page}&size=${args?.size}`, undefined, token);
    case "api_post":
      return edge(origin, "GET", `/api/posts/${args?.id}`, undefined, token);

    case "api_video":
      return edge(origin, "GET", `/api/videos/${args?.id}`, undefined, token);
    case "api_play":
      return edge(origin, "GET", `/api/videos/${args?.id}/play?ep=${args?.ep}&page_texts=0`, undefined, token);

    case "api_comments":
      return edge(origin, "GET", `/api/videos/${args?.id}/comments?ep=${args?.ep}&page=${args?.page}&size=${args?.size}`, undefined, token);
    case "api_comment_send": {
      const body: Record<string, unknown> = { text: args?.text };
      const path = args?.replyId
        ? `/api/videos/${args?.id}/comments`
        : `/api/videos/${args?.id}/comments?ep=${args?.ep}`;
      if (args?.replyId) body.reply_id = args.replyId;
      return edge(origin, "POST", path, body, token);
    }
    case "api_like": {
      const method = args?.on ? "POST" : "DELETE";
      return edge(origin, method, `/api/videos/${args?.id}/like?ep=${args?.ep}`, undefined, token);
    }
    case "api_collect": {
      const method = args?.on ? "POST" : "DELETE";
      return edge(origin, method, `/api/videos/${args?.id}/collect`, undefined, token);
    }
    case "api_follow": {
      const method = args?.on ? "POST" : "DELETE";
      return edge(origin, method, `/api/users/${args?.uid}/follow`, undefined, token);
    }
    case "api_post_like": {
      const method = args?.on ? "POST" : "DELETE";
      return edge(origin, method, `/api/posts/${args?.id}/like`, undefined, token);
    }
    case "api_post_collect": {
      const method = args?.on ? "POST" : "DELETE";
      return edge(origin, method, `/api/posts/${args?.id}/collect`, undefined, token);
    }
    case "api_post_comments":
      return edge(origin, "GET", `/api/posts/${args?.id}/comments?page=${args?.page}&size=${args?.size}`, undefined, token);

    case "cache_clear":
      clearCoverCache();
      clearDirectCache();
      return undefined;

    case "net_diag":
      return {
        mode: "dian115-plugin",
        base: origin,
        ua: navigator.userAgent,
        http_via_host: true,
      };

    case "line_state":
      return { base: origin, default: DEFAULT_BASE, fixed: FIXED_LINES };
    case "line_set":
      return setBase(String(args?.url ?? ""));
    case "line_mirrors":
      return fetchMirrors();
    case "line_probe":
      return probeLines((args?.urls as string[]) || []);

    case "check_update":
      return checkUpdate();

    case "open_url": {
      const url = String(args?.url ?? "");
      const w = window.open(url, "_blank", "noopener");
      if (!w) throw new Error("当前环境无法打开外部链接");
      return undefined;
    }

    default:
      throw new Error(`未知命令：${cmd}`);
  }
}

async function readStrict(): Promise<boolean> {
  const c = pluginCtx();
  if (!c) return htmlStrict();
  try {
    const v = await c.storage.get("strict");
    return v === false ? false : true;
  } catch {
    return htmlStrict();
  }
}

async function writeStrict(strict: boolean): Promise<void> {
  const c = pluginCtx();
  if (!c) return;
  try {
    await c.storage.set("strict", strict);
  } catch { /* ignore */ }
}

/* ── 更新检查（插件版本：对比本仓库 hghub-v 前缀 tag） ─────── */

export type UpdateInfo = {
  current: string;
  latest: string;
  tag?: string;
  has_update: boolean;
  url: string;
  name?: string;
  published_at?: string;
  notes?: string;
};

function verParts(v: string): number[] {
  return v.trim().replace(/^[vV]/, "").split(/[.\-+]/).map((s) => Number.parseInt(s, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = verParts(latest), b = verParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const PLUGIN_REPO = "congyoubanmian/dian115-plugins";
const PLUGIN_TAG_PREFIX = "hghub-v";

async function checkUpdate(): Promise<UpdateInfo> {
  const current = APP_VERSION;
  const url = `https://api.github.com/repos/${PLUGIN_REPO}/releases?per_page=20`;
  try {
    const r = await httpRequest({
      url,
      method: "GET",
      headers: { Accept: "application/vnd.github+json", "User-Agent": UA },
      timeout_seconds: 12,
    });
    if (r.status >= 400) return { current, latest: "", has_update: false, url: `https://github.com/${PLUGIN_REPO}/releases` };
    const list = (JSON.parse(r.body || "[]") as { tag_name?: string; html_url?: string; name?: string; published_at?: string; body?: string }[]);
    const mine = list.find((x) => x.tag_name?.startsWith(PLUGIN_TAG_PREFIX));
    if (!mine?.tag_name) return { current, latest: "", has_update: false, url: `https://github.com/${PLUGIN_REPO}/releases` };
    const tag = mine.tag_name;
    return {
      current,
      latest: tag.slice(PLUGIN_TAG_PREFIX.length),
      tag,
      has_update: isNewer(tag, `${PLUGIN_TAG_PREFIX}${current}`),
      url: mine.html_url || `https://github.com/${PLUGIN_REPO}/releases`,
      name: mine.name,
      published_at: mine.published_at,
      notes: (mine.body || "").slice(0, 800),
    };
  } catch {
    return { current, latest: "", has_update: false, url: `https://github.com/${PLUGIN_REPO}/releases` };
  }
}

/* ── 接口 ───────────────────────────────────────────────── */

export const api = {
  boot: () => call<{
    user: User | null;
    logged_in: boolean;
    base: string;
    strict_security?: boolean;
    cli_relaxed?: boolean;
  }>("app_boot"),
  securitySet: (strict: boolean) => call<boolean>("security_set", { strict }),
  login: (username: string, password: string) =>
    call<{ user: User }>("api_login", { username, password }),
  register: (username: string, password: string, email = "") =>
    call<{ user: User }>("api_register", { username, password, email }),
  logout: () => call<{ ok: boolean }>("api_logout"),
  me: () => call<User>("api_me"),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>("api_feed", { page, size }),
  category: (cate: string, page = 1, size = 20) =>
    call<Paged<VideoCard>>("api_category", { cate, page, size }),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>("api_rank", { kind }),
  search: (q: string, page = 1, size = 20) =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", { q, page, size },
    ),
  posts: (page = 1, size = 20) => call<Paged<Post>>("api_posts", { page, size }),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>("api_post", { id }),

  video: (id: number) => call<Detail>("api_video", { id }),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", { id, ep }),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", { id, ep, page, size }),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>("api_comment_send", { id, ep, text, replyId: replyId ?? null }),

  clearCache: () => call<void>("cache_clear"),
  netDiag: () => call<Record<string, unknown>>("net_diag"),
  postLike: (id: number, on: boolean) => call<unknown>("api_post_like", { id, on }),
  postCollect: (id: number, on: boolean) => call<unknown>("api_post_collect", { id, on }),
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", { id, page, size }),
  like: (id: number, ep: number, on: boolean) => call<unknown>("api_like", { id, ep, on }),
  collect: (id: number, on: boolean) => call<unknown>("api_collect", { id, on }),
  follow: (uid: number, on: boolean) => call<unknown>("api_follow", { uid, on }),

  /* 线路（数据源）：固定线路写死，镜像线路按需从地址发布页拉取 */
  lineState: () => call<LineState>("line_state"),
  lineSet: (url: string) => call<string>("line_set", { url }),
  lineMirrors: () => call<LineMirrors>("line_mirrors"),
  lineProbe: (urls: string[]) => call<LineProbe[]>("line_probe", { urls }),

  /* 更新检查：对比插件仓库 hghub-v 前缀 tag */
  checkUpdate: () => call<UpdateInfo>("check_update"),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

/* ── 线路（数据源） ─────────────────────────────────────── */

export type LineItem = { name?: string; url: string; host?: string };
export type LineState = { base: string; default: string; fixed: LineItem[] };
export type LineMirrors = { source: string; script?: string; items: LineItem[] };
export type LineProbe = { url: string; ok: boolean; status?: number; ms: number; error?: string };

/** `https://a.b/c` → `a.b`（线路展示用） */
export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

/* ── 插件模式启动钩子（首屏前调用） ──────────────────────── */

export async function pluginBoot(): Promise<void> {
  if (!PLUGIN) return;
  await Promise.all([loadLine(), loadSession()]);
}

/* ── 自检：验证 webview → 本地协议 → 上游 的取流链路（仅桌面） ── */
export async function selfTest(): Promise<string> {
  if (PLUGIN) return "plugin-mode:no-local-protocol";
  const steps: string[] = [];
  try {
    const info = await api.play(117, 3);
    steps.push(`play:${info?.video_url ? "ok" : "empty"}`);
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(info.video_url)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        steps.push(`rustUrl:${rustUrl.slice(0, 60)}`);
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        steps.push(`inner:${inner.slice(0, 50)}`);
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

/* ── 格式化 ─────────────────────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = n % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

/** 非 m3u8 媒体（mp4 等）：桌面走本地透传，插件模式由 VideoSurface 经宿主代拉转 blob。 */
export function directMedia(url: string): string {
  return PLUGIN ? url : `${LOCAL}/seg?u=${encodeURIComponent(url)}`;
}

/** 按扩展名选择代理方式：m3u8 → 播放列表（自定义 loader）；其它 → 原样（blob 由播放组件处理）。 */
export function mediaUrl(url: string): string {
  return /\.m3u8(\?|$)/i.test(url) ? playlist(url) : directMedia(url);
}

/** 封面解析统一入口：接受裸地址或 hgcover: 标记，返回 blob URL（带缓存）。 */
export async function resolveCoverSrc(src: string): Promise<string> {
  let target = src;
  if (isCoverMarker(target)) target = stripCoverMarker(target);
  if (!target) throw new Error("封面地址为空");
  if (/^(blob:|data:)/i.test(target)) return target;
  return resolveCover(target);
}

export { b64decode };