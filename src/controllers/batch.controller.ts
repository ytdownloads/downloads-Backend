import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive, ArchiverError } from 'archiver';
import { batchJobRegistry } from '../services/batchJobRegistry.service.js';
import { playlistQueue } from '../services/playlistQueue.service.js';
import { sendSuccess } from '../utils/response.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { validateYouTubeUrl } from '../services/urlValidation.service.js';
import { env } from '../config/env.js';

const batchItemSchema = z.object({
  id: z.string().trim().min(1, 'Item id is required.'),
  url: z.string().trim().min(1, 'Item url is required.'),
  title: z.string().trim().min(1, 'Item title is required.'),
  durationSeconds: z.number().optional(),
  thumbnail: z.string().optional(),
});

const createBatchSchema = z.object({
  playlistTitle: z.string().trim().optional(),
  formatId: z.string().trim().min(1, 'formatId is required.'),
  items: z.array(batchItemSchema).min(1, 'At least one item is required in the batch.'),
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ITEM_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

function getValidatedBatchJobId(req: Request): string {
  const val = req.params['batchJobId'];
  const rawId = Array.isArray(val) ? val[0] : val;
  if (!rawId || !UUID_REGEX.test(rawId)) {
    throw new AppError('INVALID_REQUEST', 'Invalid or malformed batch job ID.', 400);
  }
  return rawId;
}

function getValidatedItemId(req: Request): string {
  const val = req.params['itemId'];
  const rawId = Array.isArray(val) ? val[0] : val;
  if (!rawId || !SAFE_ITEM_ID_REGEX.test(rawId)) {
    throw new AppError('INVALID_REQUEST', 'Invalid or malformed item ID.', 400);
  }
  return rawId;
}

export async function createBatch(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const parseResult = createBatchSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0]?.message || 'Invalid batch download request body.';
      throw new AppError('INVALID_REQUEST', issue, 400);
    }

    const { playlistTitle, formatId, items } = parseResult.data;

    // Validate formatId
    const isAudio = formatId === 'audio-best';
    const isVideo = /^video-(\d{3,4})p$/.test(formatId);
    if (!isAudio && !isVideo) {
      throw new AppError('FORMAT_UNAVAILABLE', 'Invalid or unsupported format selection.', 400);
    }

    // Validate item URLs
    const sanitizedItems = items.map((item) => {
      try {
        const validated = validateYouTubeUrl(item.url);
        return {
          ...item,
          url: validated.normalizedUrl,
        };
      } catch {
        return item;
      }
    });

    const batchJob = batchJobRegistry.createBatchJob(sanitizedItems, formatId, playlistTitle);
    playlistQueue.enqueue(batchJob);

    sendSuccess(
      res,
      {
        batchJobId: batchJob.batchJobId,
        totalItems: batchJob.items.length,
        status: batchJob.status,
      },
      201
    );
  } catch (error) {
    next(error);
  }
}

export function getBatchEvents(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found.', 404);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Initial snapshot
    sendEvent('init', batchJob.toData());

    // Keepalive ping
    const pingInterval = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    const onEvent = () => {
      sendEvent('batch_update', batchJob.toData());
    };

    const onCancelled = () => {
      sendEvent('batch_cancelled', batchJob.toData());
    };

    batchJob.emitter.on('item_status', onEvent);
    batchJob.emitter.on('item_progress', onEvent);
    batchJob.emitter.on('item_complete', onEvent);
    batchJob.emitter.on('item_failed', onEvent);
    batchJob.emitter.on('batch_progress', onEvent);
    batchJob.emitter.on('batch_cancelled', onCancelled);

    req.on('close', () => {
      clearInterval(pingInterval);
      batchJob.emitter.off('item_status', onEvent);
      batchJob.emitter.off('item_progress', onEvent);
      batchJob.emitter.off('item_complete', onEvent);
      batchJob.emitter.off('item_failed', onEvent);
      batchJob.emitter.off('batch_progress', onEvent);
      batchJob.emitter.off('batch_cancelled', onCancelled);
    });
  } catch (error) {
    next(error);
  }
}

export function getBatchStatus(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found.', 404);
    }

    sendSuccess(res, batchJob.toData(), 200);
  } catch (error) {
    next(error);
  }
}

export function getBatchZip(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found or expired.', 404);
    }

    const completedItems = batchJob.items.filter(
      (item) => item.status === 'completed' && item.filePath && fs.existsSync(item.filePath)
    );

    if (completedItems.length === 0) {
      throw new AppError('INVALID_REQUEST', 'No completed files available to package into ZIP yet.', 400);
    }

    const safeTitle = (batchJob.playlistTitle || 'Playlist')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .replace(/\s+/g, '_') || 'Playlist';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.zip"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    logger.info('Streaming batch ZIP to client', {
      batchJobId,
      completedCount: completedItems.length,
    });

    const archive = new ZipArchive({
      zlib: { level: 0 }, // Store mode: Zero compression overhead on already encoded video/audio
    });

    archive.on('warning', (err: ArchiverError) => {
      if (err.code === 'ENOENT') {
        logger.warn('Archiver file not found warning', { error: err.message });
      } else {
        logger.error('Archiver warning', { error: err.message });
      }
    });

    archive.on('error', (err: ArchiverError) => {
      logger.error('Archiver error', { error: err.message });
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    archive.pipe(res);

    completedItems.forEach((item, index) => {
      if (!item.filePath) return;
      const ext = path.extname(item.filePath);
      const indexNum = String(index + 1).padStart(2, '0');
      const safeItemTitle = (item.title || `video_${index + 1}`)
        .replace(/[^\w\s.-]/g, '')
        .trim();
      const entryName = `${indexNum} - ${safeItemTitle}${ext}`;
      archive.file(item.filePath, { name: entryName });
    });

    void archive.finalize();
  } catch (error) {
    next(error);
  }
}

export function getBatchItemFile(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const itemId = getValidatedItemId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found or expired.', 404);
    }

    const item = batchJob.getItem(itemId);
    if (!item) {
      throw new AppError('NOT_FOUND', 'Item not found in batch job.', 404);
    }

    if (item.status !== 'completed' || !item.filePath) {
      throw new AppError('INVALID_REQUEST', 'Item download is not completed yet.', 400);
    }

    const filePath = item.filePath;
    const resolvedPath = path.resolve(filePath);
    const resolvedTempBase = path.resolve(env.TEMP_DIR);

    // Defense-in-depth: Strict path traversal verification
    if (!resolvedPath.startsWith(resolvedTempBase) || !fs.existsSync(resolvedPath)) {
      throw new AppError('NOT_FOUND', 'Generated file has expired or is unavailable.', 404);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : 'video/mp4';
    const safeFileName = (item.fileName || `${item.title}${ext}`).replace(/[^\w.-]/g, '_');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (item.fileSize) {
      res.setHeader('Content-Length', item.fileSize);
    }

    logger.info('Streaming batch item file to client', { batchJobId, itemId, safeFileName });
    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);

    stream.on('error', (err) => {
      logger.error('Item file stream error', { error: String(err) });
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  } catch (error) {
    next(error);
  }
}

export function cancelBatch(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found.', 404);
    }

    playlistQueue.cancelBatch(batchJobId);
    sendSuccess(res, { message: 'Batch download cancelled.' }, 200);
  } catch (error) {
    next(error);
  }
}

export function retryBatch(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found.', 404);
    }

    playlistQueue.retryBatch(batchJobId);
    sendSuccess(res, { message: 'Retrying failed items in batch.' }, 200);
  } catch (error) {
    next(error);
  }
}
