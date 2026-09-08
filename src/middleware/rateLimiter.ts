import rateLimit from 'express-rate-limit';
import { sendError } from '../utils/response.js';
import { env } from '../config/env.js';

export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.NODE_ENV === 'development' ? 5000 : env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/api/health',
  handler: (_req, res) => {
    sendError(
      res,
      'RATE_LIMIT_EXCEEDED',
      'Too many requests from this IP, please try again later.',
      429
    );
  },
});
