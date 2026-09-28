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

  if (_req.query.probe === 'pot') {
    try {
      const potBin = potProviderService.findBinaryPath() || 'bgutil-pot';
      const pluginsDir = potProviderService.getPluginsDir() || 'none';
      let cliToken = '';
      let cliError = '';
      try {
        const { stdout } = await execAsync(`"${potBin}" -c jNQXAC9IVRw`, { timeout: 10000 });
        cliToken = stdout.trim();
      } catch (e: any) {
        cliError = e.message;
      }

      const targetUrl = (_req.query.url as string) || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
      const client = (_req.query.client as string) || 'android_vr,web_embedded';
      const withToken = _req.query.with_token === '1';

      let parsedToken = '';
      if (cliToken) {
        try {
          const parsed = JSON.parse(cliToken);
          parsedToken = parsed.poToken || '';
        } catch {}
      }

      const clientArg = client === 'none' ? '' : `--extractor-args "youtube:player_client=${client}"`;
      const tokenArg = withToken && parsedToken
        ? `--extractor-args "youtube:po_token=web.gvs+${parsedToken},web.player+${parsedToken}"`
        : '';
      const potBaseArg = `--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416"`;

      const withCookies = _req.query.cookies === '1' || _req.query.with_cookies === '1';
      const cookieStatus = inspectCookieStatus();
      const cookieArg = withCookies && cookieStatus.activePath ? `--cookies "${cookieStatus.activePath}"` : '';

      let ytdlpDebug = '';
      let ytdlpSuccess = false;
      try {
        const cmd = `yt-dlp --plugin-dirs "${pluginsDir}" ${potBaseArg} ${clientArg} ${tokenArg} ${cookieArg} -v --simulate "${targetUrl}"`;
        const { stdout, stderr } = await execAsync(cmd, { timeout: 20000 });
        ytdlpDebug = (stderr || stdout).slice(0, 3000);
        ytdlpSuccess = true;
      } catch (e: any) {
        ytdlpDebug = (e.stderr || e.stdout || e.message).slice(0, 3000);
      }

      const pingResult = await potProviderService.ping();

      res.json({
        potBin,
        pluginsDir,
        pingResult,
        cliTokenSnippet: parsedToken ? `${parsedToken.slice(0, 20)}...` : 'none',
        cliError,
        ytdlpSuccess,
        ytdlpDebug,
      });
      return;
    } catch (e: any) {
      res.status(500).json({ error: e.message });
      return;
    }
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
  const potStatus = potProviderService.getStatus();
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
        potProvider: {
          active: potStatus.active,
          version: potStatus.version,
          port: potStatus.port,
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
    cookies: safeCookieInfo,
    potProvider: {
      active: potStatus.active,
      version: potStatus.version,
      port: potStatus.port,
    },
    ytdlp: {
      version: cachedYtdlpVersion,
      available: ytdlpHealthy,
      jsRuntime: 'node',
      ejsAvailable: true,
      extractorConfiguration: getExtractorClientConfigString(),
    },
    ffmpeg: {
      version: cachedFfmpegVersion,
      available: ffmpegHealthy,
    },
  }, 200);
}


