import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { ZipArchive, ArchiverError } from 'archiver';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { BatchJob, batchJobRegistry } from './batchJobRegistry.service.js';
import { BatchItemData } from '../types/download.types.js';
import { sanitizeCleanFilename } from '../utils/filename.js';
import { getCookieArgs, getUserAgentArgs, getPlayerClientArgs } from './ytdlp.service.js';

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
   * Main dispatch loop: schedules pending items STRICTLY SEQUENTIALLY (Concurrency = 1 per batch)
   */
  public dispatch(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const allJobs = batchJobRegistry.getAllJobs();

      for (const batchJob of allJobs) {
        if (batchJob.status === 'cancelled') continue;

        const inFlight = batchJob.items.filter(
          (i) => i.status === 'downloading' || i.status === 'processing'
        ).length;
        const pendingItems = batchJob.items.filter((i) => i.status === 'pending');

        // Check if all items in this batch have finished processing
        if (inFlight === 0 && pendingItems.length === 0) {
          const completedCount = batchJob.items.filter((i) => i.status === 'completed').length;
          if (completedCount > 0 && batchJob.zipStatus === 'idle') {
            void this.generateBatchZip(batchJob);
          }
          continue;
        }

        // MANDATORY: STRICT SEQUENTIAL EXECUTION (Concurrency = 1 per batch)
        // If an item in this batch is already running, NEVER launch another item
        if (inFlight > 0) {
          continue;
        }

        // Pick the first pending item in sequence
        const nextItem = pendingItems[0];
        if (nextItem) {
          const itemIndex = batchJob.items.findIndex((i) => i.id === nextItem.id) + 1;
          const totalItems = batchJob.items.length;

          if (itemIndex === 1) {
            console.log(`\n[QUEUE] Batch started: ${totalItems} items (${batchJob.playlistTitle})`);
          }
          console.log(`[QUEUE] Item ${itemIndex}/${totalItems} started: ${nextItem.title}`);

          this.processItem(batchJob, nextItem, itemIndex, totalItems).catch((err) => {
            logger.error('Unexpected error processing batch item', {
              batchJobId: batchJob.batchJobId,
              itemId: nextItem.id,
              error: String(err),
            });
          });
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Downloads a single item inside a batch job
   */
  private async processItem(
    batchJob: BatchJob,
    item: BatchItemData,
    itemIndex: number,
    totalItems: number
  ): Promise<void> {
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
        '--no-mtime',
        '--buffer-size',
        '1024k',
        '--http-chunk-size',
        '10M',
        '--concurrent-fragments',
        '4',
        '--socket-timeout',
        '15',
        '--retries',
        '3',
        '--fragment-retries',
        '3',
        ...getPlayerClientArgs(),
        '--js-runtimes',
        `node:${process.execPath}`,
        ...getUserAgentArgs(),
        ...getCookieArgs(),
        '--paths',
        `home:${itemDir}`,
        '--output',
        '%(title).100B [%(id)s].%(ext)s',
        '--progress-template',
        'download:download:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s',
      ];

      if (isAudio) {
        args.push(
          '-f',
          'bestaudio/best',
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '0',
          item.url
        );
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
      console.log(`[YT-DLP] Downloading: ${item.title}`);
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
      let lastReportedPct = -1;

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutBuffer += text;

        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const progressPct = this.parseStdoutLine(batchJob, item.id, line, itemIndex);
          if (progressPct !== null && Math.abs(progressPct - lastReportedPct) >= 20) {
            lastReportedPct = progressPct;
            console.log(`[YT-DLP] Progress: ${progressPct}%`);
          }
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
          try {
            await fs.rm(itemDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
          this.next();
          return;
        }

        if (code === 0) {
          await this.handleItemSuccess(batchJob, item.id, itemDir, itemIndex, totalItems);
        } else {
          this.handleItemFailure(batchJob, item.id, code, stderrBuffer, itemIndex, totalItems);
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

  private parseStdoutLine(
    batchJob: BatchJob,
    itemId: string,
    line: string,
    itemIndex: number
  ): number | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Early connection & stream negotiation stages
    if (trimmed.includes('Extracting URL') || trimmed.includes('Downloading webpage')) {
      batchJob.updateItemProgress(itemId, {
        stage: 'preparing',
        stageMessage: 'Resolving YouTube media stream...',
        isIndeterminate: true,
      });
      return null;
    }
    if (trimmed.includes('Downloading android player API JSON') || trimmed.includes('player API JSON')) {
      batchJob.updateItemProgress(itemId, {
        stage: 'preparing',
        stageMessage: 'Connecting to media server...',
        isIndeterminate: true,
      });
      return null;
    }
    if (trimmed.includes('Downloading 1 format') || trimmed.includes('Downloading 2 format')) {
      batchJob.updateItemProgress(itemId, {
        stage: 'preparing',
        stageMessage: 'Negotiating video stream...',
        isIndeterminate: true,
      });
      return null;
    }

    if (trimmed.includes('Destination:')) {
      const lower = trimmed.toLowerCase();
      if (
        lower.includes('.mp4') ||
        lower.includes('.webm') ||
        lower.includes('.mkv') ||
        lower.match(/\.f(394|395|396|397|398|399|137|136|135|134|133|248|247|244|243|242|160|278)\b/)
      ) {
        batchJob.updateItemProgress(itemId, {
          stage: 'downloading_video',
          stageMessage: 'Downloading video stream...',
          isIndeterminate: false,
        });
        return null;
      } else if (
        lower.includes('.m4a') ||
        lower.includes('.opus') ||
        lower.includes('.aac') ||
        lower.includes('.mp3') ||
        lower.match(/\.f(140|251|250|249|139)\b/)
      ) {
        batchJob.updateItemProgress(itemId, {
          stage: 'downloading_audio',
          stageMessage: 'Downloading audio stream...',
          isIndeterminate: false,
        });
        return null;
      }
    }

    let progressLine: string | null = null;
    if (trimmed.startsWith('download:')) {
      progressLine = trimmed.substring(9);
    } else if (/^\d+\|[0-9NA]+\|[0-9.NA]+\|[0-9.NA]+/.test(trimmed)) {
      progressLine = trimmed;
    }

    if (progressLine) {
      const parts = progressLine.split('|');
      const downloadedBytes = parts[0] && parts[0] !== 'NA' ? parseFloat(parts[0]) : null;
      const totalBytes = parts[1] && parts[1] !== 'NA' ? parseFloat(parts[1]) : null;
      const speed = parts[2] && parts[2] !== 'NA' ? parseFloat(parts[2]) : null;
      const eta = parts[3] && parts[3] !== 'NA' ? Math.round(parseFloat(parts[3])) : null;

      let percentage: number | null = null;
      if (downloadedBytes !== null && totalBytes !== null && totalBytes > 0) {
        percentage = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
      }

      batchJob.updateItemProgress(itemId, {
        percentage,
        downloadedBytes,
        totalBytes,
        speedBytesPerSecond: speed,
        etaSeconds: eta,
        isIndeterminate: false,
      });
      return percentage;
    }

    if (trimmed.includes('[Merger]') || trimmed.includes('Merging formats into')) {
      console.log(`[FFMPEG] Processing item ${itemIndex}: Merging video + audio`);
      batchJob.updateItemStatus(itemId, 'processing', undefined, 'merging', 'Merging video and audio with FFmpeg...', true);
      batchJob.updateItemProgress(itemId, {
        isIndeterminate: true,
        speedBytesPerSecond: null,
        etaSeconds: null,
      });
      return null;
    }

    if (trimmed.includes('[ExtractAudio]') || trimmed.includes('[ffmpeg]')) {
      console.log(`[FFMPEG] Processing item ${itemIndex}: Processing audio with FFmpeg`);
      batchJob.updateItemStatus(itemId, 'processing', undefined, 'processing', 'Processing audio with FFmpeg...', true);
      batchJob.updateItemProgress(itemId, {
        isIndeterminate: true,
        speedBytesPerSecond: null,
        etaSeconds: null,
      });
      return null;
    }

    if (trimmed.includes('Deleting original file') || trimmed.includes('Fixup')) {
      batchJob.updateItemStatus(itemId, 'processing', undefined, 'finalizing', 'Finalizing file...', true);
      batchJob.updateItemProgress(itemId, {
        isIndeterminate: true,
        speedBytesPerSecond: null,
        etaSeconds: null,
      });
      return null;
    }

    return null;
  }

  private async handleItemSuccess(
    batchJob: BatchJob,
    itemId: string,
    itemDir: string,
    itemIndex: number,
    totalItems: number
  ): Promise<void> {
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
        console.log(`[QUEUE] Item ${itemIndex}/${totalItems} failed: Output file missing`);
        return;
      }

      const chosenFileName = mediaFiles[0];
      const filePath = path.join(itemDir, chosenFileName);
      const stat = await fs.stat(filePath);
      const item = batchJob.getItem(itemId);
      const ext = path.extname(chosenFileName);
      const cleanFileName = sanitizeCleanFilename(item?.title || chosenFileName, ext);

      logger.info('Batch item completed', {
        batchJobId: batchJob.batchJobId,
        itemId,
        fileName: cleanFileName,
        fileSize: stat.size,
      });

      console.log(`[QUEUE] Item ${itemIndex}/${totalItems} completed: ${cleanFileName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      batchJob.completeItem(itemId, filePath, cleanFileName, stat.size);
    } catch (err) {
      logger.error('Error verifying completed batch item file', {
        batchJobId: batchJob.batchJobId,
        itemId,
        error: String(err),
      });
      batchJob.failItem(itemId, 'DOWNLOAD_FAILED', 'Failed to inspect completed file.');
      console.log(`[QUEUE] Item ${itemIndex}/${totalItems} failed: Inspection error`);
    }
  }

  private handleItemFailure(
    batchJob: BatchJob,
    itemId: string,
    code: number | null,
    stderr: string,
    itemIndex: number,
    totalItems: number
  ): void {
    const lowerStderr = stderr.toLowerCase();
    logger.warn('Batch item failed', {
      batchJobId: batchJob.batchJobId,
      itemId,
      code,
      stderrSample: lowerStderr.slice(0, 300),
    });

    console.log(`[QUEUE] Item ${itemIndex}/${totalItems} failed (exit code: ${code})`);

    if (lowerStderr.includes('video unavailable') || lowerStderr.includes('private video')) {
      batchJob.failItem(itemId, 'VIDEO_UNAVAILABLE', 'Video is unavailable or private.');
      return;
    }

    if (
      lowerStderr.includes('sign in to confirm your age') ||
      lowerStderr.includes('confirm your age') ||
      lowerStderr.includes('age-restricted')
    ) {
      batchJob.failItem(itemId, 'AGE_RESTRICTED', 'This video is age-restricted and requires sign-in.');
      return;
    }

    if (
      lowerStderr.includes('sign in to confirm you’re not a bot') ||
      lowerStderr.includes('sign in to confirm you\'re not a bot') ||
      lowerStderr.includes('bot detection') ||
      lowerStderr.includes('automated queries')
    ) {
      batchJob.failItem(
        itemId,
        'BOT_DETECTION_BLOCKED',
        'YouTube is temporarily blocking this server from accessing the video. Please try again later.'
      );
      return;
    }

    if (lowerStderr.includes('http error 403') || lowerStderr.includes('403: forbidden')) {
      batchJob.failItem(
        itemId,
        'DOWNLOAD_FORBIDDEN',
        'YouTube is temporarily blocking direct streaming for this video on the server. Please try again later.'
      );
      return;
    }

    if (lowerStderr.includes('ffmpeg') || lowerStderr.includes('conversion failed')) {
      batchJob.failItem(itemId, 'FFMPEG_FAILED', 'Media stream merging failed.');
      return;
    }

    batchJob.failItem(itemId, 'DOWNLOAD_FAILED', 'Failed to complete video download.');
  }

  /**
   * Generates a single ZIP containing all successfully completed files in the batch
   */
  private async generateBatchZip(batchJob: BatchJob): Promise<void> {
    if (batchJob.zipStatus !== 'idle') return;

    const completedItems = batchJob.items.filter(
      (item) => item.status === 'completed' && item.filePath && existsSync(item.filePath)
    );

    if (completedItems.length === 0) {
      return;
    }

    const cleanPlaylistTitle = sanitizeCleanFilename(batchJob.playlistTitle || 'Playlist', '.zip');
    const zipFileName = `YTdownloader - ${cleanPlaylistTitle}`;
    const zipFilePath = path.join(batchJob.tempDir, zipFileName);

    console.log(`\n[ZIP] Creating ZIP for batch ${batchJob.batchJobId.slice(0, 8)} (${completedItems.length} completed videos)...`);
    batchJob.updateZipStatus('creating', `Creating ZIP (${completedItems.length} videos)...`);

    try {
      const outputStream = createWriteStream(zipFilePath);
      const archive = new ZipArchive({ zlib: { level: 0 } });

      await new Promise<void>((resolve, reject) => {
        outputStream.on('close', () => {
          resolve();
        });

        outputStream.on('error', (err) => {
          reject(err);
        });

        archive.on('warning', (err: ArchiverError) => {
          logger.warn('Archiver warning', { error: err.message });
        });

        archive.on('error', (err: ArchiverError) => {
          reject(err);
        });

        archive.pipe(outputStream);

        completedItems.forEach((item, index) => {
          if (!item.filePath) return;
          const ext = path.extname(item.filePath);
          const indexNum = String(index + 1).padStart(2, '0');
          const cleanItemTitle = sanitizeCleanFilename(item.title || `video_${index + 1}`, ext);
          const entryName = `${indexNum} - ${cleanItemTitle}`;
          archive.file(item.filePath, { name: entryName });
        });

        batchJob.updateZipStatus('finalizing', 'Finalizing ZIP archive...');
        console.log(`[ZIP] Finalizing ZIP for batch ${batchJob.batchJobId.slice(0, 8)}...`);

        void archive.finalize();
      });

      const stat = await fs.stat(zipFilePath);
      batchJob.updateZipStatus('ready', '✓ ZIP Ready', zipFilePath, zipFileName, stat.size);
      console.log(`[ZIP] Batch ${batchJob.batchJobId.slice(0, 8)} ZIP ready: ${(stat.size / 1024 / 1024).toFixed(2)} MB (${zipFileName})\n`);
    } catch (err) {
      console.error(`[ZIP] Error creating ZIP archive for batch ${batchJob.batchJobId}:`, err);
      logger.error('Error generating batch ZIP', {
        batchJobId: batchJob.batchJobId,
        error: String(err),
      });
      batchJob.updateZipStatus('failed', 'Failed to generate ZIP archive.');
    }
  }

  public async cancelItem(batchJobId: string, itemId: string): Promise<void> {
    const job = batchJobRegistry.getBatchJob(batchJobId);
    if (!job) return;

    const item = job.getItem(itemId);
    if (!item || item.status === 'cancelled') return;

    const wasActive = item.status === 'downloading' || item.status === 'processing';
    const wasPending = item.status === 'pending';

    logger.info('Cancelling individual batch item', { batchJobId, itemId, status: item.status });
    job.cancelItem(itemId);

    // Clean up temporary files for this item
    const itemDir = path.join(job.tempDir, itemId);
    try {
      await fs.rm(itemDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('Failed to clean item temp directory on cancel', { itemDir, error: String(err) });
    }

    // If an active or pending item was cancelled, advance queue
    if (wasActive || wasPending) {
      this.dispatch();
    }
  }

  public cancelBatch(batchJobId: string): void {
    const job = batchJobRegistry.getBatchJob(batchJobId);
    if (!job) return;
    job.cancelAll();
    this.dispatch();
  }

  public retryBatch(batchJobId: string): void {
    const job = batchJobRegistry.getBatchJob(batchJobId);
    if (!job) return;
    job.retryFailed();
    this.dispatch();
  }

  public resumeBatch(batchJobId: string): void {
    const job = batchJobRegistry.getBatchJob(batchJobId);
    if (!job) return;
    this.dispatch();
  }
}

export const playlistQueue = new PlaylistQueueService();
