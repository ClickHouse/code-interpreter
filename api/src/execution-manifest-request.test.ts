import { describe, expect, test } from 'bun:test';
import {
  EXECUTION_MANIFEST_VERSION,
  ExecutionManifestError,
  type ExecutionManifestClaims,
  type ExecutionManifestErrorReason,
  signExecutionManifest,
  verifyExecutionManifest,
} from './execution-manifest';
import {
  collectExecuteRequestInputFiles,
  verifyExecuteRequestManifest,
} from './execution-manifest-request';

const SECRET = 'test-secret';

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

const body = {
  session_id: 'sess_output',
  files: [
    { name: 'main.py', content: 'print(1)' },
    { id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' },
  ],
};

function expectManifestError(fn: () => unknown, reason: ExecutionManifestErrorReason): void {
  try {
    fn();
    throw new Error('expected manifest error');
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionManifestError);
    expect((error as ExecutionManifestError).reason).toBe(reason);
  }
}

describe('execute request manifest validation', () => {
  test('accepts a signed manifest whose file and output-session scope matches the request', () => {
    const token = signExecutionManifest(claims(), SECRET);

    expect(collectExecuteRequestInputFiles(body)).toEqual([
      { id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' },
    ]);
    expect(verifyExecuteRequestManifest({
      headerValue: token,
      secret: SECRET,
      body,
      nowSeconds: 150,
    })).toEqual(claims());
  });

  test('includes id refs that rely on runtime defaults in the signed scope check', () => {
    const bodyWithDefaultedRefs = {
      session_id: 'sess_output',
      files: [
        { name: 'main.py', content: 'print(1)' },
        { id: 'file_same_session', name: 'inputs/current.csv' },
        { id: 'file_default_name' },
      ],
    } as unknown as Parameters<typeof collectExecuteRequestInputFiles>[0];

    expect(collectExecuteRequestInputFiles(bodyWithDefaultedRefs)).toEqual([
      { id: 'file_default_name', session_id: 'sess_output', name: 'file2.code' },
      { id: 'file_same_session', session_id: 'sess_output', name: 'inputs/current.csv' },
    ]);

    expectManifestError(() => verifyExecuteRequestManifest({
      headerValue: signExecutionManifest(claims({
        input_files: [],
        read_sessions: [],
      }), SECRET),
      secret: SECRET,
      body: bodyWithDefaultedRefs,
      nowSeconds: 150,
    }), 'scope_mismatch');

    const matchingClaims = claims({
      input_files: [
        { id: 'file_same_session', session_id: 'sess_output', name: 'inputs/current.csv' },
        { id: 'file_default_name', session_id: 'sess_output', name: 'file2.code' },
      ],
      read_sessions: ['sess_output'],
    });

    expect(verifyExecuteRequestManifest({
      headerValue: signExecutionManifest(matchingClaims, SECRET),
      secret: SECRET,
      body: bodyWithDefaultedRefs,
      nowSeconds: 150,
    })).toEqual(matchingClaims);
  });

  test('rejects missing, wrong-session, wrong-file, and expired manifests', () => {
    expectManifestError(() => verifyExecuteRequestManifest({
      headerValue: undefined,
      secret: SECRET,
      body,
      nowSeconds: 150,
    }), 'missing_header');

    expectManifestError(() => verifyExecuteRequestManifest({
      headerValue: signExecutionManifest(claims({ output_session_id: 'other_output' }), SECRET),
      secret: SECRET,
      body,
      nowSeconds: 150,
    }), 'scope_mismatch');

    expectManifestError(() => verifyExecuteRequestManifest({
      headerValue: signExecutionManifest(claims({ input_files: [{ id: 'file_other', session_id: 'sess_input', name: 'inputs/data.csv' }] }), SECRET),
      secret: SECRET,
      body,
      nowSeconds: 150,
    }), 'scope_mismatch');

    expectManifestError(() => verifyExecuteRequestManifest({
      headerValue: signExecutionManifest(claims(), SECRET),
      secret: SECRET,
      body,
      nowSeconds: 1000,
    }), 'expired');
  });

  test('rejects duplicated request files that do not exactly match manifest multiplicity', () => {
    const duplicateBody = {
      session_id: 'sess_output',
      files: [
        { id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' },
        { id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' },
      ],
    };
    const token = signExecutionManifest(claims({
      input_files: [
        { id: 'file_123', session_id: 'sess_input', name: 'inputs/data.csv' },
        { id: 'file_other', session_id: 'sess_input', name: 'inputs/other.csv' },
      ],
    }), SECRET);

    expectManifestError(() => verifyExecuteRequestManifest({
      headerValue: token,
      secret: SECRET,
      body: duplicateBody,
      nowSeconds: 150,
    }), 'scope_mismatch');
  });

  test('rejects extra manifest read sessions beyond the request file scope', () => {
    const token = signExecutionManifest(claims({
      read_sessions: ['sess_input', 'sess_extra'],
    }), SECRET);

    expectManifestError(() => verifyExecuteRequestManifest({
      headerValue: token,
      secret: SECRET,
      body,
      nowSeconds: 150,
    }), 'scope_mismatch');
  });

  test('rejects non-base64url manifest parts as malformed', () => {
    const token = signExecutionManifest(claims(), SECRET);
    const [payload, signature] = token.split('.') as [string, string];

    expectManifestError(() => verifyExecutionManifest(`${payload}!comment.${signature}`, SECRET, {
      nowSeconds: 150,
    }), 'malformed');
  });
});
