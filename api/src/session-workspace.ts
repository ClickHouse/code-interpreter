import { config } from './config';
import { logger } from './logger';
import {
  ensureSessionWorkspace,
  resetSessionWorkspace,
  sandboxJobUidPool,
  type SandboxJobIdentity,
  type SandboxWorkspaceLease,
} from './workspace-isolation';

/**
 * Persistent, stateful session workspace for the Lambda MicroVM backend.
 *
 * A session-bound VM runs exactly one runtime session, and its executions
 * serialize on the control-plane lock — so the runner keeps a single
 * long-lived workspace and a single pinned UID, reused by every `/execute`.
 * This is what turns the semi-stateless runner stateful: files, installed
 * packages, and chDB dirs under `/mnt/data` survive between calls instead of
 * being wiped per job.
 *
 * Gated by two independent locks (both required): the image-level
 * `SANDBOX_SESSION_WORKSPACE_ENABLED` (true only in the Lambda MicroVM runner
 * target) and a per-request opt-in. The control plane opts a VM into session
 * mode by stamping the derived runtime session id on every `/execute` via the
 * `X-Runtime-Session-Id` header (see `parseSessionBindingFromHeader`). When
 * neither lock is active, `getBoundSessionWorkspace()` returns undefined and
 * the runner falls back to the untouched fresh-per-job path.
 *
 * The header, not a `/run` lifecycle hook, is the delivery mechanism: Lambda's
 * image build hooks require the snapshot-compatible Lambda base container image
 * to route, and enabling any runtime hook forces the `/ready` build hook, which
 * never reaches a stock container's listener. Per-request signaling keeps image
 * builds hookless (reliable) and needs no snapshot handshake.
 */

/** Wire contract with the Lambda backend (`service/src/sandbox-backend`). */
export const RUNTIME_SESSION_ID_HEADER = 'x-runtime-session-id';

const RUNTIME_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SessionBinding {
  runtimeSessionId: string;
}

/** Shape of the `/run` runHookPayload the control plane delivers per VM. */
interface RunHookSessionPayload {
  runtime_session_id?: unknown;
  session_workspace?: unknown;
}

export function parseSessionBinding(runHookPayload: string | undefined): SessionBinding | undefined {
  if (!config.session_workspace_enabled) return undefined;
  if (runHookPayload == null || runHookPayload.length === 0) return undefined;
  let parsed: RunHookSessionPayload;
  try {
    parsed = JSON.parse(runHookPayload) as RunHookSessionPayload;
  } catch {
    logger.warn('Ignoring non-JSON /run runHookPayload for session binding');
    return undefined;
  }
  if (parsed.session_workspace !== true) return undefined;
  if (typeof parsed.runtime_session_id !== 'string' || parsed.runtime_session_id.length === 0) {
    logger.warn('Session workspace requested without a runtime_session_id — ignoring');
    return undefined;
  }
  return { runtimeSessionId: parsed.runtime_session_id };
}

/** Per-request session opt-in from the `X-Runtime-Session-Id` header. Presence
 *  of a well-formed id is the opt-in; the header is only honored on the Lambda
 *  MicroVM runner target (`session_workspace_enabled`). Header values arrive as
 *  `string | string[]` from Node — a repeated header is malformed, so reject. */
export function parseSessionBindingFromHeader(
  headerValue: string | string[] | undefined,
): SessionBinding | undefined {
  if (!config.session_workspace_enabled) return undefined;
  if (typeof headerValue !== 'string') return undefined;
  const runtimeSessionId = headerValue.trim();
  if (!RUNTIME_SESSION_ID_PATTERN.test(runtimeSessionId)) {
    if (runtimeSessionId.length > 0) logger.warn('Ignoring malformed X-Runtime-Session-Id header');
    return undefined;
  }
  return { runtimeSessionId };
}

export class SessionWorkspace {
  readonly runtimeSessionId: string;
  private lease: SandboxWorkspaceLease | undefined;
  private identity: SandboxJobIdentity | undefined;
  /** relPath -> signature of every file already surfaced to the client, so a
   *  later job re-scanning the persistent workspace does not re-upload
   *  unchanged prior outputs (output diffing). */
  private readonly surfaced = new Map<string, string>();
  /** relPath -> storage file id already primed onto disk, so an unchanged
   *  input delivered again is not re-downloaded (priming dedup). */
  private readonly primed = new Map<string, string>();

  constructor(binding: SessionBinding) {
    this.runtimeSessionId = binding.runtimeSessionId;
  }

  /** Acquires (once) the pinned UID + persistent dir, reused every job. */
  async acquire(): Promise<SandboxWorkspaceLease> {
    if (!this.identity) {
      const identity = sandboxJobUidPool.acquire();
      if (!identity) {
        throw new Error('No sandbox UID slot available for session workspace');
      }
      this.identity = identity;
    }
    this.lease = await ensureSessionWorkspace(this.identity);
    return this.lease;
  }

  /** The pinned UID/GID for this session, so a restored checkpoint's files
   *  can be chowned to the owner the sandbox jobs run as. Ensures the
   *  workspace/identity exist first. */
  async ownership(): Promise<{ dir: string; uid: number; gid: number }> {
    const lease = await this.acquire();
    return { dir: lease.dir, uid: lease.identity.uid, gid: lease.identity.gid };
  }

  isSurfaced(relPath: string, hash: string): boolean {
    return this.surfaced.get(relPath) === hash;
  }

  markSurfaced(relPath: string, hash: string): void {
    this.surfaced.set(relPath, hash);
  }

  forget(relPath: string): void {
    this.surfaced.delete(relPath);
  }

  primedInputId(relPath: string): string | undefined {
    return this.primed.get(relPath);
  }

  markPrimed(relPath: string, storageFileId: string): void {
    this.primed.set(relPath, storageFileId);
  }

  /** Full teardown: wipe the dir, release the pinned UID, clear diff state. */
  async reset(): Promise<void> {
    await resetSessionWorkspace();
    this.surfaced.clear();
    this.primed.clear();
    this.lease = undefined;
    if (this.identity) {
      sandboxJobUidPool.release(this.identity);
      this.identity = undefined;
    }
  }
}

let boundSession: SessionWorkspace | undefined;

/** Called by the `/run` lifecycle hook. Binding the same session twice is a
 *  no-op; a different runtime session id resets the prior one first. */
export function bindSessionWorkspace(binding: SessionBinding | undefined): SessionWorkspace | undefined {
  if (!binding) return boundSession;
  if (boundSession && boundSession.runtimeSessionId === binding.runtimeSessionId) {
    return boundSession;
  }
  if (boundSession) {
    void boundSession.reset().catch((err) => logger.error({ err }, 'Failed to reset superseded session workspace'));
  }
  boundSession = new SessionWorkspace(binding);
  return boundSession;
}

export function getBoundSessionWorkspace(): SessionWorkspace | undefined {
  return boundSession;
}

/** Called by `/terminate` (and session reset) to release the workspace. */
export async function unbindSessionWorkspace(): Promise<void> {
  const current = boundSession;
  boundSession = undefined;
  if (current) await current.reset();
}

export function resetSessionWorkspaceStateForTests(): void {
  boundSession = undefined;
}
