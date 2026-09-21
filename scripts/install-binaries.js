#!/usr/bin/env node
/**
 * scripts/install-binaries.js
 * Cross-platform installer for standalone yt-dlp and FFmpeg binaries.
 * Ensures binaries are installed in project ./bin and ./node_modules/.bin on Linux (Render).
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execSync } from 'node:child_process';

const YTDLP_VERSION = '2026.08.19';
const FFMPEG_VERSION = '6.1';

const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp`;
const FFMPEG_URL = `https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}-linux-64.zip`;

const rootDir = process.cwd();
const binDir = path.join(rootDir, 'bin');
const nodeBinDir = path.join(rootDir, 'node_modules', '.bin');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, { headers: { 'User-Agent': 'Node-Installer' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return resolve(downloadFile(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        return reject(new Error(`Download failed with status ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Only auto-download Linux binaries if on Linux (e.g. Render container)
  if (process.platform !== 'linux') {
    console.log(`[install-binaries] Platform is ${process.platform}. Skipping Linux binary download.`);
    return;
  }

  ensureDir(binDir);
  ensureDir(nodeBinDir);

  const ytdlpDest = path.join(binDir, 'yt-dlp');
  const nodeYtdlpDest = path.join(nodeBinDir, 'yt-dlp');

  // 1. Install yt-dlp
  if (!fs.existsSync(ytdlpDest) && !commandExists('yt-dlp')) {
    console.log(`[install-binaries] Downloading standalone yt-dlp v${YTDLP_VERSION}...`);
    try {
      await downloadFile(YTDLP_URL, ytdlpDest);
      fs.chmodSync(ytdlpDest, 0o755);
      fs.copyFileSync(ytdlpDest, nodeYtdlpDest);
      fs.chmodSync(nodeYtdlpDest, 0o755);
      console.log(`[install-binaries] Successfully installed yt-dlp to ${ytdlpDest}`);
    } catch (err) {
      console.error('[install-binaries] Failed to download yt-dlp:', err.message);
    }
  } else if (fs.existsSync(ytdlpDest)) {
    fs.copyFileSync(ytdlpDest, nodeYtdlpDest);
    fs.chmodSync(nodeYtdlpDest, 0o755);
    console.log(`[install-binaries] yt-dlp already present at ${ytdlpDest}`);
  } else {
    console.log('[install-binaries] System yt-dlp detected.');
  }

  // 2. Install FFmpeg
  const ffmpegDest = path.join(binDir, 'ffmpeg');
  const nodeFfmpegDest = path.join(nodeBinDir, 'ffmpeg');

  if (!fs.existsSync(ffmpegDest) && !commandExists('ffmpeg')) {
    console.log(`[install-binaries] Downloading static FFmpeg v${FFMPEG_VERSION}...`);
    const zipPath = path.join(binDir, 'ffmpeg.zip');
    try {
      await downloadFile(FFMPEG_URL, zipPath);
      // Unzip using system unzip if available
      try {
        execSync(`unzip -o "${zipPath}" -d "${binDir}"`, { stdio: 'ignore' });
        fs.unlinkSync(zipPath);
        if (fs.existsSync(ffmpegDest)) {
          fs.chmodSync(ffmpegDest, 0o755);
          fs.copyFileSync(ffmpegDest, nodeFfmpegDest);
          fs.chmodSync(nodeFfmpegDest, 0o755);
          console.log(`[install-binaries] Successfully installed FFmpeg to ${ffmpegDest}`);
        }
      } catch (unzipErr) {
        console.warn('[install-binaries] System unzip failed, trying tar/fallback:', unzipErr.message);
      }
    } catch (err) {
      console.error('[install-binaries] Failed to download FFmpeg:', err.message);
    }
  } else if (fs.existsSync(ffmpegDest)) {
    fs.copyFileSync(ffmpegDest, nodeFfmpegDest);
    fs.chmodSync(nodeFfmpegDest, 0o755);
    console.log(`[install-binaries] FFmpeg already present at ${ffmpegDest}`);
  } else {
    console.log('[install-binaries] System FFmpeg detected.');
  }
}

main().catch((err) => {
  console.error('[install-binaries] Unexpected error:', err);
  // Do not fail build if network is unavailable
  process.exit(0);
});
