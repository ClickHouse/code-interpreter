import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import {
  NPM_UNIT_KEEP,
  NpmUnitValidationError,
  canonicalNpmTarballUrl,
  validateNpmUnitRequest,
} from './npm-unit-contract';

const REGISTRY = 'https://registry.npmjs.org';
const INTEGRITY = `sha512-${createHash('sha512').update('tarball').digest('base64')}`;

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@tanstack/react-query',
    version: '4.36.1',
    integrity: INTEGRITY,
    resolved: 'https://registry.npmjs.org/@tanstack/react-query/-/react-query-4.36.1.tgz',
    keep: [...NPM_UNIT_KEEP],
    ...overrides,
  };
}

describe('npm unit request contract', () => {
  test('normalizes one exact scoped registry tarball request', () => {
    expect(validateNpmUnitRequest(valid(), REGISTRY)).toEqual({
      name: '@tanstack/react-query',
      version: '4.36.1',
      integrity: INTEGRITY,
      resolved: canonicalNpmTarballUrl('@tanstack/react-query', '4.36.1', REGISTRY),
      keep: [...NPM_UNIT_KEEP],
    });
  });

  test.each([
    '../../evil',
    '@scope/../evil',
    '@scope',
    '@scope/pkg/extra',
    'UpperCase',
    '.hidden',
  ])('rejects unsafe or non-canonical package name %s', name => {
    expect(() => validateNpmUnitRequest(valid({ name }), REGISTRY)).toThrow(NpmUnitValidationError);
  });

  test('rejects an off-registry URL and a cross-package registry URL', () => {
    expect(() => validateNpmUnitRequest(valid({
      resolved: 'https://evil.example/react-query-4.36.1.tgz',
    }), REGISTRY)).toThrow('configured registry');
    expect(() => validateNpmUnitRequest(valid({
      resolved: 'https://registry.npmjs.org/zod/-/zod-4.36.1.tgz',
    }), REGISTRY)).toThrow('exactly match');
  });

  test('rejects flexible versions, non-sha512 integrity, mutable keep globs, and unknown fields', () => {
    expect(() => validateNpmUnitRequest(valid({ version: '^4.36.1' }), REGISTRY)).toThrow('exact semantic');
    expect(() => validateNpmUnitRequest(valid({ integrity: 'sha1-deadbeef' }), REGISTRY)).toThrow('sha512');
    expect(() => validateNpmUnitRequest(valid({ keep: ['**/*'] }), REGISTRY)).toThrow('keep must be exactly');
    expect(() => validateNpmUnitRequest(valid({ extra: true }), REGISTRY)).toThrow('Unknown request fields');
  });
});
