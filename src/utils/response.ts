import { Response } from 'express';
import { ApiErrorResponse } from '../types/api.types.js';

export function sendSuccess<T>(res: Response, data?: T, statusCode = 200): Response {
  if (data && typeof data === 'object' && 'status' in data) {
    return res.status(statusCode).json({
      success: true,
      status: (data as Record<string, unknown>).status,
      data,
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
