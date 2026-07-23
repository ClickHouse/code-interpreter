import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { PassThrough, Readable } from 'stream';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import type { SandboxJobIdentity } from './workspace-isolation';
import type { SessionWorkspace } from './session-workspace';
import { SANDBOX_WORKSPACE_ROOT, SESSION_WORKSPACE_ID, fallbackSandboxIdentity } from './workspace-isolation';
import { restoreSessionCheckpoint, streamSessionCheckpoint } from './session-checkpoint';
import {
  SESSION_META_FILE,
  SESSION_META_MARKER,
  bindSessionWorkspace,
  resetSessionWorkspaceStateForTests,
  unbindSessionWorkspace,
} from './session-workspace';

const savedEnabled = config.session_workspace_enabled;
const savedPerJob = config.per_job_uids;
const savedCheckpointMaxBytes = config.checkpoint_max_bytes;
const CHECKPOINT_CONTROL_FILE = '.codeapi-checkpoint-control.v2.json';
const CHECKPOINT_CONTROL_MAX_BYTES = 16 * 1024 * 1024;

afterEach(async () => {
  config.session_workspace_enabled = savedEnabled;
  config.per_job_uids = savedPerJob;
  config.checkpoint_max_bytes = savedCheckpointMaxBytes;
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

type CheckpointCaptureResponse = PassThrough & {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): CheckpointCaptureResponse;
  json(body: unknown): CheckpointCaptureResponse;
  setHeader(): CheckpointCaptureResponse;
};

function checkpointCaptureRes(): {
  res: CheckpointCaptureResponse;
  archive(): Buffer;
} {
  const chunks: Buffer[] = [];
  const res = new PassThrough() as CheckpointCaptureResponse;
  res.statusCode = 0;
  res.body = undefined;
  res.headersSent = false;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    res.headersSent = true;
    res.end();
    return res;
  };
  res.setHeader = () => res;
  res.on('data', (chunk: Buffer) => {
    res.headersSent = true;
    chunks.push(Buffer.from(chunk));
  });
  return { res, archive: () => Buffer.concat(chunks) };
}

function readArchiveMember(archive: Buffer, member: string): Buffer {
  const extracted = spawnSync(
    'tar',
    ['-xOzf', '-', member],
    { input: archive, maxBuffer: 64 * 1024 * 1024 },
  );
  if (extracted.status !== 0) {
    throw new Error(`fixture tar extraction exited ${extracted.status}`);
  }
  return extracted.stdout;
}

/** Builds a real tar.gz whose members live under a leading `session/` dir,
 *  matching the archive shape the checkpoint create side produces. */
async function makeArchive(
  files: Record<string, string>,
  topLevelFiles: Record<string, string> = {},
): Promise<Buffer> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sess-ckpt-'));
  const stage = path.join(tmp, 'session');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(stage, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  for (const [name, content] of Object.entries(topLevelFiles)) {
    await fsp.writeFile(path.join(tmp, name), content);
  }
  const tar = spawnSync(
    'tar',
    ['-czf', '-', '-C', tmp, 'session', ...Object.keys(topLevelFiles)],
    { maxBuffer: 64 * 1024 * 1024 },
  );
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

  test('checkpoint is 409 while the bound workspace is dirty', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_checkpoint_dirty' });
    seedNonRootIdentity(session!);
    session!.markDirty('partial input delivery');

    const res = fakeRes();
    await streamSessionCheckpoint(res as never);

    expect((res as unknown as { statusCode: number }).statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'session_workspace_dirty',
      message: 'Session workspace must be restored before checkpointing',
    });
  });
});

