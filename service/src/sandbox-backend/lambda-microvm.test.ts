import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import axios from 'axios';
import { FakeLambdaMicrovmClient } from '../runtime-session/lambda-client-fake';
import { LambdaMicrovmApiError } from '../runtime-session/lambda-client';
import {
  resetRedisForTests as resetThrottleRedis,
  setRedisForTests as setThrottleRedis,
} from '../runtime-session/throttle';
import {
  acquireRuntimeSessionLock,
  readRuntimeSessionRecord,
  resetRedisForTests as resetRegistryRedis,
  setRedisForTests as setRegistryRedis,
  writeRuntimeSessionRecord,
} from '../runtime-session/registry';
import { MemoryCheckpointStore, checkpointObjectKey } from '../runtime-session/checkpoint-store';
import { LambdaMicrovmSandboxBackend, normalizeMicrovmEndpoint, type LambdaMicrovmBackendConfig } from './lambda-microvm';
import { SandboxBackendError } from './types';
import type { SandboxExecuteContext, SandboxTransportRequest } from './types';
import type * as t from '../types';

type CapturedRequest = { path: string; rawBody: string; headers: Record<string, string> };

let server: ReturnType<typeof Bun.serve>;
let captured: CapturedRequest[] = [];
let healthStatus = 200;
let executeDelayMs = 0;
let mock: InstanceType<typeof RedisMock>;
const checkpointBlob = 'FAKE_TAR_GZ_BYTES';

