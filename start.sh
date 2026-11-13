#!/usr/bin/env bash
# One-command launcher: sets up deps on first run, then starts backend (:8000) and frontend (:5173).
set -e
cd "$(dirname "$0")"

if [ ! -d backend/.venv ]; then
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -q --upgrade pip
  backend/.venv/bin/pip install -q -r backend/requirements.txt
fi
[ -f backend/.env ] || { cp backend/.env.example backend/.env; echo "Created backend/.env — add your free API keys there."; }
[ -d frontend/node_modules ] || (cd frontend && npm install --no-audit --no-fund)

(cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000) &
BACK=$!
trap 'kill $BACK 2>/dev/null' EXIT
cd frontend && npm run dev