describe('streamSessionCheckpoint', () => {
  test('retains accumulated surfaced state while the full control record fits', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_checkpoint_surfaced_cap' });
    seedNonRootIdentity(session!);
    await session!.ownership();
    session!.markPrimed('input.csv', 'stable-cache-key', false, 'original-hash');
    for (let i = 0; i < 4_000; i++) {
      const suffix = `${i}-${'s'.repeat(80)}`;
      session!.markSurfaced(`generated/${suffix}.txt`, `signature-${suffix}`);
    }

    const capture = checkpointCaptureRes();
    await streamSessionCheckpoint(capture.res as never);

    expect(capture.res.statusCode).toBe(200);
    const control = JSON.parse(
      readArchiveMember(capture.archive(), CHECKPOINT_CONTROL_FILE).toString(),
    );
    expect(control.marker).toBe(SESSION_META_MARKER);
    expect(control.primed).toEqual([[
      'input.csv',
      { id: 'stable-cache-key', readOnly: false, hash: 'original-hash' },
    ]]);
    expect(control.surfaced).toHaveLength(4_000);
  });

  test('round-trips control state larger than the old 256 KiB ceiling', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_checkpoint_control_cap' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    await fsp.writeFile(path.join(dir, 'current.txt'), 'current workspace bytes');

    /* Both maps exceed the old control budget. The bounded parser can safely
     * carry this recovery state, so neither map should be degraded. */
    for (let i = 0; i < 4_000; i++) {
      const suffix = `${i}-${'s'.repeat(80)}`;
      session!.markSurfaced(`generated/${suffix}.txt`, `signature-${suffix}`);
      session!.markPrimed(
        `inputs/${suffix}.txt`,
        `cache-key-${suffix}`,
        false,
        `hash-${suffix}`,
      );
    }
    expect(
      Buffer.byteLength(JSON.stringify({
        marker: SESSION_META_MARKER,
        ...session!.snapshotMeta(),
      })),
    ).toBeGreaterThan(256 * 1024);
    expect(
      Buffer.byteLength(JSON.stringify({
        marker: SESSION_META_MARKER,
        primed: session!.snapshotMeta().primed,
        surfaced: [],
      })),
    ).toBeGreaterThan(256 * 1024);

    const capture = checkpointCaptureRes();
    await streamSessionCheckpoint(capture.res as never);

    expect(capture.res.statusCode).toBe(200);
    const archive = capture.archive();
    expect(readArchiveMember(archive, 'session/current.txt').toString())
      .toBe('current workspace bytes');
    const control = readArchiveMember(archive, CHECKPOINT_CONTROL_FILE);
    const parsed = JSON.parse(control.toString());
    expect(parsed.marker).toBe(SESSION_META_MARKER);
    expect(parsed.surfaced).toHaveLength(4_000);
    expect(parsed.primed).toHaveLength(4_000);

    /* Prove the recovery point rebuilds the primed identity used by the next
     * execute to preserve an in-place-modified input instead of downloading
     * the original over it. */
    session!.loadMeta({ primed: [], surfaced: [] });
    const restoreRes = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(archive) as never,
      restoreRes as never,
    );
    expect(restoreRes.statusCode).toBe(200);
    expect(session!.primedInputId(`inputs/0-${'s'.repeat(80)}.txt`))
      .toBe(`cache-key-0-${'s'.repeat(80)}`);
  });

  test('drops surfaced state only beyond the hard cap and preserves primed identity', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_checkpoint_hard_cap' });
    seedNonRootIdentity(session!);
    await session!.ownership();
    session!.markPrimed('input.csv', 'stable-cache-key', false, 'original-hash');
    session!.markSurfaced('generated/huge.txt', 's'.repeat(CHECKPOINT_CONTROL_MAX_BYTES));

    const capture = checkpointCaptureRes();
    await streamSessionCheckpoint(capture.res as never);

    expect(capture.res.statusCode).toBe(200);
    const control = JSON.parse(
      readArchiveMember(capture.archive(), CHECKPOINT_CONTROL_FILE).toString(),
    );
    expect(control).toEqual({
      marker: SESSION_META_MARKER,
      primed: [[
        'input.csv',
        { id: 'stable-cache-key', readOnly: false, hash: 'original-hash' },
      ]],
      surfaced: [],
    });
  });
});

