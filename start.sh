#!/usr/bin/env bash
#
# my12306 一键启动脚本
#
#   ./start.sh            前台启动（Ctrl+C 停止）
#   ./start.sh -d         后台启动，日志写入 .run/my12306.log
#   ./start.sh stop       停止后台服务
#   ./start.sh restart    重启后台服务
#   ./start.sh status     查看运行状态
#   ./start.sh build      仅重新构建前后端（不启动）
#
# 可选环境变量：
#   MY12306_PORT=7788           服务端口
#   MY12306_HOST=127.0.0.1      监听地址（外网访问改 0.0.0.0）
#   MY12306_NO_OPEN=1           启动后不自动打开浏览器
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/my12306.pid"
LOG_FILE="$RUN_DIR/my12306.log"
PORT="${MY12306_PORT:-7788}"
HOST="${MY12306_HOST:-127.0.0.1}"
BASE_URL="http://${HOST}:${PORT}"

info() { printf '\033[36m[my12306]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[my12306]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[my12306]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 运行环境 ----------

port_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

pick_node() {
  # 依次尝试各候选 Node，选出能让原生模块 better-sqlite3 真正可用的那个。
  # 原生模块的 ABI 必须与 Node 主版本匹配，否则启动时会报 ERR_DLOPEN_FAILED。
  # 注意：仅 require() 不足以判定——它不会真正 dlopen 原生模块，必须实际建一个库。
  local probe="const D=require('$ROOT/node_modules/better-sqlite3');const d=new D(':memory:');d.exec('create table t(a)');d.close();"
  local candidates=(
    "$(command -v node 2>/dev/null || true)"
    /opt/homebrew/bin/node
    "$HOME/.workbuddy/binaries/node/versions/current/bin/node"
    /usr/local/bin/node
  )
  local c
  for c in "${candidates[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    if "$c" -e "$probe" >/dev/null 2>&1; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

ensure_deps() {
  if [ -d "$ROOT/node_modules/better-sqlite3" ]; then
    return 0
  fi
  info "未检测到依赖，正在安装（首次较慢，需下载 Playwright 等）..."
  ( cd "$ROOT" && npm install )
}

ensure_build() {
  local need=0
  [ -f "$ROOT/web/dist/index.html" ] || need=1
  [ -f "$ROOT/server/dist/index.js" ] || need=1
  if [ "$need" = "0" ]; then
    return 0
  fi
  info "构建产物不完整，正在构建..."
  ( cd "$ROOT" && npm run build:web && npm run build:server )
  info "构建完成"
}

prepare() {
  ensure_deps

  NODE_BIN="$(pick_node)" || {
    warn "没有找到能正常加载 better-sqlite3 的 Node。"
    warn "该原生模块的 ABI 必须与 Node 主版本一致，当前不匹配。"
    warn "请用与安装依赖时相同的 Node 版本重新编译："
    warn "    cd $ROOT"
    warn "    export PATH=\"\$(dirname \$(command -v node)):\$PATH\""
    warn "    npm rebuild better-sqlite3 --build-from-source"
    exit 1
  }
  # 让后续 npm / tsc / vite 都使用同一个 Node，避免混用
  export PATH="$(dirname "$NODE_BIN"):$PATH"

  ensure_build
  mkdir -p "$RUN_DIR"
}

# ---------- 启停 ----------

wait_ready() {
  local i
  for i in $(seq 1 60); do
    if curl -sf "$BASE_URL/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

open_browser() {
  [ "${MY12306_NO_OPEN:-0}" = "1" ] && return 0
  case "$(uname -s)" in
    Darwin) open "$BASE_URL" >/dev/null 2>&1 || true ;;
    Linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$BASE_URL" >/dev/null 2>&1 || true ;;
  esac
}

start_foreground() {
  local existing
  existing="$(port_pid || true)"
  if [ -n "$existing" ]; then
    fail "端口 $PORT 已被占用（PID ${existing}），请先停止或更换 MY12306_PORT"
  fi

  info "Node          : $("$NODE_BIN" -v)  ($NODE_BIN)"
  info "管理台地址    : $BASE_URL"
  info "单用户模式    : 无需登录，打开后请在顶栏「12306 账号」里扫码登录 12306"
  info "按 Ctrl+C 停止服务"
  echo

  cd "$ROOT/server"
  # 用 exec 让脚本进程本身变成 node，这样 Ctrl+C / SIGTERM 能直接送达，
  # 触发后端的优雅退出（关闭浏览器、落盘等）。不要放进子 shell。
  exec "$NODE_BIN" dist/index.js
}

start_daemon() {
  local existing
  existing="$(port_pid || true)"
  if [ -n "$existing" ]; then
    info "服务已在运行（PID ${existing}），地址：$BASE_URL"
    open_browser
    return 0
  fi

  info "Node          : $("$NODE_BIN" -v)  ($NODE_BIN)"
  info "后台启动中..."
  # 注意：这里不能用 $! 记 PID —— `cd ... && nohup ... &` 的 & 作用于整个 && 列表，
  # $! 拿到的是外层子 shell 的 PID，而不是 node 的。启动后用「实际监听端口的进程」作为权威 PID。
  ( cd "$ROOT/server" && nohup "$NODE_BIN" dist/index.js >"$LOG_FILE" 2>&1 & )

  if wait_ready; then
    port_pid >"$PID_FILE" 2>/dev/null || true
    info "启动成功：$BASE_URL"
    info "单用户模式：无需登录，请在顶栏「12306 账号」里扫码登录 12306"
    info "日志：$LOG_FILE"
    info "停止：$0 stop"
    open_browser
  else
    warn "启动超时，最近日志："
    tail -20 "$LOG_FILE" >&2 || true
    stop_daemon
    exit 1
  fi
}

stop_daemon() {
  local pid=""
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  [ -n "$pid" ] || pid="$(port_pid || true)"

  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    info "服务未在运行"
    return 0
  fi

  info "正在停止（PID ${pid}）..."
  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "优雅退出超时，强制结束"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  info "已停止"
}

show_status() {
  if curl -sf "$BASE_URL/api/health" >/dev/null 2>&1; then
    info "运行中：$BASE_URL   PID $(port_pid)"
  else
    info "未运行"
  fi
}

# ---------- 入口 ----------

case "${1:-start}" in
  -d|--daemon|daemon)
    prepare && start_daemon
    ;;
  start)
    prepare && start_foreground
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    prepare && start_daemon
    ;;
  status)
    show_status
    ;;
  build)
    ensure_deps
    info "重新构建前后端..."
    ( cd "$ROOT" && npm run build:web && npm run build:server )
    info "构建完成"
    ;;
  -h|--help|help)
    # 打印文件开头的注释块（首个非注释行之前）
    awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
    ;;
  *)
    fail "未知参数：$1（可用：start | -d | stop | restart | status | build）"
    ;;
esac
