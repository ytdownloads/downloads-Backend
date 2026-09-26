export type YouTubeUrlType = 'video' | 'playlist';

export interface ValidatedYouTubeUrl {
  type: YouTubeUrlType;
  id: string;
  normalizedUrl: string;
}

export interface NormalizedFormat {
  formatId: string;
  ext: string;
  quality: string;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  filesize?: number;
}

export interface SingleVideoMetadata {
  type: 'video';
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
  channelId?: string;
  duration: number;
  durationText: string;
  webpageUrl: string;
  viewCount?: number;
  uploadDate?: string;
  isLive?: boolean;
  liveStatus?: string;
  formats: NormalizedFormat[];
}

export interface PlaylistItem {
  id: string;
  title: string;
  thumbnail: string;
  duration: number;
  durationText: string;
  webpageUrl: string;
  index: number;
}

export interface PlaylistMetadata {
  type: 'playlist';
  id: string;
  title: string;
  thumbnail: string;
  channel: string;
  channelId?: string;
  totalItems: number;
  items: PlaylistItem[];
}

export type MediaInfoResult = SingleVideoMetadata | PlaylistMetadata;

export interface InfoRequestBody {
  url: string;
}
