import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  BatchStatus,
  PlaylistItemStatus,
  DownloadStage,
  BatchItemData,
  BatchJobData,
  BatchPlaylistItemInput,
  BatchZipStatus,
} from '../types/download.types.js';
import { CleanupService } from './cleanup.service.js';

export class BatchJob {
  public readonly batchJobId: string;
  public readonly playlistTitle: string;
  public readonly formatId: string;
  public status: BatchStatus;
  public items: BatchItemData[];
  public readonly tempDir: string;
  public activeProcesses: Map<string, ChildProcess> = new Map();
  public zipStatus: BatchZipStatus = 'idle';
  public zipStatusMessage?: string;
  public zipFilePath?: string;
  public zipFileName?: string;
  public zipFileSize?: number;
  public readonly createdAt: number;
  public updatedAt: number;
  public readonly emitter: EventEmitter;
  private cleanupTimeout?: NodeJS.Timeout;

  constructor(items: BatchPlaylistItemInput[], formatId: string, playlistTitle?: string) {
    this.batchJobId = crypto.randomUUID();
    this.playlistTitle = playlistTitle?.trim() || 'YouTube Playlist';
    this.formatId = formatId;
    this.status = 'queued';
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.tempDir = path.join(path.resolve(env.TEMP_DIR), `batch_${this.batchJobId}`);

    const seenIds = new Set<string>();
    this.items = items.map((item, idx) => {
      let uniqueId = item.id;
      if (seenIds.has(uniqueId)) {
        let suffix = idx + 1;
        while (seenIds.has(`${item.id}_${suffix}`)) {
          suffix++;
        }
        uniqueId = `${item.id}_${suffix}`;
      }
      seenIds.add(uniqueId);

      return {
        id: uniqueId,
        url: item.url,
        title: item.title,
        durationSeconds: item.durationSeconds,
        thumbnail: item.thumbnail,
        formatId,
        status: 'pending',
        stage: 'preparing',
        stageMessage: 'Queued',
        isIndeterminate: false,
        percentage: 0,
        downloadedBytes: 0,
        totalBytes: null,
        speedBytesPerSecond: null,
        etaSeconds: null,
      };
    });

    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.emitter.on('error', () => {});
  }

  public getItem(itemId: string): BatchItemData | undefined {
    return this.items.find((i) => i.id === itemId);
  }

  public updateItemStatus(
    itemId: string,
    status: PlaylistItemStatus,
    error?: { code: string; message: string },
    stage?: DownloadStage,
    stageMessage?: string,
    isIndeterminate?: boolean
  ): void {
    const item = this.getItem(itemId);
    if (!item) return;

    item.status = status;
    if (error) {
      item.error = error;
    }
    if (stage) item.stage = stage;
    if (stageMessage) item.stageMessage = stageMessage;
    if (isIndeterminate !== undefined) item.isIndeterminate = isIndeterminate;

    this.updatedAt = Date.now();
    this.recalculateBatchStatus();
    this.emitter.emit('item_status', { itemId, item, batch: this.toData() });
  }

  public updateItemProgress(
    itemId: string,
    progress: {
      percentage?: number | null;
      downloadedBytes?: number | null;
      totalBytes?: number | null;
      speedBytesPerSecond?: number | null;
      etaSeconds?: number | null;
      stage?: DownloadStage;
      stageMessage?: string;
      isIndeterminate?: boolean;
    }
  ): void {
    const item = this.getItem(itemId);
    if (!item) return;

    if (progress.percentage !== undefined && progress.percentage !== null) {
      item.percentage = progress.percentage;
    }
    if (progress.downloadedBytes !== undefined && progress.downloadedBytes !== null) {
      item.downloadedBytes = progress.downloadedBytes;
    }
    if (progress.totalBytes !== undefined) {
      item.totalBytes = progress.totalBytes;
    }
    if (progress.speedBytesPerSecond !== undefined) {
      item.speedBytesPerSecond = progress.speedBytesPerSecond;
    }
    if (progress.etaSeconds !== undefined) {
      item.etaSeconds = progress.etaSeconds;
    }
    if (progress.stage) {
      item.stage = progress.stage;
    }
    if (progress.stageMessage) {
      item.stageMessage = progress.stageMessage;
    }
    if (progress.isIndeterminate !== undefined) {
      item.isIndeterminate = progress.isIndeterminate;
    }

    this.updatedAt = Date.now();
    this.recalculateBatchStatus();
    this.emitter.emit('item_progress', { itemId, item, batch: this.toData() });
  }

  public completeItem(itemId: string, filePath: string, fileName: string, fileSize: number): void {
    const item = this.getItem(itemId);
    if (!item) return;

    item.status = 'completed';
    item.stage = 'completed';
    item.stageMessage = 'Ready';
    item.isIndeterminate = false;
    item.percentage = 100;
    item.filePath = filePath;
    item.fileName = fileName;
    item.fileSize = fileSize;
    item.downloadedBytes = fileSize;
    item.totalBytes = fileSize;
    item.speedBytesPerSecond = null;
    item.etaSeconds = 0;

    this.activeProcesses.delete(itemId);
    this.updatedAt = Date.now();
    this.recalculateBatchStatus();
    this.emitter.emit('item_complete', { itemId, item, batch: this.toData() });

    // If batch finished, schedule cleanup
    if (this.status === 'completed' || this.status === 'completed_with_errors') {
      this.scheduleCleanup(env.JOB_CLEANUP_DELAY_MS);
    }
  }

