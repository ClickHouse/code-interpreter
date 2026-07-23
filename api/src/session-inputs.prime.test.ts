import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Job, type TFile } from './job';
import { SESSION_INPUT_CACHE_DIR, inputCacheKey } from './session-inputs';

/**
 * The seam that makes the redesign work: a pushed cache entry must prime
 * exactly as a file-server fetch would. Unit tests cover the cache, and route
 * tests cover the wiring — this covers the join, which is where a live-only
 * failure hid.
 */

let tmpDir: string;

afterEach(async () => {
  await fsp.rm(SESSION_INPUT_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function seedCache(sid: string, id: string, body: string, meta: object): Promise<void> {
  await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true });
  const key = inputCacheKey(sid, id);
  await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, key), body);
  await fsp.writeFile(path.join(SESSION_INPUT_CACHE_DIR, `${key}.json`), JSON.stringify(meta));
}

function makeJob(files: TFile[]): Job {
  return new Job({
    session_id: 'prime-cache-test',
    runtime: { language: 'bash', version: '5.0.0', aliases: [], runtime: 'bash' } as never,
    args: [],
    stdin: '',
    files,
    timeouts: { run: 5000, compile: 5000 },
    cpu_times: { run: 5000, compile: 5000 },
    memory_limits: { run: 128 * 1024 * 1024, compile: 128 * 1024 * 1024 },
  } as never);
}

describe('priming from the pushed input cache', () => {
  test('writes the cached bytes under the requested name without any HTTP fetch', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prime-cache-'));
    await seedCache('s1', 'f1', 'a,b\n1,2\n', { name: 'data.csv' });

    const file: TFile = { id: 'f1', storage_session_id: 's1', name: 'data.csv' };
    const job = makeJob([file]);
    (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

    /* A fetch would fail here: no file server is configured in tests, so a
     * successful write proves the bytes came from the cache. */
    const written = await job.downloadAndWriteFile(file);
    expect(written).toBe('data.csv');
    expect(await fsp.readFile(path.join(tmpDir, 'data.csv'), 'utf8')).toBe('a,b\n1,2\n');
  });

  test('honors the cached read-only bit and original name', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prime-cache-ro-'));
    await seedCache('s1', 'ro', 'SKILL\n', { name: 'renamed-by-server.md', readOnly: true });

    const file: TFile = { id: 'ro', storage_session_id: 's1', name: 'requested.md' };
    const job = makeJob([file]);
    (job as unknown as { submissionDir: string }).submissionDir = tmpDir;

    /* Content-Disposition parity: the server's name wins over the requested
     * one, exactly as it does on the pull path. */
    const written = await job.downloadAndWriteFile(file);
    expect(written).toBe('renamed-by-server.md');
    const stat = await fsp.lstat(path.join(tmpDir, 'renamed-by-server.md'));
    expect(stat.mode & 0o777).toBe(0o444);
  });
});
