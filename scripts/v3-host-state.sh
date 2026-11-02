#!/usr/bin/env bash
# 查看宿主里某个 v3 插件的存储现状（键名 + 字节数 + 版本号，不解密内容）。
#
# 用途：验证「后台任务真的把状态写进去了」——键存在即写盘成功（v3 扩展的 KV 在
# 容器内 <plugin>/data/state.sqlite，值是加密的，这里只看元信息）。
#
# 用法：bash scripts/v3-host-state.sh douban.rs [容器名]
set -euo pipefail

PLUGIN="${1:?用法: bash scripts/v3-host-state.sh <plugin-id> [容器名]}"
CONTAINER="${2:-dian115}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== $CONTAINER 上的 $PLUGIN 存储 =="
if ! docker cp "$CONTAINER:/config/extensions/$PLUGIN/data/state.sqlite" "$TMP/state.sqlite" >/dev/null 2>&1; then
  echo "取不到 state.sqlite（插件还没装在这个容器里？）" >&2
  exit 1
fi

echo "-- KV --"
sqlite3 "$TMP/state.sqlite" "SELECT key, length(value) AS bytes, revision FROM kv ORDER BY key;" || true
echo "-- 最近任务 --"
sqlite3 "$TMP/state.sqlite" "SELECT job, created FROM runs ORDER BY created DESC LIMIT 5;" || true
echo "-- 安装版本 --"
docker exec "$CONTAINER" sh -c "grep -m1 '\"version\"' /config/extensions/$PLUGIN/code/*/plugin.json" 2>/dev/null || true
