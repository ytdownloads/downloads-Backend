#!/usr/bin/env bash
# ==============================================================================
# YTdownloader - Render Deployment Build Script
# ==============================================================================
set -o errexit

echo "==> Starting build process for YTdownloader..."

# 1. Install all dependencies across monorepo
echo "==> Installing Node.js dependencies..."
npm install

# 2. Ensure yt-dlp is available in the Linux environment
mkdir -p bin
if ! command -v yt-dlp &> /dev/null; then
  echo "==> yt-dlp not found in system PATH. Fetching latest Linux binary..."
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp
  chmod a+rx bin/yt-dlp
  echo "==> Successfully installed standalone yt-dlp to bin/yt-dlp"
else
  echo "==> System yt-dlp detected: $(command -v yt-dlp)"
fi

# 3. Build backend TypeScript
echo "==> Building backend TypeScript..."
npm run build

echo "==> Build finished successfully."
