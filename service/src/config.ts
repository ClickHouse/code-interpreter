import * as dotenv from 'dotenv';
dotenv.config();
import { nanoid } from 'nanoid';
import type * as t from './types';
import { Languages } from './enum';

export const languageConfig: Record<Languages | string, t.LanguageConfig | undefined> = {
  [Languages.bash]: { language: 'bash', version: '5.2.0', fileName: 'script.sh' },
  [Languages.js]: { language: 'bun-js', version: '1.3.13', fileName: 'index.js' },
  [Languages.node]: { language: 'node', version: '24.15.0', fileName: 'index.js' },
  [Languages.py]: { language: 'python', version: '3.14.4', fileName: 'main.py' },
  [Languages.ts]: { language: 'bun-ts', version: '1.3.13', fileName: 'main.ts' },
};

const languageAliases: Record<string, Languages> = {
  // Python
  python: Languages.py,
  py: Languages.py,

  // JavaScript (Bun)
  javascript: Languages.js,
  js: Languages.js,
  'bun-js': Languages.js,
  bun: Languages.js,

  // JavaScript (Node.js)
  node: Languages.node,
  nodejs: Languages.node,
  'node-js': Languages.node,
  'node-javascript': Languages.node,

  // TypeScript (Bun)
  typescript: Languages.ts,
  ts: Languages.ts,
  'bun-ts': Languages.ts,
  'bun-typescript': Languages.ts,

  // Bash
  bash: Languages.bash,
  sh: Languages.bash,
};

export function resolveLanguage(lang: string): Languages | undefined {
  return languageAliases[lang.toLowerCase()];
}

const defaultJobTimeoutMs = Number(process.env.JOB_TIMEOUT) || 300000;
const defaultMaxFileSize = Number(process.env.MAX_FILE_SIZE) || 25 * 1024 * 1024;
const defaultExecutionManifestTtlSeconds = Math.min(Math.ceil((defaultJobTimeoutMs + 60000) / 1000), 600);
const EGRESS_GRANT_GRACE_MS = 10 * 60 * 1000;

export function resolveEgressGrantTtlSeconds(rawTtlSeconds: string | undefined, jobTimeoutMs: number): number {
  const defaultTtlSeconds = Math.max(1, Math.ceil((jobTimeoutMs + EGRESS_GRANT_GRACE_MS) / 1000));
  if (rawTtlSeconds == null || rawTtlSeconds.trim() === '') {
    return defaultTtlSeconds;
  }

  const configuredTtlSeconds = Number(rawTtlSeconds);
  if (!Number.isFinite(configuredTtlSeconds) || configuredTtlSeconds <= 0) {
    return defaultTtlSeconds;
  }

  return Math.max(1, Math.ceil(configuredTtlSeconds));
}

