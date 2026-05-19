// src/middleware/auth.ts
import type { ServiceUser, IApiKey, UserErrors, KeyErrors } from '@librechat/api-keys';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types';
import type { AuthProvider } from '../auth/provider';
import { connection } from '../queue';
import { isValidId } from '../utils';
import { env } from '../config';
import { resolveSessionKey, parseUploadSessionKeyInput, SessionKeyResolutionError } from '../session-key';
import { LibreChatJwtAuthProvider, CodeApiJwtAuthError } from '../auth/librechat-jwt';
import { applyPrincipal, type CodeApiPrincipal } from '../auth/principal';
import { AuthProviderConfigError, getAuthProviderMode } from '../auth/provider';
import {
  authenticateSyntheticRequest,
  CODEAPI_SYNTHETIC_AUTH_HEADER,
  hasSyntheticAccessToken,
} from '../auth/synthetic';
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
      requestUserId: req.codeApiAuthContext?.userId,
      authContextUserId: req.codeApiAuthContext?.userId,
      tenantId: req.codeApiAuthContext?.tenantId,
    });
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
};

const jwtProvider = new LibreChatJwtAuthProvider();
type ApiKeysModule = typeof import('@librechat/api-keys');

let apiKeysModulePromise: Promise<ApiKeysModule> | null = null;

function authLogMeta(req: AuthenticatedRequest, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: req.method,
    path: req.originalUrl || req.path,
    ip: req.ip,
    authProvider: process.env.CODEAPI_AUTH_PROVIDER || 'legacy-api-key',
    hasBearerToken: Boolean(req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()),
    hasApiKey: Boolean(req.header('X-API-Key')),
    hasSyntheticToken: hasSyntheticAccessToken(req),
    principalSource: req.codeApiPrincipal?.principalSource,
    userId: req.codeApiAuthContext?.userId,
    tenantId: req.codeApiAuthContext?.tenantId,
    authContextHash: req.codeApiAuthContext?.authContextHash,
    ...extra,
  };
}

function getApiKeysModule(): Promise<ApiKeysModule> {
  apiKeysModulePromise ??= import('@librechat/api-keys');
  return apiKeysModulePromise;
}

class LegacyApiKeyAuthProvider implements AuthProvider {
  async verify(req: Request): Promise<CodeApiPrincipal | null> {
    const authReq = req as AuthenticatedRequest;
    const apiKeyString = authReq.header('X-API-Key') ?? '';
    if (!apiKeyString) {
      return null;
    }

    const apiKey = await processApiKey(apiKeyString);
    if (!apiKey) {
      const { ErrorMessages } = await getApiKeysModule();
      throw new Error(ErrorMessages.INVALID_API_KEY);
    }
    const userId = apiKey.userId.toString();
    if (!userId) {
      const { ErrorMessages } = await getApiKeysModule();
      throw new Error(ErrorMessages.INVALID_API_KEY);
    }

    const accessUserId = await connection.get('access-user');
    if (accessUserId != null && accessUserId && accessUserId !== userId) {
      throw new Error('Unauthorized User');
    }

    await checkUser(authReq, userId);
    if (!checkKeyLimit(apiKey)) {
      throw new Error('API key usage limit exceeded');
    }

    authReq.apiKey = apiKey;
    return {
      userId,
      tenantId: authReq.codeApiAuthContext?.tenantId ?? 'legacy',
      principalSource: 'legacy_api_key',
      credentialId: apiKey._id?.toString(),
    };
  }
}

const legacyProvider = new LegacyApiKeyAuthProvider();

