import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectCookieStatus, isBotBlockRecent, getExtractorClientConfigString } from '../services/ytdlp.service.js';
import { potProviderService } from '../services/potProvider.service.js';

const execAsync = promisify(exec);
let cachedYtdlpVersion = '';
let cachedYtdlpPath = '';
let cachedFfmpegVersion = '';
let cachedFfmpegPath = '';
let cachedDenoVersion = '';

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

  // Allow manual cache refresh for dependency probes
  if (_req.query.refresh === '1' || _req.query.refresh === 'true') {
    cachedYtdlpVersion = '';
    cachedFfmpegVersion = '';
    cachedDenoVersion = '';
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

  // 3. Verify Deno runtime (for BotGuard / JS challenges)
  if (!cachedDenoVersion || cachedDenoVersion.startsWith('error')) {
    try {
      const { stdout: dOut } = await execAsync('deno --version', { timeout: 10000 });
      cachedDenoVersion = dOut.split('\n')[0].trim();
    } catch (e) {
      cachedDenoVersion = 'none';
    }
  }

  const ytdlpHealthy = Boolean(cachedYtdlpVersion && !cachedYtdlpVersion.startsWith('error'));
  const ffmpegHealthy = Boolean(cachedFfmpegVersion && !cachedFfmpegVersion.startsWith('error'));
  const cookieStatus = inspectCookieStatus();
  const potStatus = potProviderService.getStatus();
  const isBotBlocked = isBotBlockRecent();
  const isReady = ytdlpHealthy && ffmpegHealthy;

  // Safe non-sensitive cookie diagnostics
  const safeCookieInfo = {
    detected: cookieStatus.detected,
    readable: cookieStatus.readable,
    validFormat: cookieStatus.validFormat,
    source: cookieStatus.source,
    cookiesPassedToYtDlp: Boolean(cookieStatus.activePath),
    totalCookies: cookieStatus.totalCookies,
    validCookies: cookieStatus.validCookies,
    expiredCookies: cookieStatus.expiredCookies,
    hasAuthCookies: cookieStatus.hasAuthCookies,
    isExpired: cookieStatus.isExpired,
  };

  if (!isReady) {
    res.status(503).json({
      success: false,
      status: 'offline',
      data: {
        status: 'offline',
        ready: false,
        reason: 'DEPENDENCIES_UNAVAILABLE',
        message: 'Required media dependencies (yt-dlp or ffmpeg) are not operational.',
        cookies: safeCookieInfo,
        potProvider: {
          active: potStatus.active,
          version: potStatus.version,
          port: potStatus.port,
        },
        botDetection: {
          recentBlock: isBotBlocked,
          status: isBotBlocked ? 'degraded_for_some_videos' : 'normal',
        },
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
    commit: process.env.RENDER_GIT_COMMIT || 'development',
    renderInstance: process.env.RENDER_INSTANCE_ID || 'local',
    cookies: safeCookieInfo,
    potProvider: {
      active: potStatus.active,
      version: potStatus.version,
      port: potStatus.port,
    },
    botDetection: {
      recentBlock: isBotBlocked,
      status: isBotBlocked ? 'degraded_for_some_videos' : 'normal',
    },
    deno: {
      version: cachedDenoVersion,
      available: cachedDenoVersion !== 'none' && !cachedDenoVersion.startsWith('error'),
    },
    ytdlp: {
      version: cachedYtdlpVersion,
      available: ytdlpHealthy,
      jsRuntime: cachedDenoVersion !== 'none' ? 'deno' : 'node',
      ejsAvailable: true,
      extractorConfiguration: getExtractorClientConfigString(),
    },
    ffmpeg: {
      version: cachedFfmpegVersion,
      available: ffmpegHealthy,
    },
  }, 200);
}

export async function getHealthProbe(req: Request, res: Response): Promise<void> {
  const rawUrl = (req.query.url as string) || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const cookieStatus = inspectCookieStatus();
  const noCookies = req.query.nocookies === '1' || req.query.nocookies === 'true';
  const customClient = req.query.client as string;

  const args: string[] = [
    '-v',
    '-4',
    '--dump-single-json',
    '--no-playlist',
    '--skip-download',
    '--socket-timeout',
    '20',
    '--retries',
    '1',
  ];

  if (!noCookies && cookieStatus.activePath) {
    args.push('--cookies', cookieStatus.activePath);
  }

  if (customClient) {
    args.push('--extractor-args', `youtube:player_client=${customClient.trim()}`);
  }

  args.push('--', rawUrl);

  try {
    const { stdout, stderr } = await execAsync(`yt-dlp ${args.map((a) => `"${a}"`).join(' ')}`, {
      timeout: 30000,
      maxBuffer: 15 * 1024 * 1024,
    });
    res.json({
      success: true,
      args,
      cookieStatus: {
        detected: cookieStatus.detected,
        hasAuthCookies: cookieStatus.hasAuthCookies,
        isExpired: cookieStatus.isExpired,
        activePathPassed: !noCookies && Boolean(cookieStatus.activePath),
      },
      stdoutLength: stdout.length,
      stderr: stderr.slice(-3000),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      args,
      error: err.message,
      cookieStatus: {
        detected: cookieStatus.detected,
        hasAuthCookies: cookieStatus.hasAuthCookies,
        isExpired: cookieStatus.isExpired,
        activePathPassed: !noCookies && Boolean(cookieStatus.activePath),
      },
      stdoutSnippet: (err.stdout || '').slice(0, 500),
      stderr: (err.stderr || '').slice(-3000),
    });
  }
}


