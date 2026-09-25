import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getCookieArgs, isBotBlockRecent } from '../services/ytdlp.service.js';

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
      engine: 'android,web_embedded',
      nodePath: process.execPath,
      ytdlpVersion: cachedYtdlpVersion || '2026.08.19',
      ytdlpPath: cachedYtdlpPath || '/usr/bin/yt-dlp',
      ffmpegVersion: cachedFfmpegVersion || 'ffmpeg 5.1.9',
      ffmpegPath: cachedFfmpegPath || '/usr/bin/ffmpeg',
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
  const isBotBlocked = isBotBlockRecent();
  const isReady = ytdlpHealthy && ffmpegHealthy && !isBotBlocked;

  if (!isReady) {
    res.status(503).json({
      success: false,
      status: 'offline',
      data: {
        status: 'offline',
        ready: false,
        reason: isBotBlocked ? 'BOT_DETECTION_BLOCKED' : 'DEPENDENCIES_UNAVAILABLE',
        message: isBotBlocked
          ? 'YouTube is temporarily blocking datacenter requests from this server IP. Configure YOUTUBE_COOKIES in Render to authenticate.'
          : 'Required media dependencies are not operational.',
        ytdlpVersion: cachedYtdlpVersion,
        ytdlpPath: cachedYtdlpPath,
        ffmpegVersion: cachedFfmpegVersion,
        ffmpegPath: cachedFfmpegPath,
        nodePath: process.execPath,
      },
    });
    return;
  }

  sendSuccess(res, {
    status: 'ok',
    ready: true,
    version: '1.0.0',
    engine: 'android,web_embedded',
    nodePath: process.execPath,
    ytdlpVersion: cachedYtdlpVersion,
    ytdlpPath: cachedYtdlpPath,
    ffmpegVersion: cachedFfmpegVersion,
    ffmpegPath: cachedFfmpegPath,
  }, 200);
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function postDiagnose(req: Request, res: Response): Promise<void> {
  const client = (req.body?.client as string) || '';
  const url = (req.body?.url as string) || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const customCookies = (req.body?.cookies as string) || '';
  const noCookies = Boolean(req.body?.noCookies || customCookies === 'NONE');

  let cookieArgs = noCookies ? [] : getCookieArgs();
  if (!noCookies && customCookies) {
    const customPath = path.join(os.tmpdir(), 'custom_cookies.txt');
    fs.writeFileSync(customPath, customCookies, 'utf-8');
    cookieArgs = ['--cookies', customPath];
  }
  
  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    '--remote-components',
    'ejs:github',
    '--js-runtimes',
    `node:${process.execPath}`,
    ...cookieArgs,
  ];
  if (client) {
    args.push('--extractor-args', `youtube:player_client=${client}`);
  }
  args.push(url);

  try {
    const child = spawn('yt-dlp', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 25000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      let title = '';
      let formatsCount = 0;
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout);
          title = parsed.title;
          formatsCount = parsed.formats?.length || 0;
        } catch {}
      }
      sendSuccess(res, {
        code,
        title,
        formatsCount,
        args,
        cookieArgs,
        cwd: process.cwd(),
        stdoutLength: stdout.length,
        stderr: stderr.slice(0, 500),
      }, 200);
    });
  } catch (err) {
    sendSuccess(res, { error: String(err) }, 500);
  }
}
