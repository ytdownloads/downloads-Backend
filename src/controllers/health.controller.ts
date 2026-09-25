import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getCookieArgs } from '../services/ytdlp.service.js';

const execAsync = promisify(exec);
let cachedYtdlpVersion = '';
let cachedYtdlpPath = '';

export async function getHealthCheck(_req: Request, res: Response): Promise<void> {
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
  sendSuccess(res, {
    status: 'ok',
    version: '1.0.0',
    engine: 'android',
    nodePath: process.execPath,
    ytdlpVersion: cachedYtdlpVersion,
    ytdlpPath: cachedYtdlpPath,
  }, 200);
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function postDiagnose(req: Request, res: Response): Promise<void> {
  const client = (req.body?.client as string) || '';
  const url = (req.body?.url as string) || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const customCookies = (req.body?.cookies as string) || '';

  let cookieArgs = getCookieArgs();
  if (customCookies) {
    const customPath = path.join(os.tmpdir(), 'custom_cookies.txt');
    fs.writeFileSync(customPath, customCookies, 'utf-8');
    cookieArgs = ['--cookies', customPath];
  }
  
  const args = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
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
