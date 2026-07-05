import axios from 'axios';
import { nanoid } from 'nanoid';
import type { LambdaMicrovmClient, MicrovmDescription, MicrovmIdlePolicy } from '../runtime-session/lambda-client';
import type { SandboxBackend, SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
import { LambdaMicrovmApiError } from '../runtime-session/lambda-client';
import { MicrovmOpThrottledError, acquireOpBudget, poisonOpBucket } from '../runtime-session/throttle';
import {
  allocateRuntimeSessionGeneration,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  touchRuntimeSessionActive,
  waitForRuntimeSessionLock,
  writeRuntimeSessionRecord,
} from '../runtime-session/registry';
import {
  microvmLaunches,
  microvmLaunchDuration,
  microvmTerminations,
  microvmThrottleEvents,
  runtimeSessionFallback,
  runtimeSessionLockContention,
} from '../metrics';
import { injectTraceHeaders, withSpan } from '../telemetry';
import { SandboxBackendError } from './types';
import { Jobs } from '../enum';
import logger from '../logger';

/** Payload delivered to the MicroVM /run hook to activate the runner's
 *  persistent session workspace (see api/src/session-workspace.ts). */
function sessionRunHookPayload(runtimeSessionId: string): string {
  return JSON.stringify({ runtime_session_id: runtimeSessionId, session_workspace: true });
}

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
  /* Session-mode (find-or-launch) tuning. */
  idleSeconds: number;
  suspendedSeconds: number;
  lockWaitMs: number;
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

interface LaunchOptions {
  clientToken: string;
  runHookPayload?: string;
  idlePolicy?: MicrovmIdlePolicy;
  maxDurationSeconds: number;
}

/**
 * Lambda MicroVM backend. Two modes, chosen by the runtime session context:
 *
 * - **stateless** (no runtime session): one VM per execution — run, execute,
 *   terminate. Correct and simple; the default.
 * - **session** (affinity/strict): find-or-launch one warm VM per
 *   `runtime_session_id` via the registry, deliver the /run payload that
 *   activates the runner's persistent workspace, and reuse it across calls.
 *   AWS `idlePolicy` auto-suspends the VM when idle and auto-resumes it on the
 *   next request, so there is no explicit resume in the execute path.
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
    if (ctx.runtimeSessionId && ctx.runtimeSessionMode !== 'stateless') {
      return this.executeSession(client, req, ctx, ctx.runtimeSessionId);
    }
    return this.executeStateless(client, req, ctx);
  }

  private async executeStateless(
    client: LambdaMicrovmClient,
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
  ): Promise<SandboxRawResponse> {
    /* One-shots self-cap their lifetime near the job timeout so a crashed
     * worker cannot leak an 8h VM. */
    const maxDurationSeconds = Math.min(
      this.config.maxDurationSeconds,
      Math.ceil(this.config.jobTimeoutMs / 1_000) + 120,
    );
    const vm = await this.launch(client, ctx, {
      clientToken: ctx.executionId !== '' ? `exec-${ctx.executionId}` : `exec-${nanoid()}`,
      maxDurationSeconds,
    });
    let terminateReason = 'stateless';
    try {
      return await this.proxyExecute(client, vm, req, ctx);
    } catch (error) {
      terminateReason = ctx.signal.aborted ? 'timeout' : 'error';
      throw error;
    } finally {
      await this.terminate(client, vm.microvmId, terminateReason);
    }
  }

  private async executeSession(
    client: LambdaMicrovmClient,
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
    runtimeSessionId: string,
  ): Promise<SandboxRawResponse> {
    const lockToken = await waitForRuntimeSessionLock(runtimeSessionId, { waitMs: this.config.lockWaitMs });
    if (!lockToken) {
      runtimeSessionLockContention.inc({ mode: ctx.runtimeSessionMode });
      if (ctx.runtimeSessionMode === 'strict') {
        throw new SandboxBackendError('RUNTIME_SESSION_BUSY', `Runtime session ${runtimeSessionId} is busy`);
      }
      /* Affinity: warmth is only an optimization — fall back to a correct
       * stateless one-shot (the payload still carries all file refs). */
      runtimeSessionFallback.inc();
      return this.executeStateless(client, req, ctx);
    }

    try {
      const existing = await readRuntimeSessionRecord(runtimeSessionId);
      const vm = await this.findOrLaunchSession(client, ctx, runtimeSessionId, existing, lockToken);
      const result = await this.proxyExecute(client, vm, req, ctx);
      /* Re-read the record findOrLaunch settled on (freshly written on
       * launch, or the reused one) and only bump its liveness — preserves
       * generation, deadline, and image fields. */
      const now = Date.now();
      const settled = await readRuntimeSessionRecord(runtimeSessionId);
      if (settled) {
        await writeRuntimeSessionRecord({ ...settled, state: 'RUNNING', last_seen_at: now }, lockToken);
      }
      await touchRuntimeSessionActive(runtimeSessionId, now);
      return result;
    } finally {
      await releaseRuntimeSessionLock(runtimeSessionId, lockToken);
    }
  }

  private async findOrLaunchSession(
    client: LambdaMicrovmClient,
    ctx: SandboxExecuteContext,
    runtimeSessionId: string,
    record: RuntimeSessionRecord | null,
    lockToken: string,
  ): Promise<MicrovmDescription> {
    const deadlineHeadroomMs = this.config.jobTimeoutMs + 30_000;
    const reusable = record
      && record.state === 'RUNNING'
      && record.microvm_id
      && record.endpoint
      && (record.hard_deadline_at == null || record.hard_deadline_at - Date.now() > deadlineHeadroomMs);
    if (reusable && record) {
      /* Reuse the warm VM. If AWS auto-suspended it, the proxy request
       * transparently auto-resumes it (idlePolicy.autoResume). */
      return { microvmId: record.microvm_id as string, state: 'RUNNING', endpoint: record.endpoint };
    }

    const generation = await allocateRuntimeSessionGeneration(runtimeSessionId);
    const pendingOk = await writeRuntimeSessionRecord({
      runtime_session_id: runtimeSessionId,
      tenant_id: ctx.tenantId ?? '',
      canonical_user_id: ctx.canonicalUserId ?? '',
      state: 'PENDING',
      generation,
      last_seen_at: Date.now(),
    }, lockToken);
    if (!pendingOk) {
      throw new SandboxBackendError('MICROVM_FENCED', `Lost session lock for ${runtimeSessionId} before launch`);
    }

    const launchedAt = Date.now();
    const vm = await this.launch(client, ctx, {
      clientToken: `sess-${runtimeSessionId}-${generation}`,
      runHookPayload: sessionRunHookPayload(runtimeSessionId),
      idlePolicy: {
        maxIdleSeconds: this.config.idleSeconds,
        suspendedSeconds: this.config.suspendedSeconds,
        autoResume: true,
      },
      maxDurationSeconds: this.config.maxDurationSeconds,
    });

    const runningOk = await writeRuntimeSessionRecord({
      runtime_session_id: runtimeSessionId,
      tenant_id: ctx.tenantId ?? '',
      canonical_user_id: ctx.canonicalUserId ?? '',
      microvm_id: vm.microvmId,
      endpoint: vm.endpoint,
      port: this.config.port,
      image_arn: this.config.imageArn,
      image_version: this.config.imageVersion,
      state: 'RUNNING',
      generation,
      launched_at: launchedAt,
      last_seen_at: Date.now(),
      hard_deadline_at: launchedAt + this.config.maxDurationSeconds * 1_000 - 60_000,
    }, lockToken);
    if (!runningOk) {
      await this.terminate(client, vm.microvmId, 'error');
      throw new SandboxBackendError('MICROVM_FENCED', `Lost session lock for ${runtimeSessionId} after launch`);
    }
    return vm;
  }

  private async proxyExecute(
    client: LambdaMicrovmClient,
    vm: MicrovmDescription,
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
  ): Promise<SandboxRawResponse> {
    const base = normalizeMicrovmEndpoint(vm.endpoint ?? '');
    const token = await client.createMicrovmAuthToken({
      microvmId: vm.microvmId,
      port: this.config.port,
      ttlSeconds: this.config.authTokenTtlSeconds,
    });
    await this.assertHealthy(base, token.token, ctx);

    return withSpan('codeapi.sandbox.execute', {
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
  }

  private async launch(
    client: LambdaMicrovmClient,
    ctx: SandboxExecuteContext,
    opts: LaunchOptions,
  ): Promise<MicrovmDescription> {
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
      vm = await client.runMicrovm({
        imageIdentifier: this.config.imageArn,
        imageVersion: this.config.imageVersion,
        executionRoleArn: this.config.executionRoleArn,
        ingressConnectorArns: this.config.ingressConnectorArns,
        egressConnectorArns: this.config.egressConnectorArns,
        maximumDurationSeconds: opts.maxDurationSeconds,
        runHookPayload: opts.runHookPayload,
        idlePolicy: opts.idlePolicy,
        clientToken: opts.clientToken,
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
