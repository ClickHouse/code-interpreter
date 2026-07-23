import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { Readable } from 'stream';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import type { SandboxJobIdentity } from './workspace-isolation';
import type { SessionWorkspace } from './session-workspace';
import { SANDBOX_WORKSPACE_ROOT, SESSION_WORKSPACE_ID, fallbackSandboxIdentity } from './workspace-isolation';
import { restoreSessionCheckpoint, streamSessionCheckpoint } from './session-checkpoint';
import { bindSessionWorkspace, resetSessionWorkspaceStateForTests, unbindSessionWorkspace } from './session-workspace';

const savedEnabled = config.session_workspace_enabled;
const savedPerJob = config.per_job_uids;

afterEach(async () => {
  config.session_workspace_enabled = savedEnabled;
  config.per_job_uids = savedPerJob;
  await unbindSessionWorkspace().catch(() => {});
  resetSessionWorkspaceStateForTests();
  await fsp
    .rm(path.join(SANDBOX_WORKSPACE_ROOT, SESSION_WORKSPACE_ID), { recursive: true, force: true })
    .catch(() => {});
});

/** CI and local dev run bun as a non-root user, where the default per-job-UID
 *  configuration requires root for workspace chowns. Switch the session to the
 *  shared fallback identity (perJobUid=false) and flip the config flag the
 *  workspace-root preparation consults, so skipped chowns degrade to
 *  compatibility modes — the same degradation the runner itself applies when
 *  running unprivileged outside hardened mode. */
function seedNonRootIdentity(session: SessionWorkspace): void {
  config.per_job_uids = false;
  (session as unknown as { identity?: SandboxJobIdentity }).identity = fallbackSandboxIdentity();
}

/** Minimal Express response double capturing status + json body. */
function fakeRes(): { status: number; body: unknown; setHeader: () => void; destroy: () => void } & {
  status(code: number): { json(body: unknown): void };
} {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: () => {},
    destroy: () => {},
    status(code: number) {
      res.statusCode = code;
      return {
        json(body: unknown) { res.body = body; },
      };
    },
  };
  return res as never;
}

function fakeStreamRes(): { statusCode: number; body: unknown; headersSent: boolean } & {
  status(code: number): { json(body: unknown): void };
} {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return {
        json(body: unknown) { res.body = body; res.headersSent = true; },
      };
    },
  };
  return res as never;
}

/** Builds a real tar.gz whose members live under a leading `session/` dir,
 *  matching the archive shape the checkpoint create side produces. */
async function makeArchive(files: Record<string, string>): Promise<Buffer> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sess-ckpt-'));
  const stage = path.join(tmp, 'session');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(stage, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  const tar = spawnSync('tar', ['-czf', '-', '-C', tmp, 'session'], { maxBuffer: 64 * 1024 * 1024 });
  await fsp.rm(tmp, { recursive: true, force: true });
  if (tar.status !== 0) throw new Error(`fixture tar exited ${tar.status}`);
  return tar.stdout;
}

describe('session checkpoint gating', () => {
  test('checkpoint is 409 when no session is bound', async () => {
    const res = fakeRes();
    await streamSessionCheckpoint(res as never);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(409);
  });

  test('restore is 409 when no session is bound', async () => {
    const res = fakeRes();
    await restoreSessionCheckpoint({} as never, res as never);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(409);
  });
});

describe('restoreSessionCheckpoint', () => {
  test('replaces the workspace with the archive contents', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_1' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    /* Restore is a full replace, unlike input delivery: state predating the
     * checkpoint must not survive it. */
    await fsp.writeFile(path.join(dir, 'stale.txt'), 'from-a-previous-life');

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(await makeArchive({ 'restored.csv': 'a,b\n1,2\n' })) as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(await fsp.readFile(path.join(dir, 'restored.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(await fsp.lstat(path.join(dir, 'stale.txt')).catch(() => null)).toBeNull();
  });

  test('a corrupt archive fails and leaves a clean slate', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_2' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(Buffer.from('not a tarball')) as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    /* The control plane treats restore failure as recyclable, so the workspace
     * is wiped rather than left holding half an archive. */
    expect(await fsp.readdir(dir).catch(() => [])).toEqual([]);
  });
});
