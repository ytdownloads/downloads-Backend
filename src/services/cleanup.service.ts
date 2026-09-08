import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class CleanupService {
  /**
   * Safely deletes an entire job directory within TEMP_DIR.
   * Path is verified to prevent path traversal outside TEMP_DIR.
   */
  public static async cleanupJobDir(jobDir: string): Promise<void> {
    if (!jobDir) return;

    try {
      const resolvedTarget = path.resolve(jobDir);
      const resolvedTempBase = path.resolve(env.TEMP_DIR);

      // Path safety verification
      if (!resolvedTarget.startsWith(resolvedTempBase) || resolvedTarget === resolvedTempBase) {
        logger.error('Security alert: Refusing to delete path outside TEMP_DIR', {
          target: resolvedTarget,
          tempBase: resolvedTempBase,
        });
        return;
      }

      await fs.rm(resolvedTarget, { recursive: true, force: true });
      logger.info('Cleaned up job directory', { jobDir: path.basename(resolvedTarget) });
    } catch (err) {
      logger.warn('Error during job directory cleanup (ignoring)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Cleans stale job directories on server startup
   */
  public static async startupCleanup(): Promise<void> {
    try {
      const resolvedTempBase = path.resolve(env.TEMP_DIR);
      await fs.mkdir(resolvedTempBase, { recursive: true });

      const entries = await fs.readdir(resolvedTempBase, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(resolvedTempBase, entry.name);
          await fs.rm(dirPath, { recursive: true, force: true });
          logger.info('Purged stale temporary directory on startup', { dir: entry.name });
        }
      }
    } catch (err) {
      logger.warn('Failed startup temporary directory cleanup', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
