import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import {
  acquireRuntimeSessionLock,
  allocateCheckpointSequence,
  allocateRuntimeSessionGeneration,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  removeRuntimeSession,
  resetRedisForTests,
  setRedisForTests,
  waitForRuntimeSessionLock,
  writeRuntimeSessionRecord,
  type RuntimeSessionRecord,
} from './registry';

let mock: InstanceType<typeof RedisMock>;

beforeEach(async () => {
  /* ioredis-mock shares one keyspace across instances — flush per test. */
  mock = new RedisMock();
  await mock.flushall();
  setRedisForTests(mock);
});

afterEach(() => {
  resetRedisForTests();
});

function record(overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord {
  return {
    runtime_session_id: 'rt_abc123',
    tenant_id: 'tenant-a',
    canonical_user_id: 'user-1',
    state: 'PENDING',
    generation: 1,
    last_seen_at: 1_778_250_000_000,
    ...overrides,
  };
}

describe('runtime session lock', () => {
  test('acquire is exclusive; release makes it available again', async () => {
    const token = await acquireRuntimeSessionLock('rt_abc123');
    expect(token).not.toBeNull();
    expect(await acquireRuntimeSessionLock('rt_abc123')).toBeNull();
    await releaseRuntimeSessionLock('rt_abc123', token as string);
    expect(await acquireRuntimeSessionLock('rt_abc123')).not.toBeNull();
  });

  test('release is CAS-guarded: a stale token cannot free the current holder', async () => {
    const first = await acquireRuntimeSessionLock('rt_abc123');
    await releaseRuntimeSessionLock('rt_abc123', first as string);
    const second = await acquireRuntimeSessionLock('rt_abc123');
    await releaseRuntimeSessionLock('rt_abc123', first as string);
    expect(await acquireRuntimeSessionLock('rt_abc123')).toBeNull();
    await releaseRuntimeSessionLock('rt_abc123', second as string);
  });

  test('waitForRuntimeSessionLock polls until the holder releases', async () => {
    const holder = await acquireRuntimeSessionLock('rt_abc123');
    setTimeout(() => void releaseRuntimeSessionLock('rt_abc123', holder as string), 60);
    const token = await waitForRuntimeSessionLock('rt_abc123', { waitMs: 2_000, pollMs: 20 });
    expect(token).not.toBeNull();
  });

  test('waitForRuntimeSessionLock gives up after waitMs', async () => {
    await acquireRuntimeSessionLock('rt_abc123');
    const started = Date.now();
    const token = await waitForRuntimeSessionLock('rt_abc123', { waitMs: 120, pollMs: 25 });
    expect(token).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('waitForRuntimeSessionLock stops promptly when the job is canceled', async () => {
    const holder = await acquireRuntimeSessionLock('rt_abc123');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('job deadline')), 10);

    await expect(waitForRuntimeSessionLock('rt_abc123', {
      waitMs: 5_000,
      pollMs: 1_000,
      signal: controller.signal,
    })).rejects.toThrow('job deadline');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await acquireRuntimeSessionLock('rt_abc123')).toBeNull();
    await releaseRuntimeSessionLock('rt_abc123', holder as string);
  });
});

describe('fenced record writes', () => {
  test('retries a transient lock-release failure so the session is immediately reusable', async () => {
    const token = (await acquireRuntimeSessionLock('rt_release_retry')) as string;
    const scripted = mock as unknown as {
      releaseRuntimeSessionLockScript(
        lockKey: string,
        lockToken: string,
      ): Promise<number>;
    };
    const release = scripted.releaseRuntimeSessionLockScript.bind(scripted);
    let calls = 0;
    scripted.releaseRuntimeSessionLockScript = async (lockKey, lockToken) => {
      calls += 1;
      if (calls === 1) throw new Error('temporary Redis failover');
      return release(lockKey, lockToken);
    };

    await releaseRuntimeSessionLock('rt_release_retry', token);

    expect(calls).toBe(2);
    expect(await acquireRuntimeSessionLock('rt_release_retry')).not.toBeNull();
  });

  test('write succeeds while holding the lock and round-trips the record', async () => {
    const token = (await acquireRuntimeSessionLock('rt_abc123')) as string;
    const rec = record({ state: 'RUNNING', microvm_id: 'mvm-1', endpoint: 'https://vm.example', generation: 3 });
    expect(await writeRuntimeSessionRecord(rec, token)).toBe(true);
    expect(await readRuntimeSessionRecord('rt_abc123')).toEqual(rec);
  });

  test('reads a corrupt record as missing instead of throwing', async () => {
    await mock.set('rtsx:sess:rt_bad', '{not valid json');
    expect(await readRuntimeSessionRecord('rt_bad')).toBeNull();
  });

  test('write is fenced after the lock is lost', async () => {
    const token = (await acquireRuntimeSessionLock('rt_abc123')) as string;
    await releaseRuntimeSessionLock('rt_abc123', token);
    const thief = await acquireRuntimeSessionLock('rt_abc123');
    expect(thief).not.toBeNull();
    expect(await writeRuntimeSessionRecord(record(), token)).toBe(false);
    expect(await readRuntimeSessionRecord('rt_abc123')).toBeNull();
  });

  test('write is fenced when no lock exists at all', async () => {
    expect(await writeRuntimeSessionRecord(record(), 'never-held')).toBe(false);
  });

  test('removal is fenced and clears the record', async () => {
    const token = (await acquireRuntimeSessionLock('rt_abc123')) as string;
    await writeRuntimeSessionRecord(record(), token);

    expect(await removeRuntimeSession('rt_abc123', 'stale-token')).toBe(false);
    expect(await readRuntimeSessionRecord('rt_abc123')).not.toBeNull();

    expect(await removeRuntimeSession('rt_abc123', token)).toBe(true);
    expect(await readRuntimeSessionRecord('rt_abc123')).toBeNull();
  });
});

describe('generation counter', () => {
  test('increments monotonically per session and independently across sessions', async () => {
    expect(await allocateRuntimeSessionGeneration('rt_abc123')).toBe(1);
    expect(await allocateRuntimeSessionGeneration('rt_abc123')).toBe(2);
    expect(await allocateRuntimeSessionGeneration('rt_abc123')).toBe(3);
    expect(await allocateRuntimeSessionGeneration('rt_other')).toBe(1);
  });
});

describe('checkpoint sequence counter', () => {
  test('concurrent stale holders reserve distinct keys above the durable high-water mark', async () => {
    /* Models two holders that both listed durable sequence 100 around a lease
     * handoff. A split INCR + reseed SET can return 101 to both and let the
     * stale upload overwrite the new holder's committed object. The atomic
     * reservation must serialize them as 101 and 102 instead. */
    const reservations = await Promise.all([
      allocateCheckpointSequence('rt_abc123', 100),
      allocateCheckpointSequence('rt_abc123', 100),
    ]);
    expect(reservations.sort((a, b) => a - b)).toEqual([101, 102]);
    expect(await allocateCheckpointSequence('rt_abc123', 50)).toBe(103);
  });
});
