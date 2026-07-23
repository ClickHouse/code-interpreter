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
import {
  SESSION_FILES_MANIFEST_FILE,
  SESSION_FILES_MANIFEST_MARKER,
  receiveSessionFiles,
  restoreSessionCheckpoint,
  streamSessionCheckpoint,
} from './session-checkpoint';
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

  test('session files delivery is 409 when no session is bound', async () => {
    const res = fakeRes();
    await receiveSessionFiles({} as never, res as never);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(409);
  });
});

/** Builds a real tar.gz whose members live under a leading `session/` dir,
 *  matching the archive shape both restore and files-delivery expect. */
async function makeArchive(files: Record<string, string>): Promise<Buffer> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sess-files-'));
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

describe('receiveSessionFiles (additive delivery)', () => {
  test('overlays uploaded files WITHOUT clearing existing workspace content', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_files_1' });
    expect(session).toBeDefined();
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    await fsp.writeFile(path.join(dir, 'existing.txt'), 'already-here');

    const archive = await makeArchive({
      'upload.csv': 'a,b\n1,2\n',
      'nested/notes.md': '# hi',
      [SESSION_FILES_MANIFEST_FILE]: JSON.stringify({
        marker: SESSION_FILES_MANIFEST_MARKER,
        files: [
          { name: 'upload.csv', id: 'file_1', storage_session_id: 'store_1' },
          { name: 'nested/notes.md', id: 'file_2', storage_session_id: 'store_1' },
        ],
      }),
    });
    const res = fakeStreamRes();
    await receiveSessionFiles(Readable.from(archive) as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(await fsp.readFile(path.join(dir, 'upload.csv'), 'utf8')).toBe('a,b\n1,2\n');
    /* Nested destinations are created no-follow and owned by the session, so
     * the sandbox UID can write beside them. */
    expect(await fsp.readFile(path.join(dir, 'nested/notes.md'), 'utf8')).toBe('# hi');
    /* The additive contract: pre-existing session state survives. */
    expect(await fsp.readFile(path.join(dir, 'existing.txt'), 'utf8')).toBe('already-here');
  });

  test('a delivery whose members do not match the manifest 1:1 is refused before mutating', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_files_mismatch' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    await fsp.writeFile(path.join(dir, 'existing.txt'), 'untouched');

    /* An extra member the manifest never declared: priming would miss it, so
     * the execute would fall to the unreachable pull path for that file. */
    const res = fakeStreamRes();
    await receiveSessionFiles(
      Readable.from(await makeArchive({
        'listed.csv': 'a\n',
        'stowaway.sh': 'echo hi\n',
        [SESSION_FILES_MANIFEST_FILE]: JSON.stringify({
          marker: SESSION_FILES_MANIFEST_MARKER,
          files: [{ name: 'listed.csv', id: 'file_1', storage_session_id: 'store_1' }],
        }),
      })) as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    /* Validation runs before any commit, so nothing landed. */
    expect(await fsp.lstat(path.join(dir, 'listed.csv')).catch(() => null)).toBeNull();
    expect(await fsp.lstat(path.join(dir, 'stowaway.sh')).catch(() => null)).toBeNull();
    expect(await fsp.readFile(path.join(dir, 'existing.txt'), 'utf8')).toBe('untouched');
    /* A rejected (never-started) delivery must NOT quarantine the workspace. */
    expect(session!.quarantineReason).toBeUndefined();
  });

  test('a delivery through a symlinked ancestor is refused', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_files_symlink' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();

    /* Sandbox code from a prior turn plants a link where the delivery wants a
     * directory; `mkdir -p`/`rename` would follow it and write outside the
     * workspace as root. */
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'escape-'));
    await fsp.symlink(outside, path.join(dir, 'inputs'));

    const res = fakeStreamRes();
    await receiveSessionFiles(
      Readable.from(await makeArchive({
        'inputs/pwned.txt': 'escaped\n',
        [SESSION_FILES_MANIFEST_FILE]: JSON.stringify({
          marker: SESSION_FILES_MANIFEST_MARKER,
          files: [{ name: 'inputs/pwned.txt', id: 'file_1', storage_session_id: 'store_1' }],
        }),
      })) as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    expect(await fsp.lstat(path.join(outside, 'pwned.txt')).catch(() => null)).toBeNull();
    await fsp.rm(outside, { recursive: true, force: true });
  });

  test('a manifest member primes delivered files and never reaches the workspace', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_files_manifest' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();

    const archive = await makeArchive({
      'upload.csv': 'a,b\n1,2\n',
      'skill.md': '# infra file',
      [SESSION_FILES_MANIFEST_FILE]: JSON.stringify({
        marker: SESSION_FILES_MANIFEST_MARKER,
        files: [
          { name: 'upload.csv', id: 'file_up1', storage_session_id: 'store_1' },
          { name: 'skill.md', id: 'file_ro1', storage_session_id: 'store_1', read_only: true },
        ],
      }),
    });
    const res = fakeStreamRes();
    await receiveSessionFiles(Readable.from(archive) as never, res as never);

    expect(res.statusCode).toBe(200);
    /* Delivered + listed ⇒ primed, so the next exec reuses the on-disk copy
     * instead of attempting an unreachable pull, and later turns suppress it
     * from the output scan. */
    expect(session!.primedInputId('upload.csv')).toBe('file_up1');
    expect(session!.primedSessionId('upload.csv')).toBe('store_1');
    /* Read-only deliveries keep the pull model's contract: always suppressed
     * from the output scan, and reported as not-primed so each exec receives
     * a pristine re-delivery instead of trusting the writable workspace copy. */
    expect(session!.isPrimedInput('skill.md')).toBe(true);
    expect(session!.isPrimedReadOnly('skill.md')).toBe(true);
    expect(session!.primedInputId('skill.md')).toBeUndefined();
    /* Both are reusable for THIS exec, read-only included: on a push-model
     * backend the pull fallback has nothing reachable to download from. */
    expect(session!.consumeFreshDelivery('upload.csv', 'file_up1', 'store_1')).toBe(true);
    expect(session!.consumeFreshDelivery('skill.md', 'file_ro1', 'store_1')).toBe(true);
    /* One-shot: a later exec that does not re-push falls back to the normal
     * (id, storage session) reuse rules. */
    expect(session!.consumeFreshDelivery('skill.md', 'file_ro1', 'store_1')).toBe(false);
    /* The reserved member is consumed, never left for user code to see. */
    expect(await fsp.lstat(path.join(dir, SESSION_FILES_MANIFEST_FILE)).catch(() => null)).toBeNull();
  });

  test('a re-delivered writable input never overwrites the sandbox\'s edit', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_files_modified' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();

    const manifest = JSON.stringify({
      marker: SESSION_FILES_MANIFEST_MARKER,
      files: [
        { name: 'data.csv', id: 'file_1', storage_session_id: 'store_1' },
        { name: 'skill.md', id: 'file_ro', storage_session_id: 'store_1', read_only: true },
      ],
    });
    const original = { 'data.csv': 'a,b\n1,2\n', 'skill.md': 'PRISTINE\n' };
    await receiveSessionFiles(
      Readable.from(await makeArchive({ ...original, [SESSION_FILES_MANIFEST_FILE]: manifest })) as never,
      fakeStreamRes() as never,
    );

    /* The sandbox edits the writable input, and forces the read-only one
     * writable to tamper with it (0444 alone cannot stop an owner, which is
     * exactly why the pull path also re-downloads read-only inputs). */
    await fsp.writeFile(path.join(dir, 'data.csv'), 'a,b\n1,2\n3,4\n');
    await fsp.chmod(path.join(dir, 'skill.md'), 0o644);
    await fsp.writeFile(path.join(dir, 'skill.md'), 'TAMPERED\n');

    const res = fakeStreamRes();
    await receiveSessionFiles(
      Readable.from(await makeArchive({ ...original, [SESSION_FILES_MANIFEST_FILE]: manifest })) as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    /* Writable input: the user's edit wins over the re-pushed original. This
     * holds even though the control plane re-sent the ref — the guarantee must
     * not depend on Redis dedupe state that dies with the session record. */
    expect(await fsp.readFile(path.join(dir, 'data.csv'), 'utf8')).toBe('a,b\n1,2\n3,4\n');
    /* Read-only input: restored to pristine bytes by contract. */
    expect(await fsp.readFile(path.join(dir, 'skill.md'), 'utf8')).toBe('PRISTINE\n');
    /* Both are reusable this exec, so neither falls back to an unreachable pull. */
    expect(session!.consumeFreshDelivery('data.csv', 'file_1', 'store_1')).toBe(true);
    expect(session!.consumeFreshDelivery('skill.md', 'file_ro', 'store_1')).toBe(true);
  });

  test('a manifest naming a path outside the workspace fails the delivery', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_files_bad' });
    seedNonRootIdentity(session!);
    await session!.ownership();

    const archive = await makeArchive({
      'upload.csv': 'a,b\n1,2\n',
      [SESSION_FILES_MANIFEST_FILE]: JSON.stringify({
        marker: SESSION_FILES_MANIFEST_MARKER,
        files: [{ name: '../escape.txt', id: 'file_bad', storage_session_id: 'store_1' }],
      }),
    });
    const res = fakeStreamRes();
    await receiveSessionFiles(Readable.from(archive) as never, res as never);

    /* Priming is what makes a pushed file usable; acknowledging a delivery the
     * next execute cannot use would strand it on the unreachable pull path. */
    expect(res.statusCode).toBe(500);
  });

  test('a corrupt archive fails WITHOUT wiping existing workspace content', async () => {
    config.session_workspace_enabled = true;
    const session = bindSessionWorkspace({ runtimeSessionId: 'rt_files_2' });
    seedNonRootIdentity(session!);
    const { dir } = await session!.ownership();
    await fsp.writeFile(path.join(dir, 'precious.txt'), 'do-not-lose');

    const res = fakeStreamRes();
    await receiveSessionFiles(Readable.from(Buffer.from('not a tarball')) as never, res as never);

    expect(res.statusCode).toBe(500);
    /* Unlike restore's clean-slate error path, delivery failure must never
     * destroy real session state. */
    expect(await fsp.readFile(path.join(dir, 'precious.txt'), 'utf8')).toBe('do-not-lose');
  });
});
