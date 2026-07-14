import type * as t from '../types';

/**
 * Fully built sandbox execute request: `body` already carries the egress
 * grant and signed execution manifest from `buildSandboxExecuteRequest`.
 * Backends MUST NOT mutate `body` — the manifest binds its sha256.
 */
export interface SandboxTransportRequest {
  body: t.PayloadBody;
  headers: Record<string, string>;
}

export interface SandboxExecuteContext {
  executionId: string;
  language: string;
  isSynthetic: boolean;
  /** Worker-owned JOB_TIMEOUT abort signal. */
  signal: AbortSignal;
  tenantId?: string;
  canonicalUserId?: string;
  /** Absent ⇒ stateless execution (no runtime session affinity). */
  runtimeSessionId?: string;
  runtimeSessionMode: 'stateless' | 'affinity' | 'strict';
}

/** Raw sandbox response, pre-gateway-restore. */
export type SandboxRawResponse = t.ExecuteResponse & {
  session_id: string;
  files?: t.FileRefs;
  run?: t.ExecuteResponse['run'];
};

export interface SandboxBackend {
  readonly name: 'http' | 'lambda-microvm';
  execute(req: SandboxTransportRequest, ctx: SandboxExecuteContext): Promise<SandboxRawResponse>;
  shutdown?(): Promise<void>;
}

export type SandboxBackendErrorCode =
  | 'RUNTIME_SESSION_BUSY'
  | 'MICROVM_LAUNCH_FAILED'
  | 'MICROVM_LAUNCH_THROTTLED'
  | 'MICROVM_UNHEALTHY'
  | 'MICROVM_FENCED'
  | 'MICROVM_DEADLINE_EXCEEDED';

/** Lambda-only failure modes; the worker prefixes messages with the code so
 *  the router can map them (e.g. RUNTIME_SESSION_BUSY -> 409). Axios errors
 *  from the sandbox POST itself are rethrown raw by every backend. */
export class SandboxBackendError extends Error {
  /**
   * @param transient - Marks a failure the backend may safely retry once with
   * fresh identifiers (e.g. a MicroVM that reached a terminal state during
   * boot). Throttles, aborts, and deadline timeouts stay non-transient: a
   * throttle retry worsens the pressure and a timeout retry doubles the wait.
   */
  constructor(
    public readonly code: SandboxBackendErrorCode,
    message: string,
    public readonly cause?: unknown,
    public readonly transient: boolean = false,
  ) {
    super(message);
    this.name = 'SandboxBackendError';
  }
}
