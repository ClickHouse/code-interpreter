import { nanoid } from 'nanoid';
import type { Redis } from 'ioredis';
import { connection } from '../queue';
import { env } from '../config';
import logger from '../logger';

/**
 * Redis-backed registry mapping a `runtime_session_id` to its live (or
 * suspended) Lambda MicroVM. Keys:
 *
 *   rtsx:sess:<id>   JSON RuntimeSessionRecord            (TTL: record TTL)
 *   rtsx:lock:<id>   per-session mutex token               (SET NX PX)
 *   rtsx:gen:<id>    monotonic generation counter (INCR)   (TTL: record TTL)
 *
 * Fencing: every record mutation runs through a Lua script that checks the
 * caller still holds the session lock. A `false` return means the caller was
 * fenced (lock expired or stolen) and must treat any MicroVM it just launched
 * as an orphan to terminate. Lua stays within the GET/SET/DEL string-compare
 * subset that ioredis-mock supports (see replay-state.ts).
 */

export type RuntimeSessionState = 'PENDING' | 'RUNNING' | 'SUSPENDED' | 'TERMINATING' | 'TERMINATED';

export interface RuntimeSessionRecord {
  runtime_session_id: string;
  tenant_id: string;
  canonical_user_id: string;
  microvm_id?: string;
  endpoint?: string;
  port?: number;
  image_arn?: string;
  image_version?: string;
  /** Fingerprint of every immutable launch/security input. A deploy that
   * changes one must not reuse a VM launched under the old policy. */
  launch_fingerprint?: string;
  /** Exact provider idempotency token for this persisted launch intent.
   * Optional so workers can safely replay records written before this field
   * existed. */
  launch_client_token?: string;
  /** Exact fingerprint of the RunMicrovm request paired with
   * `launch_client_token`. Unlike `launch_fingerprint`, this preserves
   * wire-level distinctions such as connector ordering for safe replay. */
  launch_request_fingerprint?: string;
  state: RuntimeSessionState;
  generation: number;
  launched_at?: number;
  last_seen_at: number;
  hard_deadline_at?: number;
  workspace_checkpoint?: string;
  checkpointed_at?: number;
  last_error?: string;
}

const SESS_PREFIX = 'rtsx:sess:';
const LOCK_PREFIX = 'rtsx:lock:';
const GEN_PREFIX = 'rtsx:gen:';
const CKPT_SEQ_PREFIX = 'rtsx:ckptseq:';

/** The session lock is held across the WHOLE `executeSession` critical path
 * (launch throttle, readiness/restore, execute, post-run checkpoint), which sums
 * to a large and variable worst case once per-op token-mint throttle waits are
 * included. Rather than pin the TTL to that sum (fragile — a missed term lets a
 * second worker fence a live holder and mutate the session concurrently), the
 * holder RENEWS the lock on a heartbeat (`renewRuntimeSessionLock`) for as long
 * as it runs. This value is therefore just a comfortable BASE that must outlive
 * one heartbeat interval plus a stalled event loop — it already covers a normal
 * relaunch (execute + launch + health + the checkpoint I/Os) with headroom. */
export const RUNTIME_SESSION_LOCK_TTL_MS =
  env.JOB_TIMEOUT +
  2 * env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS +
  env.LAMBDA_MICROVM_HEALTH_TIMEOUT_MS +
  4 * env.CHECKPOINT_TIMEOUT_MS +
  60_000;

const MAX_MICROVM_DURATION_SECONDS = 28_800;
export const RUNTIME_SESSION_RECORD_TTL_SECONDS = MAX_MICROVM_DURATION_SECONDS + 600;

type RedisWithScripts = Redis & {
  releaseRuntimeSessionLockScript(lockKey: string, token: string): Promise<number>;
  renewRuntimeSessionLockScript(lockKey: string, token: string, ttlMs: string): Promise<number>;
  writeRuntimeSessionRecordScript(
    sessKey: string,
    lockKey: string,
    token: string,
    recordJson: string,
    ttlSeconds: string,
  ): Promise<number>;
  removeRuntimeSessionScript(
    sessKey: string,
    lockKey: string,
    token: string,
  ): Promise<number>;
  allocateCheckpointSequenceScript(
    sequenceKey: string,
    retainedMax: string,
    ttlSeconds: string,
  ): Promise<number>;
  allocateRuntimeSessionGenerationScript(
    generationKey: string,
    initialGeneration: string,
    ttlSeconds: string,
  ): Promise<string>;
};

const SCRIPTS_REGISTERED = Symbol.for('runtime-session-registry.scriptsRegistered');

