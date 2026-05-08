// src/middleware/auth.ts
import { validateAndGetUser, validateUser, validateApiKey, ErrorMessages, UserErrors, KeyErrors } from '@librechat/api-keys';
import type { ServiceUser, IApiKey } from '@librechat/api-keys';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types';
import { connection } from '../queue';
import { isValidId } from '../utils';
import { env } from '../config';
import { resolveSessionKey, parseUploadSessionKeyInput, SessionKeyResolutionError } from '../session-key';
import logger from '../logger';

/**
 * Mirrors the helper in `service/router.ts`. Returns true when the
 * error was a SessionKeyResolutionError and the response was sent
 * (with a logged trail); false otherwise so the caller can rethrow.
 * Centralizing the log gives a server-side breadcrumb for sessionKey
 * misconfigurations that would otherwise only surface in response
 * bodies.
 */
const logSessionKeyResolutionError = (
  err: unknown,
  res: Response,
  req: AuthenticatedRequest,
  context: string,
): boolean => {
  if (err instanceof SessionKeyResolutionError) {
    logger.error(`sessionKey resolution failed (${context})`, {
      status: err.status,
      message: err.message,
      method: req.method,
      path: req.path,
      requestUserId: req.apiKey?.userId?.toString(),
      authContextUserId: req.codeApiAuthContext?.userId,
      tenantId: req.codeApiAuthContext?.tenantId,
    });
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
};

const checkUser = async (req: AuthenticatedRequest, userId: string): Promise<void> => {
  const cachedUser = await connection.get(`user:${userId}`) ?? '';
  const apiKeyString = req.header('X-API-Key') ?? '';
  if (!cachedUser) {
    const user = await validateAndGetUser(userId, apiKeyString);
    await connection.set(
      `user:${userId}`,
      JSON.stringify(user),
      'EX',
      env.USER_CACHE_TTL
    );
    return;
  }
  const user: ServiceUser | null | undefined = JSON.parse(cachedUser);
  if (user === null || user === undefined) {
    throw new Error('User not found');
  }
  const updatedUser = await validateUser(user);
  await connection.set(
    `user:${userId}`,
    JSON.stringify(updatedUser),
    'EX',
    env.USER_CACHE_TTL
  );
  req.planId = updatedUser.subscription?.planId;
  return;
};

const checkKeyLimit = (key: IApiKey): boolean => {
  const limit = key.limit ?? 0;
  if (!limit || limit <= 0) {
    return true;
  }
  const usage = key.usage ?? 0;
  return usage < limit;
};

const processApiKey = async (apiKeyString: string): Promise<IApiKey | null | undefined> => {
  const cachedKey = await connection.get(`apiKey:${apiKeyString}`) ?? '';
  if (!cachedKey) {
    const validatedKey = await validateApiKey(apiKeyString);
    const apiKey: IApiKey = {
      ...validatedKey,
      _id: validatedKey._id.toString(),
      userId: validatedKey.userId.toString(),
    };

    await connection.set(
      `apiKey:${apiKeyString}`,
      JSON.stringify(apiKey),
      'EX',
      env.KEY_CACHE_TTL
    );

    return apiKey;
  }

  return JSON.parse(cachedKey);
};

export const apiKeyAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void | Response> => {
  const path = req.path.substring(1);
  if (path === 'enterprise/user/id') {
    next();
    return;
  }
  const apiKeyString = req.header('X-API-Key') ?? '';

  if (!apiKeyString) {
    return res.status(401).json({ error: 'API key is required' });
  }

  try {
    const apiKey = await processApiKey(apiKeyString);
    if (!apiKey) {
      return res.status(401).json({ error: ErrorMessages.INVALID_API_KEY });
    }
    const userId = apiKey.userId.toString();

    if (!userId) {
      return res.status(401).json({ error: ErrorMessages.INVALID_API_KEY });
    }

    const accessUserId = await connection.get('access-user');
    if (accessUserId != null && accessUserId && accessUserId !== userId) {
      return res.status(401).json({ error: 'Unauthorized User' });
    }

    await checkUser(req, userId);
    const isWithinLimit = checkKeyLimit(apiKey);

    if (!isWithinLimit) {
      return res.status(429).json({ error: 'API key usage limit exceeded' });
    }

    req.apiKey = apiKey;
    /* Populate the canonical `codeApiAuthContext` from the validated
     * API key. `resolveSessionKey` and `resolveOutputBucketSessionKey`
     * read this directly with no fallback to `req.apiKey.userId`, so
     * leaving it unset throws "authContext.userId is missing" on
     * every `/exec`. Single-tenant deploys leave `tenantId` undefined
     * — `TENANT_ISOLATION_STRICT=false` (default) folds that to
     * `'legacy'`; multi-tenant deploys flip STRICT on once a real
     * tenantId is available from the auth artifact. */
    req.codeApiAuthContext = {
      ...(req.codeApiAuthContext ?? {}),
      userId,
    };
    next();
  } catch (error) {
    const message = ((error as Error | undefined)?.message ?? '') as UserErrors | KeyErrors;
    const errorMessage = ErrorMessages[message] || ErrorMessages.INVALID_API_KEY;
    logger.error(`API key validation error request from ${req.ip}:`, error);
    return res.status(401).json({ error: errorMessage });
  }
};

/**
 * Verify the requester is authorized to read the given storage session.
 *
 * Looks up the cached sessionKey for `session_id` (set at upload time
 * by `/upload` or `/upload/batch`) and compares it to the sessionKey
 * the requester would derive from their auth context plus the
 * `kind`/`id`/`version?` URL query params. Equality is the entire
 * authorization check — for shared kinds (`'skill'`, `'agent'`) any
 * user in the same tenant who supplies the matching kind/id/version
 * resolves the same key and is authorized; for `'user'` only the
 * uploading user does.
 */
export const sessionAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void | Response> => {
  const { session_id, fileId } = req.params as { session_id?: string; fileId?: string };

  if (!isValidId(session_id)) {
    logger.error(`Invalid session ID: ${session_id}`);
    return res.status(400).json({ error: 'Bad request' });
  } else if (fileId != null && fileId.length > 0 && !isValidId(fileId)) {
    logger.error(`Invalid file ID: ${fileId}`);
    return res.status(400).json({ error: 'Bad request' });
  }

  const userId = (req.apiKey?.userId ?? '').toString();
  if (!userId) {
    return res.status(401).json({ error: 'User not found' });
  }

  const { kind, id, version } = req.query;
  if (kind !== undefined && typeof kind !== 'string') return res.status(400).json({ error: 'Bad request' });
  if (id !== undefined && typeof id !== 'string') return res.status(400).json({ error: 'Bad request' });
  if (version !== undefined && typeof version !== 'string') return res.status(400).json({ error: 'Bad request' });

  let sessionKeyInput;
  try {
    sessionKeyInput = parseUploadSessionKeyInput({
      kind: kind as string | undefined,
      id: id as string | undefined,
      version: version as string | undefined,
      authContextUserId: req.codeApiAuthContext?.userId ?? userId,
    });
  } catch (err) {
    if (logSessionKeyResolutionError(err, res, req, 'sessionAuth: parseUploadSessionKeyInput')) {
      return;
    }
    throw err;
  }

  let sessionKey: string;
  try {
    sessionKey = resolveSessionKey(req, sessionKeyInput);
  } catch (err) {
    if (logSessionKeyResolutionError(err, res, req, 'sessionAuth: resolveSessionKey')) {
      return;
    }
    throw err;
  }
  const cachedSessionKey = await connection.get(`session:${session_id}`);
  if (cachedSessionKey !== sessionKey) {
    logger.error(`Unauthorized download: Cached session key: ${cachedSessionKey} | Expected session key: ${sessionKey} | Session ID: ${session_id} | File ID: ${fileId}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }

  req.sessionKey = sessionKey;
  next();
};
