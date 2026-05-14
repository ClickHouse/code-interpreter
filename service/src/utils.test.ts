import { describe, expect, test } from 'bun:test';
import type { AxiosError } from 'axios';
import { isValidId, isValidResourceId, publicExecutionFailure, sandboxErrorMessageFromAxios } from './utils';

describe('isValidId (21-char nanoid for sandbox-generated ids)', () => {
  test('accepts a canonical 21-char nanoid', () => {
    expect(isValidId('aBc123_-defGhi456jKlM')).toBe(true);
  });

  test('rejects empty / undefined', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId()).toBe(false);
  });

  test('rejects 24-char Mongo ObjectId (length mismatch)', () => {
    /* The reason `isValidResourceId` exists — `isValidId` is reserved
     * for storage uuids that codeapi/file_server generated and is
     * deliberately strict on length. */
    expect(isValidId('69dcf561f37f717858d4d072')).toBe(false);
  });

  test('rejects 17-char agent slug', () => {
    expect(isValidId('agent_abc12345678')).toBe(false);
  });

  test('rejects shapes with disallowed punctuation', () => {
    /* Nanoid alphabet is `[A-Za-z0-9_-]` — no `.`, `:`, `/`, etc. */
    expect(isValidId('aaaaaaaaaaaaaaaaaaaa.')).toBe(false);
    expect(isValidId('aaaaaaaaaaaaaaaaaaaa:')).toBe(false);
    expect(isValidId('aaaaaaaaaaaaaaaaaaaa/')).toBe(false);
  });

  test('rejects whitespace / control chars', () => {
    expect(isValidId('aaaaaaaa aaaaaaaaaaaa')).toBe(false);
    expect(isValidId('aaaaaaaaaaaaaaaaaaaaa\n')).toBe(false);
  });
});

describe('isValidResourceId (heterogeneous resource identifiers)', () => {
  /* The sprint added this validator distinct from `isValidId` so the
   * `resource_id` field on `RequestFile` could carry skill `_id`
   * (24-char Mongo hex), agent slug (`agent_<nanoid>`), or user id
   * (Mongo hex / other) — all of which `isValidId` rightly rejects.
   * Without it, every shared-kind /exec 400'd at the validator. */

  test('accepts 24-char Mongo ObjectId (skill _id, user _id)', () => {
    expect(isValidResourceId('69dcf561f37f717858d4d072')).toBe(true);
    expect(isValidResourceId('682f49b90f07376815c38ef2')).toBe(true);
  });

  test("accepts 17-char `agent_<nanoid>` slug", () => {
    expect(isValidResourceId('agent_abc12345678')).toBe(true);
  });

  test('accepts the `_` and `-` and `.` and `:` punctuation explicitly', () => {
    expect(isValidResourceId('foo_bar')).toBe(true);
    expect(isValidResourceId('foo-bar')).toBe(true);
    expect(isValidResourceId('foo.bar')).toBe(true);
    expect(isValidResourceId('foo:bar')).toBe(true);
  });

  test('accepts 21-char nanoid (back-compat with values that happen to fit isValidId too)', () => {
    /* A migrated client may briefly send a nanoid as resource_id (e.g.
     * during the LC bridge period). The looser regex must still admit
     * it so the request authorizes — sessionKey resolution is the
     * tamper-resistance boundary, not this format check. */
    expect(isValidResourceId('aBc123_-defGhi456jKlM')).toBe(true);
  });

  test('rejects empty / undefined', () => {
    expect(isValidResourceId('')).toBe(false);
    expect(isValidResourceId()).toBe(false);
  });

  test('rejects whitespace anywhere', () => {
    expect(isValidResourceId('has space')).toBe(false);
    expect(isValidResourceId(' leading')).toBe(false);
    expect(isValidResourceId('trailing ')).toBe(false);
    expect(isValidResourceId('with\ttab')).toBe(false);
    expect(isValidResourceId('with\nnewline')).toBe(false);
  });

  test('rejects path separators / shell metacharacters', () => {
    expect(isValidResourceId('foo/bar')).toBe(false);
    expect(isValidResourceId('../traversal')).toBe(false);
    expect(isValidResourceId('foo;rm -rf')).toBe(false);
    expect(isValidResourceId('foo$(bad)')).toBe(false);
    expect(isValidResourceId('foo|bar')).toBe(false);
  });

  test('rejects values longer than 128 chars (length-bounded)', () => {
    expect(isValidResourceId('a'.repeat(128))).toBe(true);
    expect(isValidResourceId('a'.repeat(129))).toBe(false);
    expect(isValidResourceId('a'.repeat(10_000))).toBe(false);
  });

  test('rejects null bytes and control chars', () => {
    expect(isValidResourceId('foo\0bar')).toBe(false);
    expect(isValidResourceId('foo\x01bar')).toBe(false);
  });
});

describe('sandbox error formatting', () => {
  test('preserves sandbox error code and safe message from axios response data', () => {
    const err = {
      message: 'Request failed with status code 503',
      response: {
        data: {
          error: 'permission_denied',
          message: 'Sandbox setup failed: operation not permitted',
        },
      },
    } as AxiosError;

    expect(sandboxErrorMessageFromAxios(err)).toBe(
      '[permission_denied] Sandbox setup failed: operation not permitted',
    );
  });

  test('maps sandbox setup failures from worker errors to public responses', () => {
    const err = new Error('Error from sandbox [mount_failed]: Sandbox setup failed: workspace mount failed');

    expect(publicExecutionFailure(err)).toEqual({
      status: 503,
      body: {
        error: 'mount_failed',
        message: 'Sandbox setup failed: workspace mount failed',
      },
    });
  });

  test('maps sandbox request guard failures to public bad requests', () => {
    const axiosErr = {
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: {
          message: 'run_timeout cannot exceed the configured limit of 15000',
        },
      },
    } as AxiosError;

    const workerErr = new Error(`Error from sandbox: ${sandboxErrorMessageFromAxios(axiosErr)}`);

    expect(publicExecutionFailure(workerErr)).toEqual({
      status: 400,
      body: {
        error: 'bad_request',
        message: 'run_timeout cannot exceed the configured limit of 15000',
      },
    });
  });

  test('maps sanitized sandbox execution failures to bad gateway', () => {
    const err = new Error('Error from sandbox [sandbox_execution_failed]: Sandbox execution failed');

    expect(publicExecutionFailure(err)).toEqual({
      status: 502,
      body: {
        error: 'sandbox_execution_failed',
        message: 'Sandbox execution failed',
      },
    });
  });

  test('does not expose arbitrary sandbox errors as public infrastructure failures', () => {
    const err = new Error('Error from sandbox [unexpected]: very specific internal detail');

    expect(publicExecutionFailure(err)).toBeNull();
  });
});
