import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as zlib from 'zlib';
import {
  SESSION_FILES_MAX_COUNT,
  SessionFilesError,
  buildSessionFilesArchive,
  sessionFileRefKey,
} from './files';

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const readOnly = new URL(req.url).pathname.includes('/objects/ro');
      return new Response('0123456789', {
        status: 200,
        headers: readOnly ? { 'X-Read-Only': 'true' } : {},
      });
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

describe('buildSessionFilesArchive limits', () => {
  test('rejects deliveries above the file-count cap before any fetch', async () => {
    const refs = Array.from({ length: SESSION_FILES_MAX_COUNT + 1 }, (_, i) => ref(i));
    await expect(buildSessionFilesArchive(refs, opts())).rejects.toThrow(SessionFilesError);
  });

  test('enforces a CUMULATIVE uncompressed budget, not just per-file size', async () => {
    /* Three 10-byte objects against a 25-byte budget: the per-fetch
     * maxContentLength alone would admit all of them. */
    await expect(
      buildSessionFilesArchive([ref(1), ref(2), ref(3)], opts({ maxBytes: 25 })),
    ).rejects.toThrow('delivery budget');
  });

  test('honors an aborted signal instead of consuming disk and bandwidth', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildSessionFilesArchive([ref(1)], opts({ signal: controller.signal })),
    ).rejects.toThrow('aborted');
  });

  test('rejects traversal names outright', async () => {
    await expect(
      buildSessionFilesArchive(
        [{ id: 'f1', storage_session_id: 's1', name: '../escape.txt' }],
        opts(),
      ),
    ).rejects.toThrow('Unsafe input file name');
  });

  test('reports writable refs as delivered keys and excludes read-only refs', async () => {
    const writable = ref('w1');
    const readOnly = { id: 'ro1', storage_session_id: 's1', name: 'skill.md' };
    const archive = await buildSessionFilesArchive([writable, readOnly], opts());
    expect(archive?.deliveredKeys).toEqual([sessionFileRefKey(writable)]);
    const untarred = zlib.gunzipSync(archive!.data).toString('latin1');
    expect(untarred).toContain('session/skill.md');
    expect(untarred).toContain('"read_only":true');
  });
});
