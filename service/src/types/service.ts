import type { Job } from 'bullmq';
import type { IApiKey } from '@librechat/api-keys';
import type { Request } from 'express';
import type { ExecutionManifestClaims } from '../execution-manifest';
import { Jobs } from '@/enum/service';

export type FileRef = {
  id: string;
  name: string;
  session_id?: string;  // Included for self-contained file references
  path?: string;
  /** Lineage tracking - present if this file was modified from a previous session's file */
  modified_from?: {
    id: string;
    session_id: string;
  };
  /**
   * Echoed back on `inherited: true` files (unchanged input passthroughs)
   * so the caller's session-state cache can preserve the per-file entity
   * scope across the round-trip. Without this, callers either lose the
   * field on every same-name merge (silent 403 on next execute) or have
   * to defensively carry it forward themselves.
   */
  entity_id?: string;
  /**
   * `true` when the sandbox echoed this entry as an unchanged passthrough
   * of an input the caller already owns. Surfaced so callers can render
   * inputs distinctly from generated outputs and skip post-processing.
   */
  inherited?: true;
};

export type RequestFile = {
  id: string;
  session_id: string;
  name: string;
  /** Optional per-file entity scope. When present, this file's authorization
   *  resolves its sessionKey under this entity instead of the request-level
   *  `entity_id`, allowing one execute call to reference files uploaded under
   *  different entities (e.g. a skill bundle + a user attachment). Falls back
   *  to the request-level entity when absent. Charset matches
   *  `validateEntityIdString`. */
  entity_id?: string;
};

export type FileRefs = FileRef[];

export type ExecuteResponse = {
  run?: {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
    output: string;
    memory: number | null;
    message: string | null;
    status: string | null;
    cpu_time: number | null;
    wall_time: number | null;
  };
  language: string;
  version: string;
  session_id: string;
  files: FileRefs;
};

export interface RequestBody {
  code: string;
  lang: string;
  args?: string[];
  // session_id: string;
  user_id?: string;
  entity_id?: string;
  files?: RequestFile[];
}

export type CreatePayload = { req: AuthenticatedRequest, session_id: string; isPyPlot?: boolean };
export interface FileObject {
  name: string;
  id: string;
  session_id: string;
  content?: string;
  encoding?: 'base64'|'hex'|'utf8';
  size?: number;
  lastModified?: string;
  etag?: string;
  metadata?: {
    'content-type': string;
    'original-filename': string;
  } | undefined;
  versionId?: string | null;
  contentType?: string;
}

export type PayloadFile = { name: string; content: string };

export interface PayloadBody {
  language: string;
  version: string;
  run_memory_limit?: number;
  run_timeout?: number;
  run_cpu_time?: number;
  files: Array<PayloadFile | { id: string; session_id: string; name: string; entity_id?: string }>;
  session_id?: string;
  args?: string[];
  /**
   * Extra environment variables to inject into the sandboxed process via nsjail -E.
   * NOTE: PTC replay mode delivers tool-result history as a payload file
   * (`_ptc_history.json` under `/mnt/data`) rather than through this field;
   * the sandbox locates it via `PTC_HISTORY_PATH`. Size-sensitive data should
   * use files to avoid the Linux ARG_MAX ceiling.
   */
  env_vars?: Record<string, string>;
}

export type ExecuteResult = {
  session_id: string;
  stdout: string;
  stderr: string;
  files: FileRefs;
  code?: number | null;
  signal?: string | null;
  message?: string | null;
  status?: string | null;
  wall_time?: number | null;
};

export interface LanguageConfig {
  language: string;
  version: string;
  fileName: string;
  runtime?: string;
}

export type JobData = {
  code: string;
  userId: string;
  apiKeyId: string;
  apiKeyString: string;
  payload: PayloadBody;
  SANDBOX_ENDPOINT: string;
  isPyPlot?: boolean;
  executionId?: string;
  tenantId?: string;
  canonicalUserId?: string;
  executionManifestClaims?: ExecutionManifestClaims;
};
export type JobResult = ExecuteResult;
export type ExecuteJob = Job<JobData, JobResult, Jobs.execute>;

export interface CodeApiAuthContext {
  userId: string;
  tenantId: string;
  orgId?: string;
  serviceId?: string;
  chcUserId?: string;
  principalSource?: string;
  authContextHash?: string;
}

export interface AuthenticatedRequest extends Request {
  apiKey?: IApiKey;
  sessionKey?: string;
  planId?: string;
  codeApiAuthContext?: CodeApiAuthContext;
}

export interface ProgrammaticTool {
  name: string;
  description?: string;
  parameters?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// Programmatic Tool Calling Types
export interface ProgrammaticRequestBody {
  code: string;
  tools?: ProgrammaticTool[];
  session_id?: string;
  timeout?: number;
  continuation_token?: string;
  tool_results?: Array<{
    call_id: string;
    result: unknown;
    is_error?: boolean;
    error_message?: string;
  }>;
  entity_id?: string;
  user_id?: string;
  files?: RequestFile[];
  /** Optional. Defaults to 'python'. Currently supported: 'python', 'bash'. */
  language?: 'python' | 'bash';
  /** Back-compat alias for `language`. The `danny-avila/agents` bash PTC
   * client sends `lang: 'bash'` (mirroring the `lang` field on the
   * legacy `/exec` sandbox body), so the router accepts either key and
   * normalizes to `language`. If both are present, `language` wins. */
  lang?: 'python' | 'bash';
}

export interface ProgrammaticToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProgrammaticResponse {
  status: 'tool_call_required' | 'completed' | 'error';
  continuation_token?: string;
  tool_calls?: ProgrammaticToolCall[];
  partial_stdout?: string;
  partial_stderr?: string;
  stdout?: string;
  stderr?: string;
  files?: FileRefs;
  session_id?: string;
  tool_calls_made?: number;
  execution_time?: number;
  error?: string;
  error_type?: string;
}
