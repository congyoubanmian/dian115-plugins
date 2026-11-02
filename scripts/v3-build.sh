#!/usr/bin/env bash
# 一键构建 dian115 v3 三个插件：构建 Vue 界面 → project-check → pack → sha256。
#
# 顺序是固定的，不能调换：
#   1) scripts/v3-build-ui.sh —— v3-ui/src/<plugin>/ → v3/<plugin>/ui/page.js。
#      必须先于打包：pack.mjs 打的是插件目录，而 ui/page.js 正是宿主加载的入口
#      （清单 ui.entry = "ui/page.js"），产物不在包里，装上去页面就起不来。
#   2) 每个插件 project-check（清单/入口/源码结构）→ pack → 校验包内容。
#   3) 打印 sha256（更新 v3-market-index.json 时用）。
#
# 幂等：界面构建对同一份源码产出同样的字节；pack.mjs 以源码文件名的字节序固定顺序、
# 不写入时间戳，同一份源码重复打包得到完全相同的 .dian115p 与 sha256；
# 重复执行会覆盖旧包。
#
# 用法（任意目录）：
#   bash scripts/v3-build.sh
#
# 依赖：v3-ui/node_modules（首次由 scripts/v3-build-ui.sh 按入库的 package-lock.json
# 跑 npm ci 装好；离线环境请先在 v3-ui/ 手动 npm ci）。
#
# 产物：dist/<插件>*.dian115p；末尾打印 v3-market-index.json 需要的 sha256。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFORMANCE="$ROOT/v3-kit/conformance"
DIST="$ROOT/dist"

# 插件 ID | 源码目录（相对仓库根） | 交付包名（与 v3-market-index.json 的 source_url 一致）
PLUGINS=(
  "chase.rs|v3/chase-rs|chase-rs-0.1.13.dian115p"
  "music.rs|v3/music-rs|music-rs.dian115p"
  "douban.rs|v3/douban-rs|douban-rs.dian115p"
)

mkdir -p "$DIST"

# ── 1) 界面：先构建 Vue 界面 ───────────────────────────────────────────────
echo "== 构建 Vue 界面（v3-ui/src/<plugin> → v3/<plugin>/ui/）=="
bash "$ROOT/scripts/v3-build-ui.sh"

# ── 2) 官方审查闸门（结构 + 恶意特征扫描）──────────────────────────────
# 宿主官方 scripts/check.mjs 在 do-not-install 时会拒绝打包；这里用等价的检查脚本
# （scripts/v3-check-official.mjs），critical/high 必须逐条登记在
# scripts/v3-audit-allowlist.json 里才算通过，避免"绕过闸门"。
echo "== 官方审查（结构检查 + 恶意特征扫描）=="
node "$ROOT/scripts/v3-check-official.mjs"

# ── 3) 清单检查 + 打包 ──────────────────────────────────────────────────────
for row in "${PLUGINS[@]}"; do
  IFS='|' read -r id src pkg <<<"$row"
  echo "== $id =="
  node "$CONFORMANCE/project-check.mjs" "$ROOT/$src"
  # pack.mjs 以 wx 独占写入，重复执行前先清掉旧包
  rm -f "$DIST/$pkg"
  node "$CONFORMANCE/pack.mjs" "$ROOT/$src" "$DIST/$pkg"
  # 包里不能有 node_modules，且清单声明的入口必须都在包里
  node "$ROOT/scripts/v3-pack-check.mjs" "$DIST/$pkg" "$ROOT/$src"
done

if command -v sha256sum >/dev/null 2>&1; then
  HASHER=(sha256sum)
else
  HASHER=(shasum -a 256)
fi

echo
echo "== sha256（更新 v3-market-index.json 时使用）=="
for row in "${PLUGINS[@]}"; do
  IFS='|' read -r id src pkg <<<"$row"
  read -r hash _ < <("${HASHER[@]}" "$DIST/$pkg")
  printf '%s  dist/%s\n' "$hash" "$pkg"
done
