import { afterEach, describe, expect, test } from 'bun:test';
import { restoreSessionCheckpoint, streamSessionCheckpoint } from './session-checkpoint';
import { resetSessionWorkspaceStateForTests } from './session-workspace';

afterEach(resetSessionWorkspaceStateForTests);

/** Minimal Express response double capturing status + json body. */
function fakeRes(): { status: number; body: unknown; setHeader: () => void; destroy: () => void } & {
  status(code: number): { json(body: unknown): void };
} {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: () => {},
    destroy: () => {},
    status(code: number) {
      res.statusCode = code;
      return {
        json(body: unknown) { res.body = body; },
      };
    },
  };
  return res as never;
}

describe('session checkpoint gating', () => {
  test('checkpoint is 409 when no session is bound', async () => {
    const res = fakeRes();
    await streamSessionCheckpoint(res as never);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(409);
  });

  test('restore is 409 when no session is bound', async () => {
    const res = fakeRes();
    await restoreSessionCheckpoint({} as never, res as never);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(409);
  });
});
