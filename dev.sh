#!/bin/bash
echo "🔧 WormGPT Dev Mode (hot-reload)..."

# Start Ollama
if ! pgrep -x "ollama" > /dev/null; then ollama serve &>/dev/null & sleep 2; fi

# Start backend
cd "$(dirname "$0")/server" && node index.js &
cd ..

# Start frontend dev server
cd "$(dirname "$0")/app" && npm run dev
