/**
 * 媒体管线：封面解密（AES-128-CBC）+ HLS 自定义 loader + 直连媒体 blob。
 *
 * 上游封面是 AES-128-CBC 密文；m3u8 分片/key 带防盗链（Referer 校验）且跨域。
 * 全部请求走宿主 HTTP（ctx.http.request，服务端代发、无浏览器 CORS、可带 Referer/UA），
 * 二进制用 base64 回传；封面用 WebCrypto 在页面内解密后生成 blob URL。
 */
import { b64decode, base, httpRequest, UA, type DianHttpRequestOptions } from "./ctx";

/* ── 封面解密 ─────────────────────────────────────────────── */

const IMG_KEY = new TextEncoder().encode("f5d965df75336270");
const IMG_IV = new TextEncoder().encode("97b60394abc2fbe1");

/** 插件模式下的封面标记协议：src 会被替换成 `hgcover:<url>`，由页面统一异步解析。 */
export const COVER_PREFIX = "hgcover:";
export const isCoverMarker = (url: string) => url.startsWith(COVER_PREFIX);
export const stripCoverMarker = (url: string) => url.slice(COVER_PREFIX.length);

async function aesCbcDecrypt(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error("封面密文长度无效");
  const key = await crypto.subtle.importKey("raw", IMG_KEY, { name: "AES-CBC" }, false, ["decrypt"]);
  const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv: IMG_IV }, key, data);
  return new Uint8Array(out);
}

function imageKind(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  return null;
}

/* 内存 LRU：与 Rust 侧 IMG_CACHE 同策略（上限 240 条） */
const coverCache = new Map<string, string>();
const COVER_CACHE_MAX = 240;

function cachePut(key: string, url: string): void {
  if (coverCache.has(key)) coverCache.delete(key);
  coverCache.set(key, url);
  if (coverCache.size > COVER_CACHE_MAX) {
    const oldest = coverCache.keys().next().value;
    if (oldest !== undefined) coverCache.delete(oldest);
  }
}

function mediaHeaders(): Record<string, string> {
  return { Referer: `${base()}/`, "User-Agent": UA };
}

/** 拉取并解密一张封面，返回 blob URL（带缓存）。 */
export async function resolveCover(raw: string): Promise<string> {
  const key = raw;
  const hit = coverCache.get(key);
  if (hit) return hit;

  const r = await httpRequest({
    url: raw,
    method: "GET",
    headers: mediaHeaders(),
    response_type: "base64",
    timeout_seconds: 30,
  } as DianHttpRequestOptions);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const enc = r.body_base64;
  if (!enc) throw new Error("封面响应为空");

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = b64decode(enc);
  } catch {
    throw new Error("封面 base64 解析失败");
  }
  const kind = imageKind(bytes);
  if (kind) {
    // 非密文（图片头直接可识别）→ 原样使用
    const blob = new Blob([bytes], { type: kind });
    const url = URL.createObjectURL(blob);
    cachePut(key, url);
    return url;
  }
  const plain = await aesCbcDecrypt(bytes);
  const type = imageKind(plain) || "image/jpeg";
  const blob = new Blob([plain], { type });
  const url = URL.createObjectURL(blob);
  cachePut(key, url);
  return url;
}

export function clearCoverCache(): void {
  for (const url of coverCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
  coverCache.clear();
}

/* ── 直连媒体（mp4 等非 m3u8） ────────────────────────────── */

const directCache = new Map<string, string>();

/** 非 m3u8 媒体：经宿主代拉后转 blob（防盗链 + 无 CORS）。 */
export async function resolveDirectMedia(url: string): Promise<string> {
  const hit = directCache.get(url);
  if (hit) return hit;
  const r = await httpRequest({
    url,
    method: "GET",
    headers: mediaHeaders(),
    response_type: "base64",
    timeout_seconds: 60,
  } as DianHttpRequestOptions);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const enc = r.body_base64;
  if (!enc) throw new Error("媒体响应为空");
  const blob = new Blob([b64decode(enc)], { type: "video/mp4" });
  const objectUrl = URL.createObjectURL(blob);
  directCache.set(url, objectUrl);
  return objectUrl;
}

export function clearDirectCache(): void {
  for (const url of directCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
  directCache.clear();
}

/* ── hls.js 自定义 loader ─────────────────────────────────── */

type HlsStats = {
  trequest: number;
  tfirst: number;
  tload: number;
  loaded: number;
  total: number;
};

type LoaderCallbacks = {
  onSuccess: (data: string | ArrayBuffer, stats: HlsStats, context: unknown, networkDetails: unknown) => void;
  onError: (error: { code: number; text: string }, context: unknown, networkDetails: unknown, stats: HlsStats) => void;
  onTimeout?: (stats: HlsStats, context: unknown) => void;
};

type LoaderContext = { url: string; type: string; responseType?: string; loader?: unknown; frag?: unknown };

export class DianLoader {
  private config: { loadPolicy?: { maxTimeToFirstByteMs?: number; maxLoadTimeMs?: number; timeoutRetry?: unknown } };
  constructor(config: { loadPolicy?: unknown }) {
    this.config = (config || {}) as { loadPolicy?: { maxTimeToFirstByteMs?: number; maxLoadTimeMs?: number; timeoutRetry?: unknown } };
  }

  destroy(): void {
    /* 无状态：请求由 ctx.http 内部管理 */
  }

  abort(): void {
    /* 无状态 */
  }

  load(context: LoaderContext, _config: unknown, callbacks: LoaderCallbacks): void {
    const url = context.url;
    const t0 = performance.now();
    const stats: HlsStats = { trequest: t0, tfirst: 0, tload: 0, loaded: 0, total: 0 };

    const done = (data: string | ArrayBuffer) => {
      const now = performance.now();
      stats.tfirst = now;
      stats.tload = now;
      stats.loaded = typeof data === "string" ? data.length : data.byteLength;
      stats.total = stats.loaded;
      callbacks.onSuccess(data, stats, context, { url });
    };
    const fail = (text: string, code = 2) => {
      const now = performance.now();
      stats.tfirst = stats.tload = now;
      callbacks.onError({ code, text }, context, { url }, stats);
    };

    const isManifest = context.type === "manifest" || context.type === "level" || context.type === "audioTrack" || context.type === "subtitle";
    const opts: DianHttpRequestOptions = {
      url,
      method: "GET",
      headers: mediaHeaders(),
      timeout_seconds: 45,
    };
    if (!isManifest) opts.response_type = "base64";

    httpRequest(opts)
      .then((r) => {
        if (r.status >= 400) {
          fail(`HTTP ${r.status}`, 2);
          return;
        }
        if (isManifest) {
          done(r.body ?? "");
        } else {
          const b64 = r.body_base64;
          if (!b64) {
            fail("响应为空", 2);
            return;
          }
          try {
            done(b64decode(b64).buffer as ArrayBuffer);
          } catch {
            fail("base64 解析失败", 2);
          }
        }
      })
      .catch((e: Error) => fail(String(e?.message || e), 2));
  }
}

/** 同时注入 manifest / 分片 / key 三个 loader。 */
export function hlsLoaders(): { pLoader: typeof DianLoader; fLoader: typeof DianLoader; kLoader: typeof DianLoader } {
  return { pLoader: DianLoader, fLoader: DianLoader, kLoader: DianLoader };
}

/** 插件模式下 hls.js 不启用 worker（srcdoc 容器内 blob worker 不可靠）。 */
export function hlsOptions(): Record<string, unknown> {
  return { loaders: hlsLoaders(), enableWorker: false };
}