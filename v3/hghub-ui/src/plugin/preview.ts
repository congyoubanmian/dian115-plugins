/**
 * 无宿主预览桥：vite dev 时提供与 DIAN115 页面 ctx 相同接口的 mock。
 * 上游请求经 dev server 中间件（/__hg/edge、/__hg/raw）转发，绕开 CORS 并补 Referer/UA。
 */
import type { DianHttpRequestOptions, DianHttpResponse, DianPluginCtx } from "./ctx";

const LS_PREFIX = "hghub_dev_";

async function devHttp(opts: DianHttpRequestOptions): Promise<DianHttpResponse> {
  const isEdge = opts.url.endsWith("/api/edge/request") && opts.method === "POST";
  if (isEdge) {
    const r = await fetch("/__hg/edge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.json ?? opts.body ?? ""),
    });
    return { status: r.status, body: await r.text() };
  }
  if (opts.response_type === "base64") {
    const r = await fetch(`/__hg/raw?u=${encodeURIComponent(opts.url)}`);
    if (r.status >= 400) return { status: r.status, body: await r.text() };
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return { status: r.status, body_base64: btoa(bin) };
  }
  const r = await fetch(`/__hg/raw?u=${encodeURIComponent(opts.url)}`);
  return { status: r.status, body: await r.text() };
}

function devStorage() {
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(LS_PREFIX + "kv") || "{}");
    } catch {
      return {};
    }
  };
  const write = (kv: Record<string, unknown>) => {
    try {
      localStorage.setItem(LS_PREFIX + "kv", JSON.stringify(kv));
    } catch {
      /* ignore */
    }
  };
  return {
    get: async (key: string) => read()[key],
    set: async (key: string, value: unknown) => {
      const kv = read();
      kv[key] = value;
      write(kv);
      return 1;
    },
    remove: async (key: string) => {
      const kv = read();
      delete kv[key];
      write(kv);
    },
    list: async () => Object.keys(read()),
  };
}

/** 构造预览 ctx（供 main.tsx 在浏览器里跑应用）。 */
export function createPreviewCtx(): DianPluginCtx {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  return {
    id: "huanggu.drama.preview",
    signal: new AbortController().signal,
    theme: {
      mode: media.matches ? "light" : "dark",
      subscribe(fn) {
        const onChange = (e: MediaQueryListEvent) => fn(e.matches ? "light" : "dark");
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
      },
    },
    storage: devStorage(),
    http: { request: devHttp },
  };
}