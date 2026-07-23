import axios from 'axios';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type * as t from '../types';
import { internalServiceHeaders } from '../internal-service-auth';
import { getAxiosErrorDetails } from '../utils';
import { env } from '../config';
import logger from '../logger';

/**
 * Input delivery for sandbox backends whose guest cannot reach the file
 * server (a MicroVM's only egress is the public internet, so the runner's
 * pull-based priming has nothing reachable to pull from).
 *
 * The control plane fetches the authorized objects locally and pushes the
 * bytes into a runner-local cache keyed by (storage session, object id). The
 * runner's EXISTING priming path then resolves refs from that cache instead of
 * over HTTP — so the sandbox workspace keeps exactly one writer, and pushed
 * inputs inherit its identity, ownership, read-only, symlink-safety, priming
 * and modification-detection semantics unchanged.
 *
 * Two consequences worth stating, because earlier designs got them wrong:
 *  - Nothing here decides what the workspace should contain. Re-pushing an
 *    object can never revert a sandbox edit, because the push does not touch
 *    the workspace at all.
 *  - Dedupe is asked of the VM (`probe`), not tracked in Redis. Control-plane
 *    state can be lost with a recycle; the VM's own cache cannot lie about
 *    what it holds.
 */

export const SESSION_INPUTS_MAX_COUNT = 256;

export class SessionFilesError extends Error {}

export interface SessionFileRef {
  id: string;
  storage_session_id: string;
  name: string;
}

/** Mirrors the runner's `inputCacheKey` (api/src/session-inputs.ts): both ends
 *  ship in the same image, so the digest is a hard-coded contract. */
export function inputCacheKey(storageSessionId: string, id: string): string {
  return crypto.createHash('sha256').update(`${storageSessionId}\u0000${id}`, 'utf8').digest('hex');
}

/** The by-reference subset of the payload's files (inline `content` entries
 *  need no delivery — the runner writes those itself). */
export function sessionFileRefs(files: t.PayloadBody['files'] | undefined): SessionFileRef[] {
  if (!files?.length) return [];
  const refs: SessionFileRef[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!('id' in file) || !file.id || !file.storage_session_id || !file.name) continue;
    /* Identity is (storage session, id) — the same object requested under two
     * names is ONE delivery; the runner writes it to each requested path from
     * the payload during priming. */
    const key = inputCacheKey(file.storage_session_id, file.id);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ id: file.id, storage_session_id: file.storage_session_id, name: file.name });
  }
  return refs;
}

export interface InputBatch {
  data: Buffer;
  count: number;
}

/**
 * Fetches the given objects from the file server and packs them into the
 * digest-named batch the runner's cache endpoint accepts. Throws
 * {@link SessionFilesError} on a failed fetch or a blown budget — a silently
 * missing input is the failure mode this module exists to prevent.
 */
export async function buildInputBatch(
  refs: SessionFileRef[],
  opts: { timeoutMs: number; maxBytes: number; fileServerUrl?: string; signal?: AbortSignal },
): Promise<InputBatch | undefined> {
  if (refs.length === 0) return undefined;
  if (refs.length > SESSION_INPUTS_MAX_COUNT) {
    throw new SessionFilesError(
      `Session delivery of ${refs.length} objects exceeds the ${SESSION_INPUTS_MAX_COUNT} limit`,
    );
  }
  const baseUrl = (opts.fileServerUrl ?? env.FILE_SERVER_URL).replace(/\/$/, '');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-inputs-'));
  try {
    let totalBytes = 0;
    for (const ref of refs) {
      if (opts.signal?.aborted) throw new SessionFilesError('Session input delivery aborted');
      const fetched = await fetchFileObject(baseUrl, ref, opts);
      totalBytes += fetched.bytes.length;
      /* Cumulative budget: a per-fetch content-length cap alone would let one
       * authorized object repeated across many refs exhaust disk and heap. */
      if (totalBytes > opts.maxBytes) {
        throw new SessionFilesError(`Session inputs exceed the ${opts.maxBytes}-byte budget`);
      }
      const key = inputCacheKey(ref.storage_session_id, ref.id);
      await fsp.writeFile(path.join(tmp, key), fetched.bytes);
      await fsp.writeFile(
        path.join(tmp, `${key}.json`),
        /* Only object-level facts travel with the object; the destination
         * name belongs to each requesting ref (see CachedInputMeta). */
        JSON.stringify({ readOnly: fetched.readOnly }),
      );
    }
    return { data: await tarDirectory(tmp), count: refs.length };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchFileObject(
  baseUrl: string,
  ref: SessionFileRef,
  opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<{ bytes: Buffer; readOnly: boolean }> {
  const url = `${baseUrl}/sessions/${encodeURIComponent(ref.storage_session_id)}/objects/${encodeURIComponent(ref.id)}`;
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      headers: internalServiceHeaders(),
      responseType: 'arraybuffer',
      maxContentLength: opts.maxBytes,
      timeout: opts.timeoutMs,
      signal: opts.signal,
    });
    const readOnly = String(response.headers['x-read-only'] ?? '').toLowerCase() === 'true';
    return { bytes: Buffer.from(response.data), readOnly };
  } catch (error) {
    /* Sanitized details only: a raw axios error carries the request config —
     * including the internal service token header — straight into the logs. */
    logger.error(`Failed to fetch session input ${ref.id}:`, getAxiosErrorDetails(error));
    throw new SessionFilesError(`Failed to fetch input ${ref.name} from file server`);
  }
}

function tarDirectory(root: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', '-', '-C', root, '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    tar.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    tar.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code !== 0) {
        reject(new SessionFilesError(`inputs tar exited ${code}: ${Buffer.concat(errChunks).toString()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
