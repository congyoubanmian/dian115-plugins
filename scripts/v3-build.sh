#!/usr/bin/env bash
# 一键构建 dian115 v3 三个插件：project-check → pack → sha256。
#
# 幂等：pack.mjs 以源码文件名的字节序固定顺序、不写入时间戳，
# 同一份源码重复打包得到完全相同的 .dian115p 与 sha256；重复执行会覆盖旧包。
#
# 用法（任意目录）：
#   bash scripts/v3-build.sh
#
# 产物：dist/<插件>*.dian115p；末尾打印 v3-market-index.json 需要的 sha256。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFORMANCE="$ROOT/v3-kit/conformance"
DIST="$ROOT/dist"

# 插件 ID | 源码目录（相对仓库根） | 交付包名（与 v3-market-index.json 的 source_url 一致）
PLUGINS=(
  "chase.rs|v3/chase-rs|chase-rs-0.1.9.dian115p"
  "music.rs|v3/music-rs|music-rs.dian115p"
  "douban.rs|v3/douban-rs|douban-rs.dian115p"
)

mkdir -p "$DIST"

for row in "${PLUGINS[@]}"; do
  IFS='|' read -r id src pkg <<<"$row"
  echo "== $id =="
  node "$CONFORMANCE/project-check.mjs" "$ROOT/$src"
  # pack.mjs 以 wx 独占写入，重复执行前先清掉旧包
  rm -f "$DIST/$pkg"
  node "$CONFORMANCE/pack.mjs" "$ROOT/$src" "$DIST/$pkg"
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
