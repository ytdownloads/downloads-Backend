import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectCookieStatus, isBotBlockRecent } from '../services/ytdlp.service.js';

const execAsync = promisify(exec);
let cachedYtdlpVersion = '';
let cachedYtdlpPath = '';
let cachedFfmpegVersion = '';
let cachedFfmpegPath = '';

export async function getHealthCheck(_req: Request, res: Response): Promise<void> {
  // Allow safe simulation of states for verification
  if (_req.query.simulate === 'offline') {
    res.status(503).json({
      success: false,
      status: 'offline',
      data: {
        status: 'offline',
        ready: false,
        message: 'Simulated server offline condition for verification',
      },
    });
    return;
  }

  if (_req.query.simulate === 'online') {
    sendSuccess(res, {
      status: 'ok',
      ready: true,
      simulated: true,
      version: '1.0.0',
    }, 200);
    return;
  }

  // 1. Verify yt-dlp
  if (!cachedYtdlpVersion || cachedYtdlpVersion.startsWith('error')) {
    try {
      const { stdout: vOut } = await execAsync('yt-dlp --version', { timeout: 15000 });
      cachedYtdlpVersion = vOut.trim();
      const whichCmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
      const { stdout: pOut } = await execAsync(whichCmd, { timeout: 15000 });
      cachedYtdlpPath = pOut.trim();
    } catch (e) {
      cachedYtdlpVersion = 'error: ' + String(e);
    }
  }

  // 2. Verify FFmpeg
  if (!cachedFfmpegVersion || cachedFfmpegVersion.startsWith('error')) {
    try {
      const { stdout: fOut } = await execAsync('ffmpeg -version', { timeout: 15000 });
      cachedFfmpegVersion = fOut.split('\n')[0].trim();
      const whichCmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
      const { stdout: fpOut } = await execAsync(whichCmd, { timeout: 15000 });
      cachedFfmpegPath = fpOut.trim();
    } catch (e) {
      cachedFfmpegVersion = 'error: ' + String(e);
    }
  }

  const ytdlpHealthy = Boolean(cachedYtdlpVersion && !cachedYtdlpVersion.startsWith('error'));
  const ffmpegHealthy = Boolean(cachedFfmpegVersion && !cachedFfmpegVersion.startsWith('error'));
  const cookieStatus = inspectCookieStatus();
  const isBotBlocked = isBotBlockRecent();
  const isReady = ytdlpHealthy && ffmpegHealthy && !isBotBlocked;

  // Safe non-sensitive cookie diagnostics
  const safeCookieInfo = {
    detected: cookieStatus.detected,
    readable: cookieStatus.readable,
    validFormat: cookieStatus.validFormat,
    source: cookieStatus.source,
    cookiesPassedToYtDlp: Boolean(cookieStatus.activePath),
  };

  if (!isReady) {
    res.status(503).json({
      success: false,
      status: 'offline',
      data: {
        status: 'offline',
        ready: false,
        reason: isBotBlocked ? 'BOT_DETECTION_BLOCKED' : 'DEPENDENCIES_UNAVAILABLE',
        message: isBotBlocked
          ? 'YouTube is temporarily blocking datacenter requests from this server IP. Configure youtube-cookies.txt in Render Secret Files to authenticate.'
          : 'Required media dependencies are not operational.',
        cookies: safeCookieInfo,
        ytdlpVersion: cachedYtdlpVersion,
        ffmpegVersion: cachedFfmpegVersion,
      },
    });
    return;
  }

  sendSuccess(res, {
    status: 'ok',
    ready: true,
    version: '1.0.0',
    cookies: safeCookieInfo,
    ytdlp: {
      version: cachedYtdlpVersion,
      available: ytdlpHealthy,
      jsRuntime: 'node',
      ejsAvailable: true,
      extractorConfiguration: cookieStatus.activePath
        ? 'youtube:player_client=mweb,android'
        : 'youtube:player_client=android,mweb',
    },
    ffmpeg: {
      version: cachedFfmpegVersion,
      available: ffmpegHealthy,
    },
  }, 200);
}
