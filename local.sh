#!/usr/bin/env bash
#
# local.sh — start/stop the CloudCLI dev stack (API server + Vite client).
# AI SmartTalk fork helper. Usage: ./local.sh {start|stop|restart|status|logs}
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$ROOT/.local-dev.pid"
LOGFILE="$ROOT/.local-dev.log"

port_from_env() { # $1=var  $2=default
  local v
  v="$(grep -E "^$1=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"
  echo "${v:-$2}"
}

kill_tree() { # recursively kill a PID and its descendants
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

# The API port is the source of truth for "is the stack up" — a pidfile PID can
# die while orphaned children keep serving, so we probe the port instead.
is_running() {
  local p
  p="$(port_from_env SERVER_PORT 3001)"
  [[ -n "$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null)" ]]
}

status() {
  local sp vp
  sp="$(port_from_env SERVER_PORT 3001)"
  vp="$(port_from_env VITE_PORT 5173)"
  if is_running; then
    echo "● Running (PID $(cat "$PIDFILE"))"
    echo "  UI (dev):  http://localhost:${vp}"
    echo "  API:       http://localhost:${sp}"
    echo "  Logs:      ./local.sh logs"
  else
    echo "○ Not running"
  fi
}

start() {
  if is_running; then
    echo "Already running (PID $(cat "$PIDFILE"))."
    status
    return 0
  fi

  if [[ ! -f "$ROOT/.env" ]]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    echo "Created .env from .env.example (edit ports there if needed)."
  fi
  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "Installing dependencies (first run)…"
    (cd "$ROOT" && npm install) || { echo "npm install failed."; exit 1; }
  fi

  echo "Starting CloudCLI dev stack…"
  (cd "$ROOT" && nohup npm run dev > "$LOGFILE" 2>&1 &
   echo $! > "$PIDFILE")
  local pid; pid="$(cat "$PIDFILE")"

  # Wait until the server reports ready (or dies).
  local i
  for i in $(seq 1 60); do
    if grep -q "CloudCLI Server - Ready" "$LOGFILE" 2>/dev/null; then
      echo "Ready."
      status
      return 0
    fi
    if grep -qE "EADDRINUSE|exited with code [1-9]" "$LOGFILE" 2>/dev/null; then
      echo "Startup error — last log lines:"
      tail -n 15 "$LOGFILE"
      return 1
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Process exited early — see $LOGFILE"
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for readiness; check ./local.sh logs"
  status
}

stop() {
  local sp vp any=0 port pid
  sp="$(port_from_env SERVER_PORT 3001)"
  vp="$(port_from_env VITE_PORT 5173)"

  if [[ -f "$PIDFILE" ]]; then
    kill_tree "$(cat "$PIDFILE")"
    rm -f "$PIDFILE"
    any=1
  fi

  # Safety net: kill whatever still listens on our ports (orphaned children left
  # behind if the npm parent died and they got reparented to init).
  for port in "$sp" "$vp"; do
    for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
      kill_tree "$pid"
      any=1
    done
  done

  if [[ "$any" == 1 ]]; then echo "Stopped."; else echo "Nothing to stop."; fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    tail -n 50 -f "$LOGFILE" ;;
  *)
    echo "Usage: ./local.sh {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
