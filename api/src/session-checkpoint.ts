import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Request, Response } from 'express';
import { pipeline } from 'stream/promises';
import { logger } from './logger';
import {
  SANDBOX_WORKSPACE_ROOT,
  SESSION_WORKSPACE_ID,
  applyReadOnlyInputPermissions,
} from './workspace-isolation';
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

/** Reserved archive member the control plane includes with a files delivery so
 *  the runner can register the delivered inputs as primed (see
 *  {@link receiveSessionFiles}). Never left in the workspace. */
export const SESSION_FILES_MANIFEST_FILE = '.codeapi-files.json';
export const SESSION_FILES_MANIFEST_MARKER = 'codeapi.session-files.v1';

type DeliveredFileEntry = {
  name: string;
  id: string;
  storage_session_id: string;
  /** Mirrors the file server's X-Read-Only contract: read-only deliveries are
   *  primed as such, so the output scan always suppresses them and each exec
   *  re-delivers a pristine copy (a writable workspace copy of an
   *  infrastructure file is never trusted). */
  read_only?: boolean;
};

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

/**
 * Additive input-file delivery: extracts a tar.gz into the bound session
 * workspace WITHOUT clearing it — the overlay counterpart to
 * {@link restoreSessionCheckpoint}'s full replace. The control plane pushes
 * user uploads through this over the same authed proxy channel as restore,
 * which is what makes uploads work on backends where the VM cannot reach a
 * file server (the MicroVM's only egress is the public internet, so the
 * pull-based priming path has nothing reachable to pull from).
 *
 * Inherits restore's traversal hardening verbatim: `--strip-components=1 -C
 * dir` pins every archive member under the workspace, so `../x`,
 * `other-ws/x`, or absolute members cannot escape into runner space. Unlike
 * restore, failure never wipes: the workspace holds real session state, so a
 * cut-off overlay leaves existing files untouched (at worst a partial
 * overlay, which the caller may retry idempotently). A reserved
 * {@link SESSION_FILES_MANIFEST_FILE} member registers the delivered inputs
 * as primed (see {@link applyDeliveredFilesManifest}).
 */
export async function receiveSessionFiles(req: Request, res: Response): Promise<void> {
  const session = getBoundSessionWorkspace();
  if (!session) {
    res.status(409).json({ message: 'No session workspace is bound' });
    return;
  }
  const { dir, uid, gid } = await session.ownership();
  await fsp.mkdir(dir, { recursive: true });

  const tar = spawn('tar', ['-xzf', '-', '--strip-components=1', '-C', dir], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  tar.stderr.on('data', (chunk: Buffer) => logger.debug({ tar: chunk.toString() }, 'session files tar'));
  try {
    /* 'close' listener before the pipeline await, for the same small-body
     * race documented on the checkpoint/restore sides; 'error' guards the
     * spawn-failure case. */
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
    if (code !== 0) throw new SessionCheckpointError(`session files tar exited ${code}`);
    await chownRecursive(dir, uid, gid);
    await applyDeliveredFilesManifest(session, dir);
    res.status(200).json({ status: 'received' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to receive session files');
    if (!res.headersSent) res.status(500).json({ message: 'session file delivery failed' });
  }
}

/**
 * Registers delivered inputs as primed from the reserved manifest member the
 * control plane packs into the archive. Priming is what stitches a pushed file
 * into the normal input lifecycle: the next execute's `reusePrimedInput` sees a
 * matching (storage_session_id, id) already on disk and skips its own fetch
 * (which has nothing reachable to fetch from on push-model backends), and later
 * turns that omit the ref suppress it from the output scan while unchanged.
 * Hashes are computed locally so the primed baseline matches the runner's own
 * `computeFileHash` format exactly. The manifest is removed before responding —
 * user code never sees it. A missing or marker-less manifest is non-fatal (and
 * a marker-less regular file with the reserved name is left untouched as user
 * data, mirroring the SESSION_META_FILE squat handling).
 */
async function applyDeliveredFilesManifest(session: SessionWorkspace, dir: string): Promise<void> {
  const manifestPath = path.join(dir, SESSION_FILES_MANIFEST_FILE);
  const stat = await fsp.lstat(manifestPath).catch(() => null);
  /* No manifest at all: a legacy/manifest-less delivery. Nothing to register,
   * and nothing is broken — the pull path still applies where reachable. */
  if (!stat?.isFile()) return;

  let parsed: { marker?: string; files?: DeliveredFileEntry[] };
  try {
    parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as typeof parsed;
  } catch (error) {
    /* Unparseable content under the reserved name is user data, not our
     * manifest (we never write invalid JSON): leave it in the workspace
     * untouched, exactly like the marker-mismatch case below. */
    logger.warn({ err: error }, 'Ignoring unparseable file at the reserved session-files manifest path');
    return;
  }
  if (parsed?.marker !== SESSION_FILES_MANIFEST_MARKER || !Array.isArray(parsed.files)) return;

  /* From here the manifest is provably ours, so every failure is a REAL
   * delivery failure: priming is what makes the pushed files usable, and a
   * push-model runner cannot fall back to pulling them. Throw so
   * receiveSessionFiles answers 500 and the control plane recycles, instead
   * of acknowledging a delivery the next execute cannot use. */
  await fsp.rm(manifestPath, { force: true });
  for (const entry of parsed.files) {
    if (typeof entry?.name !== 'string' || typeof entry?.id !== 'string'
      || typeof entry?.storage_session_id !== 'string') {
      throw new SessionCheckpointError('Malformed session files manifest entry');
    }
    /* The manifest names workspace-relative paths; resolve and re-check
     * containment so a malformed entry can never prime (or hash) a path
     * outside the session workspace. */
    const target = path.resolve(dir, entry.name);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw new SessionCheckpointError(`Session files manifest escapes the workspace: ${entry.name}`);
    }
    const st = await fsp.lstat(target).catch(() => null);
    if (!st?.isFile()) {
      throw new SessionCheckpointError(`Session files manifest names a missing file: ${entry.name}`);
    }
    const readOnly = entry.read_only === true;
    if (readOnly) {
      /* Same defense-in-depth as the pull path: root-owned 0444 so the sandbox
       * UID can read an infrastructure file but cannot chmod it writable. Runs
       * AFTER the delivery-wide chown, which would otherwise hand it back.
       * Best-effort exactly like the pull path (an unprivileged runner outside
       * hardened mode cannot chown), so a failure warns rather than voiding a
       * delivery whose bytes are already correct. */
      await applyReadOnlyInputPermissions(target).catch((err) => {
        logger.warn({ file: entry.name, err }, 'Failed to protect read-only delivered input');
      });
    }
    session.markPrimed(entry.name, entry.id, readOnly, await sha256File(target), entry.storage_session_id);
    session.markDelivered(entry.name);
  }
}

/** Same digest shape as Job.computeFileHash (streaming sha256 hex, no-follow)
 *  so primed baselines recorded here compare equal to the output scan's.
 *  Opens via fsp.open because numeric flag constants are only typed there —
 *  `createReadStream`'s options type wants a string mode with no O_NOFOLLOW
 *  spelling. */
async function sha256File(filePath: string): Promise<string> {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = crypto.createHash('sha256');
  for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  return hash.digest('hex');
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
