import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { logger } from './logger';
import { SANDBOX_WORKSPACE_ROOT } from './workspace-isolation';

/**
 * Runner-local cache of by-reference input objects.
 *
 * Backends whose sandbox cannot reach the file server (the Lambda MicroVM's
 * only egress is the public internet) have the control plane PUSH input bytes
 * into this cache before an execute. Priming then resolves a ref from here
 * instead of over HTTP — see `Job.fetchInputObject`.
 *
 * The cache is deliberately NOT part of the session workspace:
 *  - entries are keyed by a runner-computed digest of (storage session, id),
 *    so no caller-supplied path component ever reaches the filesystem;
 *  - sandbox code cannot see or modify it (0700, outside /mnt/data);
 *  - it is never checkpointed, so a relaunched VM simply starts empty and the
 *    control plane re-pushes what the next execute needs.
 *
 * Because the only workspace writer stays the existing prime path, delivered
 * files inherit its identity, ownership, read-only, symlink-safety, priming
 * and modification-detection semantics for free.
 */

/**
 * Sibling of the workspace root, never inside it. Everything under
 * SANDBOX_WORKSPACE_ROOT is a workspace as far as the stale-workspace reaper
 * is concerned, so a cache placed there is deleted out from under the very
 * execute it was pushed for — proven live, then reproduced with
 * `reapStaleWorkspaces`. Being outside also keeps it off every nsjail mount,
 * so sandbox code can neither read nor tamper with pending inputs.
 */
export const SESSION_INPUT_CACHE_DIR =
  process.env.SANDBOX_INPUT_CACHE_DIR ?? `${SANDBOX_WORKSPACE_ROOT}-inputs`;
/** Cache entry names are exactly this shape — anything else is rejected. */
const ENTRY_PATTERN = /^[0-9a-f]{64}(\.json)?$/;
const META_SUFFIX = '.json';

export interface CachedInputMeta {
  /** Whether the object is infrastructure the sandbox must not modify. This is
   *  a property of the OBJECT, so it belongs here. A filename deliberately
   *  does not: the cache is keyed by object, and the same object can be
   *  requested at several destinations in one execute, so the requesting ref
   *  owns the name. Emitting one cached name as Content-Disposition made every
   *  ref resolve to the first ref's path — which then overwrote a file the
   *  sandbox had edited. */
  readOnly?: boolean;
}

export interface CachedInput {
  path: string;
  meta: CachedInputMeta;
}

/** Opaque, collision-resistant key for a (storage session, object) pair. The
 *  digest keeps caller-controlled ids out of the filesystem entirely. */
export function inputCacheKey(storageSessionId: string, id: string): string {
  return crypto
    .createHash('sha256')
    .update(`${storageSessionId}\u0000${id}`, 'utf8')
    .digest('hex');
}

export async function hasCachedInput(storageSessionId: string, id: string): Promise<boolean> {
  const entry = path.join(SESSION_INPUT_CACHE_DIR, inputCacheKey(storageSessionId, id));
  const stat = await fsp.lstat(entry).catch(() => null);
  return stat?.isFile() === true;
}

export async function openCachedInput(
  storageSessionId: string,
  id: string,
): Promise<CachedInput | null> {
  const key = inputCacheKey(storageSessionId, id);
  const entry = path.join(SESSION_INPUT_CACHE_DIR, key);
  const stat = await fsp.lstat(entry).catch(() => null);
  if (!stat?.isFile()) return null;
  let meta: CachedInputMeta = {};
  const raw = await fsp.readFile(`${entry}${META_SUFFIX}`, 'utf8').catch(() => null);
  if (raw != null) {
    try {
      meta = JSON.parse(raw) as CachedInputMeta;
    } catch (error) {
      /* Metadata is an optimization (original name / read-only bit); a corrupt
       * sidecar must not make an otherwise-valid cached object unusable. */
      logger.warn({ key, err: error }, 'Ignoring corrupt session input metadata');
    }
  }
  return { path: entry, meta };
}

