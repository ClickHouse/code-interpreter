import { describe, expect, test } from 'bun:test';
import { tokenFromBodyOrHeader, type ExecuteRequestBody } from './api/v2';

function body(overrides: Partial<ExecuteRequestBody> = {}): ExecuteRequestBody {
  return {
    language: 'bash',
    version: '5.2.0',
    files: [{ name: 'script.sh', content: 'echo ok' }],
    ...overrides,
  };
}

describe('sandbox execute capability transport', () => {
  test('prefers body-carried egress grants over legacy headers', () => {
    expect(tokenFromBodyOrHeader(
      body({ egress_grant: 'body-grant' }),
      'egress_grant',
      'header-grant',
    )).toBe('body-grant');
  });

  test('preserves legacy header fallback during rolling deploys', () => {
    expect(tokenFromBodyOrHeader(
      body(),
      'egress_grant',
      'header-grant',
    )).toBe('header-grant');
  });

  test('supports body-carried execution manifests', () => {
    expect(tokenFromBodyOrHeader(
      body({ execution_manifest: 'body-manifest' }),
      'execution_manifest',
      'header-manifest',
    )).toBe('body-manifest');
  });
});
