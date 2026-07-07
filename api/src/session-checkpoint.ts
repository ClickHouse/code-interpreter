import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Request, Response } from 'express';
import { pipeline } from 'stream/promises';
import { logger } from './logger';
import { SANDBOX_WORKSPACE_ROOT, SESSION_WORKSPACE_ID } from './workspace-isolation';
import { getBoundSessionWorkspace } from './session-workspace';

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

/** Streams `tar -czf -` of the session workspace to the response. */
export async function streamSessionCheckpoint(res: Response): Promise<void> {
  const session = getBoundSessionWorkspace();
  if (!session) {
    res.status(409).json({ message: 'No session workspace is bound' });
    return;
  }
  await session.ownership();

  res.status(200);
  res.setHeader('Content-Type', CHECKPOINT_CONTENT_TYPE);
  const tar = spawn('tar', ['-czf', '-', '-C', SANDBOX_WORKSPACE_ROOT, SESSION_WORKSPACE_ID], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tar.stderr.on('data', (chunk: Buffer) => logger.debug({ tar: chunk.toString() }, 'checkpoint tar'));
  try {
    await pipeline(tar.stdout, res);
    const code: number = await new Promise((resolve) => tar.on('close', resolve));
    if (code !== 0) throw new SessionCheckpointError(`checkpoint tar exited ${code}`);
  } catch (error) {
    logger.error({ err: error }, 'Failed to stream session checkpoint');
    if (!res.headersSent) res.status(500).json({ message: 'checkpoint failed' });
    else res.destroy();
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
   * side), so extraction stays within the workspace root without needing
   * GNU-only flags. Production hardening: verify/scan the archive before
   * trusting a restore from shared storage. */
  const tar = spawn('tar', ['-xzf', '-', '-C', SANDBOX_WORKSPACE_ROOT], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  tar.stderr.on('data', (chunk: Buffer) => logger.debug({ tar: chunk.toString() }, 'restore tar'));
  try {
    await pipeline(req, tar.stdin);
    const code: number = await new Promise((resolve) => tar.on('close', resolve));
    if (code !== 0) throw new SessionCheckpointError(`restore tar exited ${code}`);
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
