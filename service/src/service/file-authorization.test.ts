import { describe, expect, test } from 'bun:test';
import type * as t from '../types';
import { resolveSessionKey } from '../session-key';
import {
  FileRefAuthorizationError,
  authorizeRequestedFiles,
  validateRequestedFiles,
} from './file-authorization';

const USER_ID = 'user_123';
const TENANT_ID = 'tenant_abc';
const ENTITY_ID = 'entity_123';
const SESSION_ID = 'sess_1234567890123456';
const OTHER_SESSION_ID = 'sess_6543210987654321';
const FILE_ID = 'file_1234567890123456';

class FakeStore {
  private values = new Map<string, string>();

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async exists(key: string): Promise<number> {
    return this.values.has(key) ? 1 : 0;
  }
}

function request(authContext?: t.CodeApiAuthContext): t.AuthenticatedRequest {
  return { codeApiAuthContext: authContext } as t.AuthenticatedRequest;
}

function validFile(overrides: Partial<t.RequestFile> = {}): t.RequestFile {
  return {
    id: FILE_ID,
    session_id: SESSION_ID,
    name: 'inputs/data.csv',
    ...overrides,
  };
}

function ownedStore(sessionKey: string, file = validFile()): FakeStore {
  const store = new FakeStore();
  store.set(`session:${file.session_id}`, sessionKey);
  store.set(`upload:${sessionKey}${file.session_id}${file.id}`, 'true');
  return store;
}

async function expectAuthError(promise: Promise<unknown>, status: 400 | 403): Promise<void> {
  try {
    await promise;
    throw new Error('expected authorization error');
  } catch (err) {
    expect(err).toBeInstanceOf(FileRefAuthorizationError);
    expect((err as FileRefAuthorizationError).status).toBe(status);
  }
}

describe('validateRequestedFiles', () => {
  test('accepts and sanitizes valid file refs', () => {
    expect(validateRequestedFiles([{ ...validFile(), ignored: true }])).toEqual([validFile()]);
  });

  test('rejects malformed ids', () => {
    expect(() => validateRequestedFiles([validFile({ id: '../bad' })])).toThrow(FileRefAuthorizationError);
  });

  test('rejects path-like traversal names', () => {
    expect(() => validateRequestedFiles([validFile({ name: '../secrets.txt' })])).toThrow(FileRefAuthorizationError);
    expect(() => validateRequestedFiles([validFile({ name: 'dir//file.txt' })])).toThrow(FileRefAuthorizationError);
    expect(() => validateRequestedFiles([validFile({ name: '/abs/file.txt' })])).toThrow(FileRefAuthorizationError);
  });
});

