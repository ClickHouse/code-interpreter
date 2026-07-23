import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import express from 'express';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import v2Router from './v2';
import { SESSION_INPUT_CACHE_DIR, inputCacheKey } from '../session-inputs';

/**
 * Route-level coverage for input delivery. The unit suites exercise the cache
 * itself; this exercises the WIRING — body parsing, the JSON gate's tar
 * exemption, and mount paths — which is where a live-only failure hid: the
 * probe route had no parser (there is no global one), so every ref list came
 * back "refs must be an array".
 */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  /* Mirror index.ts: no global JSON parser, router mounted under /api/v2. */
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/v2', v2Router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await fsp.rm(SESSION_INPUT_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
});

async function makeBatch(entries: Array<{ sid: string; id: string; body: string }>): Promise<Buffer> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'route-batch-'));
  for (const entry of entries) {
    const key = inputCacheKey(entry.sid, entry.id);
    await fsp.writeFile(path.join(tmp, key), entry.body);
    await fsp.writeFile(path.join(tmp, `${key}.json`), JSON.stringify({ name: `${entry.id}.txt` }));
  }
  const tar = spawnSync('tar', ['-czf', '-', '-C', tmp, '.'], { maxBuffer: 16 * 1024 * 1024 });
  await fsp.rm(tmp, { recursive: true, force: true });
  return tar.stdout;
}

const probe = (refs: unknown) =>
  fetch(`${baseUrl}/api/v2/session/inputs/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  });

describe('input delivery routes', () => {
  test('probe parses its body and reports everything missing on a cold VM', async () => {
    const response = await probe([{ storage_session_id: 's1', id: 'f1' }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ missing: [{ storage_session_id: 's1', id: 'f1' }] });
  });

  test('a pushed batch flips the probe answer to nothing missing', async () => {
    const push = await fetch(`${baseUrl}/api/v2/session/inputs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-gtar' },
      body: await makeBatch([{ sid: 's1', id: 'f1', body: 'bytes' }]),
    });
    expect(push.status).toBe(200);
    expect(await push.json()).toEqual({ stored: 1 });

    const after = await probe([
      { storage_session_id: 's1', id: 'f1' },
      { storage_session_id: 's1', id: 'f2' },
    ]);
    /* Only the object the VM actually holds is skipped — dedupe is the VM's
     * answer, never control-plane bookkeeping. */
    expect(await after.json()).toEqual({ missing: [{ storage_session_id: 's1', id: 'f2' }] });
  });

  test('probe rejects a malformed ref list rather than guessing', async () => {
    expect((await probe('nope')).status).toBe(400);
    expect((await probe([{ storage_session_id: 's1' }])).status).toBe(400);
  });
});
