import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './config/env.js';
import { apiRouter } from './routes/index.js';
import { requestLogger } from './middleware/requestLogger.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { getHealthCheck } from './controllers/health.controller.js';

export function createApp(): Express {
  const app = express();

  // Security headers (allow Vite inline styles & scripts)
  app.use(
    helmet({
      contentSecurityPolicy: false,
    })
  );

  // CORS configuration
  const defaultOrigins = [
    'https://ytdownloads.github.io',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];

  const configuredOrigins = [
    ...(env.FRONTEND_URL ? env.FRONTEND_URL.split(',') : []),
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : []),
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
  ]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const allowedOrigins = Array.from(new Set([...defaultOrigins, ...configuredOrigins]));

  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      const normalizedOrigin = origin.trim().replace(/\/+$/, '');
      if (
        env.NODE_ENV === 'development' ||
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(normalizedOrigin) ||
        normalizedOrigin === 'https://ytdownloads.github.io'
      ) {
        return callback(null, true);
      }
      return callback(new Error(`Blocked by CORS policy: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition', 'Content-Length'],
    maxAge: 86400,
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  // Request size limiting & parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Structured request logging
  app.use(requestLogger);

  // Direct root healthcheck endpoint (in addition to /api/health)
  app.get('/health', getHealthCheck);

  // Rate limiting for API endpoints
  app.use('/api', apiRateLimiter);

  // Mount API routes
  app.use('/api', apiRouter);

  // Serve production frontend bundle if built
  const frontendDist = path.resolve(process.cwd(), 'frontend/dist');
  const fallbackFrontendDist = path.resolve(process.cwd(), '../frontend/dist');
  const targetDist = fs.existsSync(frontendDist)
    ? frontendDist
    : fs.existsSync(fallbackFrontendDist)
    ? fallbackFrontendDist
    : null;

  if (targetDist) {
    app.use(express.static(targetDist));
    const VALID_SPA_ROUTES = new Set([
      '',
      '/',
      '/privacy',
      '/terms',
      '/dmca',
      '/cookies',
      '/disclaimer',
    ]);
    app.get('*', (req, res, next) => {
      const normalizedPath = req.path.toLowerCase().replace(/\/$/, '');
      if (VALID_SPA_ROUTES.has(normalizedPath) || normalizedPath.startsWith('/downloads')) {
        return res.sendFile(path.join(targetDist, 'index.html'));
      }
      return next();
    });
  }

  // 404 Fallback for unhandled API or missing routes
  app.use(notFoundHandler);

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}
