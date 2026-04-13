#!/bin/bash
# ─── WormGPT APK Builder ──────────────────────────────────────────────────────
# Run this script locally (macOS/Linux) or on any CI environment with:
# - Java 21+
# - Android SDK (ANDROID_HOME set)
# - Node.js 20+
# ─────────────────────────────────────────────────────────────────────────────

set -e

echo "═══════════════════════════════════════════════"
echo "  WormGPT Android APK Builder"
echo "═══════════════════════════════════════════════"

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found. Install from https://nodejs.org"; exit 1; }
command -v java >/dev/null 2>&1 || { echo "❌ Java 21 not found. Install from https://adoptium.net"; exit 1; }
[ -n "$ANDROID_HOME" ] || { echo "❌ ANDROID_HOME not set. Install Android Studio and set ANDROID_HOME"; exit 1; }

echo "✅ Node $(node -v)"
echo "✅ Java $(java -version 2>&1 | head -1)"
echo "✅ ANDROID_HOME=$ANDROID_HOME"
echo ""

# Build web app
echo "📦 Installing frontend dependencies..."
cd app && npm install

echo "🔨 Building web app..."
npm run build

echo "🔄 Syncing Capacitor..."
npx cap sync android

# Build APK
echo "🤖 Building Android APK..."
cd android && chmod +x gradlew
./gradlew assembleDebug --no-daemon

APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_PATH" ]; then
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "  ✅ APK built successfully!"
  echo "  📁 Location: app/android/$APK_PATH"
  echo "  📲 Install: adb install $APK_PATH"
  echo "═══════════════════════════════════════════════"
else
  echo "❌ APK not found. Check build output for errors."
  exit 1
fi
