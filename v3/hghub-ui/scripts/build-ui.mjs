// 构建后的 ui/ 自检：入口存在、plugin.json 指向正确、无意外产物。
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const uiDir = resolve(root, "../huanggu-drama/ui");
const pluginDir = resolve(root, "../huanggu-drama");

const entry = resolve(uiDir, "page.js");
if (!existsSync(entry)) {
  console.error("构建产物缺失：" + entry + "（先运行 npm run build）");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(resolve(pluginDir, "plugin.json"), "utf8"));
if (manifest.ui?.entry !== "ui/page.js") {
  console.error("plugin.json ui.entry 与构建产物不一致");
  process.exit(1);
}
const size = statSync(entry).size;

// 防回归：宿主页面运行时没有 Node 的 process 全局。Vite lib 模式不会默认替换
// process.env.NODE_ENV（React 双包选择器会残留），这里检测到就报错。
const bundle = readFileSync(entry, 'utf8');
if (/process\.env\b/.test(bundle)) {
  console.error('构建产物仍引用 Node 全局 process.env（宿主浏览器没有 process）。\n' +
    '修复：vite.config.ts 的 define 里显式替换 "process.env.NODE_ENV"。');
  process.exit(1);
}

console.log(`ui/page.js 就绪：${(size / 1024).toFixed(1)} KiB`);
console.log(`plugin.json：${manifest.id} v${manifest.version} → ui.entry=${manifest.ui.entry}`);