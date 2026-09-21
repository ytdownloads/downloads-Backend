export type JobStatus =
  | 'created'
  | 'preparing'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DownloadStage =
  | 'preparing'
  | 'downloading_video'
  | 'downloading_audio'
  | 'merging'
  | 'processing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DownloadProgress {
  status: JobStatus;
  stage: DownloadStage;
  stageMessage: string;
  isIndeterminate: boolean;
  percentage: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
}

export interface CreateDownloadRequest {
  url: string;
  formatId: string;
  type?: 'video';
}

export interface DownloadJobData {
  jobId: string;
  url: string;
  title?: string;
  formatId: string;
  status: JobStatus;
  progress: DownloadProgress;
  fileName?: string;
  fileSize?: number;
  error?: {
    code: string;
    message: string;
  };
  createdAt: number;
  updatedAt: number;
}

export type BatchStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'completed_with_errors'
  | 'cancelled'
  | 'failed';

export type PlaylistItemStatus =
  | 'pending'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BatchItemData {
  id: string; // unique item id (video id or item index id)
  url: string;
  title: string;
  durationSeconds?: number;
  thumbnail?: string;
  formatId: string;
  status: PlaylistItemStatus;
  stage?: DownloadStage;
  stageMessage?: string;
  isIndeterminate?: boolean;
  percentage: number;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
  fileName?: string;
  fileSize?: number;
  filePath?: string;
  error?: {
    code: string;
    message: string;
  };
}

export type BatchZipStatus = 'idle' | 'creating' | 'finalizing' | 'ready' | 'failed';

export interface BatchJobData {
  batchJobId: string;
  playlistTitle?: string;
  formatId: string;
  status: BatchStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  overallPercentage: number;
  items: BatchItemData[];
  zipStatus?: BatchZipStatus;
  zipStatusMessage?: string;
  zipFileName?: string;
  zipFileSize?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BatchPlaylistItemInput {
  id: string;
  url: string;
  title: string;
  durationSeconds?: number;
  thumbnail?: string;
}

export interface CreateBatchDownloadRequest {
  playlistTitle?: string;
  formatId: string;
  items: BatchPlaylistItemInput[];
}

export interface AddBatchItemsRequest {
  formatId: string;
  items: BatchPlaylistItemInput[];
}
