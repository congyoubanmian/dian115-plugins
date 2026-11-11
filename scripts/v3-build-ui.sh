#!/usr/bin/env bash
# 构建 v3 插件的界面：v3-ui/src/<plugin>/ → v3/<plugin>/ui/page.js（Vue 3）；
# hghub（React 自打包）单独在 v3/hghub-ui 里构建 → v3/hghub/ui/page.js。
#
# 用法（任意目录）：
#   bash scripts/v3-build-ui.sh
#
# 依赖：v3-ui/node_modules。锁文件 package-lock.json 已入库；缺 node_modules 时脚本会
# 自己跑一次 npm ci（严格按锁文件装，不解析新版本），CI 里则由工作流显式执行 npm ci。
#
# 幂等：同一份源码重复构建得到同样的产物。构建只覆盖自己产出的文件
# （v3/<plugin>/ui/page.js 与 chunks/），ui/ 目录里的其它文件不动
# （例如 music-rs 的 qr.js 是二维码编码器源码，Vue 版在构建期把它打进 page.js，
#   它本身留在原地，不是构建产物）。
#
# 产物：v3/<plugin>/ui/page.js（ESM，导出 mount(el, ctx)）与可选的 chunks/。
# 宿主只加载 ui/page.js（见 v3-kit/docs/ui-theme.md），样式已内联进 page.js，
# 不需要宿主另外去取 .css。
#
# 另外维护 v3-ui/legacy/<plugin>/page.js —— 改写前的原生 JS 版行为基准。
# 改写页面的任务会把它当"原来有哪些功能"的对照物；构建产物一旦盖上去就找不回来了，
# 所以这里在每次构建前从 page.native.js（只读原件）恢复它。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$ROOT/v3-ui"
LEGACY_DIR="$UI_DIR/legacy"

# 构建顺序固定：chase → music → douban。
PLUGINS=(
  "chase-rs"
  "music-rs"
  "douban-rs"
)

# 依赖来自入库的 package-lock.json：npm ci 严格按锁文件装（不解析新版本），
# 所以「本地装的」和「CI 装的」是同一套依赖，构建结果可复现。
if [ ! -d "$UI_DIR/node_modules" ]; then
  if [ ! -f "$UI_DIR/package-lock.json" ]; then
    echo "缺少 $UI_DIR/package-lock.json：无法按锁文件安装依赖。" >&2
    exit 1
  fi
  echo "缺少 $UI_DIR/node_modules，按入库的 package-lock.json 执行 npm ci ..."
  (cd "$UI_DIR" && npm ci)
fi

# ── 恢复行为基准归档 ────────────────────────────────────────────────────────
# 改写任务会把 v3/<plugin>/ui/page.js 复制到 v3-ui/legacy/<plugin>/page.js 留作对照；
# 复制进去的可能是构建产物（页面已经被 Vue 版覆盖），那就不再是基准了。
# 每次构建前用只读原件 page.native.js 校正，保证归档里始终是原生 JS 版。
for plugin in "${PLUGINS[@]}"; do
  pristine="$LEGACY_DIR/$plugin/page.native.js"
  archive="$LEGACY_DIR/$plugin/page.js"
  if [ -f "$pristine" ]; then
    if ! cmp -s "$pristine" "$archive" 2>/dev/null; then
      cp "$pristine" "$archive"
      echo "已恢复行为基准归档：v3-ui/legacy/$plugin/page.js"
    fi
  fi
done

cd "$UI_DIR"

for plugin in "${PLUGINS[@]}"; do
  case "$plugin" in
    chase-rs) npm_script="build:chase" ;;
    music-rs) npm_script="build:music" ;;
    douban-rs) npm_script="build:douban" ;;
  esac
  echo "== 构建 $plugin（npm run $npm_script）=="
  npm run --silent "$npm_script"
done

# 构建后自检：入口存在且是合法的 ESM（node --check 只查语法，不执行），
# 再用最小 DOM 垫片把页面挂一次（mount / 主题切换 / 清理函数）。
cd "$ROOT"
for plugin in "${PLUGINS[@]}"; do
  entry="$ROOT/v3/$plugin/ui/page.js"
  if [ ! -f "$entry" ]; then
    echo "构建后缺少产物：$entry" >&2
    exit 1
  fi
  node --check "$entry"
  echo "  ✓ $entry（$(wc -c <"$entry") 字节）"
  node "$ROOT/v3-ui/scripts/smoke-mount.mjs" "$plugin"
done

# ── hghub（React 自打包，独立构建空间）─────────────────────────────────────
# React 运行时需要完整 DOM（mini-dom 垫片不够），冒烟只做语法 + 导出检查；
# 真实挂载由宿主完成（与其它插件一样，安装后宿主再次解析实际代码）。
echo "== 构建 hghub（npm run build in v3/hghub-ui → v3/hghub/ui/）=="
if [ ! -d "$ROOT/v3/hghub-ui/node_modules" ]; then
  if [ ! -f "$ROOT/v3/hghub-ui/package-lock.json" ]; then
    echo "缺少 $ROOT/v3/hghub-ui/package-lock.json：无法按锁文件安装依赖。" >&2
    exit 1
  fi
  echo "缺少 $ROOT/v3/hghub-ui/node_modules，按入库的 package-lock.json 执行 npm ci ..."
  (cd "$ROOT/v3/hghub-ui" && npm ci)
fi
(cd "$ROOT/v3/hghub-ui" && npm run --silent build)
entry="$ROOT/v3/hghub/ui/page.js"
node --check "$entry"
# 模块顶层会挂页面事件监听（document/navigator），用 mini-dom 垫片导入；
# mini-dom 的 Document 没有 addEventListener（Vue 不需要），这里补空实现；
# 只验证 mount 导出存在，不做完整挂载（React 运行时需要完整 DOM）。
node --input-type=module -e '
  import { installMiniDom } from "./v3-ui/scripts/mini-dom.mjs";
  import { pathToFileURL } from "node:url";
  installMiniDom();
  document.addEventListener = () => {};
  document.removeEventListener = () => {};
  window.addEventListener = window.addEventListener || (() => {});
  const m = await import(pathToFileURL(process.argv[1]));
  if (typeof m.mount !== "function") throw new Error("ui/page.js 未导出 mount(el, ctx)");
  console.log("  ✓ mount 导出存在");
' "$entry"
echo "  ✓ $entry（$(wc -c <"$entry") 字节）"

echo
echo "== UI 构建完成 =="
for plugin in "${PLUGINS[@]}"; do
  printf '  %-10s %s\n' "$plugin" "v3/$plugin/ui/page.js"
done
printf '  %-10s %s\n' "hghub" "v3/hghub/ui/page.js"
