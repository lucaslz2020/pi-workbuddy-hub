#!/usr/bin/env bash
# 安装每日自动签到（launchd，macOS）。
#
# 为什么不复用 pi 扩展里的定时器：扩展只在 session 里活着，pi 一关就没了。
# 无人值守必须落在系统级定时器上。
#
# 用法：./bin/install-launchd.sh [HH:MM]
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
ENTRY="$ROOT/bin/checkin.mjs"
# label 用当前用户名推导，避免把作者名字带进别人的机器
USER_TAG=$(id -un | tr "[:upper:]" "[:lower:]" | tr -cd "a-z0-9")
LABEL="com.${USER_TAG:-user}.workbuddy-checkin"
PLIST_SRC="$ROOT/bin/launchd/workbuddy-checkin.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/WorkBuddy/checkin.log"

TIME="${1:-09:05}"
HOUR="${TIME%%:*}"
MINUTE="${TIME##*:}"

# 必须是绝对路径的 node：launchd 的 PATH 极简，`node` 会 not found。
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node。先装 Node（>=20）再运行。" >&2
  exit 1
fi
NODE_BIN=$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")

mkdir -p "$(dirname "${LOG}")" "$HOME/Library/LaunchAgents"

# 用占位符替换，避免 heredoc 里手写绝对路径出错
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__ENTRY__|$ENTRY|g" \
  -e "s|__LOG__|$LOG|g" \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|<integer>9</integer>|<integer>$HOUR</integer>|" \
  -e "s|<integer>5</integer>|<integer>$MINUTE</integer>|" \
  "$PLIST_SRC" > "$PLIST_DST"

# 先卸载旧的（不存在也没关系），再装新的
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "已安装：$PLIST_DST"
echo "  时间  每天 ${TIME}（本机时区）"
echo "  node  $NODE_BIN"
echo "  脚本  $ENTRY"
echo "  日志  ${LOG}"
echo
echo "验证（立即跑一次）："
echo "  launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  tail -f \"$LOG\""
echo
echo "查看状态："
echo "  launchctl print gui/$(id -u)/$LABEL | grep -E 'state|runs|last exit'"
echo
echo "卸载："
echo "  launchctl bootout gui/$(id -u)/$LABEL && rm \"$PLIST_DST\""
