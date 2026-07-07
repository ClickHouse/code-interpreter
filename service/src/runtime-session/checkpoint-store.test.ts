import { describe, expect, test } from 'bun:test';
import { MemoryCheckpointStore, CheckpointTooLargeError, checkpointObjectKey } from './checkpoint-store';

const BIG = 1_000_000;

describe('checkpoint store', () => {
  test('object key is deterministic per runtime session under the prefix', () => {
    expect(checkpointObjectKey('rt_abc')).toBe('rtsx-checkpoints/rt_abc.tar.gz');
    expect(checkpointObjectKey('rt_abc')).toBe(checkpointObjectKey('rt_abc'));
    expect(checkpointObjectKey('rt_xyz')).not.toBe(checkpointObjectKey('rt_abc'));
  });

  test('memory store round-trips bytes and copies defensively', async () => {
    const store = new MemoryCheckpointStore();
    const original = Buffer.from('workspace-bytes');
    await store.put('rt_1', original);

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

  test('last-writer-wins on the same key', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', Buffer.from('v1'));
    await store.put('rt_1', Buffer.from('v2'));
    expect((await store.get('rt_1', BIG))?.toString()).toBe('v2');
  });

  test('rejects a checkpoint larger than maxBytes', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_big', Buffer.alloc(2048));
    await expect(store.get('rt_big', 1024)).rejects.toBeInstanceOf(CheckpointTooLargeError);
  });
});
