#!/bin/bash
# Local test signature only; no certificate, notarization, sudo, or global policy edits.
set -euo pipefail
umask 077
fail() { printf '签名失败：%s\n' "$*" >&2; exit 1; }
[ "$(/usr/bin/uname -s)" = Darwin ] || fail '此脚本只适用于 macOS'
[ "$#" -le 1 ] || fail '只允许指定一个 my12306.app 路径'
app_path="${1:-/Applications/my12306.app}"
if [ "$#" -eq 0 ] && [ ! -d "$app_path" ]; then app_path="$HOME/Applications/my12306.app"; fi
[ -d "$app_path" ] && [ ! -L "$app_path" ] || fail '请先把 my12306 拖入“应用程序”，再运行助手'
app_path="$(cd "$app_path" && /bin/pwd -P)"
case "$app_path" in /Volumes/*) fail '请先安装应用，不要处理 DMG 内的只读副本' ;; esac
[ "${app_path##*/}" = my12306.app ] || fail '只处理 my12306.app'
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Contents/Info.plist" 2>/dev/null) || fail '应用信息损坏，请重新安装'
[ "$bundle_id" = cn.my12306.desktop ] || fail '应用标识不匹配'
signature=$(/usr/bin/codesign --display --verbose=4 "$app_path" 2>&1 || true)
if printf '%s\n' "$signature" | /usr/bin/grep -q '^Authority='; then
  fail '检测到证书签名，此助手不会覆盖。它仅用于未签名或 Ad-hoc 内测版。'
fi
if /usr/bin/codesign --verify --deep --strict "$app_path" >/dev/null 2>&1; then
  printf '%s\n' '现有本地签名校验通过，无需重复签名。'
  exit 0
fi
printf '正在为内测版补齐本地签名，请等待完成，不要关闭窗口。\n目标：%s\n' "$app_path"
inventory=$(/usr/bin/mktemp -t my12306-adhoc)
trap '/bin/rm -f "$inventory"' EXIT
# Depth-first order seals each nested Mach-O, then its enclosing bundle, then the main app.
# Resources include Chromium and native modules, so do not rely on codesign --deep signing.
/usr/bin/find -P "$app_path" -depth \( -type f -o -type d \) -print0 > "$inventory"
count=0
while IFS= read -r -d '' item; do
  sign_this=0
  if [ -f "$item" ]; then
    kind=$(/usr/bin/file -b "$item")
    case "$kind" in *Mach-O*) sign_this=1 ;; esac
  else
    case "$item" in *.app|*.framework|*.xpc|*.appex) sign_this=1 ;; esac
  fi
  [ "$sign_this" -eq 1 ] || continue
  # Preserve existing entitlements. Do not add hardened runtime to a local test build.
  /usr/bin/codesign --force --sign - --timestamp=none --preserve-metadata=entitlements "$item" || fail "无法签名，请退出应用、检查写入权限后重试：$item"
  count=$((count + 1))
done < "$inventory"
/usr/bin/codesign --verify --deep --strict "$app_path" || fail '签名校验未通过，请重新安装并把本窗口截图交给内测包提供者'
printf '本地 Ad-hoc 签名完成，共处理 %s 个组件，完整校验通过。\n' "$count"
printf '%s\n' '这是本地内测签名，不是 Developer ID 签名或 Apple 公证，不会自动过期。'
