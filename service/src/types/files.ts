import type { ItemBucketMetadata } from 'minio';
export interface UploadResult {
  filename: string;
  fileId: string;
}

export type SimpleObject = string;

export interface SummaryObject {
  name: string;
  size: number;
  lastModified: Date;
  etag: string;
}

export interface FullObject extends SummaryObject {
  metadata: ItemBucketMetadata;
  versionId: string | null;
  contentType: string;
}

/**
 * Self-contained file reference with session_id - ideal for subsequent API calls
 */
export interface NormalizedObject {
  id: string;
  name: string;
  session_id: string;
  size: number;
  contentType: string;
  lastModified: Date;
}

export type DetailLevel = 'simple' | 'summary' | 'full' | 'normalized';

export type ObjectTypes = SimpleObject | SummaryObject | FullObject | NormalizedObject;

export interface BatchUploadFileSuccess {
  status: 'success';
  filename: string;
  fileId: string;
}

export interface BatchUploadFileError {
  status: 'error';
  filename: string;
  error: string;
}

export type BatchUploadFileResult = BatchUploadFileSuccess | BatchUploadFileError;

export interface BatchUploadResponse {
  message: 'success' | 'partial_success' | 'error';
  session_id: string;
  files: BatchUploadFileResult[];
  succeeded: number;
  failed: number;
  filesLimitReached?: boolean;
  maxFiles?: number;
}
