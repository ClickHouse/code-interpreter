import { afterEach, describe, expect, test } from 'bun:test';
import { env } from './config';
import {
  validateApiHardenedConfig,
  validateEgressGatewayHardenedConfig,
  validateWorkerHardenedConfig,
} from './secure-startup';

const savedEnv = { ...process.env };
const saved = {
  hardened: env.HARDENED_SANDBOX_MODE,
  gatewayUrl: env.EGRESS_GATEWAY_URL,
  grantSecret: env.EGRESS_GRANT_SECRET,
  privateKey: env.EXECUTION_MANIFEST_PRIVATE_KEY,
  hmacSecret: env.EXECUTION_MANIFEST_SECRET,
  ledgerRequired: env.EGRESS_LEDGER_REQUIRED,
  fileServerUrl: env.EGRESS_GATEWAY_FILE_SERVER_URL,
  toolCallUrl: env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL,
};

function restore(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  env.HARDENED_SANDBOX_MODE = saved.hardened;
  env.EGRESS_GATEWAY_URL = saved.gatewayUrl;
  env.EGRESS_GRANT_SECRET = saved.grantSecret;
  env.EXECUTION_MANIFEST_PRIVATE_KEY = saved.privateKey;
  env.EXECUTION_MANIFEST_SECRET = saved.hmacSecret;
  env.EGRESS_LEDGER_REQUIRED = saved.ledgerRequired;
  env.EGRESS_GATEWAY_FILE_SERVER_URL = saved.fileServerUrl;
  env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL = saved.toolCallUrl;
}

afterEach(restore);

describe('hardened CodeAPI startup config', () => {
  test('rejects grant secrets in API and worker processes', () => {
    env.HARDENED_SANDBOX_MODE = true;
    env.EGRESS_GATEWAY_URL = 'http://egress-gateway:3190';
    env.EXECUTION_MANIFEST_PRIVATE_KEY = 'private-key';
    process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = 'internal-token';
    process.env.CODEAPI_EGRESS_GRANT_SECRET = 'must-not-be-here';

    expect(() => validateApiHardenedConfig()).toThrow('CODEAPI_EGRESS_GRANT_SECRET');
    expect(() => validateWorkerHardenedConfig()).toThrow('CODEAPI_EGRESS_GRANT_SECRET');
  });

  test('rejects legacy HMAC signing in hardened worker mode', () => {
    env.HARDENED_SANDBOX_MODE = true;
    env.EGRESS_GATEWAY_URL = 'http://egress-gateway:3190';
    env.EXECUTION_MANIFEST_PRIVATE_KEY = 'private-key';
    process.env.CODEAPI_EXECUTION_MANIFEST_SECRET = 'legacy-secret';
    process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = 'internal-token';

    expect(() => validateWorkerHardenedConfig()).toThrow('CODEAPI_EXECUTION_MANIFEST_SECRET');
  });

  test('keeps synthetic auth token out of worker and egress processes', () => {
    env.HARDENED_SANDBOX_MODE = true;
    env.EGRESS_GATEWAY_URL = 'http://egress-gateway:3190';
    env.EXECUTION_MANIFEST_PRIVATE_KEY = 'private-key';
    env.EGRESS_GRANT_SECRET = 'strong-egress-grant-secret-32-bytes';
    env.EGRESS_LEDGER_REQUIRED = true;
    env.EGRESS_GATEWAY_FILE_SERVER_URL = 'http://file-server:3000';
    env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL = 'http://tool-call-server:3033';
    process.env.REDIS_HOST = 'redis';
    process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = 'internal-token';
    process.env.CODEAPI_SYNTHETIC_ACCESS_TOKEN = 'synthetic-token-must-stay-on-api';

    expect(() => validateWorkerHardenedConfig()).toThrow('CODEAPI_SYNTHETIC_ACCESS_TOKEN');
    expect(() => validateEgressGatewayHardenedConfig()).toThrow('CODEAPI_SYNTHETIC_ACCESS_TOKEN');
  });

  test('requires gateway URL, internal auth, and worker manifest private key', () => {
    env.HARDENED_SANDBOX_MODE = true;
    env.EGRESS_GATEWAY_URL = '';
    env.EXECUTION_MANIFEST_PRIVATE_KEY = 'private-key';
    process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = 'internal-token';

    expect(() => validateApiHardenedConfig()).toThrow('EGRESS_GATEWAY_URL');
    expect(() => validateWorkerHardenedConfig()).toThrow('EGRESS_GATEWAY_URL');

    env.EGRESS_GATEWAY_URL = 'http://egress-gateway:3190';
    delete process.env.CODEAPI_INTERNAL_SERVICE_TOKEN;
    expect(() => validateApiHardenedConfig()).toThrow('CODEAPI_INTERNAL_SERVICE_TOKEN');
    expect(() => validateWorkerHardenedConfig()).toThrow('CODEAPI_INTERNAL_SERVICE_TOKEN');

    process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = 'internal-token';
    env.EXECUTION_MANIFEST_PRIVATE_KEY = '';
    expect(() => validateWorkerHardenedConfig()).toThrow('CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY');
  });

  test('requires strong gateway secret, Redis ledger, and upstream URLs', () => {
    env.HARDENED_SANDBOX_MODE = true;
    env.EGRESS_GRANT_SECRET = 'strong-egress-grant-secret-32-bytes';
    env.EGRESS_LEDGER_REQUIRED = true;
    process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = 'internal-token';
    process.env.REDIS_HOST = 'redis';

    env.EGRESS_GATEWAY_FILE_SERVER_URL = '';
    env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL = 'http://tool-call-server:3033';
    expect(() => validateEgressGatewayHardenedConfig()).toThrow('EGRESS_GATEWAY_FILE_SERVER_URL');

    env.EGRESS_GATEWAY_FILE_SERVER_URL = 'http://file-server:3000';
    env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL = '';
    expect(() => validateEgressGatewayHardenedConfig()).toThrow('EGRESS_GATEWAY_TOOL_CALL_SERVER_URL');

    env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL = 'http://tool-call-server:3033';
    delete process.env.REDIS_HOST;
    expect(() => validateEgressGatewayHardenedConfig()).toThrow('REDIS_HOST');

    process.env.REDIS_HOST = 'redis';
    env.EGRESS_GRANT_SECRET = 'short';
    expect(() => validateEgressGatewayHardenedConfig()).toThrow('at least 32 bytes');

    env.EGRESS_GRANT_SECRET = 'strong-egress-grant-secret-32-bytes';
    env.EGRESS_LEDGER_REQUIRED = false;
    expect(() => validateEgressGatewayHardenedConfig()).toThrow('CODEAPI_EGRESS_LEDGER_REQUIRED');
  });
});
