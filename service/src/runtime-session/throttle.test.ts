import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import {
  MicrovmOpThrottledError,
  acquireOpBudget,
  poisonOpBucket,
  resetRedisForTests,
  setRedisForTests,
} from './throttle';

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

/** Virtual clock: sleep() advances time instead of waiting. */
function virtualClock(startMs = 1_000_000_000_000): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let t = startMs;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('acquireOpBudget', () => {
  test('grants slots under the per-second limit without sleeping', async () => {
    const clock = virtualClock();
    for (let i = 0; i < 4; i++) {
      await acquireOpBudget('run', { limitPerSecond: 4, budgetMs: 5_000, now: clock.now, sleep: clock.sleep });
    }
    expect(clock.slept).toHaveLength(0);
  });

  test('the (limit+1)th call in one second waits into the next second', async () => {
    const clock = virtualClock();
    for (let i = 0; i < 5; i++) {
      await acquireOpBudget('run', { limitPerSecond: 4, budgetMs: 5_000, now: clock.now, sleep: clock.sleep });
    }
    expect(clock.slept.length).toBeGreaterThanOrEqual(1);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(1_000);
    expect(clock.slept[0]).toBeLessThan(1_200);
  });

  test('throws MicrovmOpThrottledError when the budget cannot cover the wait', async () => {
    const clock = virtualClock();
    for (let i = 0; i < 4; i++) {
      await acquireOpBudget('run', { limitPerSecond: 4, budgetMs: 5_000, now: clock.now, sleep: clock.sleep });
    }
    expect(
      acquireOpBudget('run', { limitPerSecond: 4, budgetMs: 100, now: clock.now, sleep: clock.sleep }),
    ).rejects.toThrow(MicrovmOpThrottledError);
  });

  test('ops have independent buckets', async () => {
    const clock = virtualClock();
    await acquireOpBudget('suspend', { limitPerSecond: 1, budgetMs: 100, now: clock.now, sleep: clock.sleep });
    await acquireOpBudget('run', { limitPerSecond: 1, budgetMs: 100, now: clock.now, sleep: clock.sleep });
    expect(clock.slept).toHaveLength(0);
  });

  test('a poisoned bucket blocks until it clears, then grants', async () => {
    const clock = virtualClock();
    await poisonOpBucket('run', 60_000);
    expect(
      acquireOpBudget('run', { limitPerSecond: 4, budgetMs: 200, now: clock.now, sleep: clock.sleep }),
    ).rejects.toThrow(MicrovmOpThrottledError);

    await mock.del('rtsx:tps:poison:run');
    await acquireOpBudget('run', { limitPerSecond: 4, budgetMs: 200, now: clock.now, sleep: clock.sleep });
  });

  test('cancellation interrupts a real throttle wait immediately', async () => {
    await poisonOpBucket('run', 60_000);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('job deadline')), 10);

    await expect(acquireOpBudget('run', {
      limitPerSecond: 4,
      budgetMs: 120_000,
      signal: controller.signal,
    })).rejects.toThrow('job deadline');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
