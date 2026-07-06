import axios from 'axios';
import type { LambdaMicrovmClient } from './lambda-client';
import type { CheckpointStore } from './checkpoint-store';
import {
  acquireRuntimeSessionLock,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  writeRuntimeSessionRecord,
} from './registry';
import { checkpointObjectKey } from './checkpoint-store';
import { microvmCheckpoints, microvmRestores, microvmCheckpointBytes } from '../metrics';
import logger from '../logger';

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

export async function pullCheckpoint(
  client: LambdaMicrovmClient,
  args: { microvmId: string; endpointBase: string },
  config: CheckpointConfig,
): Promise<Buffer> {
  const token = await client.createMicrovmAuthToken({
    microvmId: args.microvmId,
    port: config.port,
    ttlSeconds: config.authTokenTtlSeconds,
  });
  const response = await axios.get<ArrayBuffer>(`${args.endpointBase}/api/v2/session/checkpoint`, {
    headers: { [token.headerName]: token.token },
    responseType: 'arraybuffer',
    maxContentLength: config.maxBytes,
    timeout: config.timeoutMs,
  });
  return Buffer.from(response.data);
}

export async function pushRestore(
  client: LambdaMicrovmClient,
  args: { microvmId: string; endpointBase: string },
  data: Buffer,
  config: CheckpointConfig,
): Promise<void> {
  const token = await client.createMicrovmAuthToken({
    microvmId: args.microvmId,
    port: config.port,
    ttlSeconds: config.authTokenTtlSeconds,
  });
  await axios.post(`${args.endpointBase}/api/v2/session/restore`, data, {
    headers: {
      [token.headerName]: token.token,
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
  client: LambdaMicrovmClient;
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
    const data = await pullCheckpoint(args.client, {
      microvmId: record.microvm_id,
      endpointBase: args.normalizeEndpoint(record.endpoint),
    }, args.config);
    await args.store.put(args.runtimeSessionId, data);
    microvmCheckpointBytes.observe(data.length);
    await writeRuntimeSessionRecord({
      ...record,
      workspace_checkpoint: checkpointObjectKey(args.runtimeSessionId),
      checkpointed_at: Date.now(),
    }, lockToken);
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
  client: LambdaMicrovmClient;
  store: CheckpointStore;
  runtimeSessionId: string;
  microvmId: string;
  endpointBase: string;
  config: CheckpointConfig;
}): Promise<'restored' | 'absent' | 'failed'> {
  let data: Buffer | null;
  try {
    data = await args.store.get(args.runtimeSessionId);
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
    await pushRestore(args.client, { microvmId: args.microvmId, endpointBase: args.endpointBase }, data, args.config);
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