/**
 * Presents a cached entry as the `Response` the file server would have
 * returned, so every downstream priming step (name resolution, read-only
 * protection, streaming hash, atomic rename) runs byte-identically whether the
 * bytes arrived by pull or by push.
 */
export function cachedInputResponse(entry: CachedInput): Response {
  const headers = new Headers();
  /* No Content-Disposition: priming falls back to the ref's requested name,
   * so each destination gets its own copy (see CachedInputMeta). */
  if (entry.meta.readOnly === true) headers.set('x-read-only', 'true');
  return new Response(fs.createReadStream(entry.path) as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}

/**
 * Extracts a pushed batch into the cache. Members are digest-named by the
 * control plane (`<key>` for bytes, `<key>.json` for metadata), so validation
 * is a name-shape check rather than path arithmetic: nothing else can be
 * written, and no member can escape the cache directory.
 */
export async function storeCachedInputs(body: NodeJS.ReadableStream): Promise<number> {
  await fsp.mkdir(SESSION_INPUT_CACHE_DIR, { recursive: true, mode: 0o700 });
  const staging = await fsp.mkdtemp(path.join(SESSION_INPUT_CACHE_DIR, '.staging-'));
  try {
    const tar = spawn('tar', ['-xzf', '-', '-C', staging], { stdio: ['pipe', 'ignore', 'pipe'] });
    tar.stderr.on('data', (chunk: Buffer) => logger.debug({ tar: chunk.toString() }, 'session inputs tar'));
    const closed: Promise<number> = new Promise((resolve, reject) => {
      tar.on('close', resolve);
      tar.on('error', reject);
    });
    /* Observe immediately: a spawn failure rejects `pipeline` first, and an
     * unobserved rejection would crash the runner after we answered 500. */
    closed.catch(() => {});
    await pipeline(body, tar.stdin);
    const code = await closed;
    if (code !== 0) throw new Error(`session inputs tar exited ${code}`);

    const entries = await fsp.readdir(staging, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !ENTRY_PATTERN.test(entry.name)) {
        throw new Error(`Unexpected session input member: ${entry.name}`);
      }
    }
    let stored = 0;
    for (const entry of entries) {
      await fsp.rename(
        path.join(staging, entry.name),
        path.join(SESSION_INPUT_CACHE_DIR, entry.name),
      );
      if (!entry.name.endsWith(META_SUFFIX)) stored += 1;
    }
    return stored;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Drops least-recently-used entries until the cache fits `maxBytes`. Eviction
 *  is always safe: a miss simply re-pushes on the next probe. */
export async function pruneInputCache(maxBytes: number): Promise<void> {
  const names = await fsp.readdir(SESSION_INPUT_CACHE_DIR).catch(() => [] as string[]);
  const files: Array<{ name: string; size: number; atime: number }> = [];
  let total = 0;
  for (const name of names) {
    if (!ENTRY_PATTERN.test(name)) continue;
    const stat = await fsp.lstat(path.join(SESSION_INPUT_CACHE_DIR, name)).catch(() => null);
    if (!stat?.isFile()) continue;
    files.push({ name, size: stat.size, atime: stat.atimeMs });
    total += stat.size;
  }
  if (total <= maxBytes) return;
  files.sort((a, b) => a.atime - b.atime);
  for (const file of files) {
    if (total <= maxBytes) break;
    await fsp.rm(path.join(SESSION_INPUT_CACHE_DIR, file.name), { force: true }).catch(() => {});
    /* Metadata rides with its object; drop both or the sidecar leaks. */
    if (!file.name.endsWith(META_SUFFIX)) {
      await fsp
        .rm(path.join(SESSION_INPUT_CACHE_DIR, `${file.name}${META_SUFFIX}`), { force: true })
        .catch(() => {});
    }
    total -= file.size;
  }
}
