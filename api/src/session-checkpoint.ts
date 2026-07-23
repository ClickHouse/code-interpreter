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
  ensureDirNoFollow,
} from './workspace-isolation';
import { validateFilePath } from './validation';
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
 * <staging>` pins every archive member under a scratch directory, so `../x`,
 * `other-ws/x`, or absolute members cannot escape into runner space. Unlike
 * restore, failure never wipes: the workspace holds real session state, so a
 * failed delivery leaves it untouched (the caller may retry idempotently).
 *
 * Extraction lands in staging rather than straight into the workspace so the
 * merge can enforce the invariant that makes re-delivery safe: a WRITABLE
 * input the sandbox has modified since it was primed is never overwritten by
 * a re-push of its original bytes. The control plane also skips already
 * delivered refs, but that state lives in Redis and dies with the session
 * record (VM recycle, failover, flush) — enforcing it here, against the
 * primed baseline that travels inside the checkpoint, makes the guarantee
 * independent of control-plane state. Read-only inputs are exempt by
 * contract: they are always restored to pristine bytes.
 */
export async function receiveSessionFiles(req: Request, res: Response): Promise<void> {
  const session = getBoundSessionWorkspace();
  if (!session) {
    res.status(409).json({ message: 'No session workspace is bound' });
    return;
  }
  const { dir, uid, gid } = await session.ownership();
  await fsp.mkdir(dir, { recursive: true });
  /* Sibling of the workspace so the merge can rename() instead of copying,
   * and 0o700 so no sandbox UID can read or tamper with files in flight. */
  const staging = await fsp.mkdtemp(path.join(SANDBOX_WORKSPACE_ROOT, '.delivery-'));
  await fsp.chmod(staging, 0o700);

  const tar = spawn('tar', ['-xzf', '-', '--strip-components=1', '-C', staging], {
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
    await mergeDeliveredFiles(session, staging, dir, uid, gid);
    res.status(200).json({ status: 'received' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to receive session files');
    if (!res.headersSent) res.status(500).json({ message: 'session file delivery failed' });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Commits an extracted delivery into the live workspace.
 *
 * Two-phase by construction: EVERYTHING is validated before the first byte of
 * live state changes, because a half-applied delivery leaves a workspace whose
 * contents match neither the checkpoint nor the request. Phase 1 proves the
 * archive is exactly what the manifest claims — canonical relative names, a
 * unique one-to-one correspondence between manifest entries and staged regular
 * files (no missing, duplicate, or extra members), and no path escaping the
 * workspace. Phase 2 commits, and any failure there marks the workspace
 * indeterminate so the runner refuses further work until the control plane
 * recycles the VM (see {@link SessionWorkspace.poisonDelivery}).
 *
 * Writes go through {@link ensureDirNoFollow}, the same no-follow ancestor walk
 * the pull path uses: a prior turn's sandbox code can plant a symlink inside
 * the persistent workspace, and `mkdir -p`/`rename` would happily follow it and
 * write outside the workspace as root.
 */
async function mergeDeliveredFiles(
  session: SessionWorkspace,
  staging: string,
  dir: string,
  uid: number,
  gid: number,
): Promise<void> {
  const manifest = await readDeliveryManifest(staging);
  const staged = await listFilesRecursive(staging);

  /* ---- Phase 1: validate, mutating nothing ---- */
  const entries = new Map<string, DeliveredFileEntry>();
  for (const entry of manifest) {
    if (entries.has(entry.name)) {
      throw new SessionCheckpointError(`Duplicate session files manifest entry: ${entry.name}`);
    }
    /* Same canonical-name rules the pull path enforces, so manifest keys,
     * on-disk paths, and the output scanner's relative paths always agree. */
    try {
      validateFilePath(entry.name, dir);
    } catch (error) {
      throw new SessionCheckpointError(
        `Invalid session files manifest name "${entry.name}": ${error instanceof Error ? error.message : 'invalid'}`,
      );
    }
    const target = path.resolve(dir, entry.name);
    if (target === dir || !target.startsWith(dir + path.sep)) {
      throw new SessionCheckpointError(`Session delivery escapes the workspace: ${entry.name}`);
    }
    entries.set(entry.name, entry);
  }

  const stagedFiles = staged.filter((rel) => rel !== SESSION_FILES_MANIFEST_FILE);
  for (const rel of stagedFiles) {
    if (!entries.has(rel)) {
      throw new SessionCheckpointError(`Session delivery contains an unlisted file: ${rel}`);
    }
  }
  for (const name of entries.keys()) {
    if (!stagedFiles.includes(name)) {
      throw new SessionCheckpointError(`Session files manifest names an undelivered file: ${name}`);
    }
  }

  /* ---- Phase 2: commit ---- */
  try {
    for (const rel of stagedFiles) {
      const entry = entries.get(rel) as DeliveredFileEntry;
      const readOnly = entry.read_only === true;
      const target = path.join(dir, rel);

      /* Keep a sandbox edit ONLY when the incoming ref is the same file the
       * edit was made to. A different id/storage session at the same path is a
       * different file the caller asked for: it must land, and re-prime, or
       * the execute would run against stale bytes whose identity no longer
       * matches anything the request declared. Read-only refs never preserve —
       * restoring pristine bytes is their contract. */
      if (!readOnly && isSameWritablePrime(session, rel, entry)
        && (await isModifiedSincePrimed(session, dir, rel))) {
        logger.info({ file: rel }, 'Keeping sandbox-modified input over re-delivered original');
        session.markDelivered(rel);
        continue;
      }

      await ensureDirNoFollow(dir, path.dirname(target), { uid, gid, slot: -1, perJobUid: false });
      /* `rename` replaces a file or symlink atomically and never follows the
       * final component; only a directory in the way needs removing first. */
      const existing = await fsp.lstat(target).catch(() => null);
      if (existing?.isDirectory()) {
        await fsp.rm(target, { recursive: true, force: true });
      }
      await fsp.rename(path.join(staging, rel), target);
      await fsp.lchown(target, uid, gid).catch(() => {});
      if (readOnly) {
        /* Same defense-in-depth as the pull path: root-owned 0444 so the
         * sandbox UID can read an infrastructure file but cannot chmod it
         * writable. Best-effort exactly like the pull path (an unprivileged
         * runner outside hardened mode cannot chown). */
        await applyReadOnlyInputPermissions(target).catch((err) => {
          logger.warn({ file: rel, err }, 'Failed to protect read-only delivered input');
        });
      }
      session.markPrimed(rel, entry.id, readOnly, await sha256File(target), entry.storage_session_id);
      session.markDelivered(rel);
    }
  } catch (error) {
    /* Renames already committed cannot be rolled back reliably (the bytes they
     * replaced are gone), so quarantine instead: every later request fails
     * until the control plane recycles this VM and restores from the last
     * checkpoint. */
    session.poisonDelivery(error instanceof Error ? error.message : 'delivery failed mid-commit');
    throw error;
  }
}

/** Whether `entry` names the exact writable prime currently recorded at `rel`
 *  — the only case where preserving a sandbox edit is correct. */
function isSameWritablePrime(
  session: SessionWorkspace,
  rel: string,
  entry: DeliveredFileEntry,
): boolean {
  return session.primedInputId(rel) === entry.id
    && session.primedSessionId(rel) === entry.storage_session_id;
}

/** True when `rel` exists on disk with content differing from the primed
 *  baseline — i.e. the sandbox edited a previously delivered input. */
async function isModifiedSincePrimed(
  session: SessionWorkspace,
  dir: string,
  rel: string,
): Promise<boolean> {
  const primedHash = session.primedHash(rel);
  if (!primedHash) return false;
  const target = path.join(dir, rel);
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isFile()) return false;
  return (await sha256File(target)) !== primedHash;
}

/** Reads and validates the reserved manifest member from a staged delivery. */
async function readDeliveryManifest(staging: string): Promise<DeliveredFileEntry[]> {
  const manifestPath = path.join(staging, SESSION_FILES_MANIFEST_FILE);
  const stat = await fsp.lstat(manifestPath).catch(() => null);
  /* No manifest: a legacy/manifest-less delivery. The files still land; they
   * just carry no priming metadata. */
  if (!stat?.isFile()) return [];

  let parsed: { marker?: string; files?: DeliveredFileEntry[] };
  try {
    parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as typeof parsed;
  } catch (error) {
    throw new SessionCheckpointError(
      `Unparseable session files manifest: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    );
  }
  if (parsed?.marker !== SESSION_FILES_MANIFEST_MARKER || !Array.isArray(parsed.files)) {
    throw new SessionCheckpointError('Session files manifest is missing its marker');
  }
  for (const entry of parsed.files) {
    if (typeof entry?.name !== 'string' || typeof entry?.id !== 'string'
      || typeof entry?.storage_session_id !== 'string') {
      throw new SessionCheckpointError('Malformed session files manifest entry');
    }
  }
  return parsed.files;
}

/** Workspace-relative paths of every regular file under `root`. */
async function listFilesRecursive(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const dirents = await fsp.readdir(path.join(root, prefix), { withFileTypes: true });
  for (const dirent of dirents) {
    const rel = prefix ? path.join(prefix, dirent.name) : dirent.name;
    /* Never follow a link out of staging; the archive is untrusted input. */
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      out.push(...(await listFilesRecursive(root, rel)));
      continue;
    }
    if (dirent.isFile()) out.push(rel);
  }
  return out;
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
