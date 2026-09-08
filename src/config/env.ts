import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

// Load environment variables from .env file if available
dotenv.config();

// Ensure local bin directory is in PATH for standalone yt-dlp binaries
const candidateBins = [
  path.resolve(process.cwd(), 'bin'),
  path.resolve(process.cwd(), '..', 'bin'),
  path.resolve(process.cwd(), 'backend', 'bin'),
];
for (const binPath of candidateBins) {
  if (fs.existsSync(binPath)) {
    process.env.PATH = `${binPath}${path.delimiter}${process.env.PATH || ''}`;
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  DOWNLOAD_CONCURRENCY: z.coerce.number().positive().default(2),
  DOWNLOAD_TIMEOUT_MS: z.coerce.number().positive().default(600000),
  FFMPEG_TIMEOUT_MS: z.coerce.number().positive().default(1800000),
  INFO_TIMEOUT_MS: z.coerce.number().positive().default(60000),
  MAX_PLAYLIST_ITEMS: z.coerce.number().positive().default(100),
  JOB_CLEANUP_DELAY_MS: z.coerce.number().positive().default(300000),
  TEMP_DIR: z.string().default(path.resolve(process.cwd(), 'temp_downloads')),
  RATE_LIMIT_MAX: z.coerce.number().positive().default(500),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env = loadConfig();
