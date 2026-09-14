#!/usr/bin/env bash
# 自分専用のヘッドレス Chrome を起動・停止する。止めるのは「そのポートで待ち受けているプロセス」だけ。
#
#   tools/browser/browser.sh start <cdpPort> <profileDir>   起動し、DevTools が応答するまで待つ
#   tools/browser/browser.sh stop  <cdpPort>                そのポートの Chrome だけを kill
#
# Chrome の場所は $CHROME で上書きできる（既定: macOS の Google Chrome、無ければ PATH 上の
# google-chrome / chromium）。profileDir は一時ディレクトリを渡す（人が使うプロファイルを使わない）。
# `pkill -f "Google Chrome.*headless"` は同じマシンの他の作業の Chrome も殺すので使わない。
set -euo pipefail

find_chrome() {
  if [[ -n "${CHROME:-}" ]]; then echo "$CHROME"; return; fi
  local mac="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "$mac" ]]; then echo "$mac"; return; fi
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return; fi
  done
  echo "browser.sh: Chrome が見つからない（\$CHROME で場所を指定する）" >&2
  exit 1
}

up() { curl -s "http://127.0.0.1:$1/json/version" >/dev/null; }

case "${1:-}" in
  start)
    port=${2:-}; prof=${3:-}
    [[ -n $port && -n $prof ]] || { echo "usage: browser.sh start <cdpPort> <profileDir>" >&2; exit 64; }
    if up "$port"; then echo "already running on $port"; exit 0; fi
    chrome=$(find_chrome)
    mkdir -p "$prof"
    nohup "$chrome" --headless=new --disable-gpu --enable-unsafe-swiftshader --hide-scrollbars \
      --remote-debugging-port="$port" --user-data-dir="$prof" --window-size=1700,1050 about:blank \
      >"$prof/chrome.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 100); do
      if up "$port"; then echo "chrome up on $port (pid $pid)"; exit 0; fi
      sleep 0.2
    done
    echo "chrome did not come up on $port (log: $prof/chrome.log)" >&2
    exit 1 ;;
  stop)
    port=${2:-}
    [[ -n $port ]] || { echo "usage: browser.sh stop <cdpPort>" >&2; exit 64; }
    pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN || true)
    if [[ -n $pids ]]; then
      # shellcheck disable=SC2086 # one pid per word
      kill $pids
      # SIGTERM is asynchronous: wait for the port to be released before saying so
      for _ in $(seq 1 50); do lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.1; done
      echo "stopped $pids"
    else
      echo "nothing on $port"
    fi ;;
  *)
    echo "usage: browser.sh start <cdpPort> <profileDir> | stop <cdpPort>" >&2
    exit 64 ;;
esac
