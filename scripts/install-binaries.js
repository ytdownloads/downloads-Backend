#!/usr/bin/env node
/**
 * scripts/install-binaries.js
 * Cross-platform installer for standalone yt-dlp and FFmpeg binaries.
 * Ensures binaries are installed and verified in project ./bin and ./node_modules/.bin on Linux (Render).
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
    const whichCmd = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(whichCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function verifyBinary(binPathOrCmd, name) {
  try {
    const flag = name === 'yt-dlp' ? '--version' : '-version';
    const out = execSync(`"${binPathOrCmd}" ${flag}`, { encoding: 'utf-8', timeout: 10000 });
    const firstLine = out.split('\n')[0].trim();
    console.log(`[install-binaries] ${name} verified (${binPathOrCmd}): ${firstLine}`);
    return true;
  } catch (e) {
    console.warn(`[install-binaries] ${name} verification failed at ${binPathOrCmd}: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log(`[install-binaries] Checking required media binaries (platform: ${process.platform})...`);

  // On non-Linux (e.g. Windows dev machine), verify local binaries without downloading Linux binaries
  if (process.platform !== 'linux') {
    const hasYtdlp = commandExists('yt-dlp');
    const hasFfmpeg = commandExists('ffmpeg');
    console.log(`[install-binaries] System yt-dlp available: ${hasYtdlp}`);
    console.log(`[install-binaries] System FFmpeg available: ${hasFfmpeg}`);
    if (hasYtdlp) verifyBinary('yt-dlp', 'yt-dlp');
    if (hasFfmpeg) verifyBinary('ffmpeg', 'ffmpeg');
    console.log('[install-binaries] Non-Linux environment check completed.');
    return;
  }

  ensureDir(binDir);
  ensureDir(nodeBinDir);

  const ytdlpDest = path.join(binDir, 'yt-dlp');
  const nodeYtdlpDest = path.join(nodeBinDir, 'yt-dlp');
  const ffmpegDest = path.join(binDir, 'ffmpeg');
  const nodeFfmpegDest = path.join(nodeBinDir, 'ffmpeg');

  // ==========================================
  // 1. yt-dlp Installation & Verification
  // ==========================================
  let ytdlpReady = false;

  // Check if ./bin/yt-dlp already exists and works
  if (fs.existsSync(ytdlpDest)) {
    if (verifyBinary(ytdlpDest, 'yt-dlp')) {
      ytdlpReady = true;
      console.log(`[install-binaries] Existing yt-dlp binary is valid at ${ytdlpDest}`);
    } else {
      console.warn(`[install-binaries] Existing yt-dlp at ${ytdlpDest} is invalid/corrupt, redownloading...`);
      try { fs.unlinkSync(ytdlpDest); } catch {}
    }
  }

  if (!ytdlpReady) {
    console.log(`[install-binaries] Downloading standalone yt-dlp v${YTDLP_VERSION}...`);
    await downloadFile(YTDLP_URL, ytdlpDest);
    fs.chmodSync(ytdlpDest, 0o755);
    if (!verifyBinary(ytdlpDest, 'yt-dlp')) {
      throw new Error(`Downloaded yt-dlp at ${ytdlpDest} failed execution verification.`);
    }
    ytdlpReady = true;
    console.log(`[install-binaries] Successfully installed and verified yt-dlp at ${ytdlpDest}`);
  }

  // Ensure node_modules/.bin also has a working copy
  try {
    fs.copyFileSync(ytdlpDest, nodeYtdlpDest);
    fs.chmodSync(nodeYtdlpDest, 0o755);
  } catch (copyErr) {
    console.warn(`[install-binaries] Warning: Could not mirror yt-dlp to node_modules/.bin: ${copyErr.message}`);
  }

  // ==========================================
  // 2. FFmpeg Installation & Verification
  // ==========================================
  let ffmpegReady = false;

  // Check if system FFmpeg is available (standard on Render Linux image: /usr/bin/ffmpeg)
  if (commandExists('ffmpeg')) {
    if (verifyBinary('ffmpeg', 'ffmpeg')) {
      ffmpegReady = true;
      console.log('[install-binaries] System FFmpeg is verified and functional.');
    }
  }

  // Check if project bin FFmpeg exists and works
  if (!ffmpegReady && fs.existsSync(ffmpegDest)) {
    if (verifyBinary(ffmpegDest, 'ffmpeg')) {
      ffmpegReady = true;
      console.log(`[install-binaries] Existing FFmpeg binary is valid at ${ffmpegDest}`);
    } else {
      console.warn(`[install-binaries] Existing FFmpeg at ${ffmpegDest} is invalid, removing...`);
      try { fs.unlinkSync(ffmpegDest); } catch {}
    }
  }

  // Download static FFmpeg only if no valid FFmpeg is available on the system
  if (!ffmpegReady) {
    console.log(`[install-binaries] Downloading static FFmpeg v${FFMPEG_VERSION}...`);
    const zipPath = path.join(binDir, 'ffmpeg.zip');
    try {
      await downloadFile(FFMPEG_URL, zipPath);
      // Unzip using system unzip or tar
      try {
        execSync(`unzip -o "${zipPath}" -d "${binDir}"`, { stdio: 'ignore' });
      } catch {
        execSync(`tar -xf "${zipPath}" -C "${binDir}"`, { stdio: 'ignore' });
      }
      try { fs.unlinkSync(zipPath); } catch {}

      if (fs.existsSync(ffmpegDest)) {
        fs.chmodSync(ffmpegDest, 0o755);
        if (verifyBinary(ffmpegDest, 'ffmpeg')) {
          ffmpegReady = true;
          console.log(`[install-binaries] Successfully installed and verified FFmpeg at ${ffmpegDest}`);
        }
      }
    } catch (err) {
      console.error('[install-binaries] Failed to download/extract FFmpeg:', err.message);
    }
  }

  // Mirror to node_modules/.bin if ./bin/ffmpeg exists
  if (fs.existsSync(ffmpegDest)) {
    try {
      fs.copyFileSync(ffmpegDest, nodeFfmpegDest);
      fs.chmodSync(nodeFfmpegDest, 0o755);
    } catch (copyErr) {
      console.warn(`[install-binaries] Warning: Could not mirror FFmpeg to node_modules/.bin: ${copyErr.message}`);
    }
  }

  // Final check: yt-dlp must be ready
  if (!ytdlpReady) {
    throw new Error('Critical dependency yt-dlp could not be verified.');
  }

  // Final check: FFmpeg must be ready
  if (!ffmpegReady) {
    throw new Error('Critical dependency FFmpeg could not be verified.');
  }

  console.log('[install-binaries] All critical media binaries successfully verified.');
}

main().catch((err) => {
  console.error('[install-binaries] Fatal error during binary installation:', err);
  process.exit(1);
});
