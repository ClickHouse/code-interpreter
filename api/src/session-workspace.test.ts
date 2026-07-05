import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import {
  SessionWorkspace,
  bindSessionWorkspace,
  getBoundSessionWorkspace,
  parseSessionBinding,
  resetSessionWorkspaceStateForTests,
  unbindSessionWorkspace,
} from './session-workspace';

const savedEnabled = config.session_workspace_enabled;

afterEach(async () => {
  config.session_workspace_enabled = savedEnabled;
  await unbindSessionWorkspace().catch(() => {});
  resetSessionWorkspaceStateForTests();
});

describe('parseSessionBinding (gating)', () => {
  test('returns undefined when the image-level flag is off, regardless of payload', () => {
    config.session_workspace_enabled = false;
    expect(parseSessionBinding(JSON.stringify({ runtime_session_id: 'rt_1', session_workspace: true }))).toBeUndefined();
  });

  test('binds only when enabled AND the payload opts in with a runtime_session_id', () => {
    config.session_workspace_enabled = true;
    expect(parseSessionBinding(JSON.stringify({ runtime_session_id: 'rt_1', session_workspace: true })))
      .toEqual({ runtimeSessionId: 'rt_1' });
  });

  test('rejects payloads missing the opt-in flag or the session id', () => {
    config.session_workspace_enabled = true;
    expect(parseSessionBinding(JSON.stringify({ runtimeSessionId: 'rt_1' }))).toBeUndefined();
    expect(parseSessionBinding(JSON.stringify({ session_workspace: true }))).toBeUndefined();
    expect(parseSessionBinding(JSON.stringify({ session_workspace: true, runtime_session_id: '' }))).toBeUndefined();
  });

  test('tolerates absent and non-JSON payloads', () => {
    config.session_workspace_enabled = true;
    expect(parseSessionBinding(undefined)).toBeUndefined();
    expect(parseSessionBinding('')).toBeUndefined();
    expect(parseSessionBinding('not json')).toBeUndefined();
  });
});

describe('bindSessionWorkspace lifecycle', () => {
  test('binding is idempotent for the same runtime session and returns the same instance', () => {
    const a = bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
    const b = bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
    expect(a).toBe(b);
    expect(getBoundSessionWorkspace()).toBe(a);
  });

  test('a different runtime session replaces the binding', () => {
    const a = bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
    const b = bindSessionWorkspace({ runtimeSessionId: 'rt_2' });
    expect(b).not.toBe(a);
    expect(getBoundSessionWorkspace()?.runtimeSessionId).toBe('rt_2');
  });

  test('unbind clears the bound session', async () => {
    bindSessionWorkspace({ runtimeSessionId: 'rt_1' });
    await unbindSessionWorkspace();
    expect(getBoundSessionWorkspace()).toBeUndefined();
  });
});

describe('SessionWorkspace state', () => {
  test('surfaced and primed tracking, cleared on reset', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sw-state-'));
    const savedPerJob = config.per_job_uids;
    config.per_job_uids = false;
    try {
      const ws = new SessionWorkspace({ runtimeSessionId: 'rt_1' });

      expect(ws.isSurfaced('out.csv', '10:100')).toBe(false);
      ws.markSurfaced('out.csv', '10:100');
      expect(ws.isSurfaced('out.csv', '10:100')).toBe(true);
      expect(ws.isSurfaced('out.csv', '11:200')).toBe(false);

      expect(ws.primedInputId('in.csv')).toBeUndefined();
      ws.markPrimed('in.csv', 'file_abc');
      expect(ws.primedInputId('in.csv')).toBe('file_abc');

      await ws.reset();
      expect(ws.isSurfaced('out.csv', '10:100')).toBe(false);
      expect(ws.primedInputId('in.csv')).toBeUndefined();
    } finally {
      config.per_job_uids = savedPerJob;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
