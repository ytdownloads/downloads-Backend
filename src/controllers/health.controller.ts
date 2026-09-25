import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';

export function getHealthCheck(_req: Request, res: Response): void {
  sendSuccess(res, { status: 'ok', version: '1.0.0', engine: 'visionos', nodePath: process.execPath }, 200);
}
