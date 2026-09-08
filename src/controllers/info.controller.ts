import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateYouTubeUrl } from '../services/urlValidation.service.js';
import { YtDlpService } from '../services/ytdlp.service.js';
import { sendSuccess } from '../utils/response.js';
import { AppError } from '../middleware/errorHandler.js';

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
    const metadata = await YtDlpService.fetchMetadata(validated);

    // 3. Return typed, normalized result
    sendSuccess(res, metadata, 200);
  } catch (error) {
    next(error);
  }
}
