#!/usr/bin/env bash
# 校验「入库的界面产物」与「当前源码重建出来的产物」一致。
#
# 用法（任意目录）：
#   bash scripts/v3-verify-ui-artifacts.sh
#
# 为什么需要它：v3/<plugin>/ui/page.js 是**入库**的（宿主按 ui.entry 直接加载它），
# 所以源码改了而产物没重建、或者构建本身不可重复，都会让宿主跑的东西和源码对不上。
# 这个脚本用「重建一次 → 和 git 里的版本比」把这两类问题挡住：
#   - CI（.github/workflows/release-v3.yml）在打包前跑它，比对的是同一份源码的重建结果；
#   - 本地跑它 = 检查自己有没有忘记提交重建后的产物。
#
# 只比对、不修改文件（不 git add、不 checkout）。退出码非 0 表示不一致。
#
# 前提：当前工作区的界面产物已经是重建过的（先跑 scripts/v3-build-ui.sh）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UI_DIRS=(
  "v3/chase-rs/ui"
  "v3/music-rs/ui"
  "v3/douban-rs/ui"
)

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "不在 git 仓库里，跳过比对。" >&2
  exit 1
fi

# porcelain 会把「已暂存 / 未暂存 / 未跟踪 / 已删除」都列出来——
# 正好覆盖「产物改了没提交」和「产物删了没提交」两种漏提交。
status="$(git status --porcelain -- "${UI_DIRS[@]}")"

if [ -n "$status" ]; then
  echo "界面产物与入库版本不一致：" >&2
  echo "$status" | sed 's/^/  /' >&2
  echo >&2
  echo "本地修法：bash scripts/v3-build-ui.sh 重建，再把产物一起提交。" >&2
  exit 1
fi

echo "通过：入库的界面产物与当前源码的重建结果一致（${UI_DIRS[*]}）。"
