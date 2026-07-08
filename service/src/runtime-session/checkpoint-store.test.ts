import { describe, expect, test } from 'bun:test';
import {
  MemoryCheckpointStore,
  CheckpointTooLargeError,
  checkpointObjectKey,
  checkpointPrefixFor,
} from './checkpoint-store';

const BIG = 1_000_000;

describe('checkpoint store', () => {
  test('object key is per session + sequence, zero-padded for lexical order', () => {
    expect(checkpointObjectKey('rt_abc', 1)).toBe('rtsx-checkpoints/rt_abc/00000000000000000001.tar.gz');
    expect(checkpointPrefixFor('rt_abc')).toBe('rtsx-checkpoints/rt_abc/');
    /* zero-padding keeps lexical order == numeric sequence order across widths */
    expect(checkpointObjectKey('rt_abc', 2) > checkpointObjectKey('rt_abc', 1)).toBe(true);
    expect(checkpointObjectKey('rt_abc', 10) > checkpointObjectKey('rt_abc', 9)).toBe(true);
    expect(checkpointObjectKey('rt_xyz', 1)).not.toBe(checkpointObjectKey('rt_abc', 1));
  });

  test('memory store round-trips the highest-sequence bytes and copies defensively', async () => {
    const store = new MemoryCheckpointStore();
    const original = Buffer.from('workspace-bytes');
    await store.put('rt_1', 1, original);

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

  test('get reads the highest sequence, not the last write', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 2, Buffer.from('newer'));
    /* a crash-orphaned put from a LOWER sequence lands late but must NOT win */
    await store.put('rt_1', 1, Buffer.from('stale'));
    expect((await store.get('rt_1', BIG))?.toString()).toBe('newer');
  });

  test('latestSequence reports the max retained sequence (for reset seeding)', async () => {
    const store = new MemoryCheckpointStore();
    expect(await store.latestSequence('rt_1')).toBe(0);
    await store.put('rt_1', 5, Buffer.from('v5'));
    expect(await store.latestSequence('rt_1')).toBe(5);
    /* other sessions don't leak into this one's max */
    await store.put('rt_2', 9, Buffer.from('v9'));
    expect(await store.latestSequence('rt_1')).toBe(5);
  });

  test('put prunes strictly-older sequences for the session', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', 1, Buffer.from('v1'));
    await store.put('rt_1', 2, Buffer.from('v2'));
    await store.put('rt_other', 1, Buffer.from('other'));
    const keys = [...store.objects.keys()];
    expect(keys).toContain(checkpointObjectKey('rt_1', 2));
    expect(keys).not.toContain(checkpointObjectKey('rt_1', 1));
    expect(keys).toContain(checkpointObjectKey('rt_other', 1));
  });

  test('rejects a checkpoint larger than maxBytes', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_big', 1, Buffer.alloc(2048));
    await expect(store.get('rt_big', 1024)).rejects.toBeInstanceOf(CheckpointTooLargeError);
  });
});
