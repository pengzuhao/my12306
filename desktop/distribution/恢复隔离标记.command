#!/bin/bash
set -u
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
printf '\n%s\n\n' 'my12306 内测版：恢复原始隔离标记'
printf '%s\n' '请先从 my12306 托盘菜单选择“退出”。本工具仅恢复原始文件标记，不删除应用或业务数据。' ''
result=0
/bin/bash "$script_dir/macos-quarantine.sh" --restore "$@" || result=$?
if [ -t 0 ]; then printf '\n按回车键关闭此窗口…'; IFS= read -r _answer || true; fi
exit "$result"
