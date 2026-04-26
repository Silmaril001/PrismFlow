#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[PrismFlow] one-click startup (logs)"

if ! command -v node >/dev/null 2>&1; then
  echo "[Error] Node.js not found. Please install Node.js 20+ first."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[Error] npm not found. Please install npm first."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[Setup] Installing dependencies..."
  npm install
else
  echo "[Setup] Dependencies already installed."
fi

if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env
  echo "[Setup] Created apps/api/.env from template."
fi

is_port_listening() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

if [ "${SKIP_DEV:-0}" = "1" ]; then
  echo "[Info] SKIP_DEV=1, startup checks finished."
  exit 0
fi

LOGS_URL="http://localhost:5174/logs"

if is_port_listening 5174; then
  echo "[Info] Web port 5174 is already in use. Skip starting a second dev server."
  if [ "${SKIP_OPEN:-0}" != "1" ]; then
    if command -v open >/dev/null 2>&1; then
      open "$LOGS_URL" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$LOGS_URL" >/dev/null 2>&1 || true
    fi
  fi
  exit 0
fi

echo "[Run] Starting API + Web..."
echo "[Open] ${LOGS_URL}"

npm run dev &
DEV_PID=$!

cleanup() {
  if kill -0 "$DEV_PID" >/dev/null 2>&1; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
    wait "$DEV_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM

if [ "${SKIP_OPEN:-0}" != "1" ]; then
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:5174" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if command -v open >/dev/null 2>&1; then
    open "$LOGS_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$LOGS_URL" >/dev/null 2>&1 || true
  fi
fi

wait "$DEV_PID"