export const env = {
  PORT: process.env.SERVICE_PORT ?? 3112,
  LOCAL_MODE: process.env.LOCAL_MODE === 'true',
  HARDENED_SANDBOX_MODE: process.env.CODEAPI_HARDENED_SANDBOX_MODE === 'true',
  INSTANCE_ID: process.env.INSTANCE_ID ?? nanoid(),
  HTTP_JSON_LIMIT: process.env.CODEAPI_HTTP_JSON_LIMIT ?? '50mb',
  SANDBOX_ENDPOINT: process.env.SANDBOX_ENDPOINT ?? 'http://localhost:2000/api/v2',
  EGRESS_GATEWAY_URL: process.env.EGRESS_GATEWAY_URL ?? '',
  FILE_SERVER_URL: process.env.FILE_SERVER_URL ?? 'http://localhost:3000',
  TOOL_CALL_SERVER_URL: process.env.TOOL_CALL_SERVER_URL ?? 'http://localhost:3033',
  EGRESS_GATEWAY_PORT: Number(process.env.EGRESS_GATEWAY_PORT) || 3190,
  EGRESS_GATEWAY_FILE_SERVER_URL: process.env.EGRESS_GATEWAY_FILE_SERVER_URL ?? process.env.FILE_SERVER_URL ?? 'http://localhost:3000',
  EGRESS_GATEWAY_TOOL_CALL_SERVER_URL: process.env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL ?? process.env.TOOL_CALL_SERVER_URL ?? 'http://localhost:3033',
  EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES: Number(process.env.EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES) || 1024 * 1024,
  EGRESS_GATEWAY_MAX_FILE_BYTES: Number(process.env.EGRESS_GATEWAY_MAX_FILE_BYTES ?? process.env.SANDBOX_MAX_FILE_SIZE) || 10_000_000,
  EGRESS_GATEWAY_MAX_PATH_LENGTH: Number(process.env.EGRESS_GATEWAY_MAX_PATH_LENGTH ?? process.env.SANDBOX_MAX_PATH_LENGTH) || 256,
  EGRESS_GATEWAY_MAX_NESTING_DEPTH: Number(process.env.EGRESS_GATEWAY_MAX_NESTING_DEPTH ?? process.env.SANDBOX_MAX_NESTING_DEPTH) || 10,
  EGRESS_GATEWAY_REQUEST_TIMEOUT_MS: Number(process.env.EGRESS_GATEWAY_REQUEST_TIMEOUT_MS) || 30_000,
  EGRESS_GATEWAY_REVOKE_TIMEOUT_MS: Number(process.env.EGRESS_GATEWAY_REVOKE_TIMEOUT_MS) || 5_000,
  EGRESS_LEDGER_REQUIRED: process.env.CODEAPI_EGRESS_LEDGER_REQUIRED === 'true' || process.env.CODEAPI_HARDENED_SANDBOX_MODE === 'true',
  EGRESS_LEDGER_TTL_GRACE_SECONDS: Number(process.env.CODEAPI_EGRESS_LEDGER_TTL_GRACE_SECONDS) || 300,
  EGRESS_GRANT_SECRET: process.env.CODEAPI_EGRESS_GRANT_SECRET ?? '',
  EGRESS_GRANT_TTL_SECONDS: resolveEgressGrantTtlSeconds(process.env.EGRESS_GRANT_TTL_SECONDS, defaultJobTimeoutMs),
  PYTHON_CONCURRENCY: Number(process.env.PYTHON_CONCURRENCY) || 1,
  OTHER_CONCURRENCY: Number(process.env.OTHER_CONCURRENCY) || 8,
  JOB_WINDOW: Number(process.env.JOB_WINDOW) || 1000,
  MAX_UPLOAD_CHECKS: Number(process.env.MAX_UPLOAD_CHECKS) || 14,
  MAX_UPLOAD_WAIT: Number(process.env.MAX_UPLOAD_WAIT) || 500,
  MAX_FILE_SIZE: defaultMaxFileSize,
  JOB_TIMEOUT: defaultJobTimeoutMs, // 5 minutes (increased for complex matplotlib rendering)
  // API Rate Limiting
  KEY_CACHE_TTL: Number(process.env.KEY_CACHE_TTL) || 120, // 2 minutes
  USER_CACHE_TTL: Number(process.env.USER_CACHE_TTL) || 120, // 2 minutes
  // Execution Rate Limits
  EXEC_LIMIT_WINDOW: Number(process.env.RATE_LIMIT_WINDOW) || 60 * 1000, // 1 minute
  EXEC_MAX_REQUESTS: Number(process.env.MAX_REQUESTS) || 60, // requests per minute
  // Upload Rate Limits
  UPLOAD_LIMIT_WINDOW: Number(process.env.UPLOAD_LIMIT_WINDOW) || 5 * 60 * 1000, // 5 minutes
  UPLOAD_MAX_REQUESTS: Number(process.env.UPLOAD_MAX_REQUESTS) || 30, // 30 uploads per 5 minutes
  // Download Rate Limits
  DOWNLOAD_LIMIT_WINDOW: Number(process.env.DOWNLOAD_LIMIT_WINDOW) || 60 * 1000, // 1 minute
  DOWNLOAD_MAX_REQUESTS: Number(process.env.DOWNLOAD_MAX_REQUESTS) || 60, // 60 downloads per minute
  // Files List Rate Limits
  FETCH_LIMIT_WINDOW: Number(process.env.FETCH_LIMIT_WINDOW) || 60 * 1000, // 1 minute
  FETCH_MAX_REQUESTS: Number(process.env.FETCH_MAX_REQUESTS) || 120, // 120 requests per minute
  // Redis Key Cache Config
  SESSION_CACHE_TTL: Number(process.env.SESSION_CACHE_TTL) || 86400,
  // Emails
  EMAIL_SERVER: process.env.EMAIL_SERVER ?? '',
  DOMAIN_NAME: process.env.DOMAIN_NAME ?? 'code.librechat.ai',
  FROM_NO_REPLY_EMAIL: process.env.FROM_NO_REPLY_EMAIL ?? 'LibreChat <noreply@mail.librechat.ai>',
  NEWSLETTER_SECRET: process.env.NEWSLETTER_SECRET!,
  // Optional logging
  LOGGING_ENABLED: (process.env.LOGGING_ENABLED) === 'true',
  /** Strict tenant isolation. When true, sessionKey resolution fails closed
   *  (500) on requests whose auth context lacks `tenantId`, instead of
   *  silently falling back to the `'legacy'` tenant prefix. Default OFF in
   *  code so single-tenant deploys without an auth tenancy concept keep
   *  working; multi-tenant deploys MUST set this to `true` before any tenant
   *  is multi-homed, otherwise a missing tenantId would silently bucket
   *  cross-tenant requests under the same `'legacy'` prefix. */
  TENANT_ISOLATION_STRICT: process.env.CODEAPI_TENANT_ISOLATION_STRICT === 'true',
  // Signed execution manifests. Prefer private/public key mode for split-runner
  // deployments so sandbox-runner receives only a verifier, not a signing secret.
  EXECUTION_MANIFEST_PRIVATE_KEY: process.env.CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY ?? '',
  EXECUTION_MANIFEST_PUBLIC_KEY: process.env.CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY ?? '',
  // Legacy HMAC fallback for non-split deployments. Do not mount into sandbox-runner.
  EXECUTION_MANIFEST_SECRET: process.env.CODEAPI_EXECUTION_MANIFEST_SECRET ?? '',
  EXECUTION_MANIFEST_TTL_SECONDS: Math.min(
    Number(process.env.EXECUTION_MANIFEST_TTL_SECONDS) || defaultExecutionManifestTtlSeconds,
    600,
  ),
  EXECUTION_MANIFEST_MAX_UPLOAD_BYTES: Number(process.env.EXECUTION_MANIFEST_MAX_UPLOAD_BYTES) || defaultMaxFileSize,
  EXECUTION_MANIFEST_MAX_OUTPUT_FILES: Number(process.env.EXECUTION_MANIFEST_MAX_OUTPUT_FILES) || 50,
  EXECUTION_MANIFEST_MAX_REQUESTS: Number(process.env.EXECUTION_MANIFEST_MAX_REQUESTS) || 1000,
  // Redis - Alternative DNS Lookup for AWS ElastiCache TLS connections
  REDIS_USE_ALTERNATIVE_DNS_LOOKUP: process.env.REDIS_USE_ALTERNATIVE_DNS_LOOKUP === 'true',
  /**
   * Programmatic Tool Calling execution model.
   * - `replay` (default): Temporal-style replay. Sandbox exits between round-trips;
   *   tool results are persisted in Redis and replayed into a fresh sandbox on each
   *   continuation until the code either completes or surfaces new tool calls.
   *   Safe to scale horizontally since all state lives in Redis.
   * - `blocking`: legacy path. Sandbox process stays alive across tool round-trips
   *   via a long-polling HTTP callback through the Tool Call Server. Retained as
   *   an explicit opt-in during rollout; scheduled for removal in a follow-up.
   */
  PTC_MODE: (process.env.PTC_MODE === 'blocking' ? 'blocking' : 'replay') as 'replay' | 'blocking',
  PTC_DEBUG: process.env.PTC_DEBUG === 'true',
};

const default_run_memory_limit = 256 * 1024 * 1024;
const elevated_run_memory_limit = 512 * 1024 * 1024;

type PlanLimit = {
  run_memory_limit?: number;
  max_file_size?: number;
};

type PlanLimits = {
  default: Required<PlanLimit>;
} & {
  [key: string]: PlanLimit | undefined;
};

export const planLimits: PlanLimits = {
  default: {
    run_memory_limit: Number(process.env.SANDBOX_RUN_MEMORY_LIMIT) || default_run_memory_limit,
    max_file_size: env.MAX_FILE_SIZE,
  },
  prod_RJEfVQ9bqHYRHB: {
    run_memory_limit: elevated_run_memory_limit,
    max_file_size: 50 * 1024 * 1024,
  },
  /** Pro Plan */
  prod_RJEgZe6LAkZKy8: {
    run_memory_limit: elevated_run_memory_limit,
    max_file_size: 150 * 1024 * 1024,
  },
  /** Pro Plus Plan */
  prod_T1sy0i4HGg8XZW: {
    run_memory_limit: elevated_run_memory_limit,
    max_file_size: 150 * 1024 * 1024,
  },
};
