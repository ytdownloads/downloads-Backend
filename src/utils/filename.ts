/**
 * Utility functions for producing clean, readable, Windows-safe filenames
 * across all media types (Single Video, Single Audio, Playlist, Batch, and ZIP).
 */

/**
 * Sanitizes a title into a clean, readable, Windows-safe filename with the specified extension.
 *
 * Rules:
 * 1. Preserves normal spaces (does NOT convert spaces into underscores).
 * 2. Removes or safely replaces characters invalid in Windows filenames: < > : " / \ | ? * and ASCII control characters (0-31, 127).
 * 3. Preserves Unicode characters (Devanagari/Marathi/Hindi, Cyrillic, Chinese, accents, etc.).
 * 4. Cleans redundant repeated separators (e.g. "__" -> "_", "  " -> " ").
 * 5. Normalizes whitespace (trims leading and trailing spaces).
 * 6. Strips trailing dots/periods (Windows filenames cannot safely end with a period).
 * 7. Ensures correct extension without duplication (e.g. avoids "song.mp3.mp3").
 * 8. Truncates overly long base titles (e.g. max 150 chars) safely without breaking multi-byte Unicode codepoints.
 * 9. Provides fallback if title is empty.
 */
export function sanitizeCleanFilename(rawTitle: string, ext: string): string {
  // Normalize extension
  let cleanExt = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase().trim();
  if (cleanExt === '.') cleanExt = '.mp4';

  let title = (rawTitle || '').trim();

  // Strip extension if already present at the end of title to prevent double extension (e.g. "song.mp3.mp3")
  if (title.toLowerCase().endsWith(cleanExt)) {
    title = title.slice(0, -cleanExt.length).trim();
  }

  // Remove invalid Windows filename characters: < > : " / \ | ? * and control chars (0x00-0x1F, 0x7F)
  // Also strip zero-width characters (U+200B-U+200D, U+FEFF)
  title = title
    .replace(/[\x00-\x1F\x7F<>:"/\\|?*]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Collapse multiple underscores into single underscore
  title = title.replace(/_{2,}/g, '_');

  // Collapse multiple spaces into single space
  title = title.replace(/\s+/g, ' ');

  // Trim spaces and periods from both ends (Windows filenames cannot end with a period or space)
  title = title.replace(/^[\s.]+|[\s.]+$/g, '');

  // Truncate overly long base filename to safe length (max 150 characters)
  if (Array.from(title).length > 150) {
    title = Array.from(title).slice(0, 150).join('').trim();
    // Trim trailing periods again after truncation
    title = title.replace(/[\s.]+$/g, '');
  }

  // Fallback if empty after sanitization
  if (!title) {
    title = 'media';
  }

  return `${title}${cleanExt}`;
}

/**
 * Builds an RFC 5987 / RFC 6266 compliant Content-Disposition header.
 *
 * This provides:
 * 1. An ASCII fallback filename for legacy clients (`filename="..."`).
 * 2. A UTF-8 encoded filename for modern browsers (`filename*=UTF-8''...`),
 *    guaranteeing that Marathi, Hindi, Unicode, and spaces are downloaded accurately.
 */
export function buildContentDispositionHeader(filename: string): string {
  // ASCII fallback: replace non-ASCII and quotes/backslashes
  const asciiFallback = filename
    .replace(/[\x80-\uFFFF]/g, '_')
    .replace(/["\\]/g, '')
    .trim() || 'download';

  const utf8Encoded = encodeURIComponent(filename).replace(/['()]/g, escape);

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}
