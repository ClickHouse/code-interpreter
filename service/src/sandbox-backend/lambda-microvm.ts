import axios from 'axios';
import { nanoid } from 'nanoid';
import type { LambdaMicrovmClient, MicrovmAuthToken, MicrovmDescription, MicrovmIdlePolicy } from '../runtime-session/lambda-client';
import type { SandboxBackend, SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
import type { RuntimeSessionRecord } from '../runtime-session/registry';
import type { CheckpointConfig } from '../runtime-session/checkpoint';
import type { CheckpointStore } from '../runtime-session/checkpoint-store';
import { LambdaMicrovmApiError, microvmPortHeaders } from '../runtime-session/lambda-client';
import { MicrovmOpThrottledError, acquireOpBudget, poisonOpBucket } from '../runtime-session/throttle';
import { checkpointSession, restoreSession } from '../runtime-session/checkpoint';
import {
  RUNTIME_SESSION_LOCK_TTL_MS,
  allocateRuntimeSessionGeneration,
  readRuntimeSessionRecord,
  releaseRuntimeSessionLock,
  removeRuntimeSession,
  renewRuntimeSessionLock,
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

/** Header that opts a proxied /execute into the runner's persistent session
 *  workspace (see api/src/session-workspace.ts). Session mode is delivered
 *  per-request, not via a /run lifecycle hook — Lambda's build hooks require
 *  the snapshot-compatible base container image to route, and enabling any
 *  runtime hook forces the /ready build hook (which never reaches a stock
 *  container's listener), so hookless + per-request keeps image builds sound. */
const RUNTIME_SESSION_ID_HEADER = 'X-Runtime-Session-Id';

export interface LambdaMicrovmBackendConfig {
  imageArn: string;
  imageVersion?: string;
  executionRoleArn?: string;
  logGroup?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  port: number;
  maxDurationSeconds: number;
  authTokenTtlSeconds: number;
  launchTimeoutMs: number;
  healthTimeoutMs: number;
  launchTps: number;
  tokenTps: number;
  jobTimeoutMs: number;
  /* Session-mode (find-or-launch) tuning. */
  idleSeconds: number;
  suspendedSeconds: number;
  lockWaitMs: number;
  /* Auto-checkpoint. When disabled, session VMs still reuse a warm workspace
   * but expiry recovery falls back to file refs (no cross-VM restore). */
  checkpointsEnabled: boolean;
  checkpoint: CheckpointConfig;
}

interface LambdaMicrovmBackendDeps {
  clientFactory: () => Promise<LambdaMicrovmClient>;
  config: LambdaMicrovmBackendConfig;
  pollIntervalMs?: number;
  /** Injected in session+checkpoint mode; undefined disables checkpoints. */
  checkpointStore?: CheckpointStore;
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
  idlePolicy?: MicrovmIdlePolicy;
  maxDurationSeconds: number;
}

/**
 * Lambda MicroVM backend. Two modes, chosen by the runtime session context:
 *
 * - **stateless** (no runtime session): one VM per execution — run, execute,
 *   terminate. Correct and simple; the default.
 * - **session** (affinity/strict): find-or-launch one warm VM per
 *   `runtime_session_id` via the registry, stamp that id on every proxied
 *   /execute (the header that activates the runner's persistent workspace),
 *   and reuse the VM across calls.
 *   AWS `idlePolicy` auto-suspends the VM when idle and auto-resumes it on the
 *   next request, so there is no explicit resume in the execute path.
 */
export class LambdaMicrovmSandboxBackend implements SandboxBackend {
  readonly name = 'lambda-microvm' as const;
  private clientPromise: Promise<LambdaMicrovmClient> | undefined;
  private readonly config: LambdaMicrovmBackendConfig;
  private readonly clientFactory: () => Promise<LambdaMicrovmClient>;
  private readonly pollIntervalMs: number;
  private readonly checkpointStore: CheckpointStore | undefined;

  constructor(deps: LambdaMicrovmBackendDeps) {
    this.clientFactory = deps.clientFactory;
    this.config = deps.config;
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
    this.checkpointStore = deps.checkpointStore;
  }

  private checkpointsActive(): boolean {
    return this.config.checkpointsEnabled && this.checkpointStore !== undefined;
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
    /* Approximate the JOB_TIMEOUT budget consumed so we don't push the result
     * past the router's `waitUntilFinished(JOB_TIMEOUT)` with an optional
     * checkpoint (below). Captured before the lock wait so lock-wait + launch +
     * execute all count. */
    const startedAt = Date.now();
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

    /* Heartbeat the lock for as long as we hold it so an arbitrarily long
     * critical path (launch throttle + readiness/restore + execute + checkpoint,
     * each with its own I/O and token-mint waits) can't outlive a fixed TTL and
     * let a second worker fence us and run concurrently. Fenced renew stops
     * itself; the interval is a third of the TTL so a couple of missed ticks are
     * survivable. */
    const heartbeat = setInterval(() => {
      void renewRuntimeSessionLock(runtimeSessionId, lockToken).then((held) => {
        if (!held) clearInterval(heartbeat);
      });
    }, Math.floor(RUNTIME_SESSION_LOCK_TTL_MS / 3));

    try {
      const existing = await readRuntimeSessionRecord(runtimeSessionId);
      const { vm, reused } = await this.findOrLaunchSession(client, ctx, runtimeSessionId, existing, lockToken);
      const result = await this.executeOnSessionVm(client, vm, req, ctx, runtimeSessionId, lockToken, reused);
      /* Re-read the record findOrLaunch settled on (freshly written on
       * launch, or the reused one) and only bump its liveness — preserves
       * generation, deadline, and image fields. */
      const now = Date.now();
      /* The post-run checkpoint is an optional cache write. Skip it when the job
       * budget won't fit a full checkpoint, so a run that already succeeded
       * isn't timed out at the router by the checkpoint's latency — the next
       * relaunch restores the prior checkpoint, one exec staler. */
      const remainingBudgetMs = this.config.jobTimeoutMs - (now - startedAt);
      /* Reserve the WHOLE checkpoint path, not just one timeout: it can spend a
       * token-budget wait (up to launchTimeoutMs) + the checkpoint GET + the
       * object-store sequence/list (only on counter reset/first write) + the
       * object-store put (each up to checkpoint.timeoutMs). Guarding on a
       * single timeout let a run finishing with barely more than that still
       * block long enough to blow the router's waitUntilFinished(JOB_TIMEOUT)
       * after the sandbox work already succeeded. */
      const worstCaseCheckpointMs =
        this.config.launchTimeoutMs + 3 * this.config.checkpoint.timeoutMs;
      const canCheckpoint = !ctx.signal.aborted && remainingBudgetMs > worstCaseCheckpointMs;
      const settled = await readRuntimeSessionRecord(runtimeSessionId);
      const nextRecord = settled
        ? canCheckpoint
          ? await this.checkpointUnderLock(client, settled, runtimeSessionId, now, lockToken)
          : { ...settled, state: 'RUNNING' as const, last_seen_at: now }
        : undefined;
      if (nextRecord) {
        const persisted = await writeRuntimeSessionRecord(nextRecord, lockToken);
        if (!persisted) {
          throw new SandboxBackendError('MICROVM_FENCED', `Lost session lock for ${runtimeSessionId} after execute`);
        }
      }
      await touchRuntimeSessionActive(runtimeSessionId, now);
      return result;
    } finally {
      clearInterval(heartbeat);
      await releaseRuntimeSessionLock(runtimeSessionId, lockToken);
    }
  }

  /**
   * Proxies the execute to a session VM and, on a failure that means the VM
   * must not be reused, terminates it and drops the registry record so the next
   * call relaunches + restores rather than reusing a dead-or-dirty VM:
   *  - abort (JOB_TIMEOUT): the runner keeps NsJail running until the child
   *    exits even after the socket closes, so a later request reusing this VM
   *    could mutate the workspace concurrently with the timed-out run.
   *  - VM unreachable (health/connection failure, e.g. idlePolicy auto-terminated
   *    a suspended VM): the RUNNING record would otherwise keep pointing at a
   *    dead VM until the hard deadline, and every request would reuse it.
   * A plain non-200 from a live runner (`Error from sandbox`) leaves the warm VM
   * and its record intact — the VM is healthy, only the request failed.
   */
  private async executeOnSessionVm(
    client: LambdaMicrovmClient,
    vm: MicrovmDescription,
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
    runtimeSessionId: string,
    lockToken: string,
    reused: boolean,
  ): Promise<SandboxRawResponse> {
    try {
      return await this.proxyExecute(client, vm, req, ctx, runtimeSessionId, reused);
    } catch (error) {
      /* Recycle the VM ONLY on positive evidence it's unreachable or dirty:
       *  - abort: the runner keeps NsJail running after the socket closes, so a
       *    reuse could mutate the workspace concurrently.
       *  - a transport-level axios failure (no `.response`): the execute couldn't
       *    reach the VM (connection refused/timeout).
       *  - a failed health check: assertHealthy wraps the connection/timeout/non-200
       *    into MICROVM_UNHEALTHY, so it isn't a top-level AxiosError.
       * Everything else keeps the warm VM: a non-2xx sandbox response (AxiosError
       * WITH `.response` — the VM is alive, only the request failed) and a
       * pre-request control-plane failure like a throttled CreateMicrovmAuthToken
       * (not an axios error at all) — the VM was never touched.
       * Exception: a proxy 5xx (502/503/504) is the AWS gateway reporting the
       * VM as unreachable — typically a suspended VM that failed to auto-resume,
       * but it can also happen after a fresh VM passed health and then died.
       * That has `.response` (so it's not a transport failure) but means the VM
       * is dead, not that the runner rejected the request; recycle it, else
       * every later call keeps reusing the dead VM until idle expiry. */
      const status = axios.isAxiosError(error) ? error.response?.status ?? 0 : 0;
      const transportFailure = axios.isAxiosError(error) && error.response == null;
      const unhealthy = error instanceof SandboxBackendError && error.code === 'MICROVM_UNHEALTHY';
      const gatewayUnreachable = status >= 502 && status <= 504;
      if (ctx.signal.aborted || transportFailure || unhealthy || gatewayUnreachable) {
        await this.terminate(client, vm.microvmId, ctx.signal.aborted ? 'timeout' : 'error').catch(() => {});
        await removeRuntimeSession(runtimeSessionId, lockToken).catch(() => {});
      }
      throw error;
    }
  }

  /** Order-independent fingerprint of the ingress/egress connector ARNs the
   *  current config would launch a VM with, recorded on the session so a
   *  connector config change makes an existing VM non-reusable. */
  private connectorFingerprint(): string {
    const ingress = [...(this.config.ingressConnectorArns ?? [])].sort();
    const egress = [...(this.config.egressConnectorArns ?? [])].sort();
    return JSON.stringify({ ingress, egress });
  }

  private async findOrLaunchSession(
    client: LambdaMicrovmClient,
    ctx: SandboxExecuteContext,
    runtimeSessionId: string,
    record: RuntimeSessionRecord | null,
    lockToken: string,
  ): Promise<{ vm: MicrovmDescription; reused: boolean }> {
    const deadlineHeadroomMs = this.config.jobTimeoutMs + 30_000;
    /* A record whose image/version/port no longer match the current config was
     * launched by an older deploy — relaunch on the current config rather than
     * reuse it (a changed port would otherwise health-check the wrong port and
     * fail as UNHEALTHY instead of cleanly relaunching). */
    const configMatches = record
      && record.image_arn === this.config.imageArn
      && record.image_version === this.config.imageVersion
      && record.port === this.config.port
      && (record.connectors ?? '') === this.connectorFingerprint();
    /* Past idle+suspended, AWS auto-terminates the suspended VM while the record
     * still reads RUNNING until the 8h hard deadline. Treat that as non-reusable
     * so the first request after idle expiry relaunches + restores, instead of
     * reusing a dead endpoint, failing the health check, and returning 503. */
    const idleTerminationMs = (this.config.idleSeconds + this.config.suspendedSeconds) * 1_000;
    const likelyIdleTerminated = record != null && Date.now() - record.last_seen_at > idleTerminationMs;
    const reusable = record
      && record.state === 'RUNNING'
      && record.microvm_id
      && record.endpoint
      && configMatches
      && !likelyIdleTerminated
      && (record.hard_deadline_at == null || record.hard_deadline_at - Date.now() > deadlineHeadroomMs);
    if (reusable && record) {
      /* Reuse the warm VM. If AWS auto-suspended it, the proxy request
       * transparently auto-resumes it (idlePolicy.autoResume). */
      return {
        vm: { microvmId: record.microvm_id as string, state: 'RUNNING', endpoint: record.endpoint },
        reused: true,
      };
    }

    /* We're relaunching. If the recorded VM is a live-but-non-reusable one
     * (config/version/port drift, or deadline too close for this job) it would
     * otherwise leak — running/suspended and billing until idle/max-duration
     * expiry — once we overwrite the record below. Terminate it first. Skip
     * when likelyIdleTerminated: AWS already killed it, so that's positive
     * evidence it's gone and terminate would be a wasted not-found call. */
    if (record?.microvm_id && !likelyIdleTerminated) {
      await this.terminate(client, record.microvm_id, 'superseded').catch(() => {});
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
      connectors: this.connectorFingerprint(),
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

    /* Fresh VM: restore the predecessor's workspace before the first execute so
     * an 8h rollover / eviction is invisible. Attempt whenever checkpoints are
     * active, NOT only when a Redis record exists — the checkpoint lives under a
     * deterministic S3 key that can outlive/repair a lost record, and
     * restoreSession treats a missing object as `absent` (a truly new session
     * just no-ops one stat). */
    if (this.checkpointStore && this.checkpointsActive()) {
      const endpointBase = normalizeMicrovmEndpoint(vm.endpoint ?? '');
      /* Wait for the runner's API listener before restoring. RUNNING is a
       * control-plane state — the endpoint can be allocated while the app is
       * still booting, and pushRestore is intentionally non-fatal, so a restore
       * that raced the boot would silently drop the checkpoint and run the first
       * execute on an empty workspace. If the runner never comes up, tear the VM
       * down so the next call relaunches instead of reusing a dead endpoint. */
      try {
        await this.waitForRunnerReady(client, vm.microvmId, endpointBase, ctx);
      } catch (error) {
        await this.terminate(client, vm.microvmId, 'error').catch(() => {});
        await removeRuntimeSession(runtimeSessionId, lockToken).catch(() => {});
        throw error;
      }
      const restoreResult = await restoreSession({
        mintToken: (microvmId) => this.mintAuthToken(client, microvmId),
        store: this.checkpointStore,
        runtimeSessionId,
        microvmId: vm.microvmId,
        endpointBase,
        config: this.config.checkpoint,
      });
      /* A push-restore that failed after the runner began extracting leaves the
       * workspace possibly-partial (the runner's cleanup runs async past our
       * abort). Don't execute against it — recycle so the next call relaunches a
       * clean VM. (A fetch failure / absent checkpoint is safe: the workspace is
       * the untouched fresh one.) */
      if (restoreResult === 'push_failed') {
        await this.terminate(client, vm.microvmId, 'error').catch(() => {});
        await removeRuntimeSession(runtimeSessionId, lockToken).catch(() => {});
        throw new SandboxBackendError('MICROVM_UNHEALTHY', 'Checkpoint restore left the workspace in an unknown state');
      }
    }
    return { vm, reused: false };
  }

  /** Polls the runner's health endpoint until it responds, bounded by the
   *  launch timeout — a freshly-RUNNING VM's app may still be booting. */
  private async waitForRunnerReady(
    client: LambdaMicrovmClient,
    microvmId: string,
    base: string,
    ctx: SandboxExecuteContext,
  ): Promise<void> {
    const token = await this.mintAuthToken(client, microvmId);
    const deadline = Date.now() + this.config.launchTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) {
        throw new SandboxBackendError('MICROVM_LAUNCH_FAILED', 'Execution aborted while waiting for runner readiness');
      }
      try {
        await this.assertHealthy(base, token.token, ctx);
        return;
      } catch (error) {
        lastError = error;
        await sleep(this.pollIntervalMs);
      }
    }
    throw lastError instanceof SandboxBackendError
      ? lastError
      : new SandboxBackendError('MICROVM_UNHEALTHY', 'Runner did not become ready before restore', lastError);
  }

  /**
   * Pulls a checkpoint from the still-warm VM while the exec lock is held and
   * stores it, returning the record to persist (with the checkpoint pointer)
   * or the liveness-only update if checkpoints are off/failed. Never throws —
   * a missed checkpoint degrades to file-ref recovery.
   */
  private async checkpointUnderLock(
    client: LambdaMicrovmClient,
    record: RuntimeSessionRecord,
    runtimeSessionId: string,
    now: number,
    lockToken: string,
  ): Promise<RuntimeSessionRecord> {
    const base: RuntimeSessionRecord = { ...record, state: 'RUNNING', last_seen_at: now };
    if (!this.checkpointStore || !this.checkpointsActive() || !record.microvm_id || !record.endpoint) {
      return base;
    }
    const result = await checkpointSession({
      mintToken: (microvmId) => this.mintAuthToken(client, microvmId),
      store: this.checkpointStore,
      runtimeSessionId,
      config: this.config.checkpoint,
      normalizeEndpoint: normalizeMicrovmEndpoint,
      lockToken,
    });
    /* checkpointSession wrote the pointer under our lock on success; re-read so
     * we keep it, but re-apply `last_seen_at: now` — that record was built from
     * the pre-execute snapshot, so without this the liveness timestamp never
     * advances on checkpointed executes and an actively-used session would look
     * idle and relaunch needlessly. */
    if (result === 'stored') {
      const persisted = await readRuntimeSessionRecord(runtimeSessionId);
      return persisted ? { ...persisted, last_seen_at: now } : base;
    }
    return base;
  }

  /** Mints a proxy auth token under the shared per-second token budget, so
   *  concurrent warm-session executes queue instead of bursting past AWS's
   *  CreateMicrovmAuthToken TPS limit (mirrors launch's `run` budget). Maps
   *  control-plane failures to SandboxBackendError so they never escape raw:
   *  `throttled` poisons the bucket for backoff, and `not_found` (the VM was
   *  evicted/terminated) surfaces as MICROVM_UNHEALTHY so the caller tears down
   *  the stale record and relaunches instead of retrying a dead VM. */
  private async mintAuthToken(client: LambdaMicrovmClient, microvmId: string): Promise<MicrovmAuthToken> {
    try {
      await acquireOpBudget('token', {
        limitPerSecond: this.config.tokenTps,
        budgetMs: this.config.launchTimeoutMs,
      });
    } catch (error) {
      if (error instanceof MicrovmOpThrottledError) {
        microvmThrottleEvents.inc({ op: 'token' });
        throw new SandboxBackendError('MICROVM_LAUNCH_THROTTLED', error.message, error);
      }
      throw error;
    }
    try {
      return await client.createMicrovmAuthToken({
        microvmId,
        port: this.config.port,
        ttlSeconds: this.config.authTokenTtlSeconds,
      });
    } catch (error) {
      if (error instanceof LambdaMicrovmApiError && error.kind === 'throttled') {
        await poisonOpBucket('token');
        microvmThrottleEvents.inc({ op: 'token' });
        throw new SandboxBackendError('MICROVM_LAUNCH_THROTTLED', error.message, error);
      }
      if (error instanceof LambdaMicrovmApiError && error.kind === 'not_found') {
        throw new SandboxBackendError('MICROVM_UNHEALTHY', error.message, error);
      }
      if (error instanceof LambdaMicrovmApiError) {
        throw new SandboxBackendError('MICROVM_LAUNCH_FAILED', error.message, error);
      }
      throw error;
    }
  }

  private async proxyExecute(
    client: LambdaMicrovmClient,
    vm: MicrovmDescription,
    req: SandboxTransportRequest,
    ctx: SandboxExecuteContext,
    runtimeSessionId?: string,
    reused = false,
  ): Promise<SandboxRawResponse> {
    const base = normalizeMicrovmEndpoint(vm.endpoint ?? '');
    const token = await this.mintAuthToken(client, vm.microvmId);
    /* Skip the preflight health check on a REUSED session VM: AWS may be
     * auto-resuming it from a suspend, and that resume can exceed the short
     * healthTimeoutMs (it scales with suspended-state size) — a slow-but-valid
     * resume would be misread as MICROVM_UNHEALTHY and the VM torn down. The
     * execute itself carries the resume under the full job budget, a
     * genuinely-evicted VM already fails token minting with not_found, and a
     * freshly-launched VM (reused=false) still gets the readiness probe. */
    if (!reused) {
      await this.assertHealthy(base, token.token, ctx);
    }

    /* Session mode is opted into per-request via this header (not a /run
     * lifecycle hook): stock container images can't route Lambda's build
     * hooks, so the runner reads its runtime session id straight off the
     * proxied execute. Header-only — never the manifest-signed body. */
    const sessionHeader = runtimeSessionId
      ? { [RUNTIME_SESSION_ID_HEADER]: runtimeSessionId }
      : undefined;

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
            ...microvmPortHeaders(this.config.port),
            ...sessionHeader,
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
        logGroup: this.config.logGroup,
        ingressConnectorArns: this.config.ingressConnectorArns,
        egressConnectorArns: this.config.egressConnectorArns,
        maximumDurationSeconds: opts.maxDurationSeconds,
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
      /* waitUntilRunning throws SandboxBackendError for its own conditions, but
       * the GetMicrovm poll it makes can throw a raw LambdaMicrovmApiError
       * (throttle/transient control-plane error). Map it like runMicrovm so it
       * surfaces as a public MICROVM_LAUNCH_* failure, not a generic 500. */
      if (error instanceof SandboxBackendError) throw error;
      if (error instanceof LambdaMicrovmApiError && error.kind === 'throttled') {
        await poisonOpBucket('run');
        microvmThrottleEvents.inc({ op: 'run' });
        throw new SandboxBackendError('MICROVM_LAUNCH_THROTTLED', error.message, error);
      }
      throw new SandboxBackendError(
        'MICROVM_LAUNCH_FAILED',
        error instanceof Error ? error.message : 'MicroVM poll failed',
        error,
      );
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
        headers: { 'X-aws-proxy-auth': token, ...microvmPortHeaders(this.config.port) },
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
