import axios from 'axios';
import { spawn } from 'child_process';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type * as t from '../types';
import { internalServiceHeaders } from '../internal-service-auth';
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
 */

/** Mirrors the runner's reserved manifest member (api/src/session-checkpoint.ts);
 *  both ends ship together, so a hard-coded pair needs no compat dance. */
export const SESSION_FILES_MANIFEST_FILE = '.codeapi-files.json';
export const SESSION_FILES_MANIFEST_MARKER = 'codeapi.session-files.v1';

export class SessionFilesError extends Error {}

export interface SessionFileRef {
  id: string;
  storage_session_id: string;
  name: string;
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

/**
 * Fetches every ref from the file server and builds the delivery archive
 * (`session/<name>` members + the primed-files manifest). Throws
 * {@link SessionFilesError} on an unsafe name or a failed fetch — a silently
 * missing input is precisely the failure mode this module exists to fix, so
 * the execute must fail loudly rather than run without the user's file.
 */
export async function buildSessionFilesArchive(
  refs: SessionFileRef[],
  opts: { timeoutMs: number; maxBytes: number; fileServerUrl?: string },
): Promise<Buffer | undefined> {
  if (refs.length === 0) return undefined;
  const baseUrl = (opts.fileServerUrl ?? env.FILE_SERVER_URL).replace(/\/$/, '');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-session-files-'));
  const stage = path.join(tmp, 'session');
  try {
    await fsp.mkdir(stage);
    const staged: SessionFileRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const name = safeRelativeName(stage, ref.name);
      if (!name) throw new SessionFilesError(`Unsafe input file name: ${ref.name}`);
      if (seen.has(name)) continue;
      seen.add(name);
      const bytes = await fetchFileObject(baseUrl, ref, opts);
      const target = path.join(stage, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      staged.push({ ...ref, name });
    }
    await fsp.writeFile(
      path.join(stage, SESSION_FILES_MANIFEST_FILE),
      JSON.stringify({ marker: SESSION_FILES_MANIFEST_MARKER, files: staged }),
      { mode: 0o600 },
    );
    const archive = await tarDirectory(tmp);
    if (archive.length > opts.maxBytes) {
      throw new SessionFilesError(
        `Session files archive is ${archive.length} bytes (limit ${opts.maxBytes})`,
      );
    }
    return archive;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchFileObject(
  baseUrl: string,
  ref: SessionFileRef,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<Buffer> {
  const url = `${baseUrl}/sessions/${encodeURIComponent(ref.storage_session_id)}/objects/${encodeURIComponent(ref.id)}`;
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      headers: internalServiceHeaders(),
      responseType: 'arraybuffer',
      maxContentLength: opts.maxBytes,
      timeout: opts.timeoutMs,
    });
    return Buffer.from(response.data);
  } catch (error) {
    logger.error(`Failed to fetch session input file ${ref.id}:`, error);
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
