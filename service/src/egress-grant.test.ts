import { describe, expect, test } from 'bun:test';
import type { ExecutionManifestClaims } from './execution-manifest';
import { env } from './config';
import {
  normalizeEgressGatewayUrl,
  normalizeProgrammaticTimeoutMs,
  prepareSandboxJobSecurity,
  refreshEgressGrantClaims,
  sealPtcCallbackTokenForGateway,
  timeoutMsToGrantSeconds,
} from './sandbox-egress';
import {
  EGRESS_GRANT_HEADER,
  EGRESS_GRANT_VERSION,
  EgressGrantError,
  openEgressGrant,
  openEgressHandle,
  prepareSandboxEgress,
  restoreSandboxExecuteResult,
  sealEgressGrant,
  sealEgressHandle,
  sealPtcCallbackToken,
  openPtcCallbackToken,
} from './egress-grant';
import { openEgressRouteHandle } from './egress-route-params';
import type * as t from './types';

const SECRET = 'test-egress-secret-32-bytes-minimum';

function claims(overrides: Partial<ExecutionManifestClaims> = {}): ExecutionManifestClaims {
  return {
    v: 1,
    exec_id: 'exec_123',
    tenant_id: 'tenant_abc',
    user_id: 'user_123',
    session_key: 'tenant:tenant_abc:user:user_123',
    input_files: [{ id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' }],
    read_sessions: ['sess_input'],
    output_session_id: 'sess_output',
    max_upload_bytes: 1024,
    max_output_files: 10,
    max_requests: 100,
    iat: 100,
    exp: 300,
    principal_source: 'librechat',
    auth_context_hash: 'hash_123',
    ...overrides,
  };
}

type JobSecurityArgs = Parameters<typeof prepareSandboxJobSecurity>[0];

function jobSecurityArgs(overrides: Partial<JobSecurityArgs> = {}): JobSecurityArgs {
  const payload: t.PayloadBody = {
    language: 'python',
    version: '3.14.4',
    session_id: 'sess_output',
    files: [{ id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' }],
  };
  return {
    req: {
      codeApiAuthContext: {
        userId: 'user_123',
        tenantId: 'tenant_abc',
        principalSource: 'librechat',
        authContextHash: 'hash_123',
      },
    } as t.AuthenticatedRequest,
    executionId: 'exec_123',
    userId: 'user_123',
    sessionKey: 'tenant:tenant_abc:user:user_123',
    outputSessionId: 'sess_output',
    payload,
    nowSeconds: 100,
    ...overrides,
  };
}

function expectEgressError(fn: () => unknown, reason: EgressGrantError['reason']): void {
  try {
    fn();
    throw new Error('expected egress error');
  } catch (error) {
    expect(error).toBeInstanceOf(EgressGrantError);
    expect((error as EgressGrantError).reason).toBe(reason);
  }
}

describe('egress encrypted grants and handles', () => {
  test('exports the sandbox-to-gateway grant header name', () => {
    expect(EGRESS_GRANT_HEADER).toBe('X-CodeAPI-Egress-Grant');
  });

  test('round-trips encrypted grants without exposing raw claims in the token', () => {
    const token = sealEgressGrant(claims(), SECRET);
    expect(token).toStartWith('ceg1.');
    expect(token).not.toContain('tenant_abc');
    expect(token).not.toContain('sess_input');
    expect(openEgressGrant(token, SECRET, 150)).toMatchObject({
      typ: 'grant',
      v: EGRESS_GRANT_VERSION,
      tenant_id: 'tenant_abc',
      user_id: 'user_123',
      output_session_id: 'sess_output',
    });
    expect(openEgressGrant(token, SECRET, 150)).not.toHaveProperty('max_output_files');
    expect(openEgressGrant(token, SECRET, 150)).not.toHaveProperty('max_requests');
  });

  test('rejects tampered, expired, wrong-secret, and weak-secret tokens', () => {
    const token = sealEgressGrant(claims(), SECRET);
    const tamperedParts = token.split('.');
    tamperedParts[2] = `${tamperedParts[2][0] === 'A' ? 'B' : 'A'}${tamperedParts[2].slice(1)}`;
    const tampered = tamperedParts.join('.');

    expectEgressError(() => openEgressGrant(tampered, SECRET, 150), 'malformed');
    expectEgressError(() => openEgressGrant(token, SECRET, 1000), 'expired');
    expectEgressError(() => openEgressGrant(token, 'different-egress-secret-32-bytes-min', 150), 'malformed');
    expectEgressError(() => sealEgressGrant(claims(), 'short'), 'weak_secret');
  });

  test('keeps file/session handles typed and operation-scoped', () => {
    const readSession = sealEgressHandle({
      typ: 'session',
      dir: 'read',
      exec_id: 'exec_123',
      session_id: 'sess_input',
      iat: 100,
      exp: 300,
    }, SECRET);
    const object = sealEgressHandle({
      typ: 'object',
      dir: 'read',
      exec_id: 'exec_123',
      session_id: 'sess_input',
      object_id: 'file_123',
      name: 'inputs/data.csv',
      iat: 100,
      exp: 300,
    }, SECRET);

    expect(openEgressHandle(readSession, SECRET, 150)).toMatchObject({ typ: 'session', dir: 'read' });
    expect(openEgressHandle(object, SECRET, 150)).toMatchObject({ typ: 'object', object_id: 'file_123' });
  });

  test('treats malformed already-decoded route handle params as egress errors', () => {
    expectEgressError(() => openEgressRouteHandle('%', SECRET), 'malformed');
  });

  test('masks sandbox payload IDs and redacts raw identity labels from sandbox manifest claims', () => {
    const payload: t.PayloadBody = {
      language: 'python',
      version: '3.14.4',
      session_id: 'sess_output',
      files: [
        { name: 'main.py', content: 'print(1)' },
        { id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' },
      ],
    };

    const prepared = prepareSandboxEgress({
      payload,
      claims: claims({
        org_id: 'org_raw',
        service_id: 'service_raw',
        chc_user_id: 'chc_user_raw',
      }),
      secret: SECRET,
    });
    const serializedPayload = JSON.stringify(prepared.payload);
    const serializedManifest = JSON.stringify(prepared.executionManifestClaims);

    expect(serializedPayload).not.toContain('file_123');
    expect(serializedPayload).not.toContain('sess_input');
    expect(serializedPayload).not.toContain('sess_output');
    expect(serializedManifest).not.toContain('tenant_abc');
    expect(serializedManifest).not.toContain('user_123');
    expect(serializedManifest).not.toContain('tenant:tenant_abc');
    expect(serializedManifest).not.toContain('org_raw');
    expect(serializedManifest).not.toContain('service_raw');
    expect(serializedManifest).not.toContain('chc_user_raw');
    expect(prepared.executionManifestClaims.org_id).toBeUndefined();
    expect(prepared.executionManifestClaims.service_id).toBeUndefined();
    expect(prepared.executionManifestClaims.chc_user_id).toBeUndefined();
    expect(prepared.executionManifestClaims.auth_context_hash).toBe('hash_123');

    const fileRef = prepared.payload.files[1] as { id: string; storage_session_id: string };
    expect(openEgressHandle(fileRef.id, SECRET, 150)).toMatchObject({
      typ: 'object',
      object_id: 'file_123',
      session_id: 'sess_input',
    });
    expect(openEgressHandle(fileRef.storage_session_id, SECRET, 150)).toMatchObject({
      typ: 'session',
      dir: 'read',
      session_id: 'sess_input',
    });
  });

  test('restores sandbox response handles before returning to callers', () => {
    const now = Math.floor(Date.now() / 1000);
    const liveClaims = claims({ iat: now - 10, exp: now + 300 });
    const payload: t.PayloadBody = {
      language: 'python',
      version: '3.14.4',
      session_id: 'sess_output',
      files: [{ id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' }],
    };
    const prepared = prepareSandboxEgress({ payload, claims: liveClaims, secret: SECRET });
    const inputFile = prepared.payload.files[0] as { id: string; storage_session_id: string; name: string };
    const response = {
      session_id: prepared.payload.session_id!,
      files: [
        {
          id: 'generated_file_id_01',
          name: 'plot.png',
          storage_session_id: prepared.payload.session_id!,
        },
        {
          id: inputFile.id,
          name: inputFile.name,
          storage_session_id: inputFile.storage_session_id,
          inherited: true as const,
        },
      ],
    };

    expect(restoreSandboxExecuteResult(response, prepared.egressGrantToken, SECRET)).toEqual({
      session_id: 'sess_output',
      files: [
        { id: 'generated_file_id_01', name: 'plot.png', storage_session_id: 'sess_output' },
        { id: 'file_123', name: 'inputs/data.csv', storage_session_id: 'sess_input', inherited: true },
      ],
    });
  });

  test('rejects raw object ids returned under read-scoped session handles', () => {
    const now = Math.floor(Date.now() / 1000);
    const liveClaims = claims({ iat: now - 10, exp: now + 300 });
    const payload: t.PayloadBody = {
      language: 'python',
      version: '3.14.4',
      session_id: 'sess_output',
      files: [{ id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' }],
    };
    const prepared = prepareSandboxEgress({ payload, claims: liveClaims, secret: SECRET });
    const inputFile = prepared.payload.files[0] as { storage_session_id: string };

    expectEgressError(() => restoreSandboxExecuteResult({
      session_id: prepared.payload.session_id!,
      files: [{ id: 'file_123', name: 'inputs/data.csv', storage_session_id: inputFile.storage_session_id }],
    }, prepared.egressGrantToken, SECRET), 'scope_mismatch');
  });

  test('rejects restored top-level session ids outside the write-scoped output session', () => {
    const now = Math.floor(Date.now() / 1000);
    const liveClaims = claims({ iat: now - 10, exp: now + 300 });
    const payload: t.PayloadBody = {
      language: 'python',
      version: '3.14.4',
      session_id: 'sess_output',
      files: [{ id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' }],
    };
    const prepared = prepareSandboxEgress({ payload, claims: liveClaims, secret: SECRET });
    const readSession = (prepared.payload.files[0] as { storage_session_id: string }).storage_session_id;
    const wrongWriteSession = sealEgressHandle({
      typ: 'session',
      dir: 'write',
      exec_id: 'exec_123',
      session_id: 'sess_other',
      iat: liveClaims.iat,
      exp: liveClaims.exp,
    }, SECRET);

    expectEgressError(() => restoreSandboxExecuteResult({
      session_id: readSession,
      files: [],
    }, prepared.egressGrantToken, SECRET), 'scope_mismatch');
    expectEgressError(() => restoreSandboxExecuteResult({
      session_id: wrongWriteSession,
      files: [],
    }, prepared.egressGrantToken, SECRET), 'scope_mismatch');
  });

  test('rejects restored read handles with the wrong execution binding or file scope', () => {
    const now = Math.floor(Date.now() / 1000);
    const liveClaims = claims({ iat: now - 10, exp: now + 300 });
    const payload: t.PayloadBody = {
      language: 'python',
      version: '3.14.4',
      session_id: 'sess_output',
      files: [{ id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' }],
    };
    const prepared = prepareSandboxEgress({ payload, claims: liveClaims, secret: SECRET });
    const wrongExecObject = sealEgressHandle({
      typ: 'object',
      dir: 'read',
      exec_id: 'exec_other',
      session_id: 'sess_input',
      object_id: 'file_123',
      name: 'inputs/data.csv',
      iat: liveClaims.iat,
      exp: liveClaims.exp,
    }, SECRET);
    const wrongScopeObject = sealEgressHandle({
      typ: 'object',
      dir: 'read',
      exec_id: 'exec_123',
      session_id: 'sess_input',
      object_id: 'file_other',
      name: 'inputs/other.csv',
      iat: liveClaims.iat,
      exp: liveClaims.exp,
    }, SECRET);

    expectEgressError(() => restoreSandboxExecuteResult({
      session_id: prepared.payload.session_id!,
      files: [{ id: wrongExecObject, name: 'x', storage_session_id: (prepared.payload.files[0] as { storage_session_id: string }).storage_session_id }],
    }, prepared.egressGrantToken, SECRET), 'scope_mismatch');
    expectEgressError(() => restoreSandboxExecuteResult({
      session_id: prepared.payload.session_id!,
      files: [{ id: wrongScopeObject, name: 'x', storage_session_id: (prepared.payload.files[0] as { storage_session_id: string }).storage_session_id }],
    }, prepared.egressGrantToken, SECRET), 'scope_mismatch');
  });

  test('seals PTC callback tokens so sandbox code does not receive raw callback secrets', () => {
    const token = sealPtcCallbackToken({
      executionId: 'exec_123',
      sessionId: 'sess_output',
      callbackToken: 'raw-callback-token',
      issuedAt: 100,
      expiresAt: 300,
      secret: SECRET,
    });

    expect(token).not.toContain('raw-callback-token');
    expect(openPtcCallbackToken(token, SECRET, 150)).toMatchObject({
      typ: 'ptc-callback',
      exec_id: 'exec_123',
      callback_token: 'raw-callback-token',
    });
  });

  test('converts PTC callback timeout milliseconds to grant seconds', () => {
    expect(timeoutMsToGrantSeconds(300000)).toBe(300);
    expect(timeoutMsToGrantSeconds(300001)).toBe(301);
    expect(timeoutMsToGrantSeconds(0)).toBe(1);
  });

  test('normalizes and caps programmatic request timeouts', () => {
    expect(normalizeProgrammaticTimeoutMs(undefined, 300000)).toBe(300000);
    expect(normalizeProgrammaticTimeoutMs(1000.1, 300000)).toBe(1001);
    expect(normalizeProgrammaticTimeoutMs(999999999, 300000)).toBe(300000);
    expect(normalizeProgrammaticTimeoutMs(undefined, 1000)).toBe(1000);
    expect(() => normalizeProgrammaticTimeoutMs('300000', 300000)).toThrow('timeout must be a positive number');
    expect(() => normalizeProgrammaticTimeoutMs(0, 300000)).toThrow('timeout must be a positive number');
  });

  test('normalizes the gateway callback URL for sandbox-originated PTC', () => {
    expect(normalizeEgressGatewayUrl(' http://egress-gateway:3190/// ')).toBe('http://egress-gateway:3190');
    expect(() => normalizeEgressGatewayUrl('  ')).toThrow('EGRESS_GATEWAY_URL is required');
  });

  test('fails closed when egress grants are enabled without an egress gateway URL', () => {
    const previousSecret = env.EGRESS_GRANT_SECRET;
    const previousGatewayUrl = env.EGRESS_GATEWAY_URL;
    env.EGRESS_GRANT_SECRET = SECRET;
    env.EGRESS_GATEWAY_URL = '';
    try {
      expect(() => prepareSandboxJobSecurity(jobSecurityArgs())).toThrow(
        'EGRESS_GATEWAY_URL is required when CODEAPI_EGRESS_GRANT_SECRET enables sandbox egress grants',
      );
    } finally {
      env.EGRESS_GRANT_SECRET = previousSecret;
      env.EGRESS_GATEWAY_URL = previousGatewayUrl;
    }
  });

  test('builds egress grant claims only when the gateway path is configured', () => {
    const previousSecret = env.EGRESS_GRANT_SECRET;
    const previousGatewayUrl = env.EGRESS_GATEWAY_URL;
    env.EGRESS_GRANT_SECRET = SECRET;
    env.EGRESS_GATEWAY_URL = 'http://egress-gateway:3190';
    try {
      const prepared = prepareSandboxJobSecurity(jobSecurityArgs());
      expect(prepared.egressGrantClaims).toMatchObject({
        exec_id: 'exec_123',
        tenant_id: 'tenant_abc',
        user_id: 'user_123',
      });
      expect(prepared.executionManifestClaims).toBeUndefined();
    } finally {
      env.EGRESS_GRANT_SECRET = previousSecret;
      env.EGRESS_GATEWAY_URL = previousGatewayUrl;
    }
  });

  test('fails closed when sandbox-originated PTC lacks the gateway sealing secret', () => {
    const previousSecret = env.EGRESS_GRANT_SECRET;
    env.EGRESS_GRANT_SECRET = '';

    try {
      expect(() => sealPtcCallbackTokenForGateway({
        executionId: 'exec_123',
        sessionId: 'sess_output',
        callbackToken: 'raw-callback-token',
        timeoutSeconds: 300,
      })).toThrow('CODEAPI_EGRESS_GRANT_SECRET is required');
    } finally {
      env.EGRESS_GRANT_SECRET = previousSecret;
    }
  });

  test('bounds sandbox-originated PTC callback token expiry to the execution timeout', () => {
    const previousSecret = env.EGRESS_GRANT_SECRET;
    const previousTtlSeconds = env.EGRESS_GRANT_TTL_SECONDS;
    const previousDateNow = Date.now;
    env.EGRESS_GRANT_SECRET = SECRET;
    env.EGRESS_GRANT_TTL_SECONDS = 900;
    Date.now = () => 1000 * 1000;

    try {
      const token = sealPtcCallbackTokenForGateway({
        executionId: 'exec_123',
        sessionId: 'sess_output',
        callbackToken: 'raw-callback-token',
        timeoutSeconds: 5,
      });

      expect(openPtcCallbackToken(token, SECRET, 1000)).toMatchObject({
        iat: 1000,
        exp: 1005,
      });
    } finally {
      env.EGRESS_GRANT_SECRET = previousSecret;
      env.EGRESS_GRANT_TTL_SECONDS = previousTtlSeconds;
      Date.now = previousDateNow;
    }
  });

  test('caps sandbox-originated PTC callback token expiry at the global grant TTL', () => {
    const previousSecret = env.EGRESS_GRANT_SECRET;
    const previousTtlSeconds = env.EGRESS_GRANT_TTL_SECONDS;
    const previousDateNow = Date.now;
    env.EGRESS_GRANT_SECRET = SECRET;
    env.EGRESS_GRANT_TTL_SECONDS = 3;
    Date.now = () => 1000 * 1000;

    try {
      const token = sealPtcCallbackTokenForGateway({
        executionId: 'exec_123',
        sessionId: 'sess_output',
        callbackToken: 'raw-callback-token',
        timeoutSeconds: 300,
      });

      expect(openPtcCallbackToken(token, SECRET, 1000)).toMatchObject({
        iat: 1000,
        exp: 1003,
      });
    } finally {
      env.EGRESS_GRANT_SECRET = previousSecret;
      env.EGRESS_GRANT_TTL_SECONDS = previousTtlSeconds;
      Date.now = previousDateNow;
    }
  });

  test('refreshes egress grant expiry at worker dispatch time', () => {
    const payload: t.PayloadBody = {
      language: 'python',
      version: '3.14.4',
      session_id: 'sess_output',
      files: [{ id: 'file_123', storage_session_id: 'sess_input', name: 'inputs/data.csv' }],
    };
    const staleClaims = claims({ iat: 10, exp: 20 });
    const refreshedClaims = refreshEgressGrantClaims(staleClaims, 1000, 90);
    const prepared = prepareSandboxEgress({ payload, claims: refreshedClaims, secret: SECRET });

    expect(openEgressGrant(prepared.egressGrantToken, SECRET, 1089)).toMatchObject({
      iat: 1000,
      exp: 1090,
    });
    expectEgressError(() => openEgressGrant(prepared.egressGrantToken, SECRET, 1121), 'expired');

    const fileRef = prepared.payload.files[0] as { id: string; storage_session_id: string };
    expect(openEgressHandle(fileRef.id, SECRET, 1089)).toMatchObject({ exp: 1090 });
    expect(openEgressHandle(fileRef.storage_session_id, SECRET, 1089)).toMatchObject({ exp: 1090 });
  });
});
