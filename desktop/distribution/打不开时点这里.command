#!/bin/bash
set -u
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
printf '\n%s\n\n' 'my12306 内测版启动助手'
printf '%s\n' '请先把 DMG 中的 my12306 拖入“应用程序”。' \
  '助手为这一个内测应用补齐本地签名并处理下载隔离标记，不关闭电脑的全局安全保护。' ''
result=0
/bin/bash "$script_dir/macos-adhoc-sign.sh" "$@" || result=$?
if [ "$result" -eq 0 ]; then /bin/bash "$script_dir/macos-quarantine.sh" "$@" || result=$?; fi
if [ "$result" -eq 0 ]; then
  app_path="${1:-/Applications/my12306.app}"
  if [ "$#" -eq 0 ] && [ ! -d "$app_path" ]; then app_path="$HOME/Applications/my12306.app"; fi
  printf '\n%s\n' '处理完成，正在打开 my12306。请在应用中扫码登录 12306。'
  /usr/bin/open "$app_path" || result=$?
else
  printf '\n%s\n' '未完成处理，请查看上面的中文提示，或把终端窗口截图发给提供内测包的人。'
fi
if [ -t 0 ]; then printf '\n按回车键结束本助手（不会退出 my12306）…'; IFS= read -r _answer || true; fi
exit "$result"
