import { AppError } from '../middleware/errorHandler.js';
import { ValidatedYouTubeUrl } from '../types/media.types.js';

const YOUTUBE_HOSTNAMES = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_REGEX = /^[A-Za-z0-9_-]{12,}$/;

function isMixPlaylist(listId?: string | null): boolean {
  if (!listId) return false;
  // YouTube mixes/radios: RD (Radio/Mix), UL (User continuous upload mix), TL, PU
  return /^(RD|UL|TL|PU)/i.test(listId);
}

function cleanVideoId(rawId?: string | null, listId?: string | null): string {
  if (!rawId) return '';
  let id = rawId.trim();

  // If already exact 11-char video ID
  if (VIDEO_ID_REGEX.test(id)) {
    return id;
  }

  // If listId is a YouTube Mix (e.g. RD<11-char-video-id>), extract video ID embedded right after 'RD'
  if (listId && /^RD([A-Za-z0-9_-]{11})$/i.test(listId)) {
    const fromList = listId.slice(2);
    if (VIDEO_ID_REGEX.test(fromList)) {
      return fromList;
    }
  }

  // If there's an accidental leading dash before an 11-character video ID (12 chars total)
  if (id.length === 12 && id.startsWith('-') && VIDEO_ID_REGEX.test(id.slice(1))) {
    return id.slice(1);
  }

  // Extract any 11-character base64 sequence
  const match = id.match(/[A-Za-z0-9_-]{11}/);
  if (match && VIDEO_ID_REGEX.test(match[0])) {
    return match[0];
  }

  return id;
}

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

  // Enforce HTTP / HTTPS protocol
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError('INVALID_URL', 'Only HTTP and HTTPS YouTube URLs are supported.', 400);
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
    const listId = parsed.searchParams.get('list');
    const isMix = isMixPlaylist(listId);

    if (listId && PLAYLIST_ID_REGEX.test(listId) && !isMix) {
      return {
        type: 'playlist',
        id: listId,
        normalizedUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
      };
    }

    const rawVideoId = parsed.pathname.slice(1).split('/')[0] || '';
    const videoId = cleanVideoId(rawVideoId, listId);

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

    if (isMixPlaylist(listId)) {
      throw new AppError(
        'UNSUPPORTED_URL',
        'YouTube Mixes and auto-generated radios cannot be downloaded as playlists. Please open and share an individual video.',
        400
      );
    }

    return {
      type: 'playlist',
      id: listId,
      normalizedUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
    };
  }

  // Watch video URLs
  if (pathname === '/watch') {
    const listId = parsed.searchParams.get('list');
    const isMix = isMixPlaylist(listId);

    // Only treat as playlist if it is a genuine playlist (not a dynamic mix/radio)
    if (listId && PLAYLIST_ID_REGEX.test(listId) && !isMix) {
      return {
        type: 'playlist',
        id: listId,
        normalizedUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
      };
    }

    const rawVideoId = parsed.searchParams.get('v') || '';
    const videoId = cleanVideoId(rawVideoId, listId);

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
    const rawVideoId = parsed.pathname.slice('/shorts/'.length).split('/')[0];
    const videoId = cleanVideoId(rawVideoId);
    if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
      throw new AppError('INVALID_URL', 'Invalid YouTube shorts video ID.', 400);
    }

    return {
      type: 'video',
      id: videoId,
      normalizedUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    };
  }

  // Embed video URLs (e.g. https://www.youtube.com/embed/VIDEO_ID or /v/VIDEO_ID)
  if (parsed.pathname.toLowerCase().startsWith('/embed/') || parsed.pathname.toLowerCase().startsWith('/v/')) {
    const prefix = parsed.pathname.toLowerCase().startsWith('/embed/') ? '/embed/' : '/v/';
    const rawVideoId = parsed.pathname.slice(prefix.length).split('/')[0];
    const videoId = cleanVideoId(rawVideoId);
    if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
      throw new AppError('INVALID_URL', 'Invalid YouTube embed video ID.', 400);
    }

    return {
      type: 'video',
      id: videoId,
      normalizedUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    };
  }

  // Other unsupported YouTube endpoints (channels, user pages, feeds)
  throw new AppError(
    'UNSUPPORTED_URL',
    'Only direct YouTube video, short, and playlist links are supported.',
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
