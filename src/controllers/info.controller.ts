import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateYouTubeUrl } from '../services/urlValidation.service.js';
import { YtDlpService } from '../services/ytdlp.service.js';
import { sendSuccess } from '../utils/response.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { ValidatedYouTubeUrl } from '../types/media.types.js';

const infoRequestSchema = z.object({
  url: z.string({
    required_error: 'URL is required.',
  }).trim().min(1, 'URL cannot be empty.'),
});

export async function getMediaInfo(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const parseResult = infoRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0]?.message || 'Invalid request body.';
      throw new AppError('INVALID_REQUEST', issue, 400);
    }

    const { url } = parseResult.data;

    // 1. Backend URL validation and single/playlist classification
    const validated = validateYouTubeUrl(url);

    // 2. Safe yt-dlp metadata extraction without downloading
    let metadata;
    try {
      metadata = await YtDlpService.fetchMetadata(validated);
    } catch (err) {
      // If playlist extraction failed, but the URL was a watch link containing a video ID,
      // fallback to extracting the single video instead of failing completely.
      try {
        const parsed = new URL(url.trim());
        const rawVideoId = parsed.searchParams.get('v');
        if (validated.type === 'playlist' && rawVideoId) {
          const fallbackId = /^[A-Za-z0-9_-]{11}$/.test(rawVideoId)
            ? rawVideoId
            : rawVideoId.match(/[A-Za-z0-9_-]{11}/)?.[0];

          if (fallbackId) {
            logger.warn('Playlist extraction failed, falling back to video ID from URL', {
              playlistId: validated.id,
              videoId: fallbackId,
            });
            const fallbackValidated: ValidatedYouTubeUrl = {
              type: 'video',
              id: fallbackId,
              normalizedUrl: `https://www.youtube.com/watch?v=${fallbackId}`,
            };
            metadata = await YtDlpService.fetchMetadata(fallbackValidated);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      } catch {
        throw err;
      }
    }

    // 3. Return typed, normalized result
    sendSuccess(res, metadata, 200);
  } catch (error) {
    next(error);
  }
}
