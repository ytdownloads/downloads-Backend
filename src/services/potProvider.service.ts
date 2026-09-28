/**
 * src/services/potProvider.service.ts
 * Manages the background BgUtils POT (Proof-of-Origin Token) provider HTTP server.
 * This server runs locally on 127.0.0.1:4416 and mints genuine dynamic PO tokens
 * on the server's own IP address, satisfying YouTube's BotGuard requirements
 * for web and mweb player clients without exposing tokens or cookies.
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const POT_HOST = '127.0.0.1';
const POT_PORT = 4416;
const PING_URL = `http://${POT_HOST}:${POT_PORT}/ping`;
const READY_TIMEOUT_MS = 15000;

class PotProviderService {
  private child: ChildProcess | null = null;
  private isReady: boolean = false;
  private version: string | null = null;
  private startAttempted: boolean = false;

  /**
   * Locates the bgutil-pot executable
   */
  public findBinaryPath(): string | null {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'bgutil-pot.exe' : 'bgutil-pot';

    // 1. Check ./bin/bgutil-pot
    const localBin = path.resolve(process.cwd(), 'bin', binaryName);
    if (fs.existsSync(localBin)) {
      return localBin;
    }

    // 2. Check ./node_modules/.bin/bgutil-pot
    const nodeBin = path.resolve(process.cwd(), 'node_modules', '.bin', binaryName);
    if (fs.existsSync(nodeBin)) {
      return nodeBin;
    }

    // 3. Fallback to binary name on PATH
    return binaryName;
  }

  /**
   * Checks if plugins directory exists
   */
  public getPluginsDir(): string | null {
    const pluginsDir = path.resolve(process.cwd(), 'plugins');
    if (fs.existsSync(pluginsDir)) {
      return pluginsDir;
    }
    return null;
  }

  /**
   * Starts the background POT provider server if not already running
   */
  public async start(): Promise<boolean> {
    if (this.isReady) {
      return true;
    }
    if (this.startAttempted && !this.isReady) {
      return false;
    }
    this.startAttempted = true;

    // Check if an existing server is already running on port 4416
    const existing = await this.ping();
    if (existing.ok) {
      this.isReady = true;
      this.version = existing.version || '0.8.1';
      logger.info(`[POT Provider] Reusing existing POT provider server on ${POT_HOST}:${POT_PORT} (v${this.version})`);
      return true;
    }

    const binPath = this.findBinaryPath();
    if (!binPath) {
      logger.warn('[POT Provider] bgutil-pot binary not found. Extraction will proceed using fallback strategies.');
      return false;
    }

    try {
      logger.info(`[POT Provider] Spawning POT provider server: ${binPath} server --host ${POT_HOST} --port ${POT_PORT}`);
      this.child = spawn(binPath, ['server', '--host', POT_HOST, '--port', String(POT_PORT)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.child.stdout?.on('data', (data: Buffer) => {
        logger.debug(`[POT Provider stdout] ${data.toString().trim()}`);
      });

      this.child.stderr?.on('data', (data: Buffer) => {
        logger.debug(`[POT Provider stderr] ${data.toString().trim()}`);
      });

      this.child.on('error', (err) => {
        logger.warn('[POT Provider] Failed to launch bgutil-pot process:', { error: err.message });
        this.isReady = false;
        this.child = null;
      });

      this.child.on('close', (code) => {
        logger.warn(`[POT Provider] Process exited with code ${code}`);
        this.isReady = false;
        this.child = null;
      });

      // Poll /ping until ready or timeout
      const startTime = Date.now();
      while (Date.now() - startTime < READY_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 250));
        const res = await this.ping();
        if (res.ok) {
          this.isReady = true;
          this.version = res.version || '0.8.1';
          logger.info(
            `[POT Provider] Server verified online and ready at ${POT_HOST}:${POT_PORT} (v${this.version}) in ${Date.now() - startTime}ms`
          );
          return true;
        }
      }

      logger.warn(`[POT Provider] Server failed to respond to /ping within ${READY_TIMEOUT_MS}ms`);
      return false;
    } catch (err: any) {
      logger.warn('[POT Provider] Unexpected error starting server:', { error: err.message });
      return false;
    }
  }

  /**
   * Pings the POT provider HTTP endpoint
   */
  public async ping(): Promise<{ ok: boolean; version?: string; uptime?: number }> {
    try {
      const res = await fetch(PING_URL, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const body: any = await res.json();
        return {
          ok: true,
          version: body.version,
          uptime: body.server_uptime,
        };
      }
    } catch {
      // Endpoint unreachable
    }
    return { ok: false };
  }

  public getStatus(): { active: boolean; version: string | null; host: string; port: number } {
    return {
      active: this.isReady,
      version: this.version,
      host: POT_HOST,
      port: POT_PORT,
    };
  }

  /**
   * Returns CLI arguments required by yt-dlp to use the POT provider
   */
  public getYtDlpArgs(): string[] {
    const args: string[] = [];
    const pluginsDir = this.getPluginsDir();
    if (pluginsDir) {
      args.push('--plugin-dirs', pluginsDir);
    }
    if (this.isReady) {
      args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=http://${POT_HOST}:${POT_PORT}`);
    }
    return args;
  }

  /**
   * Graceful shutdown of child process
   */
  public shutdown(): void {
    if (this.child) {
      logger.info('[POT Provider] Shutting down POT provider server...');
      try {
        this.child.kill('SIGTERM');
        setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill('SIGKILL');
          }
        }, 2000).unref();
      } catch {}
      this.child = null;
      this.isReady = false;
    }
  }
}

export const potProviderService = new PotProviderService();
