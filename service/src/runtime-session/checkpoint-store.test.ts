import { describe, expect, test } from 'bun:test';
import {
  MemoryCheckpointStore,
  CheckpointTooLargeError,
  checkpointObjectKey,
  checkpointPrefixFor,
} from './checkpoint-store';

const BIG = 1_000_000;

describe('checkpoint store', () => {
  test('object key is per session + timestamp, zero-padded for lexical order', () => {
    expect(checkpointObjectKey('rt_abc', 1)).toBe('rtsx-checkpoints/rt_abc/000000000000001.tar.gz');
    expect(checkpointPrefixFor('rt_abc')).toBe('rtsx-checkpoints/rt_abc/');
    /* zero-padding keeps lexical order == chronological order across widths */
    expect(checkpointObjectKey('rt_abc', 2) > checkpointObjectKey('rt_abc', 1)).toBe(true);
    expect(checkpointObjectKey('rt_abc', 10) > checkpointObjectKey('rt_abc', 9)).toBe(true);
    expect(checkpointObjectKey('rt_abc', 1_783_000_000_000) > checkpointObjectKey('rt_abc', 999)).toBe(true);
    expect(checkpointObjectKey('rt_xyz', 1)).not.toBe(checkpointObjectKey('rt_abc', 1));
  });

  test('memory store round-trips the newest bytes and copies defensively', async () => {
    const store = new MemoryCheckpointStore();
    const original = Buffer.from('workspace-bytes');
    await store.put('rt_1', 1000, original);

    const fetched = await store.get('rt_1', BIG);
    expect(fetched?.toString()).toBe('workspace-bytes');
    /* stored copy is independent of the caller's buffer */
    original.fill(0);
    expect((await store.get('rt_1', BIG))?.toString()).toBe('workspace-bytes');
  });

  test('absent checkpoint returns null', async () => {
    const store = new MemoryCheckpointStore();
    expect(await store.get('rt_missing', BIG)).toBeNull();
  });

  test('get reads the newest timestamp, not the last write', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 2000, Buffer.from('newer'));
    /* a stale put carrying an EARLIER start time lands late but must NOT win —
     * and a fresh checkpoint after an idle gap (later timestamp) always does */
    await store.put('rt_1', 1000, Buffer.from('stale'));
    expect((await store.get('rt_1', BIG))?.toString()).toBe('newer');
  });

  test('put prunes older timestamps for the session', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 1000, Buffer.from('v1'));
    await store.put('rt_1', 2000, Buffer.from('v2'));
    /* only the newest object survives; siblings for other sessions are untouched */
    await store.put('rt_other', 1000, Buffer.from('other'));
    const keys = [...store.objects.keys()];
    expect(keys).toContain(checkpointObjectKey('rt_1', 2000));
    expect(keys).not.toContain(checkpointObjectKey('rt_1', 1000));
    expect(keys).toContain(checkpointObjectKey('rt_other', 1000));
  });

  test('rejects a checkpoint larger than maxBytes', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_big', 1000, Buffer.alloc(2048));
    await expect(store.get('rt_big', 1024)).rejects.toBeInstanceOf(CheckpointTooLargeError);
  });
});
