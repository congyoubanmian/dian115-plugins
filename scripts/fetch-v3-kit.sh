#!/usr/bin/env bash
# 拉取 dian115 官方 v3 开发套件到 v3-kit/（conformance 工具、完整示例、SDK、v3 文档）。
#
# v3-kit/ 不入库（上游仓库无 license，不随本仓库分发），本脚本负责按需重建。
#
# 用法（任意目录）：
#   bash scripts/fetch-v3-kit.sh
#
# 需要访问 GitHub。国内网络可指定代理（HTTP/SOCKS5 均可）：
#   DIAN115_PROXY=socks5h://127.0.0.1:1080 bash scripts/fetch-v3-kit.sh
#
# 环境变量：
#   DIAN115_REF    上游分支/标签，默认 main
#   DIAN115_PROXY  git 走的代理（可选）
#
# 幂等：每次重建 v3-kit/，然后跑官方示例的 project-check 自检。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${DIAN115_REF:-main}"
KIT="$ROOT/v3-kit"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 拉取 madbrolab/dian115@${REF} 的 docs/plugin-platform =="
GIT_ARGS=(clone --depth 1 --filter=blob:none --sparse --branch "$REF")
if [ -n "${DIAN115_PROXY:-}" ]; then
  git -c "http.proxy=${DIAN115_PROXY}" "${GIT_ARGS[@]}" \
    https://github.com/madbrolab/dian115.git "$TMP/repo"
else
  git "${GIT_ARGS[@]}" https://github.com/madbrolab/dian115.git "$TMP/repo"
fi
git -C "$TMP/repo" sparse-checkout set docs/plugin-platform

echo "== 重建 v3-kit/ =="
rm -rf "$KIT"
mkdir -p "$KIT/docs"
cp -R "$TMP/repo/docs/plugin-platform/conformance" "$KIT/conformance"
cp -R "$TMP/repo/docs/plugin-platform/examples" "$KIT/examples"
# 文档与 schema 副本（工具相对路径要求 conformance/ 与 examples/ 为兄弟目录）
find "$TMP/repo/docs/plugin-platform" -maxdepth 1 -type f \( -name '*.md' -o -name '*.json' \) \
  -exec cp {} "$KIT/docs/" \;
# SDK 类型与 openapi 在根级的相对路径兼容（sdk.test.mjs 期望 ../../openapi-v3.json）
cp -R "$TMP/repo/docs/plugin-platform/examples/sdk" "$KIT/docs/sdk" 2>/dev/null || true
ln -sfn docs/openapi-v3.json "$KIT/openapi-v3.json"

echo "== 自检：官方示例 project-check =="
node "$KIT/conformance/project-check.mjs" "$KIT/examples/complete-plugin"

echo "完成：$KIT（上游 ${REF}）"
