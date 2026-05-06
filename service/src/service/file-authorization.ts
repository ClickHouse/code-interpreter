import path from 'path';
import type * as t from '../types';
import { isValidId } from '../utils';
import { resolveSessionKey } from '../session-key';
import { validateEntityIdString } from '../middleware/auth';

const MAX_FILE_REF_NAME_LENGTH = 256;
const MAX_FILE_REF_NESTING_DEPTH = 10;

type FileRefStore = {
  get(key: string): Promise<string | null>;
  exists(key: string): Promise<number>;
};

export type FileRefAuthDenyReason =
  | 'session_key_mismatch'
  | 'upload_missing'
  | 'invalid_input';

export class FileRefAuthorizationError extends Error {
  readonly status: 400 | 403;
  readonly reason: FileRefAuthDenyReason;
  readonly context: Record<string, unknown>;

  constructor(
    status: 400 | 403,
    message: string,
    reason: FileRefAuthDenyReason = 'invalid_input',
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'FileRefAuthorizationError';
    this.status = status;
    this.reason = reason;
    this.context = context;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFileRefName(name: string): void {
  if (!name || name === '.') {
    throw new FileRefAuthorizationError(400, 'files[].name must not be empty');
  }
  if (name.length > MAX_FILE_REF_NAME_LENGTH) {
    throw new FileRefAuthorizationError(400, `files[].name must not exceed ${MAX_FILE_REF_NAME_LENGTH} characters`);
  }
  if (name.includes('\0') || name.includes('\\')) {
    throw new FileRefAuthorizationError(400, 'files[].name contains invalid path characters');
  }
  if (path.posix.isAbsolute(name)) {
    throw new FileRefAuthorizationError(400, 'files[].name must be a relative path');
  }
  const segments = name.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new FileRefAuthorizationError(400, 'files[].name must not contain empty, current, or parent path segments');
  }
  if (path.posix.normalize(name) !== name || name.endsWith('/')) {
    throw new FileRefAuthorizationError(400, 'files[].name must be canonical and file-like');
  }
  const depth = segments.length;
  if (depth > MAX_FILE_REF_NESTING_DEPTH) {
    throw new FileRefAuthorizationError(400, `files[].name exceeds maximum nesting depth of ${MAX_FILE_REF_NESTING_DEPTH}`);
  }
}

export function validateRequestedFiles(files: unknown): t.RequestFile[] {
  if (files == null) return [];
  if (!Array.isArray(files)) {
    throw new FileRefAuthorizationError(400, 'files must be an array');
  }

  return files.map((file, index) => {
    if (!isPlainObject(file)) {
      throw new FileRefAuthorizationError(400, `files[${index}] must be an object`);
    }

    const { id, session_id, name, entity_id } = file;
    if (typeof id !== 'string' || !isValidId(id)) {
      throw new FileRefAuthorizationError(400, `files[${index}].id is invalid`);
    }
    if (typeof session_id !== 'string' || !isValidId(session_id)) {
      throw new FileRefAuthorizationError(400, `files[${index}].session_id is invalid`);
    }
    if (typeof name !== 'string') {
      throw new FileRefAuthorizationError(400, `files[${index}].name must be a string`);
    }
    validateFileRefName(name);

    if (entity_id !== undefined) {
      if (typeof entity_id !== 'string' || !validateEntityIdString(entity_id)) {
        throw new FileRefAuthorizationError(400, `files[${index}].entity_id is invalid`);
      }
    }

    const result: t.RequestFile = { id, session_id, name };
    if (entity_id !== undefined) {
      result.entity_id = entity_id;
    }
    return result;
  });
}

export async function authorizeRequestedFiles(args: {
  req: t.AuthenticatedRequest;
  files: unknown;
  userId: string;
  entityId?: string;
  store: FileRefStore;
}): Promise<t.RequestFile[]> {
  const requestedFiles = validateRequestedFiles(args.files);
  if (requestedFiles.length === 0) return requestedFiles;

  for (const file of requestedFiles) {
    const effectiveEntityId = file.entity_id ?? args.entityId;
    const sessionKey = resolveSessionKey(args.req, args.userId, effectiveEntityId);

    const cachedSessionKey = await args.store.get(`session:${file.session_id}`);
    if (cachedSessionKey !== sessionKey) {
      throw new FileRefAuthorizationError(
        403,
        'Unauthorized file reference',
        'session_key_mismatch',
        {
          file: {
            id: file.id,
            session_id: file.session_id,
            name: file.name,
            entity_id: file.entity_id,
          },
          effectiveEntityId,
          resolvedSessionKey: sessionKey,
          cachedSessionKey,
        },
      );
    }

    const uploadKey = `upload:${sessionKey}${file.session_id}${file.id}`;
    const exists = await args.store.exists(uploadKey);
    if (exists !== 1) {
      throw new FileRefAuthorizationError(
        403,
        'Unauthorized file reference',
        'upload_missing',
        {
          file: {
            id: file.id,
            session_id: file.session_id,
            name: file.name,
            entity_id: file.entity_id,
          },
          effectiveEntityId,
          resolvedSessionKey: sessionKey,
          uploadKey,
        },
      );
    }
  }

  return requestedFiles;
}
