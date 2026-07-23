import type { Redis } from 'ioredis';
import { connection } from '../queue';

/**
 * Distributed per-second token buckets for Lambda MicroVM control-plane
 * calls. All workers share the AWS account limits (RunMicrovm 5 TPS,
 * ResumeMicrovm 5, SuspendMicrovm 2, CreateMicrovmAuthToken 50), so the
 * budget lives in Redis:
 *
 *   rtsx:tps:<op>:<epochSecond>  INCR-ed per attempt   (PEXPIRE 2s)
 *   rtsx:tps:poison:<op>         backoff flag set on SDK throttle errors
 */

export type ThrottledOp = 'run' | 'resume' | 'suspend' | 'token';

const BUCKET_PREFIX = 'rtsx:tps:';
const POISON_PREFIX = 'rtsx:tps:poison:';
const BUCKET_TTL_MS = 2_000;
const DEFAULT_POISON_MS = 2_000;

let redis: Redis = connection;

export function setRedisForTests(client: Redis): void {
  redis = client;
}

export function resetRedisForTests(): void {
  redis = connection;
}

export class MicrovmOpThrottledError extends Error {
  constructor(public readonly op: ThrottledOp, budgetMs: number) {
    super(`Lambda MicroVM ${op} budget exhausted after ${budgetMs}ms of throttling`);
    this.name = 'MicrovmOpThrottledError';
  }
}

export interface OpBudgetOptions {
  limitPerSecond: number;
  /** Total time the caller is willing to wait for a slot. */
  budgetMs: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Lambda MicroVM operation budget aborted');
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise(
  (resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  },
);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Reserves one control-plane call slot for `op`, waiting across second
 * boundaries until `budgetMs` is exhausted. Throws MicrovmOpThrottledError
 * when no slot frees up in time.
 */
export async function acquireOpBudget(op: ThrottledOp, options: OpBudgetOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.budgetMs;

  for (;;) {
    throwIfAborted(options.signal);
    const poisoned = await redis.pttl(`${POISON_PREFIX}${op}`);
    throwIfAborted(options.signal);
    if (poisoned > 0) {
      if (now() + poisoned > deadline) throw new MicrovmOpThrottledError(op, options.budgetMs);
      await sleep(poisoned, options.signal);
      continue;
    }

    const nowMs = now();
    const second = Math.floor(nowMs / 1_000);
    const key = `${BUCKET_PREFIX}${op}:${second}`;
    const count = await redis.incr(key);
    throwIfAborted(options.signal);
    if (count === 1) {
      await redis.pexpire(key, BUCKET_TTL_MS);
      throwIfAborted(options.signal);
    }
    if (count <= options.limitPerSecond) return;

    const nextSecondMs = (second + 1) * 1_000 - nowMs;
    const jitter = Math.floor(Math.random() * 100);
    const waitMs = nextSecondMs + jitter;
    if (nowMs + waitMs > deadline) throw new MicrovmOpThrottledError(op, options.budgetMs);
    await sleep(waitMs, options.signal);
  }
}

/** Called when the SDK reports ThrottlingException/TooManyRequests: back the
 *  whole fleet off `op` briefly instead of hammering per-second buckets. */
export async function poisonOpBucket(op: ThrottledOp, durationMs: number = DEFAULT_POISON_MS): Promise<void> {
  await redis.set(`${POISON_PREFIX}${op}`, '1', 'PX', durationMs);
}
