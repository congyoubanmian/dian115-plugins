#!/usr/bin/env bash
# 本地发版（正式包 protected-v4）—— 编译 MCP 只能连到**可达的 DIAN115 实例**，
# 所以签发必须在开发者自己机器上做；CI 只跑检查与可读包构建。
#
# 流程（先 Release 后索引：避免出现「索引指向不存在的资产」的中间态）：
#   0) 单测 + 密钥扫描 + 工作区干净检查
#   1) 构建 + 官方审查闸门 + 可读源码包（本机调试用）
#   2) 逐个插件走编译 MCP 出正式包（dist/<id>-<release_id>.dian115p）+ 写正式包清单
#   3) 先把正式包上传成 draft Release（资产已就位，索引此刻还指向旧 tag 也不会 404）
#   4) 用正式包更新市场索引 → 提交 → 打 tag → 推送
#   5) 发布 draft → 完成
#
# 用法：
#   bash scripts/release-v3-local.sh v3-2026.11.02
#
# 前置：工作区干净；仓库根有 .env.local（DIAN115_URL / DIAN115_API_KEY / DIAN115_ACCOUNT_ID）；
#       gh 已登录；npm 依赖已装（v3-ui/node_modules）。
set -euo pipefail

TAG="${1:?用法: bash scripts/release-v3-local.sh v3-YYYY.MM.DD}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REPO="${DIAN115_REPO:-congyoubanmian/dian115-plugins}"
BRANCH="${2:-main}"
PLUGINS=(chase-rs music-rs douban-rs)

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净，先提交或清理再发版" >&2
  git status --short >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "tag 已存在: $TAG" >&2
  exit 1
fi
if [ ! -f .env.local ]; then
  echo "缺少 .env.local（见 .env.example：DIAN115_URL / DIAN115_API_KEY / DIAN115_ACCOUNT_ID）" >&2
  exit 1
fi

# sha256sum 的 macOS 兜底（BSD 没有 -sum 版）。
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"
  else shasum -a 256 "$@"; fi
}

echo "== 0) 单测 + 密钥扫描（凭据没漏进仓库）=="
bash scripts/v3-test.sh
node scripts/v3-secret-scan.mjs

echo "== 1) 构建 + 审查 + 可读调试包 =="
# 先清掉历史产物：dist/ 里留着上一轮的可读包与正式包，上传时会混进 Release
rm -f dist/*.dian115p dist/official-packages.json
bash scripts/v3-build.sh
# 构建可能改写入库的 ui/page.js 等产物：发版前必须比对一致性，
# 不一致则先把产物提交（CI 的 verify-ui-artifacts 也是同一道闸）。
if ! bash scripts/v3-verify-ui-artifacts.sh >/dev/null 2>&1; then
  echo "构建改动了入库的 UI 产物，先 bash scripts/v3-build-ui.sh 并提交后再发版" >&2
  bash scripts/v3-verify-ui-artifacts.sh >&2 || true
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "构建产生了未跟踪/未提交的改动，先处理再发版" >&2
  git status --short >&2
  exit 1
fi

echo "== 2) 编译 MCP 签发正式包 =="
rm -f dist/official-packages.json
for plugin in "${PLUGINS[@]}"; do
  node scripts/v3-compile.mjs compile "v3/$plugin" --out dist
done

echo "== 3) 先创建 draft Release 并上传正式包（资产就位后再动索引）=="
RELEASE_FILES=()
while IFS= read -r file; do RELEASE_FILES+=("$file"); done < <(ls -1 dist/*.dian115p)
if [ "${#RELEASE_FILES[@]}" -eq 0 ]; then
  echo "dist/ 里没有 .dian115p 产物" >&2
  exit 1
fi
# tag 还不存在：gh release create --draft 允许指定未来 tag 名（发布时才建立 tag）。
gh release create "$TAG" "${RELEASE_FILES[@]}" \
  --draft \
  --title "v3 插件 $TAG" \
  --notes-file <(cd dist && sha256_of *.dian115p)
echo "draft Release 已创建：$TAG（${#RELEASE_FILES[@]} 个资产）"

echo "== 4) 更新市场索引（正式包）→ 提交 → 打 tag → 推送 =="
TAG="$TAG" REPO="$REPO" node scripts/update-v3-index.mjs
cp v3-market-index.release.json v3-market-index.json
mkdir -p plugin-market/v3
cp v3-market-index.release.json plugin-market/v3/index.json
git add v3-market-index.json plugin-market/v3/index.json
git commit -m "chore(release): 市场索引指向正式包 ${TAG}（protected-v4）"
git tag -a "$TAG" -m "dian115 v3 插件发布 $TAG"
git push origin "$BRANCH"
git push origin "$TAG"

echo "== 5) 发布 Release（tag 已存在，gh 会把它挂到刚推的 tag 上）=="
gh release edit "$TAG" --draft=false --latest

echo "== 完成 =="
echo "Release: https://github.com/$REPO/releases/tag/$TAG"
echo "资产：${RELEASE_FILES[*]}"
echo "（正式包 protected-v4 供新宿主安装；同目录的可读源码包仅供本机调试，两者都挂在 Release 上，索引指向正式包。）"
