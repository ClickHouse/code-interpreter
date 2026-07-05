import { afterEach, describe, expect, test } from 'bun:test';
import { env } from './config';
import {
  validateApiHardenedConfig,
  validateEgressGatewayHardenedConfig,
  validateSandboxBackendPolicy,
  validateWorkerHardenedConfig,
} from './secure-startup';

const savedEnv = { ...process.env };
const saved = {
  hardened: env.HARDENED_SANDBOX_MODE,
  sandboxBackend: env.SANDBOX_BACKEND,
  ptcMode: env.PTC_MODE,
  runtimeSessionMode: env.RUNTIME_SESSION_MODE,
  lambdaImageArn: env.LAMBDA_MICROVM_IMAGE_ARN,
  lambdaEgressConnectors: env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS,
  lambdaTokenTtl: env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS,
  lambdaAllowShell: env.LAMBDA_MICROVM_ALLOW_SHELL,
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
  env.SANDBOX_BACKEND = saved.sandboxBackend;
  env.PTC_MODE = saved.ptcMode;
  env.RUNTIME_SESSION_MODE = saved.runtimeSessionMode;
  env.LAMBDA_MICROVM_IMAGE_ARN = saved.lambdaImageArn;
  env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS = saved.lambdaEgressConnectors;
  env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS = saved.lambdaTokenTtl;
  env.LAMBDA_MICROVM_ALLOW_SHELL = saved.lambdaAllowShell;
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

describe('sandbox backend policy', () => {
  function configureValidLambda(): void {
    env.SANDBOX_BACKEND = 'lambda-microvm';
    env.HARDENED_SANDBOX_MODE = false;
    env.PTC_MODE = 'replay';
    env.RUNTIME_SESSION_MODE = 'stateless';
    env.LAMBDA_MICROVM_IMAGE_ARN = 'arn:aws:lambda:us-east-2:1:microvm-image:codeapi';
    env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS = undefined;
    env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS = 300;
    env.LAMBDA_MICROVM_ALLOW_SHELL = false;
  }

  test('accepts the default http backend', () => {
    env.SANDBOX_BACKEND = 'http';
    env.RUNTIME_SESSION_MODE = 'stateless';
    expect(() => validateSandboxBackendPolicy()).not.toThrow();
  });

  test('accepts a fully configured stateless lambda backend', () => {
    configureValidLambda();
    expect(() => validateSandboxBackendPolicy()).not.toThrow();
  });

  test('strict runtime sessions require the lambda backend', () => {
    env.SANDBOX_BACKEND = 'http';
    env.RUNTIME_SESSION_MODE = 'strict';
    expect(() => validateSandboxBackendPolicy()).toThrow('requires the lambda-microvm backend');
  });

  test('rejects blocking PTC on the lambda backend', () => {
    configureValidLambda();
    env.PTC_MODE = 'blocking';
    expect(() => validateSandboxBackendPolicy()).toThrow('PTC replay is the only supported PTC mode');
  });

  test('requires the image ARN', () => {
    configureValidLambda();
    env.LAMBDA_MICROVM_IMAGE_ARN = '';
    expect(() => validateSandboxBackendPolicy()).toThrow('LAMBDA_MICROVM_IMAGE_ARN is required');
  });

  test('rejects non-stateless session modes until orchestration lands', () => {
    configureValidLambda();
    env.RUNTIME_SESSION_MODE = 'affinity';
    expect(() => validateSandboxBackendPolicy()).toThrow('session orchestration is not yet available');
  });

  test('hardened mode requires an egress connector', () => {
    configureValidLambda();
    env.HARDENED_SANDBOX_MODE = true;
    expect(() => validateSandboxBackendPolicy()).toThrow('LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS is required');
    env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS = ['arn:aws:lambda:us-east-2:1:network-connector:vpc-egress'];
    expect(() => validateSandboxBackendPolicy()).not.toThrow();
  });

  test('caps ingress token TTL and blocks shell ingress in hardened mode', () => {
    configureValidLambda();
    env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS = 901;
    expect(() => validateSandboxBackendPolicy()).toThrow('must be 900 or less');

    configureValidLambda();
    env.LAMBDA_MICROVM_ALLOW_SHELL = true;
    expect(() => validateSandboxBackendPolicy()).not.toThrow();
    env.HARDENED_SANDBOX_MODE = true;
    env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS = ['arn:aws:lambda:us-east-2:1:network-connector:vpc-egress'];
    expect(() => validateSandboxBackendPolicy()).toThrow('LAMBDA_MICROVM_ALLOW_SHELL');
  });
});