function registerScripts(client: Redis): RedisWithScripts {
  const tagged = client as Redis & { [SCRIPTS_REGISTERED]?: true };
  if (tagged[SCRIPTS_REGISTERED]) return client as RedisWithScripts;
  client.defineCommand('releaseRuntimeSessionLockScript', {
    numberOfKeys: 1,
    lua: "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
  });
  client.defineCommand('renewRuntimeSessionLockScript', {
    numberOfKeys: 1,
    lua: "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
  });
  client.defineCommand('writeRuntimeSessionRecordScript', {
    numberOfKeys: 2,
    lua: `if redis.call('get', KEYS[2]) == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
else
  return 0
end`,
  });
  client.defineCommand('removeRuntimeSessionScript', {
    numberOfKeys: 2,
    lua: `if redis.call('get', KEYS[2]) == ARGV[1] then
  redis.call('del', KEYS[1])
  return 1
else
  return 0
end`,
  });
  client.defineCommand('allocateCheckpointSequenceScript', {
    numberOfKeys: 1,
    lua: `local current = tonumber(redis.call('get', KEYS[1]) or '0')
local retained = tonumber(ARGV[1])
if retained > current then current = retained end
local sequence = current + 1
redis.call('set', KEYS[1], tostring(sequence), 'EX', ARGV[2])
return sequence`,
  });
  client.defineCommand('allocateRuntimeSessionGenerationScript', {
    numberOfKeys: 1,
    lua: `local current = redis.call('get', KEYS[1]) or '0'
local initial = ARGV[1]
local generation
local below_initial = string.len(current) < string.len(initial)
  or (string.len(current) == string.len(initial) and current < initial)
if below_initial then
  generation = ARGV[1]
  redis.call('set', KEYS[1], generation, 'EX', ARGV[2])
else
  redis.call('incr', KEYS[1])
  redis.call('expire', KEYS[1], ARGV[2])
  generation = redis.call('get', KEYS[1])
end
return generation`,
  });
  tagged[SCRIPTS_REGISTERED] = true;
  return client as RedisWithScripts;
}

let redis: RedisWithScripts = registerScripts(connection);

/** Test seam mirroring replay-state.ts: swap in ioredis-mock per test. */
export function setRedisForTests(client: Redis): void {
  redis = registerScripts(client);
}

export function resetRedisForTests(): void {
  redis = registerScripts(connection);
}

