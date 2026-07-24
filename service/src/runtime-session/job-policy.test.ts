import { describe, expect, test } from 'bun:test';
import {
  PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
  resolveRuntimeSessionIdForJob,
} from './job-policy';

describe('resolveRuntimeSessionIdForJob', () => {
  test('keeps explicitly exempt programmatic jobs stateless in strict mode', () => {
    expect(resolveRuntimeSessionIdForJob({
      mode: 'strict',
      runtimeSessionExemption: PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
      isSynthetic: false,
    })).toBeUndefined();
  });

  test('the programmatic exemption wins over an accidentally supplied session id', () => {
    expect(resolveRuntimeSessionIdForJob({
      mode: 'affinity',
      runtimeSessionId: 'rt_should_not_be_used',
      runtimeSessionExemption: PROGRAMMATIC_RUNTIME_SESSION_EXEMPTION,
      isSynthetic: false,
    })).toBeUndefined();
  });

  test('strict ordinary jobs still require a runtime session id', () => {
    expect(() => resolveRuntimeSessionIdForJob({
      mode: 'strict',
      isSynthetic: false,
    })).toThrow('strict runtime session mode requires a runtimeSessionId on the job');
  });

  test('synthetic jobs retain their existing strict-mode exemption', () => {
    expect(resolveRuntimeSessionIdForJob({
      mode: 'strict',
      isSynthetic: true,
    })).toBeUndefined();
  });
});
