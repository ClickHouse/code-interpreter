import { describe, expect, it } from 'bun:test';
import { languageConfig, resolveEgressGrantTtlSeconds, resolveLanguage } from './config';
import { Languages } from './enum';
import { createPayload } from './payload';
import type { AuthenticatedRequest } from './types';

describe('node language configuration', () => {
  it('resolves Node.js aliases', () => {
    for (const alias of ['node', 'nodejs', 'node-js', 'node-javascript']) {
      expect(resolveLanguage(alias)).toBe(Languages.node);
    }
  });

  it('maps Node.js requests to the node sandbox runtime', () => {
    expect(languageConfig[Languages.node]).toEqual({
      language: 'node',
      version: '24.15.0',
      fileName: 'index.js',
    });
  });

  it('creates a valid Node.js execution payload', () => {
    const req = {
      body: {
        lang: 'node',
        code: 'console.log("hello from node")',
        args: ['--trace-warnings'],
        files: [],
      },
    } as unknown as AuthenticatedRequest;

    const payload = createPayload({
      req,
      isPyPlot: false,
      session_id: 'session-node',
    });

    expect(payload).toMatchObject({
      language: 'node',
      version: '24.15.0',
      session_id: 'session-node',
      args: ['--trace-warnings'],
      files: [
        {
          name: 'index.js',
          content: 'console.log("hello from node")',
        },
      ],
    });
  });
});

describe('runtime version configuration', () => {
  it('maps Python requests to Python 3.14.4', () => {
    expect(languageConfig[Languages.py]).toMatchObject({
      language: 'python',
      version: '3.14.4',
      fileName: 'main.py',
    });
  });

  it('maps Bun JavaScript and TypeScript requests to Bun 1.3.14', () => {
    expect(languageConfig[Languages.js]).toMatchObject({
      language: 'bun-js',
      version: '1.3.14',
      fileName: 'index.js',
    });
    expect(languageConfig[Languages.ts]).toMatchObject({
      language: 'bun-ts',
      version: '1.3.14',
      fileName: 'main.ts',
    });
  });
});

describe('egress grant TTL configuration', () => {
  it('defaults to job timeout plus grace without a fixed 30 minute cap', () => {
    expect(resolveEgressGrantTtlSeconds(undefined, 45 * 60 * 1000)).toBe(55 * 60);
  });

  it('honors explicit positive TTL overrides', () => {
    expect(resolveEgressGrantTtlSeconds('7200', 300000)).toBe(7200);
    expect(resolveEgressGrantTtlSeconds('1.2', 300000)).toBe(2);
  });

  it('falls back to the job-based default for invalid overrides', () => {
    expect(resolveEgressGrantTtlSeconds('0', 300000)).toBe(900);
    expect(resolveEgressGrantTtlSeconds('-1', 300000)).toBe(900);
    expect(resolveEgressGrantTtlSeconds('not-a-number', 300000)).toBe(900);
  });
});
