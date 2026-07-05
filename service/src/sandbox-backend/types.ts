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