const EXECUTE_RESPONSE = {
  session_id: 'sess_exec_1',
  language: 'python',
  version: '3.14.4',
  files: [],
  run: {
    stdout: 'ok', stderr: '', code: 0, signal: null, output: 'ok',
    memory: 1, message: null, status: null, cpu_time: 1, wall_time: 2,
  },
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      captured.push({
        path,
        rawBody: await req.text(),
        headers: Object.fromEntries(req.headers.entries()),
      });
      if (path === '/api/v2/health') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: healthStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/v2/execute') {
        if (executeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, executeDelayMs));
        }
        return new Response(JSON.stringify(EXECUTE_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/v2/session/checkpoint') {
        return new Response(checkpointBlob, { status: 200, headers: { 'Content-Type': 'application/x-gtar' } });
      }
      if (path === '/api/v2/session/restore') {
        return new Response(JSON.stringify({ status: 'restored' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  /* ioredis-mock shares one keyspace across instances — flush per test. */
  mock = new RedisMock();
  await mock.flushall();
  setThrottleRedis(mock);
  setRegistryRedis(mock);
  captured = [];
  healthStatus = 200;
  executeDelayMs = 0;
});

afterEach(() => {
  resetThrottleRedis();
  resetRegistryRedis();
});

function config(overrides: Partial<LambdaMicrovmBackendConfig> = {}): LambdaMicrovmBackendConfig {
  return {
    imageArn: 'arn:aws:lambda:us-east-2:1:microvm-image:codeapi',
    imageVersion: '3',
    port: 8080,
    maxDurationSeconds: 28_800,
    authTokenTtlSeconds: 300,
    launchTimeoutMs: 2_000,
    healthTimeoutMs: 1_000,
    launchTps: 50,
    jobTimeoutMs: 300_000,
    idleSeconds: 300,
    suspendedSeconds: 1_800,
    lockWaitMs: 500,
    checkpointsEnabled: false,
    checkpoint: { port: 8080, authTokenTtlSeconds: 300, maxBytes: 512 * 1024 * 1024, timeoutMs: 30_000 },
    ...overrides,
  };
}

function makeBackend(
  fake: FakeLambdaMicrovmClient,
  cfg?: Partial<LambdaMicrovmBackendConfig>,
  checkpointStore?: MemoryCheckpointStore,
): LambdaMicrovmSandboxBackend {
  return new LambdaMicrovmSandboxBackend({
    clientFactory: () => Promise.resolve(fake),
    config: config(cfg),
    pollIntervalMs: 5,
    checkpointStore,
  });
}

function fakeClient(): FakeLambdaMicrovmClient {
  return new FakeLambdaMicrovmClient({ endpointProvider: () => `http://localhost:${server.port}` });
}

function payloadBody(): t.PayloadBody {
  return {
    language: 'python',
    version: '3.14.4',
    session_id: 'sess_exec_1',
    files: [{ id: 'file_1', storage_session_id: 'sess_store_1', name: 'inputs/data.csv' }],
    egress_grant: 'ceg1.iv.ct.tag',
    execution_manifest: 'signed-manifest-token',
  };
}

function request(): SandboxTransportRequest {
  return { body: payloadBody(), headers: { 'Content-Type': 'application/json' } };
}

function context(overrides: Partial<SandboxExecuteContext> = {}): SandboxExecuteContext {
  return {
    executionId: 'exec_42',
    language: 'python',
    isSynthetic: false,
    signal: new AbortController().signal,
    runtimeSessionMode: 'stateless',
    ...overrides,
  };
}

describe('normalizeMicrovmEndpoint', () => {
  test('prefixes https for bare hosts and keeps explicit schemes', () => {
    expect(normalizeMicrovmEndpoint('abc.lambda-microvm.on.aws')).toBe('https://abc.lambda-microvm.on.aws');
    expect(normalizeMicrovmEndpoint('abc.on.aws/')).toBe('https://abc.on.aws');
    expect(normalizeMicrovmEndpoint('http://localhost:1234')).toBe('http://localhost:1234');
    expect(normalizeMicrovmEndpoint('https://x.on.aws///')).toBe('https://x.on.aws');
  });
});

describe('LambdaMicrovmSandboxBackend stateless execution', () => {
  test('run -> health -> execute -> terminate happy path', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    const req = request();

    const result = await backend.execute(req, context());

    expect(result).toEqual(EXECUTE_RESPONSE);

    const runCalls = fake.callsFor('runMicrovm');
    expect(runCalls).toHaveLength(1);
    const runArgs = runCalls[0].args as { imageIdentifier: string; clientToken?: string; maximumDurationSeconds: number };
    expect(runArgs.imageIdentifier).toBe('arn:aws:lambda:us-east-2:1:microvm-image:codeapi');
    expect(runArgs.clientToken).toBe('exec-exec_42');
    expect(runArgs.maximumDurationSeconds).toBe(Math.ceil(300_000 / 1_000) + 120);

    const executeReq = captured.find((c) => c.path === '/api/v2/execute');
    expect(executeReq).toBeDefined();
    expect(executeReq?.rawBody).toBe(JSON.stringify(req.body));
    const vm = [...fake.vms.values()][0];
    expect(executeReq?.headers['x-aws-proxy-auth']).toBe(vm.mintedTokens[0]);

    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(vm.state).toBe('TERMINATED');
  });

  test('health check runs before execute', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), context());
    const paths = captured.map((c) => c.path);
    expect(paths.indexOf('/api/v2/health')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/health')).toBeLessThan(paths.indexOf('/api/v2/execute'));
  });

  test('terminates the VM even when the execute is aborted mid-flight', async () => {
    const fake = fakeClient();
    executeDelayMs = 5_000;
    const controller = new AbortController();
    const pending = makeBackend(fake).execute(request(), context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);

    try {
      await pending;
      throw new Error('expected rejection');
    } catch (error) {
      expect(axios.isAxiosError(error)).toBe(true);
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('launch poll timeout surfaces MICROVM_LAUNCH_FAILED and terminates the stuck VM', async () => {
    const fake = fakeClient();
    fake.delayNextLaunch(10_000);
    const backend = makeBackend(fake, { launchTimeoutMs: 60 });

    try {
      await backend.execute(request(), context());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_LAUNCH_FAILED');
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('control-plane throttle surfaces MICROVM_LAUNCH_THROTTLED and poisons the run bucket', async () => {
    const fake = fakeClient();
    fake.failNext('runMicrovm', new LambdaMicrovmApiError('throttled', 'RunMicrovm', 'rate exceeded'));

    try {
      await makeBackend(fake).execute(request(), context());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_LAUNCH_THROTTLED');
    }
    expect(await mock.exists('rtsx:tps:poison:run')).toBe(1);
  });

  test('failed health check surfaces MICROVM_UNHEALTHY and terminates', async () => {
    const fake = fakeClient();
    healthStatus = 500;

    try {
      await makeBackend(fake).execute(request(), context());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_UNHEALTHY');
    }
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('does not mutate the signed request body', async () => {
    const fake = fakeClient();
    const req = request();
    const before = JSON.stringify(req.body);
    await makeBackend(fake).execute(req, context());
    expect(JSON.stringify(req.body)).toBe(before);
  });
});

describe('LambdaMicrovmSandboxBackend session execution', () => {
  function sessionContext(overrides: Partial<SandboxExecuteContext> = {}): SandboxExecuteContext {
    return context({
      runtimeSessionId: 'rt_session_1',
      runtimeSessionMode: 'affinity',
      tenantId: 'tenant-a',
      canonicalUserId: 'user-1',
      ...overrides,
    });
  }

  test('launches a hookless session VM (idlePolicy, no runHookPayload) and stamps the workspace header on execute', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);

    const result = await backend.execute(request(), sessionContext());
    expect(result).toEqual(EXECUTE_RESPONSE);

    const runArgs = fake.callsFor('runMicrovm')[0].args as {
      runHookPayload?: string;
      idlePolicy?: { autoResume: boolean; maxIdleSeconds: number };
      clientToken?: string;
      maximumDurationSeconds: number;
    };
    /* Session mode is delivered per-request via the header, never a /run hook
     * (image builds stay hookless), so RunMicrovm carries no runHookPayload. */
    expect(runArgs.runHookPayload).toBeUndefined();
    expect(runArgs.idlePolicy?.autoResume).toBe(true);
    expect(runArgs.clientToken).toBe('sess-rt_session_1-1');
    expect(runArgs.maximumDurationSeconds).toBe(28_800);

    const executeReq = captured.find((c) => c.path === '/api/v2/execute');
    expect(executeReq?.headers['x-runtime-session-id']).toBe('rt_session_1');

    const record = await readRuntimeSessionRecord('rt_session_1');
    expect(record?.state).toBe('RUNNING');
    expect(record?.microvm_id).toBe([...fake.vms.keys()][0]);
    expect(record?.generation).toBe(1);
  });

  test('reuses the warm VM on the second execution (no second RunMicrovm)', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);

    await backend.execute(request(), sessionContext());
    await backend.execute(request(), sessionContext());

    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    const executes = captured.filter((c) => c.path === '/api/v2/execute');
    expect(executes).toHaveLength(2);
  });

  test('two concurrent executions on one session serialize on the registry lock', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);

    const [a, b] = await Promise.all([
      backend.execute(request(), sessionContext()),
      backend.execute(request(), sessionContext()),
    ]);
    expect(a).toEqual(EXECUTE_RESPONSE);
    expect(b).toEqual(EXECUTE_RESPONSE);
    /* Serialized launch: exactly one VM created, reused by the other. */
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('strict mode raises RUNTIME_SESSION_BUSY when the lock is held', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake, { lockWaitMs: 100 });
    const held = await acquireRuntimeSessionLock('rt_session_1', 60_000);
    expect(held).not.toBeNull();

    try {
      await backend.execute(request(), sessionContext({ runtimeSessionMode: 'strict' }));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('RUNTIME_SESSION_BUSY');
    }
  });

  test('affinity mode falls back to a stateless one-shot when the lock is held', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake, { lockWaitMs: 100 });
    await acquireRuntimeSessionLock('rt_session_1', 60_000);

    const result = await backend.execute(request(), sessionContext({ runtimeSessionMode: 'affinity' }));
    expect(result).toEqual(EXECUTE_RESPONSE);
    /* Stateless fallback: launched a one-shot VM and terminated it. */
    const runArgs = fake.callsFor('runMicrovm')[0].args as { runHookPayload?: string; clientToken: string };
    expect(runArgs.runHookPayload).toBeUndefined();
    expect(runArgs.clientToken.startsWith('exec-')).toBe(true);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
  });

  test('stateless mode ignores a runtime session id', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext({ runtimeSessionMode: 'stateless' }));
    const runArgs = fake.callsFor('runMicrovm')[0].args as { runHookPayload?: string };
    expect(runArgs.runHookPayload).toBeUndefined();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });
});

