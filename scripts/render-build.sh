#!/usr/bin/env bash
# ==============================================================================
# YTdownloader - Render Deployment Build Script
# ==============================================================================
set -o errexit

echo "==> Starting build process for YTdownloader..."

# 1. Install Node.js dependencies
echo "==> Installing Node.js dependencies..."
npm install

# 2. Ensure project bin and node_modules/.bin directories exist and prepend to PATH
mkdir -p bin
mkdir -p node_modules/.bin
export PATH="$PWD/bin:$PWD/node_modules/.bin:$PATH"

# 3. Pinned reproducible versions
YTDLP_VERSION="2026.10.26"
FFMPEG_VERSION="6.1"
DENO_VERSION="v2.1.4"

# 4. Install standalone yt-dlp binary for Linux x86_64 (enforce exact pinned version)
CURRENT_BIN_VER=""
if [ -f bin/yt-dlp ]; then
  CURRENT_BIN_VER="$(bin/yt-dlp --version 2>/dev/null || python3 bin/yt-dlp --version 2>/dev/null || true)"
fi

if [ "$CURRENT_BIN_VER" != "$YTDLP_VERSION" ]; then
  echo "==> yt-dlp needs update (current: '${CURRENT_BIN_VER}', target: '${YTDLP_VERSION}'). Fetching pinned Linux binary v${YTDLP_VERSION}..."
  rm -f bin/yt-dlp node_modules/.bin/yt-dlp
  curl -sSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o bin/yt-dlp
  chmod a+rx bin/yt-dlp
  cp -f bin/yt-dlp node_modules/.bin/yt-dlp || true
  echo "==> Successfully installed standalone yt-dlp v${YTDLP_VERSION} to bin/yt-dlp and node_modules/.bin/yt-dlp"
else
  echo "==> bin/yt-dlp is already at target version: ${CURRENT_BIN_VER}"
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

# 5b. Install standalone Deno runtime for Linux x86_64 (required by yt-dlp to solve BotGuard challenges)
if ! command -v deno &> /dev/null && [ ! -f bin/deno ]; then
  echo "==> deno not found in system PATH. Fetching standalone Deno ${DENO_VERSION} for Linux x86_64..."
  curl -sSL "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o bin/deno.zip
  unzip -o bin/deno.zip -d bin/ || true
  rm -f bin/deno.zip
  if [ -f bin/deno ]; then
    chmod a+rx bin/deno
    cp -f bin/deno node_modules/.bin/deno || true
    echo "==> Successfully installed standalone deno to bin/deno and node_modules/.bin/deno"
  fi
else
  echo "==> Deno binary available."
fi

# 5c. Install standalone bgutil-pot for Linux x86_64 (Proof-of-Origin Token provider)
if [ ! -f bin/bgutil-pot ]; then
  echo "==> Fetching standalone bgutil-pot binary for Linux x86_64..."
  curl -sSL "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/latest/download/bgutil-pot-linux-x86_64" -o bin/bgutil-pot
  chmod a+rx bin/bgutil-pot
  cp -f bin/bgutil-pot node_modules/.bin/bgutil-pot || true
  echo "==> Successfully installed bgutil-pot to bin/bgutil-pot and node_modules/.bin/bgutil-pot"
fi

# 6. Verify media binaries
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

if command -v deno &> /dev/null; then
  echo "==> deno version: $(deno --version | head -n 1)"
elif [ -f bin/deno ]; then
  echo "==> bin/deno version: $(bin/deno --version | head -n 1)"
fi

# 7. Build backend TypeScript
echo "==> Building backend TypeScript..."
npm run build

echo "==> Build finished successfully."
