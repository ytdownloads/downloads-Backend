import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { CleanupService } from './services/cleanup.service.js';
import { jobRegistry } from './services/jobRegistry.service.js';
import { batchJobRegistry } from './services/batchJobRegistry.service.js';

// Prepend project-local bin, node_modules/.bin, and node runtime directories to PATH
const projectBin = path.resolve(process.cwd(), 'bin');
const nodeModulesBin = path.resolve(process.cwd(), 'node_modules', '.bin');
const nodeBin = path.dirname(process.execPath);
const currentPath = process.env.PATH || process.env.Path || '';
const pathDelimiter = path.delimiter;
const pathParts = currentPath.split(pathDelimiter);

if (!pathParts.includes(projectBin)) {
  process.env.PATH = `${projectBin}${pathDelimiter}${nodeModulesBin}${pathDelimiter}${nodeBin}${pathDelimiter}${currentPath}`;
  process.env.Path = process.env.PATH;
}

const app = createApp();

// Execute temporary directory startup cleanup
void CleanupService.startupCleanup();

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`Server running in ${env.NODE_ENV} mode on 0.0.0.0:${env.PORT}`, {
    port: env.PORT,
    environment: env.NODE_ENV,
    corsOrigin: env.FRONTEND_URL,
  });

  // Log detected yt-dlp binary version at startup
  const probe = spawn('yt-dlp', ['--version'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  probe.stdout?.on('data', (data: Buffer) => {
    logger.info(`[Media Engine] yt-dlp active: v${data.toString().trim()}`);
  });
  probe.on('error', () => {
    logger.warn('[Media Engine] yt-dlp not detected on current PATH');
  });
});

// Graceful shutdown handling
function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Terminate any running yt-dlp child processes and cancel active download jobs
  try {
    jobRegistry.shutdownAll();
  } catch (err) {
    logger.error('Error shutting down jobRegistry:', { error: (err as Error).message });
  }

  try {
    batchJobRegistry.shutdownAll();
  } catch (err) {
    logger.error('Error shutting down batchJobRegistry:', { error: (err as Error).message });
  }

  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });

  // Force close after 10 seconds if lingering connections exist
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled Promise Rejection:', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception:', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
