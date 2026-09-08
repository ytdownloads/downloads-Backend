import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { BatchJob, batchJobRegistry } from './batchJobRegistry.service.js';
import { jobRegistry } from './jobRegistry.service.js';
import { BatchItemData } from '../types/download.types.js';

const VALID_VIDEO_FORMAT_REGEX = /^video-(\d{3,4})p$/;

export class PlaylistQueueService {
  private isProcessing = false;

  /**
   * Enqueues a batch job and initiates queue processing
   */
  public enqueue(batchJob: BatchJob): void {
    logger.info('Batch enqueued for processing', {
      batchJobId: batchJob.batchJobId,
      totalItems: batchJob.items.length,
    });
    this.dispatch();
  }

  /**
   * Main dispatch loop: schedules pending items up to DOWNLOAD_CONCURRENCY
   */
  public dispatch(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const concurrencyLimit = env.DOWNLOAD_CONCURRENCY;

      // Count single video active jobs + batch active processes
      const singleActive = jobRegistry.getActiveJobCount();
      const batchActive = batchJobRegistry.getActiveItemCount();
      let totalActive = singleActive + batchActive;

      if (totalActive >= concurrencyLimit) {
        return;
      }

      const allJobs = batchJobRegistry.getAllJobs();

      for (const batchJob of allJobs) {
        if (batchJob.status === 'cancelled') continue;

        for (const item of batchJob.items) {
          if (totalActive >= concurrencyLimit) break;

          if (item.status === 'pending') {
            totalActive++;
            // Launch item download asynchronously without blocking the loop
            this.processItem(batchJob, item).catch((err) => {
              logger.error('Unexpected error processing batch item', {
                batchJobId: batchJob.batchJobId,
                itemId: item.id,
                error: String(err),
              });
            });
          }
        }

        if (totalActive >= concurrencyLimit) break;
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Downloads a single item inside a batch job
   */
  private async processItem(batchJob: BatchJob, item: BatchItemData): Promise<void> {
    const itemDir = path.join(batchJob.tempDir, item.id);

    try {
      await fs.mkdir(itemDir, { recursive: true });

      const isAudio = item.formatId === 'audio-best';
      const isVideo = VALID_VIDEO_FORMAT_REGEX.test(item.formatId);

      const args: string[] = [
        '--newline',
        '--no-playlist',
        '--windows-filenames',
        '--no-warnings',
        '--paths',
        `home:${itemDir}`,
        '--output',
        '%(title).100B [%(id)s].%(ext)s',
        '--progress-template',
        'download:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s',
      ];

      if (isAudio) {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', item.url);
      } else if (isVideo) {
        const match = item.formatId.match(VALID_VIDEO_FORMAT_REGEX);
        const height = match ? parseInt(match[1], 10) : 1080;
        args.push(
          '-f',
          `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
          '--merge-output-format',
          'mp4',
          item.url
        );
      } else {
        // Fallback standard video
        args.push(
          '-f',
          'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          '--merge-output-format',
          'mp4',
          item.url
        );
      }

      batchJob.updateItemStatus(item.id, 'downloading');
      logger.info('Spawning yt-dlp for batch item', {
        batchJobId: batchJob.batchJobId,
        itemId: item.id,
        url: item.url,
      });

      const child: ChildProcess = spawn('yt-dlp', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      batchJob.activeProcesses.set(item.id, child);

      // Child execution timeout
      const timeoutTimer = setTimeout(() => {
        if (item.status === 'downloading' || item.status === 'processing') {
          logger.warn('Batch item download timed out', {
            batchJobId: batchJob.batchJobId,
            itemId: item.id,
          });
          batchJob.failItem(item.id, 'DOWNLOAD_TIMEOUT', 'Download timed out.');
          child.kill('SIGTERM');
        }
      }, env.DOWNLOAD_TIMEOUT_MS);

      let stdoutBuffer = '';
      let stderrBuffer = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutBuffer += text;

        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          this.parseStdoutLine(batchJob, item.id, line);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString('utf-8');
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeoutTimer);
        logger.error('Batch item child process error', {
          batchJobId: batchJob.batchJobId,
          itemId: item.id,
          error: err.message,
        });
        batchJob.failItem(item.id, 'DOWNLOAD_FAILED', 'Media downloader process encountered an execution error.');
        this.next();
      });

      child.on('close', async (code: number | null) => {
        clearTimeout(timeoutTimer);

        if (item.status === 'cancelled' || batchJob.status === 'cancelled') {
          logger.info('Item closed after cancellation', {
            batchJobId: batchJob.batchJobId,
            itemId: item.id,
          });
          this.next();
          return;
        }

        if (code === 0) {
          await this.handleItemSuccess(batchJob, item.id, itemDir);
        } else {
          this.handleItemFailure(batchJob, item.id, code, stderrBuffer);
        }

        this.next();
      });
    } catch (err) {
      logger.error('Failed to launch batch item download', {
        batchJobId: batchJob.batchJobId,
        itemId: item.id,
        error: String(err),
      });
      batchJob.failItem(item.id, 'DOWNLOAD_FAILED', 'Failed to initialize item download.');
      this.next();
    }
  }

  private next(): void {
    // Trigger next items in queue
    setImmediate(() => {
      this.dispatch();
    });
  }

  private parseStdoutLine(batchJob: BatchJob, itemId: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('download:')) {
      const parts = trimmed.substring(9).split('|');
      const downloadedBytes = parts[0] && parts[0] !== 'NA' ? parseFloat(parts[0]) : null;
      const totalBytes = parts[1] && parts[1] !== 'NA' ? parseFloat(parts[1]) : null;
      const speed = parts[2] && parts[2] !== 'NA' ? parseFloat(parts[2]) : null;
      const eta = parts[3] && parts[3] !== 'NA' ? Math.round(parseFloat(parts[3])) : null;

      let percentage: number | null = null;
      if (downloadedBytes !== null && totalBytes !== null && totalBytes > 0) {
        percentage = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
      }

      batchJob.updateItemProgress(itemId, {
        percentage,
        downloadedBytes,
        totalBytes,
        speedBytesPerSecond: speed,
        etaSeconds: eta,
      });
      return;
    }

    if (
      trimmed.includes('[Merger]') ||
      trimmed.includes('[ExtractAudio]') ||
      trimmed.includes('Destination:') ||
      trimmed.includes('Fixup')
    ) {
      batchJob.updateItemStatus(itemId, 'processing');
      batchJob.updateItemProgress(itemId, {
        percentage: 99,
        etaSeconds: null,
      });
    }
  }

  private async handleItemSuccess(batchJob: BatchJob, itemId: string, itemDir: string): Promise<void> {
    try {
      const files = await fs.readdir(itemDir);
      const mediaFiles = files.filter((f) => {
        const lower = f.toLowerCase();
        return (
          (lower.endsWith('.mp4') ||
            lower.endsWith('.mp3') ||
            lower.endsWith('.m4a') ||
            lower.endsWith('.webm') ||
            lower.endsWith('.mkv')) &&
          !lower.endsWith('.part') &&
          !lower.endsWith('.ytdl')
        );
      });

      if (mediaFiles.length === 0) {
        logger.error('No output file found for batch item', {
          batchJobId: batchJob.batchJobId,
          itemId,
          files,
        });
        batchJob.failItem(itemId, 'DOWNLOAD_FAILED', 'Output file could not be found.');
        return;
      }

      const chosenFileName = mediaFiles[0];
      const filePath = path.join(itemDir, chosenFileName);
      const stat = await fs.stat(filePath);

      logger.info('Batch item completed', {
        batchJobId: batchJob.batchJobId,
        itemId,
        fileName: chosenFileName,
        fileSize: stat.size,
      });

      batchJob.completeItem(itemId, filePath, chosenFileName, stat.size);
    } catch (err) {
      logger.error('Error verifying completed batch item file', {
        batchJobId: batchJob.batchJobId,
        itemId,
        error: String(err),
      });
      batchJob.failItem(itemId, 'DOWNLOAD_FAILED', 'Failed to inspect completed file.');
    }
  }

  private handleItemFailure(
    batchJob: BatchJob,
    itemId: string,
    code: number | null,
    stderr: string
  ): void {
    const lowerStderr = stderr.toLowerCase();
    logger.warn('Batch item failed', {
      batchJobId: batchJob.batchJobId,
      itemId,
      code,
      stderrSample: lowerStderr.slice(0, 300),
    });

    if (lowerStderr.includes('video unavailable') || lowerStderr.includes('private video')) {
      batchJob.failItem(itemId, 'VIDEO_UNAVAILABLE', 'Video is unavailable or private.');
      return;
    }

    if (lowerStderr.includes('ffmpeg') || lowerStderr.includes('conversion failed')) {
      batchJob.failItem(itemId, 'FFMPEG_FAILED', 'Media stream merging failed.');
      return;
    }

    batchJob.failItem(itemId, 'DOWNLOAD_FAILED', 'Failed to complete video download.');
  }

  public cancelBatch(batchJobId: string): void {
    const job = batchJobRegistry.getBatchJob(batchJobId);
    if (!job) return;
    job.cancelAll();
    this.next();
  }

  public retryBatch(batchJobId: string): void {
    const job = batchJobRegistry.getBatchJob(batchJobId);
    if (!job) return;
    job.retryFailed();
    this.dispatch();
  }
}

export const playlistQueue = new PlaylistQueueService();
