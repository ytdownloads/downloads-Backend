import { AppError } from '../middleware/errorHandler.js';
import { ValidatedYouTubeUrl } from '../types/media.types.js';

const YOUTUBE_HOSTNAMES = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_REGEX = /^[A-Za-z0-9_-]{12,}$/;

export function validateYouTubeUrl(inputUrl: string): ValidatedYouTubeUrl {
  if (!inputUrl || typeof inputUrl !== 'string') {
    throw new AppError('INVALID_URL', 'Please enter a valid YouTube URL.', 400);
  }

  const trimmed = inputUrl.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('INVALID_URL', 'The provided string is not a valid URL.', 400);
  }

  // Enforce HTTPS protocol
  if (parsed.protocol !== 'https:') {
    throw new AppError('INVALID_URL', 'Only secure HTTPS YouTube URLs are supported.', 400);
  }

  // Enforce exact YouTube hostnames (no subdomains like evil.youtube.com.attacker.com)
  const hostname = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTNAMES.has(hostname)) {
    throw new AppError(
      'INVALID_URL',
      'The provided URL is not from a supported YouTube domain.',
      400
    );
  }

  // Handle youtu.be short links (e.g. https://youtu.be/jNQXAC9IVRw)
  if (hostname === 'youtu.be') {
    const videoId = parsed.pathname.slice(1).split('/')[0];
    if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
      throw new AppError('INVALID_URL', 'Invalid YouTube short video ID.', 400);
    }

    return {
      type: 'video',
      id: videoId,
      normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  // Handle standard youtube.com domains
  const pathname = parsed.pathname.toLowerCase();

  // Playlist URLs
  if (pathname === '/playlist') {
    const listId = parsed.searchParams.get('list');
    if (!listId || !PLAYLIST_ID_REGEX.test(listId)) {
      throw new AppError('INVALID_URL', 'Invalid or missing YouTube playlist ID.', 400);
    }

    return {
      type: 'playlist',
      id: listId,
      normalizedUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
    };
  }

  // Watch video URLs
  if (pathname === '/watch') {
    const videoId = parsed.searchParams.get('v');
    if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
      throw new AppError('INVALID_URL', 'Invalid or missing YouTube video ID.', 400);
    }

    return {
      type: 'video',
      id: videoId,
      normalizedUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    };
  }

  // Shorts video URLs (e.g. https://www.youtube.com/shorts/VIDEO_ID)
  if (parsed.pathname.toLowerCase().startsWith('/shorts/')) {
    const videoId = parsed.pathname.slice('/shorts/'.length).split('/')[0];
    if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
      throw new AppError('INVALID_URL', 'Invalid YouTube shorts video ID.', 400);
    }

    return {
      type: 'video',
      id: videoId,
      normalizedUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    };
  }

  // Other unsupported YouTube endpoints (channels, user pages, embeds, feeds)
  throw new AppError(
    'UNSUPPORTED_URL',
    'Only direct YouTube video and playlist links are supported.',
    400
  );
}

export function isValidYouTubeUrl(inputUrl: string): boolean {
  try {
    validateYouTubeUrl(inputUrl);
    return true;
  } catch {
    return false;
  }
}
