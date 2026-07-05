import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import RedisMock from 'ioredis-mock';
import axios from 'axios';
import { FakeLambdaMicrovmClient } from '../runtime-session/lambda-client-fake';
import { LambdaMicrovmApiError } from '../runtime-session/lambda-client';
import {
  resetRedisForTests as resetThrottleRedis,
  setRedisForTests as setThrottleRedis,
} from '../runtime-session/throttle';
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
  captured = [];
  healthStatus = 200;
  executeDelayMs = 0;
});

afterEach(() => {
  resetThrottleRedis();
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
    ...overrides,
  };
}

function makeBackend(fake: FakeLambdaMicrovmClient, cfg?: Partial<LambdaMicrovmBackendConfig>): LambdaMicrovmSandboxBackend {
  return new LambdaMicrovmSandboxBackend({
    clientFactory: () => Promise.resolve(fake),
    config: config(cfg),
    pollIntervalMs: 5,
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
