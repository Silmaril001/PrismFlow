#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[PrismFlow] one-click startup"

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
  echo "[Hint] OPENAI_API_KEY is optional. Without it, local fallback shader is used."
fi

if [ "${SKIP_DEV:-0}" = "1" ]; then
  echo "[Info] SKIP_DEV=1, startup checks finished."
  exit 0
fi

echo "[Run] Starting API + Web..."
echo "[Web] http://localhost:5174"
echo "[API] http://localhost:8788"

npm run dev
