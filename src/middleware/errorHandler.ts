import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { sendError } from '../utils/response.js';
import { env } from '../config/env.js';

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const isAppError =
    err instanceof AppError ||
    err?.name === 'AppError' ||
    (typeof err?.code === 'string' && typeof err?.statusCode === 'number');

  if (isAppError) {
    logger.warn(`Handled application error: [${err.code}] ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
    });
    sendError(res, err.code, err.message, err.statusCode, err.details);
    return;
  }

  // CORS policy errors
  if (err.message && err.message.includes('Blocked by CORS policy')) {
    logger.warn(`Handled CORS error: ${err.message}`);
    sendError(res, 'CORS_ERROR', err.message, 403);
    return;
  }

  // Fallback for bot detection in unhandled errors
  const lowerMsg = (err.message || '').toLowerCase();
  if (
    lowerMsg.includes('sign in to confirm') ||
    lowerMsg.includes('not a bot') ||
    lowerMsg.includes('bot detection') ||
    lowerMsg.includes('automated queries')
  ) {
    logger.warn('Handled bot detection in error handler fallback');
    sendError(
      res,
      'BOT_DETECTION_BLOCKED',
      'YouTube is temporarily blocking this server from accessing the video. Please try again later.',
      503
    );
    return;
  }

  // Unhandled internal server error
  logger.error('Unhandled server error:', {
    message: err.message,
    stack: env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  const message =
    env.NODE_ENV === 'production'
      ? 'An internal server error occurred. Please try again later.'
      : err.message || 'Internal Server Error';

  sendError(res, 'INTERNAL_SERVER_ERROR', message, 500);
}

export function notFoundHandler(req: Request, res: Response): void {
  sendError(res, 'NOT_FOUND', `Endpoint ${req.method} ${req.originalUrl} not found`, 404);
}
