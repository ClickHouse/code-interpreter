import { afterEach, describe, expect, test } from 'bun:test';
import { env } from '../config';
import { HttpSandboxBackend } from './http';
import { getSandboxBackend, setSandboxBackendForTests } from './index';
import type { SandboxBackend } from './types';

const savedBackend = env.SANDBOX_BACKEND;

afterEach(() => {
  env.SANDBOX_BACKEND = savedBackend;
  setSandboxBackendForTests(undefined);
});

describe('getSandboxBackend', () => {
  test('defaults to the http backend and memoizes it', () => {
    const backend = getSandboxBackend();
    expect(backend).toBeInstanceOf(HttpSandboxBackend);
    expect(backend.name).toBe('http');
    expect(getSandboxBackend()).toBe(backend);
  });

  test('rejects lambda-microvm until the backend lands', () => {
    env.SANDBOX_BACKEND = 'lambda-microvm';
    expect(() => getSandboxBackend()).toThrow('lambda-microvm is not yet available');
  });

  test('test seam replaces the active backend', () => {
    const fake: SandboxBackend = {
      name: 'http',
      execute: () => Promise.reject(new Error('unused')),
    };
    setSandboxBackendForTests(fake);
    expect(getSandboxBackend()).toBe(fake);
    setSandboxBackendForTests(undefined);
    expect(getSandboxBackend()).toBeInstanceOf(HttpSandboxBackend);
  });
});
