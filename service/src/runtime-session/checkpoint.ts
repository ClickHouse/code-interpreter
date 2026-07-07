import axios from 'axios';
import type { MicrovmAuthToken } from './lambda-client';
import type { CheckpointStore } from './checkpoint-store';
import {
  acquireRuntimeSessionLock,
  allocateCheckpointSequence,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  writeRuntimeSessionRecord,
} from './registry';
import { checkpointObjectKey } from './checkpoint-store';
import { microvmCheckpoints, microvmRestores, microvmCheckpointBytes } from '../metrics';
import logger from '../logger';

/** Reject if `promise` doesn't settle within `ms`. The underlying op is not
 *  cancelled (the object-store client has no abort hook), but the caller stops
 *  waiting so a stalled write can't hold the session lock indefinitely. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Auto-checkpoint orchestration. The workspace only mutates during an
 * execute, and executes serialize on the session lock — so a lock-guarded
 * checkpoint after each exec yields complete, tear-free coverage: if a newer
 * exec already holds the lock we skip, and that exec's own post-checkpoint
 * covers our changes. Restore runs in-path on relaunch, before the first
 * execute on the fresh VM. Failures are never fatal: a missed checkpoint
 * degrades to file-ref recovery, a failed restore degrades to a fresh
 * workspace ("a resumed VM can be faster, but a relaunched VM must be
 * correct").
 */

export interface CheckpointConfig {
  port: number;
  authTokenTtlSeconds: number;
  maxBytes: number;
  timeoutMs: number;
}

/* Opts the runner into session mode for checkpoint/restore. These run before
 * the first /execute on a relaunched VM, so the runner has nothing bound yet in
 * the hookless design; without this header the handler 409s. Case-insensitive,
 * matches the runner's `x-runtime-session-id`. */
const RUNTIME_SESSION_ID_HEADER = 'X-Runtime-Session-Id';

export async function pullCheckpoint(
  args: { mintToken: () => Promise<MicrovmAuthToken>; endpointBase: string; runtimeSessionId: string },
  config: CheckpointConfig,
): Promise<Buffer> {
  const token = await args.mintToken();
  const response = await axios.get<ArrayBuffer>(`${args.endpointBase}/api/v2/session/checkpoint`, {
    headers: {
      [token.headerName]: token.token,
      [RUNTIME_SESSION_ID_HEADER]: args.runtimeSessionId,
    },
    responseType: 'arraybuffer',
    maxContentLength: config.maxBytes,
    timeout: config.timeoutMs,
  });
  return Buffer.from(response.data);
}

export async function pushRestore(
  args: { mintToken: () => Promise<MicrovmAuthToken>; endpointBase: string; runtimeSessionId: string },
  data: Buffer,
  config: CheckpointConfig,
): Promise<void> {
  const token = await args.mintToken();
  await axios.post(`${args.endpointBase}/api/v2/session/restore`, data, {
    headers: {
      [token.headerName]: token.token,
      [RUNTIME_SESSION_ID_HEADER]: args.runtimeSessionId,
      'Content-Type': 'application/x-gtar',
    },
    maxBodyLength: config.maxBytes,
    timeout: config.timeoutMs,
  });
}

/**
 * Checkpoint the session workspace: pull the tar from the still-warm VM,
 * store it, and record the pointer under the lock (fenced write). Pass
 * `lockToken` to reuse a lock already held (the post-exec path); omit it for
 * a standalone checkpoint (e.g. a pre-deadline sweep), which takes a single
 * non-blocking lock — a busy lock means a newer exec is running and its own
 * post-checkpoint will cover this one.
 */