  public failItem(itemId: string, code: string, message: string): void {
    const item = this.getItem(itemId);
    if (!item) return;

    item.status = 'failed';
    item.stage = 'failed';
    item.stageMessage = message;
    item.isIndeterminate = false;
    item.error = { code, message };
    item.speedBytesPerSecond = null;
    item.etaSeconds = null;

    this.activeProcesses.delete(itemId);
    this.updatedAt = Date.now();
    this.recalculateBatchStatus();
    this.emitter.emit('item_failed', { itemId, item, batch: this.toData() });

    if (this.status === 'completed' || this.status === 'completed_with_errors' || this.status === 'failed') {
      this.scheduleCleanup(env.JOB_CLEANUP_DELAY_MS);
    }
  }

  public cancelItem(itemId: string): void {
    const item = this.getItem(itemId);
    if (!item || item.status === 'cancelled') return;

    item.status = 'cancelled';
    item.stage = 'cancelled';
    item.stageMessage = 'Cancelled';
    item.isIndeterminate = false;
    const child = this.activeProcesses.get(itemId);
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child && !child.killed) child.kill('SIGKILL');
        }, 1500).unref();
      } catch (err) {
        logger.warn('Error terminating item process on cancel', { itemId, error: String(err) });
      }
    }
    this.activeProcesses.delete(itemId);
    this.updatedAt = Date.now();
    this.recalculateBatchStatus();
    this.emitter.emit('item_status', { itemId, item, batch: this.toData() });
  }

  public updateZipStatus(
    status: BatchZipStatus,
    message?: string,
    zipFilePath?: string,
    zipFileName?: string,
    zipFileSize?: number
  ): void {
    this.zipStatus = status;
    if (message !== undefined) this.zipStatusMessage = message;
    if (zipFilePath !== undefined) this.zipFilePath = zipFilePath;
    if (zipFileName !== undefined) this.zipFileName = zipFileName;
    if (zipFileSize !== undefined) this.zipFileSize = zipFileSize;
    this.updatedAt = Date.now();
    this.emitter.emit('batch_update', this.toData());
    if (status === 'ready') {
      this.emitter.emit('zip_ready', this.toData());
    }
  }

  public cancelAll(): void {
    logger.info('Cancelling batch job', { batchJobId: this.batchJobId });
    this.status = 'cancelled';
    this.zipStatus = 'idle';
    this.zipStatusMessage = undefined;

    if (this.zipFilePath && fs.existsSync(this.zipFilePath)) {
      try {
        fs.unlinkSync(this.zipFilePath);
      } catch (err) {
        logger.warn('Error removing zip file on cancelAll', { error: String(err) });
      }
      this.zipFilePath = undefined;
    }

    for (const item of this.items) {
      if (item.status === 'pending' || item.status === 'downloading' || item.status === 'processing') {
        item.status = 'cancelled';
      }
    }

    for (const [itemId, child] of this.activeProcesses.entries()) {
      if (child && !child.killed) {
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child && !child.killed) child.kill('SIGKILL');
          }, 1500).unref();
        } catch (err) {
          logger.warn('Error killing process on batch cancel', { itemId, error: String(err) });
        }
      }
    }
    this.activeProcesses.clear();
    this.updatedAt = Date.now();
    this.emitter.emit('batch_cancelled', this.toData());

    // Schedule cleanup
    this.scheduleCleanup(60000);
  }

  public retryFailed(): void {
    logger.info('Retrying failed items in batch', { batchJobId: this.batchJobId });
    let resetCount = 0;

    for (const item of this.items) {
      if (item.status === 'failed' || item.status === 'cancelled') {
        item.status = 'pending';
        item.percentage = 0;
        item.downloadedBytes = 0;
        item.totalBytes = null;
        item.speedBytesPerSecond = null;
        item.etaSeconds = null;
        item.error = undefined;
        resetCount++;
      }
    }

    if (resetCount > 0) {
      this.status = 'processing';
      this.updatedAt = Date.now();
      this.emitter.emit('batch_progress', this.toData());
    }
  }

  public recalculateBatchStatus(): void {
    const total = this.items.length;
    if (total === 0) return;

    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let inFlight = 0;

    for (const item of this.items) {
      if (item.status === 'completed') completed++;
      else if (item.status === 'failed') failed++;
      else if (item.status === 'cancelled') cancelled++;
      else if (item.status === 'downloading' || item.status === 'processing' || item.status === 'pending') {
        inFlight++;
      }
    }

    if (this.status !== 'cancelled') {
      if (inFlight > 0) {
        this.status = 'processing';
      } else if (completed + failed + cancelled === total) {
        if (completed > 0 && failed > 0) {
          this.status = 'completed_with_errors';
        } else if (completed > 0) {
          this.status = 'completed';
        } else if (failed > 0) {
          this.status = 'failed';
        } else {
          this.status = 'cancelled';
        }
      }
    }
  }

  public getOverallPercentage(): number {
    if (this.items.length === 0) return 0;
    const totalSum = this.items.reduce((acc, item) => acc + (item.percentage || 0), 0);
    return Math.min(100, Math.round(totalSum / this.items.length));
  }

  public scheduleCleanup(delayMs: number): void {
    if (this.cleanupTimeout) clearTimeout(this.cleanupTimeout);
    this.cleanupTimeout = setTimeout(() => {
      void CleanupService.cleanupJobDir(this.tempDir);
      batchJobRegistry.removeJob(this.batchJobId);
    }, delayMs);
    this.cleanupTimeout.unref();
  }

  public cancelCleanup(): void {
    if (this.cleanupTimeout) {
      clearTimeout(this.cleanupTimeout);
      this.cleanupTimeout = undefined;
    }
  }

  public addItems(newItems: BatchPlaylistItemInput[], formatId: string): BatchItemData[] {
    this.cancelCleanup();

    if (newItems.length === 0) {
      return [];
    }

    const seenIds = new Set(this.items.map((i) => i.id));
    const createdItems: BatchItemData[] = newItems.map((item, idx) => {
      let uniqueId = item.id;
      if (seenIds.has(uniqueId)) {
        let suffix = this.items.length + idx + 1;
        while (seenIds.has(`${item.id}_${suffix}`)) {
          suffix++;
        }
        uniqueId = `${item.id}_${suffix}`;
      }
      seenIds.add(uniqueId);

      return {
        id: uniqueId,
        url: item.url,
        title: item.title,
        durationSeconds: item.durationSeconds,
        thumbnail: item.thumbnail,
        formatId,
        status: 'pending',
        stage: 'preparing',
        stageMessage: 'Queued',
        isIndeterminate: false,
        percentage: 0,
        downloadedBytes: 0,
        totalBytes: null,
        speedBytesPerSecond: null,
        etaSeconds: null,
      };
    });

    this.items.push(...createdItems);

    if (
      this.status === 'completed' ||
      this.status === 'completed_with_errors' ||
      this.status === 'failed'
    ) {
      this.status = 'processing';
    }

    if (this.zipFilePath && fs.existsSync(this.zipFilePath)) {
      try {
        fs.unlinkSync(this.zipFilePath);
      } catch (err) {
        logger.warn('Error removing old zip file on addItems', { error: String(err) });
      }
      this.zipFilePath = undefined;
      this.zipFileName = undefined;
      this.zipFileSize = undefined;
    }
    this.zipStatus = 'idle';
    this.zipStatusMessage = undefined;

    this.updatedAt = Date.now();
    this.recalculateBatchStatus();
    this.emitter.emit('batch_update', this.toData());

    return createdItems;
  }

  public toData(): BatchJobData {
    let completedItems = 0;
    let failedItems = 0;
    let cancelledItems = 0;

    for (const item of this.items) {
      if (item.status === 'completed') completedItems++;
      else if (item.status === 'failed') failedItems++;
      else if (item.status === 'cancelled') cancelledItems++;
    }

    return {
      batchJobId: this.batchJobId,
      playlistTitle: this.playlistTitle,
      formatId: this.formatId,
      status: this.status,
      totalItems: this.items.length,
      completedItems,
      failedItems,
      cancelledItems,
      overallPercentage: this.getOverallPercentage(),
      items: this.items.map((i) => ({ ...i })),
      zipStatus: this.zipStatus,
      zipStatusMessage: this.zipStatusMessage,
      zipFileName: this.zipFileName,
      zipFileSize: this.zipFileSize,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

class BatchJobRegistryService {
  private jobs = new Map<string, BatchJob>();

  public createBatchJob(
    items: BatchPlaylistItemInput[],
    formatId: string,
    playlistTitle?: string
  ): BatchJob {
    const job = new BatchJob(items, formatId, playlistTitle);
    this.jobs.set(job.batchJobId, job);
    logger.info('Registered new batch job', {
      batchJobId: job.batchJobId,
      totalItems: items.length,
      formatId,
    });
    return job;
  }

  public getBatchJob(batchJobId: string): BatchJob | undefined {
    return this.jobs.get(batchJobId);
  }

  public removeJob(batchJobId: string): void {
    this.jobs.delete(batchJobId);
  }

  public getAllJobs(): BatchJob[] {
    return Array.from(this.jobs.values());
  }

  public getActiveItemCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      count += job.activeProcesses.size;
    }
    return count;
  }

  public shutdownAll(): void {
    logger.info('Shutting down all batch download jobs', { totalJobs: this.jobs.size });
    for (const job of this.jobs.values()) {
      try {
        job.cancelAll();
      } catch (err) {
        logger.warn('Error cancelling batch job during shutdown', {
          batchJobId: job.batchJobId,
          error: String(err),
        });
      }
    }
  }
}

export const batchJobRegistry = new BatchJobRegistryService();
