import axios from 'axios';
import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type * as t from '../types';
import { internalServiceHeaders } from '../internal-service-auth';
import { getAxiosErrorDetails } from '../utils';
import { env } from '../config';
import logger from '../logger';

/**
 * Input-file delivery for push-model sandbox backends.
 *
 * MicroVMs have internet-only egress, so the runner's pull-based priming
 * cannot reach the (internal) file server. Instead the control plane fetches
 * the authorized refs from the file server locally, packs them into the same
 * `session/`-rooted tar.gz shape a checkpoint restore uses, and pushes the
 * archive into the bound session workspace over the authed proxy channel
 * (`POST /api/v2/session/files` — additive, never a workspace replace).
 *
 * A reserved manifest member tells the runner which (storage_session_id, id)
 * each delivered path corresponds to, so it registers them as primed inputs:
 * the execute's own priming then reuses the on-disk copy instead of attempting
 * an unreachable pull, and later turns suppress unchanged inputs from the
 * output scan exactly as on pull-model backends.
 *
 * Refs the session record marks as already delivered are skipped entirely —
 * re-pushing them would overwrite in-place modifications the sandbox made on
 * a prior turn, defeating the runner's `reusePrimedInput` contract. Read-only
 * refs are the deliberate exception: they are re-delivered every exec (and
 * marked read-only in the manifest), mirroring the pull model's rule that a
 * writable workspace copy of an infrastructure file is never trusted.
 */

/** Mirrors the runner's reserved manifest member (api/src/session-checkpoint.ts);
 *  both ends ship together, so a hard-coded pair needs no compat dance. */
export const SESSION_FILES_MANIFEST_FILE = '.codeapi-files.json';
export const SESSION_FILES_MANIFEST_MARKER = 'codeapi.session-files.v1';

/** Upper bound on refs per delivery — matches the batch-upload ceiling rather
 *  than trusting the request body to be reasonable. */
export const SESSION_FILES_MAX_COUNT = 256;

export class SessionFilesError extends Error {}

export interface SessionFileRef {
  id: string;
  storage_session_id: string;
  name: string;
}

/** `<storage_session_id>/<id>@<name>` — the registry key for a delivered ref.
 *  The destination path is part of the identity: the SAME object presented
 *  under a new filename is a file the workspace does not have yet and must
 *  still be delivered. */
export function sessionFileRefKey(ref: SessionFileRef): string {
  return `${ref.storage_session_id}/${ref.id}@${ref.name}`;
}

/** The by-reference subset of the payload's files (inline `content` entries
 *  need no delivery — the runner writes those itself). */
export function sessionFileRefs(files: t.PayloadBody['files'] | undefined): SessionFileRef[] {
  if (!files?.length) return [];
  const refs: SessionFileRef[] = [];
  for (const file of files) {
    if ('id' in file && file.id && file.storage_session_id && file.name) {
      refs.push({ id: file.id, storage_session_id: file.storage_session_id, name: file.name });
    }
  }
  return refs;
}

/** Workspace-relative delivery path, or undefined when the name cannot be
 *  staged safely. Nested relative paths are legitimate (dir-keep uploads);
 *  anything absolute or escaping the staging root is not. */
function safeRelativeName(stage: string, name: string): string | undefined {
  if (!name || name.includes('\\') || path.posix.isAbsolute(name)) return undefined;
  const normalized = path.posix.normalize(name);
  if (normalized === '.' || normalized.startsWith('..')) return undefined;
  const resolved = path.resolve(stage, normalized);
  if (resolved !== stage && !resolved.startsWith(stage + path.sep)) return undefined;
  return normalized;
}

export interface SessionFilesArchive {
  data: Buffer;
  /** Registry keys of WRITABLE refs staged into this archive — the caller
   *  records them as delivered after a successful push. Read-only refs are
   *  intentionally absent so they re-deliver next exec. */
  deliveredKeys: string[];
}

/**
 * Fetches every ref from the file server and builds the delivery archive
 * (`session/<name>` members + the primed-files manifest). Throws
 * {@link SessionFilesError} on an unsafe name, a failed fetch, or a blown
 * size/count budget — a silently missing input is precisely the failure mode
 * this module exists to fix, so the execute must fail loudly rather than run
 * without the user's file. Honors `opts.signal` between and during fetches so
 * an aborted job stops consuming disk and file-server bandwidth.
 */
export async function buildSessionFilesArchive(
  refs: SessionFileRef[],
  opts: { timeoutMs: number; maxBytes: number; fileServerUrl?: string; signal?: AbortSignal },
): Promise<SessionFilesArchive | undefined> {
  if (refs.length === 0) return undefined;
  if (refs.length > SESSION_FILES_MAX_COUNT) {
    throw new SessionFilesError(
      `Session delivery of ${refs.length} files exceeds the ${SESSION_FILES_MAX_COUNT}-file limit`,
    );
  }
  const baseUrl = (opts.fileServerUrl ?? env.FILE_SERVER_URL).replace(/\/$/, '');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-session-files-'));
  const stage = path.join(tmp, 'session');
  try {
    await fsp.mkdir(stage);
    const staged: Array<SessionFileRef & { read_only: boolean }> = [];
    const seen = new Set<string>();
    /* Cumulative UNCOMPRESSED budget: per-fetch maxContentLength alone lets
     * one authorized object repeated under many names consume unbounded disk
     * and heap before the post-compression check would ever run. */
    let totalBytes = 0;
    for (const ref of refs) {
      if (opts.signal?.aborted) {
        throw new SessionFilesError('Session file delivery aborted');
      }
      const name = safeRelativeName(stage, ref.name);
      if (!name) throw new SessionFilesError(`Unsafe input file name: ${ref.name}`);
      /* The manifest rides in the archive under a reserved name. A user input
       * claiming that name would be silently replaced by protocol metadata (and
       * then deleted by the runner), so refuse the delivery instead. */
      if (name === SESSION_FILES_MANIFEST_FILE) {
        throw new SessionFilesError(`Input file name is reserved: ${SESSION_FILES_MANIFEST_FILE}`);
      }
      if (seen.has(name)) continue;
      seen.add(name);
      const fetched = await fetchFileObject(baseUrl, ref, opts);
      totalBytes += fetched.bytes.length;
      if (totalBytes > opts.maxBytes) {
        throw new SessionFilesError(
          `Session files exceed the ${opts.maxBytes}-byte delivery budget`,
        );
      }
      const target = path.join(stage, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, fetched.bytes);
      staged.push({ ...ref, name, read_only: fetched.readOnly });
    }
    await fsp.writeFile(
      path.join(stage, SESSION_FILES_MANIFEST_FILE),
      JSON.stringify({ marker: SESSION_FILES_MANIFEST_MARKER, files: staged }),
      { mode: 0o600 },
    );
    const data = await tarDirectory(tmp);
    if (data.length > opts.maxBytes) {
      throw new SessionFilesError(
        `Session files archive is ${data.length} bytes (limit ${opts.maxBytes})`,
      );
    }
    return {
      data,
      deliveredKeys: staged.filter((ref) => !ref.read_only).map(sessionFileRefKey),
    };
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
    logger.error(
      `Failed to fetch session input file ${ref.id}:`,
      getAxiosErrorDetails(error),
    );
    throw new SessionFilesError(`Failed to fetch input file ${ref.name} from file server`);
  }
}

function tarDirectory(root: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', '-', '-C', root, 'session'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    tar.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    tar.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code !== 0) {
        reject(new SessionFilesError(`session files tar exited ${code}: ${Buffer.concat(errChunks).toString()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