export async function checkpointSession(args: {
  mintToken: (microvmId: string) => Promise<MicrovmAuthToken>;
  store: CheckpointStore;
  runtimeSessionId: string;
  config: CheckpointConfig;
  normalizeEndpoint: (endpoint: string) => string;
  lockToken?: string;
}): Promise<'stored' | 'skipped_busy' | 'skipped_state' | 'failed'> {
  const heldToken = args.lockToken;
  const lockToken = heldToken ?? await acquireRuntimeSessionLock(args.runtimeSessionId);
  if (!lockToken) {
    microvmCheckpoints.inc({ outcome: 'skipped_busy' });
    return 'skipped_busy';
  }
  try {
    const record = await readRuntimeSessionRecord(args.runtimeSessionId);
    if (!record || record.state !== 'RUNNING' || !record.microvm_id || !record.endpoint) {
      microvmCheckpoints.inc({ outcome: 'skipped_state' });
      return 'skipped_state';
    }
    const microvmId = record.microvm_id;
    const data = await pullCheckpoint({
      mintToken: () => args.mintToken(microvmId),
      endpointBase: args.normalizeEndpoint(record.endpoint),
      runtimeSessionId: args.runtimeSessionId,
    }, args.config);
    /* Each checkpoint writes a distinct, strictly increasing object key, so a
     * put that stalled past the lock and lands late writes an OLDER key and can
     * never overwrite the newer one restore reads. Fence the pointer write
     * first: if it reports we were fenced, skip the store entirely. */
    const sequence = await allocateCheckpointSequence(args.runtimeSessionId);
    const persisted = await writeRuntimeSessionRecord({
      ...record,
      workspace_checkpoint: checkpointObjectKey(args.runtimeSessionId, sequence),
      checkpointed_at: Date.now(),
    }, lockToken);
    if (!persisted) {
      microvmCheckpoints.inc({ outcome: 'skipped_busy' });
      return 'skipped_busy';
    }
    /* Bound the object-store write by the checkpoint timeout too — otherwise a
     * stalled S3/MinIO put holds the session lock past JOB_TIMEOUT. */
    await withTimeout(
      args.store.put(args.runtimeSessionId, sequence, data),
      args.config.timeoutMs,
      'checkpoint store.put',
    );
    microvmCheckpointBytes.observe(data.length);
    microvmCheckpoints.inc({ outcome: 'stored' });
    return 'stored';
  } catch (error) {
    microvmCheckpoints.inc({ outcome: 'failed' });
    logger.warn('Session checkpoint failed', {
      runtimeSessionId: args.runtimeSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  } finally {
    /* Only release a lock we acquired here. */
    if (!heldToken) await releaseRuntimeSessionLock(args.runtimeSessionId, lockToken);
  }
}

/** Relaunch restore: caller holds the session lock and the VM is RUNNING. */
export async function restoreSession(args: {
  mintToken: (microvmId: string) => Promise<MicrovmAuthToken>;
  store: CheckpointStore;
  runtimeSessionId: string;
  microvmId: string;
  endpointBase: string;
  config: CheckpointConfig;
}): Promise<'restored' | 'absent' | 'failed'> {
  /* The store enforces `maxBytes` before buffering (stats S3 object size first),
   * so an oversized/stray checkpoint throws here instead of OOM'ing the worker.
   * Bound the fetch too — a stalled S3/MinIO get would otherwise hold the
   * session lock through the whole relaunch and time the request out. */
  let data: Buffer | null;
  try {
    data = await withTimeout(
      args.store.get(args.runtimeSessionId, args.config.maxBytes),
      args.config.timeoutMs,
      'checkpoint store.get',
    );
  } catch (error) {
    microvmRestores.inc({ outcome: 'failed' });
    logger.warn('Checkpoint fetch failed; continuing with a fresh workspace', {
      runtimeSessionId: args.runtimeSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
  if (!data) {
    microvmRestores.inc({ outcome: 'absent' });
    return 'absent';
  }
  try {
    await pushRestore({
      mintToken: () => args.mintToken(args.microvmId),
      endpointBase: args.endpointBase,
      runtimeSessionId: args.runtimeSessionId,
    }, data, args.config);
    microvmRestores.inc({ outcome: 'restored' });
    logger.info('Session workspace restored from checkpoint', {
      runtimeSessionId: args.runtimeSessionId,
      bytes: data.length,
    });
    return 'restored';
  } catch (error) {
    microvmRestores.inc({ outcome: 'failed' });
    logger.warn('Checkpoint restore failed; continuing with a fresh workspace', {
      runtimeSessionId: args.runtimeSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}
