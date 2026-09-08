import { Response } from 'express';
import { ApiErrorResponse } from '../types/api.types.js';

export function sendSuccess<T>(res: Response, data?: T, statusCode = 200): Response {
  if (data && typeof data === 'object' && 'status' in data && Object.keys(data).length === 1) {
    // Specialized format matching { success: true, status: 'ok' }
    return res.status(statusCode).json({
      success: true,
      ...(data as Record<string, unknown>),
    });
  }

  return res.status(statusCode).json({
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
}

export function sendError(
  res: Response,
  code: string,
  message: string,
  statusCode = 400,
  details?: unknown
): Response {
  const payload: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return res.status(statusCode).json(payload);
}
