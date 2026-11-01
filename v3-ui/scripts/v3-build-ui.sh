#!/usr/bin/env bash
# 转发到仓库根的 scripts/v3-build-ui.sh。
#
# 为什么有这个转发：真正的构建脚本在仓库根 scripts/v3-build-ui.sh（与 v3-build.sh、
# release-v3.sh 放在一起）。但人在 v3-ui/ 里工作时容易顺手敲 `bash scripts/v3-build-ui.sh`，
# 那会解析到本目录下的 scripts/ —— 没有这个文件就报"没有那个文件或目录"。
# 这里放一个转发脚本，让两种 cwd 下敲同一条命令都能跑。
#
# 真脚本内部用 BASH_SOURCE 推导仓库根，与调用时的 cwd 无关。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/../../scripts/v3-build-ui.sh" "$@"
