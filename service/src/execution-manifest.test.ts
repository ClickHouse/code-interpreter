import { describe, expect, test } from 'bun:test';
import type * as t from './types';
import { buildExecutionManifestClaims, collectManifestInputFiles } from './execution-manifest-claims';
import {
  EXECUTION_MANIFEST_VERSION,
  ExecutionManifestError,
  type ExecutionManifestErrorReason,
  type ExecutionManifestClaims,
  signExecutionManifest,
  signExecutionManifestWithPrivateKey,
  verifyExecutionManifest,
  verifyExecutionManifestWithKey,
  verifyExecutionManifestWithPublicKey,
} from './execution-manifest';

const SECRET = 'test-secret';
const PRIVATE_KEY = 'MC4CAQAwBQYDK2VwBCIEIBoxzSJjQ5jTVyuohHtlD+uDGqv/tZ6hQS2CmxuOg2Wn';
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAeY3PRoTS3adfU6E3gQUB5hSZdrdMSw6OrKkH4UhYh0U=';

function claims(overrides: Partial<ExecutionManifestClaims> = {}): ExecutionManifestClaims {
  return {
    v: EXECUTION_MANIFEST_VERSION,
    exec_id: 'exec_123',
    tenant_id: 'tenant_abc',
    user_id: 'user_123',
    session_key: 'tenant:tenant_abc:user:user_123',
    input_files: [{ id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' }],
    read_sessions: ['sess_input'],
    output_session_id: 'sess_output',
    max_upload_bytes: 1024,
    max_output_files: 10,
    max_requests: 50,
    iat: 100,
    exp: 200,
    principal_source: 'librechat',
    ...overrides,
  };
}

function expectManifestError(fn: () => unknown, reason: ExecutionManifestErrorReason): void {
  try {
    fn();
    throw new Error('expected manifest error');
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionManifestError);
    expect((error as ExecutionManifestError).reason).toBe(reason);
  }
}

describe('execution manifest signing', () => {
  test('round-trips signed claims', () => {
    const token = signExecutionManifest(claims(), SECRET);
    expect(verifyExecutionManifest(token, SECRET, { nowSeconds: 150 })).toEqual(claims());
  });

  test('round-trips asymmetric signed claims with public verifier only', () => {
    const token = signExecutionManifestWithPrivateKey(claims(), PRIVATE_KEY);
    expect(verifyExecutionManifestWithPublicKey(token, PUBLIC_KEY, { nowSeconds: 150 })).toEqual(claims());
    expectManifestError(() => verifyExecutionManifest(token, SECRET, { nowSeconds: 150 }), 'invalid_signature');
  });

  test('falls back to legacy HMAC verification only when public-key signature verification fails', () => {
    const token = signExecutionManifest(claims(), SECRET);

    expect(verifyExecutionManifestWithKey(token, {
      publicKey: PUBLIC_KEY,
      secret: SECRET,
    }, { nowSeconds: 150 })).toEqual(claims());

    expectManifestError(() => verifyExecutionManifestWithKey(token, {
      publicKey: PUBLIC_KEY,
      secret: SECRET,
    }, { nowSeconds: 1000 }), 'expired');
  });

  test('uses canonical JSON independent of insertion order', () => {
    const first = claims();
    const second = {
      exp: 200,
      iat: 100,
      max_requests: 50,
      max_output_files: 10,
      max_upload_bytes: 1024,
      output_session_id: 'sess_output',
      read_sessions: ['sess_input'],
      input_files: [{ name: 'inputs/data.csv', session_id: 'sess_input', id: 'file_123' }],
      session_key: 'tenant:tenant_abc:user:user_123',
      user_id: 'user_123',
      tenant_id: 'tenant_abc',
      exec_id: 'exec_123',
      principal_source: 'librechat',
      v: EXECUTION_MANIFEST_VERSION,
    } as ExecutionManifestClaims;

    expect(signExecutionManifest(first, SECRET)).toBe(signExecutionManifest(second, SECRET));
  });

  test('rejects tampered and expired manifests', () => {
    const token = signExecutionManifest(claims(), SECRET);
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

    expectManifestError(() => verifyExecutionManifest(tampered, SECRET, { nowSeconds: 150 }), 'invalid_signature');
    expectManifestError(() => verifyExecutionManifest(token, SECRET, { nowSeconds: 1000 }), 'expired');
  });

  test('rejects non-base64url manifest parts as malformed', () => {
    const token = signExecutionManifest(claims(), SECRET);
    const [payload, signature] = token.split('.') as [string, string];

    expectManifestError(() => verifyExecutionManifest(`${payload}!comment.${signature}`, SECRET, {
      nowSeconds: 150,
    }), 'malformed');
  });
});

describe('execution manifest claim construction', () => {
  test('builds scoped claims from payload file refs and auth context', () => {
    const payload: t.PayloadBody = {
      language: 'python',
      version: '3.12.0',
      session_id: 'sess_output',
      files: [
        { name: 'main.py', content: 'print(1)' },
        { id: 'file_b', storage_session_id: 'sess_b', name: 'b.csv' },
        { id: 'file_a', storage_session_id: 'sess_a', name: 'a.csv' },
      ],
    };
    const req = {
      codeApiAuthContext: {
        tenantId: 'tenant_ctx',
        userId: 'user_ctx',
        orgId: 'org_123',
        serviceId: 'svc_123',
        chcUserId: 'chc_123',
        principalSource: 'librechat',
        authContextHash: 'hash_123',
      },
    } as t.AuthenticatedRequest;

    expect(collectManifestInputFiles(payload)).toEqual([
      { id: 'file_a', session_id: 'sess_a', name: 'a.csv' },
      { id: 'file_b', session_id: 'sess_b', name: 'b.csv' },
    ]);

    const built = buildExecutionManifestClaims({
      req,
      executionId: 'exec_ctx',
      userId: 'api_key_user',
      sessionKey: 'tenant:tenant_ctx:user:user_ctx',
      outputSessionId: 'sess_output',
      payload,
      nowSeconds: 100,
    });

    expect(built).toMatchObject({
      exec_id: 'exec_ctx',
      tenant_id: 'tenant_ctx',
      user_id: 'user_ctx',
      session_key: 'tenant:tenant_ctx:user:user_ctx',
      output_session_id: 'sess_output',
      read_sessions: ['sess_a', 'sess_b'],
      org_id: 'org_123',
      service_id: 'svc_123',
      chc_user_id: 'chc_123',
      principal_source: 'librechat',
      auth_context_hash: 'hash_123',
      iat: 100,
    });
    expect(built.exp).toBeGreaterThan(100);
  });
});