export async function acquireRuntimeSessionLock(
  runtimeSessionId: string,
  ttlMs: number = RUNTIME_SESSION_LOCK_TTL_MS,
): Promise<string | null> {
  const token = nanoid();
  const result = await redis.set(`${LOCK_PREFIX}${runtimeSessionId}`, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? token : null;
}

/** Polls for the session mutex; returns null once `waitMs` is exhausted.
 *  Stateful callers surface contention as HTTP 409 instead of executing cold. */
export async function waitForRuntimeSessionLock(
  runtimeSessionId: string,
  args: { waitMs: number; pollMs?: number; ttlMs?: number; signal?: AbortSignal },
): Promise<string | null> {
  const pollMs = args.pollMs ?? 250;
  const deadline = Date.now() + args.waitMs;
  for (;;) {
    args.signal?.throwIfAborted();
    const token = await acquireRuntimeSessionLock(runtimeSessionId, args.ttlMs);
    if (args.signal?.aborted) {
      if (token != null) await releaseRuntimeSessionLock(runtimeSessionId, token);
      args.signal.throwIfAborted();
    }
    if (token != null) return token;
    if (Date.now() + pollMs > deadline) return null;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        args.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, pollMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(args.signal?.reason instanceof Error
          ? args.signal.reason
          : new Error('Runtime session lock wait aborted'));
      };
      args.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export async function releaseRuntimeSessionLock(runtimeSessionId: string, token: string): Promise<void> {
  const retryDelaysMs = [50, 200] as const;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await redis.releaseRuntimeSessionLockScript(`${LOCK_PREFIX}${runtimeSessionId}`, token);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retryDelaysMs.length) {
        await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
  }
  /* Release runs from finally blocks. Do not mask either a successful execute
   * or its primary error, but heal brief Redis failovers before accepting that
   * the token-guarded lease must age out. The Lua release is idempotent, so a
   * retry is safe even if Redis deleted the key but lost the first response. */
  logger.warn('Failed to release runtime session lock after retries', {
    runtimeSessionId,
    err: lastError,
  });
}

/** Fenced heartbeat: extend the lock's TTL only while we still hold the token.
 *  Returns false if we've been fenced (another worker owns the lock now), which
 *  the caller uses to stop renewing. Lets the critical path run arbitrarily long
 *  (launch throttle + restore + execute + checkpoint, each with its own I/O and
 *  token-mint waits) without the TTL having to bound the worst-case sum. */
/** `lost` is positive evidence another holder fenced us (token mismatch);
 *  `error` is a transport failure where the lock may well still be held —
 *  callers must only abort in-flight work on `lost`, never on a single
 *  transient `error` (the TTL is a multiple of the heartbeat interval, so
 *  the next tick retries well before expiry). */
export type LockRenewal = 'held' | 'lost' | 'error';

export async function renewRuntimeSessionLock(
  runtimeSessionId: string,
  token: string,
  ttlMs: number = RUNTIME_SESSION_LOCK_TTL_MS,
): Promise<LockRenewal> {
  try {
    const result = await redis.renewRuntimeSessionLockScript(
      `${LOCK_PREFIX}${runtimeSessionId}`,
      token,
      String(ttlMs),
    );
    return result === 1 ? 'held' : 'lost';
  } catch (err) {
    logger.warn('Failed to renew runtime session lock', { runtimeSessionId, err });
    return 'error';
  }
}

export async function readRuntimeSessionRecord(runtimeSessionId: string): Promise<RuntimeSessionRecord | null> {
  const data = await redis.get(`${SESS_PREFIX}${runtimeSessionId}`);
  if (data == null) return null;
  /* Treat a corrupt/incompatible record as missing so a single bad key can't
   * wedge every request for the session until it is manually deleted. */
  try {
    return JSON.parse(data) as RuntimeSessionRecord;
  } catch (err) {
    logger.warn('Discarding malformed runtime session record', { runtimeSessionId, err });
    return null;
  }
}

/** Fenced write: persists the record only while `lockToken` still holds the
 *  session mutex. Returns false when the caller was fenced. */
export async function writeRuntimeSessionRecord(
  record: RuntimeSessionRecord,
  lockToken: string,
  ttlSeconds: number = RUNTIME_SESSION_RECORD_TTL_SECONDS,
): Promise<boolean> {
  const result = await redis.writeRuntimeSessionRecordScript(
    `${SESS_PREFIX}${record.runtime_session_id}`,
    `${LOCK_PREFIX}${record.runtime_session_id}`,
    lockToken,
    JSON.stringify(record),
    String(ttlSeconds),
  );
  return result === 1;
}

/** Monotonic generation for launch fencing: allocated while holding the lock,
 *  before RunMicrovm, so a stale worker's record can never outrank a newer
 *  launch. `initialGeneration` lets a caller atomically move a lost/legacy
 *  counter into a collision-resistant namespace while remaining compatible
 *  with older workers, which derive the provider token from this number. */
export async function allocateRuntimeSessionGeneration(
  runtimeSessionId: string,
  initialGeneration = 1,
): Promise<number> {
  if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1) {
    throw new Error('Runtime session generation must be a positive safe integer');
  }
  const key = `${GEN_PREFIX}${runtimeSessionId}`;
  const rawGeneration = await redis.allocateRuntimeSessionGenerationScript(
    key,
    String(initialGeneration),
    String(RUNTIME_SESSION_RECORD_TTL_SECONDS),
  );
  const generation = Number(rawGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Runtime session generation exceeded the safe integer range');
  }
  return generation;
}

/** Atomically reserves a monotonic checkpoint sequence above both the Redis
 *  counter and the highest object retained in durable storage. Combining the
 *  high-water reseed and increment in one Lua operation is required for
 *  fencing: a stale holder that resumes after another worker acquired the
 *  session lock can consume a distinct sequence, but can never reset the
 *  counter and overwrite the newer holder's immutable object key. */
export async function allocateCheckpointSequence(
  runtimeSessionId: string,
  retainedMax = 0,
): Promise<number> {
  const key = `${CKPT_SEQ_PREFIX}${runtimeSessionId}`;
  return redis.allocateCheckpointSequenceScript(
    key,
    String(retainedMax),
    String(RUNTIME_SESSION_RECORD_TTL_SECONDS),
  );
}

/** Fenced removal: deletes the record while the caller holds the mutex.
 *  Returns false when fenced. */
export async function removeRuntimeSession(runtimeSessionId: string, lockToken: string): Promise<boolean> {
  const result = await redis.removeRuntimeSessionScript(
    `${SESS_PREFIX}${runtimeSessionId}`,
    `${LOCK_PREFIX}${runtimeSessionId}`,
    lockToken,
  );
  return result === 1;
}
