import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import {
  acquireRuntimeSessionLock,
  allocateRuntimeSessionGeneration,
  countActiveRuntimeSessions,
  forgetRuntimeSessionActive,
  listIdleRuntimeSessions,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  removeRuntimeSession,
  resetRedisForTests,
  setRedisForTests,
  touchRuntimeSessionActive,
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
});

describe('fenced record writes', () => {
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

  test('removal is fenced and clears record + active member', async () => {
    const token = (await acquireRuntimeSessionLock('rt_abc123')) as string;
    await writeRuntimeSessionRecord(record(), token);
    await touchRuntimeSessionActive('rt_abc123', 1_778_250_000_000);

    expect(await removeRuntimeSession('rt_abc123', 'stale-token')).toBe(false);
    expect(await readRuntimeSessionRecord('rt_abc123')).not.toBeNull();

    expect(await removeRuntimeSession('rt_abc123', token)).toBe(true);
    expect(await readRuntimeSessionRecord('rt_abc123')).toBeNull();
    expect(await countActiveRuntimeSessions()).toBe(0);
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

describe('active session bookkeeping', () => {
  test('idle listing returns only sessions last seen before the cutoff', async () => {
    await touchRuntimeSessionActive('rt_old', 1_000);
    await touchRuntimeSessionActive('rt_mid', 5_000);
    await touchRuntimeSessionActive('rt_new', 9_000);

    expect(await listIdleRuntimeSessions(4_999)).toEqual(['rt_old']);
    expect(await listIdleRuntimeSessions(5_000)).toEqual(['rt_old', 'rt_mid']);
    expect(await countActiveRuntimeSessions()).toBe(3);
  });

  test('touch updates the score in place; forget repairs orphans', async () => {
    await touchRuntimeSessionActive('rt_abc123', 1_000);
    await touchRuntimeSessionActive('rt_abc123', 9_000);
    expect(await listIdleRuntimeSessions(5_000)).toEqual([]);
    expect(await countActiveRuntimeSessions()).toBe(1);

    await forgetRuntimeSessionActive('rt_abc123');
    expect(await countActiveRuntimeSessions()).toBe(0);
  });

  test('idle listing respects the limit bound', async () => {
    for (let i = 0; i < 5; i++) {
      await touchRuntimeSessionActive(`rt_${i}`, i);
    }
    expect(await listIdleRuntimeSessions(10, 2)).toHaveLength(2);
  });
});
