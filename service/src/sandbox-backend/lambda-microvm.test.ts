import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import * as zlib from 'zlib';
import axios from 'axios';
import { env } from '../config';
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
import { MemoryCheckpointStore, checkpointObjectKey, checkpointPrefixFor } from '../runtime-session/checkpoint-store';
import { LambdaMicrovmSandboxBackend, normalizeMicrovmEndpoint, type LambdaMicrovmBackendConfig } from './lambda-microvm';
import { SandboxBackendError } from './types';
import type { SandboxExecuteContext, SandboxTransportRequest } from './types';
import type * as t from '../types';

type CapturedRequest = { path: string; rawBody: string; headers: Record<string, string> };

let server: ReturnType<typeof Bun.serve>;
let captured: CapturedRequest[] = [];
let healthStatus = 200;
let executeDelayMs = 0;
let executeStatus = 200;
let sessionFilesStatus = 200;
let lastSessionFilesBody: Buffer | null = null;
let stealSessionLockOnExecute = false;
let fileReadOnly = false;
const fileObjectBytes = 'csv,bytes\n1,2\n';
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
      const raw = Buffer.from(await req.arrayBuffer());
      captured.push({
        path,
        rawBody: raw.toString(),
        headers: Object.fromEntries(req.headers.entries()),
      });
      /* The same server doubles as the internal file server the control plane
       * fetches input refs from when building a session files delivery. */
      if (path.startsWith('/sessions/')) {
        return new Response(fileObjectBytes, {
          status: 200,
          headers: fileReadOnly ? { 'X-Read-Only': 'true' } : {},
        });
      }
      if (path === '/api/v2/session/files') {
        lastSessionFilesBody = raw;
        return new Response(JSON.stringify({ status: 'received' }), {
          status: sessionFilesStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
        if (stealSessionLockOnExecute) {
          await mock.set('rtsx:lock:rt_session_1', 'stolen');
        }
        return new Response(JSON.stringify(EXECUTE_RESPONSE), {
          status: executeStatus,
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
  env.FILE_SERVER_URL = `http://localhost:${server.port}`;
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
  executeStatus = 200;
  sessionFilesStatus = 200;
  lastSessionFilesBody = null;
  stealSessionLockOnExecute = false;
  fileReadOnly = false;
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
    tokenTps: 50,
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

  test('a MicroVM that dies during boot is retried once with a fresh clientToken', async () => {
    const fake = fakeClient();
    fake.terminateNextLaunch();

    const result = await makeBackend(fake).execute(request(), context());

    expect(result).toEqual(EXECUTE_RESPONSE);
    const runCalls = fake.callsFor('runMicrovm');
    expect(runCalls).toHaveLength(2);
    const tokens = runCalls.map((call) => (call.args as { clientToken?: string }).clientToken);
    expect(tokens[0]).toBe('exec-exec_42');
    expect(tokens[1]).toBe('exec-exec_42-r1');
  });

  test('a second boot-time death fails the request — single retry only', async () => {
    const fake = fakeClient();
    fake.terminateNextLaunch();
    fake.terminateNextLaunch();

    await expect(makeBackend(fake).execute(request(), context())).rejects.toMatchObject({
      code: 'MICROVM_LAUNCH_FAILED',
    });
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
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

  test('a reused VM skips the preflight health check so a slow auto-resume can proceed', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    captured = [];
    await backend.execute(request(), sessionContext());
    /* The warm/suspended VM auto-resumes on the execute itself under the full
     * job budget; a 5s health probe would misclassify a slow resume as
     * unhealthy and tear the VM down. */
    expect(captured.filter((c) => c.path === '/api/v2/health')).toHaveLength(0);
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(1);
  });

  test('a runner non-2xx keeps the warm VM (does not tear down the session)', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    executeStatus = 500;
    /* The runner responded (500) — the VM is alive, only the request failed —
     * so the session must NOT be terminated (regression: the error-classifier
     * previously tore down any error that wasn't literally "Error from sandbox"). */
    await expect(backend.execute(request(), sessionContext())).rejects.toThrow();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(0);
    const record = await readRuntimeSessionRecord('rt_session_1');
    expect(record?.state).toBe('RUNNING');
  });

  test('delivers by-ref input files to the session VM before the execute', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), sessionContext());

    const paths = captured.map((c) => c.path);
    expect(paths.indexOf('/sessions/sess_store_1/objects/file_1')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/session/files')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/v2/session/files')).toBeLessThan(paths.indexOf('/api/v2/execute'));

    const filesReq = captured.find((c) => c.path === '/api/v2/session/files');
    expect(filesReq?.headers['x-runtime-session-id']).toBe('rt_session_1');
    expect(filesReq?.headers['content-type']).toBe('application/x-gtar');

    /* Real tar.gz on the wire: member paths and the primed-files manifest are
     * visible in the decompressed stream. */
    const untarred = zlib.gunzipSync(lastSessionFilesBody!).toString('latin1');
    expect(untarred).toContain('session/inputs/data.csv');
    expect(untarred).toContain(fileObjectBytes);
    expect(untarred).toContain('codeapi.session-files.v1');
    expect(untarred).toContain('"id":"file_1"');
    expect(untarred).toContain('"storage_session_id":"sess_store_1"');
  });

  test('a ref already delivered to the warm session is not re-pushed', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    await backend.execute(request(), sessionContext());

    /* One push, not two: re-delivering the same writable ref would overwrite
     * any in-place modification the first exec made to the file. */
    expect(captured.filter((c) => c.path === '/api/v2/session/files')).toHaveLength(1);
    const record = await readRuntimeSessionRecord('rt_session_1');
    expect(record?.delivered_files).toEqual(['sess_store_1/file_1']);
    expect(record?.delivered_at).toBeGreaterThan(0);
  });

  test('read-only refs are re-delivered on every exec and never recorded', async () => {
    fileReadOnly = true;
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    await backend.execute(request(), sessionContext());

    expect(captured.filter((c) => c.path === '/api/v2/session/files')).toHaveLength(2);
    const record = await readRuntimeSessionRecord('rt_session_1');
    expect(record?.delivered_files ?? []).toEqual([]);
    /* The manifest carries the read-only bit so the runner primes accordingly. */
    const untarred = zlib.gunzipSync(lastSessionFilesBody!).toString('latin1');
    expect(untarred).toContain('"read_only":true');
  });

  test('a failed file delivery recycles the VM instead of executing partial inputs', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    sessionFilesStatus = 500;

    await expect(backend.execute(request(), sessionContext())).rejects.toThrow(
      'Session input file delivery failed',
    );
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('a payload with no by-ref files skips the delivery leg entirely', async () => {
    const fake = fakeClient();
    const req = request();
    req.body.files = [{ name: 'inline.txt', content: 'inline' }];
    await makeBackend(fake).execute(req, sessionContext());
    expect(captured.filter((c) => c.path === '/api/v2/session/files')).toHaveLength(0);
  });

  test('a fresh session VM returning a proxy 502 is recycled immediately', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    executeStatus = 502;

    await expect(backend.execute(request(), sessionContext())).rejects.toThrow();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('a reused VM returning a proxy 502 (failed auto-resume) is recycled', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    /* 502/503/504 is the AWS proxy reporting the VM unreachable (a suspended VM
     * that failed to auto-resume), not the runner rejecting the request — so the
     * dead VM must be torn down, unlike a runner 500. */
    executeStatus = 502;
    await expect(backend.execute(request(), sessionContext())).rejects.toThrow();
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('relaunches an idle-expired session instead of reusing the dead endpoint', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    /* Backdate last_seen past idle+suspended: AWS would have auto-terminated the
     * VM, so the next request must relaunch rather than reuse the stale RUNNING
     * endpoint (which would health-check-fail and 503 the first request). */
    const token = (await acquireRuntimeSessionLock('rt_session_1', 60_000)) as string;
    const rec = await readRuntimeSessionRecord('rt_session_1');
    await writeRuntimeSessionRecord({ ...rec!, last_seen_at: 1 }, token);
    const { releaseRuntimeSessionLock } = await import('../runtime-session/registry');
    await releaseRuntimeSessionLock('rt_session_1', token);
    await backend.execute(request(), sessionContext());
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
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

  test('a fenced post-execute record write fails instead of returning stale session state', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    stealSessionLockOnExecute = true;

    try {
      await backend.execute(request(), sessionContext());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBackendError);
      expect((error as SandboxBackendError).code).toBe('MICROVM_FENCED');
    }
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

  test('sends X-aws-proxy-port only when the port is not the 8080 default', async () => {
    const fake = fakeClient();
    await makeBackend(fake, { port: 9090 }).execute(request(), sessionContext());
    const exec = captured.find((c) => c.path === '/api/v2/execute');
    /* Non-default port needs the routing header, or AWS sends traffic to 8080. */
    expect(exec?.headers['x-aws-proxy-port']).toBe('9090');

    captured = [];
    await makeBackend(fake, { port: 8080 }).execute(request(), sessionContext({ runtimeSessionId: 'rt_8080' }));
    const exec8080 = captured.find((c) => c.path === '/api/v2/execute');
    expect(exec8080?.headers['x-aws-proxy-port']).toBeUndefined();
  });

  test('a reused VM whose token mint returns not_found is torn down and the record dropped', async () => {
    const fake = fakeClient();
    const backend = makeBackend(fake);
    await backend.execute(request(), sessionContext());
    /* The VM was evicted between calls: CreateMicrovmAuthToken now 404s. That
     * escapes raw today; it must surface as MICROVM_UNHEALTHY so the dead VM is
     * terminated and its record dropped, and the next call relaunches. */
    fake.failNext('createMicrovmAuthToken', new LambdaMicrovmApiError('not_found', 'CreateMicrovmAuthToken', 'gone'));
    await expect(backend.execute(request(), sessionContext())).rejects.toBeInstanceOf(SandboxBackendError);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_session_1')).toBeNull();
  });

  test('terminates a superseded (config-drifted) VM before relaunching', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), sessionContext());
    const oldVmId = [...fake.vms.keys()][0];
    /* A deploy bumps the image version: the recorded VM no longer matches config,
     * so it must be terminated (not left running/billing) before the replacement
     * launches. */
    await makeBackend(fake, { imageVersion: '4' }).execute(request(), sessionContext());
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
    const terminated = fake.callsFor('terminateMicrovm').map((c) => (c.args as { microvmId: string }).microvmId);
    expect(terminated).toContain(oldVmId);
  });

  test('a tightened egress connector config makes an existing session non-reusable', async () => {
    const fake = fakeClient();
    await makeBackend(fake).execute(request(), sessionContext());
    const oldVmId = [...fake.vms.keys()][0];
    /* Connectors apply only at RunMicrovm, so a hardened deploy that tightens
     * egress must relaunch rather than keep serving on the old broader policy. */
    await makeBackend(fake, {
      egressConnectorArns: ['arn:aws:lambda:us-east-2:1:network-connector:vpc-egress'],
    }).execute(request(), sessionContext());
    expect(fake.callsFor('runMicrovm')).toHaveLength(2);
    const terminated = fake.callsFor('terminateMicrovm').map((c) => (c.args as { microvmId: string }).microvmId);
    expect(terminated).toContain(oldVmId);
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
    expect((await store.get('rt_ckpt_1', 1_000_000))?.toString()).toBe(checkpointBlob);
    const record = await readRuntimeSessionRecord('rt_ckpt_1');
    /* Key is timestamp-based now (Date.now at checkpoint), so match the shape. */
    expect(record?.workspace_checkpoint).toStartWith(checkpointPrefixFor('rt_ckpt_1'));
    expect(record?.workspace_checkpoint).toEndWith('.tar.gz');
    expect(record?.checkpointed_at).toBeGreaterThan(0);
  });

  test('a relaunched VM restores the checkpoint before the first exec', async () => {
    const store = new MemoryCheckpointStore();
    await store.put('rt_ckpt_1', 1000, Buffer.from('PRIOR_WORKSPACE'));
    /* Seed a terminated prior session so findOrLaunch relaunches. */
    const seedToken = await acquireRuntimeSessionLock('rt_ckpt_1', 60_000);
    await writeRuntimeSessionRecord({
      runtime_session_id: 'rt_ckpt_1', tenant_id: 'tenant-a', canonical_user_id: 'user-1',
      state: 'TERMINATED', generation: 3, last_seen_at: 1, workspace_checkpoint: checkpointObjectKey('rt_ckpt_1', 1000),
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
    /* File delivery is independent of checkpointing — only the checkpoint and
     * restore legs must be skipped. */
    expect(captured.filter((c) =>
      c.path === '/api/v2/session/checkpoint' || c.path === '/api/v2/session/restore',
    )).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  test('a checkpoint FETCH failure fails closed instead of running on an empty workspace', async () => {
    const fake = fakeClient();
    const store = new MemoryCheckpointStore();
    store.get = () => Promise.reject(new Error('S3 down'));
    const backend = makeBackend(fake, cfgOn, store);

    /* Running anyway used to let the post-run checkpoint prune the last good
     * snapshot — a transient S3 blip becoming permanent data loss. */
    await expect(backend.execute(request(), sessionContext())).rejects.toThrow(
      'refusing to run against an empty workspace',
    );
    expect(captured.filter((c) => c.path === '/api/v2/execute')).toHaveLength(0);
    expect(fake.callsFor('terminateMicrovm')).toHaveLength(1);
    expect(await readRuntimeSessionRecord('rt_ckpt_1')).toBeNull();
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
