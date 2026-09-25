import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';

import { execSync } from 'node:child_process';

let cachedYtdlpVersion = '';
let cachedYtdlpPath = '';

export function getHealthCheck(_req: Request, res: Response): void {
  if (!cachedYtdlpVersion) {
    try {
      cachedYtdlpVersion = execSync('yt-dlp --version', { encoding: 'utf-8', timeout: 3000 }).trim();
      cachedYtdlpPath = execSync(process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp', { encoding: 'utf-8', timeout: 3000 }).trim();
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
