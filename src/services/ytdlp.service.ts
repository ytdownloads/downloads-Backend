import { spawn } from 'node:child_process';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  ValidatedYouTubeUrl,
  MediaInfoResult,
  SingleVideoMetadata,
  PlaylistMetadata,
  PlaylistItem,
  NormalizedFormat,
} from '../types/media.types.js';

// Maximum buffer for yt-dlp JSON stdout (15 MB to accommodate playlists)
const MAX_STDOUT_BYTES = 15 * 1024 * 1024;

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null || isNaN(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');

  if (hrs > 0) {
    return `${hrs}:${pad(mins)}:${pad(secs)}`;
  }
  return `${mins}:${pad(secs)}`;
}

interface RawThumbnail {
  url?: string;
  height?: number;
  width?: number;
}

interface RawFormat {
  format_id?: string;
  ext?: string;
  resolution?: string;
  height?: number;
  width?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
}

interface RawEntry {
  id?: string;
  title?: string;
  thumbnails?: RawThumbnail[];
  duration?: number;
  url?: string;
  webpage_url?: string;
}

interface RawYtDlpOutput {
  _type?: string;
  id?: string;
  title?: string;
  thumbnail?: string;
  thumbnails?: RawThumbnail[];
  channel?: string;
  uploader?: string;
  channel_id?: string;
  uploader_id?: string;
  duration?: number;
  webpage_url?: string;
  view_count?: number;
  upload_date?: string;
  playlist_count?: number;
  entries?: RawEntry[];
  formats?: RawFormat[];
}

function getBestThumbnail(item: { thumbnail?: string; thumbnails?: RawThumbnail[] }): string {
  if (item.thumbnail) return item.thumbnail;
  if (item.thumbnails && item.thumbnails.length > 0) {
    // Sort descending by resolution (width * height)
    const sorted = [...item.thumbnails].sort((a, b) => {
      const areaA = (a.width || 0) * (a.height || 0);
      const areaB = (b.width || 0) * (b.height || 0);
      return areaB - areaA;
    });
    return sorted[0]?.url || '';
  }
  return '';
}

function normalizeFormats(rawFormats?: RawFormat[]): NormalizedFormat[] {
  if (!rawFormats || !Array.isArray(rawFormats)) {
    return [];
  }

  // Find unique video resolutions and audio streams
  const resolutionMap = new Map<number, NormalizedFormat>();
  let bestAudioFormat: NormalizedFormat | null = null;

  for (const f of rawFormats) {
    const hasVideo = Boolean(f.vcodec && f.vcodec !== 'none');
    const hasAudio = Boolean(f.acodec && f.acodec !== 'none');
    const height = f.height;
    const filesize = f.filesize || f.filesize_approx;

    // Track audio-only option
    if (!hasVideo && hasAudio) {
      if (!bestAudioFormat || (filesize && (!bestAudioFormat.filesize || filesize > bestAudioFormat.filesize))) {
        bestAudioFormat = {
          formatId: 'audio-best',
          ext: f.ext === 'm4a' ? 'm4a' : 'mp3',
          quality: 'Audio Only (Best Quality)',
          hasVideo: false,
          hasAudio: true,
          filesize,
        };
      }
    }

    // Track video resolutions
    if (hasVideo && height && height >= 144) {
      const qualityLabel = `${height}p${f.fps && f.fps > 30 ? f.fps : ''}`;
      const existing = resolutionMap.get(height);

      // Prefer MP4 container or format with known filesize
      if (!existing || (f.ext === 'mp4' && existing.ext !== 'mp4')) {
        resolutionMap.set(height, {
          formatId: `video-${height}p`,
          ext: f.ext || 'mp4',
          quality: qualityLabel,
          height,
          fps: f.fps,
          hasVideo: true,
          hasAudio: true, // Will be merged with best audio during download
          filesize,
        });
      }
    }
  }

  // Sort video resolutions descending (e.g. 1080p, 720p, 480p, etc.)
  const sortedVideoFormats = Array.from(resolutionMap.values()).sort(
    (a, b) => (b.height || 0) - (a.height || 0)
  );

  const result: NormalizedFormat[] = [...sortedVideoFormats];
  if (bestAudioFormat) {
    result.push(bestAudioFormat);
  }

  return result;
}

