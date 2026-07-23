import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  SESSION_INPUTS_MAX_COUNT,
  SessionFilesError,
  buildInputBatch,
  inputCacheKey,
  sessionFileRefs,
} from './files';

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const readOnly = new URL(req.url).pathname.includes('/objects/ro');
      const headers: Record<string, string> = { 'X-Original-Filename': 'server-name.txt' };
      if (readOnly) headers['X-Read-Only'] = 'true';
      return new Response('0123456789', { status: 200, headers });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

const opts = (overrides: Partial<{ maxBytes: number; signal: AbortSignal }> = {}) => ({
  timeoutMs: 5_000,
  maxBytes: 1024 * 1024,
  fileServerUrl: `http://localhost:${server.port}`,
  ...overrides,
});

const ref = (n: number | string) => ({
  id: `f${n}`,
  storage_session_id: 's1',
  name: `file-${n}.txt`,
});

/** Lists member names of a produced batch. */
async function membersOf(data: Buffer): Promise<string[]> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'batch-check-'));
  try {
    const archive = path.join(tmp, 'b.tgz');
    await fsp.writeFile(archive, data);
    spawnSync('tar', ['-xzf', archive, '-C', tmp]);
    await fsp.rm(archive);
    return (await fsp.readdir(tmp)).sort();
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

describe('sessionFileRefs', () => {
  test('collapses the same object requested under multiple names', () => {
    /* Identity is (storage session, id): one delivery, and priming writes it
     * to each requested path. Two entries would push the same bytes twice. */
    const refs = sessionFileRefs([
      { id: 'f1', storage_session_id: 's1', name: 'a.csv' },
      { id: 'f1', storage_session_id: 's1', name: 'copy/a.csv' },
      { id: 'f2', storage_session_id: 's1', name: 'b.csv' },
      { name: 'inline.py', content: 'print(1)' },
    ]);
    expect(refs.map((r) => r.id)).toEqual(['f1', 'f2']);
  });
});

describe('buildInputBatch', () => {
  test('packs digest-named members with metadata the runner can serve', async () => {
    const batch = await buildInputBatch([ref(1)], opts());
    expect(batch?.count).toBe(1);
    const key = inputCacheKey('s1', 'f1');
    expect(await membersOf(batch!.data)).toEqual([key, `${key}.json`].sort());
  });

  test('carries the file server original name and read-only bit', async () => {
    const batch = await buildInputBatch(
      [{ id: 'ro', storage_session_id: 's1', name: 'skill.md' }],
      opts(),
    );
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'meta-check-'));
    const archive = path.join(tmp, 'b.tgz');
    await fsp.writeFile(archive, batch!.data);
    spawnSync('tar', ['-xzf', archive, '-C', tmp]);
    const meta = JSON.parse(
      await fsp.readFile(path.join(tmp, `${inputCacheKey('s1', 'ro')}.json`), 'utf8'),
    );
    await fsp.rm(tmp, { recursive: true, force: true });
    expect(meta).toEqual({ name: 'server-name.txt', readOnly: true });
  });

  test('rejects deliveries above the object-count cap before any fetch', async () => {
    const refs = Array.from({ length: SESSION_INPUTS_MAX_COUNT + 1 }, (_, i) => ref(i));
    await expect(buildInputBatch(refs, opts())).rejects.toThrow(SessionFilesError);
  });

  test('enforces a CUMULATIVE byte budget, not just per-object size', async () => {
    await expect(buildInputBatch([ref(1), ref(2), ref(3)], opts({ maxBytes: 25 }))).rejects.toThrow(
      'budget',
    );
  });

  test('honors an aborted signal instead of consuming disk and bandwidth', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildInputBatch([ref(1)], opts({ signal: controller.signal }))).rejects.toThrow(
      'aborted',
    );
  });
});
