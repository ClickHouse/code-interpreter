import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { Readable } from 'stream';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SANDBOX_WORKSPACE_ROOT, reapStaleWorkspaces } from './workspace-isolation';
import {
  SESSION_INPUT_CACHE_DIR,
  cachedInputResponse,
  hasCachedInput,
  inputCacheKey,
  openCachedInput,
  pruneInputCache,
  storeCachedInputs,
} from './session-inputs';

afterEach(async () => {
  await fsp.rm(SESSION_INPUT_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
});

/** Builds the digest-named batch the control plane pushes. */
async function makeBatch(
  entries: Array<{ storageSessionId: string; id: string; body: string; meta?: object }>,
  extras: Record<string, string> = {},
): Promise<Buffer> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'inputs-batch-'));
  for (const entry of entries) {
    const key = inputCacheKey(entry.storageSessionId, entry.id);
    await fsp.writeFile(path.join(tmp, key), entry.body);
    if (entry.meta) await fsp.writeFile(path.join(tmp, `${key}.json`), JSON.stringify(entry.meta));
  }
  for (const [name, body] of Object.entries(extras)) {
    await fsp.mkdir(path.dirname(path.join(tmp, name)), { recursive: true });
    await fsp.writeFile(path.join(tmp, name), body);
  }
  const tar = spawnSync('tar', ['-czf', '-', '-C', tmp, '.'], { maxBuffer: 64 * 1024 * 1024 });
  await fsp.rm(tmp, { recursive: true, force: true });
  if (tar.status !== 0) throw new Error(`fixture tar exited ${tar.status}`);
  return tar.stdout;
}

describe('pushed input cache', () => {
  test('lives outside the workspace root so the reaper cannot eat it', async () => {
    /* Regression: the cache was originally a dot-directory INSIDE
     * SANDBOX_WORKSPACE_ROOT, where the stale-workspace reaper treats every
     * entry as a workspace — it deleted pending inputs between the push and
     * the execute they were pushed for. */
    expect(SESSION_INPUT_CACHE_DIR.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)).toBe(false);

    await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true });
    const key = inputCacheKey('s1', 'survives');
    await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, key), 'bytes');
    await reapStaleWorkspaces({ maxAgeMs: 0 });
    expect(await hasCachedInput('s1', 'survives')).toBe(true);
  });

  test('stores a batch and serves it as the response a fetch would have returned', async () => {
    const batch = await makeBatch([
      { storageSessionId: 's1', id: 'f1', body: 'a,b\n1,2\n', meta: { name: 'data.csv' } },
      { storageSessionId: 's1', id: 'ro', body: 'SKILL\n', meta: { name: 'skill.md', readOnly: true } },
    ]);
    expect(await storeCachedInputs(Readable.from(batch))).toBe(2);

    expect(await hasCachedInput('s1', 'f1')).toBe(true);
    expect(await hasCachedInput('s1', 'nope')).toBe(false);

    const hit = await openCachedInput('s1', 'f1');
    expect(hit).not.toBeNull();
    const response = cachedInputResponse(hit!);
    /* Priming reads the name from Content-Disposition and the read-only bit
     * from X-Read-Only, exactly as it does for a file-server response. */
    expect(response.headers.get('content-disposition')).toContain('data.csv');
    expect(response.headers.get('x-read-only')).toBeNull();
    expect(await response.text()).toBe('a,b\n1,2\n');

    const readOnly = cachedInputResponse((await openCachedInput('s1', 'ro'))!);
    expect(readOnly.headers.get('x-read-only')).toBe('true');
  });

  test('rejects a batch containing anything but digest-named flat members', async () => {
    /* Names are runner-computed digests, so a traversal attempt is not a path
     * problem to solve — it is simply not a legal member name. Any member that
     * is not `<64 hex>[.json]` fails the whole batch, and nothing lands. */
    const cases: Array<Record<string, string>> = [
      { 'notadigest.txt': 'nope' },
      { 'nested/deep.txt': 'nope' },
    ];
    for (const extras of cases) {
      const batch = await makeBatch([{ storageSessionId: 's1', id: 'f1', body: 'ok' }], extras);
      await expect(storeCachedInputs(Readable.from(batch))).rejects.toThrow();
      expect(await hasCachedInput('s1', 'f1')).toBe(false);
    }
  });

  test('a corrupt metadata sidecar still yields usable bytes', async () => {
    const key = inputCacheKey('s1', 'f1');
    await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true });
    await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, key), 'payload');
    await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, `${key}.json`), '{not json');

    const hit = await openCachedInput('s1', 'f1');
    expect(hit).not.toBeNull();
    expect(await cachedInputResponse(hit!).text()).toBe('payload');
  });

  test('eviction drops least-recently-used entries with their metadata', async () => {
    const batch = await makeBatch([
      { storageSessionId: 's1', id: 'old', body: 'x'.repeat(4096), meta: { name: 'old.bin' } },
      { storageSessionId: 's1', id: 'new', body: 'y'.repeat(4096), meta: { name: 'new.bin' } },
    ]);
    await storeCachedInputs(Readable.from(batch));
    const oldKey = inputCacheKey('s1', 'old');
    /* Backdate the older entry so LRU ordering is deterministic. */
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(path.join(SESSION_INPUT_CACHE_DIR, oldKey), past, past);

    await pruneInputCache(5000);

    expect(await hasCachedInput('s1', 'old')).toBe(false);
    expect(await hasCachedInput('s1', 'new')).toBe(true);
    /* The sidecar must go with its object, or metadata leaks forever. */
    expect(
      await fsp.lstat(path.join(SESSION_INPUT_CACHE_DIR, `${oldKey}.json`)).catch(() => null),
    ).toBeNull();
  });
});
