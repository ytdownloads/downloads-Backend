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
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    logger.warn(`Handled application error: [${err.code}] ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
    });
    sendError(res, err.code, err.message, err.statusCode, err.details);
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
