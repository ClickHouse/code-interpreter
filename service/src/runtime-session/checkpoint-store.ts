import { Client as MinioClient } from 'minio';
import { env } from '../config';

/**
 * Durable storage for session workspace checkpoints. Each checkpoint writes a
 * distinct, strictly increasing object under a per-session prefix
 * (`<prefix><runtime_session_id>/<sequence>.tar.gz`); restore reads the highest
 * sequence. A put that timed out and lands late therefore writes an OLDER
 * sequence and can never overwrite a newer checkpoint, and a relaunch can still
 * find the latest checkpoint by listing the prefix even if the registry record
 * was lost. Older sequences are best-effort pruned after each successful put.
 */
export interface CheckpointStore {
  put(runtimeSessionId: string, sequence: number, data: Buffer): Promise<void>;
  /** Reads the highest-sequence checkpoint for the session. `maxBytes` is
   *  enforced BEFORE the object is buffered into memory (stat the object first
   *  for S3-backed stores) so a stray oversized checkpoint can't OOM the worker.
   *  Throws {@link CheckpointTooLargeError} when exceeded. */
  get(runtimeSessionId: string, maxBytes: number): Promise<Buffer | null>;
}

export class CheckpointTooLargeError extends Error {}

/** Zero-padded so lexicographic key order matches numeric sequence order. */
const SEQUENCE_WIDTH = 20;

export function checkpointPrefixFor(runtimeSessionId: string): string {
  return `${env.CHECKPOINT_PREFIX}${runtimeSessionId}/`;
}

export function checkpointObjectKey(runtimeSessionId: string, sequence: number): string {
  return `${checkpointPrefixFor(runtimeSessionId)}${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.tar.gz`;
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

  async put(runtimeSessionId: string, sequence: number, data: Buffer): Promise<void> {
    const key = checkpointObjectKey(runtimeSessionId, sequence);
    await this.client.putObject(this.bucket, key, data, data.length, {
      'Content-Type': 'application/x-gtar',
    });
    /* Best-effort: drop only STRICTLY-OLDER sequences. Never touch a newer key
     * (a stale late put must not delete the checkpoint that superseded it —
     * restore always reads the max sequence). */
    await this.pruneOlderThan(runtimeSessionId, key).catch(() => {});
  }

  async get(runtimeSessionId: string, maxBytes: number): Promise<Buffer | null> {
    const key = await this.latestKey(runtimeSessionId);
    if (!key) return null;
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
    let total = 0;
    for await (const chunk of stream) {
      /* Cap during download too: the object can grow between statObject and here
       * (a concurrent put), and the stat size alone wouldn't catch it. */
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        throw new CheckpointTooLargeError(`checkpoint exceeded maxBytes ${maxBytes}B during download`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private async listKeys(runtimeSessionId: string): Promise<string[]> {
    const prefix = checkpointPrefixFor(runtimeSessionId);
    const keys: string[] = [];
    const stream = this.client.listObjectsV2(this.bucket, prefix, true);
    for await (const item of stream as AsyncIterable<{ name?: string }>) {
      if (item.name) keys.push(item.name);
    }
    return keys;
  }

  private async latestKey(runtimeSessionId: string): Promise<string | null> {
    const keys = await this.listKeys(runtimeSessionId);
    if (keys.length === 0) return null;
    return keys.reduce((max, key) => (key > max ? key : max));
  }

  private async pruneOlderThan(runtimeSessionId: string, keepKey: string): Promise<void> {
    const stale = (await this.listKeys(runtimeSessionId)).filter((key) => key < keepKey);
    if (stale.length > 0) await this.client.removeObjects(this.bucket, stale);
  }
}

/** In-memory store for bun tests. Keyed by full object key so latest-selection
 *  and pruning mirror the S3-backed store. */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly objects = new Map<string, Buffer>();

  async put(runtimeSessionId: string, sequence: number, data: Buffer): Promise<void> {
    const key = checkpointObjectKey(runtimeSessionId, sequence);
    const prefix = checkpointPrefixFor(runtimeSessionId);
    for (const existing of this.objects.keys()) {
      /* prune strictly-older sequences only — never a newer one */
      if (existing.startsWith(prefix) && existing < key) this.objects.delete(existing);
    }
    this.objects.set(key, Buffer.from(data));
  }

  async get(runtimeSessionId: string, maxBytes: number): Promise<Buffer | null> {
    const prefix = checkpointPrefixFor(runtimeSessionId);
    let latest: string | undefined;
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix) && (latest === undefined || key > latest)) latest = key;
    }
    if (latest === undefined) return null;
    const data = this.objects.get(latest) as Buffer;
    if (data.length > maxBytes) {
      throw new CheckpointTooLargeError(`checkpoint ${data.length}B exceeds maxBytes ${maxBytes}B`);
    }
    return Buffer.from(data);
  }
}
