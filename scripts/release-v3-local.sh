#!/usr/bin/env bash
# 本地发版（正式包 protected-v4）—— 编译 MCP 只能连到**可达的 DIAN115 实例**，
# 所以签发必须在开发者自己机器上做；CI 只跑检查与可读包构建。
#
# 流程：
#   1) 构建 + 官方审查闸门 + 可读源码包（本机调试用）
#   2) 逐个插件走编译 MCP 出正式包（dist/<id>-<release_id>.dian115p）+ 写正式包清单
#   3) 用正式包更新市场索引（delivery=protected-v4，author=会员昵称）
#   4) 提交索引 → 打 tag → 推 tag → 创建 Release 并上传正式包（+可读调试包）
#   5) 把最终索引回写 main
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

echo "== 1) 构建 + 审查 + 可读调试包 =="
bash scripts/v3-build.sh

echo "== 2) 编译 MCP 签发正式包 =="
rm -f dist/official-packages.json
for plugin in "${PLUGINS[@]}"; do
  node scripts/v3-compile.mjs compile "v3/$plugin" --out dist
done

echo "== 3) 更新市场索引（正式包）=="
TAG="$TAG" REPO="$REPO" node scripts/update-v3-index.mjs
cp v3-market-index.release.json v3-market-index.json
mkdir -p plugin-market/v3
cp v3-market-index.release.json plugin-market/v3/index.json
git add v3-market-index.json plugin-market/v3/index.json
git commit -m "chore(release): 市场索引指向正式包 ${TAG}（protected-v4）"

echo "== 4) 打 tag 并推送 =="
git tag -a "$TAG" -m "dian115 v3 插件发布 $TAG"
git push origin "$BRANCH"
git push origin "$TAG"

echo "== 5) 创建 Release 并上传资产 =="
RELEASE_FILES=()
while IFS= read -r file; do RELEASE_FILES+=("$file"); done < <(ls -1 dist/*.dian115p)
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${RELEASE_FILES[@]}" --clobber
else
  gh release create "$TAG" "${RELEASE_FILES[@]}" \
    --title "v3 插件 $TAG" \
    --notes-file <(cd dist && sha256sum *.dian115p)
fi

echo "== 完成 =="
echo "Release: https://github.com/$REPO/releases/tag/$TAG"
echo "资产：${RELEASE_FILES[*]}"
echo "（正式包 protected-v4 供新宿主安装；同目录的可读源码包仅供本机调试，两者都挂在 Release 上，索引指向正式包。）"
