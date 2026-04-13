#!/bin/bash
echo ""
echo "🐛 Starting WormGPT Enhanced..."

# Start Ollama if not running
if ! pgrep -x "ollama" > /dev/null; then
  echo "🚀 Starting Ollama..."
  ollama serve &>/dev/null &
  sleep 2
fi

# Start backend
echo "🔌 Starting backend server..."
cd "$(dirname "$0")/server"
node index.js &
SERVER_PID=$!
cd ..

sleep 1

# Open browser
if command -v xdg-open &>/dev/null; then xdg-open http://localhost:3001
elif command -v open &>/dev/null; then open http://localhost:3001
fi

echo ""
echo "╔═══════════════════════════════════════╗"
echo "║  🐛 WormGPT Enhanced Running!         ║"
echo "║                                       ║"
echo "║  → http://localhost:3001              ║"
echo "║  Password: Realnojokepplwazy1234      ║"
echo "║                                       ║"
echo "║  Press Ctrl+C to stop                 ║"
echo "╚═══════════════════════════════════════╝"
echo ""

# Keep alive
wait $SERVER_PID
