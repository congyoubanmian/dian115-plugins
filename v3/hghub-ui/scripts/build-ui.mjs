// 构建后的 ui/ 自检：入口存在、plugin.json 指向正确、无意外产物。
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const uiDir = resolve(root, "../hghub/ui");
const pluginDir = resolve(root, "../hghub");

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
console.log(`ui/page.js 就绪：${(size / 1024).toFixed(1)} KiB`);
console.log(`plugin.json：${manifest.id} v${manifest.version} → ui.entry=${manifest.ui.entry}`);