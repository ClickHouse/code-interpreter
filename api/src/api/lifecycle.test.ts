import { afterEach, describe, expect, test } from 'bun:test';
import {
  LIFECYCLE_HOOK_BASE_PATH,
  applyRunHook,
  getMicrovmRunContext,
  resetMicrovmRunContextForTests,
} from './lifecycle';

afterEach(resetMicrovmRunContextForTests);

describe('MicroVM /run hook context', () => {
  test('captures microvmId and runHookPayload from the platform body', () => {
    const context = applyRunHook({
      microvmId: 'mvm-0123',
      runHookPayload: '{"runtime_session_id":"rt_x"}',
    });
    expect(context.microvmId).toBe('mvm-0123');
    expect(context.runHookPayload).toBe('{"runtime_session_id":"rt_x"}');
    expect(getMicrovmRunContext()).toBe(context);
  });

  test('first run wins: a different microvmId does not overwrite the context', () => {
    applyRunHook({ microvmId: 'mvm-first', runHookPayload: 'a' });
    applyRunHook({ microvmId: 'mvm-second', runHookPayload: 'b' });
    expect(getMicrovmRunContext()?.microvmId).toBe('mvm-first');
    expect(getMicrovmRunContext()?.runHookPayload).toBe('a');
  });

  test('retries with the same microvmId are idempotent', () => {
    const first = applyRunHook({ microvmId: 'mvm-0123' });
    const second = applyRunHook({ microvmId: 'mvm-0123' });
    expect(second).toBe(first);
  });

  test('tolerates malformed and empty bodies', () => {
    expect(applyRunHook(undefined).microvmId).toBeUndefined();
    resetMicrovmRunContextForTests();
    expect(applyRunHook('not-an-object').microvmId).toBeUndefined();
    resetMicrovmRunContextForTests();
    expect(applyRunHook({ microvmId: 42, runHookPayload: {} }).microvmId).toBeUndefined();
  });

  test('hook base path matches the AWS well-known prefix', () => {
    expect(LIFECYCLE_HOOK_BASE_PATH).toBe('/aws/lambda-microvms/runtime/v1');
  });
});
