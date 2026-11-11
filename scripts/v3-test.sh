#!/usr/bin/env bash
# 跑 v3 插件的离线单测（测试与夹具在 v3/tests/<plugin>/，不在插件目录里）。
#
# 用法：bash scripts/v3-test.sh [插件目录名 ...]
#   bash scripts/v3-test.sh              # 全部跑
#   bash scripts/v3-test.sh music-rs     # 只跑一个
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGINS=("$@")
if [ ${#PLUGINS[@]} -eq 0 ]; then
  PLUGINS=(chase-rs music-rs douban-rs huanggu-drama)
fi

status=0
for plugin in "${PLUGINS[@]}"; do
  dir="$ROOT/v3/tests/$plugin"
  if [ ! -d "$dir" ]; then
    echo "找不到测试目录: $dir" >&2
    status=1
    continue
  fi
  echo "== $plugin =="
  ( cd "$dir" && node --test *.test.mjs *.test.js ) || status=1
done
exit "$status"
