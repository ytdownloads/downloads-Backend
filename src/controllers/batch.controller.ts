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
import { sanitizeCleanFilename, buildContentDispositionHeader } from '../utils/filename.js';

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
  items: z
    .array(batchItemSchema)
    .min(1, 'At least one item is required in the batch.')
    .max(30, 'Maximum 30 videos can be downloaded in one batch.'),
});

const addBatchItemsSchema = z.object({
  formatId: z.string().trim().min(1, 'formatId is required.'),
  items: z
    .array(batchItemSchema)
    .min(1, 'At least one item is required.')
    .max(30, 'Maximum 30 videos can be added at a time.'),
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
    batchJob.emitter.on('batch_update', onEvent);
    batchJob.emitter.on('zip_ready', onEvent);
    batchJob.emitter.on('batch_cancelled', onCancelled);

    req.on('close', () => {
      clearInterval(pingInterval);
      batchJob.emitter.off('item_status', onEvent);
      batchJob.emitter.off('item_progress', onEvent);
      batchJob.emitter.off('item_complete', onEvent);
      batchJob.emitter.off('item_failed', onEvent);
      batchJob.emitter.off('batch_progress', onEvent);
      batchJob.emitter.off('batch_update', onEvent);
      batchJob.emitter.off('zip_ready', onEvent);
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

    if (batchJob.zipStatus !== 'ready' || !batchJob.zipFilePath || !fs.existsSync(batchJob.zipFilePath)) {
      throw new AppError('INVALID_REQUEST', 'ZIP file is not ready yet. Please wait for ZIP generation to complete.', 400);
    }

    const stat = fs.statSync(batchJob.zipFilePath);
    const fileName = batchJob.zipFileName || 'playlist.zip';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', buildContentDispositionHeader(fileName));
    res.setHeader('Content-Length', stat.size.toString());
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    logger.info('Streaming finalized batch ZIP to client', {
      batchJobId,
      fileName,
      fileSize: stat.size,
    });

    const readStream = fs.createReadStream(batchJob.zipFilePath);
    readStream.pipe(res);
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
    const cleanFileName = sanitizeCleanFilename(item.fileName || item.title || `video${ext}`, ext);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', buildContentDispositionHeader(cleanFileName));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (item.fileSize) {
      res.setHeader('Content-Length', item.fileSize);
    }

    logger.info('Streaming batch item file to client', { batchJobId, itemId, cleanFileName });
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

export async function cancelBatchItem(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const itemId = getValidatedItemId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found.', 404);
    }

    const item = batchJob.getItem(itemId);
    if (!item) {
      throw new AppError('NOT_FOUND', 'Item not found in batch job.', 404);
    }

    await playlistQueue.cancelItem(batchJobId, itemId);
    sendSuccess(res, { message: 'Item cancelled successfully.', itemId }, 200);
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

    const retryableItems = batchJob.items.filter(
      (item) => item.status === 'failed' || item.status === 'cancelled'
    );
    if (retryableItems.length > 30) {
      throw new AppError('INVALID_REQUEST', 'Maximum 30 videos can be downloaded in one batch.', 400);
    }

    playlistQueue.retryBatch(batchJobId);
    sendSuccess(res, { message: 'Retrying failed items in batch.' }, 200);
  } catch (error) {
    next(error);
  }
}

export async function addBatchItems(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const batchJobId = getValidatedBatchJobId(req);
    const batchJob = batchJobRegistry.getBatchJob(batchJobId);

    if (!batchJob) {
      throw new AppError('NOT_FOUND', 'Batch download job not found.', 404);
    }

    if (batchJob.status === 'cancelled') {
      throw new AppError('INVALID_REQUEST', 'Cannot add items to a cancelled batch download.', 400);
    }

    const parseResult = addBatchItemsSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0]?.message || 'Invalid add items request body.';
      throw new AppError('INVALID_REQUEST', issue, 400);
    }

    const { formatId, items } = parseResult.data;

    // Validate formatId
    const isAudio = formatId === 'audio-best';
    const isVideo = /^video-(\d{3,4})p$/.test(formatId);
    if (!isAudio && !isVideo) {
      throw new AppError('FORMAT_UNAVAILABLE', 'Invalid or unsupported format selection.', 400);
    }

    // Check for duplicates against existing items
    const existingIds = new Set(batchJob.items.map((i) => i.id));
    const newItems = items.filter((item) => !existingIds.has(item.id));

    if (newItems.length === 0) {
      throw new AppError('INVALID_REQUEST', 'All selected videos are already in the download queue.', 400);
    }

    // Validate item URLs
    const sanitizedItems = newItems.map((item) => {
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

    const added = batchJob.addItems(sanitizedItems, formatId);
    playlistQueue.resumeBatch(batchJobId);

    logger.info('Added items to batch job', {
      batchJobId,
      addedCount: added.length,
      totalItems: batchJob.items.length,
      formatId,
    });

    sendSuccess(
      res,
      {
        batchJobId,
        addedCount: added.length,
        totalItems: batchJob.items.length,
        status: batchJob.status,
        batch: batchJob.toData(),
      },
      200
    );
  } catch (error) {
    next(error);
  }
}
