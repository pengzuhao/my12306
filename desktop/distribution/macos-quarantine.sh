#!/bin/bash
# Scope: the installed my12306 bundle only. No sudo, system policy changes, or launch.
set -euo pipefail
umask 077
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' '用法：bash macos-quarantine.sh [--restore] [my12306.app 路径]' \
    '默认查找 /Applications/my12306.app，再查找 ~/Applications/my12306.app。' \
    '默认操作：备份并移除该应用的 com.apple.quarantine；--restore 恢复备份。' \
    '不关闭系统 Gatekeeper / SIP / 恶意软件检查，不自动启动应用。'
}
action=apply
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --restore) action=restore; shift ;;
  --*) fail '不支持的选项，请使用 --help 查看说明' ;;
esac
[ "$#" -le 1 ] || fail '只允许指定一个应用路径'
[ "$(/usr/bin/uname -s)" = Darwin ] || fail '此脚本只适用于 macOS'
app_path="${1:-/Applications/my12306.app}"
if [ "$#" -eq 0 ] && [ ! -d "$app_path" ]; then app_path="$HOME/Applications/my12306.app"; fi
[ -d "$app_path" ] && [ ! -L "$app_path" ] || fail '未找到应用。请先把 DMG 中的 my12306.app 拖入应用程序，再运行脚本。'
app_path="$(cd "$app_path" && /bin/pwd -P)"
case "$app_path" in /Volumes/*) fail '请先安装到应用程序目录，不能修改只读 DMG 内的应用' ;; esac
[ "${app_path##*/}" = my12306.app ] || fail '只处理名为 my12306.app 的应用'
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist" 2>/dev/null) || fail '应用缺少有效的 Info.plist'
[ "$bundle_id" = cn.my12306.desktop ] || fail '应用标识不匹配，未进行任何修改'
backup_root="${MY12306_QUARANTINE_BACKUP_DIR:-$HOME/Library/Application Support/my12306/quarantine-backups}"
key=$(printf '%s' "$app_path" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
backup_dir="$backup_root/$key"
attribute=com.apple.quarantine
count=0
failed=0
printf '目标应用：%s\n' "$app_path"

if [ "$action" = restore ]; then
  [ -d "$backup_dir" ] && [ -f "$backup_dir/target" ] || fail '未找到该路径的隔离标记备份'
  [ "$(cat "$backup_dir/target")" = "$app_path" ] || fail '备份目标不匹配'
  for record in "$backup_dir"/*.path; do
    [ -f "$record" ] || continue
    item=''
    IFS= read -r -d '' item < "$record" || fail '备份路径记录损坏'
    case "$item" in "$app_path"|"$app_path"/*) ;; *) fail '备份包含应用范围外的路径' ;; esac
    # Never follow symlinks (including a directory replaced since the backup).
    if [ ! -e "$item" ] || [ -L "$item" ]; then failed=$((failed + 1)); continue; fi
    parent=$(cd "$(/usr/bin/dirname "$item")" && /bin/pwd -P)
    if [ "$item" != "$app_path" ]; then
      case "$parent" in "$app_path"|"$app_path"/*) ;; *) fail '备份目标经过了应用范围外的符号链接' ;; esac
    fi
    hex=$(cat "${record%.path}.hex")
    if /usr/bin/xattr -wx "$attribute" "$hex" "$item"; then count=$((count + 1)); else failed=$((failed + 1)); fi
  done
  printf '已恢复 %s 项原始隔离标记。\n' "$count"
  [ "$failed" -eq 0 ] || fail "有 $failed 项未能恢复（文件可能已更新或权限不足），备份已保留：$backup_dir"
  /bin/mv "$backup_dir" "$backup_dir.restored-$(/bin/date +%Y%m%d-%H%M%S)-$$"
  printf '%s\n' '恢复完成。仅恢复文件标记，不撤销系统此前记录的“仍要打开”等许可。'
  exit 0
fi

backup_exists=0
if [ -e "$backup_dir" ]; then backup_exists=1; fi
# Make the complete file list first so an enumeration error cannot produce partial success.
inventory=$(/usr/bin/mktemp -t my12306-quarantine)
trap '/bin/rm -f "$inventory"' EXIT
/usr/bin/find -P "$app_path" \( -type d -o -type f \) -print0 > "$inventory"
while IFS= read -r -d '' item; do
  # Listing errors matter; an absent quarantine attribute is simply skipped.
  attributes=$(/usr/bin/xattr "$item") || fail "无法读取属性，请确认对该应用有读写权限：$item"
  if ! printf '%s\n' "$attributes" | /usr/bin/grep -Fxq "$attribute"; then continue; fi
  [ "$backup_exists" -eq 0 ] || fail "已有备份，未覆盖。若需要再次处理，请先用 --restore 恢复：$backup_dir"
  hex=$(/usr/bin/xattr -px "$attribute" "$item") || fail "无法备份属性：$item"
  if [ "$count" -eq 0 ]; then
    /bin/mkdir -p "$backup_dir"
    printf '%s' "$app_path" > "$backup_dir/target"
  fi
  count=$((count + 1))
  record="$backup_dir/$count"
  printf '%s' "$hex" > "$record.hex"
  printf '%s\0' "$item" > "$record.path"
  /usr/bin/xattr -d "$attribute" "$item" || fail "无法移除属性。备份已保留，请检查应用权限：$backup_dir"
done < "$inventory"
if [ "$count" -eq 0 ]; then
  printf '%s\n' '应用没有隔离标记，无需处理。其他启动错误请查看使用说明。'
else
  printf '已处理 %s 项隔离标记；备份：%s\n' "$count" "$backup_dir"
  printf '%s\n' '现在可手动打开 my12306；需要恢复原标记时使用 --restore。'
fi