const checkUser = async (req: AuthenticatedRequest, userId: string): Promise<void> => {
  const cachedUser = await connection.get(`user:${userId}`) ?? '';
  const apiKeyString = req.header('X-API-Key') ?? '';
  if (!cachedUser) {
    const { validateAndGetUser } = await getApiKeysModule();
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
  const { validateUser } = await getApiKeysModule();
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
    const { validateApiKey } = await getApiKeysModule();
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
  const bearerToken = req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const syntheticToken = req.header(CODEAPI_SYNTHETIC_AUTH_HEADER)?.trim();
  const authHeaderCount = [apiKeyString, bearerToken, syntheticToken].filter(Boolean).length;
  if (authHeaderCount > 1) {
    logger.warn('Rejecting ambiguous CodeAPI auth headers', authLogMeta(req));
    return res.status(400).json({ error: 'Ambiguous authentication headers' });
  }

  try {
    const syntheticAuthResult = authenticateSyntheticRequest(req);
    if (syntheticAuthResult !== null) {
      if (!syntheticAuthResult.ok) {
        const logMeta = authLogMeta(req, { mode: 'synthetic', reason: syntheticAuthResult.reason });
        if (syntheticAuthResult.status >= 500) {
          logger.error('Rejecting synthetic CodeAPI request', logMeta);
        } else {
          logger.warn('Rejecting synthetic CodeAPI request', logMeta);
        }
        return res.status(syntheticAuthResult.status).json({ error: syntheticAuthResult.error });
      }

      applyPrincipal(req, syntheticAuthResult.principal);
      logger.debug('CodeAPI synthetic request authenticated', authLogMeta(req, { mode: 'synthetic' }));
      next();
      return;
    }

    const mode = getAuthProviderMode();
    let principal: CodeApiPrincipal | null = null;

    if (mode === 'none') {
      if (env.LOCAL_MODE !== true && process.env.CODEAPI_ALLOW_AUTH_PROVIDER_NONE !== 'true') {
        logger.error(
          'Rejecting CODEAPI_AUTH_PROVIDER=none outside local mode',
          authLogMeta(req, { mode }),
        );
        return res
          .status(500)
          .json({ error: 'CodeAPI auth provider none is only allowed in local mode' });
      }
      const userId =
        req.header('User-Id') || (req.body as { user_id?: string })?.user_id || 'anonymous';
      principal = {
        userId,
        tenantId: 'legacy',
        principalSource: 'none',
      };
    } else if (mode === 'librechat-jwt') {
      if (!bearerToken) {
        logger.warn('Rejecting CodeAPI request without bearer token', authLogMeta(req, { mode }));
        return res.status(401).json({ error: 'Bearer token is required' });
      }
      principal = await jwtProvider.verify(req);
    } else if (mode === 'both') {
      if (bearerToken) {
        principal = await jwtProvider.verify(req);
      } else if (apiKeyString) {
        principal = await legacyProvider.verify(req);
      } else {
        logger.warn('Rejecting CodeAPI request without auth headers', authLogMeta(req, { mode }));
        return res.status(401).json({ error: 'Authentication is required' });
      }
    } else {
      if (!apiKeyString) {
        logger.warn('Rejecting CodeAPI request without API key', authLogMeta(req, { mode }));
        return res.status(401).json({ error: 'API key is required' });
      }
      principal = await legacyProvider.verify(req);
    }

    if (!principal) {
      logger.warn('CodeAPI auth provider returned no principal', authLogMeta(req, { mode }));
      return res.status(401).json({ error: 'Authentication is required' });
    }
    applyPrincipal(req, principal);
    logger.debug('CodeAPI request authenticated', authLogMeta(req, { mode }));
    next();
  } catch (error) {
    if (error instanceof CodeApiJwtAuthError) {
      if (error.reason === 'config') {
        logger.error(
          `JWT auth configuration failure request from ${req.ip}: ${error.message}`,
          authLogMeta(req, { reason: error.reason, error }),
        );
        return res.status(500).json({ error: 'CodeAPI JWT auth is misconfigured' });
      }
      logger.warn(
        `JWT auth failure request from ${req.ip}: ${error.reason}`,
        authLogMeta(req, { reason: error.reason }),
      );
      return res.status(401).json({ error: 'Invalid bearer token' });
    }
    if (error instanceof AuthProviderConfigError) {
      logger.error(
        `Auth provider configuration failure request from ${req.ip}: ${error.message}`,
        authLogMeta(req, { error }),
      );
      return res.status(500).json({ error: 'CodeAPI auth provider is misconfigured' });
    }
    if ((error as Error | undefined)?.message === 'API key usage limit exceeded') {
      return res.status(429).json({ error: 'API key usage limit exceeded' });
    }
    const message = ((error as Error | undefined)?.message ?? '') as UserErrors | KeyErrors;
    const { ErrorMessages } = await getApiKeysModule();
    const errorMessage = ErrorMessages[message] || ErrorMessages.INVALID_API_KEY;
    logger.error(`API key validation error request from ${req.ip}:`, authLogMeta(req, { error }));
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

  const userId = req.codeApiAuthContext?.userId ?? '';
  if (!userId) {
    logger.warn('Rejecting session auth without authContext.userId', authLogMeta(req));
    return res.status(401).json({ error: 'User not found' });
  }

  const { kind, id, version } = req.query;
  if (kind !== undefined && typeof kind !== 'string') {
    logger.warn('Rejecting session auth with malformed kind query', authLogMeta(req));
    return res.status(400).json({ error: 'Bad request' });
  }
  if (id !== undefined && typeof id !== 'string') {
    logger.warn('Rejecting session auth with malformed id query', authLogMeta(req));
    return res.status(400).json({ error: 'Bad request' });
  }
  if (version !== undefined && typeof version !== 'string') {
    logger.warn('Rejecting session auth with malformed version query', authLogMeta(req));
    return res.status(400).json({ error: 'Bad request' });
  }

  let sessionKeyInput;
  try {
    sessionKeyInput = parseUploadSessionKeyInput({
      kind: kind as string | undefined,
      id: id as string | undefined,
      version: version as string | undefined,
      authContextUserId: userId,
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
