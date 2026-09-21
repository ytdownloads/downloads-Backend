#!/usr/bin/env bash
# ==============================================================================
# YTdownloader - Render Deployment Build Script
# ==============================================================================
set -o errexit

echo "==> Starting build process for YTdownloader..."

# 1. Install Node.js dependencies
echo "==> Installing Node.js dependencies..."
npm install

# 2. Ensure project bin and node_modules/.bin directories exist
mkdir -p bin
mkdir -p node_modules/.bin

# 3. Pinned reproducible versions
YTDLP_VERSION="2026.08.19"
FFMPEG_VERSION="6.1"

# 4. Install standalone yt-dlp binary for Linux x86_64
if ! command -v yt-dlp &> /dev/null; then
  echo "==> yt-dlp not found in system PATH. Fetching pinned Linux binary v${YTDLP_VERSION}..."
  curl -sSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o bin/yt-dlp
  chmod a+rx bin/yt-dlp
  cp -f bin/yt-dlp node_modules/.bin/yt-dlp || true
  echo "==> Successfully installed standalone yt-dlp to bin/yt-dlp and node_modules/.bin/yt-dlp"
else
  echo "==> System yt-dlp detected: $(command -v yt-dlp)"
fi

# 5. Install standalone static FFmpeg binary for Linux x86_64
if ! command -v ffmpeg &> /dev/null; then
  echo "==> ffmpeg not found in system PATH. Fetching static FFmpeg v${FFMPEG_VERSION}..."
  curl -sSL "https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}-linux-64.zip" -o bin/ffmpeg.zip
  unzip -o bin/ffmpeg.zip -d bin/ || true
  rm -f bin/ffmpeg.zip
  if [ -f bin/ffmpeg ]; then
    chmod a+rx bin/ffmpeg
    cp -f bin/ffmpeg node_modules/.bin/ffmpeg || true
    echo "==> Successfully installed standalone ffmpeg to bin/ffmpeg and node_modules/.bin/ffmpeg"
  fi
else
  echo "==> System ffmpeg detected: $(command -v ffmpeg)"
fi

# 6. Verify environment PATH
export PATH="$PWD/bin:$PWD/node_modules/.bin:$PATH"
echo "==> Verifying media binaries..."
if command -v yt-dlp &> /dev/null; then
  echo "==> yt-dlp version: $(yt-dlp --version)"
elif [ -f bin/yt-dlp ]; then
  echo "==> bin/yt-dlp version: $(bin/yt-dlp --version)"
fi

if command -v ffmpeg &> /dev/null; then
  echo "==> ffmpeg version: $(ffmpeg -version | head -n 1)"
elif [ -f bin/ffmpeg ]; then
  echo "==> bin/ffmpeg version: $(bin/ffmpeg -version | head -n 1)"
fi

# 7. Build backend TypeScript
echo "==> Building backend TypeScript..."
npm run build

echo "==> Build finished successfully."
