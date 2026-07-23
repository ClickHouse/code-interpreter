import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Request, Response } from 'express';
import { pipeline } from 'stream/promises';
import { logger } from './logger';
import { SANDBOX_WORKSPACE_ROOT, SESSION_WORKSPACE_ID } from './workspace-isolation';
import type { SessionMetaSnapshot, SessionWorkspace } from './session-workspace';
import { SESSION_META_FILE, SESSION_META_MARKER, getBoundSessionWorkspace } from './session-workspace';

/**
 * Session workspace checkpoint / restore.
 *
 * Makes an expiring MicroVM's state survive across a relaunch: the control
 * plane pulls a compressed archive of the session workspace over the authed
 * proxy (GET /checkpoint), stores it in S3, and pushes it back into a fresh
 * VM's workspace before the first execute (POST /restore). The untrusted VM
 * never touches S3 — only tars its own `/mnt/data`.
 *
 * Only reachable when a session is bound (getBoundSessionWorkspace); returns
 * 409 otherwise so the legacy fresh-per-job runner exposes nothing new.
 */

const CHECKPOINT_CONTENT_TYPE = 'application/x-gtar';

export class SessionCheckpointError extends Error {}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** Streams `tar -czf -` of the session workspace to the response. */
export async function streamSessionCheckpoint(res: Response): Promise<void> {
  const session = getBoundSessionWorkspace();
  if (!session) {
    res.status(409).json({ message: 'No session workspace is bound' });
    return;
  }
  const { dir } = await session.ownership();

  /* Carry the priming/output-diff state into the archive so a relaunched VM
   * rebuilds it (see restoreSessionCheckpoint). Written under the held session
   * lock, so no concurrent user code sees it, and removed once tar has read it.
   * The path is a collision point:
   *  - a prior exec's sandbox code can squat it as a symlink OR a directory
   *    (attack — remove it; `recursive` clears a dir else the write fails
   *    EISDIR, `force` ignores absence, and neither follows a symlink), or
   *  - user code can legitimately create a regular file with this name (their
   *    data — do NOT delete it; skip metadata persistence this turn so their
   *    file tars as normal workspace content).
   * We only ever remove/restore a sidecar we actually wrote. */
  const metaPath = path.join(dir, SESSION_META_FILE);
  const squat = await fsp.lstat(metaPath).catch(() => null);
  let wroteSidecar = false;
  if (squat?.isFile()) {
    logger.warn('Session meta sidecar path holds a user file; skipping metadata persistence this checkpoint');
  } else {
    await fsp.rm(metaPath, { force: true, recursive: true });
    await fsp.writeFile(
      metaPath,
      JSON.stringify({ marker: SESSION_META_MARKER, ...session.snapshotMeta() }),
      { flag: 'wx', mode: 0o600 },
    );
    wroteSidecar = true;
  }

  res.status(200);
  res.setHeader('Content-Type', CHECKPOINT_CONTENT_TYPE);
  const tar = spawn('tar', ['-czf', '-', '-C', SANDBOX_WORKSPACE_ROOT, SESSION_WORKSPACE_ID], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tar.stderr.on('data', (chunk: Buffer) => logger.debug({ tar: chunk.toString() }, 'checkpoint tar'));
  try {
    /* Register the 'close' listener BEFORE awaiting the pipeline: for a small
     * workspace tar can exit and emit 'close' before pipeline resolves, and a
     * listener attached only afterward would miss it and hang here forever —
     * the finally never runs, leaving the runner sidecar in the workspace for
     * the next /execute to mis-scan as user output. The 'error' listener turns
     * a spawn failure (e.g. tar missing from PATH) into a rejected promise
     * instead of an unhandled ChildProcess 'error' crashing the runner. */
    const closed: Promise<number> = new Promise((resolve, reject) => {
      tar.on('close', resolve);
      tar.on('error', reject);
    });
    /* Observe the rejection immediately: when `tar` fails to spawn, `pipeline`
     * below rejects first and we never reach `await closed` — an unobserved
     * rejection would then take the whole runner down after we already
     * answered 500. The later `await closed` still sees the same rejection. */
    closed.catch(() => {});
    await pipeline(tar.stdout, res);
    const code = await closed;
    if (code !== 0) throw new SessionCheckpointError(`checkpoint tar exited ${code}`);
  } catch (error) {
    logger.error({ err: error }, 'Failed to stream session checkpoint');
    if (!res.headersSent) res.status(500).json({ message: 'checkpoint failed' });
    else res.destroy();
  } finally {
    if (wroteSidecar) await fsp.rm(metaPath, { force: true }).catch(() => {});
  }
}

/** Extracts a `tar.gz` from the request body into the session workspace and
 *  re-owns it to the session's pinned UID. */
export async function restoreSessionCheckpoint(req: Request, res: Response): Promise<void> {
  const session = getBoundSessionWorkspace();
  if (!session) {
    res.status(409).json({ message: 'No session workspace is bound' });
    return;
  }
  const { dir, uid, gid } = await session.ownership();

  /* Start from a clean workspace so a restore is a full replace, not a merge. */
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  /* Archives are created with relative `session/...` members (see the create
   * side). Strip that leading component and extract straight into the session
   * `dir`, so a poisoned archive member (`../x`, `ws_other/x`, `rootfile`) can
   * never escape the workspace into shared runner space — every member lands
   * under `dir`. Production hardening: verify/scan the archive before trusting a
   * restore from shared storage. */
  const tar = spawn('tar', ['-xzf', '-', '--strip-components=1', '-C', dir], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  tar.stderr.on('data', (chunk: Buffer) => logger.debug({ tar: chunk.toString() }, 'restore tar'));
  try {
    /* Register the 'close' listener before awaiting the pipeline (see the create
     * side): a small upload can finish and 'close' can fire before pipeline
     * resolves, and a listener attached afterward would hang, never sending the
     * 200 — the control plane would then hit the restore timeout and recycle a
     * freshly-launched VM even though the archive was valid. 'error' guards the
     * spawn-failure case (see the create side). */
    const closed: Promise<number> = new Promise((resolve, reject) => {
      tar.on('close', resolve);
      tar.on('error', reject);
    });
    /* Observe the rejection immediately: when `tar` fails to spawn, `pipeline`
     * below rejects first and we never reach `await closed` — an unobserved
     * rejection would then take the whole runner down after we already
     * answered 500. The later `await closed` still sees the same rejection. */
    closed.catch(() => {});
    await pipeline(req, tar.stdin);
    const code = await closed;
    if (code !== 0) throw new SessionCheckpointError(`restore tar exited ${code}`);
    await applyRestoredMeta(session, dir);
    await chownRecursive(dir, uid, gid);
    res.status(200).json({ status: 'restored', dir: path.basename(dir) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to restore session checkpoint');
    /* A corrupt archive or cut-off upload can leave partially-extracted members
     * behind. The control plane treats restore failure as non-fatal and runs the
     * job anyway, so wipe the workspace to a clean slate — otherwise the job runs
     * against a mix of stale checkpoint files instead of an empty workspace. */
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    if (!res.headersSent) res.status(500).json({ message: 'restore failed' });
  }
}

/** Applies the restored priming/output-diff sidecar to the bound session and
 *  removes it from disk so user code never sees it. Absent (older checkpoint)
 *  or malformed metadata is non-fatal — the session just re-primes/re-surfaces
 *  as if warmth were lost. */
async function applyRestoredMeta(session: SessionWorkspace, dir: string): Promise<void> {
  const metaPath = path.join(dir, SESSION_META_FILE);
  try {
    /* Only trust a regular file: a restored archive is untrusted, so never
     * follow a symlinked sidecar (it would read an arbitrary file into the
     * loaded metadata). lstat does not follow the link. */
    const stat = await fsp.lstat(metaPath).catch(() => null);
    if (!stat?.isFile()) return;
    const trustedOwner = currentUid();
    const ownerMatches = trustedOwner == null || stat.uid === trustedOwner;
    const ownerWritable = (stat.mode & 0o200) !== 0;
    if (!ownerMatches || !ownerWritable) {
      logger.warn('Ignoring untrusted session meta sidecar from restored workspace');
      return;
    }
    const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as SessionMetaSnapshot;
    /* Require the runner-owned sidecar shape plus marker: a user file sharing
     * the reserved name is never loaded as metadata nor deleted, even if it
     * happens to contain primed/surfaced arrays. */
    if (parsed?.marker === SESSION_META_MARKER
      && Array.isArray(parsed?.primed) && Array.isArray(parsed?.surfaced)) {
      session.loadMeta(parsed);
      await fsp.rm(metaPath, { force: true }).catch(() => {});
    }
  } catch (error) {
    logger.debug({ err: error }, 'No session meta sidecar to restore');
  }
}

async function chownRecursive(dir: string, uid: number, gid: number): Promise<void> {
  await fsp.lchown(dir, uid, gid).catch(() => {});
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    /* A restored checkpoint is untrusted content: never follow symlinks. A
     * `session/x -> /etc/passwd` entry would otherwise have `chown` re-own the
     * target outside the workspace. `lchown` the link itself and never recurse
     * through it (Dirent reports the link type, so `isDirectory()` is false). */
    if (entry.isSymbolicLink()) {
      await fsp.lchown(full, uid, gid).catch(() => {});
      continue;
    }
    await fsp.chown(full, uid, gid).catch(() => {});
    if (entry.isDirectory()) await chownRecursive(full, uid, gid);
  }
}
