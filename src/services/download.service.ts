import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { validateYouTubeUrl } from './urlValidation.service.js';
import { jobRegistry, DownloadJob } from './jobRegistry.service.js';
import { sanitizeCleanFilename } from '../utils/filename.js';
import { metadataCache, getCookieArgs, getUserAgentArgs, getPlayerClientArgs, recordBotBlock } from './ytdlp.service.js';

const VALID_VIDEO_FORMAT_REGEX = /^video-(\d{3,4})p$/;

export class DownloadService {
  /**
   * Starts a real background download job with yt-dlp and FFmpeg
   */
  public static async startDownload(
    url: string,
    formatId: string
  ): Promise<DownloadJob> {
    // 1. URL verification
    const validated = validateYouTubeUrl(url);
    if (validated.type !== 'video') {
      throw new AppError(
        'INVALID_REQUEST',
        'Single video downloader accepts video URLs only.',
        400
      );
    }

    // 2. Format ID verification (reject arbitrary client strings)
    const isAudio = formatId === 'audio-best';
    const isVideo = VALID_VIDEO_FORMAT_REGEX.test(formatId);

    if (!isAudio && !isVideo) {
      throw new AppError(
        'FORMAT_UNAVAILABLE',
        'Invalid or unsupported format selection.',
        400
      );
    }

    // Check if canonical URL is cached from metadata extraction
    const cachedMeta = metadataCache.get(`video:${validated.id}`);
    const downloadUrl =
      cachedMeta && cachedMeta.type === 'video' && cachedMeta.webpageUrl
        ? cachedMeta.webpageUrl
        : validated.normalizedUrl;

    // 3. Create job in registry (handles concurrency limits)
    const job = jobRegistry.createJob(downloadUrl, formatId);

    // 4. Ensure temporary job directory exists
    await fs.mkdir(job.tempDir, { recursive: true });

    // 5. Construct safe yt-dlp arguments array (NO shell execution)
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
      ...getPlayerClientArgs(),
      '--remote-components',
      'ejs:github',
      '--js-runtimes',
      `node:${process.execPath}`,
      ...getUserAgentArgs(),
      ...getCookieArgs(),
      '--paths',
      `home:${job.tempDir}`,
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
        validated.normalizedUrl
      );
    } else {
      const match = formatId.match(VALID_VIDEO_FORMAT_REGEX);
      const height = match ? parseInt(match[1], 10) : 1080;
      args.push(
        '-f',
        `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
        '--merge-output-format',
        'mp4',
        validated.normalizedUrl
      );
    }

    // 6. Launch download process in background
    this.executeDownloadProcess(job, args);

    return job;
  }

  private static executeDownloadProcess(job: DownloadJob, args: string[]): void {
    job.updateStatus('preparing', 'preparing', 'Connecting to media server...', true);
    logger.info('Spawning yt-dlp download process', { jobId: job.jobId });

    let child;
    try {
      child = spawn('yt-dlp', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.childProcess = child;
    } catch (err) {
      logger.error('Failed to spawn yt-dlp download process', { error: String(err) });
      job.fail('DOWNLOAD_FAILED', 'Failed to launch media download process.');
      return;
    }

    // Enforce overall download process timeout
    const timeoutTimer = setTimeout(() => {
      if (job.status !== 'completed' && job.status !== 'cancelled') {
        logger.warn('Download job timed out', { jobId: job.jobId });
        job.fail('DOWNLOAD_TIMEOUT', 'Download timed out. The file may be too large or connection too slow.');
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child && !child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000).unref();
      }
    }, env.DOWNLOAD_TIMEOUT_MS);

    let stdoutBuffer = '';
    let stderrBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdoutBuffer += text;

      // Extract lines from buffer
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        this.parseStdoutLine(job, line);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf-8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutTimer);
      logger.error('yt-dlp child process error', { error: err.message, code: err.code });
      if (err.code === 'ENOENT') {
        job.fail('YTDLP_NOT_AVAILABLE', 'Media engine (yt-dlp) is not installed on the server.');
      } else {
        job.fail('DOWNLOAD_FAILED', 'Media downloader process encountered an execution error.');
      }
    });

    child.on('close', async (code: number | null) => {
      clearTimeout(timeoutTimer);

      if (job.status === 'cancelled') {
        logger.info('Download process closed after cancellation', { jobId: job.jobId });
        return;
      }

      if (code === 0) {
        await this.handleDownloadSuccess(job);
      } else {
        this.handleDownloadFailure(job, code, stderrBuffer);
      }
    });
  }

  private static parseStdoutLine(job: DownloadJob, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Early connection & stream negotiation stages
    if (trimmed.includes('Extracting URL') || trimmed.includes('Downloading webpage')) {
      job.updateStatus('preparing', 'preparing', 'Resolving YouTube media stream...', true);
      return;
    }
    if (trimmed.includes('Downloading android player API JSON') || trimmed.includes('player API JSON')) {
      job.updateStatus('preparing', 'preparing', 'Connecting to media server...', true);
      return;
    }
    if (trimmed.includes('Downloading 1 format') || trimmed.includes('Downloading 2 format')) {
      job.updateStatus('preparing', 'preparing', 'Negotiating video stream...', true);
      return;
    }

    // Detect stream destination to distinguish video vs audio download stages
    if (trimmed.includes('Destination:')) {
      const lower = trimmed.toLowerCase();
      if (
        lower.includes('.mp4') ||
        lower.includes('.webm') ||
        lower.includes('.mkv') ||
        lower.match(/\.f(394|395|396|397|398|399|137|136|135|134|133|248|247|244|243|242|160|278)\b/)
      ) {
        job.updateStatus('downloading', 'downloading_video', 'Downloading video stream...', false);
        return;
      } else if (
        lower.includes('.m4a') ||
        lower.includes('.opus') ||
        lower.includes('.aac') ||
        lower.includes('.mp3') ||
        lower.match(/\.f(140|251|250|249|139)\b/)
      ) {
        job.updateStatus('downloading', 'downloading_audio', 'Downloading audio stream...', false);
        return;
      } else if (job.formatId === 'audio-best') {
        job.updateStatus('downloading', 'downloading_audio', 'Downloading audio stream...', false);
        return;
      } else {
        job.updateStatus('downloading', 'downloading_video', 'Downloading video stream...', false);
        return;
      }
    }

    // Real progress template line: download:bytes|total|speed|eta OR bytes|total|speed|eta
    let progressLine: string | null = null;
    if (trimmed.startsWith('download:')) {
      progressLine = trimmed.substring(9);
    } else if (/^\d+\|[0-9NA]+\|[0-9.NA]+\|[0-9.NA]+/.test(trimmed)) {
      progressLine = trimmed;
    }

    if (progressLine) {
      if (job.status === 'preparing') {
        const initialStage = job.formatId === 'audio-best' ? 'downloading_audio' : 'downloading_video';
        const initialMsg = job.formatId === 'audio-best' ? 'Downloading audio stream...' : 'Downloading video stream...';
        job.updateStatus('downloading', initialStage, initialMsg, false);
      }

      const parts = progressLine.split('|');
      const downloadedBytes = parts[0] && parts[0] !== 'NA' ? parseFloat(parts[0]) : null;
      const totalBytes = parts[1] && parts[1] !== 'NA' ? parseFloat(parts[1]) : null;
      const speed = parts[2] && parts[2] !== 'NA' ? parseFloat(parts[2]) : null;
      const eta = parts[3] && parts[3] !== 'NA' ? Math.round(parseFloat(parts[3])) : null;

      let percentage: number | null = null;
      if (downloadedBytes !== null && totalBytes !== null && totalBytes > 0) {
        percentage = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
      }

      job.updateProgress({
        isIndeterminate: false,
        percentage,
        downloadedBytes,
        totalBytes,
        speedBytesPerSecond: speed,
        etaSeconds: eta,
      });
      return;
    }

    // Check for FFmpeg merger
    if (trimmed.includes('[Merger]') || trimmed.includes('Merging formats into')) {
      job.updateStatus('processing', 'merging', 'Merging video and audio with FFmpeg...', true);
      job.updateProgress({
        isIndeterminate: true,
        speedBytesPerSecond: null,
        etaSeconds: null,
      });
      return;
    }

    // Check for audio extraction or conversion
    if (trimmed.includes('[ExtractAudio]') || trimmed.includes('[ffmpeg]')) {
      job.updateStatus('processing', 'processing', 'Processing audio with FFmpeg...', true);
      job.updateProgress({
        isIndeterminate: true,
        speedBytesPerSecond: null,
        etaSeconds: null,
      });
      return;
    }

    // Check for finalizing / deleting intermediate files
    if (trimmed.includes('Deleting original file') || trimmed.includes('Fixup')) {
      job.updateStatus('processing', 'finalizing', 'Finalizing media file...', true);
      job.updateProgress({
        isIndeterminate: true,
        speedBytesPerSecond: null,
        etaSeconds: null,
      });
      return;
    }
  }

  private static async handleDownloadSuccess(job: DownloadJob): Promise<void> {
    try {
      // Find the generated media file in the job's temporary directory
      const files = await fs.readdir(job.tempDir);
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
        logger.error('yt-dlp exited cleanly but no output media file was found in tempDir', {
          jobId: job.jobId,
          files,
        });
        job.fail('DOWNLOAD_FAILED', 'Output file could not be verified after download.');
        return;
      }

      const chosenFileName = mediaFiles[0];
      const filePath = path.join(job.tempDir, chosenFileName);
      const stat = await fs.stat(filePath);
      const ext = path.extname(chosenFileName);
      const cleanFileName = sanitizeCleanFilename(job.title || chosenFileName, ext);

      logger.info('Download job completed successfully', {
        jobId: job.jobId,
        fileName: cleanFileName,
        fileSize: stat.size,
      });

      job.complete(filePath, cleanFileName, stat.size);
    } catch (err) {
      logger.error('Error verifying completed file', { error: String(err) });
      job.fail('DOWNLOAD_FAILED', 'Failed to inspect completed download file.');
    }
  }

  private static handleDownloadFailure(
    job: DownloadJob,
    code: number | null,
    stderr: string
  ): void {
    const lowerStderr = stderr.toLowerCase();
    logger.warn('yt-dlp download failed with non-zero exit code', {
      jobId: job.jobId,
      code,
      stderrSample: lowerStderr.slice(0, 300),
    });

    if (
      lowerStderr.includes('sign in to confirm your age') ||
      lowerStderr.includes('confirm your age') ||
      lowerStderr.includes('age-restricted')
    ) {
      job.fail(
        'AGE_RESTRICTED',
        'This video is age-restricted and requires sign-in.'
      );
      return;
    }

    if (
      lowerStderr.includes('sign in to confirm you’re not a bot') ||
      lowerStderr.includes('sign in to confirm you\'re not a bot') ||
      lowerStderr.includes('bot detection') ||
      lowerStderr.includes('automated queries')
    ) {
      recordBotBlock();
      logger.warn('Download blocked by YouTube bot detection. Note for deployment owner: YOUTUBE_COOKIES can be configured on Render.', {
        jobId: job.jobId,
      });
      job.fail(
        'BOT_DETECTION_BLOCKED',
        'YouTube is temporarily blocking this server from accessing the video. Please try again later.'
      );
      return;
    }

    if (lowerStderr.includes('http error 403') || lowerStderr.includes('403: forbidden')) {
      logger.warn('Download throttled by YouTube direct streaming restrictions (403 Forbidden). Note for deployment owner: YOUTUBE_COOKIES can be configured on Render.', {
        jobId: job.jobId,
      });
      job.fail(
        'DOWNLOAD_FORBIDDEN',
        'YouTube is temporarily blocking direct streaming for this video on the server. Please try again later.'
      );
      return;
    }

    if (lowerStderr.includes('ffmpeg') || lowerStderr.includes('conversion failed')) {
      job.fail('FFMPEG_FAILED', 'Media conversion / stream merging failed.', { stderrSample: lowerStderr.slice(0, 500) });
      return;
    }

    if (
      lowerStderr.includes('video unavailable') ||
      lowerStderr.includes('is unavailable') ||
      lowerStderr.includes('private video') ||
      lowerStderr.includes('removed')
    ) {
      job.fail('VIDEO_UNAVAILABLE', 'This video is private, unavailable, or restricted.', { stderrSample: lowerStderr.slice(0, 500) });
      return;
    }

    job.fail('DOWNLOAD_FAILED', 'Failed to complete video download. Please try again.', { stderrSample: lowerStderr.slice(0, 500) });
  }
}
