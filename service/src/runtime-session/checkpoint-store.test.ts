import { describe, expect, test } from 'bun:test';
import { MemoryCheckpointStore, checkpointObjectKey } from './checkpoint-store';

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

    const fetched = await store.get('rt_1');
    expect(fetched?.toString()).toBe('workspace-bytes');
    /* stored copy is independent of the caller's buffer */
    original.fill(0);
    expect((await store.get('rt_1'))?.toString()).toBe('workspace-bytes');
  });

  test('absent checkpoint returns null', async () => {
    const store = new MemoryCheckpointStore();
    expect(await store.get('rt_missing')).toBeNull();
  });

  test('last-writer-wins on the same key', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_1', Buffer.from('v1'));
    await store.put('rt_1', Buffer.from('v2'));
    expect((await store.get('rt_1'))?.toString()).toBe('v2');
  });
});
