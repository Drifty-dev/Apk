#!/bin/bash
set -e

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║          WormGPT Enhanced Installer       ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi
NODE_VER=$(node -v | cut -c2- | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js 18+ required. Current: $(node -v)"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# Check/Install Ollama
if ! command -v ollama &> /dev/null; then
  echo ""
  echo "📦 Installing Ollama..."
  curl -fsSL https://ollama.ai/install.sh | sh
  echo "✅ Ollama installed"
else
  echo "✅ Ollama $(ollama --version 2>/dev/null | head -1)"
fi

# Start Ollama service
echo ""
echo "🚀 Starting Ollama service..."
ollama serve &>/dev/null &
OLLAMA_PID=$!
sleep 3

# Pull required model
echo "📥 Pulling model: godmoded/llama3-lexi-uncensored"
echo "   (This may take a few minutes on first run)"
ollama pull godmoded/llama3-lexi-uncensored || echo "⚠️  Model pull failed — try manually: ollama pull godmoded/llama3-lexi-uncensored"

# Install frontend deps
echo ""
echo "📦 Installing frontend dependencies..."
cd app
npm install --silent
echo "✅ Frontend deps installed"

# Build frontend
echo "🔨 Building frontend..."
npm run build --silent
echo "✅ Frontend built"

# Install server deps
echo ""
echo "📦 Installing server dependencies..."
cd ../server
npm install --silent
echo "✅ Server deps installed"

cd ..

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║  ✅  Installation Complete!               ║"
echo "║                                           ║"
echo "║  Run:  ./start.sh                         ║"
echo "║  Open: http://localhost:3001              ║"
echo "║  Pass: Realnojokepplwazy1234              ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
