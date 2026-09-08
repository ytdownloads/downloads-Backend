# YTdownloader — Backend API

Production-ready backend API service for **YTdownloader**, powering YouTube video and playlist metadata extraction, high-efficiency media stream downloading, Server-Sent Events (SSE) progress broadcasting, dynamic streaming ZIP archiving, and ephemeral storage lifecycle management.

---

## Features

- **Decoupled Architecture**: Standalone Node.js + Express + TypeScript service easily deployable to Render, Railway, Fly.io, or AWS.
- **Real-Time yt-dlp & FFmpeg Engine**: Real stream extraction and remuxing without mock/dummy data.
- **Server-Sent Events (SSE)**: Native streaming endpoints (`/api/download/:jobId/events` and `/api/batch/:id/events`) providing live transfer statistics.
- **Concurrent Playlist Queue**: Thread-safe worker queue enforcing strict concurrency limits (`DOWNLOAD_CONCURRENCY=2`) and streaming ZIP packaging via `archiver`.
- **Ephemeral Storage Lifecycle**: Downloads stored in isolated directories under `temp_downloads/<jobId>` with automatic deletion after completion/cancellation, plus startup purge of stale directories.
- **Graceful Process Management**: Immediate process tree termination on job cancellation, and `SIGTERM`/`SIGINT` graceful shutdown handlers.
- **Security-Hardened**: Strict RFC 4122 UUID route parameter validation, path traversal defense-in-depth, discrete child process argument arrays (preventing shell injection), anti-caching headers, and rate limiting.

---

## Prerequisites

1. **Node.js**: `v18.x` or later.
2. **npm**: `v9.x` or later.
3. **yt-dlp**: Installed in system PATH (automatically installed via `scripts/render-build.sh` on Linux).
4. **FFmpeg**: Required for media stream merging.

---

## Local Development Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment:**
   ```bash
   cp .env.example .env
   ```
   Adjust configuration options if needed (defaults work out-of-the-box for local testing).

3. **Start Development Server:**
   ```bash
   npm run dev
   ```
   The backend API will start on `http://localhost:5000`.

---

## Production Build & Run

1. **Typecheck:**
   ```bash
   npm run typecheck
   ```

2. **Compile TypeScript:**
   ```bash
   npm run build
   ```

3. **Run Production Server:**
   ```bash
   npm start
   ```
   The server binds to `0.0.0.0:${PORT}` and handles graceful shutdown signals cleanly.

---

## Render Deployment

This repository includes a native [render.yaml](render.yaml) Blueprint:

1. Connect your repository to **Render**.
2. Select **New Blueprint Instance**.
3. Render will automatically execute `./scripts/render-build.sh` to install system `yt-dlp` and compile the TypeScript application.
4. Set the `FRONTEND_URL` environment variable to your frontend domain (e.g. `https://youtubedownloader-maker.github.io`).
5. Health checks are monitored at `/api/health`.

---

## API Endpoints Overview

- `GET /health` / `GET /api/health`: Health check (returns `{ status: "ok" }`).
- `POST /api/info`: Extracts metadata, formats, and audio/video stream availability for a given YouTube URL.
- `POST /api/download`: Initializes a single video download job.
- `GET /api/download/:jobId/events`: Real-time SSE progress event stream.
- `POST /api/download/:jobId/cancel`: Aborts active download and purges files.
- `GET /api/download/:jobId/file`: Delivers completed media file with anti-caching headers.
- `POST /api/batch`: Initiates playlist/batch download job.
- `GET /api/batch/:id/events`: Real-time SSE batch progress events.
- `GET /api/batch/:id/items/:itemId/file`: Downloads single finished playlist item.
- `GET /api/batch/:id/zip`: On-the-fly streaming ZIP packaging of all completed playlist items.
- `POST /api/batch/:id/cancel`: Cancels playlist batch and aborts active workers.
- `POST /api/batch/:id/retry`: Re-queues failed/cancelled items.

---

## License & Copyright

@2026 YTdownloader All right reserved
