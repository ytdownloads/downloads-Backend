import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  BatchStatus,
  PlaylistItemStatus,
  BatchItemData,
  BatchJobData,
  BatchPlaylistItemInput,
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

    this.items = items.map((item) => ({
      id: item.id,
      url: item.url,
      title: item.title,
      durationSeconds: item.durationSeconds,
      thumbnail: item.thumbnail,
      formatId,
      status: 'pending',
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
    }));

    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  public getItem(itemId: string): BatchItemData | undefined {
    return this.items.find((i) => i.id === itemId);
  }

  public updateItemStatus(itemId: string, status: PlaylistItemStatus, error?: { code: string; message: string }): void {
    const item = this.getItem(itemId);
    if (!item) return;

    item.status = status;
    if (error) {
      item.error = error;
    }
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

    this.updatedAt = Date.now();
    this.recalculateBatchStatus();
    this.emitter.emit('item_progress', { itemId, item, batch: this.toData() });
  }

  public completeItem(itemId: string, filePath: string, fileName: string, fileSize: number): void {
    const item = this.getItem(itemId);
    if (!item) return;

    item.status = 'completed';
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
    if (!item || item.status === 'completed' || item.status === 'cancelled') return;

    item.status = 'cancelled';
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

  public cancelAll(): void {
    logger.info('Cancelling batch job', { batchJobId: this.batchJobId });
    this.status = 'cancelled';

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
        } else if (failed === total) {
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