export class YtDlpService {
  /**
   * Safe execution of yt-dlp with strict argument arrays and process timeouts
   */
  private static executeYtDlp(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      logger.debug('Invoking yt-dlp', { argsCount: args.length });

      const child = spawn('yt-dlp', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      // Enforce timeout
      const timer = setTimeout(() => {
        killed = true;
        logger.warn('yt-dlp process timed out, terminating', {
          timeoutMs: env.INFO_TIMEOUT_MS,
        });
        child.kill('SIGTERM');
        // Force kill after 3 seconds if SIGTERM does not close
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000).unref();
      }, env.INFO_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
          killed = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          return reject(
            new AppError(
              'METADATA_FAILED',
              'Metadata response exceeded allowed size limit.',
              413
            )
          );
        }
        stdout += chunk.toString('utf-8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          return reject(
            new AppError(
              'YTDLP_NOT_AVAILABLE',
              'The yt-dlp media engine is not installed or not found on the server PATH.',
              500
            )
          );
        }
        return reject(
          new AppError('METADATA_FAILED', 'Failed to launch media analysis process.', 500)
        );
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);

        if (killed) {
          return reject(
            new AppError(
              'TIMEOUT',
              'Metadata extraction timed out. The URL may be unreachable or slow to respond.',
              504
            )
          );
        }

        if (code === 0) {
          return resolve(stdout);
        }

        // Map stderr to application-level errors
        const lowerStderr = stderr.toLowerCase();
        logger.warn('yt-dlp exited with non-zero code', { code, stderrSample: lowerStderr.slice(0, 200) });

        if (
          lowerStderr.includes('video unavailable') ||
          lowerStderr.includes('private video') ||
          lowerStderr.includes('this video has been removed') ||
          lowerStderr.includes('not available in your country') ||
          lowerStderr.includes('sign in to confirm your age')
        ) {
          return reject(
            new AppError(
              'VIDEO_UNAVAILABLE',
              'This video is unavailable, private, age-restricted, or removed.',
              404
            )
          );
        }

        if (
          lowerStderr.includes('playlist does not exist') ||
          lowerStderr.includes('the playlist does not exist') ||
          lowerStderr.includes('this playlist is private')
        ) {
          return reject(
            new AppError(
              'PLAYLIST_UNAVAILABLE',
              'This playlist is unavailable, private, or does not exist.',
              404
            )
          );
        }

        if (lowerStderr.includes('incomplete youtube id') || lowerStderr.includes('invalid url')) {
          return reject(
            new AppError('INVALID_URL', 'The YouTube URL is invalid or malformed.', 400)
          );
        }

        return reject(
          new AppError(
            'METADATA_FAILED',
            'Failed to extract metadata for this YouTube link. Please check the URL and try again.',
            400
          )
        );
      });
    });
  }

  /**
   * Main entry point to fetch and normalize metadata for single videos or playlists
   */
  public static async fetchMetadata(
    validated: ValidatedYouTubeUrl
  ): Promise<MediaInfoResult> {
    const startTime = Date.now();
    logger.info(`Starting metadata extraction for type: ${validated.type}`, {
      type: validated.type,
      id: validated.id,
    });

    try {
      let args: string[];

      if (validated.type === 'playlist') {
        // Safe playlist extraction with flat-playlist and limit protection
        args = [
          '--dump-single-json',
          '--flat-playlist',
          '--playlist-end',
          String(env.MAX_PLAYLIST_ITEMS + 1),
          '--no-warnings',
          '--skip-download',
          validated.normalizedUrl,
        ];
      } else {
        // Safe single-video extraction
        args = [
          '--dump-single-json',
          '--no-playlist',
          '--no-warnings',
          '--skip-download',
          validated.normalizedUrl,
        ];
      }

      const rawJson = await this.executeYtDlp(args);
      let parsed: RawYtDlpOutput;

      try {
        parsed = JSON.parse(rawJson);
      } catch (err) {
        logger.error('Failed to parse yt-dlp JSON output', { error: String(err) });
        throw new AppError('METADATA_FAILED', 'Could not parse media metadata.', 500);
      }

      // Check if yt-dlp returned a playlist
      if (parsed._type === 'playlist' || validated.type === 'playlist') {
        return this.normalizePlaylist(parsed, validated);
      }

      // Single video
      return this.normalizeSingleVideo(parsed, validated);
    } finally {
      const duration = Date.now() - startTime;
      logger.info(`Finished metadata extraction for id: ${validated.id} in ${duration}ms`);
    }
  }

  private static normalizeSingleVideo(
    data: RawYtDlpOutput,
    validated: ValidatedYouTubeUrl
  ): SingleVideoMetadata {
    const duration = data.duration || 0;

    return {
      type: 'video',
      id: data.id || validated.id,
      title: data.title || 'Untitled Video',
      thumbnail: getBestThumbnail(data),
      channel: data.channel || data.uploader || 'Unknown Channel',
      channelId: data.channel_id || data.uploader_id,
      duration,
      durationText: formatDuration(duration),
      webpageUrl: data.webpage_url || validated.normalizedUrl,
      viewCount: data.view_count,
      uploadDate: data.upload_date,
      formats: normalizeFormats(data.formats),
    };
  }

  private static normalizePlaylist(
    data: RawYtDlpOutput,
    validated: ValidatedYouTubeUrl
  ): PlaylistMetadata {
    const rawEntries = data.entries || [];
    const totalCount = data.playlist_count || rawEntries.length;

    // Resource protection: check against MAX_PLAYLIST_ITEMS
    if (totalCount > env.MAX_PLAYLIST_ITEMS || rawEntries.length > env.MAX_PLAYLIST_ITEMS) {
      throw new AppError(
        'PLAYLIST_TOO_LARGE',
        `This playlist contains ${totalCount} videos, which exceeds the maximum supported limit of ${env.MAX_PLAYLIST_ITEMS} videos.`,
        400
      );
    }

    const items: PlaylistItem[] = [];
    let index = 1;

    for (const entry of rawEntries) {
      if (!entry || !entry.id) continue;

      const duration = entry.duration || 0;
      items.push({
        id: entry.id,
        title: entry.title || `Video #${index}`,
        thumbnail: getBestThumbnail(entry),
        duration,
        durationText: formatDuration(duration),
        webpageUrl: entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
        index,
      });
      index++;
    }

    return {
      type: 'playlist',
      id: data.id || validated.id,
      title: data.title || 'Untitled Playlist',
      thumbnail: getBestThumbnail(data) || (items[0]?.thumbnail ?? ''),
      channel: data.channel || data.uploader || 'Unknown Channel',
      channelId: data.channel_id || data.uploader_id,
      totalItems: items.length,
      items,
    };
  }
}
