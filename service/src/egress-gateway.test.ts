process.env.CODEAPI_EGRESS_GATEWAY_AUTOSTART = 'false';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { env } from './config';
import {
  EGRESS_GRANT_HEADER,
  openEgressHandle,
  sealEgressGrant,
  sealEgressHandle,
  sealPtcCallbackToken,
  type EgressGrantClaims,
} from './egress-grant';
import { INTERNAL_SERVICE_TOKEN_HEADER } from './internal-service-auth';

const { app } = await import('./egress-gateway');

const SECRET = 'test-egress-gateway-secret-32-bytes';
const INTERNAL_TOKEN = 'internal-token';
const originalFetch = globalThis.fetch;

type UpstreamCall = {
  url: string;
  init: RequestInit;
};

let server: Server;
let baseUrl: string;
let upstreamCalls: UpstreamCall[] = [];
let upstreamResponse: globalThis.Response;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function claims(overrides: Partial<EgressGrantClaims> = {}): EgressGrantClaims {
  const now = nowSeconds();
  return {
    v: 1,
    typ: 'grant',
    exec_id: 'exec_123',
    tenant_id: 'tenant_abc',
    user_id: 'user_123',
    session_key: 'tenant:tenant_abc:user:user_123',
    input_files: [{ id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' }],
    read_sessions: ['sess_input'],
    output_session_id: 'sess_output',
    max_upload_bytes: 1024,
    iat: now - 10,
    exp: now + 300,
    principal_source: 'librechat',
    auth_context_hash: 'hash_123',
    ...overrides,
  };
}

function grantHeader(grant: EgressGrantClaims = claims()): Record<string, string> {
  return { [EGRESS_GRANT_HEADER]: sealEgressGrant(grant, SECRET) };
}

function sessionHandle(args: { dir: 'read' | 'write'; sessionId: string; execId?: string }): string {
  const now = nowSeconds();
  return sealEgressHandle({
    typ: 'session',
    dir: args.dir,
    exec_id: args.execId ?? 'exec_123',
    session_id: args.sessionId,
    iat: now - 10,
    exp: now + 300,
  }, SECRET);
}

function objectHandle(args: { fileId?: string; sessionId?: string; name?: string; execId?: string }): string {
  const now = nowSeconds();
  return sealEgressHandle({
    typ: 'object',
    dir: 'read',
    exec_id: args.execId ?? 'exec_123',
    session_id: args.sessionId ?? 'sess_input',
    object_id: args.fileId ?? 'file_123',
    name: args.name ?? 'inputs/data.csv',
    iat: now - 10,
    exp: now + 300,
  }, SECRET);
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name] ?? headers?.[name.toLowerCase()];
}

async function gatewayFetch(path: string, init: RequestInit = {}): Promise<globalThis.Response> {
  return originalFetch(`${baseUrl}${path}`, init);
}

beforeAll(() => {
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  env.EGRESS_GRANT_SECRET = SECRET;
  env.EGRESS_GATEWAY_FILE_SERVER_URL = 'http://file-server';
  env.EGRESS_GATEWAY_TOOL_CALL_SERVER_URL = 'http://tool-call-server';
  env.EGRESS_GATEWAY_MAX_TOOL_CALL_BYTES = 128;
  process.env.CODEAPI_INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
  upstreamCalls = [];
  upstreamResponse = new Response('ok', { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    upstreamCalls.push({ url: String(input), init: init ?? {} });
    return upstreamResponse;
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  server.close();
  delete process.env.CODEAPI_INTERNAL_SERVICE_TOKEN;
});

describe('egress gateway routes', () => {
  test('lists only scoped objects and injects internal credentials', async () => {
    upstreamResponse = Response.json([
      { id: 'file_123', name: 'inputs/data.csv', storage_session_id: 'sess_input' },
      { id: 'file_999', name: 'inputs/other.csv', storage_session_id: 'sess_input' },
    ]);
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });

    const response = await gatewayFetch(`/sessions/${readSession}/objects?detail=normalized`, {
      headers: grantHeader(),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Array<{ id: string; storage_session_id: string; name: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('inputs/data.csv');
    expect(body[0].storage_session_id).toBe(readSession);
    expect(openEgressHandle(body[0].id, SECRET)).toMatchObject({ typ: 'object', object_id: 'file_123' });
    expect(upstreamCalls[0].url).toBe('http://file-server/sessions/sess_input/objects?detail=normalized');
    expect(header(upstreamCalls[0].init, INTERNAL_SERVICE_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
    expect(header(upstreamCalls[0].init, EGRESS_GRANT_HEADER)).toBeUndefined();
  });

  test('rejects unsupported list query params before delegation', async () => {
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });

    const response = await gatewayFetch(`/sessions/${readSession}/objects?detail=raw`, {
      headers: grantHeader(),
    });

    expect(response.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('downloads scoped objects by unwrapping handles', async () => {
    upstreamResponse = new Response('file-body', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
    const readSession = sessionHandle({ dir: 'read', sessionId: 'sess_input' });
    const object = objectHandle({});

    const response = await gatewayFetch(`/sessions/${readSession}/objects/${object}`, {
      headers: grantHeader(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('file-body');
    expect(upstreamCalls[0].url).toBe('http://file-server/sessions/sess_input/objects/file_123');
    expect(header(upstreamCalls[0].init, INTERNAL_SERVICE_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
  });

  test('enforces upload byte limits before delegation', async () => {
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });

    const response = await gatewayFetch(`/sessions/${writeSession}/objects/abcdefghijklmnopqrstu`, {
      method: 'PUT',
      headers: {
        ...grantHeader(claims({ max_upload_bytes: 3 })),
        'Content-Type': 'text/plain',
        'Content-Length': '4',
        'X-Original-Filename': 'out.txt',
      },
      body: 'abcd',
    });

    expect(response.status).toBe(413);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('uploads scoped output files with injected internal credentials', async () => {
    upstreamResponse = Response.json({ id: 'abcdefghijklmnopqrstu' }, { status: 201 });
    const writeSession = sessionHandle({ dir: 'write', sessionId: 'sess_output' });

    const response = await gatewayFetch(`/sessions/${writeSession}/objects/abcdefghijklmnopqrstu`, {
      method: 'PUT',
      headers: {
        ...grantHeader(),
        'Content-Type': 'text/plain',
        'Content-Length': '3',
        'X-Original-Filename': 'out.txt',
      },
      body: 'abc',
    });

    expect(response.status).toBe(201);
    expect(upstreamCalls[0].url).toBe('http://file-server/sessions/sess_output/objects/abcdefghijklmnopqrstu');
    expect(header(upstreamCalls[0].init, INTERNAL_SERVICE_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
    expect(header(upstreamCalls[0].init, 'X-Original-Filename')).toBe('out.txt');
  });

  test('forwards PTC calls with unwrapped callback tokens', async () => {
    upstreamResponse = Response.json({ success: true, result: 'ok' });
    const body = JSON.stringify({ tool_name: 'query_clickhouse', input: { sql: 'SELECT 1' } });
    const callbackToken = sealPtcCallbackToken({
      executionId: 'exec_123',
      sessionId: 'tool_session',
      callbackToken: 'raw-callback-token',
      issuedAt: nowSeconds() - 10,
      expiresAt: nowSeconds() + 300,
      secret: SECRET,
    });

    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': callbackToken,
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(upstreamCalls[0].url).toBe('http://tool-call-server/tool-call');
    expect(header(upstreamCalls[0].init, 'X-Execution-ID')).toBe('exec_123');
    expect(header(upstreamCalls[0].init, 'X-Tool-Call-ID')).toBe('call_001');
    expect(header(upstreamCalls[0].init, 'X-Callback-Token')).toBe('raw-callback-token');
  });

  test('rejects PTC callbacks whose execution does not match the request', async () => {
    const body = JSON.stringify({ tool_name: 'query_clickhouse', input: {} });
    const callbackToken = sealPtcCallbackToken({
      executionId: 'exec_other',
      sessionId: 'tool_session',
      callbackToken: 'raw-callback-token',
      issuedAt: nowSeconds() - 10,
      expiresAt: nowSeconds() + 300,
      secret: SECRET,
    });

    const response = await gatewayFetch('/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-Execution-ID': 'exec_123',
        'X-Tool-Call-ID': 'call_001',
        'X-Callback-Token': callbackToken,
      },
      body,
    });

    expect(response.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });
});
