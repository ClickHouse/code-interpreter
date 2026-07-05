import axios from 'axios';
import { nanoid } from 'nanoid';
import type { LambdaMicrovmClient, MicrovmDescription } from '../runtime-session/lambda-client';
import type { SandboxBackend, SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
import { LambdaMicrovmApiError } from '../runtime-session/lambda-client';
import { MicrovmOpThrottledError, acquireOpBudget, poisonOpBucket } from '../runtime-session/throttle';
import { microvmLaunches, microvmLaunchDuration, microvmTerminations, microvmThrottleEvents } from '../metrics';
import { injectTraceHeaders, withSpan } from '../telemetry';
import { SandboxBackendError } from './types';
import { Jobs } from '../enum';
import logger from '../logger';

export interface LambdaMicrovmBackendConfig {
  imageArn: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  port: number;
  maxDurationSeconds: number;
  authTokenTtlSeconds: number;
  launchTimeoutMs: number;
  healthTimeoutMs: number;
  launchTps: number;
  jobTimeoutMs: number;
}

interface LambdaMicrovmBackendDeps {
  clientFactory: () => Promise<LambdaMicrovmClient>;
  config: LambdaMicrovmBackendConfig;
  pollIntervalMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** AWS returns the endpoint as a bare host; docs samples do `https://${endpoint}`. */
export function normalizeMicrovmEndpoint(endpoint: string): string {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint.replace(/\/+$/, '');
  }
  return `https://${endpoint.replace(/\/+$/, '')}`;
}

/**
 * Stateless Lambda MicroVM backend: one VM per execution
 * (run -> poll RUNNING -> health -> execute -> terminate). Runtime-session
 * reuse (find-or-launch on the registry) lands in the next phase; the
 * startup policy rejects non-stateless modes until then.
 */
export class LambdaMicrovmSandboxBackend implements SandboxBackend {
  readonly name = 'lambda-microvm' as const;
  private clientPromise: Promise<LambdaMicrovmClient> | undefined;
  private readonly config: LambdaMicrovmBackendConfig;
  private readonly clientFactory: () => Promise<LambdaMicrovmClient>;
  private readonly pollIntervalMs: number;

  constructor(deps: LambdaMicrovmBackendDeps) {
    this.clientFactory = deps.clientFactory;
    this.config = deps.config;
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
  }

  private client(): Promise<LambdaMicrovmClient> {
    this.clientPromise ??= this.clientFactory();
    return this.clientPromise;
  }

  async execute(req: SandboxTransportRequest, ctx: SandboxExecuteContext): Promise<SandboxRawResponse> {
    const client = await this.client();
    const vm = await this.launch(client, ctx);
    let terminateReason = 'stateless';
    try {
      const base = normalizeMicrovmEndpoint(vm.endpoint ?? '');
      const token = await client.createMicrovmAuthToken({
        microvmId: vm.microvmId,
        port: this.config.port,
        ttlSeconds: this.config.authTokenTtlSeconds,
      });
      await this.assertHealthy(base, token.token, ctx);

      return await withSpan('codeapi.sandbox.execute', {
        'http.request.method': 'POST',
        'url.path': `/${Jobs.execute}`,
        'codeapi.language': ctx.language,
        'codeapi.sandbox.backend': this.name,
      }, async () => {
        const response = await axios.post<SandboxRawResponse>(
          `${base}/api/v2/${Jobs.execute}`,
          req.body,
          {
            headers: {
              ...injectTraceHeaders(req.headers),
              [token.headerName]: token.token,
            },
            signal: ctx.signal,
          },
        );
        if (response.status !== 200) {
          throw new Error('Error from sandbox');
        }
        return response.data;
      }, 'CLIENT');
    } catch (error) {
      terminateReason = ctx.signal.aborted ? 'timeout' : 'error';
      throw error;
    } finally {
      await this.terminate(client, vm.microvmId, terminateReason);
    }
  }

  private async launch(client: LambdaMicrovmClient, ctx: SandboxExecuteContext): Promise<MicrovmDescription> {
    const endLaunchTimer = microvmLaunchDuration.startTimer();
    try {
      await acquireOpBudget('run', {
        limitPerSecond: this.config.launchTps,
        budgetMs: this.config.launchTimeoutMs,
      });
    } catch (error) {
      if (error instanceof MicrovmOpThrottledError) {
        microvmThrottleEvents.inc({ op: 'run' });
        microvmLaunches.inc({ outcome: 'throttled' });
        throw new SandboxBackendError('MICROVM_LAUNCH_THROTTLED', error.message, error);
      }
      throw error;
    }

    let vm: MicrovmDescription;
    try {
      /* Stateless one-shots self-cap their lifetime near the job timeout so
       * a crashed worker cannot leak an 8h VM. */
      const maxDurationSeconds = Math.min(
        this.config.maxDurationSeconds,
        Math.ceil(this.config.jobTimeoutMs / 1_000) + 120,
      );
      vm = await client.runMicrovm({
        imageIdentifier: this.config.imageArn,
        imageVersion: this.config.imageVersion,
        executionRoleArn: this.config.executionRoleArn,
        ingressConnectorArns: this.config.ingressConnectorArns,
        egressConnectorArns: this.config.egressConnectorArns,
        maximumDurationSeconds: maxDurationSeconds,
        clientToken: ctx.executionId !== '' ? `exec-${ctx.executionId}` : `exec-${nanoid()}`,
      });
    } catch (error) {
      if (error instanceof LambdaMicrovmApiError && error.kind === 'throttled') {
        await poisonOpBucket('run');
        microvmThrottleEvents.inc({ op: 'run' });
        microvmLaunches.inc({ outcome: 'throttled' });
        throw new SandboxBackendError('MICROVM_LAUNCH_THROTTLED', error.message, error);
      }
      microvmLaunches.inc({ outcome: 'failed' });
      throw new SandboxBackendError(
        'MICROVM_LAUNCH_FAILED',
        error instanceof Error ? error.message : 'RunMicrovm failed',
        error,
      );
    }

    try {
      const ready = await this.waitUntilRunning(client, vm, ctx);
      microvmLaunches.inc({ outcome: 'ok' });
      endLaunchTimer();
      return ready;
    } catch (error) {
      microvmLaunches.inc({ outcome: 'failed' });
      await this.terminate(client, vm.microvmId, 'error');
      throw error;
    }
  }

  private async waitUntilRunning(
    client: LambdaMicrovmClient,
    vm: MicrovmDescription,
    ctx: SandboxExecuteContext,
  ): Promise<MicrovmDescription> {
    const deadline = Date.now() + this.config.launchTimeoutMs;
    let current = vm;
    while (current.state !== 'RUNNING' || !current.endpoint) {
      if (ctx.signal.aborted) {
        throw new SandboxBackendError('MICROVM_LAUNCH_FAILED', 'Execution aborted while MicroVM was launching');
      }
      if (current.state === 'TERMINATED' || current.state === 'TERMINATING') {
        throw new SandboxBackendError(
          'MICROVM_LAUNCH_FAILED',
          `MicroVM ${current.microvmId} entered ${current.state} before becoming ready`,
        );
      }
      if (Date.now() + this.pollIntervalMs > deadline) {
        throw new SandboxBackendError(
          'MICROVM_LAUNCH_FAILED',
          `MicroVM ${current.microvmId} did not reach RUNNING within ${this.config.launchTimeoutMs}ms`,
        );
      }
      await sleep(this.pollIntervalMs);
      current = await client.getMicrovm(current.microvmId);
    }
    return current;
  }

  private async assertHealthy(base: string, token: string, ctx: SandboxExecuteContext): Promise<void> {
    try {
      const response = await axios.get(`${base}/api/v2/health`, {
        headers: { 'X-aws-proxy-auth': token },
        timeout: this.config.healthTimeoutMs,
        signal: ctx.signal,
      });
      if (response.status !== 200) {
        throw new Error(`health returned ${response.status}`);
      }
    } catch (error) {
      throw new SandboxBackendError(
        'MICROVM_UNHEALTHY',
        `MicroVM health check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        error,
      );
    }
  }

  private async terminate(client: LambdaMicrovmClient, microvmId: string, reason: string): Promise<void> {
    try {
      await client.terminateMicrovm(microvmId);
      microvmTerminations.inc({ reason });
    } catch (error) {
      logger.error('Failed to terminate MicroVM', { microvmId, reason, error });
    }
  }
}
