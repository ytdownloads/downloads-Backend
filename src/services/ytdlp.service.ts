import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/**
 * Generates --cookies argument if YOUTUBE_COOKIES environment variable is provided
 */
export function getCookieArgs(): string[] {
  const cookies = env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIES;
  if (!cookies || !cookies.trim()) {
    return [];
  }
  const cookieFilePath = path.join(os.tmpdir(), 'ytdl_cookies.txt');
  try {
    fs.writeFileSync(cookieFilePath, cookies.trim(), 'utf-8');
    return ['--cookies', cookieFilePath];
  } catch (err) {
    logger.warn('Failed to write YOUTUBE_COOKIES to temp file', { error: String(err) });
    return [];
  }
}

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
  thumbnail?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
  channel?: string;
  uploader?: string;
  channel_id?: string;
  uploader_id?: string;
  view_count?: number;
  upload_date?: string;
  formats?: RawFormat[];
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

interface CacheEntry {
  data: MediaInfoResult;
  expiresAt: number;
}

const METADATA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL
const MAX_METADATA_CACHE_SIZE = 500;

class MetadataCache {
  private cache = new Map<string, CacheEntry>();

  public get(key: string): MediaInfoResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  public set(key: string, data: MediaInfoResult): void {
    if (this.cache.size >= MAX_METADATA_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
    });
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const metadataCache = new MetadataCache();

/**
 * Resolves the true case-sensitive YouTube video ID from YouTube search HTML in ~200ms
 * (bypasses direct video URL case sensitivity without launching heavy subprocesses)
 */
export async function resolveCanonicalYouTubeId(rawId: string): Promise<string> {
  if (!rawId || !/^[A-Za-z0-9_-]{11}$/.test(rawId)) {
    return rawId;
  }
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(rawId)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return rawId;
    const html = await res.text();
    const regex = /\/watch\?v=([A-Za-z0-9_-]{11})/g;
    let match: RegExpExecArray | null;
    const lowerRaw = rawId.toLowerCase();
    while ((match = regex.exec(html)) !== null) {
      const candidate = match[1];
      if (candidate && candidate.toLowerCase() === lowerRaw) {
        return candidate;
      }
    }
  } catch {
    // Return original rawId on fetch failure
  }
  return rawId;
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
              503
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
          lowerStderr.includes('sign in to confirm you’re not a bot') ||
          lowerStderr.includes('sign in to confirm you\'re not a bot') ||
          lowerStderr.includes('automated queries')
        ) {
          logger.warn('YouTube challenged server IP with bot detection. Note for deployment owner: YOUTUBE_COOKIES can be set in Render environment variables to authenticate cloud requests.', {
            code,
          });
          return reject(
            new AppError(
              'BOT_DETECTION_BLOCKED',
              'YouTube is temporarily blocking this server from accessing the video. Please try again later.',
              503
            )
          );
        }

        if (
          lowerStderr.includes('sign in to confirm your age') ||
          lowerStderr.includes('confirm your age') ||
          lowerStderr.includes('age-restricted')
        ) {
          return reject(
            new AppError(
              'AGE_RESTRICTED',
              'This video is age-restricted and requires sign-in.',
              403
            )
          );
        }

        if (
          lowerStderr.includes('video unavailable') ||
          lowerStderr.includes('is unavailable') ||
          lowerStderr.includes('private video') ||
          lowerStderr.includes('this video has been removed') ||
          lowerStderr.includes('not available in your country') ||
          lowerStderr.includes('members-only')
        ) {
          return reject(
            new AppError(
              'VIDEO_UNAVAILABLE',
              'This video is unavailable, private, or removed.',
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
            400,
            { stderrSample: lowerStderr.slice(0, 500) }
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
    const cacheKey = `${validated.type}:${validated.id}`;
    const cached = metadataCache.get(cacheKey);
    if (cached) {
      logger.info(`Metadata cache hit for ${cacheKey}`, {
        type: validated.type,
        id: validated.id,
      });
      return cached;
    }

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
          ...getCookieArgs(),
          validated.normalizedUrl,
        ];
      } else {
        // Use web_embedded player client for maximum reliability and avoiding datacenter bot detection
        args = [
          '--dump-single-json',
          '--no-playlist',
          '--no-warnings',
          '--extractor-args',
          'youtube:player_client=web_embedded',
          '--skip-download',
          ...getCookieArgs(),
          validated.normalizedUrl,
        ];
      }

      let rawJson: string;
      try {
        rawJson = await this.executeYtDlp(args);
      } catch (err) {
        // Fallback retry with mweb client (also safe on cloud IPs)
        if (validated.type === 'video') {
          logger.info(`Extraction with primary client failed for ${validated.id}, retrying with mweb client args...`);
          try {
            const fallbackArgs = [
              '--dump-single-json',
              '--no-playlist',
              '--no-warnings',
              '--extractor-args',
              'youtube:player_client=mweb',
              '--skip-download',
              ...getCookieArgs(),
              validated.normalizedUrl,
            ];
            rawJson = await this.executeYtDlp(fallbackArgs);
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }

      let parsed: RawYtDlpOutput;

      try {
        parsed = JSON.parse(rawJson);
      } catch (err) {
        logger.error('Failed to parse yt-dlp JSON output', { error: String(err) });
        throw new AppError('METADATA_FAILED', 'Could not parse media metadata.', 500);
      }

      let result: MediaInfoResult;
      // Check if yt-dlp returned a playlist
      if (parsed._type === 'playlist' || validated.type === 'playlist') {
        result = this.normalizePlaylist(parsed, validated);
      } else {
        // Single video
        result = this.normalizeSingleVideo(parsed, validated);
      }

      metadataCache.set(cacheKey, result);
      metadataCache.set(`${validated.type}:${validated.id}`, result);
      return result;
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
    const seenIds = new Set<string>();
    let index = 1;

    for (const entry of rawEntries) {
      if (!entry || !entry.id) continue;

      let itemId = entry.id;
      if (seenIds.has(itemId)) {
        itemId = `${entry.id}_${index}`;
      }
      seenIds.add(itemId);

      const duration = entry.duration || 0;
      items.push({
        id: itemId,
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
