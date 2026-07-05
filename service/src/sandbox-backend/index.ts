import type { SandboxBackend } from './types';
import { LambdaMicrovmSandboxBackend } from './lambda-microvm';
import { HttpSandboxBackend } from './http';
import { env } from '../config';

export type { SandboxBackend, SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
export { SandboxBackendError } from './types';
export { HttpSandboxBackend } from './http';
export { LambdaMicrovmSandboxBackend } from './lambda-microvm';

let backend: SandboxBackend | undefined;

function createBackend(): SandboxBackend {
  if (env.SANDBOX_BACKEND === 'lambda-microvm') {
    return new LambdaMicrovmSandboxBackend({
      /* Dynamic import keeps @aws-sdk out of http-only worker bundles. */
      clientFactory: async () => {
        const { AwsLambdaMicrovmClient } = await import('../runtime-session/lambda-client-aws');
        return new AwsLambdaMicrovmClient({ region: env.LAMBDA_MICROVM_REGION });
      },
      config: {
        imageArn: env.LAMBDA_MICROVM_IMAGE_ARN,
        imageVersion: env.LAMBDA_MICROVM_IMAGE_VERSION,
        executionRoleArn: env.LAMBDA_MICROVM_EXECUTION_ROLE_ARN,
        ingressConnectorArns: env.LAMBDA_MICROVM_INGRESS_CONNECTOR_ARNS,
        egressConnectorArns: env.LAMBDA_MICROVM_EGRESS_CONNECTOR_ARNS,
        port: env.LAMBDA_MICROVM_PORT,
        maxDurationSeconds: env.LAMBDA_MICROVM_MAX_DURATION_SECONDS,
        authTokenTtlSeconds: env.LAMBDA_MICROVM_AUTH_TOKEN_TTL_SECONDS,
        launchTimeoutMs: env.LAMBDA_MICROVM_LAUNCH_TIMEOUT_MS,
        healthTimeoutMs: env.LAMBDA_MICROVM_HEALTH_TIMEOUT_MS,
        launchTps: env.LAMBDA_MICROVM_LAUNCH_TPS,
        jobTimeoutMs: env.JOB_TIMEOUT,
      },
    });
  }
  return new HttpSandboxBackend();
}

export function getSandboxBackend(): SandboxBackend {
  backend ??= createBackend();
  return backend;
}

export function setSandboxBackendForTests(next: SandboxBackend | undefined): void {
  backend = next;
}
