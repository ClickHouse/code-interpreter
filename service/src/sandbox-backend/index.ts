import type { SandboxBackend } from './types';
import { HttpSandboxBackend } from './http';
import { env } from '../config';

export type { SandboxBackend, SandboxExecuteContext, SandboxRawResponse, SandboxTransportRequest } from './types';
export { HttpSandboxBackend } from './http';

let backend: SandboxBackend | undefined;

function createBackend(): SandboxBackend {
  if (env.SANDBOX_BACKEND === 'lambda-microvm') {
    throw new Error('CODEAPI_SANDBOX_BACKEND=lambda-microvm is not yet available');
  }
  return new HttpSandboxBackend();
}

export function getSandboxBackend(): SandboxBackend {
  backend ??= createBackend();
  return backend;
}

export function setSandboxBackendForTests(next: SandboxBackend | undefined): void {
  backend = next;
}
