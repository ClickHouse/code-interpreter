import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import RedisMock from 'ioredis-mock';
import { env } from '../config';
import {
  cleanupExecution,
  resetRedisForTests,
  setRedisForTests,
} from './replay-state';

describe('cleanupExecution', () => {
  let redis: InstanceType<typeof RedisMock>;
  let server: Server;
  let previousToolCallServerUrl: string;
  let requests: string[];

  beforeEach(async () => {
    redis = new RedisMock();
    setRedisForTests(redis as unknown as Parameters<typeof setRedisForTests>[0]);
    previousToolCallServerUrl = env.TOOL_CALL_SERVER_URL;
    requests = [];

    server = createServer((req, res) => {
      requests.push(`${req.method ?? ''} ${req.url ?? ''}`);
      req.resume();
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    env.TOOL_CALL_SERVER_URL = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    env.TOOL_CALL_SERVER_URL = previousToolCallServerUrl;
    resetRedisForTests();
    await redis.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  });

  test('blocking cleanup deletes the Tool Call Server session', async () => {
    await cleanupExecution('exec_cleanup_123', 'blocking');

    expect(requests).toContain('DELETE /sessions/exec_cleanup_123');
  });
});
