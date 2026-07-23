#!/usr/bin/env bash
# Starts one persistent `serena start-mcp-server` instance for a project and
# writes the port it's listening on to <project>/.serena/pi-web-port — the
# discovery file the pi-serena extension (serena.ext.ts) reads on every
# `before_agent_start` to find it. Run this once per project before opening
# any pi-web chats against it (see README.md / COOKBOOK.md); it's meant to
# outlive any single pi process, unlike the old per-chat-subprocess design.
#
# Usage:
#   serena-daemon.sh <project-path> [port] [--foreground]
#
# Default mode detaches the server with nohup so it survives the invoking
# shell exiting (the manual/one-off-terminal path). --foreground execs
# serena in place of this script instead, without nohup/backgrounding — for
# the systemd unit (serena@.service), whose process supervision needs to
# hold the actual server's PID, not a shell that already returned.
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <project-path> [port] [--foreground]" >&2
  exit 1
}

FOREGROUND=0
args=()
for a in "$@"; do
  if [ "$a" = "--foreground" ]; then
    FOREGROUND=1
  else
    args+=("$a")
  fi
done
set -- "${args[@]+"${args[@]}"}"

PROJECT_PATH=${1:-}
PORT=${2:-}
[ -n "$PROJECT_PATH" ] || usage

if ! command -v serena >/dev/null 2>&1; then
  echo "error: 'serena' not found on PATH" >&2
  exit 1
fi

if [ ! -d "$PROJECT_PATH" ]; then
  echo "error: project path does not exist: $PROJECT_PATH" >&2
  exit 1
fi

PROJECT_PATH=$(cd "$PROJECT_PATH" && pwd)
SERENA_DIR="$PROJECT_PATH/.serena"
PORT_FILE="$SERENA_DIR/pi-web-port"
LOG_FILE="$SERENA_DIR/pi-web-daemon.log"

mkdir -p "$SERENA_DIR"

# Best-effort duplicate check: Serena's web dashboard is a *separate*,
# auto-assigned HTTP port starting at 24282 (not the --port we pick below
# for the MCP endpoint — see server/src/main.rs's Serena monitoring code,
# which polls the same range). If one's already answering and we have a
# stale-looking port file, warn rather than silently spawning a second
# instance. Non-blocking: a curl failure just means "couldn't confirm",
# never a hard stop.
if [ -f "$PORT_FILE" ] && command -v curl >/dev/null 2>&1; then
  for dash_port in $(seq 24282 24291); do
    if curl -sf --max-time 1 "http://127.0.0.1:${dash_port}/heartbeat" >/dev/null 2>&1; then
      echo "warning: a Serena dashboard is already responding on port ${dash_port} — an instance for this (or another) project may already be running. Continuing anyway; delete ${PORT_FILE} first if you want a clean start." >&2
      break
    fi
  done
fi

if [ -z "$PORT" ]; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || true)
  if [ -z "$PORT" ]; then
    # No python3 — fall back to a random high port not currently listening,
    # per `ss`. Small race window between the check and serena actually
    # binding it; acceptable for this best-effort picker.
    PORT=$(comm -23 <(seq 20000 40000) <(ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | rev | cut -d: -f1 | rev | sort -un) | shuf | head -n1)
  fi
fi

if [ "$FOREGROUND" = "1" ]; then
  echo "$PORT" > "$PORT_FILE"
  echo "Starting Serena for $PROJECT_PATH on port $PORT (foreground)"
  exec serena start-mcp-server --transport streamable-http --port "$PORT" --project "$PROJECT_PATH"
fi

nohup serena start-mcp-server --transport streamable-http --port "$PORT" --project "$PROJECT_PATH" \
  >>"$LOG_FILE" 2>&1 &
disown

echo "$PORT" > "$PORT_FILE"
echo "Serena started for $PROJECT_PATH on port $PORT (detached; log: $LOG_FILE, port file: $PORT_FILE)"
