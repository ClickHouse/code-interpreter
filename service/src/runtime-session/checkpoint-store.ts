import { Client as MinioClient } from 'minio';
import { env } from '../config';

/**
 * Durable storage for session workspace checkpoints. Deterministic key per
 * runtime session (`<prefix><runtime_session_id>.tar.gz`) so a relaunch can
 * find the latest checkpoint even if the registry record was lost. Writes are
 * serialized by the session lock, so last-writer-wins is the intended
 * semantic; object versioning (Phase 4) adds forensic history on top.
 */
export interface CheckpointStore {
  put(runtimeSessionId: string, data: Buffer): Promise<void>;
  /** `maxBytes` is enforced BEFORE the object is buffered into memory (stat the
   *  object first for S3-backed stores) so a stray oversized checkpoint can't
   *  OOM the worker. Throws {@link CheckpointTooLargeError} when exceeded. */
  get(runtimeSessionId: string, maxBytes: number): Promise<Buffer | null>;
}

export class CheckpointTooLargeError extends Error {}

export function checkpointObjectKey(runtimeSessionId: string): string {
  return `${env.CHECKPOINT_PREFIX}${runtimeSessionId}.tar.gz`;
}

/** S3/MinIO-backed store using the same MINIO_* envs as file-server. */
export class MinioCheckpointStore implements CheckpointStore {
  private readonly client: MinioClient;
  private readonly bucket: string;

  constructor() {
    this.client = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
      port: Number(process.env.MINIO_PORT) || 9000,
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY ?? '',
      secretKey: process.env.MINIO_SECRET_KEY ?? '',
      ...(process.env.MINIO_SESSION_TOKEN ? { sessionToken: process.env.MINIO_SESSION_TOKEN } : {}),
      ...(process.env.MINIO_REGION ? { region: process.env.MINIO_REGION } : {}),
    });
    this.bucket = process.env.CODEAPI_CHECKPOINT_BUCKET ?? process.env.MINIO_BUCKET ?? 'test-bucket';
  }

  async put(runtimeSessionId: string, data: Buffer): Promise<void> {
    await this.client.putObject(this.bucket, checkpointObjectKey(runtimeSessionId), data, data.length, {
      'Content-Type': 'application/x-gtar',
    });
  }

  async get(runtimeSessionId: string, maxBytes: number): Promise<Buffer | null> {
    const key = checkpointObjectKey(runtimeSessionId);
    let size: number;
    try {
      const stat = await this.client.statObject(this.bucket, key);
      size = stat.size;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'NoSuchKey' || code === 'NotFound') return null;
      throw error;
    }
    /* Reject before downloading — never buffer an arbitrarily large object. */
    if (size > maxBytes) {
      throw new CheckpointTooLargeError(`checkpoint ${size}B exceeds maxBytes ${maxBytes}B`);
    }
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}

/** In-memory store for bun tests. */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly objects = new Map<string, Buffer>();

  async put(runtimeSessionId: string, data: Buffer): Promise<void> {
    this.objects.set(runtimeSessionId, Buffer.from(data));
  }

  async get(runtimeSessionId: string, maxBytes: number): Promise<Buffer | null> {
    const data = this.objects.get(runtimeSessionId);
    if (!data) return null;
    if (data.length > maxBytes) {
      throw new CheckpointTooLargeError(`checkpoint ${data.length}B exceeds maxBytes ${maxBytes}B`);
    }
    return Buffer.from(data);
  }
}
