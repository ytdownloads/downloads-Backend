import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { CleanupService } from './services/cleanup.service.js';
import { jobRegistry } from './services/jobRegistry.service.js';
import { batchJobRegistry } from './services/batchJobRegistry.service.js';

const app = createApp();

// Execute temporary directory startup cleanup
void CleanupService.startupCleanup();

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`Server running in ${env.NODE_ENV} mode on 0.0.0.0:${env.PORT}`, {
    port: env.PORT,
    environment: env.NODE_ENV,
    corsOrigin: env.FRONTEND_URL,
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
