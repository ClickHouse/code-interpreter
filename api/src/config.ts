type LimitOverrides = Record<string, Record<string, number> | undefined>;

function parseLimitOverrides(raw: string): LimitOverrides {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as LimitOverrides;
  } catch {
    return {};
  }
}

/**
 * Parses an integer env var, falling back to the default when the value is
 * missing, non-numeric, or below min. Prevents NaN from silently disabling
 * safety checks via comparisons that always return false.
 */
export function safeInt(raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

const egressGatewayUrl = process.env.EGRESS_GATEWAY_URL ?? '';
const requireExecutionManifest = (
  process.env.SANDBOX_REQUIRE_EGRESS_MANIFEST
  ?? (egressGatewayUrl ? 'true' : 'false')
) === 'true';

export const config = {
  log_level: process.env.SANDBOX_LOG_LEVEL ?? 'DEBUG',
  bind_address: `0.0.0.0:${process.env.PORT ?? 2000}`,
  data_directory: process.env.SANDBOX_DATA_DIRECTORY ?? '/piston',
  disable_networking: (process.env.SANDBOX_DISABLE_NETWORKING ?? 'true') === 'true',
  use_cgroupv2: (process.env.SANDBOX_USE_CGROUPV2 ?? 'true') === 'true',
  allowed_local_network_port: Number(process.env.SANDBOX_ALLOWED_LOCAL_NETWORK_PORT ?? 0),
  output_max_size: Number(process.env.SANDBOX_OUTPUT_MAX_SIZE ?? 1024),
  max_process_count: Number(process.env.SANDBOX_MAX_PROCESS_COUNT ?? 64),
  max_open_files: Number(process.env.SANDBOX_MAX_OPEN_FILES ?? 256),
  max_file_size: Number(process.env.SANDBOX_MAX_FILE_SIZE ?? 10000000),
  compile_timeout: Number(process.env.SANDBOX_COMPILE_TIMEOUT ?? 10000),
  run_timeout: Number(process.env.SANDBOX_RUN_TIMEOUT ?? 30000),
  compile_cpu_time: Number(process.env.SANDBOX_COMPILE_CPU_TIME ?? 10000),
  run_cpu_time: Number(process.env.SANDBOX_RUN_CPU_TIME ?? 30000),
  compile_memory_limit: Number(process.env.SANDBOX_COMPILE_MEMORY_LIMIT ?? -1),
  run_memory_limit: Number(process.env.SANDBOX_RUN_MEMORY_LIMIT ?? -1),
  max_concurrent_jobs: Number(process.env.SANDBOX_MAX_CONCURRENT_JOBS ?? 64),
  rlimit_as: Number(process.env.SANDBOX_RLIMIT_AS ?? 16384),
  rlimit_fsize: Number(process.env.SANDBOX_RLIMIT_FSIZE ?? 100),
  nsjail_path: process.env.NSJAIL_PATH ?? '/usr/sbin/nsjail',
  nsjail_config: process.env.NSJAIL_CONFIG ?? '/sandbox_api/config/sandbox.cfg',
  execute_body_limit: process.env.SANDBOX_EXECUTE_BODY_LIMIT ?? '50mb',
  egress_gateway_url: egressGatewayUrl,
  file_server_url: process.env.FILE_SERVER_URL ?? '',
  max_nesting_depth: safeInt(process.env.SANDBOX_MAX_NESTING_DEPTH, 10),
  max_path_length: safeInt(process.env.SANDBOX_MAX_PATH_LENGTH, 256),
  max_output_files: safeInt(process.env.SANDBOX_MAX_OUTPUT_FILES, 50),
  require_execution_manifest: requireExecutionManifest,
  execution_manifest_public_key: process.env.SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY
    ?? process.env.CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY
    ?? '',
  // Legacy HMAC verifier fallback for rolling upgrades only. Cloud split-runner
  // deployments should mount SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY instead so a
  // compromised runner cannot mint valid manifests.
  execution_manifest_secret: process.env.SANDBOX_EXECUTION_MANIFEST_SECRET
    ?? process.env.CODEAPI_EXECUTION_MANIFEST_SECRET
    ?? '',
  /* Cap on simultaneous PUTs to file_server during a single job's upload
   * phase. Each PUT streams from disk and holds an open fd + an HTTP
   * connection slot; without a cap a job at `max_output_files` would fan
   * out 50 connections at once, which is fine in isolation but piles up
   * across concurrent jobs. 8 is enough to saturate typical disk/network
   * throughput without exhausting the host's open-fd budget or the
   * file-server's per-session minio object-put concurrency. */
  upload_concurrency: safeInt(process.env.SANDBOX_UPLOAD_CONCURRENCY, 8),
  limit_overrides: parseLimitOverrides(process.env.SANDBOX_LIMIT_OVERRIDES ?? '{}'),
};
