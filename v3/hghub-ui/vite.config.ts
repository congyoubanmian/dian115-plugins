import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * 无宿主预览桥（dev only）：把上游请求转发到本机 dev server，绕开浏览器 CORS，
 * 并在服务端补 Referer/UA。预览桥与真实 DIAN115 ctx 走同一套 DianCtx 接口。
 */
function devProxy(): Plugin {
  return {
    name: "hghub-dev-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        if (url === "/__hg/ping") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.startsWith("/__hg/edge")) {
          try {
            let body = "";
            for await (const chunk of req) body += chunk;
            const upstream = "https://huangguoai.com/api/edge/request";
            const r = await fetch(upstream, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
                referer: "https://huangguoai.com/",
                "user-agent": UA,
              },
              body,
              signal: AbortSignal.timeout(20000),
            });
            const text = await r.text();
            res.statusCode = r.status;
            res.setHeader("content-type", r.headers.get("content-type") || "application/json");
            res.end(text);
          } catch (e) {
            res.statusCode = 502;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: String((e as Error).message || e) }));
          }
          return;
        }
        if (url.startsWith("/__hg/raw")) {
          try {
            // POST {url, method, body, headers}：转发方法/正文/自定义头（新版取址接口是 POST）
            let target = "";
            let method = "GET";
            let body: string | undefined;
            let headers: Record<string, string> = {};
            if (req.method === "POST") {
              let raw = "";
              for await (const chunk of req) raw += chunk;
              const fwd = JSON.parse(raw || "{}") as {
                url?: string; method?: string; body?: string; headers?: Record<string, string>;
              };
              target = fwd.url || "";
              method = fwd.method || "GET";
              body = fwd.body;
              headers = fwd.headers || {};
            } else {
              const u = new URL(url, "http://localhost");
              target = u.searchParams.get("u") || "";
            }
            const r = await fetch(target, {
              method,
              headers: {
                referer: "https://huangguoai.com/",
                "user-agent": UA,
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
                ...headers,
              },
              body: method === "GET" || method === "HEAD" ? undefined : body,
              signal: AbortSignal.timeout(30000),
            });
            const buf = Buffer.from(await r.arrayBuffer());
            res.statusCode = r.status;
            res.setHeader("content-type", r.headers.get("content-type") || "application/octet-stream");
            res.setHeader("content-length", String(buf.length));
            res.end(buf);
          } catch (e) {
            res.statusCode = 502;
            res.end(String((e as Error).message || e));
          }
          return;
        }
        next();
      });
    },
  };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default defineConfig({
  plugins: [react(), tailwindcss(), devProxy()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __PLUGIN_MODE__: JSON.stringify(true),
    // Vite lib 模式不会默认替换 process.env.NODE_ENV：React 的 dev/prod 双包选择器
    // （process.env.NODE_ENV === "production" ? prod : dev）会在宿主浏览器里执行，
    // 而宿主页面运行时没有 Node 的 process 全局 → ReferenceError: process is not defined。
    // 这里静态替换成生产值，dev 分支随之被 tree-shake 掉。
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // 插件宿主直接 import ESM 并调用 mount(el, ctx)
    lib: {
      entry: "src/plugin-entry.tsx",
      formats: ["es"],
      fileName: () => "page.js",
    },
    outDir: "../huanggu-drama/ui",
    emptyOutDir: true,
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    cssCodeSplit: false,
  },
});