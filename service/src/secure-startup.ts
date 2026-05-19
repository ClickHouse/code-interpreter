import { env } from './config';
import { INTERNAL_SERVICE_TOKEN_ENV } from './internal-service-auth';

export class SecureStartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureStartupConfigError';
  }
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function requireValue(name: string, value: string | undefined): void {
  if (!nonEmpty(value)) {
    throw new SecureStartupConfigError(`${name} is required in CODEAPI_HARDENED_SANDBOX_MODE`);
  }
}

function requireStrongSecret(name: string, value: string | undefined, minBytes = 32): void {
  requireValue(name, value);
  if (Buffer.byteLength(value ?? '', 'utf8') < minBytes) {
    throw new SecureStartupConfigError(`${name} must be at least ${minBytes} bytes in CODEAPI_HARDENED_SANDBOX_MODE`);
  }
}

function rejectValue(name: string, value: string | undefined): void {
  if (nonEmpty(value)) {
    throw new SecureStartupConfigError(`${name} must not be configured in CODEAPI_HARDENED_SANDBOX_MODE`);
  }
}

export function validateApiHardenedConfig(): void {
  if (!env.HARDENED_SANDBOX_MODE) return;
  rejectValue('CODEAPI_EGRESS_GRANT_SECRET', process.env.CODEAPI_EGRESS_GRANT_SECRET);
  requireValue('EGRESS_GATEWAY_URL', env.EGRESS_GATEWAY_URL);
  requireValue(INTERNAL_SERVICE_TOKEN_ENV, process.env[INTERNAL_SERVICE_TOKEN_ENV]);
}

export function validateWorkerHardenedConfig(): void {
  if (!env.HARDENED_SANDBOX_MODE) return;
  rejectValue('CODEAPI_EGRESS_GRANT_SECRET', process.env.CODEAPI_EGRESS_GRANT_SECRET);
  rejectValue('CODEAPI_EXECUTION_MANIFEST_SECRET', process.env.CODEAPI_EXECUTION_MANIFEST_SECRET);
  rejectValue('CODEAPI_SYNTHETIC_ACCESS_TOKEN', process.env.CODEAPI_SYNTHETIC_ACCESS_TOKEN);
  requireValue('EGRESS_GATEWAY_URL', env.EGRESS_GATEWAY_URL);
  requireValue(INTERNAL_SERVICE_TOKEN_ENV, process.env[INTERNAL_SERVICE_TOKEN_ENV]);
  requireValue('CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY', env.EXECUTION_MANIFEST_PRIVATE_KEY);
}

export function validateEgressGatewayHardenedConfig(): void {
  if (!env.HARDENED_SANDBOX_MODE) return;
  rejectValue('CODEAPI_SYNTHETIC_ACCESS_TOKEN', process.env.CODEAPI_SYNTHETIC_ACCESS_TOKEN);
  requireStrongSecret('CODEAPI_EGRESS_GRANT_SECRET', env.EGRESS_GRANT_SECRET);
  requireValue(INTERNAL_SERVICE_TOKEN_ENV, process.env[INTERNAL_SERVICE_TOKEN_ENV]);
  requireValue('EGRESS_GATEWAY_FILE_SERVER_URL', env.EGRESS_GATEWAY_FILE_SERVER_URL);
  requireValue('EGRESS_GATEWAY_TOOL_CALL_SERVER_URL', env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL);
  requireValue('REDIS_HOST', process.env.REDIS_HOST);
  if (!env.EGRESS_LEDGER_REQUIRED) {
    throw new SecureStartupConfigError('CODEAPI_EGRESS_LEDGER_REQUIRED must be true in CODEAPI_HARDENED_SANDBOX_MODE');
  }
}