describe('restoreSessionCheckpoint', () => {
  test('round-trips control metadata without touching a user file at the legacy path', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_checkpoint_roundtrip' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    const userFile = JSON.stringify({
      marker: SESSION_META_MARKER,
      primed: [['user-trap.csv', {
        id: 'user-controlled-id',
        readOnly: false,
      }]],
      surfaced: [],
    });
    await fsp.writeFile(path.join(dir, SESSION_META_FILE), userFile);
    await fsp.writeFile(path.join(dir, 'session-meta.json'), 'rollback-sensitive-user-data');
    await fsp.writeFile(path.join(dir, 'input.csv'), 'sandbox-modified');
    session!.markPrimed('input.csv', 'stable-cache-key', false, 'original-hash');
    session!.markSurfaced('output.csv', 'output-hash');

    const capture = checkpointCaptureRes();
    await streamSessionCheckpoint(capture.res as never);

    expect(capture.res.statusCode).toBe(200);
    expect(await fsp.readFile(path.join(dir, SESSION_META_FILE), 'utf8')).toBe(userFile);
    const archive = capture.archive();

    /* A pre-control-metadata image restores with --strip-components=1. The
     * runner control member must be a single top-level component so that old
     * tar skips it instead of extracting/overwriting `session-meta.json`. */
    const legacyRestore = await fsp.mkdtemp(path.join(os.tmpdir(), 'legacy-restore-'));
    try {
      const legacyTar = spawnSync(
        'tar',
        ['-xzf', '-', '--strip-components=1', '-C', legacyRestore],
        { input: archive, maxBuffer: 64 * 1024 * 1024 },
      );
      expect(legacyTar.status).toBe(0);
      expect(await fsp.readFile(path.join(legacyRestore, 'session-meta.json'), 'utf8'))
        .toBe('rollback-sensitive-user-data');
    } finally {
      await fsp.rm(legacyRestore, { recursive: true, force: true });
    }

    session!.loadMeta({ primed: [], surfaced: [] });
    const restoreRes = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(archive) as never,
      restoreRes as never,
    );

    expect(restoreRes.statusCode).toBe(200);
    expect(await fsp.readFile(path.join(dir, SESSION_META_FILE), 'utf8')).toBe(userFile);
    expect(session!.primedInputId('input.csv')).toBe('stable-cache-key');
    expect(session!.primedInputId('user-trap.csv')).toBeUndefined();
    expect(session!.isSurfaced('output.csv', 'output-hash')).toBe(true);
  });

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

  test('rejects a checkpoint upload that exceeds the runner-local compressed-byte cap', async () => {
    config.session_workspace_enabled = true;
    config.checkpoint_max_bytes = 64;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_oversized_upload' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    const archive = await makeArchive({ 'restored.csv': 'new bytes' });
    expect(archive.length).toBeGreaterThan(config.checkpoint_max_bytes);

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(Readable.from(archive) as never, res as never);

    expect(res.statusCode).toBe(500);
    expect(await fsp.readdir(dir).catch(() => [])).toEqual([]);
    expect(session!.dirtyReason).toBe('checkpoint restore failed');
  });

  test('rejects malformed metadata in a present new-format control member', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_bad_control' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    session!.markPrimed('stale.csv', 'stale-cache-key');

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(await makeArchive(
        { 'input.csv': 'sandbox-modified' },
        { [CHECKPOINT_CONTROL_FILE]: '{"marker":' },
      )) as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    expect(await fsp.readdir(dir).catch(() => [])).toEqual([]);
    expect(session!.primedInputId('stale.csv')).toBeUndefined();
    expect(session!.dirtyReason).toBe('checkpoint restore failed');
  });

  test('rejects new-format control metadata larger than 16 MiB before parsing it', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_large_control' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    const validButOversized = `${' '.repeat(CHECKPOINT_CONTROL_MAX_BYTES)}${JSON.stringify({
      marker: SESSION_META_MARKER,
      primed: [],
      surfaced: [],
    })}`;

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(await makeArchive(
        { 'input.csv': 'sandbox-modified' },
        { [CHECKPOINT_CONTROL_FILE]: validButOversized },
      )) as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    expect(await fsp.readdir(dir).catch(() => [])).toEqual([]);
    expect(session!.dirtyReason).toBe('checkpoint restore failed');
  });

  test('fails closed and clears the workspace when restored ownership cannot be applied', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_chown_failure' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    session!.markPrimed('stale.csv', 'stale-cache-key');
    const ownershipFailure = Object.assign(new Error('ownership denied'), { code: 'EPERM' });

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(await makeArchive({ 'restored.csv': 'new bytes' })) as never,
      res as never,
      {
        allowUnprivilegedOwnershipFallback: false,
        ownershipOps: {
          lchown: async () => { throw ownershipFailure; },
          chown: async () => { throw ownershipFailure; },
        },
      },
    );

    expect(res.statusCode).toBe(500);
    expect(await fsp.readdir(dir).catch(() => [])).toEqual([]);
    expect(session!.primedInputId('stale.csv')).toBeUndefined();
    expect(session!.dirtyReason).toBe('checkpoint restore failed');
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
    expect(session!.dirtyReason).toBe('checkpoint restore failed');
  });

  test('does not load or surface metadata from the incompatible v1 identity schema', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_v1' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    const v1 = JSON.stringify({
      marker: 'codeapi.session-meta.v1',
      primed: [['input.csv', {
        id: 'per-execution-masked-id',
        sessionId: 'per-execution-masked-session',
        readOnly: false,
      }]],
      surfaced: [],
    });

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(await makeArchive({
        'input.csv': 'sandbox-modified',
        [SESSION_META_FILE]: v1,
      })) as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(session!.primedInputId('input.csv')).toBeUndefined();
    expect(await fsp.lstat(path.join(dir, SESSION_META_FILE)).catch(() => null)).toBeNull();
  });

  test('restores metadata from a compatible legacy in-workspace sidecar', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_restore_legacy_v2' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    const v2 = JSON.stringify({
      marker: SESSION_META_MARKER,
      primed: [['input.csv', {
        id: 'stable-cache-key',
        readOnly: false,
        hash: 'original-hash',
      }]],
      surfaced: [['output.csv', 'output-hash']],
    });

    const res = fakeStreamRes();
    await restoreSessionCheckpoint(
      Readable.from(await makeArchive({
        'input.csv': 'sandbox-modified',
        [SESSION_META_FILE]: v2,
      })) as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(session!.primedInputId('input.csv')).toBe('stable-cache-key');
    expect(session!.isSurfaced('output.csv', 'output-hash')).toBe(true);
    expect(await fsp.lstat(path.join(dir, SESSION_META_FILE)).catch(() => null)).toBeNull();
  });
});
