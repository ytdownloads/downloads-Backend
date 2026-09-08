import { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.js';

export function getHealthCheck(_req: Request, res: Response): void {
  sendSuccess(res, { status: 'ok' }, 200);
}