describe('LambdaMicrovmSandboxBackend auto-checkpoint', () => {
  function sessionContext(overrides: Partial<SandboxExecuteContext> = {}): SandboxExecuteContext {
    return context({
      runtimeSessionId: 'rt_ckpt_1',
      runtimeSessionMode: 'affinity',
      tenantId: 'tenant-a',
      canonicalUserId: 'user-1',
      ...overrides,
    });
  }
  const cfgOn: Partial<LambdaMicrovmBackendConfig> = { checkpointsEnabled: true };

  test('checkpoints the workspace after a session exec and records the pointer', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, cfgOn, store);

    await backend.execute(request(), sessionContext());

    const checkpoints = captured.filter((c) => c.path === '/api/v2/session/checkpoint');
    expect(checkpoints).toHaveLength(1);
    /* The runner binds session mode from this header (hookless): without it the
     * checkpoint/restore handlers 409 and state is lost across expiry. */
    expect(checkpoints[0].headers['x-runtime-session-id']).toBe('rt_ckpt_1');
    expect(store.objects.get('rt_ckpt_1')?.toString()).toBe(checkpointBlob);
    const record = await readRuntimeSessionRecord('rt_ckpt_1');
    expect(record?.workspace_checkpoint).toBe(checkpointObjectKey('rt_ckpt_1'));
    expect(record?.checkpointed_at).toBeGreaterThan(0);
  });

  test('a relaunched VM restores the checkpoint before the first exec', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_ckpt_1', Buffer.from('PRIOR_WORKSPACE'));
    /* Seed a terminated prior session so findOrLaunch relaunches. */
    const seedToken = await acquireRuntimeSessionLock('rt_ckpt_1', 60_000);
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_ckpt_1', tenant_id: 'tenant-a', canonical_user_id: 'user-1',
      state: 'TERMINATED', generation: 3, last_seen_at: 1, workspace_checkpoint: checkpointObjectKey('rt_ckpt_1'),
    }, seedToken as string);
    const { releaseRuntimeSessionLock } = await import('../runtime-session/registry');
    await releaseRuntimeSessionLock('rt_ckpt_1', seedToken as string);

    const fake = fakeClient();
    const backend = makeBackend(fake, cfgOn, store);
    const result = await backend.execute(request(), sessionContext());
    expect(result).toEqual(EXECUTE_RESPONSE);

    const paths = captured.map((c) => c.path);
    /* restore precedes execute on the fresh VM. */
    expect(paths.indexOf('/api/v2/session/restore')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/session/restore')).toBeLessThan(paths.indexOf('/api/v2/execute'));
    const restoreReq = captured.find((c) => c.path === '/api/v2/session/restore');
    expect(restoreReq?.headers['x-runtime-session-id']).toBe('rt_ckpt_1');
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('reuse (warm VM) does not restore — no prior expiry', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, cfgOn, store);

    await backend.execute(request(), sessionContext());
    captured = [];
    await backend.execute(request(), sessionContext());

    expect(captured.filter((c) => c.path === '/api/v2/session/restore')).toHaveLength(0);
    expect(fake.callsFor('runMicrovm')).toHaveLength(1);
  });

  test('disabled checkpoints skip both checkpoint and restore', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    const backend = makeBackend(fake, { checkpointsEnabled: false }, store);
    await backend.execute(request(), sessionContext());
    expect(captured.filter((c) => c.path.startsWith('/api/v2/session/'))).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  test('a failed checkpoint is non-fatal — the exec still succeeds', async () => {
    const fake = fakeClient();
    const failing: MemoryCheckpointStore = new MemoryCheckpointStore();
    failing.put = () => Promise.reject(new Error('S3 down'));
    const backend = makeBackend(fake, cfgOn, failing);
    const result = await backend.execute(request(), sessionContext());
    expect(result).toEqual(EXECUTE_RESPONSE);
    const record = await readRuntimeSessionRecord('rt_ckpt_1');
    expect(record?.state).toBe('RUNNING');
    expect(record?.workspace_checkpoint).toBeUndefined();
  });
});
