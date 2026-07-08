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
 *   rtsx:active      zset of session ids by last_seen_at   (sweeper-pruned)
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
const ACTIVE_ZSET = 'rtsx:active';

/** The session lock is held across the WHOLE `executeSession` critical path, so
 * its TTL must outlive the worst-case sum of the configurable budgets — else a
 * live holder is fenced mid-operation and a second worker acquires the same
 * session concurrently. A relaunch path can spend, back to back:
 *   - launch throttle wait (acquireOpBudget)      ≤ LAUNCH_TIMEOUT_MS
 *   - poll to RUNNING (waitUntilRunning)          ≤ LAUNCH_TIMEOUT_MS
 *   - restore the checkpoint before the first exec ≤ CHECKPOINT_TIMEOUT_MS
 *   - health check                                 ≤ HEALTH_TIMEOUT_MS
 *   - the execute                                  ≤ JOB_TIMEOUT
 *   - the post-run checkpoint                      ≤ CHECKPOINT_TIMEOUT_MS
 * so budget 2× launch and 2× checkpoint, plus headroom for lock-wait + jitter. */
export const RUNTIME_SESSION_LOCK_TTL_MS =
  env.JOB_TIMEOUT +
  2 * env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS +
  env.LAMBDA_MICROVM_HEALTH_TIMEOUT_MS +
  2 * env.CHECKPOINT_TIMEOUT_MS +
  60_000;

const MAX_MICROVM_DURATION_SECONDS = 28_800;
export const RUNTIME_SESSION_RECORD_TTL_SECONDS = MAX_MICROVM_DURATION_SECONDS + 600;

type RedisWithScripts = Redis & {
  releaseRuntimeSessionLockScript(lockKey: string, token: string): Promise<number>;
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
    activeKey: string,
    token: string,
    member: string,
  ): Promise<number>;
};

const SCRIPTS_REGISTERED = Symbol.for('runtime-session-registry.scriptsRegistered');

function registerScripts(client: Redis): RedisWithScripts {
  const tagged = client as Redis & { [SCRIPTS_REGISTERED]?: true };
  if (tagged[SCRIPTS_REGISTERED]) return client as RedisWithScripts;
  client.defineCommand('releaseRuntimeSessionLockScript', {
    numberOfKeys: 1,
    lua: "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
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
    numberOfKeys: 3,
    lua: `if redis.call('get', KEYS[2]) == ARGV[1] then
  redis.call('del', KEYS[1])
  redis.call('zrem', KEYS[3], ARGV[2])
  return 1
else
  return 0
end`,
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
 *  Callers decide mode policy (affinity ⇒ stateless fallback, strict ⇒ 409). */
export async function waitForRuntimeSessionLock(
  runtimeSessionId: string,
  args: { waitMs: number; pollMs?: number; ttlMs?: number },
): Promise<string | null> {
  const pollMs = args.pollMs ?? 250;
  const deadline = Date.now() + args.waitMs;
  for (;;) {
    const token = await acquireRuntimeSessionLock(runtimeSessionId, args.ttlMs);
    if (token != null) return token;
    if (Date.now() + pollMs > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function releaseRuntimeSessionLock(runtimeSessionId: string, token: string): Promise<void> {
  try {
    await redis.releaseRuntimeSessionLockScript(`${LOCK_PREFIX}${runtimeSessionId}`, token);
  } catch (err) {
    logger.warn('Failed to release runtime session lock', { runtimeSessionId, err });
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
 *  launch. */
export async function allocateRuntimeSessionGeneration(runtimeSessionId: string): Promise<number> {
  const key = `${GEN_PREFIX}${runtimeSessionId}`;
  const generation = await redis.incr(key);
  await redis.expire(key, RUNTIME_SESSION_RECORD_TTL_SECONDS);
  return generation;
}

export async function touchRuntimeSessionActive(runtimeSessionId: string, lastSeenAtMs: number): Promise<void> {
  await redis.zadd(ACTIVE_ZSET, lastSeenAtMs, runtimeSessionId);
}

/** Fenced removal: deletes the record and active-zset member while the caller
 *  holds the mutex. Returns false when fenced. */
export async function removeRuntimeSession(runtimeSessionId: string, lockToken: string): Promise<boolean> {
  const result = await redis.removeRuntimeSessionScript(
    `${SESS_PREFIX}${runtimeSessionId}`,
    `${LOCK_PREFIX}${runtimeSessionId}`,
    ACTIVE_ZSET,
    lockToken,
    runtimeSessionId,
  );
  return result === 1;
}

/** Unfenced zset repair for sweeper use (record already gone). */
export async function forgetRuntimeSessionActive(runtimeSessionId: string): Promise<void> {
  await redis.zrem(ACTIVE_ZSET, runtimeSessionId);
}

export async function listIdleRuntimeSessions(idleBeforeMs: number, limit = 100): Promise<string[]> {
  return redis.zrangebyscore(ACTIVE_ZSET, '-inf', idleBeforeMs, 'LIMIT', 0, limit);
}

export async function countActiveRuntimeSessions(): Promise<number> {
  return redis.zcard(ACTIVE_ZSET);
}
