import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { JobStatus, DownloadProgress, DownloadJobData } from '../types/download.types.js';
import { CleanupService } from './cleanup.service.js';

export class DownloadJob {
  public readonly jobId: string;
  public readonly url: string;
  public readonly formatId: string;
  public title: string;
  public status: JobStatus;
  public progress: DownloadProgress;
  public readonly tempDir: string;
  public outputFilePath?: string;
  public fileName?: string;
  public fileSize?: number;
  public error?: { code: string; message: string };
  public childProcess?: ChildProcess;
  public readonly createdAt: number;
  public updatedAt: number;
  public readonly emitter: EventEmitter;
  private cleanupTimeout?: NodeJS.Timeout;

  constructor(url: string, formatId: string, title?: string) {
    this.jobId = crypto.randomUUID();
    this.url = url;
    this.formatId = formatId;
    this.title = title || 'YouTube Video';
    this.status = 'created';
    this.progress = {
      status: 'created',
      percentage: 0,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
    };
    this.tempDir = path.join(path.resolve(env.TEMP_DIR), this.jobId);
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);
  }

  public updateStatus(status: JobStatus): void {
    this.status = status;
    this.progress.status = status;
    this.updatedAt = Date.now();
    this.emitter.emit('status', status);
  }

  public updateProgress(progressUpdate: Partial<DownloadProgress>): void {
    this.progress = {
      ...this.progress,
      ...progressUpdate,
    };
    this.updatedAt = Date.now();
    this.emitter.emit('progress', this.progress);
  }

  public complete(filePath: string, fileName: string, fileSize: number): void {
    this.outputFilePath = filePath;
    this.fileName = fileName;
    this.fileSize = fileSize;
    this.updateStatus('completed');
    this.updateProgress({
      percentage: 100,
      downloadedBytes: fileSize,
      totalBytes: fileSize,
      etaSeconds: 0,
    });
    this.emitter.emit('completed', this.toData());

    // Schedule cleanup of temporary files after delay
    this.scheduleCleanup(env.JOB_CLEANUP_DELAY_MS);
  }

  public fail(code: string, message: string): void {
    this.error = { code, message };
    this.updateStatus('failed');
    this.emitter.emit('error', this.error);

    // Immediate cleanup on failure
    void CleanupService.cleanupJobDir(this.tempDir);
  }

  public cancel(): void {
    if (this.status === 'completed' || this.status === 'cancelled') return;

    logger.info('Cancelling download job', { jobId: this.jobId });
    this.updateStatus('cancelled');

    // Terminate child process safely
    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.childProcess.kill('SIGTERM');
        setTimeout(() => {
          if (this.childProcess && !this.childProcess.killed) {
            this.childProcess.kill('SIGKILL');
          }
        }, 2000).unref();
      } catch (err) {
        logger.warn('Error killing child process during cancellation', { error: String(err) });
      }
    }

    this.emitter.emit('cancelled');

    // Clean up temporary files
    void CleanupService.cleanupJobDir(this.tempDir);
  }

  public scheduleCleanup(delayMs: number): void {
    if (this.cleanupTimeout) clearTimeout(this.cleanupTimeout);
    this.cleanupTimeout = setTimeout(() => {
      void CleanupService.cleanupJobDir(this.tempDir);
      jobRegistry.removeJob(this.jobId);
    }, delayMs);
    this.cleanupTimeout.unref();
  }

  public toData(): DownloadJobData {
    return {
      jobId: this.jobId,
      url: this.url,
      title: this.title,
      formatId: this.formatId,
      status: this.status,
      progress: this.progress,
      fileName: this.fileName,
      fileSize: this.fileSize,
      error: this.error,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

class JobRegistryService {
  private jobs = new Map<string, DownloadJob>();

  public createJob(url: string, formatId: string, title?: string): DownloadJob {
    const activeCount = this.getActiveJobCount();
    if (activeCount >= env.DOWNLOAD_CONCURRENCY) {
      throw new AppError(
        'RESOURCE_LIMIT',
        `Server download limit reached (${env.DOWNLOAD_CONCURRENCY} concurrent downloads). Please wait a moment and try again.`,
        429
      );
    }

    const job = new DownloadJob(url, formatId, title);
    this.jobs.set(job.jobId, job);
    logger.info('Registered new download job', { jobId: job.jobId, formatId });
    return job;
  }

  public getJob(jobId: string): DownloadJob | undefined {
    return this.jobs.get(jobId);
  }

  public removeJob(jobId: string): void {
    this.jobs.delete(jobId);
  }

  public getActiveJobCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (
        job.status === 'preparing' ||
        job.status === 'downloading' ||
        job.status === 'processing'
      ) {
        count++;
      }
    }
    return count;
  }

  public shutdownAll(): void {
    logger.info('Shutting down all single download jobs', { totalJobs: this.jobs.size });
    for (const job of this.jobs.values()) {
      try {
        job.cancel();
      } catch (err) {
        logger.warn('Error cancelling job during shutdown', { jobId: job.jobId, error: String(err) });
      }
    }
  }
}

export const jobRegistry = new JobRegistryService();