describe('authorizeRequestedFiles', () => {
  test('allows files owned by the resolved legacy session key', async () => {
    const sessionKey = resolveSessionKey(request(), USER_ID);
    const store = ownedStore(sessionKey);

    await expect(authorizeRequestedFiles({
      req: request(),
      files: [validFile()],
      userId: USER_ID,
      store,
    })).resolves.toEqual([validFile()]);
  });

  test('allows files owned by the resolved entity session key', async () => {
    const sessionKey = resolveSessionKey(request(), USER_ID, ENTITY_ID);
    const store = ownedStore(sessionKey);

    await expect(authorizeRequestedFiles({
      req: request(),
      files: [validFile()],
      userId: USER_ID,
      entityId: ENTITY_ID,
      store,
    })).resolves.toEqual([validFile()]);
  });

  test('uses canonical tenant/user/entity context when present', async () => {
    const req = request({ tenantId: TENANT_ID, userId: USER_ID });
    const sessionKey = resolveSessionKey(req, 'api-key-user', ENTITY_ID);
    const store = ownedStore(sessionKey);

    expect(sessionKey).toBe(`tenant:${TENANT_ID}:user:${USER_ID}:entity:${ENTITY_ID}`);
    await expect(authorizeRequestedFiles({
      req,
      files: [validFile()],
      userId: 'api-key-user',
      entityId: ENTITY_ID,
      store,
    })).resolves.toEqual([validFile()]);
  });

  test('rejects a foreign session before enqueue', async () => {
    const store = new FakeStore();
    store.set(`session:${SESSION_ID}`, 'someone-else');

    await expectAuthError(authorizeRequestedFiles({
      req: request(),
      files: [validFile()],
      userId: USER_ID,
      store,
    }), 403);
  });

  test('rejects a missing upload marker before enqueue', async () => {
    const sessionKey = resolveSessionKey(request(), USER_ID);
    const store = new FakeStore();
    store.set(`session:${SESSION_ID}`, sessionKey);

    await expectAuthError(authorizeRequestedFiles({
      req: request(),
      files: [validFile()],
      userId: USER_ID,
      store,
    }), 403);
  });

  test('rejects same entity across different tenant contexts', async () => {
    const tenantA = request({ tenantId: 'tenant_a', userId: USER_ID });
    const tenantB = request({ tenantId: 'tenant_b', userId: USER_ID });
    const tenantASessionKey = resolveSessionKey(tenantA, USER_ID, ENTITY_ID);
    const store = ownedStore(tenantASessionKey);

    await expectAuthError(authorizeRequestedFiles({
      req: tenantB,
      files: [validFile()],
      userId: USER_ID,
      entityId: ENTITY_ID,
      store,
    }), 403);
  });

  test('rejects malformed refs as 400', async () => {
    await expectAuthError(authorizeRequestedFiles({
      req: request(),
      files: [validFile({ session_id: OTHER_SESSION_ID, name: 'a/../b.txt' })],
      userId: USER_ID,
      store: new FakeStore(),
    }), 400);
  });

  test('per-file entity_id authorizes against its own session key', async () => {
    const skillEntity = 'skill_42';
    const skillSessionKey = resolveSessionKey(request(), USER_ID, skillEntity);
    const store = ownedStore(skillSessionKey);

    await expect(authorizeRequestedFiles({
      req: request(),
      files: [validFile({ entity_id: skillEntity })],
      userId: USER_ID,
      entityId: 'agent_unrelated',
      store,
    })).resolves.toEqual([validFile({ entity_id: skillEntity })]);
  });

  test('mixed-entity execute: skill file (per-file entity) + user attachment (request-level fallback) both authorize', async () => {
    const skillEntity = 'skill_99';
    const userSessionId = 'sess_aaaa1111aaaa1111';
    const skillSessionId = 'sess_bbbb2222bbbb2222';
    const userFileId = 'file_user1234567890ab';
    const skillFileId = 'file_skill1234567890a';

    const userFile: t.RequestFile = {
      id: userFileId,
      session_id: userSessionId,
      name: 'inputs/user.csv',
    };
    const skillFile: t.RequestFile = {
      id: skillFileId,
      session_id: skillSessionId,
      name: 'inputs/skill.json',
      entity_id: skillEntity,
    };

    const userSessionKey = resolveSessionKey(request(), USER_ID);
    const skillSessionKey = resolveSessionKey(request(), USER_ID, skillEntity);

    const store = new FakeStore();
    store.set(`session:${userSessionId}`, userSessionKey);
    store.set(`upload:${userSessionKey}${userSessionId}${userFileId}`, 'true');
    store.set(`session:${skillSessionId}`, skillSessionKey);
    store.set(`upload:${skillSessionKey}${skillSessionId}${skillFileId}`, 'true');

    await expect(authorizeRequestedFiles({
      req: request(),
      files: [userFile, skillFile],
      userId: USER_ID,
      store,
    })).resolves.toEqual([userFile, skillFile]);
  });

  test('legacy client (no per-file entity_id, request-level entity_id) resolves via fallback', async () => {
    const sessionKey = resolveSessionKey(request(), USER_ID, ENTITY_ID);
    const store = ownedStore(sessionKey);

    await expect(authorizeRequestedFiles({
      req: request(),
      files: [validFile()],
      userId: USER_ID,
      entityId: ENTITY_ID,
      store,
    })).resolves.toEqual([validFile()]);
  });

  test('per-file entity_id overrides request-level entity_id (does not fall back when set)', async () => {
    const skillEntity = 'skill_77';
    const requestEntity = 'agent_anything';

    const skillSessionKey = resolveSessionKey(request(), USER_ID, skillEntity);
    const store = ownedStore(skillSessionKey);

    await expect(authorizeRequestedFiles({
      req: request(),
      files: [validFile({ entity_id: skillEntity })],
      userId: USER_ID,
      entityId: requestEntity,
      store,
    })).resolves.toEqual([validFile({ entity_id: skillEntity })]);

    const requestSessionKey = resolveSessionKey(request(), USER_ID, requestEntity);
    const fallbackStore = ownedStore(requestSessionKey);

    await expectAuthError(authorizeRequestedFiles({
      req: request(),
      files: [validFile({ entity_id: skillEntity })],
      userId: USER_ID,
      entityId: requestEntity,
      store: fallbackStore,
    }), 403);
  });

  test('rejects malformed per-file entity_id as 400', async () => {
    await expectAuthError(authorizeRequestedFiles({
      req: request(),
      files: [validFile({ entity_id: 'has spaces and !*invalid' })],
      userId: USER_ID,
      store: new FakeStore(),
    }), 400);
  });

  test('error context includes file entity_id and effectiveEntityId on session_key_mismatch', async () => {
    const skillEntity = 'skill_55';
    const store = new FakeStore();
    store.set(`session:${SESSION_ID}`, 'someone-else');

    try {
      await authorizeRequestedFiles({
        req: request(),
        files: [validFile({ entity_id: skillEntity })],
        userId: USER_ID,
        entityId: 'agent_unused',
        store,
      });
      throw new Error('expected authorization error');
    } catch (err) {
      expect(err).toBeInstanceOf(FileRefAuthorizationError);
      const e = err as FileRefAuthorizationError;
      expect(e.reason).toBe('session_key_mismatch');
      expect(e.context.effectiveEntityId).toBe(skillEntity);
      expect((e.context.file as { entity_id?: string }).entity_id).toBe(skillEntity);
    }
  });
});
