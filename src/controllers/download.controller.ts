import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { DownloadService } from '../services/download.service.js';
import { jobRegistry } from '../services/jobRegistry.service.js';
import { sendSuccess } from '../utils/response.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { sanitizeCleanFilename, buildContentDispositionHeader } from '../utils/filename.js';

const createDownloadSchema = z.object({
  url: z.string({
    required_error: 'URL is required.',
  }).trim().min(1, 'URL cannot be empty.'),
  formatId: z.string({
    required_error: 'formatId is required.',
  }).trim().min(1, 'formatId cannot be empty.'),
  type: z.literal('video').optional(),
});

export async function createDownload(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const parseResult = createDownloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0]?.message || 'Invalid request body.';
      throw new AppError('INVALID_REQUEST', issue, 400);
    }

    const { url, formatId } = parseResult.data;
    const job = await DownloadService.startDownload(url, formatId);

    sendSuccess(
      res,
      {
        jobId: job.jobId,
        status: job.status,
      },
      201
    );
  } catch (error) {
    next(error);
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getValidatedJobId(req: Request): string {
  const val = req.params['jobId'];
  const rawId = Array.isArray(val) ? val[0] : val;
  if (!rawId || !UUID_REGEX.test(rawId)) {
    throw new AppError('INVALID_REQUEST', 'Invalid or malformed job ID.', 400);
  }
  return rawId;
}

export function getDownloadEvents(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const jobId = getValidatedJobId(req);
    const job = jobRegistry.getJob(jobId);

    if (!job) {
      throw new AppError('NOT_FOUND', 'Download job not found.', 404);
    }

    // Set Server-Sent Events headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Helper to send SSE message
    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial status immediately
    sendEvent('status', job.toData());

    // Event listeners
    const onProgress = () => {
      sendEvent('progress', job.toData());
    };

    const onCompleted = () => {
      sendEvent('completed', job.toData());
      setTimeout(() => res.end(), 1000);
    };

    const onError = () => {
      sendEvent('error', job.toData());
      setTimeout(() => res.end(), 1000);
    };

    const onCancelled = () => {
      sendEvent('cancelled', job.toData());
      setTimeout(() => res.end(), 1000);
    };

    job.emitter.on('progress', onProgress);
    job.emitter.on('completed', onCompleted);
    job.emitter.on('error', onError);
    job.emitter.on('cancelled', onCancelled);

    // Cleanup on client disconnect
    req.on('close', () => {
      job.emitter.off('progress', onProgress);
      job.emitter.off('completed', onCompleted);
      job.emitter.off('error', onError);
      job.emitter.off('cancelled', onCancelled);
    });
  } catch (error) {
    next(error);
  }
}

export function getDownloadStatus(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const jobId = getValidatedJobId(req);
    const job = jobRegistry.getJob(jobId);

    if (!job) {
      throw new AppError('NOT_FOUND', 'Download job not found.', 404);
    }

    sendSuccess(res, job.toData(), 200);
  } catch (error) {
    next(error);
  }
}

export function getDownloadFile(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const jobId = getValidatedJobId(req);
    const job = jobRegistry.getJob(jobId);

    if (!job) {
      throw new AppError('NOT_FOUND', 'Download job not found or expired.', 404);
    }

    if (job.status !== 'completed' || !job.outputFilePath) {
      throw new AppError('INVALID_REQUEST', 'Download is not completed yet.', 400);
    }

    const filePath = job.outputFilePath;
    const resolvedPath = path.resolve(filePath);
    const resolvedTempBase = path.resolve(env.TEMP_DIR);

    // Defense-in-depth: Strict path traversal verification
    if (!resolvedPath.startsWith(resolvedTempBase) || !fs.existsSync(resolvedPath)) {
      throw new AppError('NOT_FOUND', 'Generated file has expired or is unavailable.', 404);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : 'video/mp4';

    // Clean, readable, Windows-safe filename
    const cleanFileName = sanitizeCleanFilename(job.fileName || job.title || `video${ext}`, ext);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', buildContentDispositionHeader(cleanFileName));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (job.fileSize) {
      res.setHeader('Content-Length', job.fileSize);
    }

    logger.info('Streaming completed file to client', { jobId, cleanFileName });
    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);

    stream.on('error', (err) => {
      logger.error('File streaming error', { error: String(err) });
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  } catch (error) {
    next(error);
  }
}

export function cancelDownload(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const jobId = getValidatedJobId(req);
    const job = jobRegistry.getJob(jobId);

    if (!job) {
      throw new AppError('NOT_FOUND', 'Download job not found.', 404);
    }

    job.cancel();
    sendSuccess(res, { message: 'Download cancelled successfully.' }, 200);
  } catch (error) {
    next(error);
  }
}
