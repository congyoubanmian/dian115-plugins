#!/usr/bin/env bash
# 一键发布 dian115 v3 插件：打标注 tag → 推送 → 触发 release-v3.yml（对 tag ref 手动分发）。
#
# 用法：
#   bash scripts/release-v3.sh v3-2026.11.01 [分支]
#
# 为什么还要手动 dispatch：实测本仓库通过 deploy key 推送的 tag 不会自动触发
# GitHub Actions 的 push.tags 工作流（分支推送正常）；对 tag ref 手动分发
# release-v3.yml 走完全相同的发布路径（会创建 Release 并回写市场索引）。
#
# 前置：gh 已登录（GH_TOKEN 或 gh auth login），本地在默认分支且工作区干净。

set -euo pipefail

TAG="${1:?用法: bash scripts/release-v3.sh v3-YYYY.MM.DD [分支]}"
BRANCH="${2:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "tag 已存在: $TAG" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净，先提交或清理再发布" >&2
  exit 1
fi

echo "== 打 tag $TAG =="
git tag -a "$TAG" -m "dian115 v3 插件发布 $TAG"

echo "== 推送 tag =="
git push origin "$TAG"

echo "== 触发 release-v3.yml（ref=$TAG）=="
gh workflow run release-v3.yml --ref "$TAG"

echo "== 已触发，查看进度：gh run list --workflow=release-v3.yml --limit 1 =="
