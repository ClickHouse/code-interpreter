import { describe, expect, test } from 'bun:test';
import { NPM_UNIT_KEEP, type NpmUnitRequest } from './npm-unit-contract';
import {
  buildNpmUnitDispatchRequest,
  validateNpmUnitDispatchRequest,
} from './npm-unit-dispatch';

const request: NpmUnitRequest = {
  name: '@tanstack/react-query',
  version: '4.36.1',
  integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  resolved: 'https://registry.npmjs.org/@tanstack/react-query/-/react-query-4.36.1.tgz',
  keep: [...NPM_UNIT_KEEP],
};

describe('direct npm unit dispatch contract', () => {
  test('builds opaque fixed-width identity labels and validates the request', () => {
    const dispatch = buildNpmUnitDispatchRequest({
      executionId: 'abcdefghij_1234567890',
      tenantId: 'tenant-secret',
      canonicalUserId: 'user-secret',
      principalSource: 'librechat_jwt',
      request,
    });

    expect(dispatch.tenantLabel).toMatch(/^tenant:[A-Za-z0-9_-]{32}$/);
    expect(dispatch.userLabel).toMatch(/^user:[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(dispatch)).not.toContain('tenant-secret');
    expect(JSON.stringify(dispatch)).not.toContain('user-secret');
    expect(validateNpmUnitDispatchRequest(dispatch)).toEqual(dispatch);
  });

  test('rejects extra fields and forged identity labels', () => {
    const dispatch = buildNpmUnitDispatchRequest({
      executionId: 'abcdefghij_1234567890',
      tenantId: 'tenant-secret',
      canonicalUserId: 'user-secret',
      principalSource: 'librechat_jwt',
      request,
    });

    expect(() => validateNpmUnitDispatchRequest({ ...dispatch, queued: true })).toThrow('unknown dispatch field');
    expect(() => validateNpmUnitDispatchRequest({ ...dispatch, tenantLabel: 'tenant:raw-value' })).toThrow('tenantLabel');
  });
});
