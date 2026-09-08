import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, originalUrl, ip } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    logger.info(`${method} ${originalUrl} ${statusCode} - ${duration}ms`, {
      ip: ip || 'unknown',
      status: statusCode,
    });
  });

  next();
}
